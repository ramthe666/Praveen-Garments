-- ============================================================================
-- PRAVEEN GARMENTS — Phase 2: Inventory / Stock Engine
-- Migration 0005: stock locations, balances, movement ledger, atomic RPCs
--
-- Apply AFTER 0004. NON-DESTRUCTIVE: new tables/functions only.
--
-- DESIGN (the POS in Phase 3 calls this same engine):
--   * stock_balances   = current quantity per (variant, location)
--   * stock_movements  = append-only ledger; EVERY quantity change writes a
--                        movement row (balance_after included)
--   * changes go ONLY through SECURITY DEFINER RPCs which:
--       - authorize via has_app_permission (database-side)
--       - lock the balance row (INSERT .. ON CONFLICT DO UPDATE) so two
--         concurrent sells of the last unit cannot both succeed
--       - enforce the allow_negative_stock rule from app_settings
--   * a guard trigger blocks direct UPDATE/DELETE of balances/movements by
--     any other path (the engine flags itself via a transaction GUC)
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. STOCK LOCATIONS (stores + warehouses; optionally tied to a branch)
-- ---------------------------------------------------------------------------
create table if not exists public.stock_locations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) between 1 and 120),
  code          text not null check (length(trim(code)) between 1 and 10),
  location_type text not null default 'store' check (location_type in ('store','warehouse')),
  branch_id     uuid references public.branches (id) on delete set null,
  address       text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint stock_locations_code_key unique (code)
);

create index if not exists stock_locations_type_idx   on public.stock_locations (location_type);
create index if not exists stock_locations_active_idx on public.stock_locations (is_active);

-- Seed one store so opening stock has somewhere to go. Ties itself to the
-- first active Phase 1 branch when one exists.
insert into public.stock_locations (name, code, location_type, branch_id)
select 'Main Store', 'MAIN', 'store',
       (select id from public.branches where is_active order by created_at limit 1)
where not exists (select 1 from public.stock_locations where code = 'MAIN');

-- ---------------------------------------------------------------------------
-- 2. STOCK BALANCES (current quantity per variant per location)
--    quantity changes are ONLY possible through the engine RPCs (see the
--    guard trigger below); reorder_level may be edited via set_reorder_level.
-- ---------------------------------------------------------------------------
create table if not exists public.stock_balances (
  id                bigint generated always as identity primary key,
  variant_id        uuid not null references public.product_variants (id) on delete restrict,
  location_id       uuid not null references public.stock_locations (id) on delete restrict,
  quantity          integer not null default 0,
  reserved_quantity integer not null default 0 check (reserved_quantity >= 0),
  reorder_level     integer check (reorder_level is null or reorder_level >= 0),
  updated_at        timestamptz not null default now(),
  constraint stock_balances_variant_location_key unique (variant_id, location_id)
);

-- Status-scan indexes (partial — small even at 10M+ balances):
create index if not exists stock_balances_out_of_stock_idx
  on public.stock_balances (variant_id)
  where (quantity - reserved_quantity) <= 0;
create index if not exists stock_balances_low_with_reorder_idx
  on public.stock_balances (variant_id)
  where reorder_level is not null
    and (quantity - reserved_quantity) > 0
    and (quantity - reserved_quantity) <= reorder_level;
create index if not exists stock_balances_qty_no_reorder_idx
  on public.stock_balances (quantity)
  where reorder_level is null;

-- ---------------------------------------------------------------------------
-- 3. STOCK MOVEMENTS (append-only ledger)
-- ---------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id             bigint generated always as identity primary key,
  variant_id     uuid not null references public.product_variants (id) on delete restrict,
  location_id    uuid not null references public.stock_locations (id) on delete restrict,
  movement_type  text not null check (movement_type in (
                   'OPENING_STOCK','PURCHASE','SALE','SALES_RETURN','PURCHASE_RETURN',
                   'TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT','DAMAGE','LOSS','OTHER')),
  quantity       integer not null check (quantity <> 0),
  balance_after  integer not null,
  reference_type text,
  reference_id   text,
  reason         text,
  user_id        uuid references auth.users (id) on delete set null,
  user_email     text,
  created_at     timestamptz not null default now()
);

