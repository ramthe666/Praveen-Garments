-- ============================================================================
-- PRAVEEN GARMENTS — Phase 2: Product Catalog + Variants
-- Migration 0004: Categories, brands, sizes, colors, products, product
--                 variants, SKU/barcode/QR generation, search RPCs, RLS
--
-- Apply order: 0001 -> 0002 -> 0003 -> 0004 -> 0005 -> 0006
-- NON-DESTRUCTIVE: creates new objects only; never alters or drops Phase 1
-- schema. Safe to re-run (IF NOT EXISTS / drop-trigger-then-create).
--
-- Design notes (10M+ row target):
--   * every search surface has an index (pg_trgm GIN for ILIKE '%..%' on
--     name / product_code / sku / barcode / qr_identifier)
--   * SKU is UNIQUE case-insensitively; barcode + QR are UNIQUE when present
--     (partial unique indexes)
--   * list pages never load the table: products_page() does filtering,
--     sorting, LIMIT/OFFSET and counting database-side
-- ============================================================================

create extension if not exists pg_trgm;

begin;

-- ---------------------------------------------------------------------------
-- 1. CATEGORIES (self-referencing tree: category -> subcategory)
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  description text,
  parent_id   uuid references public.categories (id) on delete restrict,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One name per tree level, case-insensitive
create unique index if not exists categories_parent_name_key
  on public.categories (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index if not exists categories_parent_idx   on public.categories (parent_id);
create index if not exists categories_inactive_idx on public.categories (id) where is_active = false;

-- ---------------------------------------------------------------------------
-- 2. BRANDS
-- ---------------------------------------------------------------------------
create table if not exists public.brands (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists brands_name_key    on public.brands (lower(name));
create index if not exists brands_inactive_idx       on public.brands (id) where is_active = false;

-- ---------------------------------------------------------------------------
-- 3. SIZES (configurable — never hardcoded in the UI)
-- ---------------------------------------------------------------------------
create table if not exists public.sizes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 30),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sizes_name_key      on public.sizes (lower(name));
create index if not exists sizes_active_sort_idx      on public.sizes (is_active, sort_order, name);

-- ---------------------------------------------------------------------------
-- 4. COLORS (optional hex code for swatches)
-- ---------------------------------------------------------------------------
create table if not exists public.colors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 60),
  hex_code   text check (hex_code is null or hex_code ~ '^#?[0-9A-Fa-f]{6}$'),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists colors_name_key     on public.colors (lower(name));

-- ---------------------------------------------------------------------------
-- 5. PRODUCTS
--    Required: name + category (a garment product always belongs somewhere).
--    Everything else is optional and may be overridden per variant.
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) between 1 and 200),
  product_code    text check (product_code is null or length(trim(product_code)) between 1 and 40),
  category_id     uuid not null references public.categories (id) on delete restrict,
  subcategory_id  uuid references public.categories (id) on delete restrict,
  brand_id        uuid references public.brands (id) on delete restrict,
  collection      text check (collection is null or length(trim(collection)) <= 80),
  gender          text check (gender is null or gender in ('men','women','unisex','boys','girls','kids')),
  fabric          text check (fabric is null or length(trim(fabric)) <= 80),
  pattern         text check (pattern is null or length(trim(pattern)) <= 80),
  description     text,
  hsn_code        text check (hsn_code is null or hsn_code ~ '^[0-9]{4,8}$'),
  gst_rate        numeric(5,2) check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  mrp             numeric(12,2) check (mrp is null or mrp >= 0),
  cost_price      numeric(12,2) check (cost_price is null or cost_price >= 0),
  selling_price   numeric(12,2) check (selling_price is null or selling_price >= 0),
  wholesale_price numeric(12,2) check (wholesale_price is null or wholesale_price >= 0),
  image_path      text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists products_product_code_key on public.products (product_code) where product_code is not null;
