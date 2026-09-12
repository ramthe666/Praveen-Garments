-- ---------------------------------------------------------------------------
-- 0014_phase6_report_exchange_cash.sql
--
-- WHAT: Phase 6 audit finding — exchange money was asymmetric in the money
--       reports. Exchange REFUNDS (customer paid less on a swap) were counted
--       in payment_report.refunds and cash_report.cash_refunds, but exchange
--       COLLECTIONS (customer paid MORE on an upgrade swap) were NOT counted
--       in payment_report inflows or cash_report expected_cash. A day with
--       upgrade exchanges understated the drawer by exactly the collected
--       differences, so end-of-day cash reconciliation could never balance.
--
-- HOW:  CREATE OR REPLACE payment_report() and cash_report() with the SAME
--       signatures and permission gates:
--         * payment_report adds an `exchange_collections` section (per method)
--           and includes positive non-Store-Credit exchange differences in
--           `inflows` and `summary.total_inflow` (+ new summary key
--           `total_exchange_in`).
--         * cash_report adds `cash_exchange_in` (Cash differences collected
--           during the day), includes it in `total_in` / `expected_cash`, and
--           carries prior-day collections into `opening_cash`.
--       Everything else is byte-equivalent in behaviour. No tables, no data,
--       no new functions; existing callers keep working unchanged.
--
-- ORDER: Run AFTER 0013. Additive only — 0001-0013 are untouched.
-- ---------------------------------------------------------------------------

begin;

-- ===========================================================================
-- PART A — payment_report(): include exchange collections as money in
-- ===========================================================================