-- Keyset (cursor) pagination index — the history page orders by this
create index if not exists stock_movements_created_idx       on public.stock_movements (created_at desc, id desc);
create index if not exists stock_movements_variant_created_idx on public.stock_movements (variant_id, created_at desc);
create index if not exists stock_movements_location_created_idx on public.stock_movements (location_id, created_at desc);
create index if not exists stock_movements_type_created_idx  on public.stock_movements (movement_type, created_at desc);
create index if not exists stock_movements_user_created_idx  on public.stock_movements (user_id, created_at desc);
create index if not exists stock_movements_reference_idx     on public.stock_movements (reference_type, reference_id);

-- ---------------------------------------------------------------------------
-- 4. ENGINE GUARDS (integrity triggers)
-- ---------------------------------------------------------------------------

-- movements can never be updated or deleted
create or replace function public.stock_movements_append_only()
returns trigger
language plpgsql as $$
begin
  raise exception 'stock_movements is append-only (% is forbidden).', tg_op;
end $$;

drop trigger if exists stock_movements_append_only on public.stock_movements;
create trigger stock_movements_append_only
  before update or delete on public.stock_movements
  for each row execute function public.stock_movements_append_only();

-- balance quantity/reserved changes require the engine GUC; rows are never
-- deleted. reorder_level edits via set_reorder_level() don't touch quantity,
-- so they pass without the flag.
create or replace function public.guard_stock_balance_change()
returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'stock_balances rows cannot be deleted (stock history integrity).';
  end if;
  if (new.quantity is distinct from old.quantity
      or new.reserved_quantity is distinct from old.reserved_quantity)
     and coalesce(current_setting('app.stock_engine', true), 'off') <> 'on' then
    raise exception 'Stock quantities can only change through the stock engine (adjust_stock / set_opening_stock / transfer_stock).';
  end if;
  return new;
end $$;

drop trigger if exists stock_balances_engine_guard on public.stock_balances;
create trigger stock_balances_engine_guard
  before update or delete on public.stock_balances
  for each row execute function public.guard_stock_balance_change();

-- ---------------------------------------------------------------------------
-- 5. SETTINGS HELPER (reads app_settings.inventory from inside the engine)
-- ---------------------------------------------------------------------------
create or replace function public.inv_setting(p_key text, p_default jsonb default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(value -> p_key, 'null'::jsonb)
     from public.app_settings where key = 'inventory'),
    p_default
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. THE ATOMIC STOCK ENGINE
-- ---------------------------------------------------------------------------