create index if not exists products_category_idx    on public.products (category_id);
create index if not exists products_subcategory_idx on public.products (subcategory_id);
create index if not exists products_brand_idx       on public.products (brand_id);
create index if not exists products_active_created_idx on public.products (is_active, created_at desc);
-- trigram search indexes (name + product_code)
create index if not exists products_name_trgm_idx  on public.products using gin (name gin_trgm_ops);
create index if not exists products_code_trgm_idx  on public.products using gin (product_code gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 6. PRODUCT VARIANTS (the sellable unit: size x color x prices)
-- ---------------------------------------------------------------------------
create table if not exists public.product_variants (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products (id) on delete cascade,
  sku             text not null check (length(trim(sku)) between 1 and 60),
  size_id         uuid references public.sizes (id) on delete restrict,
  color_id        uuid references public.colors (id) on delete restrict,
  barcode         text check (barcode is null or barcode ~ '^[0-9]{8,14}$'),
  qr_identifier   text check (qr_identifier is null or qr_identifier ~ '^[A-Za-z0-9_-]{4,64}$'),
  cost_price      numeric(12,2) check (cost_price is null or cost_price >= 0),
  mrp             numeric(12,2) check (mrp is null or mrp >= 0),
  selling_price   numeric(12,2) check (selling_price is null or selling_price >= 0),
  wholesale_price numeric(12,2) check (wholesale_price is null or wholesale_price >= 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Uniqueness enforced by the DATABASE, not just the frontend:
create unique index if not exists product_variants_sku_key      on public.product_variants (lower(sku));
create unique index if not exists product_variants_barcode_key  on public.product_variants (barcode) where barcode is not null;
create unique index if not exists product_variants_qr_key       on public.product_variants (qr_identifier) where qr_identifier is not null;

create index if not exists product_variants_product_idx  on public.product_variants (product_id);
create index if not exists product_variants_size_idx    on public.product_variants (size_id);
create index if not exists product_variants_color_idx   on public.product_variants (color_id);
create index if not exists product_variants_active_idx  on public.product_variants (product_id, is_active);
-- trigram search indexes (sku / barcode / qr)
create index if not exists product_variants_sku_trgm_idx      on public.product_variants using gin (sku gin_trgm_ops);
create index if not exists product_variants_barcode_trgm_idx  on public.product_variants using gin (barcode gin_trgm_ops);
create index if not exists product_variants_qr_trgm_idx       on public.product_variants using gin (qr_identifier gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 7. IDENTIFIER GENERATORS
--    Barcode: EAN-13 in the in-store range (prefix 20-29, per GS1) with a
--             valid checksum — scannable by any retail scanner.
--    QR:      short, unique, URL-safe identifier resolved to the variant.
-- ---------------------------------------------------------------------------
create sequence if not exists public.barcode_seq start with 1 increment by 1;
create sequence if not exists public.qr_seq      start with 1 increment by 1;

create or replace function public.generate_barcode()
returns text
language sql volatile security definer set search_path = public as $$
  with body as (
    select '20' || lpad(nextval('public.barcode_seq')::text, 10, '0') as digits
  ),
  weighted as (
    select digits, sum(
      (case when gs.i % 2 = 1 then 1 else 3 end)
      * substring(b.digits from gs.i for 1)::int
    ) as total
    from body b, generate_series(1, 12) gs(i)
    group by digits
  )
  select digits || (((10 - (total % 10)) % 10)::int)::text from weighted;
$$;

create or replace function public.generate_qr_identifier()
returns text
language sql volatile security definer set search_path = public as $$
  select 'QR' || lpad(nextval('public.qr_seq')::text, 10, '0');
$$;

revoke all on function public.generate_barcode()      from public, anon;
revoke all on function public.generate_qr_identifier() from public, anon;
grant execute on function public.generate_barcode()      to authenticated, service_role;
grant execute on function public.generate_qr_identifier() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. BATCH VARIANT CREATION RPC (used by the product wizard / "add variants")
--    - validates permissions, sizes/colors and prices
--    - generates SKU / barcode / QR where not supplied (with collision-safe
--      suffixing for generated SKUs)
--    - raises clear DUPLICATE errors that the API surfaces verbatim
--    - all-or-nothing: one transaction for the whole batch
-- ---------------------------------------------------------------------------
create or replace function public.create_product_variants(
  p_product_id uuid,
  p_variants   jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_row            jsonb;
  v_sku            text;
  v_barcode        text;
  v_qr             text;
  v_size_id        uuid;
  v_color_id       uuid;
  v_size_name      text;
  v_color_name     text;
  v_base           text;
  v_root           text;
  v_cand           text;
  v_n              integer;
  v_created        jsonb := '[]'::jsonb;
  v_new            jsonb;
  v_price_keys     text[] := array['cost_price','mrp','selling_price','wholesale_price'];
  v_key            text;
  v_price          numeric;
begin
  -- Authorization: staff must hold manage_products; service-role (server
  -- routes / scripts, auth.uid() null) is trusted and authorized upstream.
  if auth.uid() is not null and not public.has_app_permission('manage_products') then
    raise exception 'You do not have permission to manage products.';
  end if;

  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found.';
  end if;

  if p_variants is null
     or jsonb_typeof(p_variants) <> 'array'
     or (select count(*) from jsonb_array_elements(p_variants)) = 0 then
    raise exception 'At least one variant is required.';
  end if;

  -- SKU base: product_code when set, else a slug of the product name
  select coalesce(nullif(trim(product_code), ''),
                   left(regexp_replace(lower(name), '[^a-z0-9]+', '', 'g'), 8))
  into v_base
  from public.products where id = p_product_id;
  v_base := upper(coalesce(nullif(v_base, ''), 'PRD'));

  for v_row in select * from jsonb_array_elements(p_variants) loop
    -- ---- resolve size / color ----
    v_size_id  := nullif(v_row->>'size_id', '')::uuid;
    v_color_id := nullif(v_row->>'color_id', '')::uuid;

    if v_size_id is not null then
      select name into v_size_name from public.sizes where id = v_size_id;
      if v_size_name is null then
        raise exception 'Invalid size selected for a variant.';
      end if;
    else
      v_size_name := null;
    end if;

    if v_color_id is not null then
      select name into v_color_name from public.colors where id = v_color_id;
      if v_color_name is null then
        raise exception 'Invalid color selected for a variant.';
      end if;
    else
      v_color_name := null;
    end if;

    -- ---- validate prices ----
    foreach v_key in array v_price_keys loop
      if v_row->>v_key is not null and v_row->>v_key <> '' then
        if (v_row->>v_key) !~ '^[0-9]+(\.[0-9]{1,2})?$' then
          raise exception 'Invalid % value "%": use a number like 499 or 499.50.', v_key, v_row->>v_key;
        end if;
        v_price := (v_row->>v_key)::numeric;
        if v_price < 0 then
          raise exception '% cannot be negative.', v_key;
        end if;
      end if;
    end loop;

    -- ---- SKU ----
    v_sku := nullif(trim(coalesce(v_row->>'sku', '')), '');
    if v_sku is not null then
      if length(v_sku) > 60 then
        raise exception 'SKU % is too long (maximum 60 characters).', v_sku;
      end if;
      if exists (select 1 from public.product_variants where lower(sku) = lower(v_sku)) then
        raise exception 'Duplicate SKU: % is already used by another variant.', v_sku;
      end if;
    else
      -- generated: <BASE>-<COLOR4>-<SIZE3> with numeric suffix on collision
      v_root := v_base
        || case when v_color_name is not null or v_size_name is not null then '-' else '' end
        || left(regexp_replace(upper(coalesce(v_color_name, '')), '[^A-Z0-9]', '', 'g'), 4)
        || case when v_color_name is not null and v_size_name is not null then '-' else '' end
        || left(regexp_replace(upper(coalesce(v_size_name, '')),  '[^A-Z0-9]', '', 'g'), 3);
      if v_root = v_base then
        v_root := v_base || '-VAR';
      end if;
      v_cand := v_root;
      v_n := 1;
      while exists (select 1 from public.product_variants where lower(sku) = lower(v_cand)) loop
        v_n := v_n + 1;
        v_cand := v_root || '-' || v_n;
      end loop;
      v_sku := v_cand;
    end if;

    -- ---- barcode ----
    v_barcode := nullif(trim(coalesce(v_row->>'barcode', '')), '');
    if v_barcode is not null then
      if v_barcode !~ '^[0-9]{8,14}$' then
        raise exception 'Barcode must be 8-14 digits (got "%").', v_barcode;
      end if;
      if exists (select 1 from public.product_variants where barcode = v_barcode) then
        raise exception 'Duplicate barcode: % is already used by another variant.', v_barcode;
      end if;
    elsif coalesce((v_row->>'generate_barcode')::boolean, true) then
      v_barcode := public.generate_barcode();
    end if;

    -- ---- QR identifier ----
    v_qr := nullif(trim(coalesce(v_row->>'qr_identifier', '')), '');
    if v_qr is not null then
      if v_qr !~ '^[A-Za-z0-9_-]{4,64}$' then
        raise exception 'QR identifier must be 4-64 letters, digits, dashes or underscores.';
      end if;
      if exists (select 1 from public.product_variants where qr_identifier = v_qr) then
        raise exception 'Duplicate QR identifier: % is already used by another variant.', v_qr;
      end if;
    elsif coalesce((v_row->>'generate_qr')::boolean, true) then
      v_qr := public.generate_qr_identifier();
    end if;

    -- ---- insert ----
    insert into public.product_variants (
      product_id, sku, size_id, color_id, barcode, qr_identifier,
      cost_price, mrp, selling_price, wholesale_price, is_active
    ) values (
      p_product_id, v_sku, v_size_id, v_color_id, v_barcode, v_qr,
      nullif(v_row->>'cost_price', '')::numeric,
      nullif(v_row->>'mrp', '')::numeric,
      nullif(v_row->>'selling_price', '')::numeric,
      nullif(v_row->>'wholesale_price', '')::numeric,
      coalesce((v_row->>'is_active')::boolean, true)
    )
    returning jsonb_build_object(
      'id', id, 'sku', sku, 'size_id', size_id, 'color_id', color_id,
      'barcode', barcode, 'qr_identifier', qr_identifier
    ) into v_new;

    v_created := v_created || v_new;
  end loop;

  return jsonb_build_object('variants', v_created);
end $$;

revoke all on function public.create_product_variants(uuid, jsonb) from public, anon;
grant execute on function public.create_product_variants(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. PRODUCT LIST RPC — database-side search / filter / sort / pagination.
--    Search covers name, product_code and (via EXISTS) variant SKU, barcode
--    and QR identifier — all trigram-indexed. Unfiltered totals use the
--    planner's row estimate instead of counting millions of rows.
-- ---------------------------------------------------------------------------
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
      '(p.name ILIKE %1$L OR p.product_code ILIKE %1$L OR EXISTS (
         select 1 from public.product_variants pv
         where pv.product_id = p.id
           and (pv.sku ILIKE %1$L OR pv.barcode ILIKE %1$L OR pv.qr_identifier ILIKE %1$L)))',
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

-- ---------------------------------------------------------------------------
-- 10. (identifier lookup RPC lives in migration 0005 — it joins the stock
--     tables, so it can only be created after they exist)
-- ---------------------------------------------------------------------------

commit;

-- ---------------------------------------------------------------------------
-- 11. TRIGGERS (updated_at maintenance + audit trail) + RLS — appended in a
--     second transaction so function bodies that reference these tables
--     stay valid if the file is replayed.
-- ---------------------------------------------------------------------------
begin;

drop trigger if exists categories_set_updated_at on public.categories;
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

drop trigger if exists brands_set_updated_at on public.brands;
create trigger brands_set_updated_at
  before update on public.brands
  for each row execute function public.set_updated_at();

drop trigger if exists sizes_set_updated_at on public.sizes;
create trigger sizes_set_updated_at
  before update on public.sizes
  for each row execute function public.set_updated_at();

drop trigger if exists colors_set_updated_at on public.colors;
create trigger colors_set_updated_at
  before update on public.colors
  for each row execute function public.set_updated_at();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists product_variants_set_updated_at on public.product_variants;
create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

-- Audit trail: products/variants -> product_* + price_changed; attribute
-- tables (categories/brands/sizes/colors) -> settings_changed with the
-- entity recorded. Skips no-op updates.
create or replace function public.audit_catalog_change()
returns trigger
language plpgsql
security definer set search_path = public as $$
declare
  v_action public.audit_action;
  v_entity text := tg_table_name;
  v_price_keys text[] := array['cost_price','mrp','selling_price','wholesale_price','gst_rate'];
  v_key text;
begin
  if tg_op = 'DELETE' then
    v_action := case when tg_table_name in ('products','product_variants') then 'product_deleted' else 'settings_changed' end;
    insert into public.audit_logs (user_id, action, entity_type, entity_id, old_values)
    values (auth.uid(), v_action, v_entity, old.id::text,
            to_jsonb(old) - 'created_at' - 'updated_at');
    return old;
  end if;

  if tg_op = 'UPDATE'
     and (to_jsonb(old) - 'updated_at') is not distinct from (to_jsonb(new) - 'updated_at') then
    return new; -- nothing meaningful changed
  end if;

  v_action := case
    when tg_table_name in ('products','product_variants') then
      case when tg_op = 'INSERT' then 'product_created' else 'product_updated' end
    else 'settings_changed'
  end;

  insert into public.audit_logs (user_id, action, entity_type, entity_id, new_values)
  values (auth.uid(), v_action, v_entity, new.id::text,
          to_jsonb(new) - 'created_at' - 'updated_at');

  -- price changes get their own audit row (products AND variants)
  if tg_op = 'UPDATE' and tg_table_name in ('products','product_variants') then
    foreach v_key in array v_price_keys loop
      if to_jsonb(old) ->> v_key is distinct from to_jsonb(new) ->> v_key then
        insert into public.audit_logs (user_id, action, entity_type, entity_id,
                                        old_values, new_values, metadata)
        values (auth.uid(), 'price_changed', v_entity, new.id::text,
                jsonb_build_object(v_key, to_jsonb(old) -> v_key),
                jsonb_build_object(v_key, to_jsonb(new) -> v_key),
                jsonb_build_object('sku', to_jsonb(new) -> 'sku',
                                   'product_id', to_jsonb(new) -> 'product_id'));
      end if;
    end loop;
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists categories_audit on public.categories;
create trigger categories_audit
  after insert or update or delete on public.categories
  for each row execute function public.audit_catalog_change();

drop trigger if exists brands_audit on public.brands;
create trigger brands_audit
  after insert or update or delete on public.brands
  for each row execute function public.audit_catalog_change();

drop trigger if exists sizes_audit on public.sizes;
create trigger sizes_audit
  after insert or update or delete on public.sizes
  for each row execute function public.audit_catalog_change();

drop trigger if exists colors_audit on public.colors;
create trigger colors_audit
  after insert or update or delete on public.colors
  for each row execute function public.audit_catalog_change();

drop trigger if exists products_audit on public.products;
create trigger products_audit
  after insert or update or delete on public.products
  for each row execute function public.audit_catalog_change();

drop trigger if exists product_variants_audit on public.product_variants;
create trigger product_variants_audit
  after insert or update or delete on public.product_variants
  for each row execute function public.audit_catalog_change();

-- ---------------------------------------------------------------------------
-- 12. RLS + GRANTS for the catalog tables
--     Read:  view_inventory holders (all roles except accountant)
--     Write: manage_products holders (admin, inventory_manager) — service
--            routes hold manage_products and act with the service role.
-- ---------------------------------------------------------------------------
alter table public.categories       enable row level security;
alter table public.brands           enable row level security;
alter table public.sizes            enable row level security;
alter table public.colors           enable row level security;
alter table public.products         enable row level security;
alter table public.product_variants enable row level security;

drop policy if exists categories_select_inventory on public.categories;
drop policy if exists categories_write_products  on public.categories;
create policy categories_select_inventory
  on public.categories for select to authenticated
  using (public.has_app_permission('view_inventory'));
create policy categories_write_products
  on public.categories for insert to authenticated
  with check (public.has_app_permission('manage_products'));
-- (single all-write policy per command keeps policy evaluation cheap)
drop policy if exists categories_update_products on public.categories;
create policy categories_update_products
  on public.categories for update to authenticated
  using (public.has_app_permission('manage_products'))
  with check (public.has_app_permission('manage_products'));

drop policy if exists brands_select_inventory on public.brands;
drop policy if exists brands_write_products   on public.brands;
drop policy if exists brands_update_products  on public.brands;
create policy brands_select_inventory
  on public.brands for select to authenticated
  using (public.has_app_permission('view_inventory'));
create policy brands_write_products
  on public.brands for insert to authenticated
  with check (public.has_app_permission('manage_products'));
create policy brands_update_products
  on public.brands for update to authenticated
  using (public.has_app_permission('manage_products'))
  with check (public.has_app_permission('manage_products'));

drop policy if exists sizes_select_inventory on public.sizes;
drop policy if exists sizes_write_products   on public.sizes;
drop policy if exists sizes_update_products  on public.sizes;
create policy sizes_select_inventory
  on public.sizes for select to authenticated
  using (public.has_app_permission('view_inventory'));
create policy sizes_write_products
  on public.sizes for insert to authenticated
  with check (public.has_app_permission('manage_products'));
create policy sizes_update_products
  on public.sizes for update to authenticated
  using (public.has_app_permission('manage_products'))
  with check (public.has_app_permission('manage_products'));

drop policy if exists colors_select_inventory on public.colors;
drop policy if exists colors_write_products   on public.colors;
drop policy if exists colors_update_products  on public.colors;
create policy colors_select_inventory
  on public.colors for select to authenticated
  using (public.has_app_permission('view_inventory'));
create policy colors_write_products
  on public.colors for insert to authenticated
  with check (public.has_app_permission('manage_products'));
create policy colors_update_products
  on public.colors for update to authenticated
  using (public.has_app_permission('manage_products'))
  with check (public.has_app_permission('manage_products'));

drop policy if exists products_select_inventory on public.products;
drop policy if exists products_write_products   on public.products;
drop policy if exists products_update_products  on public.products;
create policy products_select_inventory
  on public.products for select to authenticated
  using (public.has_app_permission('view_inventory'));
create policy products_write_products
  on public.products for insert to authenticated
  with check (public.has_app_permission('manage_products'));
create policy products_update_products
  on public.products for update to authenticated
  using (public.has_app_permission('manage_products'))
  with check (public.has_app_permission('manage_products'));

drop policy if exists product_variants_select_inventory on public.product_variants;
drop policy if exists product_variants_write_products   on public.product_variants;
drop policy if exists product_variants_update_products  on public.product_variants;
create policy product_variants_select_inventory
  on public.product_variants for select to authenticated
  using (public.has_app_permission('view_inventory'));
create policy product_variants_write_products
  on public.product_variants for insert to authenticated
  with check (public.has_app_permission('manage_products'));
create policy product_variants_update_products
  on public.product_variants for update to authenticated
  using (public.has_app_permission('manage_products'))
  with check (public.has_app_permission('manage_products'));

-- API surface (anon gets nothing)
revoke all on public.categories, public.brands, public.sizes, public.colors,
              public.products, public.product_variants from anon;
grant select, insert, update on public.categories, public.brands, public.sizes,
                                    public.colors, public.products, public.product_variants
  to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 13. SEED DATA — standard garment sizes + common colors (configurable later
--     in the UI; never hardcoded in React components)
-- ---------------------------------------------------------------------------
begin;

insert into public.sizes (name, sort_order) values
  ('XS', 1), ('S', 2), ('M', 3), ('L', 4), ('XL', 5),
  ('XXL', 6), ('XXXL', 7), ('Free Size', 8)
on conflict do nothing;

insert into public.colors (name, hex_code) values
  ('Black',  '#000000'), ('White',  '#FFFFFF'), ('Blue',   '#1D4ED8'),
  ('Navy',   '#1E3A8A'), ('Red',    '#DC2626'), ('Maroon', '#7F1D1D'),
  ('Green',  '#15803D'), ('Yellow', '#EAB308'), ('Orange', '#EA580C'),
  ('Pink',   '#EC4899'), ('Grey',   '#6B7280'), ('Beige',  '#F5F5DC'),
  ('Brown',  '#92400E'), ('Purple', '#7C3AED')
on conflict do nothing;

commit;

-- Verification (informational)
select 'phase2_catalog' as migration,
       (select count(*) from public.categories)       as categories,
       (select count(*) from public.brands)           as brands,
       (select count(*) from public.sizes)            as sizes,
       (select count(*) from public.colors)           as colors,
       (select count(*) from public.products)         as products,
       (select count(*) from public.product_variants) as variants;
