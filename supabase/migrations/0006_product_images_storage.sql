-- ============================================================================
-- PRAVEEN GARMENTS — Phase 2: Product Images Storage
-- Migration 0006: "product-images" bucket + object policies
--
-- Apply AFTER 0005.
-- Bucket is PUBLIC-read (product images appear on invoices, labels and the
-- POS — not sensitive) but writes require manage_products (Admin /
-- Inventory Manager). 2 MB + image mime whitelist; SVG deliberately excluded
-- (stored-XSS vector when served from a public bucket).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
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

-- Public read (bucket is public; policy also allows authenticated listing)
drop policy if exists product_images_public_read on storage.objects;
create policy product_images_public_read
  on storage.objects for select
  using (bucket_id = 'product-images');

-- Upload restricted to manage_products holders
drop policy if exists product_images_insert_products on storage.objects;
create policy product_images_insert_products
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and public.has_app_permission('manage_products')
  );

-- Replace restricted to manage_products holders
drop policy if exists product_images_update_products on storage.objects;
create policy product_images_update_products
  on storage.objects for update to authenticated
  using (
    bucket_id = 'product-images'
    and public.has_app_permission('manage_products')
  )
  with check (
    bucket_id = 'product-images'
    and public.has_app_permission('manage_products')
  );

-- Delete restricted to manage_products holders
drop policy if exists product_images_delete_products on storage.objects;
create policy product_images_delete_products
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-images'
    and public.has_app_permission('manage_products')
  );

commit;

-- Verification (informational)
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'product-images';
