-- 0016_phase8_search_attributes.sql
-- Phase 8, Part 3 (product-search completeness at the database layer).
--
-- PURPOSE
--   The user reported "some searches may not be working correctly".
--   Reproduction (pgtest/scripts/local/test-search-p3.ts) confirmed 9 gaps:
--   searching a COLOR ("Blue"/"black"), BRAND ("Zeya"), CATEGORY ("Kurtis")
--   or SUBCATEGORY ("Silk") returned 0 rows in BOTH search entry points:
--     pos_search()    — the POS product/scan search
--     products_page() — the catalog list page
--   SIZE ("XL") matched only accidentally when the SKU text happened to
--   contain it. Both functions SELECTed size/color/brand/category names but
--   never matched them — for a garments shop these are everyday terms.
--
--   This migration redefines ONLY the two search predicates:
--     pos_search:    name | code | SKU | barcode | QR | size | color |
--                    brand | category | subcategory (new join)
--     products_page: name | code | category | subcategory | brand | variant
--                    SKU | barcode | QR | variant size | variant color
--   All matching stays DATABASE-SIDE, case-insensitive, partial and bounded
--   (pos_search limit, products_page limit/offset) — no catalog is ever
--   loaded to the browser.
--
-- SAFETY
--   - ADDITIVE and IDEMPOTENT: create-or-replace of function bodies only.
--   - No table, column, data or grant changes (grants re-issued verbatim,
--     identical to the originals).
--   - Existing migrations 0001-0015 are untouched.
--   - Signatures and result shapes are byte-identical to the originals.
--   - New ILIKE targets are the already-joined lookup tables (sizes /
--     colors / brands / categories — tiny tables); the trigram-indexed
--     product/variant columns keep their original predicates.
--   - products_page's filtered COUNT query gains the same three LEFT JOINs
--     (categories/subcategory/brand) its rows query already had, because
--     both share one WHERE string.
--   - Apply AFTER 0015 (independent bodies, but keep the chain ordered).

-- ===========================================================================
-- pos_search  (from 0008_pos_billing.sql — search extended to attributes)
-- ===========================================================================

create or replace function public.pos_search(
  p_query text default null,
  p_limit int  default 30
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_q      text := lower(trim(coalesce(p_query, '')));
  v_rows   jsonb;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('create_sale') or public.has_app_permission('view_inventory')) then
    raise exception 'You do not have permission to use the POS.';
  end if;

  p_limit := least(greatest(coalesce(p_limit, 30), 1), 100);

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_rows
  from (
    select pv.id as variant_id,
           p.id  as product_id,
           p.name as product_name,
           p.product_code,
           pv.sku,
           pv.barcode,
           pv.qr_identifier,
           s.name  as size_name,
           c.name  as color_name,
           b.name  as brand_name,
           cat.name as category_name,
           p.hsn_code,
           p.gst_rate,
           p.is_active as product_active,
           pv.is_active as variant_active,
           coalesce(pv.mrp, p.mrp) as mrp,
           coalesce(pv.selling_price, p.selling_price) as selling_price,
           coalesce(pv.cost_price, p.cost_price) as cost_price,
           coalesce(pv.wholesale_price, p.wholesale_price) as wholesale_price,
           p.image_path,
           (
             select coalesce(sum(sb.quantity - sb.reserved_quantity), 0)::int
             from public.stock_balances sb
             where sb.variant_id = pv.id
           ) as total_available,
           (
             select coalesce(jsonb_agg(jsonb_build_object(
               'location_id', sb.location_id,
               'location_name', l.name,
               'available', (sb.quantity - sb.reserved_quantity)
             ) order by l.name), '[]'::jsonb)
             from public.stock_balances sb
             join public.stock_locations l on l.id = sb.location_id
             where sb.variant_id = pv.id
           ) as stock
    from public.product_variants pv
    join public.products p on p.id = pv.product_id
    left join public.sizes s on s.id = pv.size_id
    left join public.colors c on c.id = pv.color_id
    left join public.brands b on b.id = p.brand_id
    left join public.categories cat on cat.id = p.category_id
    left join public.categories sub on sub.id = p.subcategory_id
    where pv.is_active
      and p.is_active
      and (
        v_q = ''
        or p.name ilike '%' || v_q || '%'
        or p.product_code ilike '%' || v_q || '%'
        or pv.sku ilike '%' || v_q || '%'
        or pv.barcode ilike '%' || v_q || '%'
        or pv.qr_identifier ilike '%' || v_q || '%'
        or s.name ilike '%' || v_q || '%'          -- size
        or c.name ilike '%' || v_q || '%'          -- color
        or b.name ilike '%' || v_q || '%'          -- brand
        or cat.name ilike '%' || v_q || '%'        -- category
        or sub.name ilike '%' || v_q || '%'        -- subcategory
      )
    order by
      -- exact / prefix SKU-barcode-QR matches float to the top, then name
      (case when pv.sku = v_q or pv.barcode = v_q or pv.qr_identifier = v_q then 0
            when pv.sku like v_q || '%' or pv.barcode like v_q || '%' or pv.qr_identifier like v_q || '%' then 1
            else 2 end),
      lower(p.name),
      pv.sku
    limit p_limit
  ) t;

  return jsonb_build_object('rows', v_rows);
