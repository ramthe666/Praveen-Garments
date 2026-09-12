-- ============================================================================
-- PRAVEEN GARMENTS — Phase 3: POS / Billing / Checkout / Payments / Invoices
-- Migration 0008: customers, sales, sale items, payments, held bills, the
--                 atomic create_sale engine, cancellation, sales history RPCs
--
-- Apply AFTER 0007. NON-DESTRUCTIVE: new objects only; never alters, drops
-- or truncates Phase 1 / Phase 2 schema. Safe to re-run (IF NOT EXISTS /
-- ON CONFLICT DO NOTHING / drop-policy-then-create).
--
-- DESIGN (mirrors the Phase 2 stock engine):
--   * sales / sale_items / sale_payments carry SNAPSHOT values (product name,
--     SKU, size, colour, unit price, tax…) so historical invoices never
--     depend on today's product rows.
--   * create_sale() is the ONLY write path for sales: SECURITY DEFINER RPC
--     which validates permissions, discounts, tax and payments, generates a
--     collision-proof invoice number (row-locked counter), inserts the sale +
--     items + payments, and reduces stock with row-locked upserts + SALE
--     ledger movements — ALL IN ONE TRANSACTION. Any failure rolls back
--     everything: no sale without stock, no stock without sale.
--   * cancel_sale() reverses stock (SALES_RETURN movements), records the
--     reason and preserves the original invoice record — sales are never
--     physically deleted.
--   * held bills are cart snapshots per cashier; they NEVER touch stock.
--   * prices/taxes are recomputed SERVER-SIDE from database values; client
--     numbers are display-only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PART 1 — enum extensions (own transaction so later blocks can USE the
-- values; PostgreSQL forbids using a new enum value in the transaction that
-- created it).
-- ---------------------------------------------------------------------------
begin;

alter type public.app_permission add value if not exists 'view_sales';
alter type public.app_permission add value if not exists 'override_sale_price';
alter type public.app_permission add value if not exists 'apply_discount';

alter type public.audit_action add value if not exists 'price_override_applied';
alter type public.audit_action add value if not exists 'discount_applied';
alter type public.audit_action add value if not exists 'bill_held';
alter type public.audit_action add value if not exists 'bill_resumed';
alter type public.audit_action add value if not exists 'bill_discarded';

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 1b — HOTFIX: audit_row_change() safe field resolution.
--
-- The Phase 1 trigger referenced new.email / new.id directly. PL/pgSQL
-- resolves record fields for the WHOLE statement when it is prepared, so the
-- reference fails on every table that lacks those columns (app_settings has
-- key instead of id; branches / company_settings / app_settings have no
-- email column). Effect: any REAL change to company or app settings — or a
-- branch insert — raised "record \"new\" has no field ..." and rolled back.
-- Only no-op updates ever succeeded, which is why this survived Phase 1/2
-- testing. The settings UI therefore could not save real changes; Phase 3
-- depends on saving POS / payment settings, so the function is recreated
-- here with jsonb-safe field access (identical behaviour where it worked,
-- fixed where it did not). No data is touched; future audit rows only.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer set search_path = public as $$
declare
  v_action public.audit_action;
  v_entity text := tg_table_name;
  v_new_id text;
  v_old_id text;
begin
  -- jsonb access is safe for every attached table (id or key primary keys)
  v_new_id := coalesce(to_jsonb(new) ->> 'id', to_jsonb(new) ->> 'key');
  v_old_id := coalesce(to_jsonb(old) ->> 'id', to_jsonb(old) ->> 'key');

  if tg_op = 'INSERT' then
    v_action := case tg_table_name
      when 'branches'          then 'branch_created'
      when 'profiles'          then 'user_created'
      else 'settings_changed'
    end::public.audit_action;
    insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, new_values)
    values (
      auth.uid(),
      case when tg_table_name = 'profiles' then (to_jsonb(new) ->> 'email') else null end,
      v_action, v_entity, v_new_id,
      to_jsonb(new) - 'created_at' - 'updated_at'
    );
  elsif tg_op = 'UPDATE' then
    -- ignore updates where nothing meaningful changed
    if (to_jsonb(old) - 'updated_at' - 'last_login_at')
       is not distinct from
       (to_jsonb(new) - 'updated_at' - 'last_login_at') then
      return new;
    end if;
    v_action := case tg_table_name
      when 'branches'          then 'branch_updated'
      when 'profiles'          then 'user_updated'
      else 'settings_changed'
    end::public.audit_action;
    insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, old_values, new_values)
    values (
      auth.uid(),
      case when tg_table_name = 'profiles' then (to_jsonb(new) ->> 'email') else null end,
      v_action, v_entity, v_new_id,
      to_jsonb(old) - 'created_at' - 'updated_at' - 'last_login_at',
      to_jsonb(new) - 'created_at' - 'updated_at' - 'last_login_at'
    );
  end if;
  return coalesce(new, old);
end $$;

commit;

-- ---------------------------------------------------------------------------
-- PART 2 — CUSTOMERS (lightweight POS customer directory; the full customer
-- module arrives later — sales reference these rows and keep name/phone
-- snapshots, so deleting a customer never breaks invoice history).
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  phone       text check (phone is null or phone ~ '^[0-9+\-\s()]{5,20}$'),
  email       text check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  address     text,
  city        text,
  state       text check (state is null or length(trim(state)) <= 60),
  gstin       text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  notes       text,
  is_active   boolean not null default true,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists customers_name_trgm_idx  on public.customers using gin (name gin_trgm_ops);
create index if not exists customers_phone_trgm_idx on public.customers using gin (phone gin_trgm_ops);
create index if not exists customers_active_idx     on public.customers (id) where is_active = false;
create index if not exists customers_created_idx    on public.customers (created_at desc);

-- ---------------------------------------------------------------------------
-- PART 3 — SALE NUMBER COUNTERS (row-locked, one row per prefix+year).
-- No API grants: the counter is only touched inside create_sale().
-- ---------------------------------------------------------------------------
create table if not exists public.sale_number_counters (
  id          text primary key check (length(id) between 3 and 40),
  last_number bigint not null default 0
);

-- ---------------------------------------------------------------------------
-- PART 4 — SALES (the financial record; snapshot totals as charged).
-- status is COMPLETED or CANCELLED — completed sales are never deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.sales (
  id              uuid primary key default gen_random_uuid(),
  sale_number     text not null check (length(sale_number) between 3 and 40),
  sale_date       timestamptz not null default now(),
  customer_id     uuid references public.customers (id) on delete set null,
  customer_name   text,
  customer_phone  text,
  cashier_id      uuid references auth.users (id) on delete set null,
  cashier_name    text,
  cashier_email   text,
  location_id     uuid references public.stock_locations (id) on delete set null,
  location_name   text,
  status          text not null default 'COMPLETED' check (status in ('COMPLETED','CANCELLED')),
  -- authoritative money snapshot (numeric — no float arithmetic anywhere)
  subtotal        numeric(12,2) not null default 0,
  item_discount_total numeric(12,2) not null default 0,
  bill_discount   numeric(12,2) not null default 0,
  tax_total       numeric(12,2) not null default 0,
  round_off       numeric(12,2) not null default 0,
  grand_total     numeric(12,2) not null default 0,
  paid_amount     numeric(12,2) not null default 0,
  due_amount      numeric(12,2) not null default 0,
  payment_status  text not null default 'PAID' check (payment_status in ('PAID','PARTIALLY_PAID','DUE')),
  -- tax context snapshot
  tax_mode        text not null default 'inclusive' check (tax_mode in ('inclusive','exclusive')),
  inter_state     boolean not null default false,
  price_overridden boolean not null default false,
  notes           text,
  -- cancellation trail (record preserved, never deleted)
  cancelled_at    timestamptz,
  cancelled_by    uuid references auth.users (id) on delete set null,
  cancel_reason   text,
  created_at      timestamptz not null default now()
);