-- adjust_stock: the single choke point for quantity changes. Concurrency
-- safe: INSERT .. ON CONFLICT DO UPDATE locks the (variant, location) row,
-- so parallel callers serialize and each sees the other's committed stock.
create or replace function public.adjust_stock(
  p_variant_id     uuid,
  p_location_id    uuid,
  p_quantity       integer,
  p_movement_type  text    default 'ADJUSTMENT',
  p_reason         text    default null,
  p_reference_type text    default null,
  p_reference_id   text    default null,
  p_user_email     text    default null
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user         uuid    := auth.uid();
  v_user_email   text;
  v_new          integer;
  v_reserved     integer;
  v_prior        integer;
  v_allow_negative boolean := coalesce((public.inv_setting('allow_negative_stock'))::boolean, false);
  v_movement_id  bigint;
begin
  if v_user is not null and not public.has_app_permission('manage_inventory') then
    raise exception 'You do not have permission to manage inventory.';
  end if;

  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantity must be a non-zero integer.';
  end if;

  if p_movement_type not in ('OPENING_STOCK','PURCHASE','SALE','SALES_RETURN',
                             'PURCHASE_RETURN','TRANSFER_IN','TRANSFER_OUT',
                             'ADJUSTMENT','DAMAGE','LOSS','OTHER') then
    raise exception 'Invalid movement type "%".', p_movement_type;
  end if;

  if p_movement_type in ('ADJUSTMENT','DAMAGE','LOSS')
     and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required for % movements.', p_movement_type;
  end if;

  if not exists (select 1 from public.product_variants where id = p_variant_id) then
    raise exception 'Variant not found.';
  end if;
  if not exists (select 1 from public.stock_locations where id = p_location_id and is_active) then
    raise exception 'Stock location not found or inactive.';
  end if;

  v_user_email := coalesce(
    nullif(trim(coalesce(p_user_email, '')), ''),
    (select email from public.profiles where id = v_user)
  );

  -- Flag this transaction as the stock engine (guard trigger checks it)
  perform set_config('app.stock_engine', 'on', true);

  -- Atomic, row-locked upsert: concurrent adjustments serialize here.
  insert into public.stock_balances (variant_id, location_id, quantity)
  values (p_variant_id, p_location_id, p_quantity)
  on conflict (variant_id, location_id)
  do update set quantity = public.stock_balances.quantity + p_quantity
  returning quantity, reserved_quantity into v_new, v_reserved;

  v_prior := v_new - p_quantity - coalesce(v_reserved, 0);

  -- Insufficient-stock rule (configurable in Settings > Inventory)
  if (v_new - coalesce(v_reserved, 0)) < 0 and not v_allow_negative then
    raise exception 'INSUFFICIENT_STOCK: only % available at this location.', greatest(v_prior, 0);
  end if;

  insert into public.stock_movements (
    variant_id, location_id, movement_type, quantity, balance_after,
    reference_type, reference_id, reason, user_id, user_email
  ) values (
    p_variant_id, p_location_id, p_movement_type, p_quantity, v_new,
    coalesce(nullif(trim(coalesce(p_reference_type, '')), ''), 'manual'),
    nullif(trim(coalesce(p_reference_id, '')), ''),
    nullif(trim(coalesce(p_reason, '')), ''),
    v_user, v_user_email
  )
  returning id into v_movement_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_user_email, 'stock_changed', 'stock_movement', v_movement_id::text,
          jsonb_build_object(
            'variant_id', p_variant_id, 'location_id', p_location_id,
            'movement_type', p_movement_type, 'quantity', p_quantity,
            'balance_after', v_new, 'reason', p_reason));

  return jsonb_build_object('balance', v_new, 'movement_id', v_movement_id);
end $$;

-- set_opening_stock: baseline entry — allowed exactly once per
-- (variant, location); afterwards adjustments must be used (auditable).
create or replace function public.set_opening_stock(
  p_variant_id  uuid,
  p_location_id uuid,
  p_quantity    integer,
  p_reason      text default null,
  p_user_email  text default null
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user        uuid := auth.uid();
  v_user_email  text;
  v_movement_id bigint;
begin
  if v_user is not null and not public.has_app_permission('manage_inventory') then
    raise exception 'You do not have permission to manage inventory.';
  end if;

  if p_quantity is null or p_quantity < 0 then
    raise exception 'Opening stock quantity must be zero or more.';
  end if;
  if not exists (select 1 from public.product_variants where id = p_variant_id) then
    raise exception 'Variant not found.';
  end if;
  if not exists (select 1 from public.stock_locations where id = p_location_id and is_active) then
    raise exception 'Stock location not found or inactive.';
  end if;
  if exists (select 1 from public.stock_movements
             where variant_id = p_variant_id and location_id = p_location_id) then
    raise exception 'OPENING_EXISTS: Opening stock is already recorded for this variant at this location. Use a stock adjustment instead.';
  end if;

  v_user_email := coalesce(
    nullif(trim(coalesce(p_user_email, '')), ''),
    (select email from public.profiles where id = v_user)
  );

  perform set_config('app.stock_engine', 'on', true);

  insert into public.stock_balances (variant_id, location_id, quantity)
  values (p_variant_id, p_location_id, p_quantity)
  on conflict (variant_id, location_id)
  do update set quantity = excluded.quantity;

  if p_quantity = 0 then
    return jsonb_build_object('balance', 0, 'movement_id', null);
  end if;

  insert into public.stock_movements (
    variant_id, location_id, movement_type, quantity, balance_after,
    reference_type, reason, user_id, user_email
  ) values (
    p_variant_id, p_location_id, 'OPENING_STOCK', p_quantity, p_quantity,
    'opening_stock', nullif(trim(coalesce(p_reason, '')), ''),
    v_user, v_user_email
  )
  returning id into v_movement_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_user_email, 'stock_changed', 'stock_movement', v_movement_id::text,
          jsonb_build_object(
            'variant_id', p_variant_id, 'location_id', p_location_id,
            'movement_type', 'OPENING_STOCK', 'quantity', p_quantity,
            'balance_after', p_quantity, 'reason', p_reason));

  return jsonb_build_object('balance', p_quantity, 'movement_id', v_movement_id);
