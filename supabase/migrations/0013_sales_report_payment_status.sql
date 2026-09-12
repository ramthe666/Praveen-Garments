-- ---------------------------------------------------------------------------
-- 0013_sales_report_payment_status.sql
--
-- WHAT: Adds the payment-status filter (PAID / PARTIALLY_PAID / DUE) to
--       sales_report(). The Phase 5 frontend sends a p_payment_status
--       argument on the Sales report page; 0012's sales_report does not
--       accept it, so PostgREST cannot match the function (PGRST202) and
--       the page shows "Could not load this report" even though 0012 is
--       applied. This migration makes the filter a first-class RPC arg.
--
-- HOW:  The parameter list changes (14 -> 15 args), so the 0012 version is
--       dropped first — CREATE OR REPLACE alone would create a second
--       overload. Everything else is byte-identical to 0012 PART 4.
--       Invalid p_payment_status values are ignored (same lenient pattern
--       as p_status). Existing callers that omit the new argument keep
--       working unchanged.
--
-- ORDER: Run AFTER 0012_phase5_reporting.sql. Additive only — no table or
--       data changes; 0001-0012 are untouched.
-- ---------------------------------------------------------------------------

drop function if exists public.sales_report(date, date, text, uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, int, int);

create or replace function public.sales_report(
  p_date_from      date default null,
  p_date_to        date default null,
  p_search         text default null,
  p_customer_id    uuid default null,
  p_cashier_id     uuid default null,
  p_payment_method text default null,
  p_variant_id     uuid default null,
  p_category_id    uuid default null,
  p_brand_id       uuid default null,
  p_location_id    uuid default null,
  p_status         text default 'COMPLETED',
  p_sort           text default 'date_desc',
  p_limit          int  default 25,
  p_offset         int  default 0,
  p_payment_status text default null
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz        text;
  v_from_ts   timestamptz;
  v_to_ts     timestamptz;
  v_where     text[] := array['true'];
  v_filtered  boolean := false;
  v_order     text;
  v_rows      jsonb;
  v_total     bigint;
  v_summary   jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts := coalesce(p_date_from, '1970-01-01'::date)::timestamp at time zone v_tz;
  v_to_ts   := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 10000);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  v_filtered := true;  -- reports are summary-critical: total is always exact
  v_where := v_where || format('s.sale_date >= %L::timestamptz', v_from_ts);
  v_where := v_where || format('s.sale_date < %L::timestamptz', v_to_ts);

  if p_status in ('COMPLETED', 'CANCELLED') then
    v_where := v_where || format('s.status = %L', p_status);
  end if;

  if p_payment_status in ('PAID', 'PARTIALLY_PAID', 'DUE') then
    v_where := v_where || format('s.payment_status = %L', p_payment_status);
  end if;

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_where := v_where || format(
      '(s.sale_number ILIKE %1$L OR s.customer_name ILIKE %1$L OR s.customer_phone ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_customer_id is not null then
    v_where := v_where || format('s.customer_id = %L', p_customer_id);
  end if;
  if p_cashier_id is not null then
    v_where := v_where || format('s.cashier_id = %L', p_cashier_id);
  end if;
  if p_location_id is not null then
    v_where := v_where || format('s.location_id = %L', p_location_id);
  end if;
  if nullif(trim(coalesce(p_payment_method, '')), '') is not null then
    v_where := v_where || format($fmt$
      exists (select 1 from public.sale_payments spx
              where spx.sale_id = s.id and spx.method = %L)$fmt$, trim(p_payment_method));
  end if;
  if p_variant_id is not null then
    v_where := v_where || format($fmt$
      exists (select 1 from public.sale_items six
              where six.sale_id = s.id and six.variant_id = %L)$fmt$, p_variant_id);
  end if;
  if p_category_id is not null then
    v_where := v_where || format($fmt$
      exists (select 1 from public.sale_items six
              join public.product_variants pvx on pvx.id = six.variant_id
              join public.products px on px.id = pvx.product_id
              where six.sale_id = s.id
                and (px.category_id = %L or px.subcategory_id = %L))$fmt$, p_category_id, p_category_id);
  end if;
  if p_brand_id is not null then
    v_where := v_where || format($fmt$
      exists (select 1 from public.sale_items six
              join public.product_variants pvx on pvx.id = six.variant_id
              join public.products px on px.id = pvx.product_id
              where six.sale_id = s.id and px.brand_id = %L)$fmt$, p_brand_id);
  end if;

  case p_sort
    when 'date_asc'    then v_order := 's.sale_date asc, s.id asc';
    when 'grand_desc'  then v_order := 's.grand_total desc, s.id desc';
    when 'grand_asc'   then v_order := 's.grand_total asc, s.id asc';
    when 'due_desc'    then v_order := 's.due_amount desc, s.id desc';
    else                     v_order := 's.sale_date desc, s.id desc';
  end case;

  execute format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select s.id, s.sale_number, s.sale_date, s.status, s.payment_status,
             s.customer_id, s.customer_name, s.customer_phone,
             s.cashier_name, s.location_name,
             s.subtotal, s.item_discount_total, s.bill_discount, s.tax_total,
             s.round_off, s.grand_total, s.paid_amount, s.due_amount,
             coalesce(it.items, 0) as items,
             coalesce(it.qty, 0)   as quantity,
             pay.methods
      from public.sales s
      left join lateral (
        select count(*) as items, sum(si.quantity) as qty
        from public.sale_items si where si.sale_id = s.id
      ) it on true
      left join lateral (
        select coalesce(jsonb_agg(distinct sp.method), '[]'::jsonb) as methods
        from public.sale_payments sp where sp.sale_id = s.id
      ) pay on true
      where %s
      order by %s
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), v_order, p_limit, p_offset) into v_rows;

  execute format('select count(*) from public.sales s where %s',
                 array_to_string(v_where, ' and ')) into v_total;

  execute format($sql$
    select jsonb_build_object(
      'bills',          count(*),
      'quantity',       coalesce(sum(it.qty), 0),
      'gross_sales',    coalesce(sum(s.grand_total), 0),
      'item_discounts', coalesce(sum(s.item_discount_total), 0),
      'bill_discounts', coalesce(sum(s.bill_discount), 0),
      'tax',            coalesce(sum(s.tax_total), 0),
      'paid',           coalesce(sum(s.paid_amount), 0),
      'due',            coalesce(sum(s.due_amount), 0),
      'avg_bill_value', case when count(*) > 0
                             then round(sum(s.grand_total) / count(*), 2) else 0 end
    )
    from public.sales s
    left join lateral (
      select sum(si.quantity) as qty
      from public.sale_items si where si.sale_id = s.id
    ) it on true
    where %s
  $sql$, array_to_string(v_where, ' and ')) into v_summary;

  v_summary := v_summary || jsonb_build_object(
    'returns_value', coalesce((select sum(r.applied_to_due + r.refund_amount)
                                from public.sales_returns r
                                where r.return_date >= v_from_ts and r.return_date < v_to_ts), 0),
    'refunds',       coalesce((select sum(r.refund_amount)
                                from public.sales_returns r
                                where r.refund_amount > 0
                                  and r.return_date >= v_from_ts and r.return_date < v_to_ts), 0));
  v_summary := v_summary || jsonb_build_object(
    'net_sales', round(coalesce((v_summary ->> 'gross_sales')::numeric, 0)
                       - coalesce((v_summary ->> 'returns_value')::numeric, 0), 2));

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'total_is_estimate', false, 'summary', v_summary);
end $$;

revoke all on function public.sales_report(date, date, text, uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, int, int, text) from public, anon;
grant execute on function public.sales_report(date, date, text, uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, int, int, text) to authenticated, service_role;