create unique index if not exists sales_number_key        on public.sales (sale_number);
create index if not exists sales_date_idx                 on public.sales (sale_date desc, id desc);
create index if not exists sales_customer_idx             on public.sales (customer_id);
create index if not exists sales_cashier_idx              on public.sales (cashier_id, sale_date desc);
create index if not exists sales_status_idx               on public.sales (status);
create index if not exists sales_payment_status_idx       on public.sales (payment_status);
create index if not exists sales_payment_status_date_idx  on public.sales (payment_status, sale_date desc);
create index if not exists sales_customer_name_trgm_idx   on public.sales using gin (customer_name gin_trgm_ops);
create index if not exists sales_number_trgm_idx          on public.sales using gin (sale_number gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- PART 5 — SALE ITEMS (line-level snapshots; the invoice of tomorrow shows
-- the price of yesterday).
-- ---------------------------------------------------------------------------
create table if not exists public.sale_items (
  id              uuid primary key default gen_random_uuid(),
  sale_id         uuid not null references public.sales (id) on delete restrict,
  variant_id      uuid references public.product_variants (id) on delete set null,
  -- snapshots (data integrity)
  product_name    text not null check (length(product_name) between 1 and 200),
  product_code    text,
  sku             text not null,
  size_name       text,
  color_name      text,
  hsn_code        text,
  gst_rate        numeric(5,2) not null default 0,
  quantity        integer not null check (quantity > 0),
  base_price      numeric(12,2) not null check (base_price >= 0),
  unit_price      numeric(12,2) not null check (unit_price >= 0),
  price_overridden boolean not null default false,
  mrp             numeric(12,2),
  discount_type   text not null default 'pct' check (discount_type in ('pct','fixed')),
  discount_value  numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  tax_amount      numeric(12,2) not null default 0,
  line_total      numeric(12,2) not null,
  created_at      timestamptz not null default now()
);

create index if not exists sale_items_sale_idx    on public.sale_items (sale_id);
create index if not exists sale_items_variant_idx on public.sale_items (variant_id);

-- ---------------------------------------------------------------------------
-- PART 6 — SALE PAYMENTS (a sale can have many; each row is one payment).
-- ---------------------------------------------------------------------------
create table if not exists public.sale_payments (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references public.sales (id) on delete restrict,
  method        text not null check (length(trim(method)) between 1 and 40),
  amount        numeric(12,2) not null check (amount > 0),
  reference     text check (reference is null or length(trim(reference)) <= 80),
  cash_received numeric(12,2) check (cash_received is null or cash_received >= 0),
  cash_change   numeric(12,2) not null default 0,
  is_credit     boolean not null default false,
  recorded_by   uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists sale_payments_sale_idx    on public.sale_payments (sale_id);
create index if not exists sale_payments_method_idx on public.sale_payments (method, created_at desc);

-- ---------------------------------------------------------------------------
-- PART 7 — HELD BILLS (cart snapshots; cashier-private; NEVER touch stock).
-- The row itself is the audit trail: held_at / resumed_at / discarded_at +
-- cashier. Additional audit events land in audit_logs via the RPCs.
-- ---------------------------------------------------------------------------
create table if not exists public.held_bills (
  id            uuid primary key default gen_random_uuid(),
  label         text not null default 'Held bill' check (length(label) between 1 and 80),
  cart          jsonb not null default '{}'::jsonb,
  customer_name text,
  item_count    integer not null default 0,
  total         numeric(12,2),
  status        text not null default 'HELD' check (status in ('HELD','RESUMED','DISCARDED')),
  cashier_id    uuid not null references auth.users (id) on delete cascade,
  held_at       timestamptz not null default now(),
  resumed_at    timestamptz,
  discarded_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists held_bills_cashier_status_idx on public.held_bills (cashier_id, status, held_at desc);
create index if not exists held_bills_status_idx         on public.held_bills (status, held_at desc);

-- ---------------------------------------------------------------------------
-- PART 8 — per-employee discount limit (nullable: null = role default).
-- Additive column — no existing data is touched.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists pos_discount_limit_pct numeric(5,2)
    check (pos_discount_limit_pct is null or (pos_discount_limit_pct >= 0 and pos_discount_limit_pct <= 100));

-- ---------------------------------------------------------------------------
-- PART 9 — settings additions (merge new keys into existing JSONB values;
-- existing user-customised values are preserved).
-- ---------------------------------------------------------------------------
update public.app_settings
  set value = value || jsonb_build_object(
    'allow_credit_sales',    false,
    'default_tax_mode',      'inclusive',
    'max_item_discount_pct', 10,
    'max_bill_discount_pct', 10
  )
  where key = 'pos' and not (value ? 'allow_credit_sales');

-- ---------------------------------------------------------------------------
-- PART 10 — permission seeds for the new POS permissions (Admin-editable in
-- Settings → Roles afterwards, like every other permission).
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  ('admin',    'view_sales'),
  ('admin',    'override_sale_price'),
  ('admin',    'apply_discount'),
  ('manager',  'view_sales'),
  ('manager',  'apply_discount'),
  ('cashier',  'view_sales'),
  ('accountant','view_sales')
on conflict (role, permission) do nothing;

-- ---------------------------------------------------------------------------
-- PART 11 — updated_at triggers on the new mutable tables.
-- ---------------------------------------------------------------------------
drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

drop trigger if exists held_bills_set_updated_at on public.held_bills;
create trigger held_bills_set_updated_at
  before update on public.held_bills
  for each row execute function public.set_updated_at();

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 12 — POS SETTINGS HELPER (reads app_settings.pos inside the engine;
-- mirrors inv_setting() from 0005).
-- ---------------------------------------------------------------------------
create or replace function public.pos_setting(p_key text, p_default jsonb default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(value -> p_key, 'null'::jsonb)
     from public.app_settings where key = 'pos'),
    p_default
  );
$$;

-- generic settings reader (tax / payments / invoice keys)
create or replace function public.setting_of(p_settings_key text, p_field text, p_default jsonb default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(value -> p_field, 'null'::jsonb)
     from public.app_settings where key = p_settings_key),
    p_default
  );
$$;

revoke all on function public.pos_setting(text, jsonb) from public, anon;
revoke all on function public.setting_of(text, text, jsonb) from public, anon;
grant execute on function public.pos_setting(text, jsonb) to authenticated, service_role;
grant execute on function public.setting_of(text, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 13 — get_pos_config(): one round trip for everything the POS screen
-- needs (methods, tax behaviour, caps, company identity, store locations).
-- ---------------------------------------------------------------------------
create or replace function public.get_pos_config()
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and not (public.has_app_permission('create_sale') or public.has_app_permission('view_inventory')) then
    raise exception 'You do not have permission to use the POS.';
  end if;

  return jsonb_build_object(
    'pos', (select value from public.app_settings where key = 'pos'),
    'tax', (select value from public.app_settings where key = 'tax'),
    'payments', (select value from public.app_settings where key = 'payments'),
    'invoice', (select value from public.app_settings where key = 'invoice'),
    'inventory', (select value from public.app_settings where key = 'inventory'),
    'company', (
      select jsonb_build_object(
        'company_name', cs.company_name, 'address', cs.address, 'city', cs.city,
        'state', cs.state, 'pincode', cs.pincode, 'gstin', cs.gstin,
        'phone', cs.phone, 'email', cs.email, 'logo_url', cs.logo_url,
        'invoice_prefix', cs.invoice_prefix, 'currency', cs.currency, 'timezone', cs.timezone
      )
      from public.company_settings cs limit 1
    ),
    'locations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'code', l.code, 'location_type', l.location_type
      ) order by (l.location_type <> 'store'), l.name), '[]'::jsonb)
      from public.stock_locations l
      where l.is_active
    ),
    'my_permissions', (
      select coalesce(jsonb_agg(distinct rp.permission), '[]'::jsonb)
      from public.profiles pr
      join public.role_permissions rp on rp.role = pr.role
      where pr.id = auth.uid() and pr.is_active
    )
  );
