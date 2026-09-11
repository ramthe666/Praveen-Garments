-- ============================================================================
-- PRAVEEN GARMENTS — Phase 1 Foundation
-- Migration 0002: Row Level Security policies (database-side authorization)
--
-- Apply AFTER 0001. Idempotent: drops existing policies first, recreates them.
-- Authorization model:
--   * every read/write is denied unless a policy explicitly allows it
--   * privileged operations require public.has_app_permission(...) which
--     checks the caller's active profile role against role_permissions
--   * security-definer helper functions are owned by postgres and bypass RLS
--     internally, so policy evaluation never recurses
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- BRANCHES: all staff can read; only manage_settings (Admin) can write
-- ---------------------------------------------------------------------------
drop policy if exists branches_select_all      on public.branches;
drop policy if exists branches_insert_settings on public.branches;
drop policy if exists branches_update_settings on public.branches;
drop policy if exists branches_delete_settings on public.branches;

create policy branches_select_all
  on public.branches for select to authenticated
  using (true);

create policy branches_insert_settings
  on public.branches for insert to authenticated
  with check (public.has_app_permission('manage_settings'));

create policy branches_update_settings
  on public.branches for update to authenticated
  using (public.has_app_permission('manage_settings'))
  with check (public.has_app_permission('manage_settings'));

create policy branches_delete_settings
  on public.branches for delete to authenticated
  using (public.has_app_permission('manage_settings'));

-- ---------------------------------------------------------------------------
-- PROFILES:
--   * every user can read their own profile (needed for role/permissions UI)
--   * manage_users holders (Admin) can read all profiles
--   * users cannot update their own profile through the API in Phase 1
--     (last_login_at is maintained by the security-definer RPC, not by the
--     client); all management goes through Admin or server routes
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_self   on public.profiles;
drop policy if exists profiles_select_admin  on public.profiles;
drop policy if exists profiles_insert_admin  on public.profiles;
drop policy if exists profiles_update_admin  on public.profiles;
drop policy if exists profiles_delete_admin  on public.profiles;

create policy profiles_select_self
  on public.profiles for select to authenticated
  using (id = auth.uid());

create policy profiles_select_admin
  on public.profiles for select to authenticated
  using (public.has_app_permission('manage_users'));

create policy profiles_insert_admin
  on public.profiles for insert to authenticated
  with check (public.has_app_permission('manage_users'));

create policy profiles_update_admin
  on public.profiles for update to authenticated
  using (public.has_app_permission('manage_users'))
  with check (public.has_app_permission('manage_users'));

create policy profiles_delete_admin
  on public.profiles for delete to authenticated
  using (public.has_app_permission('manage_users'));

-- ---------------------------------------------------------------------------
-- ROLE PERMISSIONS: readable by all authenticated (permission matrix UI);
-- writes arrive only via future migration / server routes (no policy = denied)
-- ---------------------------------------------------------------------------
drop policy if exists role_permissions_select_authenticated on public.role_permissions;

create policy role_permissions_select_authenticated
  on public.role_permissions for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- COMPANY SETTINGS: readable by all staff (branding, invoices);
-- update restricted to manage_settings (Admin). No insert/delete policies —
-- the single row is created by migration 0001 and cannot be removed via API.
-- ---------------------------------------------------------------------------
drop policy if exists company_settings_select_authenticated on public.company_settings;
drop policy if exists company_settings_update_settings      on public.company_settings;

create policy company_settings_select_authenticated
  on public.company_settings for select to authenticated
  using (true);

create policy company_settings_update_settings
  on public.company_settings for update to authenticated
  using (public.has_app_permission('manage_settings'))
  with check (public.has_app_permission('manage_settings'));

-- ---------------------------------------------------------------------------
-- APP SETTINGS: readable by all staff; upsert restricted to manage_settings
-- ---------------------------------------------------------------------------
drop policy if exists app_settings_select_authenticated on public.app_settings;
drop policy if exists app_settings_insert_settings      on public.app_settings;
drop policy if exists app_settings_update_settings      on public.app_settings;

create policy app_settings_select_authenticated
  on public.app_settings for select to authenticated
  using (true);

create policy app_settings_insert_settings
  on public.app_settings for insert to authenticated
  with check (public.has_app_permission('manage_settings'));

create policy app_settings_update_settings
  on public.app_settings for update to authenticated
  using (public.has_app_permission('manage_settings'))
  with check (public.has_app_permission('manage_settings'));

-- ---------------------------------------------------------------------------
-- AUDIT LOGS: append-only.
--   * inserts allowed only for the calling user's own events (login/logout)
--   * reads require view_audit_logs (Admin by default)
--   * no update/delete policies — history is immutable through the API
-- ---------------------------------------------------------------------------
drop policy if exists audit_logs_insert_self  on public.audit_logs;
drop policy if exists audit_logs_read_audited on public.audit_logs;

create policy audit_logs_insert_self
  on public.audit_logs for insert to authenticated
  with check (user_id = auth.uid());

create policy audit_logs_read_audited
  on public.audit_logs for select to authenticated
  using (public.has_app_permission('view_audit_logs'));

commit;

-- Verification (informational): lists active policies per table
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