end $$;

revoke all on function public.pos_search(text, int) from public, anon;
grant execute on function public.pos_search(text, int) to authenticated, service_role;

-- ===========================================================================
-- products_page  (from 0004_products_catalog.sql — search extended to attrs)
-- ===========================================================================

create or replace function public.products_page(
  p_search        text   default null,
  p_category_id   uuid   default null,
  p_subcategory_id uuid  default null,
  p_brand_id      uuid   default null,
  p_status        text   default null,   -- 'active' | 'inactive' | null (all)
  p_sort          text   default 'newest',
  p_limit         int    default 25,
  p_offset        int    default 0
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_where     text[] := array['true'];
  v_order     text;
  v_sql       text;
  v_rows      jsonb;
  v_total     bigint;
  v_estimate  bigint;
  v_filtered  boolean := false;
begin
  if auth.uid() is not null and not public.has_app_permission('view_inventory') then
    raise exception 'You do not have permission to view inventory.';
  end if;

  if p_status is not null and p_status not in ('active','inactive') then
    raise exception 'Invalid status filter.';
  end if;
  if p_sort not in ('newest','oldest','name_asc','name_desc') then
    raise exception 'Invalid sort.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(p.name ILIKE %1$L OR p.product_code ILIKE %1$L
         OR c.name ILIKE %1$L OR sc.name ILIKE %1$L OR b.name ILIKE %1$L
         OR EXISTS (
         select 1 from public.product_variants pv
         left join public.sizes vsz on vsz.id = pv.size_id
         left join public.colors vcol on vcol.id = pv.color_id
         where pv.product_id = p.id
           and (pv.sku ILIKE %1$L OR pv.barcode ILIKE %1$L OR pv.qr_identifier ILIKE %1$L
                OR vsz.name ILIKE %1$L OR vcol.name ILIKE %1$L)))',
      '%' || trim(p_search) || '%'
    );
  end if;
  if p_category_id is not null then
    v_filtered := true;
    v_where := v_where || format('p.category_id = %L', p_category_id::text);
  end if;
  if p_subcategory_id is not null then
    v_filtered := true;
    v_where := v_where || format('p.subcategory_id = %L', p_subcategory_id::text);
  end if;
  if p_brand_id is not null then
    v_filtered := true;
    v_where := v_where || format('p.brand_id = %L', p_brand_id::text);
  end if;
  if p_status = 'active' then
    v_filtered := true;
    v_where := v_where || 'p.is_active'::text;
  elsif p_status = 'inactive' then
    v_filtered := true;
    v_where := v_where || 'not p.is_active'::text;
  end if;

  v_order := case p_sort
    when 'newest'    then 'p.created_at desc'
    when 'oldest'    then 'p.created_at asc'
    when 'name_asc'  then 'lower(p.name) asc'
    when 'name_desc' then 'lower(p.name) desc'
    else 'p.created_at desc'
  end;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select p.id, p.name, p.product_code, p.image_path, p.is_active, p.created_at,
             p.gender, p.gst_rate, p.mrp, p.selling_price,
             p.category_id, p.subcategory_id, p.brand_id,
             c.name  as category_name,
             sc.name as subcategory_name,
             b.name  as brand_name,
             coalesce(vv.variant_count, 0)  as variant_count,
             vv.min_selling_price, vv.max_selling_price,
             vv.min_mrp, vv.max_mrp
      from public.products p
      left join public.categories c  on c.id  = p.category_id
      left join public.categories sc on sc.id = p.subcategory_id
      left join public.brands b     on b.id  = p.brand_id
      left join lateral (
        select count(*) as variant_count,
               min(coalesce(pv.selling_price, p.selling_price)) as min_selling_price,
               max(coalesce(pv.selling_price, p.selling_price)) as max_selling_price,
               min(coalesce(pv.mrp, p.mrp))                     as min_mrp,
               max(coalesce(pv.mrp, p.mrp))                     as max_mrp
        from public.product_variants pv
        where pv.product_id = p.id
      ) vv on true
      where %s
      order by %s
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), v_order, p_limit, p_offset);

  execute v_sql into v_rows;

  -- Total: exact when filtered (bounded by the filters); planner estimate
  -- when unfiltered (avoids counting the whole table at 10M+ rows).
  if v_filtered then
    execute format($sql$
      select count(*)
      from public.products p
      left join public.categories c  on c.id  = p.category_id
      left join public.categories sc on sc.id = p.subcategory_id
      left join public.brands b     on b.id  = p.brand_id
      where %s
    $sql$, array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'products' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.products' into v_total;
    end if;
  end if;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'total_is_estimate', not v_filtered
  );
end $$;

revoke all on function public.products_page(text, uuid, uuid, uuid, text, text, int, int) from public, anon;
grant execute on function public.products_page(text, uuid, uuid, uuid, text, text, int, int) to authenticated;