end $$;

-- transfer_stock: two ledger entries (OUT + IN) in ONE transaction —
-- either both happen or neither does.
create or replace function public.transfer_stock(
  p_variant_id       uuid,
  p_from_location_id uuid,
  p_to_location_id   uuid,
  p_quantity         integer,
  p_reason           text default null,
  p_user_email       text default null
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_out  jsonb;
  v_in   jsonb;
begin
  if v_user is not null and not public.has_app_permission('manage_inventory') then
    raise exception 'You do not have permission to manage inventory.';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Transfer quantity must be a positive number.';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'Source and destination locations must differ.';
  end if;

  -- Lock the two balance rows in a deterministic order (lower uuid first)
  -- so opposite transfers can never deadlock each other. Both legs share
  -- one transaction: either both are written or neither is.
  if p_from_location_id < p_to_location_id then
    v_out := public.adjust_stock(p_variant_id, p_from_location_id, -p_quantity,
                                 'TRANSFER_OUT', p_reason, 'transfer', null, p_user_email);
    v_in  := public.adjust_stock(p_variant_id, p_to_location_id, p_quantity,
                                 'TRANSFER_IN', p_reason, 'transfer', null, p_user_email);
  else
    v_in  := public.adjust_stock(p_variant_id, p_to_location_id, p_quantity,
                                 'TRANSFER_IN', p_reason, 'transfer', null, p_user_email);
    v_out := public.adjust_stock(p_variant_id, p_from_location_id, -p_quantity,
                                 'TRANSFER_OUT', p_reason, 'transfer', null, p_user_email);
  end if;

  return jsonb_build_object(
    'from_balance', v_out -> 'balance',
    'to_balance',   v_in  -> 'balance'
  );
end $$;

-- set_reorder_level: per-(variant, location) threshold; null falls back to
-- the global low_stock_threshold in app_settings.
create or replace function public.set_reorder_level(
  p_variant_id    uuid,
  p_location_id   uuid,
  p_reorder_level integer,
  p_user_email    text default null
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is not null and not public.has_app_permission('manage_inventory') then
    raise exception 'You do not have permission to manage inventory.';
  end if;
  if p_reorder_level is not null and p_reorder_level < 0 then
    raise exception 'Reorder level cannot be negative.';
  end if;
  if not exists (select 1 from public.product_variants where id = p_variant_id) then
    raise exception 'Variant not found.';
  end if;
  if not exists (select 1 from public.stock_locations where id = p_location_id) then
    raise exception 'Stock location not found.';
  end if;

  perform set_config('app.stock_engine', 'on', true);

  insert into public.stock_balances (variant_id, location_id, reorder_level)
  values (p_variant_id, p_location_id, p_reorder_level)
  on conflict (variant_id, location_id)
  do update set reorder_level = excluded.reorder_level;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, nullif(trim(coalesce(p_user_email, '')), ''),
          'settings_changed', 'stock_balances',
          p_variant_id::text || ':' || p_location_id::text,
          jsonb_build_object('reorder_level', p_reorder_level,
                             'variant_id', p_variant_id, 'location_id', p_location_id));

  return jsonb_build_object('reorder_level', p_reorder_level);
end $$;

revoke all on function public.adjust_stock(uuid, uuid, integer, text, text, text, text, text)   from public, anon;
revoke all on function public.set_opening_stock(uuid, uuid, integer, text, text)               from public, anon;
revoke all on function public.transfer_stock(uuid, uuid, uuid, integer, text, text)            from public, anon;
revoke all on function public.set_reorder_level(uuid, uuid, integer, text)                     from public, anon;
grant execute on function public.adjust_stock(uuid, uuid, integer, text, text, text, text, text)   to authenticated, service_role;
grant execute on function public.set_opening_stock(uuid, uuid, integer, text, text)               to authenticated, service_role;
grant execute on function public.transfer_stock(uuid, uuid, uuid, integer, text, text)            to authenticated, service_role;
grant execute on function public.set_reorder_level(uuid, uuid, integer, text)                     to authenticated, service_role;

commit;

-- ============================================================================
-- Read-side RPCs (second transaction: they reference everything above)
-- ============================================================================
begin;

-- Dashboard counters (indexed partial scans; nulls when no permission)
create or replace function public.get_inventory_stats()
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.has_app_permission('view_inventory') then
    return jsonb_build_object('low_stock', null, 'out_of_stock', null);
  end if;
  return (
    select jsonb_build_object(
      'low_stock',
      (select count(*) from public.stock_balances sb
        where (sb.quantity - sb.reserved_quantity) > 0
          and (sb.quantity - sb.reserved_quantity) <= coalesce(
                sb.reorder_level,
                coalesce((public.inv_setting('low_stock_threshold'))::int, 10))),
      'out_of_stock',
      (select count(*) from public.stock_balances sb
        where (sb.quantity - sb.reserved_quantity) <= 0)
    )
  );
end $$;

revoke all on function public.get_inventory_stats() from public, anon;
grant execute on function public.get_inventory_stats() to authenticated;

-- find_variant_by_identifier: barcode / QR / SKU -> variant (+ stock) —
-- the endpoint the future POS scanner will call.
create or replace function public.find_variant_by_identifier(p_value text)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.has_app_permission('view_inventory') then
    return null;
  end if;
  return (
    select jsonb_build_object(
      'variant_id', pv.id,
      'sku', pv.sku,
      'barcode', pv.barcode,
      'qr_identifier', pv.qr_identifier,
      'size_name', s.name,
      'color_name', cl.name,
      'mrp', coalesce(pv.mrp, p.mrp),
      'selling_price', coalesce(pv.selling_price, p.selling_price),
      'product_id', p.id,
      'product_name', p.name,
      'product_active', p.is_active,
      'variant_active', pv.is_active,
      'stock', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'location_id', sb.location_id,
          'location_name', l.name,
          'quantity', sb.quantity,
          'reserved_quantity', sb.reserved_quantity
        ) order by l.name), '[]'::jsonb)
        from public.stock_balances sb
        join public.stock_locations l on l.id = sb.location_id
        where sb.variant_id = pv.id
      )
    )
    from public.product_variants pv
    join public.products p on p.id = pv.product_id
    left join public.sizes s   on s.id  = pv.size_id
    left join public.colors cl on cl.id = pv.color_id
    where pv.barcode = p_value
       or pv.qr_identifier = p_value
       or lower(pv.sku) = lower(p_value)
    limit 1
  );