end $$;

revoke all on function public.get_pos_config() from public, anon;
grant execute on function public.get_pos_config() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 14 — pos_search(): database-side bounded product search for the POS
-- (name / code / SKU / barcode / QR — trigram indexed). Never loads the
-- whole catalog; returns per-variant rows with live stock per location.
-- ---------------------------------------------------------------------------
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
    where pv.is_active
      and p.is_active
      and (
        v_q = ''
        or p.name ilike '%' || v_q || '%'
        or p.product_code ilike '%' || v_q || '%'
        or pv.sku ilike '%' || v_q || '%'
        or pv.barcode ilike '%' || v_q || '%'
        or pv.qr_identifier ilike '%' || v_q || '%'
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

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 15 — create_sale(): THE ATOMIC CHECKOUT ENGINE.
--
-- One transaction validates and writes EVERYTHING:
--   permissions -> discounts -> taxes -> payments -> invoice number ->
--   sale row -> item snapshots -> payment rows -> stock deduction (row-locked
--   upserts + SALE ledger movements) -> audit events.
-- Any raise rolls back the whole sale: never a sale without stock, never a
-- stock change without a sale, never a payment without a completed sale.
--
-- Money rules:
--   * every amount is computed SERVER-SIDE from database prices;
--     the client's numbers are display-only
--   * numeric arithmetic only (no floats); round(numeric, 2) rounds half
--     away from zero — the single rounding strategy used everywhere
--   * tax-inclusive: tax = taxable * rate / (100 + rate)
--     tax-exclusive: tax = taxable * rate / 100
--   * optional rupee round-off on the grand total (app_settings.pos)
-- ---------------------------------------------------------------------------
create or replace function public.create_sale(p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user            uuid    := auth.uid();
  v_profile         public.profiles%rowtype;
  v_role            public.user_role;
  v_pos             jsonb;
  v_tax             jsonb;
  v_methods         text[];
  v_company         public.company_settings%rowtype;

  v_require_customer boolean;
  v_allow_price_edit boolean;
  v_allow_credit     boolean;
  v_round_off        boolean;
  v_tax_mode         text;
  v_max_item_disc    numeric;
  v_max_bill_disc    numeric;
  v_tax_enabled      boolean;
  v_default_rate     numeric;
  v_allow_negative   boolean;
  v_personal_limit   numeric;

  v_items       jsonb := '[]'::jsonb;
  v_item        jsonb;
  v_seen        uuid[] := array[]::uuid[];
  v_count       int;

  v_vid         uuid;
  v_sku         text;
  v_name        text;
  v_code        text;
  v_size        text;
  v_color       text;
  v_hsn         text;
  v_base        numeric;
  v_mrp         numeric;
  v_unit        numeric;
  v_price_override boolean;
  v_qty         int;
  v_gst         numeric;
  v_disc_type   text;
  v_disc_value  numeric;
  v_disc_amount numeric;
  v_gross       numeric;
  v_taxable     numeric;
  v_tax_amt     numeric;
  v_line_total  numeric;
  v_has_item_discounts boolean := false;

  v_subtotal     numeric := 0;
  v_item_disc_total numeric := 0;
  v_tax_total    numeric := 0;
  v_bill_disc_type  text;
  v_bill_disc_value numeric;
  v_bill_disc_amount numeric := 0;
  v_grand        numeric;
  v_round_off_amt numeric := 0;
  v_paid         numeric := 0;
  v_credit_sum   numeric := 0;
  v_due          numeric;
  v_cash_change  numeric := 0;   -- total change returned across cash rows
  v_row_change   numeric := 0;   -- per-payment-row change
  v_pmt_status   text;

  v_pmts        jsonb;
  v_pmt         jsonb;
  v_method      text;
  v_canon_method text;
  v_pmt_amount  numeric;
  v_ref         text;
  v_cash_recv   numeric;
  v_is_credit   boolean;
  v_has_payments boolean;

  v_customer_id uuid;
  v_cust_name   text;
  v_cust_phone  text;
  v_cust_state  text;
  v_inter_state boolean := false;

  v_location_id uuid;
  v_loc_name    text;
  v_new_qty     int;
  v_reserved    int;

  v_prefix      text;
  v_tz          text;
  v_year        text;
  v_counter_id  text;
  v_n           bigint;
  v_sale_number text;
  v_sale_id     uuid;
  v_movement_id bigint;
begin
  -- ---- authorisation -----------------------------------------------------
  if v_user is null then
    raise exception 'Not authenticated.';
  end if;
  if not public.has_app_permission('create_sale') then
    raise exception 'You do not have permission to create sales.';
  end if;

  select * into v_profile from public.profiles where id = v_user and is_active;
  if not found then
    raise exception 'Your account is not active.';
  end if;
  v_role := v_profile.role;
  v_personal_limit := v_profile.pos_discount_limit_pct;

  -- ---- settings ------------------------------------------------------------
  v_pos := (select value from public.app_settings where key = 'pos');
  v_tax := (select value from public.app_settings where key = 'tax');
  v_methods := coalesce(
    (select array(select jsonb_array_elements_text(value -> 'methods')
                  from public.app_settings where key = 'payments')),
    array[]::text[]);

  v_require_customer := coalesce((v_pos ->> 'require_customer')::boolean, false);
  v_allow_price_edit := coalesce((v_pos ->> 'allow_price_edit')::boolean, false);
  v_allow_credit     := coalesce((v_pos ->> 'allow_credit_sales')::boolean, false);
  v_round_off        := coalesce((v_pos ->> 'round_off')::boolean, true);
  v_tax_mode         := coalesce(nullif(v_pos ->> 'default_tax_mode', ''), 'inclusive');
  v_max_item_disc    := coalesce((v_pos ->> 'max_item_discount_pct')::numeric, 10);
  v_max_bill_disc    := coalesce((v_pos ->> 'max_bill_discount_pct')::numeric, 10);
  v_tax_enabled      := coalesce((v_tax ->> 'enabled')::boolean, true);
  v_default_rate     := coalesce((v_tax ->> 'default_rate')::numeric, 5);
  v_allow_negative   := coalesce((public.inv_setting('allow_negative_stock'))::boolean, false);

  select * into v_company from public.company_settings limit 1;

  -- ---- items ---------------------------------------------------------------
  if p_payload is null or jsonb_typeof(p_payload -> 'items') <> 'array'
     or (select count(*) from jsonb_array_elements(p_payload -> 'items')) = 0 then
    raise exception 'The cart is empty — add at least one item.';
  end if;
  v_count := (select count(*) from jsonb_array_elements(p_payload -> 'items'));

  for v_item in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_vid := nullif(v_item ->> 'variant_id', '')::uuid;

    if v_vid is null then
      raise exception 'Invalid item: missing variant.';
    end if;
    if v_vid = any(v_seen) then
      raise exception 'Duplicate cart line for one variant — increase the quantity instead.';
    end if;
    v_seen := v_seen || v_vid;

    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid quantity for one of the items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    select pv.sku, p.name, p.product_code, s.name, c.name, p.hsn_code,
           coalesce(pv.mrp, p.mrp),
           coalesce(pv.selling_price, p.selling_price),
           pv.is_active, p.is_active
      into v_sku, v_name, v_code, v_size, v_color, v_hsn, v_mrp, v_base
    from public.product_variants pv
    join public.products p on p.id = pv.product_id
    left join public.sizes s on s.id = pv.size_id
    left join public.colors c on c.id = pv.color_id
    where pv.id = v_vid;

    if v_sku is null then
      raise exception 'VARIANT_NOT_FOUND: one of the scanned items no longer exists.';
    end if;
    if not (select pv2.is_active from public.product_variants pv2 where pv2.id = v_vid) then
      raise exception 'VARIANT_INACTIVE: % (%) is deactivated.', v_name, v_sku;
    end if;
    if not (select p2.is_active from public.products p2
            join public.product_variants pv3 on pv3.product_id = p2.id where pv3.id = v_vid) then
      raise exception 'PRODUCT_INACTIVE: % (%) is deactivated.', v_name, v_sku;
    end if;
    if v_base is null then
      raise exception 'NO_SELLING_PRICE: % (%) has no selling price set.', v_name, v_sku;
    end if;

    -- unit price (override path is permission + setting gated, always audited)
    v_unit := v_base;
    v_price_override := false;
    if v_item ? 'unit_price' and nullif(v_item ->> 'unit_price', '') is not null then
      if coalesce(v_item ->> 'unit_price', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
        raise exception 'Invalid price for % (%).', v_name, v_sku;
      end if;
      if (v_item ->> 'unit_price')::numeric <> v_base then
        if not (v_allow_price_edit and public.has_app_permission('override_sale_price')) then
          raise exception 'PRICE_OVERRIDE_NOT_ALLOWED: editing the price is not permitted for your account.';
        end if;
        v_unit := (v_item ->> 'unit_price')::numeric;
        v_price_override := true;
      end if;
    end if;

    -- item discount
    v_disc_type := coalesce(nullif(v_item ->> 'discount_type', ''), 'pct');
    if v_disc_type not in ('pct','fixed') then
      raise exception 'Invalid discount type for % (%).', v_name, v_sku;
    end if;
    v_disc_value := coalesce(nullif(v_item ->> 'discount_value', '')::numeric, 0);
    if v_disc_value < 0 then
      raise exception 'Discount cannot be negative for % (%).', v_name, v_sku;
    end if;

    v_gross := round(v_unit * v_qty, 2);
    v_disc_amount := 0;

    if v_disc_value > 0 then
      if not (public.has_app_permission('apply_discount') or v_role = 'admin') then
        raise exception 'DISCOUNT_NOT_ALLOWED: your account cannot apply discounts.';
      end if;

      if v_disc_type = 'pct' then
        if v_disc_value > 100 then
          raise exception 'Discount cannot exceed 100 percent for % (%).', v_name, v_sku;
        end if;
        if v_role <> 'admin' and v_disc_value > coalesce(
             least(v_max_item_disc,
                   case when v_personal_limit is null then v_max_item_disc
                        else least(v_max_item_disc, v_personal_limit) end),
             v_max_item_disc) then
          raise exception 'DISCOUNT_LIMIT: the maximum item discount you may apply is % percent.',
            coalesce(case when v_personal_limit is null then v_max_item_disc
                          else least(v_max_item_disc, v_personal_limit) end,
                     v_max_item_disc);
        end if;
        v_disc_amount := round(v_gross * v_disc_value / 100, 2);
      else
        if v_disc_value > v_gross then
          raise exception 'Discount greater than the line amount is not allowed for % (%).', v_name, v_sku;
        end if;
        v_disc_amount := round(v_disc_value, 2);
        if v_role <> 'admin' and v_gross > 0
           and (v_disc_amount / v_gross * 100) > coalesce(
               least(v_max_item_disc,
                     case when v_personal_limit is null then v_max_item_disc
                          else least(v_max_item_disc, v_personal_limit) end),
               v_max_item_disc) then
          raise exception 'DISCOUNT_LIMIT: the maximum item discount you may apply is % percent.',
            coalesce(case when v_personal_limit is null then v_max_item_disc
                          else least(v_max_item_disc, v_personal_limit) end,
                     v_max_item_disc);
        end if;
      end if;
      v_has_item_discounts := true;
    end if;

    v_taxable := v_gross - v_disc_amount;
    v_gst := case when v_tax_enabled
                  then coalesce((select p2.gst_rate from public.products p2
                                 join public.product_variants pv2 on pv2.product_id = p2.id
                                 where pv2.id = v_vid), v_default_rate)
                  else 0 end;

    if v_tax_mode = 'inclusive' then
      v_tax_amt := round(v_taxable * v_gst / (100 + v_gst), 2);
      v_line_total := v_taxable;
    else
      v_tax_amt := round(v_taxable * v_gst / 100, 2);
      v_line_total := v_taxable + v_tax_amt;
    end if;

    v_subtotal := v_subtotal + v_line_total;
    v_item_disc_total := v_item_disc_total + v_disc_amount;
    v_tax_total := v_tax_total + v_tax_amt;

    v_items := v_items || jsonb_build_object(
      'variant_id', v_vid,
      'product_name', v_name,
      'product_code', v_code,
      'sku', v_sku,
      'size_name', v_size,
      'color_name', v_color,
      'hsn_code', v_hsn,
      'gst_rate', v_gst,
      'quantity', v_qty,
      'base_price', v_base,
      'unit_price', v_unit,
      'price_overridden', v_price_override,
      'mrp', v_mrp,
      'discount_type', v_disc_type,
      'discount_value', v_disc_value,
      'discount_amount', v_disc_amount,
      'tax_amount', v_tax_amt,
      'line_total', v_line_total
    );
  end loop;

  -- ---- bill discount -------------------------------------------------------
  v_bill_disc_type := coalesce(nullif(p_payload ->> 'bill_discount_type', ''), 'pct');
  if v_bill_disc_type not in ('pct','fixed') then
    raise exception 'Invalid bill discount type.';
  end if;
  v_bill_disc_value := coalesce(nullif(p_payload ->> 'bill_discount_value', '')::numeric, 0);
  if v_bill_disc_value < 0 then
    raise exception 'Bill discount cannot be negative.';
  end if;

  if v_bill_disc_value > 0 then
    if not (public.has_app_permission('apply_discount') or v_role = 'admin') then
      raise exception 'DISCOUNT_NOT_ALLOWED: your account cannot apply discounts.';
    end if;
    if v_bill_disc_type = 'pct' then
      if v_bill_disc_value > 100 then
        raise exception 'Bill discount cannot exceed 100 percent.';
      end if;
      if v_role <> 'admin' and v_bill_disc_value > coalesce(
           least(v_max_bill_disc,
                 case when v_personal_limit is null then v_max_bill_disc
                      else least(v_max_bill_disc, v_personal_limit) end),
           v_max_bill_disc) then
        raise exception 'DISCOUNT_LIMIT: the maximum bill discount you may apply is % percent.',
          coalesce(case when v_personal_limit is null then v_max_bill_disc
                        else least(v_max_bill_disc, v_personal_limit) end,
                   v_max_bill_disc);
      end if;
      v_bill_disc_amount := round(v_subtotal * v_bill_disc_value / 100, 2);
    else
      if v_bill_disc_value > v_subtotal then
        raise exception 'Bill discount greater than the bill amount is not allowed.';
      end if;
      v_bill_disc_amount := round(v_bill_disc_value, 2);
      if v_role <> 'admin' and v_subtotal > 0
         and (v_bill_disc_amount / v_subtotal * 100) > coalesce(
             least(v_max_bill_disc,
                   case when v_personal_limit is null then v_max_bill_disc
                        else least(v_max_bill_disc, v_personal_limit) end),
             v_max_bill_disc) then
        raise exception 'DISCOUNT_LIMIT: the maximum bill discount you may apply is % percent.',
          coalesce(case when v_personal_limit is null then v_max_bill_disc
                        else least(v_max_bill_disc, v_personal_limit) end,
                   v_max_bill_disc);
      end if;
    end if
    ;
  end if;

  -- ---- grand total + round off ---------------------------------------------
  v_grand := round(v_subtotal - v_bill_disc_amount, 2);
  if v_grand < 0 then
    raise exception 'The bill total cannot be negative.';
  end if;
  if v_round_off then
    v_round_off_amt := round(v_grand) - v_grand;
    v_grand := round(v_grand);
  end if;

  -- ---- payments ------------------------------------------------------------
  v_pmts := coalesce(p_payload -> 'payments', '[]'::jsonb);
  if jsonb_typeof(v_pmts) <> 'array' then
    raise exception 'Invalid payments.';
  end if;
  v_has_payments := (select count(*) from jsonb_array_elements(v_pmts)) > 0;

  for v_pmt in select * from jsonb_array_elements(v_pmts) loop
    v_method := trim(coalesce(v_pmt ->> 'method', ''));
    if v_method = '' then
      raise exception 'A payment method is required.';
    end if;
    v_is_credit := v_method ilike 'credit%';

    if not v_is_credit then
      v_canon_method := null;
      select m into v_canon_method
        from unnest(v_methods) m
       where lower(m) = lower(v_method) limit 1;
      if v_canon_method is null then
        raise exception 'PAYMENT_METHOD_DISABLED: "%" is not an accepted payment method.', v_method;
      end if;
      v_method := v_canon_method;
    else
      v_method := 'Credit';
    end if;

    if coalesce(v_pmt ->> 'amount', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Invalid payment amount for "%".', v_method;
    end if;
    v_pmt_amount := (v_pmt ->> 'amount')::numeric;
    if v_pmt_amount <= 0 then
      raise exception 'Each payment amount must be greater than zero.';
    end if;

    v_cash_recv := null;
    v_row_change := 0;
    if not v_is_credit and v_method ilike 'cash%' then
      v_cash_recv := coalesce(nullif(v_pmt ->> 'cash_received', '')::numeric, v_pmt_amount);
      if v_cash_recv < v_pmt_amount then
        raise exception 'CASH_RECEIVED_LESS: cash received cannot be less than the cash payment amount.';
      end if;
      v_row_change := round(v_cash_recv - v_pmt_amount, 2);
      v_cash_change := v_cash_change + v_row_change;
    end if;

    v_ref := nullif(trim(coalesce(v_pmt ->> 'reference', '')), '');

    if not v_is_credit then
      v_paid := v_paid + v_pmt_amount;
    else
      v_credit_sum := v_credit_sum + v_pmt_amount;
    end if;
  end loop;

  v_due := round(v_grand - v_paid, 2);
  if v_due < 0 then
    raise exception 'PAYMENT_EXCEEDS_TOTAL: the payments add up to more than the bill total.';
  end if;

  if v_due > 0 then
    if not v_allow_credit then
      raise exception 'CREDIT_NOT_ENABLED: the full amount must be paid, or credit sales must be enabled.';
    end if;
    if v_customer_id is null and nullif(p_payload ->> 'customer_id', '') is null then
      raise exception 'CREDIT_REQUIRES_CUSTOMER: a customer is required for credit (due) sales.';
    end if;
    if v_has_payments and v_credit_sum > 0 and v_credit_sum <> v_due then
      raise exception 'CREDIT_MISMATCH: the Credit row (%) must equal the remaining balance (%).', v_credit_sum, v_due;
    end if
    ;
  end if;

  if v_paid <= 0 and v_grand > 0 then
    v_pmt_status := 'DUE';
  elsif v_paid < v_grand then
    v_pmt_status := 'PARTIALLY_PAID';
  else
    v_pmt_status := 'PAID';
  end if;

  -- ---- customer ------------------------------------------------------------
  v_customer_id := nullif(p_payload ->> 'customer_id', '')::uuid;
  if v_customer_id is not null then
    select name, phone, state into v_cust_name, v_cust_phone, v_cust_state
      from public.customers where id = v_customer_id and is_active;
    if v_cust_name is null then
      raise exception 'Customer not found or inactive.';
    end if;
  elsif v_require_customer then
    raise exception 'CUSTOMER_REQUIRED: this store requires a customer on every bill.';
  end if;

  -- inter-state sale? (company state vs customer state — both must be set)
  if v_company.state is not null and v_cust_state is not null
     and lower(trim(v_cust_state)) <> lower(trim(v_company.state)) then
    v_inter_state := true;
  end if;

  -- ---- stock location ------------------------------------------------------
  v_location_id := nullif(p_payload ->> 'location_id', '')::uuid;
  if v_location_id is null then
    select id into v_location_id
      from public.stock_locations
      where is_active
      order by (location_type <> 'store'), name
      limit 1;
  end if;
  if v_location_id is null then
    raise exception 'No active stock location found. Create one in Inventory → Locations.';
  end if;
  select name into v_loc_name from public.stock_locations where id = v_location_id and is_active;
  if v_loc_name is null then
    raise exception 'Stock location not found or inactive.';
  end if;

  -- ---- invoice number (row-locked counter: concurrent checkouts can never
  --      collide; the prefix comes from company settings) ---------------------
  v_prefix := coalesce(nullif(trim(v_company.invoice_prefix), ''), 'INV');
  v_tz := coalesce(nullif(trim(v_company.timezone), ''), 'Asia/Kolkata');
  v_year := to_char(now() at time zone v_tz, 'YYYY');
  v_counter_id := upper(v_prefix) || '-' || v_year;

  insert into public.sale_number_counters (id, last_number)
  values (v_counter_id, 1)
  on conflict (id)
  do update set last_number = public.sale_number_counters.last_number + 1
  returning last_number into v_n;

  v_sale_number := v_counter_id || '-' || lpad(v_n::text, 6, '0');

  -- ---- sale row ------------------------------------------------------------
  insert into public.sales (
    sale_number, customer_id, customer_name, customer_phone,
    cashier_id, cashier_name, cashier_email,
    location_id, location_name, status,
    subtotal, item_discount_total, bill_discount, tax_total, round_off, grand_total,
    paid_amount, due_amount, payment_status,
    tax_mode, inter_state, price_overridden, notes
  ) values (
    v_sale_number, v_customer_id, v_cust_name, v_cust_phone,
    v_user, coalesce(nullif(trim(v_profile.full_name), ''), v_profile.email), v_profile.email,
    v_location_id, v_loc_name, 'COMPLETED',
    v_subtotal, v_item_disc_total, v_bill_disc_amount, v_tax_total, v_round_off_amt, v_grand,
    v_paid, v_due, v_pmt_status,
    v_tax_mode, v_inter_state,
    exists (select 1 from jsonb_array_elements(v_items) i where (i ->> 'price_overridden')::boolean),
    nullif(trim(coalesce(p_payload ->> 'notes', '')), '')
  )
  returning id into v_sale_id;

  -- ---- item rows (snapshots) ----------------------------------------------
  for v_item in select * from jsonb_array_elements(v_items) loop
    insert into public.sale_items (
      sale_id, variant_id, product_name, product_code, sku, size_name, color_name,
      hsn_code, gst_rate, quantity, base_price, unit_price, price_overridden, mrp,
      discount_type, discount_value, discount_amount, tax_amount, line_total
    ) values (
      v_sale_id,
      (v_item ->> 'variant_id')::uuid,
      v_item ->> 'product_name',
      v_item ->> 'product_code',
      v_item ->> 'sku',
      v_item ->> 'size_name',
      v_item ->> 'color_name',
      v_item ->> 'hsn_code',
      (v_item ->> 'gst_rate')::numeric,
      (v_item ->> 'quantity')::int,
      (v_item ->> 'base_price')::numeric,
      (v_item ->> 'unit_price')::numeric,
      (v_item ->> 'price_overridden')::boolean,
      (v_item ->> 'mrp')::numeric,
      v_item ->> 'discount_type',
      (v_item ->> 'discount_value')::numeric,
      (v_item ->> 'discount_amount')::numeric,
      (v_item ->> 'tax_amount')::numeric,
      (v_item ->> 'line_total')::numeric
    );
  end loop;

  -- ---- payment rows --------------------------------------------------------
  for v_pmt in select * from jsonb_array_elements(v_pmts) loop
    v_method := trim(coalesce(v_pmt ->> 'method', ''));
    v_is_credit := v_method ilike 'credit%';
    if not v_is_credit then
      select m into v_method from unnest(v_methods) m where lower(m) = lower(v_method) limit 1;
    else
      v_method := 'Credit';
    end if;
    v_pmt_amount := (v_pmt ->> 'amount')::numeric;
    v_cash_recv := null;
    v_row_change := 0;
    if not v_is_credit and v_method ilike 'cash%' then
      v_cash_recv := coalesce(nullif(v_pmt ->> 'cash_received', '')::numeric, v_pmt_amount);
      v_row_change := round(v_cash_recv - v_pmt_amount, 2);
    end if;
    v_ref := nullif(trim(coalesce(v_pmt ->> 'reference', '')), '');

    insert into public.sale_payments (
      sale_id, method, amount, reference, cash_received, cash_change, is_credit, recorded_by
    ) values (
      v_sale_id, v_method, v_pmt_amount, v_ref, v_cash_recv, v_row_change, v_is_credit, v_user
    );
  end loop;

  -- ---- atomic stock deduction (row-locked upserts — two cashiers can never
  --      both sell the last unit; the engine GUC lets the guard trigger pass) --
  perform set_config('app.stock_engine', 'on', true);

  for v_item in select * from jsonb_array_elements(v_items) loop
    v_vid := (v_item ->> 'variant_id')::uuid;
    v_qty := (v_item ->> 'quantity')::int;
    v_sku := v_item ->> 'sku';

    insert into public.stock_balances (variant_id, location_id, quantity)
    values (v_vid, v_location_id, -v_qty)
    on conflict (variant_id, location_id)
    do update set quantity = public.stock_balances.quantity - v_qty
    returning quantity, reserved_quantity into v_new_qty, v_reserved;

    if (v_new_qty - coalesce(v_reserved, 0)) < 0 and not v_allow_negative then
      raise exception 'INSUFFICIENT_STOCK: only % left for % (%).',
        greatest(v_new_qty - coalesce(v_reserved,0) + v_qty, 0), v_item ->> 'product_name', v_sku;
    end if;

    insert into public.stock_movements (
      variant_id, location_id, movement_type, quantity, balance_after,
      reference_type, reference_id, reason, user_id, user_email
    ) values (
      v_vid, v_location_id, 'SALE', -v_qty, v_new_qty,
      'sale', v_sale_id::text, 'Sale ' || v_sale_number,
      v_user, v_profile.email
    )
    returning id into v_movement_id;
  end loop;

  -- ---- audit trail ---------------------------------------------------------
  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_profile.email, 'sale_created', 'sale', v_sale_id::text,
          jsonb_build_object(
            'sale_number', v_sale_number,
            'location', v_loc_name,
            'items', v_count,
            'subtotal', v_subtotal,
            'item_discounts', v_item_disc_total,
            'bill_discount', v_bill_disc_amount,
            'tax_total', v_tax_total,
            'round_off', v_round_off_amt,
            'grand_total', v_grand,
            'paid_amount', v_paid,
            'due_amount', v_due,
            'payment_status', v_pmt_status,
            'payments', v_pmts,
            'customer', v_cust_name,
            'tax_mode', v_tax_mode,
            'inter_state', v_inter_state
          ));

  for v_item in select * from jsonb_array_elements(v_items) loop
    if (v_item ->> 'price_overridden')::boolean then
      insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, old_values, new_values, metadata)
      values (v_user, v_profile.email, 'price_override_applied', 'sale', v_sale_id::text,
              jsonb_build_object('price', (v_item ->> 'base_price')::numeric),
              jsonb_build_object('price', (v_item ->> 'unit_price')::numeric),
              jsonb_build_object('sku', v_item ->> 'sku', 'sale_number', v_sale_number));
    end if;
    if (v_item ->> 'discount_amount')::numeric > 0 then
      insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
      values (v_user, v_profile.email, 'discount_applied', 'sale_item', v_sale_id::text,
              jsonb_build_object('sku', v_item ->> 'sku',
                                 'discount_type', v_item ->> 'discount_type',
                                 'discount_value', (v_item ->> 'discount_value')::numeric,
                                 'discount_amount', (v_item ->> 'discount_amount')::numeric,
                                 'sale_number', v_sale_number));
    end if;
  end loop;

  if v_bill_disc_amount > 0 then
    insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
    values (v_user, v_profile.email, 'discount_applied', 'sale', v_sale_id::text,
            jsonb_build_object('scope', 'bill',
                               'discount_type', v_bill_disc_type,
                               'discount_value', v_bill_disc_value,
                               'discount_amount', v_bill_disc_amount,
                               'sale_number', v_sale_number));
  end if;

  -- ---- result for the post-sale screen ------------------------------------
  return jsonb_build_object(
    'sale_id', v_sale_id,
    'sale_number', v_sale_number,
    'sale_date', now(),
    'subtotal', v_subtotal,
    'item_discount_total', v_item_disc_total,
    'bill_discount', v_bill_disc_amount,
    'tax_total', v_tax_total,
    'round_off', v_round_off_amt,
    'grand_total', v_grand,
    'paid_amount', v_paid,
    'due_amount', v_due,
    'payment_status', v_pmt_status,
    'cash_change', v_cash_change,
    'tax_mode', v_tax_mode,
    'inter_state', v_inter_state,
    'customer_name', v_cust_name,
    'location_name', v_loc_name
  );
end $$;

revoke all on function public.create_sale(jsonb) from public, anon;
grant execute on function public.create_sale(jsonb) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 16 — cancel_sale(): supervised cancellation. The financial record is
-- PRESERVED (status CANCELLED + reason + who + when); stock is returned via
-- SALES_RETURN movements referencing the sale; payments stay as history.
-- Completed sales are never deleted.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_sale(p_sale_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user     uuid    := auth.uid();
  v_email    text;
  v_sale     public.sales%rowtype;
  v_item     public.sale_items%rowtype;
  v_new_qty  int;
  v_reserved int;
  v_restocked int := 0;
begin
  if v_user is null then
    raise exception 'Not authenticated.';
  end if;
  if not public.has_app_permission('cancel_sale') then
    raise exception 'You do not have permission to cancel sales.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to cancel a sale.';
  end if;

  select email into v_email from public.profiles where id = v_user;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status <> 'COMPLETED' then
    raise exception 'Only completed sales can be cancelled.';
  end if;

  -- return the goods (row-locked upserts — the engine GUC lets guards pass)
  perform set_config('app.stock_engine', 'on', true);

  for v_item in select * from public.sale_items where sale_id = p_sale_id loop
    if v_item.variant_id is null then
      raise exception 'Cannot restock an item whose variant was removed. Contact support.';
    end if;

    insert into public.stock_balances (variant_id, location_id, quantity)
    values (v_item.variant_id, v_sale.location_id, v_item.quantity)
    on conflict (variant_id, location_id)
    do update set quantity = public.stock_balances.quantity + v_item.quantity
    returning quantity, reserved_quantity into v_new_qty, v_reserved;

    insert into public.stock_movements (
      variant_id, location_id, movement_type, quantity, balance_after,
      reference_type, reference_id, reason, user_id, user_email
    ) values (
      v_item.variant_id, v_sale.location_id, 'SALES_RETURN', v_item.quantity, v_new_qty,
      'sale_cancel', v_sale.id::text,
      'Sale ' || v_sale.sale_number || ' cancelled: ' || trim(p_reason),
      v_user, coalesce(v_email, v_sale.cashier_email)
    );

    v_restocked := v_restocked + 1;
  end loop;

  update public.sales
     set status = 'CANCELLED',
         cancelled_at = now(),
         cancelled_by = v_user,
         cancel_reason = trim(p_reason)
   where id = p_sale_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, old_values, metadata)
  values (v_user, v_email, 'sale_cancelled', 'sale', v_sale.id::text,
          jsonb_build_object('status', v_sale.status),
          jsonb_build_object(
            'sale_number', v_sale.sale_number,
            'reason', trim(p_reason),
            'grand_total', v_sale.grand_total,
            'paid_amount', v_sale.paid_amount,
            'refund_due', v_sale.paid_amount,
            'restocked_items', v_restocked
          ));

  return jsonb_build_object(
    'sale_id', v_sale.id,
    'sale_number', v_sale.sale_number,
    'status', 'CANCELLED',
    'restocked_items', v_restocked,
    'refund_due', v_sale.paid_amount
  );
end $$;

revoke all on function public.cancel_sale(uuid, text) from public, anon;
grant execute on function public.cancel_sale(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 17 — held bills (draft carts). NEVER touch stock. cashier-private.
-- ---------------------------------------------------------------------------
create or replace function public.hold_bill(
  p_cart         jsonb,
  p_label        text default null,
  p_customer     text default null,
  p_item_count   int  default 0,
  p_total        numeric default null
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_id    uuid;
  v_label text;
begin
  if v_user is null then
    raise exception 'Not authenticated.';
  end if;
  if not public.has_app_permission('create_sale') then
    raise exception 'You do not have permission to use the POS.';
  end if;
  if p_cart is null or p_cart = '{}'::jsonb then
    raise exception 'The cart is empty — nothing to hold.';
  end if;

  select email into v_email from public.profiles where id = v_user;

  v_label := coalesce(nullif(trim(p_label), ''), 'Held bill');

  insert into public.held_bills (label, cart, customer_name, item_count, total, cashier_id)
  values (left(v_label, 80), p_cart, nullif(trim(coalesce(p_customer, '')), ''),
          greatest(p_item_count, 0), p_total, v_user)
  returning id into v_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'bill_held', 'held_bill', v_id::text,
          jsonb_build_object('label', v_label, 'item_count', p_item_count, 'total', p_total));

  return jsonb_build_object('id', v_id, 'label', v_label);
end $$;

revoke all on function public.hold_bill(jsonb, text, text, int, numeric) from public, anon;
grant execute on function public.hold_bill(jsonb, text, text, int, numeric) to authenticated, service_role;

create or replace function public.resume_held_bill(p_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_bill  public.held_bills%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated.';
  end if;

  select * into v_bill from public.held_bills where id = p_id for update;
  if not found then
    raise exception 'Held bill not found.';
  end if;
  if v_bill.cashier_id <> v_user then
    raise exception 'This held bill belongs to another cashier.';
  end if;
  if v_bill.status <> 'HELD' then
    raise exception 'This held bill has already been %.', lower(v_bill.status);
  end if;

  select email into v_email from public.profiles where id = v_user;

  update public.held_bills
     set status = 'RESUMED', resumed_at = now(), updated_at = now()
   where id = p_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'bill_resumed', 'held_bill', p_id::text,
          jsonb_build_object('label', v_bill.label));

  return jsonb_build_object('id', v_bill.id, 'label', v_bill.label, 'cart', v_bill.cart);
end $$;

revoke all on function public.resume_held_bill(uuid) from public, anon;
grant execute on function public.resume_held_bill(uuid) to authenticated, service_role;

create or replace function public.discard_held_bill(p_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_bill  public.held_bills%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated.';
  end if;

  select * into v_bill from public.held_bills where id = p_id for update;
  if not found then
    raise exception 'Held bill not found.';
  end if;
  if v_bill.cashier_id <> v_user then
    raise exception 'This held bill belongs to another cashier.';
  end if;
  if v_bill.status = 'DISCARDED' then
    raise exception 'This held bill is already discarded.';
  end if;

  select email into v_email from public.profiles where id = v_user;

  update public.held_bills
     set status = 'DISCARDED', discarded_at = now(), updated_at = now()
   where id = p_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'bill_discarded', 'held_bill', p_id::text,
          jsonb_build_object('label', v_bill.label));

  return jsonb_build_object('id', v_bill.id, 'status', 'DISCARDED');
end $$;

revoke all on function public.discard_held_bill(uuid) from public, anon;
grant execute on function public.discard_held_bill(uuid) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 18 — sales_page(): database-side filtered + paginated sales history.
-- Never loads the whole table; filters: text search (invoice / customer /
-- cashier), date range, payment method, cashier, status, payment status.
-- ---------------------------------------------------------------------------
create or replace function public.sales_page(
  p_search         text default null,
  p_date_from      date default null,
  p_date_to        date default null,
  p_payment_method text default null,
  p_cashier_id     uuid default null,
  p_status         text default null,
  p_payment_status text default null,
  p_limit          int  default 25,
  p_offset         int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_sql      text;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('view_sales')
              or public.has_app_permission('create_sale')
              or public.has_app_permission('cancel_sale')) then
    raise exception 'You do not have permission to view sales.';
  end if;

  if p_status is not null and p_status not in ('COMPLETED','CANCELLED') then
    raise exception 'Invalid status filter.';
  end if;
  if p_payment_status is not null and p_payment_status not in ('PAID','PARTIALLY_PAID','DUE') then
    raise exception 'Invalid payment status filter.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(s.sale_number ILIKE %1$L OR s.customer_name ILIKE %1$L OR s.cashier_name ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('s.sale_date >= %L', (p_date_from::timestamptz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('s.sale_date < (%L::date + 1)::timestamptz', (p_date_to)::text);
  end if;
  if nullif(trim(coalesce(p_payment_method, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      'exists (select 1 from public.sale_payments sp where sp.sale_id = s.id and lower(sp.method) = lower(%L))',
      trim(p_payment_method));
  end if;
  if p_cashier_id is not null then
    v_filtered := true;
    v_where := v_where || format('s.cashier_id = %L', p_cashier_id::text);
  end if;
  if p_status is not null then
    v_filtered := true;
    v_where := v_where || format('s.status = %L', p_status);
  end if;
  if p_payment_status is not null then
    v_filtered := true;
    v_where := v_where || format('s.payment_status = %L', p_payment_status);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select s.id, s.sale_number, s.sale_date, s.status, s.payment_status,
             s.subtotal, s.bill_discount, s.tax_total, s.round_off, s.grand_total,
             s.paid_amount, s.due_amount,
             s.customer_id, s.customer_name, s.customer_phone,
             s.cashier_id, s.cashier_name,
             s.location_name,
             s.cancelled_at, s.cancel_reason,
             coalesce(ii.item_count, 0) as item_count,
             coalesce(ii.unit_count, 0) as unit_count,
             coalesce(pp.methods, '[]'::jsonb) as payment_methods,
             (s.cancelled_at is not null or s.status = 'CANCELLED') as is_cancelled
      from public.sales s
      left join lateral (
        select count(*) as item_count, sum(quantity) as unit_count
        from public.sale_items si where si.sale_id = s.id
      ) ii on true
      left join lateral (
        select coalesce(jsonb_agg(distinct sp.method), '[]'::jsonb) as methods
        from public.sale_payments sp where sp.sale_id = s.id
      ) pp on true
      where %s
      order by s.sale_date desc, s.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format($sql$
      select count(*) from public.sales s where %s
    $sql$, array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'sales' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.sales' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

revoke all on function public.sales_page(text, date, date, text, uuid, text, text, int, int) from public, anon;
grant execute on function public.sales_page(text, date, date, text, uuid, text, text, int, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 19 — sale_detail(): the complete record for the detail view and the
-- invoice (sale + items + payments + stock movement references).
-- ---------------------------------------------------------------------------
create or replace function public.sale_detail(p_sale_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_sale public.sales%rowtype;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('view_sales')
              or public.has_app_permission('create_sale')
              or public.has_app_permission('cancel_sale')) then
    raise exception 'You do not have permission to view sales.';
  end if;

  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'Sale not found.';
  end if;

  return jsonb_build_object(
    'sale', to_jsonb(v_sale),
    'items', (
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
        select si.* from public.sale_items si
        where si.sale_id = p_sale_id
        order by si.created_at, si.id
      ) t
    ),
    'payments', (
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
        select sp.* from public.sale_payments sp
        where sp.sale_id = p_sale_id
        order by sp.created_at, sp.id
      ) t
    ),
    'movements', (
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
        select sm.id, sm.variant_id, sm.movement_type, sm.quantity, sm.balance_after,
               sm.reference_type, sm.reference_id, sm.reason, sm.user_email, sm.created_at,
               pv.sku
        from public.stock_movements sm
        left join public.product_variants pv on pv.id = sm.variant_id
        where sm.reference_id = p_sale_id::text
          and sm.reference_type in ('sale','sale_cancel')
        order by sm.id
      ) t
    )
  );
end $$;

revoke all on function public.sale_detail(uuid) from public, anon;
grant execute on function public.sale_detail(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 20 — GRANTS (API surface: writes only through the RPCs; reads for
-- authenticated staff via RLS policies below).
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;

-- customers: read + create/edit by manage_customers holders (cashiers hold
-- it too — they create customers at the counter)
grant select, insert, update on public.customers to authenticated;
grant select, insert, update on public.customers to service_role;

-- sales history: read-only through the API (writes live inside create_sale /
-- cancel_sale only)
grant select on public.sales, public.sale_items, public.sale_payments to authenticated;
grant select on public.sales, public.sale_items, public.sale_payments to service_role;

-- held bills: cashier-private read/update via RLS (writes through RPCs)
grant select, update on public.held_bills to authenticated;
grant select, update on public.held_bills to service_role;

-- counters: RPC-internal only — NO api grants at all
revoke all on public.sale_number_counters from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 21 — RLS (secure by default; 0002 conventions)
-- ---------------------------------------------------------------------------
alter table public.customers         enable row level security;
alter table public.sales             enable row level security;
alter table public.sale_items        enable row level security;
alter table public.sale_payments     enable row level security;
alter table public.held_bills        enable row level security;
alter table public.sale_number_counters enable row level security;

-- CUSTOMERS: staff with manage_customers (Admin / Manager / Cashier)
drop policy if exists customers_select_mgr   on public.customers;
drop policy if exists customers_insert_mgr   on public.customers;
drop policy if exists customers_update_mgr   on public.customers;

create policy customers_select_mgr
  on public.customers for select to authenticated
  using (public.has_app_permission('manage_customers'));

create policy customers_insert_mgr
  on public.customers for insert to authenticated
  with check (public.has_app_permission('manage_customers'));

create policy customers_update_mgr
  on public.customers for update to authenticated
  using (public.has_app_permission('manage_customers'))
  with check (public.has_app_permission('manage_customers'));

-- SALES / ITEMS / PAYMENTS: read for sales viewers (view_sales, create_sale
-- or cancel_sale holders); NO write policies at all — quantities and records
-- change only through the SECURITY DEFINER engine RPCs.
drop policy if exists sales_select_staff   on public.sales;
drop policy if exists sale_items_select_staff on public.sale_items;
drop policy if exists sale_payments_select_staff on public.sale_payments;

create policy sales_select_staff
  on public.sales for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('create_sale')
         or public.has_app_permission('cancel_sale'));

create policy sale_items_select_staff
  on public.sale_items for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('create_sale')
         or public.has_app_permission('cancel_sale'));

create policy sale_payments_select_staff
  on public.sale_payments for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('create_sale')
         or public.has_app_permission('cancel_sale'));

-- HELD BILLS: strictly the owning cashier (RLS + the RPCs double-check)
drop policy if exists held_bills_select_own on public.held_bills;
drop policy if exists held_bills_update_own on public.held_bills;

create policy held_bills_select_own
  on public.held_bills for select to authenticated
  using (cashier_id = auth.uid());

create policy held_bills_update_own
  on public.held_bills for update to authenticated
  using (cashier_id = auth.uid())
  with check (cashier_id = auth.uid());

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (informational)
-- ---------------------------------------------------------------------------
select 'phase 3 tables created' as status,
       (select count(*) from public.customers)             as customers,
       (select count(*) from public.sales)                 as sales,
       (select count(*) from public.sale_number_counters)  as counters,
       (select count(*) from public.held_bills)            as held_bills,
       (select count(*) from public.role_permissions
        where permission in ('view_sales','override_sale_price','apply_discount')) as new_permissions;