create or replace function public.payment_report(
  p_date_from date default null,
  p_date_to   date default null
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz       text;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
  v_from_date date;
  v_to_date  date;
  v_till     jsonb;
  v_receipts jsonb;
  v_exchange_in jsonb;
  v_inflows  jsonb;
  v_refunds  jsonb;
  v_expenses jsonb;
  v_supplier jsonb;
  v_total_in numeric := 0;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts   := coalesce(p_date_from, '1970-01-01'::date)::timestamp at time zone v_tz;
  v_to_ts     := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;
  v_from_date := coalesce(p_date_from, '1970-01-01'::date);
  v_to_date   := coalesce(p_date_to, (now() at time zone v_tz)::date);

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_till
  from (
    select sp.method, count(*) as count, round(sum(sp.amount), 2) as amount
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
    where s.status = 'COMPLETED'
      and sp.is_credit = false
      and sp.method <> 'Store Credit'
      and sp.created_at >= v_from_ts and sp.created_at < v_to_ts
      and not exists (select 1 from public.customer_payments cp
                      where cp.receipt_number = sp.reference)
    group by sp.method
    order by 3 desc
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_receipts
  from (
    select cp.method, count(*) as count, round(sum(cp.amount), 2) as amount
    from public.customer_payments cp
    where cp.method <> 'Store Credit'
      and cp.recorded_at >= v_from_ts and cp.recorded_at < v_to_ts
    group by cp.method
    order by 3 desc
  ) t;

  -- 0014: money COLLECTED on upgrade exchanges (positive differences)
  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_exchange_in
  from (
    select e.payment_method as method, count(*) as count, round(sum(e.difference_amount), 2) as amount
    from public.exchanges e
    where e.difference_amount > 0
      and e.payment_method is not null
      and e.payment_method <> 'Store Credit'
      and e.exchange_date >= v_from_ts and e.exchange_date < v_to_ts
    group by e.payment_method
    order by 3 desc
  ) t;

  select coalesce(round(sum((r ->> 'amount')::numeric), 2), 0) into v_total_in
  from jsonb_array_elements(v_till || v_receipts || v_exchange_in) r;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_inflows
  from (
    select method, sum(cnt) as count, round(sum(amt), 2) as amount,
           case when v_total_in > 0
                then round(100.0 * sum(amt) / v_total_in, 1)
                else 0 end as pct
    from (
      select method, count(*) as cnt, sum(amount) as amt
      from public.sale_payments sp
      join public.sales s on s.id = sp.sale_id
      where s.status = 'COMPLETED'
        and sp.is_credit = false
        and sp.method <> 'Store Credit'
        and sp.created_at >= v_from_ts and sp.created_at < v_to_ts
        and not exists (select 1 from public.customer_payments cp
                        where cp.receipt_number = sp.reference)
      group by sp.method
      union all
      select method, count(*), sum(amount)
      from public.customer_payments cp
      where cp.method <> 'Store Credit'
        and cp.recorded_at >= v_from_ts and cp.recorded_at < v_to_ts
      group by cp.method
      union all
      -- 0014: exchange collections count as money in
      select e.payment_method, count(*), sum(e.difference_amount)
      from public.exchanges e
      where e.difference_amount > 0
        and e.payment_method is not null
        and e.payment_method <> 'Store Credit'
        and e.exchange_date >= v_from_ts and e.exchange_date < v_to_ts
      group by e.payment_method
    ) u
    group by method
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_refunds
  from (
    select method, count(*) as count, round(sum(amt), 2) as amount
    from (
      select r.refund_method as method, r.refund_amount as amt
      from public.sales_returns r
      where r.refund_amount > 0
        and r.refund_method is not null
        and r.refund_method <> 'Store Credit'
        and r.return_date >= v_from_ts and r.return_date < v_to_ts
      union all
      select e.payment_method, -e.difference_amount
      from public.exchanges e
      where e.difference_amount < 0
        and e.payment_method is not null
        and e.payment_method <> 'Store Credit'
        and e.exchange_date >= v_from_ts and e.exchange_date < v_to_ts
    ) u
    group by method
    order by 3 desc
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_expenses
  from (
    select e.method, count(*) as count, round(sum(e.amount), 2) as amount
    from public.expenses e
    where e.status in ('PENDING', 'APPROVED')
      and e.expense_date >= v_from_date and e.expense_date <= v_to_date
    group by e.method
    order by 3 desc
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_supplier
  from (
    select sp.method, count(*) as count, round(sum(sp.amount), 2) as amount
    from public.supplier_payments sp
    where sp.recorded_at >= v_from_ts and sp.recorded_at < v_to_ts
    group by sp.method
    order by 3 desc
  ) t;

  return jsonb_build_object(
    'till', v_till,
    'receipts', v_receipts,
    'exchange_collections', v_exchange_in,
    'inflows', v_inflows,
    'refunds', v_refunds,
    'expenses', v_expenses,
    'supplier_payments', v_supplier,
    'summary', jsonb_build_object(
      'total_inflow',  v_total_in,
      'total_exchange_in', coalesce((select round(sum((r ->> 'amount')::numeric), 2)
                                      from jsonb_array_elements(v_exchange_in) r), 0),
      'total_refund',  coalesce((select round(sum((r ->> 'amount')::numeric), 2)
                                  from jsonb_array_elements(v_refunds) r), 0),
      'total_expense', coalesce((select round(sum((r ->> 'amount')::numeric), 2)
                                  from jsonb_array_elements(v_expenses) r), 0),
      'total_supplier',coalesce((select round(sum((r ->> 'amount')::numeric), 2)
                                  from jsonb_array_elements(v_supplier) r), 0),
      'store_credit_refunds', coalesce((
        select round(sum(r.refund_amount), 2)
        from public.sales_returns r
        where r.refund_method = 'Store Credit'
          and r.refund_amount > 0
          and r.return_date >= v_from_ts and r.return_date < v_to_ts), 0)
    )
  );
end $$;

revoke all on function public.payment_report(date, date) from public, anon;
grant execute on function public.payment_report(date, date) to authenticated, service_role;

commit;

begin;

-- ===========================================================================
-- PART B — cash_report(): carry exchange collections into the day's cash
-- ===========================================================================

create or replace function public.cash_report(
  p_date date default null
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz        text;
  v_day       date;
  v_start     timestamptz;
  v_end       timestamptz;
  v_opening   numeric := 0;
  v_sales     numeric := 0;
  v_receipts  numeric := 0;
  v_exch_in   numeric := 0;
  v_refunds   numeric := 0;
  v_expenses  numeric := 0;
  v_supplier  numeric := 0;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;

  v_tz    := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_day   := coalesce(p_date, (now() at time zone v_tz)::date);
  v_start := v_day::timestamp at time zone v_tz;
  v_end   := (v_day + 1)::timestamp at time zone v_tz;

  select
    coalesce((select sum(sp.amount)
              from public.sale_payments sp
              join public.sales s on s.id = sp.sale_id
              where s.status = 'COMPLETED'
                and sp.is_credit = false and sp.method = 'Cash'
                and sp.created_at < v_start
                and not exists (select 1 from public.customer_payments cp
                                where cp.receipt_number = sp.reference)), 0)
  + coalesce((select sum(cp.amount)
              from public.customer_payments cp
              where cp.method = 'Cash' and cp.recorded_at < v_start), 0)
  -- 0014: prior-day exchange collections were also physical drawer cash
  + coalesce((select sum(e.difference_amount)
              from public.exchanges e
              where e.difference_amount > 0 and e.payment_method = 'Cash'
                and e.exchange_date < v_start), 0)
  - coalesce((select sum(r.refund_amount)
              from public.sales_returns r
              where r.refund_method = 'Cash' and r.refund_amount > 0
                and r.return_date < v_start), 0)
  - coalesce((select sum(-e.difference_amount)
              from public.exchanges e
              where e.difference_amount < 0 and e.payment_method = 'Cash'
                and e.exchange_date < v_start), 0)
  - coalesce((select sum(x.amount)
              from public.expenses x
              where x.method = 'Cash' and x.status in ('PENDING', 'APPROVED')
                and x.expense_date < v_day), 0)
  - coalesce((select sum(spay.amount)
              from public.supplier_payments spay
              where spay.method = 'Cash' and spay.recorded_at < v_start), 0)
  into v_opening;

  select coalesce(sum(sp.amount), 0) into v_sales
  from public.sale_payments sp
  join public.sales s on s.id = sp.sale_id
  where s.status = 'COMPLETED'
    and sp.is_credit = false and sp.method = 'Cash'
    and sp.created_at >= v_start and sp.created_at < v_end
    and not exists (select 1 from public.customer_payments cp
                    where cp.receipt_number = sp.reference);

  select coalesce(sum(cp.amount), 0) into v_receipts
  from public.customer_payments cp
  where cp.method = 'Cash'
    and cp.recorded_at >= v_start and cp.recorded_at < v_end;

  -- 0014: cash collected on upgrade exchanges during the day
  select coalesce(sum(e.difference_amount), 0) into v_exch_in
  from public.exchanges e
  where e.difference_amount > 0 and e.payment_method = 'Cash'
    and e.exchange_date >= v_start and e.exchange_date < v_end;

  select
    coalesce((select sum(r.refund_amount)
              from public.sales_returns r
              where r.refund_method = 'Cash' and r.refund_amount > 0
                and r.return_date >= v_start and r.return_date < v_end), 0)
    + coalesce((select sum(-e.difference_amount)
              from public.exchanges e
              where e.difference_amount < 0 and e.payment_method = 'Cash'
                and e.exchange_date >= v_start and e.exchange_date < v_end), 0)
  into v_refunds;

  select coalesce(sum(x.amount), 0) into v_expenses
  from public.expenses x
  where x.method = 'Cash' and x.status in ('PENDING', 'APPROVED')
    and x.expense_date = v_day;

  select coalesce(sum(spay.amount), 0) into v_supplier
  from public.supplier_payments spay
  where spay.method = 'Cash'
    and spay.recorded_at >= v_start and spay.recorded_at < v_end;

  return jsonb_build_object(
    'date', v_day,
    'opening_cash',   round(v_opening, 2),
    'cash_sales',     round(v_sales, 2),
    'cash_receipts',  round(v_receipts, 2),
    'cash_exchange_in', round(v_exch_in, 2),
    'cash_refunds',   round(v_refunds, 2),
    'cash_expenses',  round(v_expenses, 2),
    'cash_supplier',  round(v_supplier, 2),
    'total_in',       round(v_sales + v_receipts + v_exch_in, 2),
    'total_out',      round(v_refunds + v_expenses + v_supplier, 2),
    'expected_cash',  round(v_opening + v_sales + v_receipts + v_exch_in
                            - v_refunds - v_expenses - v_supplier, 2),
    'note', 'Ledger-derived daily cash position. Till cash = genuine checkout '
            'cash (receipt mirrors excluded). Exchange differences collected '
            'in cash are included (upgrades add, downgrades refund). Expenses '
            'include PENDING + APPROVED; a later cancellation shifts '
            'subsequent days.'
  );
end $$;

revoke all on function public.cash_report(date) from public, anon;
grant execute on function public.cash_report(date) to authenticated, service_role;

commit;