end $$;

revoke all on function public.find_variant_by_identifier(text) from public, anon;
grant execute on function public.find_variant_by_identifier(text) to authenticated;

-- stock_page: database-side filtered + paginated current stock with the
-- status computed in SQL (In Stock / Low Stock / Out of Stock).
create or replace function public.stock_page(
  p_search         text default null,
  p_category_id    uuid default null,
  p_subcategory_id uuid default null,
  p_brand_id       uuid default null,
  p_size_id        uuid default null,
  p_color_id       uuid default null,
  p_location_id    uuid default null,
  p_status         text default null,   -- in_stock | low_stock | out_of_stock | null
  p_limit          int  default 25,
  p_offset         int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where     text[] := array['true'];
  v_sql       text;
  v_rows      jsonb;
  v_total     bigint;
  v_estimate  bigint;
  v_filtered  boolean := false;
  v_threshold integer := coalesce((public.inv_setting('low_stock_threshold'))::int, 10);
begin
  if auth.uid() is not null and not public.has_app_permission('view_inventory') then
    raise exception 'You do not have permission to view inventory.';
  end if;

  if p_status is not null and p_status not in ('in_stock','low_stock','out_of_stock') then
    raise exception 'Invalid status filter.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(p.name ILIKE %1$L OR p.product_code ILIKE %1$L OR v.sku ILIKE %1$L OR v.barcode ILIKE %1$L OR v.qr_identifier ILIKE %1$L)',
      '%' || trim(p_search) || '%');
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
  if p_size_id is not null then
    v_filtered := true;
    v_where := v_where || format('v.size_id = %L', p_size_id::text);
  end if;
  if p_color_id is not null then
    v_filtered := true;
    v_where := v_where || format('v.color_id = %L', p_color_id::text);
  end if;
  if p_location_id is not null then
    v_filtered := true;
    v_where := v_where || format('sb.location_id = %L', p_location_id::text);
  end if;
  if p_status = 'out_of_stock' then
    v_filtered := true;
    v_where := v_where || '(sb.quantity - sb.reserved_quantity) <= 0'::text;
  elsif p_status = 'low_stock' then
    v_filtered := true;
    v_where := v_where || format(
      '(sb.quantity - sb.reserved_quantity) > 0 and (sb.quantity - sb.reserved_quantity) <= coalesce(sb.reorder_level, %s)',
      v_threshold);
  elsif p_status = 'in_stock' then
    v_filtered := true;
    v_where := v_where || format(
      '(sb.quantity - sb.reserved_quantity) > coalesce(sb.reorder_level, %s)',
      v_threshold);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select sb.id as balance_id, sb.variant_id, sb.location_id,
             sb.quantity, sb.reserved_quantity, sb.reorder_level,
             coalesce(sb.reorder_level, %1$s) as effective_reorder,
             (sb.quantity - sb.reserved_quantity) as available,
             case
               when (sb.quantity - sb.reserved_quantity) <= 0 then 'out_of_stock'
               when (sb.quantity - sb.reserved_quantity) <= coalesce(sb.reorder_level, %1$s) then 'low_stock'
               else 'in_stock'
             end as status,
             v.sku, v.barcode, v.qr_identifier, v.is_active as variant_active,
             coalesce(v.mrp, p.mrp) as mrp,
             coalesce(v.selling_price, p.selling_price) as selling_price,
             p.id as product_id, p.name as product_name, p.product_code,
             p.image_path, p.is_active as product_active,
             s.name as size_name, c.name as color_name, c.hex_code as color_hex,
             l.name as location_name, l.code as location_code, l.location_type
      from public.stock_balances sb
      join public.product_variants v on v.id = sb.variant_id
      join public.products p on p.id = v.product_id
      left join public.sizes s  on s.id  = v.size_id
      left join public.colors c on c.id = v.color_id
      join public.stock_locations l on l.id = sb.location_id
      where %2$s
      order by p.name asc, v.sku asc, l.name asc
      limit %3$s offset %4$s
    ) t
  $sql$, v_threshold, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format($sql$
      select count(*)
      from public.stock_balances sb
      join public.product_variants v on v.id = sb.variant_id
      join public.products p on p.id = v.product_id
      where %s
    $sql$, array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'stock_balances' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.stock_balances' into v_total;
    end if;
  end if;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'total_is_estimate', not v_filtered
  );
