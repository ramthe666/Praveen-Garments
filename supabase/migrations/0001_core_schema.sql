-- ============================================================================
-- PRAVEEN GARMENTS — Phase 1 Foundation
-- Migration 0001: Core schema (enums, tables, indexes, functions, triggers, seed)
--
-- Apply order: 0001 → 0002 → 0003
-- Safe, non-destructive: uses CREATE IF NOT EXISTS patterns where possible.
-- NOTE: This file creates tables with RLS ENABLED but policies are defined in
-- 0002. Until 0002 is applied, no API access is possible (secure by default).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. ENUM TYPES
-- ---------------------------------------------------------------------------

-- Staff roles (private app — no public signup; users created by Admin only)
do $$ begin
  create type public.user_role as enum (
    'admin', 'manager', 'cashier', 'inventory_manager', 'purchase_manager', 'accountant'
  );
exception when duplicate_object then null; end $$;

-- Application permissions (scalable permission catalogue)
do $$ begin
  create type public.app_permission as enum (
    'view_dashboard', 'manage_products', 'view_inventory', 'manage_inventory',
    'create_sale', 'cancel_sale', 'process_return', 'manage_purchases',
    'manage_customers', 'manage_suppliers', 'manage_expenses', 'view_reports',
    'manage_users', 'manage_settings', 'view_audit_logs'
  );
exception when duplicate_object then null; end $$;

-- Audit actions (foundation covering future modules)
do $$ begin
  create type public.audit_action as enum (
    'login', 'logout', 'login_failed',
    'user_created', 'user_updated', 'user_deleted', 'user_disabled', 'user_enabled',
    'role_changed', 'permission_changed',
    'settings_changed',
    'branch_created', 'branch_updated', 'branch_deleted',
    'product_created', 'product_updated', 'product_deleted', 'price_changed', 'stock_changed',
    'sale_created', 'sale_cancelled', 'return_processed', 'refund_issued',
    'purchase_created', 'purchase_updated'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. BRANCHES (foundation for future multi-store; single store today)
-- ---------------------------------------------------------------------------
create table if not exists public.branches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  code        text not null check (length(trim(code)) between 1 and 10),
  address     text,
  city        text,
  state       text,
  pincode     text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  phone       text,
  email       text check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint branches_code_key unique (code)
);

create index if not exists branches_active_idx on public.branches (is_active);

-- ---------------------------------------------------------------------------
-- 3. PROFILES (one row per auth user; roles & status live here)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null default '',
  full_name     text not null default '' check (length(full_name) <= 120),
  phone         text,
  role          public.user_role not null default 'cashier',
  branch_id     uuid references public.branches (id) on delete set null,
  is_active     boolean not null default true,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists profiles_email_key on public.profiles (lower(email)) where email <> '';
create index if not exists profiles_role_idx     on public.profiles (role);
create index if not exists profiles_active_idx   on public.profiles (is_active) where is_active = false;
create index if not exists profiles_branch_idx   on public.profiles (branch_id);
create index if not exists profiles_created_idx  on public.profiles (created_at desc);

-- ---------------------------------------------------------------------------
-- 4. ROLE PERMISSIONS (role -> permission matrix, admin-editable later)
-- ---------------------------------------------------------------------------
create table if not exists public.role_permissions (
  role        public.user_role not null,
  permission  public.app_permission not null,
  created_at  timestamptz not null default now(),
  primary key (role, permission)
);

-- Seed the default matrix
insert into public.role_permissions (role, permission)
values
  -- ADMIN: full access
  ('admin','view_dashboard'), ('admin','manage_products'), ('admin','view_inventory'),
  ('admin','manage_inventory'), ('admin','create_sale'), ('admin','cancel_sale'),
  ('admin','process_return'), ('admin','manage_purchases'), ('admin','manage_customers'),
  ('admin','manage_suppliers'), ('admin','manage_expenses'), ('admin','view_reports'),
  ('admin','manage_users'), ('admin','manage_settings'), ('admin','view_audit_logs'),
  -- MANAGER: operations + reports
  ('manager','view_dashboard'), ('manager','view_inventory'), ('manager','manage_inventory'),
  ('manager','create_sale'), ('manager','cancel_sale'), ('manager','process_return'),
  ('manager','manage_purchases'), ('manager','manage_customers'), ('manager','manage_suppliers'),
  ('manager','manage_expenses'), ('manager','view_reports'),
  -- CASHIER: POS-focused
  ('cashier','view_dashboard'), ('cashier','create_sale'), ('cashier','view_inventory'),
  ('cashier','manage_customers'),
  -- INVENTORY MANAGER: stock-focused
  ('inventory_manager','view_dashboard'), ('inventory_manager','manage_products'),
  ('inventory_manager','view_inventory'), ('inventory_manager','manage_inventory'),
  -- PURCHASE MANAGER: procurement-focused
  ('purchase_manager','view_dashboard'), ('purchase_manager','view_inventory'),
  ('purchase_manager','manage_purchases'), ('purchase_manager','manage_suppliers'),
  -- ACCOUNTANT: finance-focused
  ('accountant','view_dashboard'), ('accountant','view_reports'), ('accountant','manage_expenses')
