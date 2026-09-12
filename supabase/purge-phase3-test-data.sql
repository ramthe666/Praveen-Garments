-- ============================================================================
-- Phase 3 TEST DATA PURGE — removes every artifact created during the
-- Phase 3 cloud E2E verification round (2026-09-12), i.e. data created by the
-- two test accounts below. It NEVER touches real data:
--   * your own sale INV-2026-000002 (cashier "Praveen (Owner)") is kept,
--   * Phase 2 P2TEST catalog/stock is kept (use purge-phase2-test-data.sql
--     for those, in the Supabase SQL Editor, order does not matter),
--   * sale_number_counters is intentionally left as-is — the numbering
--     stays continuous behind your real sale.
--
-- WHY THIS EXISTS: stock_movements is append-only (a guard trigger blocks
-- UPDATE/DELETE for everyone, by design), so test rows cannot be removed
-- with plain DELETEs. This snippet temporarily disables the guard trigger,
-- removes the Phase 3 test rows and re-enables the guard. Run it in the
-- Supabase SQL Editor ONLY when you want a clean slate — it is safe to skip
-- entirely (every test row is clearly labelled and harmless).
--
-- Expected counts from the verification round: 2 test users, 3 test sales
-- (INV-2026-000001 cancelled, 000003 concurrency winner, 000004 split
-- payment), 3 held bills, 1 test customer ("Ravi Kumar"), ~6 ledger
-- movements, ~15 audit rows.
-- ============================================================================

begin;

-- 1. temporarily lift the append-only guard ---------------------------------
alter table public.stock_movements disable trigger stock_movements_append_only;

-- 2. the Phase 3 test sales (items + payments first: both RESTRICT the sale)
delete from public.sale_items
where sale_id in (
  select id from public.sales
  where cashier_email in ('pg-phase3-test@praveengarments.com',
                          'pg-phase3-cashier@praveengarments.com')
);
delete from public.sale_payments
where sale_id in (
  select id from public.sales
  where cashier_email in ('pg-phase3-test@praveengarments.com',
                          'pg-phase3-cashier@praveengarments.com')
);
delete from public.sales
where cashier_email in ('pg-phase3-test@praveengarments.com',
                        'pg-phase3-cashier@praveengarments.com');

-- 3. held bills from the test round (also cascade with the users below)
delete from public.held_bills
where cashier_id in (
  select id from auth.users
  where email in ('pg-phase3-test@praveengarments.com',
                  'pg-phase3-cashier@praveengarments.com')
);

-- 4. ledger movements produced by the test round (sales are already gone,
--    so match on the documented reasons / references of this round)
delete from public.stock_movements
where reason like 'P3 %'
   or reason like 'Sale INV-2026-%' and reference_id not in (
        -- keep movements of sales that still exist (i.e. your real sale)
        select id from public.sales
      );

-- 5. the E2E test customer (only if no remaining sale references her)
delete from public.customers c
where c.phone = '9876543210' and c.name = 'Ravi Kumar'
  and not exists (select 1 from public.sales s where s.customer_id = c.id);

-- 6. audit rows produced by the test round (explicit test sale numbers ONLY —
--    INV-2026-000002 is your real sale and its audit rows are kept)
delete from public.audit_logs
where user_email in ('pg-phase3-test@praveengarments.com',
                     'pg-phase3-cashier@praveengarments.com')
   or metadata::text like '%INV-2026-000001%'
   or metadata::text like '%INV-2026-000003%'
   or metadata::text like '%INV-2026-000004%'
   or (entity_type = 'customer' and new_values::text like '%Ravi Kumar%');

-- 7. the two test accounts (profiles cascade)
delete from auth.users
where email in ('pg-phase3-test@praveengarments.com',
                'pg-phase3-cashier@praveengarments.com');

-- 8. restore the guard -------------------------------------------------------
alter table public.stock_movements enable trigger stock_movements_append_only;

-- 9. report what is left
select
  (select count(*) from public.sales)       as sales_left,
  (select count(*) from public.customers)   as customers_left,
  (select count(*) from public.held_bills)  as held_bills_left,
  (select count(*) from public.stock_movements) as movements_left,
  (select count(*) from auth.users)         as auth_users_left;

commit;