end $$;

revoke all on function public.stock_page(text, uuid, uuid, uuid, uuid, uuid, uuid, text, int, int) from public, anon;
grant execute on function public.stock_page(text, uuid, uuid, uuid, uuid, uuid, uuid, text, int, int) to authenticated;

-- stock_history_page: keyset (cursor) pagination over the movement ledger —
-- stable at any depth, unlike OFFSET. Filters: date range, search (SKU /
-- product / barcode / QR), movement type, location, variant.
create or replace function public.stock_history_page(
  p_after_created timestamptz default null,
  p_after_id      bigint      default null,
  p_date_from     timestamptz default null,
  p_date_to       timestamptz default null,
  p_search        text        default null,
  p_movement_type text        default null,
  p_location_id   uuid        default null,
  p_variant_id    uuid        default null,
  p_limit         int         default 25
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where     text[] := array['true'];
  v_keyset    text   := 'true';
  v_filtered  boolean := false;
  v_sql       text;
  v_rows      jsonb;
  v_total     bigint;
  v_estimate  bigint;
  v_has_more  boolean := false;
  v_next      jsonb;
begin
  if auth.uid() is not null and not public.has_app_permission('view_inventory') then
    raise exception 'You do not have permission to view inventory.';
  end if;

  if p_movement_type is not null and p_movement_type not in (
      'OPENING_STOCK','PURCHASE','SALE','SALES_RETURN','PURCHASE_RETURN',
      'TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT','DAMAGE','LOSS','OTHER') then
    raise exception 'Invalid movement type filter.';
  end if;

  p_limit := least(greatest(coalesce(p_limit, 25), 5), 100);

  -- keyset cursor kept SEPARATE from filters so the reported total always
  -- reflects the full filtered result set, not just the remaining rows
  if p_after_created is not null and p_after_id is not null then
    v_keyset := format('(sm.created_at < %1$L or (sm.created_at = %1$L and sm.id < %2$L))',
                       p_after_created, p_after_id);
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('sm.created_at >= %L', p_date_from);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('sm.created_at <= %L', p_date_to);
  end if;
  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(p.name ILIKE %1$L OR p.product_code ILIKE %1$L OR v.sku ILIKE %1$L OR v.barcode ILIKE %1$L OR v.qr_identifier ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_movement_type is not null then
    v_filtered := true;
    v_where := v_where || format('sm.movement_type = %L', p_movement_type);
  end if;
  if p_location_id is not null then
    v_filtered := true;
    v_where := v_where || format('sm.location_id = %L', p_location_id::text);
  end if;
  if p_variant_id is not null then
    v_filtered := true;
    v_where := v_where || format('sm.variant_id = %L', p_variant_id::text);
  end if;

  -- fetch one extra row to detect has_more without a second query
  execute format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select sm.id, sm.variant_id, sm.location_id, sm.movement_type, sm.quantity,
             sm.balance_after, sm.reference_type, sm.reference_id, sm.reason,
             sm.user_id, sm.user_email, sm.created_at,
             v.sku, v.barcode, v.qr_identifier,
             s.name as size_name, c.name as color_name,
             p.id as product_id, p.name as product_name,
             l.name as location_name, l.code as location_code
      from public.stock_movements sm
      join public.product_variants v on v.id = sm.variant_id
      join public.products p on p.id = v.product_id
      left join public.sizes s  on s.id  = v.size_id
      left join public.colors c on c.id = v.color_id
      join public.stock_locations l on l.id = sm.location_id
      where %s and %s
      order by sm.created_at desc, sm.id desc
      limit %s
    ) t
  $sql$, array_to_string(v_where, ' and '), v_keyset, p_limit + 1) into v_rows;

  if jsonb_array_length(v_rows) > p_limit then
    v_has_more := true;
    v_rows := v_rows - p_limit; -- drop the lookahead row
  end if;

  if jsonb_array_length(v_rows) > 0 then
    v_next := jsonb_build_object(
      'created_at', v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'created_at',
      'id', (v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'id')
    );
  else
    v_next := null;
  end if;

  -- total: exact when filtered, planner estimate otherwise
  if v_filtered then
    execute format($sql$
      select count(*)
      from public.stock_movements sm
      join public.product_variants v on v.id = sm.variant_id
      join public.products p on p.id = v.product_id
      where %s
    $sql$, array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'stock_movements' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.stock_movements' into v_total;
    end if;
  end if;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'total_is_estimate', not v_filtered,
    'has_more', v_has_more,
    'next_cursor', v_next
  );