on conflict (role, permission) do nothing;

-- ---------------------------------------------------------------------------
-- 5. COMPANY SETTINGS (single row; UI must read from here, never hardcode)
-- ---------------------------------------------------------------------------
create table if not exists public.company_settings (
  id              integer primary key generated always as identity check (id = 1),
  company_name    text not null default 'Praveen Garments' check (length(trim(company_name)) between 1 and 160),
  logo_url        text,
  phone           text,
  email           text check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  address         text,
  city            text,
  state           text,
  pincode         text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  gstin           text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  invoice_prefix  text not null default 'INV' check (length(trim(invoice_prefix)) between 1 and 12),
  currency        text not null default 'INR',
  timezone        text not null default 'Asia/Kolkata',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null
);

insert into public.company_settings (company_name)
select 'Praveen Garments'
where not exists (select 1 from public.company_settings);

-- ---------------------------------------------------------------------------
-- 6. APP SETTINGS (namespaced key/value JSONB — business rules live in DB)
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);

insert into public.app_settings (key, value) values
  ('invoice', '{
    "prefix": "INV", "next_number": 1, "show_logo": true,
    "default_terms": "Goods once sold will only be exchanged within the return window with the original bill.",
    "footer_note": "Thank you for shopping with us!"
  }'::jsonb),
  ('pos', '{
    "require_customer": false, "allow_price_edit": false,
    "default_payment_method": "Cash", "round_off": true,
    "bill_footer_note": "Thank you for shopping with us!"
  }'::jsonb),
  ('tax', '{
    "enabled": true, "default_rate": 5,
    "intra_state_label": "CGST + SGST", "inter_state_label": "IGST"
  }'::jsonb),
  ('inventory', '{
    "low_stock_threshold": 10, "allow_negative_stock": false,
    "costing_method": "average"
  }'::jsonb),
  ('barcode', '{
    "format": "CODE128", "auto_generate": true, "print_size": "50x25"
  }'::jsonb),
  ('qr', '{
    "enabled": true, "size": "medium"
  }'::jsonb),
  ('payments', '{
    "methods": ["Cash", "UPI", "Card", "Bank Transfer"]
  }'::jsonb),
  ('returns', '{
    "window_days": 7, "require_invoice": true, "restock_items": true
  }'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 7. AUDIT LOGS (append-only event history; designed for very large volume)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users (id) on delete set null,
  user_email  text,
  action      public.audit_action not null,
  entity_type text,
  entity_id   text,
  old_values  jsonb,
  new_values  jsonb,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_user_created_idx on public.audit_logs (user_id, created_at desc);
create index if not exists audit_logs_action_idx       on public.audit_logs (action);
create index if not exists audit_logs_entity_idx       on public.audit_logs (entity_type, entity_id);
create index if not exists audit_logs_created_idx      on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- 8. HELPER FUNCTIONS
-- ---------------------------------------------------------------------------

-- Generic updated_at maintainer
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Current caller's role (null when not signed in)
create or replace function public.get_my_role()
returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Is the caller an active admin?
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'admin' from public.profiles p where p.id = auth.uid() and p.is_active), false);
$$;

-- Permission check used by RLS policies and the API (DB-side authorization)
create or replace function public.has_app_permission(p public.app_permission)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select true
    from public.profiles pr
    join public.role_permissions rp on rp.role = pr.role
    where pr.id = auth.uid()
      and pr.is_active
      and rp.permission = p
  ), false);
$$;

-- Login-page branding readable before sign-in (company name + logo only —
-- nothing sensitive). Returns jsonb; falls back to defaults when unset.
create or replace function public.get_public_branding()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'company_name', coalesce((select cs.company_name from public.company_settings cs limit 1), 'Praveen Garments'),
    'logo_url',     (select cs.logo_url from public.company_settings cs limit 1)
  );
$$;
revoke all on function public.get_public_branding() from public;
grant execute on function public.get_public_branding() to anon, authenticated;

