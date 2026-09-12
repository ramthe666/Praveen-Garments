-- ---------------------------------------------------------------------------
-- 0011_phase4_statement_till_payments.sql
--
-- WHAT: Recreates customer_statement() so its ledger credits payments made
--       at the till (POS checkout) in addition to customer_payments
--       receipts and sales-return credits. Same pattern as 0010: one
--       CREATE OR REPLACE, same signature, same grants, no table or data
--       changes.
--
-- WHY: 0009 built the statement from three sources only — bills (debits),
--       customer_payments receipts (credits) and sales_returns credits.
--       Money handed over at the checkout screen lands in sale_payments
--       (written by create_sale) and reduces sales.due_amount immediately,
--       but the statement never credited those rows. Result: the closing
--       balance overstated real dues by exactly the till-paid amount
--       (e.g. ₹1,418 shown vs ₹618 actual dues everywhere else).
--
-- FIX: Two additions inside the function body:
--       1. the opening balance now also subtracts till payments made
--          before p_from;
--       2. the line list gains a 'till_payment' credit branch
--          (doc_number = the sale it settled).
--       Till payments are identified as sale_payments rows that are NOT
--       mirrors of the payments ledger:
--         - is_credit = false          (the 'Credit' due-marker rows are
--                                        not money received)
--         - method <> 'Store Credit'   (advance-application mirrors)
--         - reference does not match any customer_payments.receipt_number
--           (record_customer_payment mirrors its receipts into
--           sale_payments — crediting those again would double-count)
--       Only payments on COMPLETED sales count, mirroring the bill side
--       (a cancelled sale refunds its till payments, so they must not
--       reduce the balance).
--
-- SCOPE: function body only, same signature, same grants. No table or
--       data changes. Additive and idempotent, like every migration here.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- customer_statement (fixed)
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

  -- opening = billed − paid (ledger receipts + till payments) − return
  -- credits, everything before p_from
  select
    coalesce((select sum(s.grand_total) from public.sales s
              where s.customer_id = p_customer_id and s.status = 'COMPLETED'
                and s.sale_date < v_from_ts), 0)
    - coalesce((select sum(cp.amount) from public.customer_payments cp
                where cp.customer_id = p_customer_id and cp.recorded_at < v_from_ts), 0)
    - coalesce((select sum(sp.amount) from public.sale_payments sp
                join public.sales s on s.id = sp.sale_id
                where s.customer_id = p_customer_id and s.status = 'COMPLETED'
                  and sp.is_credit = false
                  and sp.method <> 'Store Credit'
                  and sp.created_at < v_from_ts
                  and not exists (select 1 from public.customer_payments cp
                                  where cp.receipt_number = sp.reference)), 0)
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
      select sp.created_at, 'till_payment', s.sale_number,
             0::numeric, sp.amount, sp.id
      from public.sale_payments sp
      join public.sales s on s.id = sp.sale_id
      where s.customer_id = p_customer_id and s.status = 'COMPLETED'
        and sp.is_credit = false
        and sp.method <> 'Store Credit'
        and sp.created_at >= v_from_ts and sp.created_at < v_to_ts
        and not exists (select 1 from public.customer_payments cp
                        where cp.receipt_number = sp.reference)
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

commit;