end $$;

revoke all on function public.stock_history_page(timestamptz, bigint, timestamptz, timestamptz, text, text, uuid, uuid, int) from public, anon;
grant execute on function public.stock_history_page(timestamptz, bigint, timestamptz, timestamptz, text, text, uuid, uuid, int) to authenticated;

commit;

-- ============================================================================
-- Diagnostics (verifies the migration created what it should; also used by
-- the high-volume test report: EXPLAIN proves index usage)
-- ============================================================================
begin;

create or replace function public.phase2_diagnostics()
returns jsonb
language plpgsql
volatile
security definer set search_path = public as $$
declare
  v_plans jsonb := '[]'::jsonb;
  v_lines jsonb;
  v_line  text;
  r       record;
begin
  for r in
    select * from (values
      ('products_name_search',
       'EXPLAIN (COSTS) select id from public.products where name ilike ''%shirt%'' order by created_at desc limit 25'),
      ('variants_sku_search',
       'EXPLAIN (COSTS) select id from public.product_variants where sku ilike ''%BLU%'' limit 25'),
      ('variants_barcode_lookup',
       'EXPLAIN (COSTS) select id from public.product_variants where barcode = ''2000000000015'''),
      ('variants_qr_lookup',
       'EXPLAIN (COSTS) select id from public.product_variants where qr_identifier = ''QR0000000001'''),
      ('variants_by_product',
       'EXPLAIN (COSTS) select id from public.product_variants where product_id = ''00000000-0000-0000-0000-000000000000'''),
      ('movements_first_page',
       'EXPLAIN (COSTS) select id from public.stock_movements order by created_at desc, id desc limit 25'),
      ('movements_keyset_page',
       'EXPLAIN (COSTS) select id from public.stock_movements where (created_at, id) < (''2026-01-01 00:00:00+00'', 999999) order by created_at desc, id desc limit 25'),
      ('movements_by_variant',
       'EXPLAIN (COSTS) select id from public.stock_movements where variant_id = ''00000000-0000-0000-0000-000000000000'' order by created_at desc limit 25'),
      ('balances_out_of_stock_count',
       'EXPLAIN (COSTS) select count(*) from public.stock_balances where (quantity - reserved_quantity) <= 0'),
      ('balances_low_stock_count',
       'EXPLAIN (COSTS) select count(*) from public.stock_balances where reorder_level is not null and (quantity - reserved_quantity) > 0 and (quantity - reserved_quantity) <= reorder_level')
    ) as t(label, sqlq)
  loop
    v_lines := '[]'::jsonb;
    for v_line in execute r.sqlq loop
      v_lines := v_lines || to_jsonb(v_line);
    end loop;
    v_plans := v_plans || jsonb_build_object('label', r.label, 'plan', v_lines);
  end loop;

  return jsonb_build_object(
    'indexes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'tablename', tablename, 'indexname', indexname, 'indexdef', indexdef
      ) order by tablename, indexname), '[]'::jsonb)
      from pg_indexes
      where schemaname = 'public'
        and tablename in ('products','product_variants','stock_balances',
                          'stock_movements','stock_locations','categories',
                          'brands','sizes','colors')
    ),
    'plans', v_plans
  );
