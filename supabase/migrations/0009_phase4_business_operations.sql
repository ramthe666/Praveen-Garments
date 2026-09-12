-- ============================================================================
-- PRAVEEN GARMENTS — Phase 4: Purchases + Suppliers + Customers + Returns +
--                              Exchanges + Refunds + Expenses + Dues
-- Migration 0009: business operations layer
--
-- Apply AFTER 0008. NON-DESTRUCTIVE: additive only — never alters, drops or
-- truncates Phase 1/2/3 schema or data. Safe to re-run (IF NOT EXISTS /
-- ON CONFLICT DO NOTHING / drop-policy-then-create / drop-constraint-then-
-- recreate with a SUPERSET of values so every existing row still validates).
--
-- DESIGN (mirrors the Phase 3 engine exactly):
--   * every historical document carries SNAPSHOT values (names, SKUs, costs,
--     tax rates) so price changes never rewrite history;
--   * every stock-changing operation is a SECURITY DEFINER RPC with row-
--     locked upserts, the app.stock_engine GUC, and full rollback on any
--     failure — no partial stock, no orphan financial records;
--   * document numbers come from the row-locked counter table (collision-
--     proof under concurrency), prefixes configurable via app_settings;
--   * money is recomputed SERVER-SIDE from database values; numeric only;
--   * RLS everywhere; writes go through RPCs, direct writes are denied;
--   * audit events for every business action.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PART 1 — enum extensions (own transaction: PostgreSQL forbids using a new
-- enum value inside the transaction that created it).
-- ---------------------------------------------------------------------------
begin;

alter type public.app_permission add value if not exists 'view_purchases';
alter type public.app_permission add value if not exists 'record_customer_payment';
alter type public.app_permission add value if not exists 'record_supplier_payment';
alter type public.app_permission add value if not exists 'approve_expense';
alter type public.app_permission add value if not exists 'approve_return';

alter type public.audit_action add value if not exists 'customer_created';
alter type public.audit_action add value if not exists 'customer_updated';
alter type public.audit_action add value if not exists 'supplier_created';
alter type public.audit_action add value if not exists 'supplier_updated';
alter type public.audit_action add value if not exists 'customer_payment_recorded';
alter type public.audit_action add value if not exists 'customer_advance_applied';
alter type public.audit_action add value if not exists 'supplier_payment_recorded';
alter type public.audit_action add value if not exists 'purchase_order_created';
alter type public.audit_action add value if not exists 'purchase_order_updated';
alter type public.audit_action add value if not exists 'purchase_order_cancelled';
alter type public.audit_action add value if not exists 'purchase_received';
alter type public.audit_action add value if not exists 'purchase_cancelled';
alter type public.audit_action add value if not exists 'purchase_return_processed';
alter type public.audit_action add value if not exists 'sales_return_processed';
alter type public.audit_action add value if not exists 'exchange_processed';
alter type public.audit_action add value if not exists 'expense_created';
alter type public.audit_action add value if not exists 'expense_updated';
alter type public.audit_action add value if not exists 'expense_approved';
alter type public.audit_action add value if not exists 'expense_cancelled';
alter type public.audit_action add value if not exists 'category_created';
alter type public.audit_action add value if not exists 'category_updated';

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 2 — CUSTOMERS extension (additive columns only; existing rows keep
-- their values; Phase 3 customers remain fully valid).
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists alt_phone
    text check (alt_phone is null or alt_phone ~ '^[0-9+\-\s()]{5,20}$'),
  add column if not exists pincode
    text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  add column if not exists customer_type
    text not null default 'retail'
    check (customer_type in ('retail','wholesale')),
  add column if not exists credit_limit
    numeric(12,2) not null default 0
    check (credit_limit >= 0);

create index if not exists customers_email_trgm_idx on public.customers using gin (email gin_trgm_ops);
create index if not exists customers_gstin_idx       on public.customers (gstin);
create index if not exists customers_type_idx        on public.customers (customer_type);

-- ---------------------------------------------------------------------------
-- PART 3 — SUPPLIERS
-- ---------------------------------------------------------------------------
create table if not exists public.suppliers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(trim(name)) between 1 and 120),
  contact_person text check (contact_person is null or length(trim(contact_person)) <= 120),
  phone          text check (phone is null or phone ~ '^[0-9+\-\s()]{5,20}$'),
  alt_phone      text check (alt_phone is null or alt_phone ~ '^[0-9+\-\s()]{5,20}$'),
  email          text check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  address        text,
  city           text,
  state          text check (state is null or length(trim(state)) <= 60),
  pincode        text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  gstin          text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  notes          text,
  is_active      boolean not null default true,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists suppliers_name_trgm_idx  on public.suppliers using gin (name gin_trgm_ops);
create index if not exists suppliers_phone_trgm_idx on public.suppliers using gin (phone gin_trgm_ops);
create index if not exists suppliers_gstin_idx      on public.suppliers (gstin);
create index if not exists suppliers_active_idx     on public.suppliers (id) where is_active = false;
create index if not exists suppliers_created_idx    on public.suppliers (created_at desc);