-- Touch caller's last_login_at (bypasses profiles UPDATE policy safely)
create or replace function public.touch_my_last_login()
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set last_login_at = now() where id = auth.uid() and is_active;
end $$;
revoke all on function public.touch_my_last_login() from public, anon;
grant execute on function public.touch_my_last_login() to authenticated;

-- Log an auth event (login / logout) as the calling user
create or replace function public.log_auth_event(p_action public.audit_action, p_meta jsonb default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_action not in ('login','logout','login_failed') then
    raise exception 'log_auth_event only accepts auth actions';
  end if;
  insert into public.audit_logs (user_id, user_email, action, entity_type, metadata)
  values (auth.uid(), null, p_action, 'auth', p_meta);
end $$;
revoke all on function public.log_auth_event(public.audit_action, jsonb) from public, anon;
grant execute on function public.log_auth_event(public.audit_action, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. TRIGGERS
-- ---------------------------------------------------------------------------

-- updated_at maintenance
create trigger branches_set_updated_at
  before update on public.branches
  for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger company_settings_set_updated_at
  before update on public.company_settings
  for each row execute function public.set_updated_at();

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- Auto-create a profile whenever an auth user is created (dashboard/API/admin).
-- Role is taken from raw_user_meta_data.app_role when valid, else 'cashier'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role public.user_role := 'cashier';
  v_requested text;
begin
  v_requested := lower(coalesce(new.raw_user_meta_data ->> 'app_role', ''));
  if v_requested in ('admin','manager','cashier','inventory_manager','purchase_manager','accountant') then
    v_role := v_requested::public.user_role;
  end if;

  insert into public.profiles (id, email, full_name, role, is_active)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    coalesce(
      nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
      initcap(split_part(coalesce(new.email, 'user'), '@', 1))
    ),
    v_role,
    true
  )
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any auth users that already exist.
-- The EARLIEST created user becomes admin (bootstrap owner); others 'cashier'.
insert into public.profiles (id, email, full_name, role)
select
  u.id,
  lower(coalesce(u.email, '')),
  coalesce(
    nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), ''),
    initcap(split_part(coalesce(u.email, 'user'), '@', 1))
  ),
  case when row_number() over (order by u.created_at) = 1 then 'admin' else 'cashier' end::public.user_role
from auth.users u
on conflict (id) do nothing;

-- Audit trail for settings / branch / profile row changes.
-- Skips no-op updates and volatile-only changes (updated_at, last_login_at).
create or replace function public.audit_row_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_action public.audit_action;
  v_entity text := tg_table_name;
begin
  if tg_op = 'INSERT' then
    v_action := case tg_table_name
      when 'branches'          then 'branch_created'
      when 'profiles'          then 'user_created'
      else 'settings_changed'
    end::public.audit_action;
    insert into public.audit_logs (user_id, user_email, action, entity_type, entity_id, new_values)
    values (
      auth.uid(),
      case when tg_table_name = 'profiles' then new.email else null end,
      v_action, v_entity, new.id::text,
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
      case when tg_table_name = 'profiles' then new.email else null end,
      v_action, v_entity, new.id::text,
      to_jsonb(old) - 'created_at' - 'updated_at' - 'last_login_at',
      to_jsonb(new) - 'created_at' - 'updated_at' - 'last_login_at'
    );
  end if;
  return coalesce(new, old);
end $$;

create trigger branches_audit
  after insert or update on public.branches
  for each row execute function public.audit_row_change();

create trigger company_settings_audit
  after insert or update on public.company_settings
  for each row execute function public.audit_row_change();

create trigger app_settings_audit
  after insert or update on public.app_settings
  for each row execute function public.audit_row_change();

create trigger profiles_audit
  after insert or update on public.profiles
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------------
-- 10. GRANTS (API surface via PostgREST roles)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant usage on schema public to anon, authenticated;
grant select on public.company_settings to authenticated;
grant select on public.app_settings to authenticated;
grant select on public.branches to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.role_permissions to authenticated;
grant insert on public.audit_logs to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Enable RLS immediately (secure-by-default; policies arrive in 0002)
-- ---------------------------------------------------------------------------
alter table public.branches          enable row level security;
alter table public.profiles          enable row level security;
alter table public.role_permissions  enable row level security;
alter table public.company_settings  enable row level security;
alter table public.app_settings      enable row level security;
alter table public.audit_logs        enable row level security;

commit;

-- Verification (informational):
select 'tables created' as status,
       (select count(*) from public.branches)          as branches,
       (select count(*) from public.profiles)          as profiles,
       (select count(*) from public.role_permissions)  as role_permissions,
       (select count(*) from public.company_settings)  as company_settings,
       (select count(*) from public.app_settings)      as app_settings;