end $$;

revoke all on function public.phase2_diagnostics() from public, anon;
grant execute on function public.phase2_diagnostics() to authenticated, service_role;

commit;

-- ============================================================================
-- RLS + triggers + grants for the stock tables
-- ============================================================================
begin;

drop trigger if exists stock_locations_set_updated_at on public.stock_locations;
create trigger stock_locations_set_updated_at
  before update on public.stock_locations
  for each row execute function public.set_updated_at();

drop trigger if exists stock_locations_audit on public.stock_locations;
create trigger stock_locations_audit
  after insert or update or delete on public.stock_locations
  for each row execute function public.audit_catalog_change();

alter table public.stock_locations enable row level security;
alter table public.stock_balances  enable row level security;
alter table public.stock_movements enable row level security;

-- Locations: readable by inventory viewers, writable by inventory managers
drop policy if exists stock_locations_select_inventory on public.stock_locations;
drop policy if exists stock_locations_write_inventory  on public.stock_locations;
drop policy if exists stock_locations_update_inventory on public.stock_locations;
create policy stock_locations_select_inventory
  on public.stock_locations for select to authenticated
  using (public.has_app_permission('view_inventory'));
create policy stock_locations_write_inventory
  on public.stock_locations for insert to authenticated
  with check (public.has_app_permission('manage_inventory'));
create policy stock_locations_update_inventory
  on public.stock_locations for update to authenticated
  using (public.has_app_permission('manage_inventory'))
  with check (public.has_app_permission('manage_inventory'));

-- Balances: readable, but NO write policies — quantities change only via
-- the SECURITY DEFINER engine (the guard trigger double-checks this).
drop policy if exists stock_balances_select_inventory on public.stock_balances;
create policy stock_balances_select_inventory
  on public.stock_balances for select to authenticated
  using (public.has_app_permission('view_inventory'));

-- Movements: readable, strictly append-only via the engine (no insert
-- policy either — inserts happen as the function owner inside adjust_stock).
drop policy if exists stock_movements_select_inventory on public.stock_movements;
create policy stock_movements_select_inventory
  on public.stock_movements for select to authenticated
  using (public.has_app_permission('view_inventory'));

revoke all on public.stock_locations, public.stock_balances, public.stock_movements from anon;
grant select, insert, update on public.stock_locations to authenticated;
grant select on public.stock_balances  to authenticated;
grant select on public.stock_movements to authenticated;

commit;

-- Verification (informational)
select 'phase2_stock' as migration,
       (select count(*) from public.stock_locations) as locations,
       (select count(*) from public.stock_balances)  as balances,
       (select count(*) from public.stock_movements) as movements;
