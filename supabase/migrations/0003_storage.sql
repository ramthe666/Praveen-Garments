-- ============================================================================
-- PRAVEEN GARMENTS — Phase 1 Foundation
-- Migration 0003: Storage bucket + object policies (company logo)
--
-- Apply AFTER 0002.
-- Bucket "company-assets" is PUBLIC-read (logos are displayed on invoices and
-- the login screen; not sensitive) but writes require manage_settings.
-- Uploads limited to 2 MB and image mime types; SVG is deliberately excluded
-- (stored-XSS vector when served from a public bucket).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'company-assets',
  'company-assets',
  true,
  2097152, -- 2 MB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public              = true,
      file_size_limit     = 2097152,
      allowed_mime_types  = array['image/png', 'image/jpeg', 'image/webp'];

-- ---------------------------------------------------------------------------
-- 2. Object policies
-- ---------------------------------------------------------------------------

-- Public read (the bucket is public; this policy also lets authenticated
-- users list/select objects through the API)
drop policy if exists company_assets_public_read  on storage.objects;
create policy company_assets_public_read
  on storage.objects for select
  using (bucket_id = 'company-assets');

-- Upload restricted to manage_settings (Admin)
drop policy if exists company_assets_insert_admin on storage.objects;
create policy company_assets_insert_admin
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'company-assets'
    and public.has_app_permission('manage_settings')
  );

-- Replace restricted to manage_settings (Admin)
drop policy if exists company_assets_update_admin on storage.objects;
create policy company_assets_update_admin
  on storage.objects for update to authenticated
  using (
    bucket_id = 'company-assets'
    and public.has_app_permission('manage_settings')
  )
  with check (
    bucket_id = 'company-assets'
    and public.has_app_permission('manage_settings')
  );

-- Delete restricted to manage_settings (Admin)
drop policy if exists company_assets_delete_admin on storage.objects;
create policy company_assets_delete_admin
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'company-assets'
    and public.has_app_permission('manage_settings')
  );

commit;

-- Verification (informational)
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'company-assets';