-- ---------------------------------------------------------------------------
-- PART 4 — PURCHASE ORDERS (DRAFT → ORDERED → PARTIALLY_RECEIVED → RECEIVED
-- / CANCELLED). Creating a PO NEVER touches stock — stock moves only when
-- goods are received through a purchase invoice.
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_orders (
  id             uuid primary key default gen_random_uuid(),
  po_number      text not null check (length(po_number) between 3 and 40),
  supplier_id    uuid not null references public.suppliers (id) on delete restrict,
  supplier_name  text not null,
  location_id    uuid not null references public.stock_locations (id),
  location_name  text not null,
  order_date     timestamptz not null default now(),
  expected_date  date,
  status         text not null default 'DRAFT'
                 check (status in ('DRAFT','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  subtotal       numeric(12,2) not null default 0,
  discount_total numeric(12,2) not null default 0,
  tax_total      numeric(12,2) not null default 0,
  grand_total    numeric(12,2) not null default 0,
  notes          text,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid references auth.users (id) on delete set null,
  cancel_reason  text
);

create unique index if not exists purchase_orders_number_key  on public.purchase_orders (po_number);
create index if not exists purchase_orders_supplier_idx       on public.purchase_orders (supplier_id, order_date desc);
create index if not exists purchase_orders_status_idx         on public.purchase_orders (status);
create index if not exists purchase_orders_date_idx           on public.purchase_orders (order_date desc, id desc);
create index if not exists purchase_orders_number_trgm_idx    on public.purchase_orders using gin (po_number gin_trgm_ops);

create table if not exists public.purchase_order_items (
  id               uuid primary key default gen_random_uuid(),
  po_id            uuid not null references public.purchase_orders (id) on delete cascade,
  variant_id       uuid references public.product_variants (id) on delete set null,
  line_no          integer not null default 0,
  -- snapshots (data integrity: PO of tomorrow shows today's names/costs)
  product_name     text not null check (length(product_name) between 1 and 200),
  sku              text not null,
  size_name        text,
  color_name       text,
  quantity         integer not null check (quantity > 0),
  unit_cost        numeric(12,2) not null check (unit_cost >= 0),
  discount_amount  numeric(12,2) not null default 0 check (discount_amount >= 0),
  gst_rate         numeric(5,2) not null default 0,
  tax_amount       numeric(12,2) not null default 0,
  line_total       numeric(12,2) not null,
  received_quantity integer not null default 0 check (received_quantity >= 0),
  created_at       timestamptz not null default now()
);

create index if not exists purchase_order_items_po_idx      on public.purchase_order_items (po_id);
create index if not exists purchase_order_items_variant_idx on public.purchase_order_items (variant_id);

-- re-run safety: earlier iterations of this migration created the table without line_no
alter table public.purchase_order_items
  add column if not exists line_no integer not null default 0;

-- ---------------------------------------------------------------------------
-- PART 5 — PURCHASE INVOICES (the goods receipt AND the supplier bill).
-- DRAFT = nothing happened yet. RECEIVED = stock increased, payable created,
-- PO progress updated — atomically. CANCELLED preserves the record and
-- (for received invoices with no payments/returns) reverses the stock.
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_invoices (
  id                   uuid primary key default gen_random_uuid(),
  invoice_number       text not null check (length(invoice_number) between 3 and 40),
  supplier_id          uuid not null references public.suppliers (id) on delete restrict,
  supplier_name        text not null,
  po_id                uuid references public.purchase_orders (id) on delete set null,
  po_number            text,
  supplier_invoice_no  text check (supplier_invoice_no is null or length(trim(supplier_invoice_no)) between 1 and 60),
  supplier_invoice_date date,
  location_id          uuid not null references public.stock_locations (id),
  location_name        text not null,
  invoice_date         timestamptz not null default now(),
  status               text not null default 'DRAFT'
                       check (status in ('DRAFT','RECEIVED','CANCELLED')),
  subtotal             numeric(12,2) not null default 0,
  discount_total       numeric(12,2) not null default 0,
  tax_total            numeric(12,2) not null default 0,
  grand_total          numeric(12,2) not null default 0,
  paid_amount          numeric(12,2) not null default 0,
  due_amount           numeric(12,2) not null default 0,
  payment_status       text not null default 'DUE'
                       check (payment_status in ('PAID','PARTIALLY_PAID','DUE')),
  tax_mode             text not null default 'inclusive' check (tax_mode in ('inclusive','exclusive')),
  inter_state          boolean not null default false,
  notes                text,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  received_at          timestamptz,
  received_by          uuid references auth.users (id) on delete set null,
  cancelled_at         timestamptz,
  cancelled_by         uuid references auth.users (id) on delete set null,
  cancel_reason        text
);

create unique index if not exists purchase_invoices_number_key on public.purchase_invoices (invoice_number);
-- duplicate supplier invoice numbers rejected per supplier (live docs only)
create unique index if not exists purchase_invoices_supplier_no_key
  on public.purchase_invoices (supplier_id, supplier_invoice_no)
  where supplier_invoice_no is not null and status <> 'CANCELLED';
create index if not exists purchase_invoices_supplier_idx  on public.purchase_invoices (supplier_id, invoice_date desc);
create index if not exists purchase_invoices_status_idx    on public.purchase_invoices (status);
create index if not exists purchase_invoices_pmt_idx       on public.purchase_invoices (payment_status, invoice_date desc);
create index if not exists purchase_invoices_po_idx        on public.purchase_invoices (po_id);
create index if not exists purchase_invoices_date_idx      on public.purchase_invoices (invoice_date desc, id desc);
create index if not exists purchase_invoices_number_trgm_idx on public.purchase_invoices using gin (invoice_number gin_trgm_ops);
create index if not exists purchase_invoices_supno_trgm_idx on public.purchase_invoices using gin (supplier_invoice_no gin_trgm_ops);

create table if not exists public.purchase_invoice_items (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.purchase_invoices (id) on delete cascade,
  po_item_id       uuid references public.purchase_order_items (id) on delete set null,
  variant_id       uuid references public.product_variants (id) on delete set null,
  line_no          integer not null default 0,
  -- snapshots
  product_name     text not null check (length(product_name) between 1 and 200),
  sku              text not null,
  size_name        text,
  color_name       text,
  quantity         integer not null check (quantity > 0),
  unit_cost        numeric(12,2) not null check (unit_cost >= 0),
  discount_amount  numeric(12,2) not null default 0 check (discount_amount >= 0),
  gst_rate         numeric(5,2) not null default 0,
  tax_amount       numeric(12,2) not null default 0,
  line_total       numeric(12,2) not null,
  returned_quantity integer not null default 0 check (returned_quantity >= 0),
  created_at       timestamptz not null default now()
);

create index if not exists purchase_invoice_items_invoice_idx on public.purchase_invoice_items (invoice_id);
create index if not exists purchase_invoice_items_variant_idx on public.purchase_invoice_items (variant_id);
create index if not exists purchase_invoice_items_poitem_idx  on public.purchase_invoice_items (po_item_id);

alter table public.purchase_invoice_items
  add column if not exists line_no integer not null default 0;

-- ---------------------------------------------------------------------------
-- PART 6 — CUSTOMER PAYMENTS (receipts) + FIFO allocations against due bills.
-- A receipt reduces the customer's outstanding balance by allocating to the
-- OLDEST due sale first (statement-correct). Unallocated remainder (only
-- when advance payments are enabled) is stored as customer credit.
-- ---------------------------------------------------------------------------
create table if not exists public.customer_payments (
  id               uuid primary key default gen_random_uuid(),
  receipt_number   text not null check (length(receipt_number) between 3 and 40),
  customer_id      uuid not null references public.customers (id) on delete restrict,
  customer_name    text not null,
  amount           numeric(12,2) not null check (amount > 0),
  allocated_amount numeric(12,2) not null default 0
                   check (allocated_amount >= 0 and allocated_amount <= amount),
  method           text not null check (length(trim(method)) between 1 and 40),
  reference        text check (reference is null or length(trim(reference)) <= 80),
  notes            text,
  recorded_by      uuid references auth.users (id) on delete set null,
  recorded_by_name text,
  recorded_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create unique index if not exists customer_payments_number_key  on public.customer_payments (receipt_number);
create index if not exists customer_payments_customer_idx       on public.customer_payments (customer_id, recorded_at desc);
create index if not exists customer_payments_method_idx         on public.customer_payments (method, recorded_at desc);
create index if not exists customer_payments_date_idx           on public.customer_payments (recorded_at desc, id desc);
create index if not exists customer_payments_unallocated_idx    on public.customer_payments (customer_id)
  where allocated_amount < amount;

create table if not exists public.customer_payment_allocations (
  id           bigint generated always as identity primary key,
  payment_id   uuid not null references public.customer_payments (id) on delete cascade,
  sale_id      uuid not null references public.sales (id) on delete restrict,
  sale_number  text not null,
  amount       numeric(12,2) not null check (amount > 0),
  created_at   timestamptz not null default now()
);

create index if not exists customer_payment_allocations_payment_idx on public.customer_payment_allocations (payment_id);
create index if not exists customer_payment_allocations_sale_idx    on public.customer_payment_allocations (sale_id);

-- ---------------------------------------------------------------------------
-- PART 7 — SUPPLIER PAYMENTS (mirror of customer payments, allocated FIFO
-- against due purchase invoices).
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_payments (
  id               uuid primary key default gen_random_uuid(),
  payment_number   text not null check (length(payment_number) between 3 and 40),
  supplier_id      uuid not null references public.suppliers (id) on delete restrict,
  supplier_name    text not null,
  amount           numeric(12,2) not null check (amount > 0),
  allocated_amount numeric(12,2) not null default 0
                   check (allocated_amount >= 0 and allocated_amount <= amount),
  method           text not null check (length(trim(method)) between 1 and 40),
  reference        text check (reference is null or length(trim(reference)) <= 80),
  notes            text,
  recorded_by      uuid references auth.users (id) on delete set null,
  recorded_by_name text,
  recorded_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create unique index if not exists supplier_payments_number_key  on public.supplier_payments (payment_number);
create index if not exists supplier_payments_supplier_idx       on public.supplier_payments (supplier_id, recorded_at desc);
create index if not exists supplier_payments_method_idx         on public.supplier_payments (method, recorded_at desc);
create index if not exists supplier_payments_date_idx           on public.supplier_payments (recorded_at desc, id desc);
create index if not exists supplier_payments_unallocated_idx    on public.supplier_payments (supplier_id)
  where allocated_amount < amount;

create table if not exists public.supplier_payment_allocations (
  id             bigint generated always as identity primary key,
  payment_id     uuid not null references public.supplier_payments (id) on delete cascade,
  invoice_id     uuid not null references public.purchase_invoices (id) on delete restrict,
  invoice_number text not null,
  amount         numeric(12,2) not null check (amount > 0),
  created_at     timestamptz not null default now()
);

create index if not exists supplier_payment_allocations_payment_idx on public.supplier_payment_allocations (payment_id);
create index if not exists supplier_payment_allocations_invoice_idx on public.supplier_payment_allocations (invoice_id);

-- ---------------------------------------------------------------------------
-- PART 8 — SALES RETURNS (per-item condition GOOD/DAMAGED; refunds; the
-- original sale record is never mutated except its due balance).
-- ---------------------------------------------------------------------------
create table if not exists public.sales_returns (
  id                uuid primary key default gen_random_uuid(),
  return_number     text not null check (length(return_number) between 3 and 40),
  sale_id           uuid not null references public.sales (id) on delete restrict,
  sale_number       text not null,
  customer_id       uuid references public.customers (id) on delete set null,
  customer_name     text,
  return_date       timestamptz not null default now(),
  reason            text not null check (length(trim(reason)) between 3 and 300),
  refund_method     text check (refund_method is null or length(trim(refund_method)) between 1 and 40),
  refund_amount     numeric(12,2) not null default 0 check (refund_amount >= 0),
  refund_reference  text check (refund_reference is null or length(trim(refund_reference)) <= 80),
  applied_to_due    numeric(12,2) not null default 0 check (applied_to_due >= 0),
  refunded_by       uuid references auth.users (id) on delete set null,
  refunded_by_name  text,
  refunded_at       timestamptz,
  notes             text,
  created_by        uuid references auth.users (id) on delete set null,
  created_by_name   text,
  created_at        timestamptz not null default now()
);

create unique index if not exists sales_returns_number_key  on public.sales_returns (return_number);
create index if not exists sales_returns_sale_idx           on public.sales_returns (sale_id);
create index if not exists sales_returns_customer_idx       on public.sales_returns (customer_id, return_date desc);
create index if not exists sales_returns_date_idx           on public.sales_returns (return_date desc, id desc);

create table if not exists public.sales_return_items (
  id            uuid primary key default gen_random_uuid(),
  return_id     uuid not null references public.sales_returns (id) on delete restrict,
  sale_item_id  uuid not null references public.sale_items (id) on delete restrict,
  variant_id    uuid references public.product_variants (id) on delete set null,
  line_no       integer not null default 0,
  -- snapshots from the original sale line
  product_name  text not null check (length(product_name) between 1 and 200),
  sku           text not null,
  quantity      integer not null check (quantity > 0),
  condition     text not null default 'GOOD' check (condition in ('GOOD','DAMAGED')),
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  tax_rate      numeric(5,2) not null default 0,
  tax_amount    numeric(12,2) not null default 0,
  line_refund   numeric(12,2) not null check (line_refund >= 0),
  created_at    timestamptz not null default now()
);

create index if not exists sales_return_items_return_idx    on public.sales_return_items (return_id);
create index if not exists sales_return_items_saleitem_idx  on public.sales_return_items (sale_item_id);

alter table public.sales_return_items
  add column if not exists line_no integer not null default 0;

-- ---------------------------------------------------------------------------
-- PART 9 — PURCHASE RETURNS (goods back to the supplier; stock decreases;
-- supplier payable adjusts as a credit note against the invoice).
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_returns (
  id                   uuid primary key default gen_random_uuid(),
  return_number        text not null check (length(return_number) between 3 and 40),
  purchase_invoice_id  uuid not null references public.purchase_invoices (id) on delete restrict,
  invoice_number       text not null,
  supplier_id          uuid not null references public.suppliers (id) on delete restrict,
  supplier_name        text not null,
  return_date          timestamptz not null default now(),
  reason               text not null check (length(trim(reason)) between 3 and 300),
  subtotal             numeric(12,2) not null default 0,
  tax_total            numeric(12,2) not null default 0,
  grand_total          numeric(12,2) not null default 0,
  applied_to_due       numeric(12,2) not null default 0 check (applied_to_due >= 0),
  notes                text,
  created_by           uuid references auth.users (id) on delete set null,
  created_by_name      text,
  created_at           timestamptz not null default now()
);

create unique index if not exists purchase_returns_number_key on public.purchase_returns (return_number);
create index if not exists purchase_returns_invoice_idx       on public.purchase_returns (purchase_invoice_id);
create index if not exists purchase_returns_supplier_idx      on public.purchase_returns (supplier_id, return_date desc);
create index if not exists purchase_returns_date_idx          on public.purchase_returns (return_date desc, id desc);

create table if not exists public.purchase_return_items (
  id              uuid primary key default gen_random_uuid(),
  return_id       uuid not null references public.purchase_returns (id) on delete restrict,
  invoice_item_id uuid not null references public.purchase_invoice_items (id) on delete restrict,
  variant_id      uuid references public.product_variants (id) on delete set null,
  line_no         integer not null default 0,
  -- snapshots from the original invoice line
  product_name    text not null check (length(product_name) between 1 and 200),
  sku             text not null,
  quantity        integer not null check (quantity > 0),
  unit_cost       numeric(12,2) not null check (unit_cost >= 0),
  tax_rate        numeric(5,2) not null default 0,
  tax_amount      numeric(12,2) not null default 0,
  line_total      numeric(12,2) not null,
  created_at      timestamptz not null default now()
);

create index if not exists purchase_return_items_return_idx     on public.purchase_return_items (return_id);
create index if not exists purchase_return_items_invoiceitem_idx on public.purchase_return_items (invoice_item_id);

alter table public.purchase_return_items
  add column if not exists line_no integer not null default 0;

-- ---------------------------------------------------------------------------
-- PART 10 — EXCHANGES (return old item(s) + issue new item(s); the price
-- difference is either collected or refunded).
-- ---------------------------------------------------------------------------
create table if not exists public.exchanges (
  id                uuid primary key default gen_random_uuid(),
  exchange_number   text not null check (length(exchange_number) between 3 and 40),
  sale_id           uuid not null references public.sales (id) on delete restrict,
  sale_number       text not null,
  customer_id       uuid references public.customers (id) on delete set null,
  customer_name     text,
  exchange_date     timestamptz not null default now(),
  reason            text not null check (length(trim(reason)) between 3 and 300),
  return_value      numeric(12,2) not null default 0,
  issue_value       numeric(12,2) not null default 0,
  difference_amount numeric(12,2) not null default 0,
  payment_method    text check (payment_method is null or length(trim(payment_method)) between 1 and 40),
  payment_amount    numeric(12,2) not null default 0 check (payment_amount >= 0),
  payment_reference text check (payment_reference is null or length(trim(payment_reference)) <= 80),
  notes             text,
  created_by        uuid references auth.users (id) on delete set null,
  created_by_name   text,
  created_at        timestamptz not null default now()
);

create unique index if not exists exchanges_number_key on public.exchanges (exchange_number);
create index if not exists exchanges_sale_idx          on public.exchanges (sale_id);
create index if not exists exchanges_customer_idx      on public.exchanges (customer_id, exchange_date desc);
create index if not exists exchanges_date_idx          on public.exchanges (exchange_date desc, id desc);

create table if not exists public.exchange_items_in (
  id            uuid primary key default gen_random_uuid(),
  exchange_id   uuid not null references public.exchanges (id) on delete cascade,
  sale_item_id  uuid not null references public.sale_items (id) on delete restrict,
  variant_id    uuid references public.product_variants (id) on delete set null,
  line_no       integer not null default 0,
  product_name  text not null check (length(product_name) between 1 and 200),
  sku           text not null,
  quantity      integer not null check (quantity > 0),
  condition     text not null default 'GOOD' check (condition in ('GOOD','DAMAGED')),
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  line_value    numeric(12,2) not null check (line_value >= 0),
  created_at    timestamptz not null default now()
);

create index if not exists exchange_items_in_exchange_idx on public.exchange_items_in (exchange_id);
create index if not exists exchange_items_in_saleitem_idx on public.exchange_items_in (sale_item_id);

alter table public.exchange_items_in
  add column if not exists line_no integer not null default 0;

create table if not exists public.exchange_items_out (
  id            uuid primary key default gen_random_uuid(),
  exchange_id   uuid not null references public.exchanges (id) on delete cascade,
  variant_id    uuid not null references public.product_variants (id) on delete restrict,
  line_no       integer not null default 0,
  -- snapshots
  product_name  text not null check (length(product_name) between 1 and 200),
  sku           text not null,
  size_name     text,
  color_name    text,
  quantity      integer not null check (quantity > 0),
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  gst_rate      numeric(5,2) not null default 0,
  tax_amount    numeric(12,2) not null default 0,
  line_total    numeric(12,2) not null,
  created_at    timestamptz not null default now()
);

create index if not exists exchange_items_out_exchange_idx on public.exchange_items_out (exchange_id);
create index if not exists exchange_items_out_variant_idx  on public.exchange_items_out (variant_id);

alter table public.exchange_items_out
  add column if not exists line_no integer not null default 0;

-- ---------------------------------------------------------------------------
-- PART 11 — EXPENSES (categories are data, admin-managed — never hardcoded).
-- ---------------------------------------------------------------------------
create table if not exists public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 2 and 60),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists expense_categories_name_key
  on public.expense_categories (lower(name));

insert into public.expense_categories (name) values
  ('Rent'), ('Electricity'), ('Salary'), ('Transport'),
  ('Maintenance'), ('Supplies'), ('Marketing'), ('Other')
on conflict do nothing;

create table if not exists public.expenses (
  id               uuid primary key default gen_random_uuid(),
  expense_number   text not null check (length(expense_number) between 3 and 40),
  category_id      uuid not null references public.expense_categories (id) on delete restrict,
  category_name    text not null,
  description      text not null check (length(trim(description)) between 3 and 300),
  amount           numeric(12,2) not null check (amount > 0),
  method           text not null check (length(trim(method)) between 1 and 40),
  location_id      uuid references public.stock_locations (id) on delete set null,
  location_name    text,
  expense_date     date not null default current_date,
  notes            text,
  -- attachment stored in the expense-attachments bucket (validated server-side)
  attachment_path  text check (attachment_path is null or length(attachment_path) <= 300),
  attachment_name  text,
  attachment_size  bigint check (attachment_size is null or attachment_size >= 0),
  attachment_mime  text,
  status           text not null default 'PENDING'
                   check (status in ('PENDING','APPROVED','CANCELLED')),
  created_by       uuid references auth.users (id) on delete set null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  approved_by      uuid references auth.users (id) on delete set null,
  approved_by_name text,
  approved_at      timestamptz,
  cancelled_at     timestamptz,
  cancelled_by     uuid references auth.users (id) on delete set null,
  cancel_reason    text
);

create unique index if not exists expenses_number_key  on public.expenses (expense_number);
create index if not exists expenses_category_idx       on public.expenses (category_id, expense_date desc);
create index if not exists expenses_status_idx         on public.expenses (status);
create index if not exists expenses_date_idx           on public.expenses (expense_date desc, id desc);
create index if not exists expenses_created_by_idx     on public.expenses (created_by, created_at desc);
create index if not exists expenses_number_trgm_idx    on public.expenses using gin (expense_number gin_trgm_ops);
create index if not exists expenses_desc_trgm_idx      on public.expenses using gin (description gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- PART 12 — settings additions (merge new keys; user values preserved).
--   returns.*  : return policy (window, approvals, damaged handling…)
--   numbering.*: configurable document prefixes
--   payments.allow_advance_payments : customer advance receipts
-- ---------------------------------------------------------------------------
update public.app_settings
  set value = value || jsonb_build_object(
    'enabled',            true,
    'exchange_enabled',   true,
    'refund_enabled',     true,
    'damaged_to_location', true,
    'manager_approval',   false,
    'max_return_qty_pct', 100
  )
  where key = 'returns' and not (value ? 'exchange_enabled');

insert into public.app_settings (key, value) values
  ('numbering', '{
    "purchase_order_prefix": "PO",
    "purchase_invoice_prefix": "PI",
    "purchase_return_prefix": "PR",
    "sales_return_prefix": "SR",
    "exchange_prefix": "EX",
    "expense_prefix": "EXP",
    "customer_receipt_prefix": "CR",
    "supplier_payment_prefix": "SP"
  }'::jsonb)
on conflict (key) do nothing;

update public.app_settings
  set value = value || jsonb_build_object('allow_advance_payments', false)
  where key = 'payments' and not (value ? 'allow_advance_payments');

-- ---------------------------------------------------------------------------
-- PART 13 — permission seeds (Admin-editable in Settings → Roles later)
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  ('admin',           'view_purchases'),
  ('admin',           'record_customer_payment'),
  ('admin',           'record_supplier_payment'),
  ('admin',           'approve_expense'),
  ('admin',           'approve_return'),
  ('manager',         'view_purchases'),
  ('manager',         'record_customer_payment'),
  ('manager',         'record_supplier_payment'),
  ('manager',         'approve_expense'),
  ('manager',         'approve_return'),
  ('cashier',         'record_customer_payment'),
  ('purchase_manager','view_purchases'),
  ('purchase_manager','record_supplier_payment'),
  ('accountant',      'view_purchases'),
  ('accountant',      'record_customer_payment'),
  ('accountant',      'record_supplier_payment'),
  ('accountant',      'approve_expense'),
  ('inventory_manager','view_purchases')
on conflict (role, permission) do nothing;

-- ---------------------------------------------------------------------------
-- PART 14 — damaged-goods stock location. The check constraint is recreated
-- with a SUPERSET of values (store, warehouse, damaged) so every existing
-- row still validates; a "Damaged Goods" location is seeded once.
-- ---------------------------------------------------------------------------
do $$ begin
  alter table public.stock_locations drop constraint if exists stock_locations_location_type_check;
exception when others then null; end $$;

alter table public.stock_locations
  add constraint stock_locations_location_type_check
  check (location_type in ('store','warehouse','damaged'));

insert into public.stock_locations (name, code, location_type, is_active)
select 'Damaged Goods', 'DMG', 'damaged', true
where not exists (select 1 from public.stock_locations where location_type = 'damaged');

-- ---------------------------------------------------------------------------
-- PART 15 — expense-attachments storage bucket (private; type + size limits
-- enforced at the bucket AND validated again in the upload API route).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'expense-attachments',
  'expense-attachments',
  false,
  5242880, -- 5 MB
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set file_size_limit    = 5242880,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

drop policy if exists expense_attachments_select on storage.objects;
drop policy if exists expense_attachments_insert on storage.objects;
drop policy if exists expense_attachments_update on storage.objects;
drop policy if exists expense_attachments_delete on storage.objects;

create policy expense_attachments_select
  on storage.objects for select to authenticated
  using (bucket_id = 'expense-attachments' and public.has_app_permission('manage_expenses'));

create policy expense_attachments_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'expense-attachments' and public.has_app_permission('manage_expenses'));

create policy expense_attachments_update
  on storage.objects for update to authenticated
  using (bucket_id = 'expense-attachments' and public.has_app_permission('manage_expenses'))
  with check (bucket_id = 'expense-attachments' and public.has_app_permission('manage_expenses'));

create policy expense_attachments_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'expense-attachments' and public.has_app_permission('manage_expenses'));

-- ---------------------------------------------------------------------------
-- PART 16 — document numbering helper (row-locked counters — the same
-- collision-proof table Phase 3 uses; prefixes are configurable through
-- app_settings.numbering). RPC-internal only: no grants to API roles.
-- ---------------------------------------------------------------------------
create or replace function public.next_doc_number(p_prefix text)
returns text
language plpgsql
security definer set search_path = public as $$
declare
  v_prefix     text := coalesce(nullif(upper(trim(coalesce(p_prefix, ''))), ''), 'DOC');
  v_tz         text := coalesce(nullif(trim((select cs.timezone from public.company_settings cs limit 1)), ''), 'Asia/Kolkata');
  v_year       text := to_char(now() at time zone v_tz, 'YYYY');
  v_counter_id text;
  v_n          bigint;
begin
  if v_prefix !~ '^[A-Z0-9_-]{1,12}$' then
    raise exception 'Invalid document prefix "%".', v_prefix;
  end if;
  v_counter_id := v_prefix || '-' || v_year;
  insert into public.sale_number_counters (id, last_number)
  values (v_counter_id, 1)
  on conflict (id)
  do update set last_number = public.sale_number_counters.last_number + 1
  returning last_number into v_n;
  return v_counter_id || '-' || lpad(v_n::text, 6, '0');
end $$;

create or replace function public.doc_prefix(p_key text, p_default text)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(upper(trim(coalesce(
      (select value ->> p_key from public.app_settings where key = 'numbering'),
      ''
    ))), ''),
    p_default
  );
$$;

revoke all on function public.next_doc_number(text) from public, anon;
revoke all on function public.doc_prefix(text, text) from public, anon;

-- ---------------------------------------------------------------------------
-- PART 17 — audit trail for directory CRUD (customers / suppliers /
-- expense categories are written directly under RLS; the row-change trigger
-- attributes every event to the acting user). Extended with the same
-- jsonb-safe field access 0008 introduced; identical behaviour where it
-- already worked.
-- ---------------------------------------------------------------------------
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
  v_new_id := coalesce(to_jsonb(new) ->> 'id', to_jsonb(new) ->> 'key');
  v_old_id := coalesce(to_jsonb(old) ->> 'id', to_jsonb(old) ->> 'key');

  if tg_op = 'INSERT' then
    v_action := case tg_table_name
      when 'branches'           then 'branch_created'
      when 'profiles'           then 'user_created'
      when 'customers'          then 'customer_created'
      when 'suppliers'          then 'supplier_created'
      when 'expense_categories' then 'category_created'
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
    if (to_jsonb(old) - 'updated_at' - 'last_login_at')
       is not distinct from
       (to_jsonb(new) - 'updated_at' - 'last_login_at') then
      return new;
    end if;
    v_action := case tg_table_name
      when 'branches'           then 'branch_updated'
      when 'profiles'           then 'user_updated'
      when 'customers'          then 'customer_updated'
      when 'suppliers'          then 'supplier_updated'
      when 'expense_categories' then 'category_updated'
      when 'expenses'           then 'expense_updated'
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

-- attach to the new mutable tables (drop-if-exists keeps re-runs safe)
drop trigger if exists suppliers_set_updated_at on public.suppliers;
create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function public.set_updated_at();
drop trigger if exists suppliers_audit_row on public.suppliers;
create trigger suppliers_audit_row
  after insert or update on public.suppliers
  for each row execute function public.audit_row_change();

drop trigger if exists customers_audit_row on public.customers;
create trigger customers_audit_row
  after insert or update on public.customers
  for each row execute function public.audit_row_change();

drop trigger if exists purchase_orders_set_updated_at on public.purchase_orders;
create trigger purchase_orders_set_updated_at
  before update on public.purchase_orders
  for each row execute function public.set_updated_at();
drop trigger if exists purchase_invoices_set_updated_at on public.purchase_invoices;
create trigger purchase_invoices_set_updated_at
  before update on public.purchase_invoices
  for each row execute function public.set_updated_at();
drop trigger if exists expenses_set_updated_at on public.expenses;
create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();
drop trigger if exists expense_categories_set_updated_at on public.expense_categories;
create trigger expense_categories_set_updated_at
  before update on public.expense_categories
  for each row execute function public.set_updated_at();

-- expense row changes: UPDATEs audited here (INSERTs/approvals/cancels are
-- RPC-driven and write richer audit rows themselves)
drop trigger if exists expenses_audit_row on public.expenses;
create trigger expenses_audit_row
  after update on public.expenses
  for each row execute function public.audit_row_change();

drop trigger if exists expense_categories_audit_row on public.expense_categories;
create trigger expense_categories_audit_row
  after insert or update on public.expense_categories
  for each row execute function public.audit_row_change();

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 18 — shared validation helpers used by the Phase 4 engines.
-- ---------------------------------------------------------------------------
create or replace function public.require_permission(p public.app_permission, p_message text)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.';
  end if;
  if not public.has_app_permission(p) then
    raise exception 'PERMISSION_DENIED: %', coalesce(nullif(p_message, ''), 'You do not have permission to do this.');
  end if;
end $$;

create or replace function public.canonical_payment_method(p_method text)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_methods text[];
  v_canon   text;
begin
  v_methods := coalesce(
    (select array(select jsonb_array_elements_text(value -> 'methods')
                  from public.app_settings where key = 'payments')),
    array[]::text[]);
  select m into v_canon from unnest(v_methods) m where lower(m) = lower(trim(p_method)) limit 1;
  return v_canon;
end $$;

revoke all on function public.require_permission(public.app_permission, text) from public, anon;
revoke all on function public.canonical_payment_method(text) from public, anon;
grant execute on function public.require_permission(public.app_permission, text) to authenticated, service_role;
grant execute on function public.canonical_payment_method(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 19 — record_customer_payment(): the atomic customer receipt engine.
--
-- One transaction: permission → customer → method → amount vs outstanding
-- (advance only when enabled) → receipt number → payment row → FIFO
-- allocation against the OLDEST due bills (row-locked, deadlock-safe
-- ordering) → sale balances + sale payment history → audit.
-- Any failure rolls back everything: no payment without allocation changes,
-- no balance change without a payment.
-- ---------------------------------------------------------------------------
create or replace function public.record_customer_payment(
  p_customer_id uuid,
  p_amount      numeric,
  p_method      text,
  p_reference   text default null,
  p_notes       text default null,
  p_payment_date timestamptz default null
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user      uuid := auth.uid();
  v_email     text;
  v_name      text;
  v_customer  public.customers%rowtype;
  v_canon     text;
  v_amount    numeric;
  v_outstanding numeric;
  v_allow_advance boolean;
  v_receipt   text;
  v_payment_id uuid;
  v_allocated  numeric := 0;
  v_row        record;
  v_apply      numeric;
  v_new_paid   numeric;
  v_new_due    numeric;
  v_new_status text;
begin
  perform public.require_permission('record_customer_payment', 'You do not have permission to record customer payments.');

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id and is_active;
  if v_customer.id is null then
    raise exception 'CUSTOMER_NOT_FOUND: customer not found or inactive.';
  end if;

  if coalesce(p_amount, 0)::text !~ '^[0-9]+(\.[0-9]{1,2})?$' or coalesce(p_amount, 0) <= 0 then
    raise exception 'Invalid payment amount.';
  end if;
  v_amount := round(p_amount, 2);

  v_canon := public.canonical_payment_method(coalesce(p_method, ''));
  if v_canon is null then
    raise exception 'PAYMENT_METHOD_DISABLED: "%" is not an accepted payment method.', coalesce(p_method, '');
  end if;

  v_allow_advance := coalesce(
    (public.setting_of('payments', 'allow_advance_payments', 'false'::jsonb))::boolean, false);

  -- serialize concurrent payments for this customer (same lock order as the
  -- FIFO loop below) BEFORE reading the outstanding balance, so the
  -- exceeds-due check can never race past a parallel payment.
  perform 1
    from public.sales s
    where s.customer_id = p_customer_id
      and s.status = 'COMPLETED'
      and s.due_amount > 0
    order by s.sale_date asc, s.id asc
    for update;

  select coalesce(sum(due_amount), 0) into v_outstanding
    from public.sales
    where customer_id = p_customer_id
      and status = 'COMPLETED'
      and due_amount > 0;

  if v_amount > round(v_outstanding, 2) and not v_allow_advance then
    raise exception 'PAYMENT_EXCEEDS_DUE: the outstanding balance is only %.', v_outstanding;
  end if;

  v_receipt := public.next_doc_number(public.doc_prefix('customer_receipt_prefix', 'CR'));

  insert into public.customer_payments (
    receipt_number, customer_id, customer_name, amount, allocated_amount,
    method, reference, notes, recorded_by, recorded_by_name, recorded_at
  ) values (
    v_receipt, p_customer_id, v_customer.name, v_amount, 0,
    v_canon, nullif(trim(coalesce(p_reference, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    v_user, coalesce(nullif(v_name, ''), v_email), coalesce(p_payment_date, now())
  )
  returning id into v_payment_id;

  -- FIFO allocation: oldest due bills first; deterministic row order keeps
  -- concurrent payments deadlock-free.
  for v_row in
    select s.id, s.sale_number, s.due_amount
      from public.sales s
      where s.customer_id = p_customer_id
        and s.status = 'COMPLETED'
        and s.due_amount > 0
      order by s.sale_date asc, s.id asc
      for update
  loop
    exit when v_allocated >= v_amount;
    v_apply := least(v_row.due_amount, v_amount - v_allocated);

    insert into public.customer_payment_allocations (payment_id, sale_id, sale_number, amount)
    values (v_payment_id, v_row.id, v_row.sale_number, round(v_apply, 2));

    v_new_paid := 0; v_new_due := 0; v_new_status := 'DUE';
    update public.sales
      set paid_amount = paid_amount + round(v_apply, 2),
          due_amount  = due_amount  - round(v_apply, 2),
          payment_status = case
            when due_amount - round(v_apply, 2) <= 0 then 'PAID'
            when paid_amount + round(v_apply, 2) > 0 then 'PARTIALLY_PAID'
            else 'DUE' end::text
      where id = v_row.id
      returning paid_amount, due_amount into v_new_paid, v_new_due;

    -- the bill's own payment history stays complete (invoice shows receipts)
    insert into public.sale_payments (
      sale_id, method, amount, reference, is_credit, recorded_by
    ) values (
      v_row.id, v_canon, round(v_apply, 2), v_receipt, false, v_user
    );

    v_allocated := round(v_allocated + v_apply, 2);
  end loop;

  update public.customer_payments
    set allocated_amount = v_allocated
    where id = v_payment_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'customer_payment_recorded', 'customer_payment', v_payment_id::text,
          jsonb_build_object(
            'receipt_number', v_receipt,
            'customer', v_customer.name,
            'customer_id', p_customer_id,
            'amount', v_amount,
            'allocated', v_allocated,
            'advance', round(v_amount - v_allocated, 2),
            'method', v_canon,
            'outstanding_before', v_outstanding,
            'outstanding_after', round(v_outstanding - v_allocated, 2)
          ));

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_number', v_receipt,
    'amount', v_amount,
    'allocated_amount', v_allocated,
    'advance_amount', round(v_amount - v_allocated, 2),
    'method', v_canon,
    'outstanding_after', round(v_outstanding - v_allocated, 2)
  );
end $$;

revoke all on function public.record_customer_payment(uuid, numeric, text, text, text, timestamptz) from public, anon;
grant execute on function public.record_customer_payment(uuid, numeric, text, text, text, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 20 — apply_customer_advance(): moves stored credit (unallocated
-- receipt remainder) onto current due bills. FIFO in both directions.
-- ---------------------------------------------------------------------------
create or replace function public.apply_customer_advance(p_customer_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user     uuid := auth.uid();
  v_email    text;
  v_applied  numeric := 0;
  v_payment  record;
  v_row      record;
  v_apply    numeric;
begin
  perform public.require_permission('record_customer_payment', 'You do not have permission to apply customer credit.');

  select email into v_email from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  for v_row in
    select s.id, s.sale_number, s.due_amount
      from public.sales s
      where s.customer_id = p_customer_id
        and s.status = 'COMPLETED'
        and s.due_amount > 0
      order by s.sale_date asc, s.id asc
      for update
  loop
    for v_payment in
      select cp.id, cp.receipt_number, (cp.amount - cp.allocated_amount) as available
        from public.customer_payments cp
        where cp.customer_id = p_customer_id
          and cp.allocated_amount < cp.amount
        order by cp.recorded_at asc, cp.id asc
        for update
    loop
      exit when v_row.due_amount <= 0;
      v_apply := least(v_row.due_amount, v_payment.available);
      if v_apply <= 0 then continue; end if;

      insert into public.customer_payment_allocations (payment_id, sale_id, sale_number, amount)
      values (v_payment.id, v_row.id, v_row.sale_number, round(v_apply, 2));

      update public.customer_payments
        set allocated_amount = allocated_amount + round(v_apply, 2)
        where id = v_payment.id;

      update public.sales
        set paid_amount = paid_amount + round(v_apply, 2),
            due_amount  = due_amount  - round(v_apply, 2),
            payment_status = case
              when due_amount - round(v_apply, 2) <= 0 then 'PAID'
              when paid_amount + round(v_apply, 2) > 0 then 'PARTIALLY_PAID'
              else 'DUE' end::text
        where id = v_row.id;

      insert into public.sale_payments (sale_id, method, amount, reference, is_credit, recorded_by)
      values (v_row.id, 'Store Credit', round(v_apply, 2), v_payment.receipt_number, false, v_user);

      v_row.due_amount := v_row.due_amount - v_apply;
      v_applied := round(v_applied + v_apply, 2);
    end loop;
  end loop;

  if v_applied > 0 then
    insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
    values (v_user, v_email, 'customer_advance_applied', 'customer', p_customer_id::text,
            jsonb_build_object('applied', v_applied));
  end if;

  return jsonb_build_object('applied_amount', v_applied);
end $$;

revoke all on function public.apply_customer_advance(uuid) from public, anon;
grant execute on function public.apply_customer_advance(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 21 — record_supplier_payment(): the supplier payment engine (mirror
-- of the customer engine; allocates FIFO against due purchase invoices).
-- ---------------------------------------------------------------------------
create or replace function public.record_supplier_payment(
  p_supplier_id  uuid,
  p_amount       numeric,
  p_method       text,
  p_reference    text default null,
  p_notes        text default null,
  p_payment_date timestamptz default null
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user      uuid := auth.uid();
  v_email     text;
  v_name      text;
  v_supplier  public.suppliers%rowtype;
  v_canon     text;
  v_amount    numeric;
  v_payable   numeric;
  v_allow_advance boolean;
  v_payment_no text;
  v_payment_id uuid;
  v_allocated  numeric := 0;
  v_row        record;
  v_apply      numeric;
begin
  perform public.require_permission('record_supplier_payment', 'You do not have permission to record supplier payments.');

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_supplier from public.suppliers
    where id = p_supplier_id and is_active;
  if v_supplier.id is null then
    raise exception 'SUPPLIER_NOT_FOUND: supplier not found or inactive.';
  end if;

  if coalesce(p_amount, 0)::text !~ '^[0-9]+(\.[0-9]{1,2})?$' or coalesce(p_amount, 0) <= 0 then
    raise exception 'Invalid payment amount.';
  end if;
  v_amount := round(p_amount, 2);

  v_canon := public.canonical_payment_method(coalesce(p_method, ''));
  if v_canon is null then
    raise exception 'PAYMENT_METHOD_DISABLED: "%" is not an accepted payment method.', coalesce(p_method, '');
  end if;

  v_allow_advance := coalesce(
    (public.setting_of('payments', 'allow_advance_payments', 'false'::jsonb))::boolean, false);

  -- serialize concurrent payments for this supplier (same lock order as the
  -- FIFO loop below) BEFORE reading the payable, so the exceeds-due check
  -- can never race past a parallel payment.
  perform 1
    from public.purchase_invoices pi
    where pi.supplier_id = p_supplier_id
      and pi.status = 'RECEIVED'
      and pi.due_amount > 0
    order by pi.invoice_date asc, pi.id asc
    for update;

  select coalesce(sum(due_amount), 0) into v_payable
    from public.purchase_invoices
    where supplier_id = p_supplier_id
      and status = 'RECEIVED'
      and due_amount > 0;

  if v_amount > round(v_payable, 2) and not v_allow_advance then
    raise exception 'PAYMENT_EXCEEDS_DUE: the outstanding payable is only %.', v_payable;
  end if;

  v_payment_no := public.next_doc_number(public.doc_prefix('supplier_payment_prefix', 'SP'));

  insert into public.supplier_payments (
    payment_number, supplier_id, supplier_name, amount, allocated_amount,
    method, reference, notes, recorded_by, recorded_by_name, recorded_at
  ) values (
    v_payment_no, p_supplier_id, v_supplier.name, v_amount, 0,
    v_canon, nullif(trim(coalesce(p_reference, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    v_user, coalesce(nullif(v_name, ''), v_email), coalesce(p_payment_date, now())
  )
  returning id into v_payment_id;

  for v_row in
    select pi.id, pi.invoice_number, pi.due_amount
      from public.purchase_invoices pi
      where pi.supplier_id = p_supplier_id
        and pi.status = 'RECEIVED'
        and pi.due_amount > 0
      order by pi.invoice_date asc, pi.id asc
      for update
  loop
    exit when v_allocated >= v_amount;
    v_apply := least(v_row.due_amount, v_amount - v_allocated);

    insert into public.supplier_payment_allocations (payment_id, invoice_id, invoice_number, amount)
    values (v_payment_id, v_row.id, v_row.invoice_number, round(v_apply, 2));

    update public.purchase_invoices
      set paid_amount = paid_amount + round(v_apply, 2),
          due_amount  = due_amount  - round(v_apply, 2),
          payment_status = case
            when due_amount - round(v_apply, 2) <= 0 then 'PAID'
            when paid_amount + round(v_apply, 2) > 0 then 'PARTIALLY_PAID'
            else 'DUE' end::text
      where id = v_row.id;

    v_allocated := round(v_allocated + v_apply, 2);
  end loop;

  update public.supplier_payments
    set allocated_amount = v_allocated
    where id = v_payment_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'supplier_payment_recorded', 'supplier_payment', v_payment_id::text,
          jsonb_build_object(
            'payment_number', v_payment_no,
            'supplier', v_supplier.name,
            'supplier_id', p_supplier_id,
            'amount', v_amount,
            'allocated', v_allocated,
            'advance', round(v_amount - v_allocated, 2),
            'method', v_canon,
            'payable_before', v_payable,
            'payable_after', round(v_payable - v_allocated, 2)
          ));

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'payment_number', v_payment_no,
    'amount', v_amount,
    'allocated_amount', v_allocated,
    'advance_amount', round(v_amount - v_allocated, 2),
    'method', v_canon,
    'payable_after', round(v_payable - v_allocated, 2)
  );
end $$;

revoke all on function public.record_supplier_payment(uuid, numeric, text, text, text, timestamptz) from public, anon;
grant execute on function public.record_supplier_payment(uuid, numeric, text, text, text, timestamptz) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 22 — purchase order RPCs.
--   create_purchase_order : DRAFT document with server-side math; NO stock.
--   update_purchase_order : item replacement while still DRAFT.
--   set_purchase_order_status : DRAFT ⇄ ORDERED.
--   cancel_purchase_order : DRAFT / ORDERED → CANCELLED (reason required).
-- ---------------------------------------------------------------------------
create or replace function public.create_purchase_order(p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user     uuid := auth.uid();
  v_email    text;
  v_name     text;
  v_supplier public.suppliers%rowtype;
  v_company  public.company_settings%rowtype;
  v_location record;
  v_po_number text;
  v_po_id    uuid;
  v_items    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_seen     uuid[] := array[]::uuid[];
  v_vid      uuid;
  v_sku      text; v_pname text; v_size text; v_color text;
  v_qty      int; v_cost numeric; v_disc numeric;
  v_gst      numeric; v_taxamt numeric; v_gross numeric; v_line numeric;
  v_subtotal numeric := 0; v_disc_total numeric := 0; v_tax_total numeric := 0;
  v_tax_enabled boolean; v_default_rate numeric; v_inter_state boolean := false;
  v_expected date;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchases.');

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_supplier from public.suppliers
    where id = nullif(p_payload ->> 'supplier_id', '')::uuid and is_active;
  if v_supplier.id is null then
    raise exception 'SUPPLIER_NOT_FOUND: supplier not found or inactive.';
  end if;

  select id, name into v_location from public.stock_locations
    where id = nullif(p_payload ->> 'location_id', '')::uuid and is_active;
  if v_location.id is null then
    raise exception 'Stock location not found or inactive.';
  end if;

  select * into v_company from public.company_settings limit 1;
  if v_company.state is not null and v_supplier.state is not null
     and lower(trim(v_supplier.state)) <> lower(trim(v_company.state)) then
    v_inter_state := true;
  end if;

  v_tax_enabled := coalesce((public.setting_of('tax', 'enabled', 'true'::jsonb))::boolean, true);
  v_default_rate := coalesce((public.setting_of('tax', 'default_rate', '5'::jsonb))::numeric, 5);

  if jsonb_typeof(p_payload -> 'items') <> 'array'
     or (select count(*) from jsonb_array_elements(p_payload -> 'items')) = 0 then
    raise exception 'Add at least one item to the purchase order.';
  end if;

  v_expected := nullif(p_payload ->> 'expected_date', '')::date;

  for v_item in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_vid := nullif(v_item ->> 'variant_id', '')::uuid;
    if v_vid is null then
      raise exception 'Invalid item: missing variant.';
    end if;
    if v_vid = any(v_seen) then
      raise exception 'Duplicate item line for one variant — increase the quantity instead.';
    end if;
    v_seen := v_seen || v_vid;

    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid quantity for one of the items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    if coalesce(v_item ->> 'unit_cost', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Invalid cost for one of the items.';
    end if;
    v_cost := (v_item ->> 'unit_cost')::numeric;

    v_disc := coalesce(nullif(v_item ->> 'discount_amount', '')::numeric, 0);
    if v_disc < 0 or v_disc > round(v_cost * v_qty, 2) then
      raise exception 'Invalid discount for one of the items.';
    end if;

    select pv.sku, p.name, s.name, c.name into v_sku, v_pname, v_size, v_color
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
      left join public.sizes s on s.id = pv.size_id
      left join public.colors c on c.id = pv.color_id
      where pv.id = v_vid;
    if v_sku is null then
      raise exception 'VARIANT_NOT_FOUND: one of the items no longer exists.';
    end if;

    v_gst := case when v_tax_enabled then
      coalesce((select p2.gst_rate from public.products p2
                join public.product_variants pv2 on pv2.product_id = p2.id where pv2.id = v_vid), v_default_rate)
      else 0 end;

    v_gross := round(v_cost * v_qty, 2);
    v_taxamt := round((v_gross - v_disc) * v_gst / 100, 2);
    v_line := round(v_gross - v_disc + v_taxamt, 2);

    v_subtotal := round(v_subtotal + v_gross, 2);
    v_disc_total := round(v_disc_total + v_disc, 2);
    v_tax_total := round(v_tax_total + v_taxamt, 2);

    v_items := v_items || jsonb_build_object(
      'line_no', jsonb_array_length(v_items) + 1,
      'variant_id', v_vid, 'product_name', v_pname, 'sku', v_sku,
      'size_name', v_size, 'color_name', v_color,
      'quantity', v_qty, 'unit_cost', v_cost, 'discount_amount', v_disc,
      'gst_rate', v_gst, 'tax_amount', v_taxamt, 'line_total', v_line
    );
  end loop;

  v_po_number := public.next_doc_number(public.doc_prefix('purchase_order_prefix', 'PO'));

  insert into public.purchase_orders (
    po_number, supplier_id, supplier_name, location_id, location_name,
    order_date, expected_date, status,
    subtotal, discount_total, tax_total, grand_total, notes,
    created_by
  ) values (
    v_po_number, v_supplier.id, v_supplier.name, v_location.id, v_location.name,
    coalesce(nullif(p_payload ->> 'order_date', '')::timestamptz, now()), v_expected, 'DRAFT',
    v_subtotal, v_disc_total, v_tax_total, round(v_subtotal - v_disc_total + v_tax_total, 2),
    nullif(trim(coalesce(p_payload ->> 'notes', '')), ''), v_user
  )
  returning id into v_po_id;

  for v_item in select * from jsonb_array_elements(v_items) loop
    insert into public.purchase_order_items (
      po_id, line_no, variant_id, product_name, sku, size_name, color_name,
      quantity, unit_cost, discount_amount, gst_rate, tax_amount, line_total
    ) values (
      v_po_id, coalesce((v_item ->> 'line_no')::int, 0),
      (v_item ->> 'variant_id')::uuid, v_item ->> 'product_name',
      v_item ->> 'sku', v_item ->> 'size_name', v_item ->> 'color_name',
      (v_item ->> 'quantity')::int, (v_item ->> 'unit_cost')::numeric,
      (v_item ->> 'discount_amount')::numeric, (v_item ->> 'gst_rate')::numeric,
      (v_item ->> 'tax_amount')::numeric, (v_item ->> 'line_total')::numeric
    );
  end loop;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'purchase_order_created', 'purchase_order', v_po_id::text,
          jsonb_build_object(
            'po_number', v_po_number, 'supplier', v_supplier.name,
            'location', v_location.name, 'items', jsonb_array_length(v_items),
            'grand_total', round(v_subtotal - v_disc_total + v_tax_total, 2)
          ));

  return jsonb_build_object(
    'po_id', v_po_id, 'po_number', v_po_number, 'status', 'DRAFT',
    'grand_total', round(v_subtotal - v_disc_total + v_tax_total, 2)
  );
end $$;

create or replace function public.update_purchase_order(p_po_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_po    public.purchase_orders%rowtype;
  v_count int := 0;
  v_supplier public.suppliers%rowtype;
  v_location record;
  v_expected date;
  v_new_sup uuid; v_new_loc uuid;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchases.');

  select email into v_email from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if v_po.id is null then
    raise exception 'Purchase order not found.';
  end if;
  if v_po.status <> 'DRAFT' then
    raise exception 'Only DRAFT purchase orders can be edited.';
  end if;

  -- supplier / location / date / notes updates (optional)
  v_new_sup := nullif(p_payload ->> 'supplier_id', '')::uuid;
  v_new_loc := nullif(p_payload ->> 'location_id', '')::uuid;
  v_expected := nullif(p_payload ->> 'expected_date', '')::date;

  if v_new_sup is not null and v_new_sup <> v_po.supplier_id then
    select * into v_supplier from public.suppliers where id = v_new_sup and is_active;
    if v_supplier.id is null then
      raise exception 'SUPPLIER_NOT_FOUND: supplier not found or inactive.';
    end if;
    update public.purchase_orders
      set supplier_id = v_supplier.id, supplier_name = v_supplier.name
      where id = p_po_id;
  end if;

  if v_new_loc is not null and v_new_loc <> v_po.location_id then
    select id, name into v_location from public.stock_locations where id = v_new_loc and is_active;
    if v_location.id is null then
      raise exception 'Stock location not found or inactive.';
    end if;
    update public.purchase_orders
      set location_id = v_location.id, location_name = v_location.name
      where id = p_po_id;
  end if;

  update public.purchase_orders
    set expected_date = coalesce(v_expected, expected_date),
        notes = coalesce(nullif(trim(coalesce(p_payload ->> 'notes', '')), ''), notes)
    where id = p_po_id;

  -- full item replacement: recompute via the same math as create
  if p_payload ? 'items' and jsonb_typeof(p_payload -> 'items') = 'array'
     and (select count(*) from jsonb_array_elements(p_payload -> 'items')) > 0 then

    delete from public.purchase_order_items where po_id = p_po_id;

    -- reuse create_purchase_order's math by delegating the item set through
    -- a fresh document? No — identical math inline (single source below).
    perform public.do_replace_po_items(p_po_id, p_payload -> 'items');
    v_count := (select count(*) from public.purchase_order_items where po_id = p_po_id);
  end if;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'purchase_order_updated', 'purchase_order', p_po_id::text,
          jsonb_build_object('po_number', v_po.po_number, 'items_after', v_count));

  return jsonb_build_object('po_id', p_po_id, 'po_number', v_po.po_number, 'updated', true);
end $$;

-- internal: (re)build PO items with server-side math; also refreshes the
-- document totals. Not granted to API roles.
create or replace function public.do_replace_po_items(p_po_id uuid, p_items jsonb)
returns void
language plpgsql
security definer set search_path = public as $$
declare
  v_item jsonb;
  v_seen uuid[] := array[]::uuid[];
  v_vid uuid; v_sku text; v_pname text; v_size text; v_color text;
  v_qty int; v_cost numeric; v_disc numeric; v_gst numeric;
  v_taxamt numeric; v_gross numeric; v_line numeric;
  v_subtotal numeric := 0; v_disc_total numeric := 0; v_tax_total numeric := 0;
  v_tax_enabled boolean; v_default_rate numeric;
begin
  v_tax_enabled := coalesce((public.setting_of('tax', 'enabled', 'true'::jsonb))::boolean, true);
  v_default_rate := coalesce((public.setting_of('tax', 'default_rate', '5'::jsonb))::numeric, 5);

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_vid := nullif(v_item ->> 'variant_id', '')::uuid;
    if v_vid is null or v_vid = any(v_seen) then
      raise exception 'Invalid or duplicate item line.';
    end if;
    v_seen := v_seen || v_vid;

    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid quantity for one of the items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    if coalesce(v_item ->> 'unit_cost', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Invalid cost for one of the items.';
    end if;
    v_cost := (v_item ->> 'unit_cost')::numeric;

    v_disc := coalesce(nullif(v_item ->> 'discount_amount', '')::numeric, 0);
    if v_disc < 0 or v_disc > round(v_cost * v_qty, 2) then
      raise exception 'Invalid discount for one of the items.';
    end if;

    select pv.sku, p.name, s.name, c.name into v_sku, v_pname, v_size, v_color
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
      left join public.sizes s on s.id = pv.size_id
      left join public.colors c on c.id = pv.color_id
      where pv.id = v_vid;
    if v_sku is null then
      raise exception 'VARIANT_NOT_FOUND: one of the items no longer exists.';
    end if;

    v_gst := case when v_tax_enabled then
      coalesce((select p2.gst_rate from public.products p2
                join public.product_variants pv2 on pv2.product_id = p2.id where pv2.id = v_vid), v_default_rate)
      else 0 end;

    v_gross := round(v_cost * v_qty, 2);
    v_taxamt := round((v_gross - v_disc) * v_gst / 100, 2);
    v_line := round(v_gross - v_disc + v_taxamt, 2);

    v_subtotal := round(v_subtotal + v_gross, 2);
    v_disc_total := round(v_disc_total + v_disc, 2);
    v_tax_total := round(v_tax_total + v_taxamt, 2);

    insert into public.purchase_order_items (
      po_id, variant_id, product_name, sku, size_name, color_name,
      quantity, unit_cost, discount_amount, gst_rate, tax_amount, line_total
    ) values (
      p_po_id, v_vid, v_pname, v_sku, v_size, v_color,
      v_qty, v_cost, v_disc, v_gst, v_taxamt, v_line
    );
  end loop;

  update public.purchase_orders
    set subtotal = v_subtotal,
        discount_total = v_disc_total,
        tax_total = v_tax_total,
        grand_total = round(v_subtotal - v_disc_total + v_tax_total, 2)
    where id = p_po_id;
end $$;

revoke all on function public.do_replace_po_items(uuid, jsonb) from public, anon, authenticated;

create or replace function public.set_purchase_order_status(p_po_id uuid, p_status text)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_po    public.purchase_orders%rowtype;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchases.');

  select email into v_email from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if v_po.id is null then
    raise exception 'Purchase order not found.';
  end if;

  if p_status not in ('DRAFT','ORDERED') then
    raise exception 'Status can only be set to DRAFT or ORDERED here — receiving updates it automatically.';
  end if;
  if v_po.status in ('CANCELLED') then
    raise exception 'This purchase order is cancelled.';
  end if;
  if v_po.status in ('PARTIALLY_RECEIVED','RECEIVED') then
    raise exception 'Goods were already received against this purchase order.';
  end if;
  if v_po.status = p_status then
    raise exception 'The purchase order is already %.', lower(p_status);
  end if;

  update public.purchase_orders set status = p_status where id = p_po_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'purchase_order_updated', 'purchase_order', p_po_id::text,
          jsonb_build_object('po_number', v_po.po_number,
                             'status_from', v_po.status, 'status_to', p_status));

  return jsonb_build_object('po_id', p_po_id, 'status', p_status);
end $$;

create or replace function public.cancel_purchase_order(p_po_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_po    public.purchase_orders%rowtype;
  v_received int;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchases.');

  select email into v_email from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to cancel a purchase order.';
  end if;

  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if v_po.id is null then
    raise exception 'Purchase order not found.';
  end if;
  if v_po.status in ('PARTIALLY_RECEIVED','RECEIVED') then
    raise exception 'Goods were already received — cancel the related purchase invoices instead.';
  end if;
  if v_po.status = 'CANCELLED' then
    raise exception 'This purchase order is already cancelled.';
  end if;

  select coalesce(sum(received_quantity), 0) into v_received
    from public.purchase_order_items where po_id = p_po_id;
  if v_received > 0 then
    raise exception 'Received quantities exist against this purchase order.';
  end if;

  update public.purchase_orders
    set status = 'CANCELLED', cancelled_at = now(), cancelled_by = v_user,
        cancel_reason = trim(p_reason)
    where id = p_po_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'purchase_order_cancelled', 'purchase_order', p_po_id::text,
          jsonb_build_object('po_number', v_po.po_number, 'reason', trim(p_reason)));

  return jsonb_build_object('po_id', p_po_id, 'status', 'CANCELLED');
end $$;

revoke all on function public.create_purchase_order(jsonb) from public, anon;
revoke all on function public.update_purchase_order(uuid, jsonb) from public, anon;
revoke all on function public.set_purchase_order_status(uuid, text) from public, anon;
revoke all on function public.cancel_purchase_order(uuid, text) from public, anon;
grant execute on function public.create_purchase_order(jsonb) to authenticated, service_role;
grant execute on function public.update_purchase_order(uuid, jsonb) to authenticated, service_role;
grant execute on function public.set_purchase_order_status(uuid, text) to authenticated, service_role;
grant execute on function public.cancel_purchase_order(uuid, text) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 23 — purchase invoice / goods receiving engine.
--
-- create_purchase_invoice(p_payload):
--   p_status 'DRAFT'  → document only, nothing else happens;
--   p_status 'RECEIVED' → one atomic transaction: items → stock increase
--   (row-locked upserts + PURCHASE movements) → PO progress update →
--   supplier payable → audit. Any failure rolls back EVERYTHING.
--
-- confirm_purchase_invoice(id): DRAFT → RECEIVED through the same engine.
-- cancel_purchase_invoice(id, reason): DRAFT freely; RECEIVED only when no
--   payments and no returns exist (stock is reversed back out).
-- ---------------------------------------------------------------------------
create or replace function public.create_purchase_invoice(p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user     uuid := auth.uid();
  v_email    text;
  v_name     text;
  v_supplier public.suppliers%rowtype;
  v_company  public.company_settings%rowtype;
  v_location record;
  v_po       public.purchase_orders%rowtype;
  v_status   text := upper(coalesce(nullif(p_payload ->> 'status', ''), 'DRAFT'));
  v_invoice_number text;
  v_invoice_id uuid;
  v_items    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_seen     uuid[] := array[]::uuid[];
  v_vid      uuid;
  v_sku      text; v_pname text; v_size text; v_color text;
  v_qty      int; v_cost numeric; v_disc numeric;
  v_gst      numeric; v_taxamt numeric; v_gross numeric; v_line numeric;
  v_subtotal numeric := 0; v_disc_total numeric := 0; v_tax_total numeric := 0;
  v_tax_enabled boolean; v_default_rate numeric;
  v_tax_mode text; v_inter_state boolean := false;
  v_po_item_id uuid;
  v_po_remaining int;
  v_result    jsonb;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchases.');

  if v_status not in ('DRAFT','RECEIVED') then
    raise exception 'Status must be DRAFT or RECEIVED.';
  end if;

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_supplier from public.suppliers
    where id = nullif(p_payload ->> 'supplier_id', '')::uuid and is_active;
  if v_supplier.id is null then
    raise exception 'SUPPLIER_NOT_FOUND: supplier not found or inactive.';
  end if;

  select id, name into v_location from public.stock_locations
    where id = nullif(p_payload ->> 'location_id', '')::uuid and is_active;
  if v_location.id is null then
    raise exception 'Stock location not found or inactive.';
  end if;

  -- optional linked PO (must be ORDERED-ish; DRAFT POs must be ordered first)
  if nullif(p_payload ->> 'po_id', '') is not null then
    select * into v_po from public.purchase_orders
      where id = (p_payload ->> 'po_id')::uuid for update;
    if v_po.id is null then
      raise exception 'Purchase order not found.';
    end if;
    if v_po.status not in ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') then
      raise exception 'PO_NOT_ORDERED: the purchase order must be in ORDERED state before goods can be received.';
    end if;
    if v_po.supplier_id <> v_supplier.id then
      raise exception 'The purchase order belongs to a different supplier.';
    end if;
  end if;

  select * into v_company from public.company_settings limit 1;
  if v_company.state is not null and v_supplier.state is not null
     and lower(trim(v_supplier.state)) <> lower(trim(v_company.state)) then
    v_inter_state := true;
  end if;

  v_tax_enabled := coalesce((public.setting_of('tax', 'enabled', 'true'::jsonb))::boolean, true);
  v_default_rate := coalesce((public.setting_of('tax', 'default_rate', '5'::jsonb))::numeric, 5);
  v_tax_mode := coalesce(nullif(p_payload ->> 'tax_mode', ''),
                         nullif((select value ->> 'default_tax_mode'
                                 from public.app_settings where key = 'pos'), ''),
                         'inclusive');

  if jsonb_typeof(p_payload -> 'items') <> 'array'
     or (select count(*) from jsonb_array_elements(p_payload -> 'items')) = 0 then
    raise exception 'Add at least one item to the purchase invoice.';
  end if;

  -- duplicate supplier invoice number (friendly pre-check; the partial
  -- unique index is the hard guarantee under concurrency)
  if nullif(trim(coalesce(p_payload ->> 'supplier_invoice_no', '')), '') is not null then
    if exists (
      select 1 from public.purchase_invoices
      where supplier_id = v_supplier.id
        and supplier_invoice_no = trim(p_payload ->> 'supplier_invoice_no')
        and status <> 'CANCELLED'
    ) then
      raise exception 'DUPLICATE_SUPPLIER_INVOICE: invoice number "%" already exists for this supplier.', trim(p_payload ->> 'supplier_invoice_no');
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_payload -> 'items') loop
    v_vid := nullif(v_item ->> 'variant_id', '')::uuid;
    if v_vid is null then
      raise exception 'Invalid item: missing variant.';
    end if;
    if v_vid = any(v_seen) then
      raise exception 'Duplicate item line for one variant — increase the quantity instead.';
    end if;
    v_seen := v_seen || v_vid;

    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid quantity for one of the items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    if coalesce(v_item ->> 'unit_cost', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Invalid cost for one of the items.';
    end if;
    v_cost := (v_item ->> 'unit_cost')::numeric;

    v_disc := coalesce(nullif(v_item ->> 'discount_amount', '')::numeric, 0);
    if v_disc < 0 or v_disc > round(v_cost * v_qty, 2) then
      raise exception 'Invalid discount for one of the items.';
    end if;

    select pv.sku, p.name, s.name, c.name into v_sku, v_pname, v_size, v_color
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
      left join public.sizes s on s.id = pv.size_id
      left join public.colors c on c.id = pv.color_id
      where pv.id = v_vid;
    if v_sku is null then
      raise exception 'VARIANT_NOT_FOUND: one of the items no longer exists.';
    end if;

    -- PO link: never receive more than the remaining ordered quantity
    v_po_item_id := nullif(v_item ->> 'po_item_id', '')::uuid;
    if v_po_item_id is not null then
      if v_po.id is null or v_po_item_id is null then
        raise exception 'Item references a PO line but no purchase order is linked.';
      end if;
      select (poi.quantity - poi.received_quantity) into v_po_remaining
        from public.purchase_order_items poi
        where poi.id = v_po_item_id and poi.po_id = v_po.id
        for update;
      if v_po_remaining is null then
        raise exception 'The referenced purchase order line does not belong to this PO.';
      end if;
      if v_qty > v_po_remaining then
        raise exception 'RECEIVE_EXCEEDS_ORDERED: only % left to receive for % (%).', v_po_remaining, v_pname, v_sku;
      end if;
    end if;

    v_gst := case when v_tax_enabled then
      coalesce((select p2.gst_rate from public.products p2
                join public.product_variants pv2 on pv2.product_id = p2.id where pv2.id = v_vid), v_default_rate)
      else 0 end;

    v_gross := round(v_cost * v_qty, 2);
    if v_tax_mode = 'inclusive' then
      v_taxamt := round((v_gross - v_disc) * v_gst / (100 + v_gst), 2);
      v_line := round(v_gross - v_disc, 2);
    else
      v_taxamt := round((v_gross - v_disc) * v_gst / 100, 2);
      v_line := round(v_gross - v_disc + v_taxamt, 2);
    end if;

    v_subtotal := round(v_subtotal + v_line, 2);
    v_disc_total := round(v_disc_total + v_disc, 2);
    v_tax_total := round(v_tax_total + v_taxamt, 2);

    v_items := v_items || jsonb_build_object(
      'line_no', jsonb_array_length(v_items) + 1,
      'po_item_id', v_po_item_id, 'variant_id', v_vid,
      'product_name', v_pname, 'sku', v_sku, 'size_name', v_size, 'color_name', v_color,
      'quantity', v_qty, 'unit_cost', v_cost, 'discount_amount', v_disc,
      'gst_rate', v_gst, 'tax_amount', v_taxamt, 'line_total', v_line
    );
  end loop;

  v_invoice_number := public.next_doc_number(public.doc_prefix('purchase_invoice_prefix', 'PI'));

  insert into public.purchase_invoices (
    invoice_number, supplier_id, supplier_name, po_id, po_number,
    supplier_invoice_no, supplier_invoice_date, location_id, location_name,
    invoice_date, status, subtotal, discount_total, tax_total, grand_total,
    paid_amount, due_amount, payment_status, tax_mode, inter_state, notes,
    created_by
  ) values (
    v_invoice_number, v_supplier.id, v_supplier.name, v_po.id, v_po.po_number,
    nullif(trim(coalesce(p_payload ->> 'supplier_invoice_no', '')), ''),
    nullif(p_payload ->> 'supplier_invoice_date', '')::date,
    v_location.id, v_location.name,
    coalesce(nullif(p_payload ->> 'invoice_date', '')::timestamptz, now()),
    -- always created DRAFT: receiving (stock + payable side effects) is the
    -- only path to RECEIVED, whether inline (status=RECEIVED) or via confirm.
    'DRAFT', v_subtotal, v_disc_total, v_tax_total,
    round(v_subtotal - v_disc_total + v_tax_total, 2),
    0, 0, 'DUE',
    v_tax_mode, v_inter_state, nullif(trim(coalesce(p_payload ->> 'notes', '')), ''),
    v_user
  )
  returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(v_items) loop
    insert into public.purchase_invoice_items (
      invoice_id, line_no, po_item_id, variant_id, product_name, sku, size_name, color_name,
      quantity, unit_cost, discount_amount, gst_rate, tax_amount, line_total
    ) values (
      v_invoice_id, coalesce((v_item ->> 'line_no')::int, 0),
      nullif(v_item ->> 'po_item_id', '')::uuid,
      (v_item ->> 'variant_id')::uuid, v_item ->> 'product_name',
      v_item ->> 'sku', v_item ->> 'size_name', v_item ->> 'color_name',
      (v_item ->> 'quantity')::int, (v_item ->> 'unit_cost')::numeric,
      (v_item ->> 'discount_amount')::numeric, (v_item ->> 'gst_rate')::numeric,
      (v_item ->> 'tax_amount')::numeric, (v_item ->> 'line_total')::numeric
    );
  end loop;

  if v_status = 'RECEIVED' then
    v_result := public.do_receive_purchase_invoice(v_invoice_id, v_user, v_email);
  else
    v_result := jsonb_build_object('received', false);
  end if;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email,
          case when v_status = 'RECEIVED' then 'purchase_received' else 'purchase_created' end::public.audit_action,
          'purchase_invoice', v_invoice_id::text,
          jsonb_build_object(
            'invoice_number', v_invoice_number,
            'supplier', v_supplier.name,
            'po_number', v_po.po_number,
            'supplier_invoice_no', p_payload ->> 'supplier_invoice_no',
            'location', v_location.name,
            'items', jsonb_array_length(v_items),
            'grand_total', round(v_subtotal - v_disc_total + v_tax_total, 2),
            'status', v_status
          ));

  return jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'status', v_status,
    'grand_total', round(v_subtotal - v_disc_total + v_tax_total, 2),
    'due_amount', round(v_subtotal - v_disc_total + v_tax_total, 2),
    'result', v_result
  );
end $$;

-- internal receiver (never granted to API roles). Assumes the invoice + its
-- item rows already exist and performs the stock/payable/PO side effects.
create or replace function public.do_receive_purchase_invoice(
  p_invoice_id uuid, p_user uuid, p_email text
)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_inv   public.purchase_invoices%rowtype;
  v_item  public.purchase_invoice_items%rowtype;
  v_po    public.purchase_orders%rowtype;
  v_new_qty int;
  v_movement_id bigint;
  v_all_received boolean;
  v_any_received boolean;
begin
  select * into v_inv from public.purchase_invoices where id = p_invoice_id for update;
  if v_inv.id is null then
    raise exception 'Purchase invoice not found.';
  end if;
  if v_inv.status <> 'DRAFT' then
    raise exception 'Only DRAFT purchase invoices can be received.';
  end if;

  perform set_config('app.stock_engine', 'on', true);

  for v_item in select * from public.purchase_invoice_items where invoice_id = p_invoice_id order by id for update loop
    if v_item.variant_id is null then
      raise exception 'Cannot receive an item whose variant was removed.';
    end if;

    insert into public.stock_balances (variant_id, location_id, quantity)
    values (v_item.variant_id, v_inv.location_id, v_item.quantity)
    on conflict (variant_id, location_id)
    do update set quantity = public.stock_balances.quantity + v_item.quantity
    returning quantity into v_new_qty;

    insert into public.stock_movements (
      variant_id, location_id, movement_type, quantity, balance_after,
      reference_type, reference_id, reason, user_id, user_email
    ) values (
      v_item.variant_id, v_inv.location_id, 'PURCHASE', v_item.quantity, v_new_qty,
      'purchase_invoice', v_inv.id::text, 'Purchase ' || v_inv.invoice_number,
      p_user, p_email
    )
    returning id into v_movement_id;

    if v_item.po_item_id is not null then
      update public.purchase_order_items
        set received_quantity = received_quantity + v_item.quantity
        where id = v_item.po_item_id;
    end if;
  end loop;

  -- PO progress: fully received → RECEIVED, partially → PARTIALLY_RECEIVED
  if v_inv.po_id is not null then
    select * into v_po from public.purchase_orders where id = v_inv.po_id for update;
    select bool_and(poi.quantity <= poi.received_quantity),
           bool_or(poi.received_quantity > 0)
      into v_all_received, v_any_received
      from public.purchase_order_items poi where poi.po_id = v_inv.po_id;
    if coalesce(v_all_received, false) then
      update public.purchase_orders set status = 'RECEIVED' where id = v_inv.po_id;
    elsif coalesce(v_any_received, false) then
      update public.purchase_orders set status = 'PARTIALLY_RECEIVED' where id = v_inv.po_id;
    end if;
  end if;

  update public.purchase_invoices
    set status = 'RECEIVED', received_at = now(), received_by = p_user,
        due_amount = grand_total, payment_status = 'DUE'
    where id = p_invoice_id;

  return jsonb_build_object('received', true, 'movements', 1);
end $$;

revoke all on function public.do_receive_purchase_invoice(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.confirm_purchase_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_inv   public.purchase_invoices%rowtype;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchases.');

  select email into v_email from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_inv from public.purchase_invoices where id = p_invoice_id;
  if v_inv.id is null then
    raise exception 'Purchase invoice not found.';
  end if;

  perform public.do_receive_purchase_invoice(p_invoice_id, v_user, v_email);

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'purchase_received', 'purchase_invoice', p_invoice_id::text,
          jsonb_build_object('invoice_number', v_inv.invoice_number,
                             'supplier', v_inv.supplier_name,
                             'grand_total', v_inv.grand_total));

  return jsonb_build_object('invoice_id', p_invoice_id, 'status', 'RECEIVED');
end $$;

create or replace function public.cancel_purchase_invoice(p_invoice_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_inv   public.purchase_invoices%rowtype;
  v_item  public.purchase_invoice_items%rowtype;
  v_new_qty int;
  v_has_payments boolean;
  v_has_returns boolean;
  v_po_id uuid;
  v_all_received boolean;
  v_any_received boolean;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchases.');

  select email into v_email from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to cancel a purchase invoice.';
  end if;

  select * into v_inv from public.purchase_invoices where id = p_invoice_id for update;
  if v_inv.id is null then
    raise exception 'Purchase invoice not found.';
  end if;
  if v_inv.status = 'CANCELLED' then
    raise exception 'This purchase invoice is already cancelled.';
  end if;

  if v_inv.status = 'RECEIVED' then
    select exists(select 1 from public.supplier_payment_allocations a
                  join public.supplier_payments sp on sp.id = a.payment_id
                  where a.invoice_id = p_invoice_id)
      into v_has_payments;
    if v_has_payments then
      raise exception 'Payments were recorded against this invoice — it cannot be cancelled.';
    end if;
    select exists(select 1 from public.purchase_return_items pri
                  join public.purchase_returns pr on pr.id = pri.return_id
                  where pri.invoice_item_id in
                    (select id from public.purchase_invoice_items where invoice_id = p_invoice_id))
      into v_has_returns;
    if v_has_returns then
      raise exception 'Returns were recorded against this invoice — it cannot be cancelled.';
    end if;

    -- reverse the stock (row-locked; refuses if the goods were already sold)
    perform set_config('app.stock_engine', 'on', true);
    for v_item in select * from public.purchase_invoice_items
                   where invoice_id = p_invoice_id order by id for update loop
      if v_item.variant_id is null then
        raise exception 'Cannot reverse an item whose variant was removed.';
      end if;
      insert into public.stock_balances (variant_id, location_id, quantity)
      values (v_item.variant_id, v_inv.location_id, -v_item.quantity)
      on conflict (variant_id, location_id)
      do update set quantity = public.stock_balances.quantity - v_item.quantity
      returning quantity into v_new_qty;
      if v_new_qty < 0 then
        raise exception 'CANNOT_REVERSE_STOCK: % (%) was already sold or moved — record a purchase return instead.', v_item.product_name, v_item.sku;
      end if;
      insert into public.stock_movements (
        variant_id, location_id, movement_type, quantity, balance_after,
        reference_type, reference_id, reason, user_id, user_email
      ) values (
        v_item.variant_id, v_inv.location_id, 'PURCHASE_RETURN', -v_item.quantity, v_new_qty,
        'purchase_cancel', v_inv.id::text, 'Cancel ' || v_inv.invoice_number,
        v_user, v_email
      );
      if v_item.po_item_id is not null then
        update public.purchase_order_items
          set received_quantity = greatest(received_quantity - v_item.quantity, 0)
          where id = v_item.po_item_id;
      end if;
    end loop;

    -- PO status rolls back to what it was before this receipt
    if v_inv.po_id is not null then
      v_po_id := v_inv.po_id;
      select bool_and(poi.quantity <= poi.received_quantity),
             bool_or(poi.received_quantity > 0)
        into v_all_received, v_any_received
        from public.purchase_order_items poi where poi.po_id = v_po_id;
      update public.purchase_orders
        set status = case
              when coalesce(v_any_received, false) then 'PARTIALLY_RECEIVED'
              else 'ORDERED' end::text
        where id = v_po_id and status in ('PARTIALLY_RECEIVED','RECEIVED');
    end if;
  end if;

  update public.purchase_invoices
    set status = 'CANCELLED', cancelled_at = now(), cancelled_by = v_user,
        cancel_reason = trim(p_reason), due_amount = 0, payment_status = 'DUE'
    where id = p_invoice_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'purchase_cancelled', 'purchase_invoice', p_invoice_id::text,
          jsonb_build_object('invoice_number', v_inv.invoice_number,
                             'reason', trim(p_reason),
                             'was_received', v_inv.status = 'RECEIVED'));

  return jsonb_build_object('invoice_id', p_invoice_id, 'status', 'CANCELLED');
end $$;

revoke all on function public.create_purchase_invoice(jsonb) from public, anon;
revoke all on function public.confirm_purchase_invoice(uuid) from public, anon;
revoke all on function public.cancel_purchase_invoice(uuid, text) from public, anon;
grant execute on function public.create_purchase_invoice(jsonb) to authenticated, service_role;
grant execute on function public.confirm_purchase_invoice(uuid) to authenticated, service_role;
grant execute on function public.cancel_purchase_invoice(uuid, text) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 24 — shared helper: how many units of a sold line are still
-- returnable (sold − previously returned − previously exchanged in).
-- ---------------------------------------------------------------------------
create or replace function public.sale_item_remaining_returnable(p_sale_item_id uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select si.quantity
    - coalesce((select sum(r.quantity) from public.sales_return_items r
                where r.sale_item_id = si.id), 0)
    - coalesce((select sum(e.quantity) from public.exchange_items_in e
                where e.sale_item_id = si.id), 0)
  from public.sale_items si
  where si.id = p_sale_item_id;
$$;

revoke all on function public.sale_item_remaining_returnable(uuid) from public, anon;
grant execute on function public.sale_item_remaining_returnable(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 25 — create_purchase_return(): goods back to the supplier.
-- Atomic: eligibility → row-locked stock deduction (PURCHASE_RETURN
-- movements) → invoice return counters → supplier payable credit note →
-- audit. Duplicate protection: the counter update makes double-submits
-- fail on the second pass (eligible quantity shrinks to zero).
-- ---------------------------------------------------------------------------
create or replace function public.create_purchase_return(p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_name  text;
  v_inv   public.purchase_invoices%rowtype;
  v_item  jsonb;
  v_items jsonb := '[]'::jsonb;
  v_ii    public.purchase_invoice_items%rowtype;
  v_return_number text;
  v_return_id uuid;
  v_qty   int;
  v_eligible int;
  v_line_total numeric; v_line_tax numeric;
  v_subtotal numeric := 0; v_tax_total numeric := 0;
  v_apply_to_due numeric;
  v_new_qty int;
  v_movement_id bigint;
  v_allow_negative boolean;
begin
  perform public.require_permission('manage_purchases', 'You do not have permission to manage purchase returns.');

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  if nullif(trim(coalesce(p_payload ->> 'reason', '')), '') is null then
    raise exception 'A reason is required for a purchase return.';
  end if;

  select * into v_inv from public.purchase_invoices
    where id = nullif(p_payload ->> 'purchase_invoice_id', '')::uuid for update;
  if v_inv.id is null then
    raise exception 'Purchase invoice not found.';
  end if;
  if v_inv.status <> 'RECEIVED' then
    raise exception 'Only RECEIVED purchase invoices can be returned.';
  end if;

  if jsonb_typeof(p_payload -> 'items') <> 'array'
     or (select count(*) from jsonb_array_elements(p_payload -> 'items')) = 0 then
    raise exception 'Select at least one item to return.';
  end if;

  v_allow_negative := coalesce((public.inv_setting('allow_negative_stock'))::boolean, false);

  for v_item in select * from jsonb_array_elements(p_payload -> 'items') loop
    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid return quantity for one of the items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    select * into v_ii from public.purchase_invoice_items
      where id = nullif(v_item ->> 'invoice_item_id', '')::uuid
        and invoice_id = v_inv.id
      for update;
    if v_ii.id is null then
      raise exception 'One of the items does not belong to this purchase invoice.';
    end if;

    v_eligible := v_ii.quantity - v_ii.returned_quantity;
    if v_qty > v_eligible then
      raise exception 'RETURN_EXCEEDS_RECEIVED: only % left to return for % (%).', v_eligible, v_ii.product_name, v_ii.sku;
    end if;

    v_line_total := round(v_ii.line_total * v_qty / v_ii.quantity, 2);
    v_line_tax := round(v_ii.tax_amount * v_qty / v_ii.quantity, 2);

    v_subtotal := round(v_subtotal + (v_line_total - v_line_tax), 2);
    v_tax_total := round(v_tax_total + v_line_tax, 2);

    v_items := v_items || jsonb_build_object(
      'line_no', jsonb_array_length(v_items) + 1,
      'invoice_item_id', v_ii.id, 'variant_id', v_ii.variant_id,
      'product_name', v_ii.product_name, 'sku', v_ii.sku,
      'quantity', v_qty, 'unit_cost', v_ii.unit_cost,
      'tax_rate', v_ii.gst_rate, 'tax_amount', v_line_tax, 'line_total', v_line_total
    );
  end loop;

  v_return_number := public.next_doc_number(public.doc_prefix('purchase_return_prefix', 'PR'));

  insert into public.purchase_returns (
    return_number, purchase_invoice_id, invoice_number, supplier_id, supplier_name,
    return_date, reason, subtotal, tax_total, grand_total, notes, created_by, created_by_name
  ) values (
    v_return_number, v_inv.id, v_inv.invoice_number, v_inv.supplier_id, v_inv.supplier_name,
    now(), trim(p_payload ->> 'reason'),
    v_subtotal, v_tax_total, round(v_subtotal + v_tax_total, 2),
    nullif(trim(coalesce(p_payload ->> 'notes', '')), ''),
    v_user, coalesce(nullif(v_name, ''), v_email)
  )
  returning id into v_return_id;

  -- line snapshots (was missing: every return keeps its own item rows)
  for v_item in select * from jsonb_array_elements(v_items) loop
    insert into public.purchase_return_items (
      return_id, line_no, invoice_item_id, variant_id, product_name, sku,
      quantity, unit_cost, tax_rate, tax_amount, line_total
    ) values (
      v_return_id, coalesce((v_item ->> 'line_no')::int, 0),
      (v_item ->> 'invoice_item_id')::uuid, nullif(v_item ->> 'variant_id', '')::uuid,
      v_item ->> 'product_name', v_item ->> 'sku',
      (v_item ->> 'quantity')::int, (v_item ->> 'unit_cost')::numeric,
      (v_item ->> 'tax_rate')::numeric, (v_item ->> 'tax_amount')::numeric,
      (v_item ->> 'line_total')::numeric
    );
  end loop;

  perform set_config('app.stock_engine', 'on', true);

  for v_item in select * from jsonb_array_elements(v_items) loop
    if (v_item ->> 'variant_id')::uuid is not null then
      insert into public.stock_balances (variant_id, location_id, quantity)
      values ((v_item ->> 'variant_id')::uuid, v_inv.location_id, -(v_item ->> 'quantity')::int)
      on conflict (variant_id, location_id)
      do update set quantity = public.stock_balances.quantity - (v_item ->> 'quantity')::int
      returning quantity into v_new_qty;

      if v_new_qty < 0 and not v_allow_negative then
        raise exception 'INSUFFICIENT_STOCK: % (%) has already been sold or moved — cannot return it to the supplier.', v_item ->> 'product_name', v_item ->> 'sku';
      end if;

      insert into public.stock_movements (
        variant_id, location_id, movement_type, quantity, balance_after,
        reference_type, reference_id, reason, user_id, user_email
      ) values (
        (v_item ->> 'variant_id')::uuid, v_inv.location_id, 'PURCHASE_RETURN', -(v_item ->> 'quantity')::int, v_new_qty,
        'purchase_return', v_return_id::text, 'Purchase return ' || v_return_number,
        v_user, v_email
      )
      returning id into v_movement_id;
    end if;

    update public.purchase_invoice_items
      set returned_quantity = returned_quantity + (v_item ->> 'quantity')::int
      where id = (v_item ->> 'invoice_item_id')::uuid;
  end loop;

  -- supplier payable credit note: due reduces first
  v_apply_to_due := least(v_inv.due_amount, round(v_subtotal + v_tax_total, 2));
  update public.purchase_invoices
    set due_amount = due_amount - v_apply_to_due,
        payment_status = case
          when due_amount - v_apply_to_due <= 0 then 'PAID'
          when paid_amount > 0 then 'PARTIALLY_PAID'
          else 'DUE' end::text
    where id = v_inv.id;

  update public.purchase_returns
    set applied_to_due = v_apply_to_due
    where id = v_return_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'purchase_return_processed', 'purchase_return', v_return_id::text,
          jsonb_build_object(
            'return_number', v_return_number,
            'invoice_number', v_inv.invoice_number,
            'supplier', v_inv.supplier_name,
            'grand_total', round(v_subtotal + v_tax_total, 2),
            'payable_adjusted', v_apply_to_due,
            'reason', trim(p_payload ->> 'reason')
          ));

  return jsonb_build_object(
    'return_id', v_return_id,
    'return_number', v_return_number,
    'grand_total', round(v_subtotal + v_tax_total, 2),
    'payable_adjusted', v_apply_to_due
  );
end $$;

revoke all on function public.create_purchase_return(jsonb) from public, anon;
grant execute on function public.create_purchase_return(jsonb) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 26 — create_sales_return(): customer returns with condition,
-- refund logic and stock restoration. All in one transaction.
--
-- Refund order: any outstanding due on the bill is offset FIRST, the
-- remainder is refunded via the chosen method ("Store Credit" stores the
-- amount as customer advance). Stock: GOOD → sellable location of the
-- original sale; DAMAGED → the Damaged Goods location (or no restock when
-- returns.damaged_to_location = false).
-- ---------------------------------------------------------------------------
create or replace function public.create_sales_return(p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_name  text;
  v_sale  public.sales%rowtype;
  v_item  jsonb;
  v_items jsonb := '[]'::jsonb;
  v_si    public.sale_items%rowtype;
  v_return_number text;
  v_return_id uuid;
  v_qty   int;
  v_eligible int;
  v_condition text;
  v_line_refund numeric; v_line_tax numeric;
  v_refund_total numeric := 0;
  v_refund_method text;
  v_store_credit boolean;
  v_applied_to_due numeric := 0;
  v_refunded numeric := 0;
  v_new_qty int;
  v_movement_id bigint;
  v_movement_count int := 0;
  v_dmg_location uuid;
  v_dmg_to_location boolean;
  v_enabled boolean;
  v_refund_enabled boolean;
  v_window_days int;
  v_max_pct numeric;
  v_manager_approval boolean;
  v_tz text;
  v_sale_local date;
  v_customer_id uuid;
  v_advance_payment_id uuid;
begin
  -- policy gates (settings, never hardcoded in components)
  v_enabled := coalesce((public.setting_of('returns', 'enabled', 'true'::jsonb))::boolean, true);
  if not v_enabled then
    raise exception 'RETURNS_DISABLED: returns are currently disabled in Settings.';
  end if;

  perform public.require_permission('process_return', 'You do not have permission to process returns.');

  v_manager_approval := coalesce((public.setting_of('returns', 'manager_approval', 'false'::jsonb))::boolean, false);
  if v_manager_approval and not public.has_app_permission('approve_return') then
    raise exception 'RETURN_NEEDS_APPROVAL: this store requires a manager or admin to approve returns.';
  end if;

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  if nullif(trim(coalesce(p_payload ->> 'reason', '')), '') is null then
    raise exception 'A reason is required for a return.';
  end if;

  select * into v_sale from public.sales
    where id = nullif(p_payload ->> 'sale_id', '')::uuid for update;
  if v_sale.id is null then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status <> 'COMPLETED' then
    raise exception 'Only completed sales can be returned.';
  end if;

  -- return window (store timezone; 0 = no limit)
  v_window_days := coalesce((public.setting_of('returns', 'window_days', '7'::jsonb))::int, 7);
  if v_window_days > 0 then
    v_tz := coalesce(nullif(trim((select cs.timezone from public.company_settings cs limit 1)), ''), 'Asia/Kolkata');
    v_sale_local := (v_sale.sale_date at time zone v_tz)::date;
    if v_sale_local < ((now() at time zone v_tz)::date - v_window_days) then
      raise exception 'RETURN_WINDOW_EXPIRED: this bill is older than the %-day return window.', v_window_days;
    end if;
  end if;

  v_max_pct := coalesce((public.setting_of('returns', 'max_return_qty_pct', '100'::jsonb))::numeric, 100);

  if jsonb_typeof(p_payload -> 'items') <> 'array'
     or (select count(*) from jsonb_array_elements(p_payload -> 'items')) = 0 then
    raise exception 'Select at least one item to return.';
  end if;

  v_dmg_to_location := coalesce((public.setting_of('returns', 'damaged_to_location', 'true'::jsonb))::boolean, true);
  if v_dmg_to_location then
    select id into v_dmg_location from public.stock_locations
      where location_type = 'damaged' and is_active limit 1;
    if v_dmg_location is null then
      raise exception 'No damaged-goods location exists. Create one in Inventory → Locations.';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_payload -> 'items') loop
    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid return quantity for one of the items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    v_condition := upper(coalesce(nullif(v_item ->> 'condition', ''), 'GOOD'));
    if v_condition not in ('GOOD','DAMAGED') then
      raise exception 'Return condition must be GOOD or DAMAGED.';
    end if;

    select * into v_si from public.sale_items
      where id = nullif(v_item ->> 'sale_item_id', '')::uuid
        and sale_id = v_sale.id;
    if v_si.id is null then
      raise exception 'One of the items does not belong to this bill.';
    end if;

    v_eligible := public.sale_item_remaining_returnable(v_si.id);
    if v_qty > v_eligible then
      raise exception 'RETURN_EXCEEDS_SOLD: only % left to return for % (%).', v_eligible, v_si.product_name, v_si.sku;
    end if;

    if v_max_pct < 100 and (v_si.quantity - v_eligible + v_qty) * 100 > v_si.quantity * v_max_pct then
      raise exception 'RETURN_LIMIT: at most % percent of each sold line can be returned (Settings).', v_max_pct;
    end if;

    -- refund = the exact value the customer paid for those units
    v_line_refund := round(v_si.line_total * v_qty / v_si.quantity, 2);
    v_line_tax := round(v_si.tax_amount * v_qty / v_si.quantity, 2);
    v_refund_total := round(v_refund_total + v_line_refund, 2);

    v_items := v_items || jsonb_build_object(
      'line_no', jsonb_array_length(v_items) + 1,
      'sale_item_id', v_si.id, 'variant_id', v_si.variant_id,
      'product_name', v_si.product_name, 'sku', v_si.sku,
      'quantity', v_qty, 'condition', v_condition,
      'unit_price', v_si.unit_price, 'tax_rate', v_si.gst_rate,
      'tax_amount', v_line_tax, 'line_refund', v_line_refund
    );
  end loop;

  -- refund method handling
  v_refund_method := nullif(trim(coalesce(p_payload ->> 'refund_method', '')), '');
  if v_refund_total > 0 then
    v_refund_enabled := coalesce((public.setting_of('returns', 'refund_enabled', 'true'::jsonb))::boolean, true);
    if not v_refund_enabled and v_sale.due_amount <= 0 then
      raise exception 'REFUNDS_DISABLED: refunds are disabled in Settings; the amount can still offset a due balance.';
    end if;
    if v_refund_method is null and v_sale.due_amount < v_refund_total then
      raise exception 'Choose a refund method for the refundable amount.';
    end if;
    if v_refund_method is not null then
      if lower(v_refund_method) = 'store credit' then
        v_store_credit := true;
        v_refund_method := 'Store Credit';
        if v_sale.customer_id is null then
          raise exception 'STORE_CREDIT_NEEDS_CUSTOMER: store credit requires a customer on the bill.';
        end if;
      else
        v_refund_method := public.canonical_payment_method(v_refund_method);
        if v_refund_method is null then
          raise exception 'PAYMENT_METHOD_DISABLED: "%" is not an accepted refund method.', p_payload ->> 'refund_method';
        end if;
      end if;
    end if;
  end if;

  v_return_number := public.next_doc_number(public.doc_prefix('sales_return_prefix', 'SR'));

  -- refund offsets the bill's due balance first
  v_applied_to_due := least(v_sale.due_amount, v_refund_total);
  v_refunded := round(v_refund_total - v_applied_to_due, 2);

  insert into public.sales_returns (
    return_number, sale_id, sale_number, customer_id, customer_name,
    return_date, reason, refund_method, refund_amount, refund_reference,
    applied_to_due, refunded_by, refunded_by_name, refunded_at, notes,
    created_by, created_by_name
  ) values (
    v_return_number, v_sale.id, v_sale.sale_number, v_sale.customer_id, v_sale.customer_name,
    now(), trim(p_payload ->> 'reason'),
    case when v_refunded > 0 then v_refund_method else null end,
    v_refunded,
    nullif(trim(coalesce(p_payload ->> 'refund_reference', '')), ''),
    v_applied_to_due, v_user, coalesce(nullif(v_name, ''), v_email), now(),
    nullif(trim(coalesce(p_payload ->> 'notes', '')), ''),
    v_user, coalesce(nullif(v_name, ''), v_email)
  )
  returning id into v_return_id;

  perform set_config('app.stock_engine', 'on', true);

  for v_item in select * from jsonb_array_elements(v_items) loop
    -- stock restoration by condition
    if (v_item ->> 'variant_id')::uuid is not null then
      if v_item ->> 'condition' = 'GOOD' then
        insert into public.stock_balances (variant_id, location_id, quantity)
        values ((v_item ->> 'variant_id')::uuid, v_sale.location_id, (v_item ->> 'quantity')::int)
        on conflict (variant_id, location_id)
        do update set quantity = public.stock_balances.quantity + (v_item ->> 'quantity')::int
        returning quantity into v_new_qty;

        insert into public.stock_movements (
          variant_id, location_id, movement_type, quantity, balance_after,
          reference_type, reference_id, reason, user_id, user_email
        ) values (
          (v_item ->> 'variant_id')::uuid, v_sale.location_id, 'SALES_RETURN', (v_item ->> 'quantity')::int, v_new_qty,
          'sales_return', v_return_id::text, 'Return ' || v_return_number,
          v_user, v_email
        )
        returning id into v_movement_id;
        v_movement_count := v_movement_count + 1;
      elsif v_dmg_to_location then
        insert into public.stock_balances (variant_id, location_id, quantity)
        values ((v_item ->> 'variant_id')::uuid, v_dmg_location, (v_item ->> 'quantity')::int)
        on conflict (variant_id, location_id)
        do update set quantity = public.stock_balances.quantity + (v_item ->> 'quantity')::int
        returning quantity into v_new_qty;

        insert into public.stock_movements (
          variant_id, location_id, movement_type, quantity, balance_after,
          reference_type, reference_id, reason, user_id, user_email
        ) values (
          (v_item ->> 'variant_id')::uuid, v_dmg_location, 'SALES_RETURN', (v_item ->> 'quantity')::int, v_new_qty,
          'sales_return', v_return_id::text, 'Damaged return ' || v_return_number,
          v_user, v_email
        )
        returning id into v_movement_id;
        v_movement_count := v_movement_count + 1;
      end if;
    end if;

    insert into public.sales_return_items (
      return_id, line_no, sale_item_id, variant_id, product_name, sku,
      quantity, condition, unit_price, tax_rate, tax_amount, line_refund
    ) values (
      v_return_id, coalesce((v_item ->> 'line_no')::int, 0),
      (v_item ->> 'sale_item_id')::uuid, nullif(v_item ->> 'variant_id', '')::uuid,
      v_item ->> 'product_name', v_item ->> 'sku',
      (v_item ->> 'quantity')::int, v_item ->> 'condition',
      (v_item ->> 'unit_price')::numeric, (v_item ->> 'tax_rate')::numeric,
      (v_item ->> 'tax_amount')::numeric, (v_item ->> 'line_refund')::numeric
    );
  end loop;

  -- bill balance: credit offsets the due, never the paid history
  if v_applied_to_due > 0 then
    update public.sales
      set due_amount = due_amount - v_applied_to_due,
          payment_status = case
            when due_amount - v_applied_to_due <= 0 then 'PAID'
            when paid_amount > 0 then 'PARTIALLY_PAID'
            else 'PARTIALLY_PAID' end::text
      where id = v_sale.id;
  end if;

  -- store-credit refunds become customer advance (proper credit storage)
  if v_store_credit and v_refunded > 0 and v_sale.customer_id is not null then
    v_customer_id := v_sale.customer_id;
    insert into public.customer_payments (
      receipt_number, customer_id, customer_name, amount, allocated_amount,
      method, reference, notes, recorded_by, recorded_by_name
    ) values (
      v_return_number, v_customer_id, coalesce(v_sale.customer_name, 'Customer'),
      v_refunded, 0, 'Store Credit', v_return_number,
      'Store credit from return ' || v_return_number,
      v_user, coalesce(nullif(v_name, ''), v_email)
    )
    returning id into v_advance_payment_id;
  end if;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'sales_return_processed', 'sales_return', v_return_id::text,
          jsonb_build_object(
            'return_number', v_return_number,
            'sale_number', v_sale.sale_number,
            'items', jsonb_array_length(v_items),
            'refund_total', v_refund_total,
            'applied_to_due', v_applied_to_due,
            'refunded', v_refunded,
            'refund_method', v_refund_method,
            'movements', v_movement_count,
            'reason', trim(p_payload ->> 'reason')
          ));

  if v_refunded > 0 then
    insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
    values (v_user, v_email, 'refund_issued', 'sales_return', v_return_id::text,
            jsonb_build_object(
              'return_number', v_return_number,
              'sale_number', v_sale.sale_number,
              'amount', v_refunded,
              'method', v_refund_method,
              'reference', nullif(trim(coalesce(p_payload ->> 'refund_reference', '')), '')
            ));
  end if;

  return jsonb_build_object(
    'return_id', v_return_id,
    'return_number', v_return_number,
    'refund_total', v_refund_total,
    'applied_to_due', v_applied_to_due,
    'refunded', v_refunded,
    'refund_method', v_refund_method
  );
end $$;

revoke all on function public.create_sales_return(jsonb) from public, anon;
grant execute on function public.create_sales_return(jsonb) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 27 — create_exchange(): return old item(s) + issue new item(s).
--
-- One atomic transaction: policy gates → sale validation → return-side
-- eligibility (sold − returned − exchanged) → new-item validation (active,
-- priced from the DATABASE, stock available) → restock returned items by
-- condition → deduct replacement items (SALE movements) → price difference
-- → collect payment or refund (incl. store credit) → audit.
-- ---------------------------------------------------------------------------
create or replace function public.create_exchange(p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_name  text;
  v_sale  public.sales%rowtype;
  v_company public.company_settings%rowtype;
  v_item  jsonb;
  v_ret_items jsonb := '[]'::jsonb;
  v_new_items jsonb := '[]'::jsonb;
  v_si    public.sale_items%rowtype;
  v_vid   uuid;
  v_sku   text; v_pname text; v_size text; v_color text;
  v_qty   int;
  v_eligible int;
  v_condition text;
  v_price numeric;
  v_gst   numeric;
  v_taxamt numeric; v_line numeric;
  v_var_active boolean;
  v_prod_active boolean;
  v_return_value numeric := 0;
  v_issue_value numeric := 0;
  v_difference numeric;
  v_payment_method text;
  v_store_credit boolean;
  v_exchange_number text;
  v_exchange_id uuid;
  v_new_qty int;
  v_reserved int;
  v_movement_id bigint;
  v_movement_count int := 0;
  v_dmg_location uuid;
  v_dmg_to_location boolean;
  v_enabled boolean;
  v_window_days int;
  v_manager_approval boolean;
  v_tax_enabled boolean;
  v_default_rate numeric;
  v_tax_mode text;
  v_allow_negative boolean;
  v_tz text;
  v_sale_local date;
  v_advance_payment_id uuid;
  v_refund_amount numeric;
begin
  -- policy gates
  v_enabled := coalesce((public.setting_of('returns', 'exchange_enabled', 'true'::jsonb))::boolean, true);
  if not v_enabled then
    raise exception 'EXCHANGES_DISABLED: exchanges are currently disabled in Settings.';
  end if;

  perform public.require_permission('process_return', 'You do not have permission to process exchanges.');

  v_manager_approval := coalesce((public.setting_of('returns', 'manager_approval', 'false'::jsonb))::boolean, false);
  if v_manager_approval and not public.has_app_permission('approve_return') then
    raise exception 'EXCHANGE_NEEDS_APPROVAL: this store requires a manager or admin to approve exchanges.';
  end if;

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  if nullif(trim(coalesce(p_payload ->> 'reason', '')), '') is null then
    raise exception 'A reason is required for an exchange.';
  end if;

  select * into v_sale from public.sales
    where id = nullif(p_payload ->> 'sale_id', '')::uuid for update;
  if v_sale.id is null then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status <> 'COMPLETED' then
    raise exception 'Only completed sales can be exchanged.';
  end if;

  v_window_days := coalesce((public.setting_of('returns', 'window_days', '7'::jsonb))::int, 7);
  if v_window_days > 0 then
    v_tz := coalesce(nullif(trim((select cs.timezone from public.company_settings cs limit 1)), ''), 'Asia/Kolkata');
    v_sale_local := (v_sale.sale_date at time zone v_tz)::date;
    if v_sale_local < ((now() at time zone v_tz)::date - v_window_days) then
      raise exception 'RETURN_WINDOW_EXPIRED: this bill is older than the %-day exchange window.', v_window_days;
    end if;
  end if;

  v_dmg_to_location := coalesce((public.setting_of('returns', 'damaged_to_location', 'true'::jsonb))::boolean, true);
  if v_dmg_to_location then
    select id into v_dmg_location from public.stock_locations
      where location_type = 'damaged' and is_active limit 1;
    if v_dmg_location is null then
      raise exception 'No damaged-goods location exists. Create one in Inventory → Locations.';
    end if;
  end if;

  select * into v_company from public.company_settings limit 1;
  v_tax_enabled := coalesce((public.setting_of('tax', 'enabled', 'true'::jsonb))::boolean, true);
  v_default_rate := coalesce((public.setting_of('tax', 'default_rate', '5'::jsonb))::numeric, 5);
  v_tax_mode := coalesce(nullif((select value ->> 'default_tax_mode'
                                 from public.app_settings where key = 'pos'), ''), 'inclusive');
  v_allow_negative := coalesce((public.inv_setting('allow_negative_stock'))::boolean, false);

  -- ---- return side ---------------------------------------------------------
  if jsonb_typeof(p_payload -> 'return_items') <> 'array'
     or (select count(*) from jsonb_array_elements(p_payload -> 'return_items')) = 0 then
    raise exception 'Select at least one item to exchange.';
  end if;

  for v_item in select * from jsonb_array_elements(p_payload -> 'return_items') loop
    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid quantity for one of the returned items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    v_condition := upper(coalesce(nullif(v_item ->> 'condition', ''), 'GOOD'));
    if v_condition not in ('GOOD','DAMAGED') then
      raise exception 'Return condition must be GOOD or DAMAGED.';
    end if;

    select * into v_si from public.sale_items
      where id = nullif(v_item ->> 'sale_item_id', '')::uuid
        and sale_id = v_sale.id;
    if v_si.id is null then
      raise exception 'One of the returned items does not belong to this bill.';
    end if;

    v_eligible := public.sale_item_remaining_returnable(v_si.id);
    if v_qty > v_eligible then
      raise exception 'RETURN_EXCEEDS_SOLD: only % left to exchange for % (%).', v_eligible, v_si.product_name, v_si.sku;
    end if;

    v_return_value := round(v_return_value + v_si.line_total * v_qty / v_si.quantity, 2);

    v_ret_items := v_ret_items || jsonb_build_object(
      'line_no', jsonb_array_length(v_ret_items) + 1,
      'sale_item_id', v_si.id, 'variant_id', v_si.variant_id,
      'product_name', v_si.product_name, 'sku', v_si.sku,
      'quantity', v_qty, 'condition', v_condition,
      'unit_price', v_si.unit_price,
      'line_value', round(v_si.line_total * v_qty / v_si.quantity, 2)
    );
  end loop;

  -- ---- issue side (replacement items) --------------------------------------
  if jsonb_typeof(p_payload -> 'new_items') <> 'array'
     or (select count(*) from jsonb_array_elements(p_payload -> 'new_items')) = 0 then
    raise exception 'Select at least one replacement item.';
  end if;

  for v_item in select * from jsonb_array_elements(p_payload -> 'new_items') loop
    v_vid := nullif(v_item ->> 'variant_id', '')::uuid;
    if v_vid is null then
      raise exception 'Invalid replacement item: missing variant.';
    end if;

    if coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,6}$' or (v_item ->> 'quantity')::int <= 0 then
      raise exception 'Invalid quantity for one of the replacement items.';
    end if;
    v_qty := (v_item ->> 'quantity')::int;

    select pv.sku, p.name, s.name, c.name,
           coalesce(pv.selling_price, p.selling_price),
           pv.is_active, p.is_active
      into v_sku, v_pname, v_size, v_color, v_price, v_var_active, v_prod_active
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
      left join public.sizes s on s.id = pv.size_id
      left join public.colors c on c.id = pv.color_id
      where pv.id = v_vid;

    if v_sku is null then
      raise exception 'VARIANT_NOT_FOUND: one of the replacement items no longer exists.';
    end if;
    if not v_var_active or not v_prod_active then
      raise exception 'VARIANT_INACTIVE: % (%) is deactivated.', v_pname, v_sku;
    end if;
    if v_price is null then
      raise exception 'NO_SELLING_PRICE: % (%) has no selling price set.', v_pname, v_sku;
    end if;

    v_gst := case when v_tax_enabled then
      coalesce((select p2.gst_rate from public.products p2
                join public.product_variants pv2 on pv2.product_id = p2.id where pv2.id = v_vid), v_default_rate)
      else 0 end;

    if v_tax_mode = 'inclusive' then
      v_taxamt := round(v_price * v_qty * v_gst / (100 + v_gst), 2);
      v_line := round(v_price * v_qty, 2);
    else
      v_taxamt := round(v_price * v_qty * v_gst / 100, 2);
      v_line := round(v_price * v_qty + v_taxamt, 2);
    end if;

    v_issue_value := round(v_issue_value + v_line, 2);

    v_new_items := v_new_items || jsonb_build_object(
      'line_no', jsonb_array_length(v_new_items) + 1,
      'variant_id', v_vid, 'product_name', v_pname, 'sku', v_sku,
      'size_name', v_size, 'color_name', v_color,
      'quantity', v_qty, 'unit_price', v_price,
      'gst_rate', v_gst, 'tax_amount', v_taxamt, 'line_total', v_line
    );
  end loop;

  -- ---- price difference ----------------------------------------------------
  v_difference := round(v_issue_value - v_return_value, 2);
  v_payment_method := nullif(trim(coalesce(p_payload ->> 'payment_method', '')), '');

  if v_difference > 0 then
    if v_payment_method is null then
      raise exception 'PAYMENT_REQUIRED: the customer must pay the difference of %.', v_difference;
    end if;
    v_payment_method := public.canonical_payment_method(v_payment_method);
    if v_payment_method is null then
      raise exception 'PAYMENT_METHOD_DISABLED: "%" is not an accepted payment method.', p_payload ->> 'payment_method';
    end if;
  elsif v_difference < 0 then
    v_refund_amount := -v_difference;
    if v_payment_method is not null then
      if lower(v_payment_method) = 'store credit' then
        v_store_credit := true;
        v_payment_method := 'Store Credit';
        if v_sale.customer_id is null then
          raise exception 'STORE_CREDIT_NEEDS_CUSTOMER: store credit requires a customer on the bill.';
        end if;
      else
        v_payment_method := public.canonical_payment_method(v_payment_method);
        if v_payment_method is null then
          raise exception 'PAYMENT_METHOD_DISABLED: "%" is not an accepted refund method.', p_payload ->> 'payment_method';
        end if;
      end if;
    end if;
  end if;

  v_exchange_number := public.next_doc_number(public.doc_prefix('exchange_prefix', 'EX'));

  insert into public.exchanges (
    exchange_number, sale_id, sale_number, customer_id, customer_name,
    exchange_date, reason, return_value, issue_value, difference_amount,
    payment_method, payment_amount, payment_reference, notes,
    created_by, created_by_name
  ) values (
    v_exchange_number, v_sale.id, v_sale.sale_number, v_sale.customer_id, v_sale.customer_name,
    now(), trim(p_payload ->> 'reason'), v_return_value, v_issue_value, v_difference,
    v_payment_method,
    case when v_difference > 0 then v_difference else 0 end,
    nullif(trim(coalesce(p_payload ->> 'payment_reference', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'notes', '')), ''),
    v_user, coalesce(nullif(v_name, ''), v_email)
  )
  returning id into v_exchange_id;

  -- ---- stock: restock returned, issue replacements (row-locked) -----------
  perform set_config('app.stock_engine', 'on', true);

  for v_item in select * from jsonb_array_elements(v_ret_items) loop
    if (v_item ->> 'variant_id')::uuid is not null then
      if v_item ->> 'condition' = 'GOOD' then
        insert into public.stock_balances (variant_id, location_id, quantity)
        values ((v_item ->> 'variant_id')::uuid, v_sale.location_id, (v_item ->> 'quantity')::int)
        on conflict (variant_id, location_id)
        do update set quantity = public.stock_balances.quantity + (v_item ->> 'quantity')::int
        returning quantity into v_new_qty;

        insert into public.stock_movements (
          variant_id, location_id, movement_type, quantity, balance_after,
          reference_type, reference_id, reason, user_id, user_email
        ) values (
          (v_item ->> 'variant_id')::uuid, v_sale.location_id, 'SALES_RETURN', (v_item ->> 'quantity')::int, v_new_qty,
          'exchange', v_exchange_id::text, 'Exchange in ' || v_exchange_number,
          v_user, v_email
        )
        returning id into v_movement_id;
        v_movement_count := v_movement_count + 1;
      elsif v_dmg_to_location then
        insert into public.stock_balances (variant_id, location_id, quantity)
        values ((v_item ->> 'variant_id')::uuid, v_dmg_location, (v_item ->> 'quantity')::int)
        on conflict (variant_id, location_id)
        do update set quantity = public.stock_balances.quantity + (v_item ->> 'quantity')::int
        returning quantity into v_new_qty;

        insert into public.stock_movements (
          variant_id, location_id, movement_type, quantity, balance_after,
          reference_type, reference_id, reason, user_id, user_email
        ) values (
          (v_item ->> 'variant_id')::uuid, v_dmg_location, 'SALES_RETURN', (v_item ->> 'quantity')::int, v_new_qty,
          'exchange', v_exchange_id::text, 'Exchange in (damaged) ' || v_exchange_number,
          v_user, v_email
        )
        returning id into v_movement_id;
        v_movement_count := v_movement_count + 1;
      end if;
    end if;

    insert into public.exchange_items_in (
      exchange_id, line_no, sale_item_id, variant_id, product_name, sku,
      quantity, condition, unit_price, line_value
    ) values (
      v_exchange_id, coalesce((v_item ->> 'line_no')::int, 0),
      (v_item ->> 'sale_item_id')::uuid, nullif(v_item ->> 'variant_id', '')::uuid,
      v_item ->> 'product_name', v_item ->> 'sku',
      (v_item ->> 'quantity')::int, v_item ->> 'condition',
      (v_item ->> 'unit_price')::numeric, (v_item ->> 'line_value')::numeric
    );
  end loop;

  for v_item in select * from jsonb_array_elements(v_new_items) loop
    insert into public.stock_balances (variant_id, location_id, quantity)
    values ((v_item ->> 'variant_id')::uuid, v_sale.location_id, -(v_item ->> 'quantity')::int)
    on conflict (variant_id, location_id)
    do update set quantity = public.stock_balances.quantity - (v_item ->> 'quantity')::int
    returning quantity, reserved_quantity into v_new_qty, v_reserved;

    if (v_new_qty - coalesce(v_reserved, 0)) < 0 and not v_allow_negative then
      raise exception 'INSUFFICIENT_STOCK: only % left for % (%).',
        greatest(v_new_qty - coalesce(v_reserved,0) + (v_item ->> 'quantity')::int, 0),
        v_item ->> 'product_name', v_item ->> 'sku';
    end if;

    insert into public.stock_movements (
      variant_id, location_id, movement_type, quantity, balance_after,
      reference_type, reference_id, reason, user_id, user_email
    ) values (
      (v_item ->> 'variant_id')::uuid, v_sale.location_id, 'SALE', -(v_item ->> 'quantity')::int, v_new_qty,
      'exchange', v_exchange_id::text, 'Exchange out ' || v_exchange_number,
      v_user, v_email
    )
    returning id into v_movement_id;
    v_movement_count := v_movement_count + 1;

    insert into public.exchange_items_out (
      exchange_id, line_no, variant_id, product_name, sku, size_name, color_name,
      quantity, unit_price, gst_rate, tax_amount, line_total
    ) values (
      v_exchange_id, coalesce((v_item ->> 'line_no')::int, 0),
      (v_item ->> 'variant_id')::uuid, v_item ->> 'product_name',
      v_item ->> 'sku', v_item ->> 'size_name', v_item ->> 'color_name',
      (v_item ->> 'quantity')::int, (v_item ->> 'unit_price')::numeric,
      (v_item ->> 'gst_rate')::numeric, (v_item ->> 'tax_amount')::numeric,
      (v_item ->> 'line_total')::numeric
    );
  end loop;

  -- store-credit refund becomes customer advance
  if v_store_credit and v_refund_amount > 0 and v_sale.customer_id is not null then
    insert into public.customer_payments (
      receipt_number, customer_id, customer_name, amount, allocated_amount,
      method, reference, notes, recorded_by, recorded_by_name
    ) values (
      v_exchange_number, v_sale.customer_id, coalesce(v_sale.customer_name, 'Customer'),
      v_refund_amount, 0, 'Store Credit', v_exchange_number,
      'Store credit from exchange ' || v_exchange_number,
      v_user, coalesce(nullif(v_name, ''), v_email)
    )
    returning id into v_advance_payment_id;
  end if;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'exchange_processed', 'exchange', v_exchange_id::text,
          jsonb_build_object(
            'exchange_number', v_exchange_number,
            'sale_number', v_sale.sale_number,
            'return_value', v_return_value,
            'issue_value', v_issue_value,
            'difference', v_difference,
            'payment_method', v_payment_method,
            'movements', v_movement_count,
            'reason', trim(p_payload ->> 'reason')
          ));

  if v_difference < 0 then
    insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
    values (v_user, v_email, 'refund_issued', 'exchange', v_exchange_id::text,
            jsonb_build_object(
              'exchange_number', v_exchange_number,
              'amount', v_refund_amount,
              'method', v_payment_method
            ));
  end if;

  return jsonb_build_object(
    'exchange_id', v_exchange_id,
    'exchange_number', v_exchange_number,
    'return_value', v_return_value,
    'issue_value', v_issue_value,
    'difference_amount', v_difference,
    'payment_method', v_payment_method
  );
end $$;

revoke all on function public.create_exchange(jsonb) from public, anon;
grant execute on function public.create_exchange(jsonb) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 28 — expense RPCs (create / approve / cancel). Numbered EXP-.
-- ---------------------------------------------------------------------------
create or replace function public.create_expense(p_payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_name  text;
  v_category public.expense_categories%rowtype;
  v_canon text;
  v_amount numeric;
  v_expense_number text;
  v_expense_id uuid;
  v_location public.stock_locations%rowtype;
  v_expense_date date;
begin
  perform public.require_permission('manage_expenses', 'You do not have permission to manage expenses.');

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_category from public.expense_categories
    where id = nullif(p_payload ->> 'category_id', '')::uuid and is_active;
  if v_category.id is null then
    raise exception 'CATEGORY_NOT_FOUND: expense category not found or inactive.';
  end if;

  if nullif(trim(coalesce(p_payload ->> 'description', '')), '') is null then
    raise exception 'A description is required.';
  end if;

  if coalesce(p_payload ->> 'amount', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' or (p_payload ->> 'amount')::numeric <= 0 then
    raise exception 'Invalid expense amount.';
  end if;
  v_amount := round((p_payload ->> 'amount')::numeric, 2);

  v_canon := public.canonical_payment_method(coalesce(p_payload ->> 'method', ''));
  if v_canon is null then
    raise exception 'PAYMENT_METHOD_DISABLED: "%" is not an accepted payment method.', coalesce(p_payload ->> 'method', '');
  end if;

  if nullif(p_payload ->> 'location_id', '') is not null then
    select id, name into v_location from public.stock_locations
      where id = (p_payload ->> 'location_id')::uuid and is_active;
    if v_location.id is null then
      raise exception 'Branch / location not found or inactive.';
    end if;
  end if;

  v_expense_date := coalesce(nullif(p_payload ->> 'expense_date', '')::date, current_date);
  if v_expense_date > current_date then
    raise exception 'The expense date cannot be in the future.';
  end if;

  v_expense_number := public.next_doc_number(public.doc_prefix('expense_prefix', 'EXP'));

  insert into public.expenses (
    expense_number, category_id, category_name, description, amount, method,
    location_id, location_name, expense_date, notes, status,
    created_by, created_by_name
  ) values (
    v_expense_number, v_category.id, v_category.name, trim(p_payload ->> 'description'),
    v_amount, v_canon,
    v_location.id, v_location.name, v_expense_date,
    nullif(trim(coalesce(p_payload ->> 'notes', '')), ''),
    'PENDING', v_user, coalesce(nullif(v_name, ''), v_email)
  )
  returning id into v_expense_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'expense_created', 'expense', v_expense_id::text,
          jsonb_build_object(
            'expense_number', v_expense_number,
            'category', v_category.name,
            'amount', v_amount,
            'method', v_canon,
            'expense_date', v_expense_date
          ));

  return jsonb_build_object(
    'expense_id', v_expense_id,
    'expense_number', v_expense_number,
    'status', 'PENDING'
  );
end $$;

create or replace function public.approve_expense(p_expense_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_name  text;
  v_exp   public.expenses%rowtype;
begin
  perform public.require_permission('approve_expense', 'You do not have permission to approve expenses.');

  select email, coalesce(nullif(trim(full_name), ''), '') into v_email, v_name
    from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  select * into v_exp from public.expenses where id = p_expense_id for update;
  if v_exp.id is null then
    raise exception 'Expense not found.';
  end if;
  if v_exp.status <> 'PENDING' then
    raise exception 'Only PENDING expenses can be approved.';
  end if;

  update public.expenses
    set status = 'APPROVED', approved_at = now(), approved_by = v_user, approved_by_name = coalesce(nullif(v_name, ''), v_email)
    where id = p_expense_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'expense_approved', 'expense', p_expense_id::text,
          jsonb_build_object('expense_number', v_exp.expense_number, 'amount', v_exp.amount));

  return jsonb_build_object('expense_id', p_expense_id, 'status', 'APPROVED');
end $$;

create or replace function public.cancel_expense(p_expense_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_email text;
  v_exp   public.expenses%rowtype;
begin
  perform public.require_permission('manage_expenses', 'You do not have permission to manage expenses.');

  select email into v_email from public.profiles where id = v_user and is_active;
  if v_email is null then
    raise exception 'Your account is not active.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to cancel an expense.';
  end if;

  select * into v_exp from public.expenses where id = p_expense_id for update;
  if v_exp.id is null then
    raise exception 'Expense not found.';
  end if;
  if v_exp.status = 'CANCELLED' then
    raise exception 'This expense is already cancelled.';
  end if;
  if v_exp.status = 'APPROVED' and not public.has_app_permission('approve_expense') then
    raise exception 'Only expense approvers can cancel an approved expense.';
  end if;

  update public.expenses
    set status = 'CANCELLED', cancelled_at = now(), cancelled_by = v_user, cancel_reason = trim(p_reason)
    where id = p_expense_id;

  insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, metadata)
  values (v_user, v_email, 'expense_cancelled', 'expense', p_expense_id::text,
          jsonb_build_object('expense_number', v_exp.expense_number, 'reason', trim(p_reason),
                             'was_approved', v_exp.status = 'APPROVED'));

  return jsonb_build_object('expense_id', p_expense_id, 'status', 'CANCELLED');
end $$;

revoke all on function public.create_expense(jsonb) from public, anon;
revoke all on function public.approve_expense(uuid) from public, anon;
revoke all on function public.cancel_expense(uuid, text) from public, anon;
grant execute on function public.create_expense(jsonb) to authenticated, service_role;
grant execute on function public.approve_expense(uuid) to authenticated, service_role;
grant execute on function public.cancel_expense(uuid, text) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 29 — customers_page(): database-side search + pagination with live
-- dues aggregates. Never loads the whole directory into the browser.
-- ---------------------------------------------------------------------------
create or replace function public.customers_page(
  p_search     text default null,
  p_type       text default null,
  p_active     text default null,
  p_limit      int  default 25,
  p_offset     int  default 0
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
     and not (public.has_app_permission('manage_customers')
              or public.has_app_permission('record_customer_payment')
              or public.has_app_permission('view_sales')) then
    raise exception 'You do not have permission to view customers.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(c.name ILIKE %1$L OR c.phone ILIKE %1$L OR c.email ILIKE %1$L OR c.gstin ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_type in ('retail','wholesale') then
    v_filtered := true;
    v_where := v_where || format('c.customer_type = %L', p_type);
  end if;
  if p_active = 'active' then
    v_filtered := true;
    v_where := v_where || 'c.is_active';
  elsif p_active = 'inactive' then
    v_filtered := true;
    v_where := v_where || 'not c.is_active';
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select c.id, c.name, c.phone, c.alt_phone, c.email, c.city, c.state,
             c.gstin, c.customer_type, c.credit_limit, c.notes, c.is_active,
             c.created_at,
             coalesce(st.total_billed, 0)  as total_billed,
             coalesce(st.bills, 0)         as bills,
             coalesce(st.outstanding, 0)   as outstanding,
             coalesce(pay.paid_total, 0)   as total_paid,
             coalesce(pay.advance, 0)      as advance
      from public.customers c
      left join lateral (
        select sum(s.grand_total) as total_billed,
               count(*) as bills,
               sum(s.due_amount) as outstanding
        from public.sales s
        where s.customer_id = c.id and s.status = 'COMPLETED'
      ) st on true
      left join lateral (
        select sum(cp.amount) as paid_total,
               sum(cp.amount - cp.allocated_amount) as advance
        from public.customer_payments cp
        where cp.customer_id = c.id
      ) pay on true
      where %s
      order by (coalesce(st.outstanding, 0) > 0) desc, c.name asc, c.id
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.customers c where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'customers' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.customers' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

revoke all on function public.customers_page(text, text, text, int, int) from public, anon;
grant execute on function public.customers_page(text, text, text, int, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 30 — customer_detail(): profile + aggregates + bounded recent lists.
-- ---------------------------------------------------------------------------
create or replace function public.customer_detail(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_customer public.customers%rowtype;
  v_sales    jsonb;
  v_payments jsonb;
  v_returns  jsonb;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_customers')
              or public.has_app_permission('record_customer_payment')
              or public.has_app_permission('view_sales')) then
    raise exception 'You do not have permission to view customers.';
  end if;

  select * into v_customer from public.customers where id = p_customer_id;
  if v_customer.id is null then
    raise exception 'Customer not found.';
  end if;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_sales from (
    select s.id, s.sale_number, s.sale_date, s.status, s.payment_status,
           s.grand_total, s.paid_amount, s.due_amount
    from public.sales s
    where s.customer_id = p_customer_id and s.status = 'COMPLETED'
    order by s.sale_date desc
    limit 50
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_payments from (
    select cp.id, cp.receipt_number, cp.recorded_at, cp.method, cp.amount,
           cp.allocated_amount, (cp.amount - cp.allocated_amount) as advance_part,
           cp.reference, cp.recorded_by_name
    from public.customer_payments cp
    where cp.customer_id = p_customer_id
    order by cp.recorded_at desc
    limit 50
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_returns from (
    select r.id, r.return_number, r.return_date, r.refund_amount,
           r.applied_to_due, r.refund_method, r.reason
    from public.sales_returns r
    where r.customer_id = p_customer_id
    order by r.return_date desc
    limit 50
  ) t;

  return jsonb_build_object(
    'customer', to_jsonb(v_customer),
    'stats', jsonb_build_object(
      'total_billed', (select coalesce(sum(s.grand_total), 0) from public.sales s
                        where s.customer_id = p_customer_id and s.status = 'COMPLETED'),
      'bills', (select count(*) from public.sales s
                 where s.customer_id = p_customer_id and s.status = 'COMPLETED'),
      'total_paid', (select coalesce(sum(cp.amount), 0) from public.customer_payments cp
                      where cp.customer_id = p_customer_id),
      'outstanding', (select coalesce(sum(s.due_amount), 0) from public.sales s
                       where s.customer_id = p_customer_id and s.status = 'COMPLETED' and s.due_amount > 0),
      'advance', (select coalesce(sum(cp.amount - cp.allocated_amount), 0) from public.customer_payments cp
                   where cp.customer_id = p_customer_id and cp.allocated_amount < cp.amount),
      'returns_total', (select coalesce(sum(r.refund_amount + r.applied_to_due), 0) from public.sales_returns r
                         where r.customer_id = p_customer_id)
    ),
    'sales', v_sales,
    'payments', v_payments,
    'returns', v_returns
  );
end $$;

revoke all on function public.customer_detail(uuid) from public, anon;
grant execute on function public.customer_detail(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 31 — customer_statement(): opening balance + ledger lines + closing
-- balance for a date range, computed database-side (browser never iterates
-- history).
-- ---------------------------------------------------------------------------
create or replace function public.customer_statement(
  p_customer_id uuid,
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_customer public.customers%rowtype;
  v_from     date := coalesce(p_from, '1970-01-01'::date);
  v_to       date := coalesce(p_to, current_date);
  v_to_ts    timestamptz := (v_to + 1)::timestamptz;
  v_from_ts  timestamptz := v_from::timestamptz;
  v_opening  numeric := 0;
  v_lines    jsonb;
  v_closing  numeric := 0;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_customers')
              or public.has_app_permission('record_customer_payment')
              or public.has_app_permission('view_sales')) then
    raise exception 'You do not have permission to view customers.';
  end if;

  select * into v_customer from public.customers where id = p_customer_id;
  if v_customer.id is null then
    raise exception 'Customer not found.';
  end if;

  -- opening = billed − paid − return credits, everything before p_from
  select
    coalesce((select sum(s.grand_total) from public.sales s
              where s.customer_id = p_customer_id and s.status = 'COMPLETED'
                and s.sale_date < v_from_ts), 0)
    - coalesce((select sum(cp.amount) from public.customer_payments cp
                where cp.customer_id = p_customer_id and cp.recorded_at < v_from_ts), 0)
    - coalesce((select sum(r.applied_to_due + r.refund_amount) from public.sales_returns r
                where r.customer_id = p_customer_id and r.return_date < v_from_ts), 0)
  into v_opening;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_lines from (
    select * from (
      select s.sale_date as entry_date, 'bill' as kind, s.sale_number as doc_number,
             s.grand_total as debit, 0::numeric as credit, s.id as link_id
      from public.sales s
      where s.customer_id = p_customer_id and s.status = 'COMPLETED'
        and s.sale_date >= v_from_ts and s.sale_date < v_to_ts
      union all
      select cp.recorded_at, 'payment', cp.receipt_number,
             0::numeric, cp.amount, cp.id
      from public.customer_payments cp
      where cp.customer_id = p_customer_id
        and cp.recorded_at >= v_from_ts and cp.recorded_at < v_to_ts
      union all
      select r.return_date, 'return', r.return_number,
             0::numeric, (r.applied_to_due + r.refund_amount), r.id
      from public.sales_returns r
      where r.customer_id = p_customer_id
        and r.return_date >= v_from_ts and r.return_date < v_to_ts
    ) u
    order by entry_date asc, doc_number asc
  ) t;

  select coalesce(sum(t.debit), 0) - coalesce(sum(t.credit), 0) into v_closing
  from jsonb_to_recordset(v_lines) as t(debit numeric, credit numeric);

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_customer.id, 'name', v_customer.name, 'phone', v_customer.phone,
      'email', v_customer.email, 'address', v_customer.address,
      'city', v_customer.city, 'state', v_customer.state, 'gstin', v_customer.gstin),
    'from_date', v_from, 'to_date', v_to,
    'opening_balance', round(v_opening, 2),
    'lines', v_lines,
    'closing_balance', round(v_opening + v_closing, 2)
  );
end $$;

revoke all on function public.customer_statement(uuid, date, date) from public, anon;
grant execute on function public.customer_statement(uuid, date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 32 — suppliers_page() / supplier_detail()
-- ---------------------------------------------------------------------------
create or replace function public.suppliers_page(
  p_search  text default null,
  p_active  text default null,
  p_limit   int  default 25,
  p_offset  int  default 0
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
     and not (public.has_app_permission('manage_suppliers')
              or public.has_app_permission('view_purchases')
              or public.has_app_permission('record_supplier_payment')) then
    raise exception 'You do not have permission to view suppliers.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(sp.name ILIKE %1$L OR sp.phone ILIKE %1$L OR sp.contact_person ILIKE %1$L OR sp.gstin ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_active = 'active' then
    v_filtered := true;
    v_where := v_where || 'sp.is_active';
  elsif p_active = 'inactive' then
    v_filtered := true;
    v_where := v_where || 'not sp.is_active';
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select sp.id, sp.name, sp.contact_person, sp.phone, sp.email, sp.city,
             sp.state, sp.gstin, sp.notes, sp.is_active, sp.created_at,
             coalesce(st.total_purchases, 0) as total_purchases,
             coalesce(st.invoices, 0)         as invoices,
             coalesce(st.payable, 0)          as outstanding,
             coalesce(pay.paid_total, 0)      as total_paid
      from public.suppliers sp
      left join lateral (
        select sum(pi.grand_total) as total_purchases,
               count(*) as invoices,
               sum(pi.due_amount) as payable
        from public.purchase_invoices pi
        where pi.supplier_id = sp.id and pi.status = 'RECEIVED'
      ) st on true
      left join lateral (
        select sum(spp.amount) as paid_total
        from public.supplier_payments spp
        where spp.supplier_id = sp.id
      ) pay on true
      where %s
      order by (coalesce(st.payable, 0) > 0) desc, sp.name asc, sp.id
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.suppliers sp where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'suppliers' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.suppliers' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

create or replace function public.supplier_detail(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_supplier public.suppliers%rowtype;
  v_invoices jsonb;
  v_payments jsonb;
  v_returns  jsonb;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_suppliers')
              or public.has_app_permission('view_purchases')
              or public.has_app_permission('record_supplier_payment')) then
    raise exception 'You do not have permission to view suppliers.';
  end if;

  select * into v_supplier from public.suppliers where id = p_supplier_id;
  if v_supplier.id is null then
    raise exception 'Supplier not found.';
  end if;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_invoices from (
    select pi.id, pi.invoice_number, pi.invoice_date, pi.po_number,
           pi.supplier_invoice_no, pi.status, pi.payment_status,
           pi.grand_total, pi.paid_amount, pi.due_amount
    from public.purchase_invoices pi
    where pi.supplier_id = p_supplier_id
    order by pi.invoice_date desc
    limit 50
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_payments from (
    select spp.id, spp.payment_number, spp.recorded_at, spp.method, spp.amount,
           spp.allocated_amount, (spp.amount - spp.allocated_amount) as advance_part,
           spp.reference, spp.recorded_by_name
    from public.supplier_payments spp
    where spp.supplier_id = p_supplier_id
    order by spp.recorded_at desc
    limit 50
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_returns from (
    select pr.id, pr.return_number, pr.return_date, pr.invoice_number,
           pr.grand_total, pr.reason
    from public.purchase_returns pr
    where pr.supplier_id = p_supplier_id
    order by pr.return_date desc
    limit 50
  ) t;

  return jsonb_build_object(
    'supplier', to_jsonb(v_supplier),
    'stats', jsonb_build_object(
      'total_purchases', (select coalesce(sum(pi.grand_total), 0) from public.purchase_invoices pi
                           where pi.supplier_id = p_supplier_id and pi.status = 'RECEIVED'),
      'invoices', (select count(*) from public.purchase_invoices pi
                    where pi.supplier_id = p_supplier_id and pi.status = 'RECEIVED'),
      'total_paid', (select coalesce(sum(spp.amount), 0) from public.supplier_payments spp
                      where spp.supplier_id = p_supplier_id),
      'outstanding', (select coalesce(sum(pi.due_amount), 0) from public.purchase_invoices pi
                       where pi.supplier_id = p_supplier_id and pi.status = 'RECEIVED' and pi.due_amount > 0),
      'returns_total', (select coalesce(sum(pr.grand_total), 0) from public.purchase_returns pr
                         where pr.supplier_id = p_supplier_id)
    ),
    'invoices', v_invoices,
    'payments', v_payments,
    'returns', v_returns
  );
end $$;

revoke all on function public.suppliers_page(text, text, int, int) from public, anon;
revoke all on function public.supplier_detail(uuid) from public, anon;
grant execute on function public.suppliers_page(text, text, int, int) to authenticated, service_role;
grant execute on function public.supplier_detail(uuid) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 33 — purchase orders / invoices / returns list RPCs + details.
-- ---------------------------------------------------------------------------
create or replace function public.purchase_orders_page(
  p_search    text default null,
  p_supplier  uuid default null,
  p_status    text default null,
  p_date_from date default null,
  p_date_to   date default null,
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_purchases')
              or public.has_app_permission('view_purchases')) then
    raise exception 'You do not have permission to view purchases.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(po.po_number ILIKE %1$L OR po.supplier_name ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_supplier is not null then
    v_filtered := true;
    v_where := v_where || format('po.supplier_id = %L', p_supplier::text);
  end if;
  if p_status in ('DRAFT','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED') then
    v_filtered := true;
    v_where := v_where || format('po.status = %L', p_status);
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('po.order_date >= %L', (p_date_from::timestamptz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('po.order_date < (%L::date + 1)::timestamptz', (p_date_to)::text);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select po.id, po.po_number, po.supplier_id, po.supplier_name,
             po.location_name, po.order_date, po.expected_date, po.status,
             po.subtotal, po.discount_total, po.tax_total, po.grand_total,
             po.cancelled_at, po.cancel_reason,
             coalesce(ii.item_count, 0) as item_count,
             coalesce(ii.unit_count, 0) as unit_count,
             coalesce(ii.received_units, 0) as received_units
      from public.purchase_orders po
      left join lateral (
        select count(*) as item_count, sum(quantity) as unit_count,
               sum(received_quantity) as received_units
        from public.purchase_order_items poi where poi.po_id = po.id
      ) ii on true
      where %s
      order by po.order_date desc, po.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.purchase_orders po where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'purchase_orders' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.purchase_orders' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

create or replace function public.purchase_order_detail(p_po_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_po     public.purchase_orders%rowtype;
  v_items  jsonb;
  v_invoices jsonb;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_purchases')
              or public.has_app_permission('view_purchases')) then
    raise exception 'You do not have permission to view purchases.';
  end if;

  select * into v_po from public.purchase_orders where id = p_po_id;
  if v_po.id is null then
    raise exception 'Purchase order not found.';
  end if;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_items from (
    select poi.id, poi.variant_id, poi.product_name, poi.sku, poi.size_name,
           poi.color_name, poi.quantity, poi.unit_cost, poi.discount_amount,
           poi.gst_rate, poi.tax_amount, poi.line_total, poi.received_quantity,
           (poi.quantity - poi.received_quantity) as pending_quantity
    from public.purchase_order_items poi
    where poi.po_id = p_po_id
    order by poi.line_no, poi.id
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_invoices from (
    select pi.id, pi.invoice_number, pi.invoice_date, pi.status,
           pi.supplier_invoice_no, pi.grand_total
    from public.purchase_invoices pi
    where pi.po_id = p_po_id and pi.status <> 'CANCELLED'
    order by pi.invoice_date desc
  ) t;

  return jsonb_build_object('purchase_order', to_jsonb(v_po), 'items', v_items, 'invoices', v_invoices);
end $$;

create or replace function public.purchase_invoices_page(
  p_search         text default null,
  p_supplier       uuid default null,
  p_status         text default null,
  p_payment_status text default null,
  p_date_from      date default null,
  p_date_to        date default null,
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
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_purchases')
              or public.has_app_permission('view_purchases')
              or public.has_app_permission('record_supplier_payment')) then
    raise exception 'You do not have permission to view purchases.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(pi.invoice_number ILIKE %1$L OR pi.supplier_invoice_no ILIKE %1$L OR pi.supplier_name ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_supplier is not null then
    v_filtered := true;
    v_where := v_where || format('pi.supplier_id = %L', p_supplier::text);
  end if;
  if p_status in ('DRAFT','RECEIVED','CANCELLED') then
    v_filtered := true;
    v_where := v_where || format('pi.status = %L', p_status);
  end if;
  if p_payment_status in ('PAID','PARTIALLY_PAID','DUE') then
    v_filtered := true;
    v_where := v_where || format('pi.payment_status = %L', p_payment_status);
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('pi.invoice_date >= %L', (p_date_from::timestamptz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('pi.invoice_date < (%L::date + 1)::timestamptz', (p_date_to)::text);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select pi.id, pi.invoice_number, pi.supplier_id, pi.supplier_name,
             pi.po_number, pi.supplier_invoice_no, pi.supplier_invoice_date,
             pi.location_name, pi.invoice_date, pi.status, pi.payment_status,
             pi.subtotal, pi.discount_total, pi.tax_total, pi.grand_total,
             pi.paid_amount, pi.due_amount,
             pi.cancelled_at, pi.cancel_reason,
             coalesce(ii.item_count, 0) as item_count,
             coalesce(ii.unit_count, 0) as unit_count
      from public.purchase_invoices pi
      left join lateral (
        select count(*) as item_count, sum(quantity) as unit_count
        from public.purchase_invoice_items pii where pii.invoice_id = pi.id
      ) ii on true
      where %s
      order by pi.invoice_date desc, pi.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.purchase_invoices pi where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'purchase_invoices' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.purchase_invoices' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

create or replace function public.purchase_invoice_detail(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_pi      public.purchase_invoices%rowtype;
  v_items   jsonb;
  v_payments jsonb;
  v_returns jsonb;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_purchases')
              or public.has_app_permission('view_purchases')
              or public.has_app_permission('record_supplier_payment')) then
    raise exception 'You do not have permission to view purchases.';
  end if;

  select * into v_pi from public.purchase_invoices where id = p_invoice_id;
  if v_pi.id is null then
    raise exception 'Purchase invoice not found.';
  end if;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_items from (
    select pii.id, pii.variant_id, pii.product_name, pii.sku, pii.size_name,
           pii.color_name, pii.quantity, pii.unit_cost, pii.discount_amount,
           pii.gst_rate, pii.tax_amount, pii.line_total, pii.returned_quantity,
           (pii.quantity - pii.returned_quantity) as returnable_quantity
    from public.purchase_invoice_items pii
    where pii.invoice_id = p_invoice_id
    order by pii.line_no, pii.id
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_payments from (
    select spp.id, spp.payment_number, spp.recorded_at, spp.method, spp.amount,
           spp.reference, spp.recorded_by_name
    from public.supplier_payments spp
    join public.supplier_payment_allocations spa on spa.payment_id = spp.id
    where spa.invoice_id = p_invoice_id
    order by spp.recorded_at desc
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_returns from (
    select pr.id, pr.return_number, pr.return_date, pr.reason, pr.grand_total,
           pr.applied_to_due
    from public.purchase_returns pr
    where pr.purchase_invoice_id = p_invoice_id
    order by pr.return_date desc
  ) t;

  return jsonb_build_object(
    'invoice', to_jsonb(v_pi), 'items', v_items,
    'payments', v_payments, 'returns', v_returns
  );
end $$;

create or replace function public.purchase_returns_page(
  p_search    text default null,
  p_supplier  uuid default null,
  p_date_from date default null,
  p_date_to   date default null,
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('manage_purchases')
              or public.has_app_permission('view_purchases')) then
    raise exception 'You do not have permission to view purchase returns.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(pr.return_number ILIKE %1$L OR pr.supplier_name ILIKE %1$L OR pr.invoice_number ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_supplier is not null then
    v_filtered := true;
    v_where := v_where || format('pr.supplier_id = %L', p_supplier::text);
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('pr.return_date >= %L', (p_date_from::timestamptz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('pr.return_date < (%L::date + 1)::timestamptz', (p_date_to)::text);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select pr.id, pr.return_number, pr.purchase_invoice_id, pr.invoice_number,
             pr.supplier_id, pr.supplier_name, pr.return_date, pr.reason,
             pr.subtotal, pr.tax_total, pr.grand_total, pr.applied_to_due,
             coalesce(ii.item_count, 0) as item_count
      from public.purchase_returns pr
      left join lateral (
        select count(*) as item_count from public.purchase_return_items pri
        where pri.return_id = pr.id
      ) ii on true
      where %s
      order by pr.return_date desc, pr.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.purchase_returns pr where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'purchase_returns' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.purchase_returns' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

revoke all on function public.purchase_orders_page(text, uuid, text, date, date, int, int) from public, anon;
revoke all on function public.purchase_order_detail(uuid) from public, anon;
revoke all on function public.purchase_invoices_page(text, uuid, text, text, date, date, int, int) from public, anon;
revoke all on function public.purchase_invoice_detail(uuid) from public, anon;
revoke all on function public.purchase_returns_page(text, uuid, date, date, int, int) from public, anon;
grant execute on function public.purchase_orders_page(text, uuid, text, date, date, int, int) to authenticated, service_role;
grant execute on function public.purchase_order_detail(uuid) to authenticated, service_role;
grant execute on function public.purchase_invoices_page(text, uuid, text, text, date, date, int, int) to authenticated, service_role;
grant execute on function public.purchase_invoice_detail(uuid) to authenticated, service_role;
grant execute on function public.purchase_returns_page(text, uuid, date, date, int, int) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 34 — sales returns / exchanges / expenses / unified payments lists.
-- ---------------------------------------------------------------------------
create or replace function public.sales_returns_page(
  p_search    text default null,
  p_customer  uuid default null,
  p_date_from date default null,
  p_date_to   date default null,
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('view_sales')
              or public.has_app_permission('process_return')
              or public.has_app_permission('create_sale')) then
    raise exception 'You do not have permission to view returns.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(r.return_number ILIKE %1$L OR r.sale_number ILIKE %1$L OR r.customer_name ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_customer is not null then
    v_filtered := true;
    v_where := v_where || format('r.customer_id = %L', p_customer::text);
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('r.return_date >= %L', (p_date_from::timestamptz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('r.return_date < (%L::date + 1)::timestamptz', (p_date_to)::text);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select r.id, r.return_number, r.sale_id, r.sale_number, r.customer_id,
             r.customer_name, r.return_date, r.reason, r.refund_method,
             r.refund_amount, r.applied_to_due, r.created_by_name,
             coalesce(ii.item_count, 0) as item_count,
             coalesce(ii.units, 0) as units
      from public.sales_returns r
      left join lateral (
        select count(*) as item_count, sum(quantity) as units
        from public.sales_return_items sri where sri.return_id = r.id
      ) ii on true
      where %s
      order by r.return_date desc, r.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.sales_returns r where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'sales_returns' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.sales_returns' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

create or replace function public.exchanges_page(
  p_search    text default null,
  p_customer  uuid default null,
  p_date_from date default null,
  p_date_to   date default null,
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('view_sales')
              or public.has_app_permission('process_return')
              or public.has_app_permission('create_sale')) then
    raise exception 'You do not have permission to view exchanges.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(e.exchange_number ILIKE %1$L OR e.sale_number ILIKE %1$L OR e.customer_name ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_customer is not null then
    v_filtered := true;
    v_where := v_where || format('e.customer_id = %L', p_customer::text);
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('e.exchange_date >= %L', (p_date_from::timestamptz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('e.exchange_date < (%L::date + 1)::timestamptz', (p_date_to)::text);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select e.id, e.exchange_number, e.sale_id, e.sale_number, e.customer_id,
             e.customer_name, e.exchange_date, e.reason, e.return_value,
             e.issue_value, e.difference_amount, e.payment_method,
             e.created_by_name,
             (select count(*) from public.exchange_items_in ei
              where ei.exchange_id = e.id) as returned_items,
             (select count(*) from public.exchange_items_out eo
              where eo.exchange_id = e.id) as issued_items
      from public.exchanges e
      where %s
      order by e.exchange_date desc, e.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format('select count(*) from public.exchanges e where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'exchanges' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.exchanges' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

create or replace function public.expenses_page(
  p_search    text default null,
  p_category  uuid default null,
  p_status    text default null,
  p_method    text default null,
  p_date_from date default null,
  p_date_to   date default null,
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
  v_summary  jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('manage_expenses') then
    raise exception 'You do not have permission to view expenses.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(ex.expense_number ILIKE %1$L OR ex.description ILIKE %1$L OR ex.category_name ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_category is not null then
    v_filtered := true;
    v_where := v_where || format('ex.category_id = %L', p_category::text);
  end if;
  if p_status in ('PENDING','APPROVED','CANCELLED') then
    v_filtered := true;
    v_where := v_where || format('ex.status = %L', p_status);
  end if;
  if nullif(trim(coalesce(p_method, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format('ex.method = %L', p_method);
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('ex.expense_date >= %L', (p_date_from)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('ex.expense_date <= %L', (p_date_to)::text);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select ex.id, ex.expense_number, ex.category_id, ex.category_name,
             ex.description, ex.amount, ex.method, ex.location_name,
             ex.expense_date, ex.notes, ex.status,
             ex.attachment_path, ex.attachment_name, ex.attachment_size,
             ex.created_by_name, ex.created_at,
             ex.approved_by_name, ex.approved_at,
             ex.cancelled_at, ex.cancel_reason
      from public.expenses ex
      where %s
      order by ex.expense_date desc, ex.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  -- period totals for the filtered set (excluding cancelled)
  execute format($sql$
    select coalesce(jsonb_build_object(
      'count', count(*),
      'pending', coalesce(sum(case when ex.status = 'PENDING' then ex.amount end), 0),
      'approved', coalesce(sum(case when ex.status = 'APPROVED' then ex.amount end), 0),
      'cancelled', count(*) filter (where ex.status = 'CANCELLED')
    ), '{}'::jsonb)
    from public.expenses ex where %s
  $sql$, array_to_string(v_where, ' and ')) into v_summary;

  if v_filtered then
    execute format('select count(*) from public.expenses ex where %s',
                   array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'expenses' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.expenses' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'total_is_estimate', not v_filtered, 'summary', v_summary);
end $$;

revoke all on function public.sales_returns_page(text, uuid, date, date, int, int) from public, anon;
revoke all on function public.exchanges_page(text, uuid, date, date, int, int) from public, anon;
revoke all on function public.expenses_page(text, uuid, text, text, date, date, int, int) from public, anon;
grant execute on function public.sales_returns_page(text, uuid, date, date, int, int) to authenticated, service_role;
grant execute on function public.exchanges_page(text, uuid, date, date, int, int) to authenticated, service_role;
grant execute on function public.expenses_page(text, uuid, text, text, date, date, int, int) to authenticated, service_role;

commit;

begin;

-- ---------------------------------------------------------------------------
-- PART 35 — payments_page(): the unified payment history (customer receipts,
-- supplier payments, sale payments, refunds, expense payments) with
-- database-side filters + pagination.
-- ---------------------------------------------------------------------------
create or replace function public.payments_page(
  p_search    text default null,
  p_source    text default null,
  p_method    text default null,
  p_date_from date default null,
  p_date_to   date default null,
  p_min       numeric default null,
  p_max       numeric default null,
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_rows  jsonb;
  v_total bigint;
  v_can_view_sales   boolean;
  v_can_view_purch   boolean;
  v_can_view_exp     boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.';
  end if;
  v_can_view_sales := public.has_app_permission('view_sales')
                      or public.has_app_permission('create_sale');
  v_can_view_purch := public.has_app_permission('view_purchases')
                      or public.has_app_permission('manage_purchases')
                      or public.has_app_permission('record_supplier_payment');
  v_can_view_exp   := public.has_app_permission('manage_expenses');
  if not (v_can_view_sales or v_can_view_purch or v_can_view_exp) then
    raise exception 'You do not have permission to view payment history.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if p_source is not null and p_source not in
     ('customer_payment','supplier_payment','sale_payment','refund','expense') then
    raise exception 'Invalid payment source filter.';
  end if;

  with src as (
    select 'customer_payment' as source, cp.id::text as source_id,
           cp.receipt_number as doc_number, cp.recorded_at as entry_at,
           cp.method, cp.amount, cp.reference, cp.recorded_by_name as user_name,
           cp.customer_name as party_name, cp.notes
    from public.customer_payments cp
    where v_can_view_sales or public.has_app_permission('record_customer_payment')
      or public.has_app_permission('manage_customers')
    union all
    select 'supplier_payment', spp.id::text, spp.payment_number, spp.recorded_at,
           spp.method, spp.amount, spp.reference, spp.recorded_by_name,
           spp.supplier_name, spp.notes
    from public.supplier_payments spp
    where v_can_view_purch
    union all
    select 'sale_payment', sp.id::text, s.sale_number, sp.created_at,
           sp.method, sp.amount, sp.reference, s.cashier_name,
           coalesce(s.customer_name, 'Walk-in'), null
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
    where v_can_view_sales and sp.is_credit = false
    union all
    select 'refund', r.id::text, r.return_number, r.return_date,
           r.refund_method, r.refund_amount, r.refund_reference,
           r.created_by_name, coalesce(r.customer_name, 'Walk-in'),
           'Sales return ' || r.sale_number
    from public.sales_returns r
    where v_can_view_sales and r.refund_amount > 0
    union all
    select 'expense', ex.id::text, ex.expense_number, ex.created_at,
           ex.method, ex.amount, null, ex.created_by_name,
           ex.category_name, ex.description
    from public.expenses ex
    where v_can_view_exp and ex.status <> 'CANCELLED'
  ),
  f as (
    select * from src
    where (p_source is null or source = p_source)
      and (p_method is null or method = p_method)
      and (p_date_from is null or entry_at >= (p_date_from::timestamptz))
      and (p_date_to is null or entry_at < ((p_date_to + 1)::timestamptz))
      and (p_min is null or amount >= p_min)
      and (p_max is null or amount <= p_max)
      and (nullif(trim(coalesce(p_search, '')), '') is null
           or doc_number ILIKE '%' || trim(p_search) || '%'
           or party_name ILIKE '%' || trim(p_search) || '%'
           or user_name ILIKE '%' || trim(p_search) || '%'
           or source_id ILIKE '%' || trim(p_search) || '%')
  )
  select
    (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select source, source_id, doc_number, entry_at, method, amount,
             reference, user_name, party_name, notes
      from f order by entry_at desc, doc_number desc
      limit p_limit offset p_offset
    ) t),
    (select count(*) from f)
  into v_rows, v_total;

  return jsonb_build_object('rows', v_rows, 'total', v_total);
end $$;

revoke all on function public.payments_page(text, text, text, date, date, numeric, numeric, int, int) from public, anon;
grant execute on function public.payments_page(text, text, text, date, date, numeric, numeric, int, int) to authenticated, service_role;

commit;

-- ---------------------------------------------------------------------------
-- PART 36 — table grants + RLS (0002/0008 conventions: writes through the
-- RPCs; direct writes denied; directory tables writable under their own
-- permission + audited by trigger).
-- ---------------------------------------------------------------------------
begin;

revoke all on public.suppliers, public.purchase_orders, public.purchase_order_items,
  public.purchase_invoices, public.purchase_invoice_items,
  public.customer_payments, public.customer_payment_allocations,
  public.supplier_payments, public.supplier_payment_allocations,
  public.sales_returns, public.sales_return_items,
  public.purchase_returns, public.purchase_return_items,
  public.exchanges, public.exchange_items_in, public.exchange_items_out,
  public.expense_categories, public.expenses
from public, anon;

-- suppliers: direct CRUD for manage_suppliers holders (audited by trigger)
grant select, insert, update on public.suppliers to authenticated;
grant select, insert, update on public.suppliers to service_role;

-- read-only surfaces (writes live inside the SECURITY DEFINER RPCs only)
grant select on public.purchase_orders, public.purchase_order_items,
  public.purchase_invoices, public.purchase_invoice_items,
  public.purchase_returns, public.purchase_return_items to authenticated;
grant select on public.purchase_orders, public.purchase_order_items,
  public.purchase_invoices, public.purchase_invoice_items,
  public.purchase_returns, public.purchase_return_items to service_role;

grant select on public.customer_payments, public.customer_payment_allocations to authenticated;
grant select on public.customer_payments, public.customer_payment_allocations to service_role;

grant select on public.supplier_payments, public.supplier_payment_allocations to authenticated;
grant select on public.supplier_payments, public.supplier_payment_allocations to service_role;

grant select on public.sales_returns, public.sales_return_items to authenticated;
grant select on public.sales_returns, public.sales_return_items to service_role;

grant select on public.exchanges, public.exchange_items_in, public.exchange_items_out to authenticated;
grant select on public.exchanges, public.exchange_items_in, public.exchange_items_out to service_role;

grant select, insert, update on public.expense_categories to authenticated;
grant select, insert, update on public.expense_categories to service_role;

grant select, insert, update on public.expenses to authenticated;
grant select, insert, update on public.expenses to service_role;

-- ---- enable RLS -----------------------------------------------------------
alter table public.suppliers                     enable row level security;
alter table public.purchase_orders               enable row level security;
alter table public.purchase_order_items          enable row level security;
alter table public.purchase_invoices             enable row level security;
alter table public.purchase_invoice_items        enable row level security;
alter table public.customer_payments             enable row level security;
alter table public.customer_payment_allocations  enable row level security;
alter table public.supplier_payments             enable row level security;
alter table public.supplier_payment_allocations  enable row level security;
alter table public.sales_returns                 enable row level security;
alter table public.sales_return_items            enable row level security;
alter table public.purchase_returns              enable row level security;
alter table public.purchase_return_items         enable row level security;
alter table public.exchanges                     enable row level security;
alter table public.exchange_items_in             enable row level security;
alter table public.exchange_items_out            enable row level security;
alter table public.expense_categories            enable row level security;
alter table public.expenses                      enable row level security;

-- ---- suppliers: manage_suppliers CRUD --------------------------------------
drop policy if exists suppliers_select_mgr on public.suppliers;
drop policy if exists suppliers_insert_mgr on public.suppliers;
drop policy if exists suppliers_update_mgr on public.suppliers;

create policy suppliers_select_mgr
  on public.suppliers for select to authenticated
  using (public.has_app_permission('manage_suppliers')
         or public.has_app_permission('view_purchases')
         or public.has_app_permission('record_supplier_payment'));

create policy suppliers_insert_mgr
  on public.suppliers for insert to authenticated
  with check (public.has_app_permission('manage_suppliers'));

create policy suppliers_update_mgr
  on public.suppliers for update to authenticated
  using (public.has_app_permission('manage_suppliers'))
  with check (public.has_app_permission('manage_suppliers'));

-- ---- purchase documents: read for purchase viewers, NO write policies ------
drop policy if exists purchase_orders_select_staff   on public.purchase_orders;
drop policy if exists purchase_order_items_select_staff on public.purchase_order_items;
drop policy if exists purchase_invoices_select_staff on public.purchase_invoices;
drop policy if exists purchase_invoice_items_select_staff on public.purchase_invoice_items;
drop policy if exists purchase_returns_select_staff  on public.purchase_returns;
drop policy if exists purchase_return_items_select_staff on public.purchase_return_items;

create policy purchase_orders_select_staff
  on public.purchase_orders for select to authenticated
  using (public.has_app_permission('manage_purchases')
         or public.has_app_permission('view_purchases'));
create policy purchase_order_items_select_staff
  on public.purchase_order_items for select to authenticated
  using (public.has_app_permission('manage_purchases')
         or public.has_app_permission('view_purchases'));
create policy purchase_invoices_select_staff
  on public.purchase_invoices for select to authenticated
  using (public.has_app_permission('manage_purchases')
         or public.has_app_permission('view_purchases')
         or public.has_app_permission('record_supplier_payment'));
create policy purchase_invoice_items_select_staff
  on public.purchase_invoice_items for select to authenticated
  using (public.has_app_permission('manage_purchases')
         or public.has_app_permission('view_purchases')
         or public.has_app_permission('record_supplier_payment'));
create policy purchase_returns_select_staff
  on public.purchase_returns for select to authenticated
  using (public.has_app_permission('manage_purchases')
         or public.has_app_permission('view_purchases'));
create policy purchase_return_items_select_staff
  on public.purchase_return_items for select to authenticated
  using (public.has_app_permission('manage_purchases')
         or public.has_app_permission('view_purchases'));

-- ---- payments: read-only, no direct write path -----------------------------
drop policy if exists customer_payments_select_staff on public.customer_payments;
drop policy if exists customer_payment_allocations_select_staff on public.customer_payment_allocations;
drop policy if exists supplier_payments_select_staff on public.supplier_payments;
drop policy if exists supplier_payment_allocations_select_staff on public.supplier_payment_allocations;

create policy customer_payments_select_staff
  on public.customer_payments for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('manage_customers')
         or public.has_app_permission('record_customer_payment'));
create policy customer_payment_allocations_select_staff
  on public.customer_payment_allocations for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('manage_customers')
         or public.has_app_permission('record_customer_payment'));
create policy supplier_payments_select_staff
  on public.supplier_payments for select to authenticated
  using (public.has_app_permission('view_purchases')
         or public.has_app_permission('manage_suppliers')
         or public.has_app_permission('record_supplier_payment'));
create policy supplier_payment_allocations_select_staff
  on public.supplier_payment_allocations for select to authenticated
  using (public.has_app_permission('view_purchases')
         or public.has_app_permission('manage_suppliers')
         or public.has_app_permission('record_supplier_payment'));

-- ---- sales returns / exchanges: read-only through API ----------------------
drop policy if exists sales_returns_select_staff  on public.sales_returns;
drop policy if exists sales_return_items_select_staff on public.sales_return_items;
drop policy if exists exchanges_select_staff     on public.exchanges;
drop policy if exists exchange_items_in_select_staff on public.exchange_items_in;
drop policy if exists exchange_items_out_select_staff on public.exchange_items_out;

create policy sales_returns_select_staff
  on public.sales_returns for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('process_return')
         or public.has_app_permission('create_sale'));
create policy sales_return_items_select_staff
  on public.sales_return_items for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('process_return')
         or public.has_app_permission('create_sale'));
create policy exchanges_select_staff
  on public.exchanges for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('process_return')
         or public.has_app_permission('create_sale'));
create policy exchange_items_in_select_staff
  on public.exchange_items_in for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('process_return')
         or public.has_app_permission('create_sale'));
create policy exchange_items_out_select_staff
  on public.exchange_items_out for select to authenticated
  using (public.has_app_permission('view_sales')
         or public.has_app_permission('process_return')
         or public.has_app_permission('create_sale'));

-- ---- expense categories: everyone reads; admins (manage_settings) write ----
drop policy if exists expense_categories_select_all on public.expense_categories;
drop policy if exists expense_categories_insert_settings on public.expense_categories;
drop policy if exists expense_categories_update_settings on public.expense_categories;

create policy expense_categories_select_all
  on public.expense_categories for select to authenticated
  using (true);
create policy expense_categories_insert_settings
  on public.expense_categories for insert to authenticated
  with check (public.has_app_permission('manage_settings'));
create policy expense_categories_update_settings
  on public.expense_categories for update to authenticated
  using (public.has_app_permission('manage_settings'))
  with check (public.has_app_permission('manage_settings'));

-- ---- expenses: manage_expenses read + update; create/cancel via RPC --------
drop policy if exists expenses_select_mgr on public.expenses;
drop policy if exists expenses_update_mgr on public.expenses;

create policy expenses_select_mgr
  on public.expenses for select to authenticated
  using (public.has_app_permission('manage_expenses'));
create policy expenses_update_mgr
  on public.expenses for update to authenticated
  using (public.has_app_permission('manage_expenses'))
  with check (public.has_app_permission('manage_expenses'));

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (informational)
-- ---------------------------------------------------------------------------
select 'phase 4 objects created' as status,
       (select count(*) from public.suppliers)            as suppliers,
       (select count(*) from public.purchase_orders)      as purchase_orders,
       (select count(*) from public.purchase_invoices)    as purchase_invoices,
       (select count(*) from public.customer_payments)    as customer_payments,
       (select count(*) from public.sales_returns)        as sales_returns,
       (select count(*) from public.exchanges)            as exchanges,
       (select count(*) from public.expenses)             as expenses,
       (select count(*) from public.expense_categories)   as expense_categories,
       (select count(*) from public.stock_locations where location_type = 'damaged') as damaged_locations,
       (select count(*) from public.role_permissions
        where permission in ('view_purchases','record_customer_payment','record_supplier_payment',
                             'approve_expense','approve_return')) as new_permissions;
