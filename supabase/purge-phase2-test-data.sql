-- ============================================================================
-- Phase 2 TEST DATA PURGE — removes every "P2TEST" artifact created during
-- the automated verification rounds (2026-09-11).
--
-- WHY THIS EXISTS: stock_movements is append-only (a guard trigger blocks
-- UPDATE/DELETE for everyone, by design) and movement rows RESTRICT variant/
-- location deletion, so test data cannot be removed with plain DELETEs.
-- This snippet temporarily disables the two guard triggers, removes the test
-- rows, and re-enables the guards. Run it in the Supabase SQL Editor ONLY
-- when you want a clean slate — it is safe to skip entirely (the test rows
-- are clearly labelled "P2TEST" and are harmless).
--
-- Expected counts from the test round: 2-3 products, ~6 variants,
-- 2 categories + 2-3 audit-check categories, 1 brand, 1 size, 1 color,
-- 1 location (P2TWH), ~13 movements, 2 balances, 2 test users, ~40 audit rows.
-- ============================================================================

begin;

-- 1. temporarily lift the append-only guards -------------------------------
alter table public.stock_movements disable trigger stock_movements_append_only;
alter table public.stock_balances   disable trigger stock_balances_engine_guard;

-- 2. test products (variants cascade; balances/movements removed explicitly)
delete from public.stock_movements
where variant_id in (
  select id from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where p.name like 'P2TEST%' or p.product_code like 'P2T-%'
);
delete from public.stock_balances
where variant_id in (
  select id from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where p.name like 'P2TEST%' or p.product_code like 'P2T-%'
);
delete from public.products where name like 'P2TEST%' or product_code like 'P2T-%';

-- 3. test catalog attributes
delete from public.categories where name like 'P2TEST%' or name like 'PROBE-direct-%';
delete from public.brands     where name like 'P2TEST%';
delete from public.sizes      where name like 'P2TEST%';
delete from public.colors     where name like 'P2TEST%';

-- 4. test stock location (movements referencing it are already gone)
delete from public.stock_locations where code = 'P2TWH';

-- 5. test users (profiles cascade; movements already deleted above)
delete from auth.users where email in (
  'pg-phase1-test@praveengarments.com',
  'pg-phase2-mgr@praveengarments.com'
);

-- 6. audit rows produced by the test round
delete from public.audit_logs where user_email in (
  'pg-phase1-test@praveengarments.com',
  'pg-phase2-mgr@praveengarments.com'
);
delete from public.audit_logs
where entity_type in ('products','product_variants','categories','brands','sizes','colors','stock_balances','stock_movement','label_print')
  and (new_values::text like '%P2TEST%' or old_values::text like '%P2TEST%'
       or metadata::text like '%P2TEST%' or entity_id in (
         select id::text from public.products where name like 'P2TEST%'
       ));

-- 7. restore the guards -----------------------------------------------------
alter table public.stock_movements enable trigger stock_movements_append_only;
alter table public.stock_balances   enable trigger stock_balances_engine_guard;

-- 8. report what is left
select
  (select count(*) from public.products)        as products_left,
  (select count(*) from public.categories)      as categories_left,
  (select count(*) from public.stock_movements) as movements_left,
  (select count(*) from public.stock_locations) as locations_left;

commit;
