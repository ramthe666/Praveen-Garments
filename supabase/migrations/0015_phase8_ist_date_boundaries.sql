-- 0015_phase8_ist_date_boundaries.sql
-- Phase 8, Part 19 (date-filter correctness at the database layer).
--
-- PURPOSE
--   The page/list RPCs (0008 sales_page; 0009 purchase_orders_page,
--   purchase_invoices_page, purchase_returns_page, sales_returns_page,
--   exchanges_page, payments_page) and customer_statement (0011) anchored
--   calendar-date filters at the SESSION timezone (UTC on Supabase):
--     (p_date_from::timestamptz)              -> 00:00 UTC  = 05:30 IST
--     ((p_date_to + 1)::timestamptz)          -> 00:00 UTC  = 05:30 IST
--   The report RPCs (0012+) already anchor at the STORE timezone
--   (company_settings.timezone, default Asia/Kolkata). The two conventions
--   disagree for records created between 00:00 and 05:29 IST, and the same
--   filter can return different rows on a page vs its report.
--
--   This migration redefines ONLY those function bodies so every date
--   boundary is store-timezone anchored, matching 0012 exactly:
--     (p_date_from::timestamp at time zone v_tz)        -> 00:00 IST
--     ((p_date_to + 1)::timestamp at time zone v_tz)    -> 00:00 IST next day
--   Filter semantics stay [from 00:00, to+1 00:00) — the To date remains
--   INCLUSIVE of the whole store-local day, now for every module.
--
-- SAFETY
--   - ADDITIVE and IDEMPOTENT: create-or-replace of function bodies only.
--   - No table, column, data or grant changes (grants re-issued verbatim,
--     identical to the originals).
--   - Existing migrations 0001-0014 are untouched.
--   - Signatures and result shapes are byte-identical to the originals.

-- ===========================================================================
-- sales_page  (from 0008_pos_billing.sql — body re-anchored to store timezone)
-- ===========================================================================

create or replace function public.sales_page(
  p_search         text default null,
  p_date_from      date default null,
  p_date_to        date default null,
  p_payment_method text default null,
  p_cashier_id     uuid default null,
  p_status         text default null,
  p_payment_status text default null,
  p_limit          int  default 25,
  p_offset         int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz      text;
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_sql      text;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
begin
  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  if auth.uid() is not null
     and not (public.has_app_permission('view_sales')
              or public.has_app_permission('create_sale')
              or public.has_app_permission('cancel_sale')) then
    raise exception 'You do not have permission to view sales.';
  end if;

  if p_status is not null and p_status not in ('COMPLETED','CANCELLED') then
    raise exception 'Invalid status filter.';
  end if;
  if p_payment_status is not null and p_payment_status not in ('PAID','PARTIALLY_PAID','DUE') then
    raise exception 'Invalid payment status filter.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      '(s.sale_number ILIKE %1$L OR s.customer_name ILIKE %1$L OR s.cashier_name ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;
  if p_date_from is not null then
    v_filtered := true;
    v_where := v_where || format('s.sale_date >= %L', (p_date_from::timestamp at time zone v_tz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('s.sale_date < %L', ((p_date_to + 1)::timestamp at time zone v_tz)::text);
  end if;
  if nullif(trim(coalesce(p_payment_method, '')), '') is not null then
    v_filtered := true;
    v_where := v_where || format(
      'exists (select 1 from public.sale_payments sp where sp.sale_id = s.id and lower(sp.method) = lower(%L))',
      trim(p_payment_method));
  end if;
  if p_cashier_id is not null then
    v_filtered := true;
    v_where := v_where || format('s.cashier_id = %L', p_cashier_id::text);
  end if;
  if p_status is not null then
    v_filtered := true;
    v_where := v_where || format('s.status = %L', p_status);
  end if;
  if p_payment_status is not null then
    v_filtered := true;
    v_where := v_where || format('s.payment_status = %L', p_payment_status);
  end if;

  v_sql := format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select s.id, s.sale_number, s.sale_date, s.status, s.payment_status,
             s.subtotal, s.bill_discount, s.tax_total, s.round_off, s.grand_total,
             s.paid_amount, s.due_amount,
             s.customer_id, s.customer_name, s.customer_phone,
             s.cashier_id, s.cashier_name,
             s.location_name,
             s.cancelled_at, s.cancel_reason,
             coalesce(ii.item_count, 0) as item_count,
             coalesce(ii.unit_count, 0) as unit_count,
             coalesce(pp.methods, '[]'::jsonb) as payment_methods,
             (s.cancelled_at is not null or s.status = 'CANCELLED') as is_cancelled
      from public.sales s
      left join lateral (
        select count(*) as item_count, sum(quantity) as unit_count
        from public.sale_items si where si.sale_id = s.id
      ) ii on true
      left join lateral (
        select coalesce(jsonb_agg(distinct sp.method), '[]'::jsonb) as methods
        from public.sale_payments sp where sp.sale_id = s.id
      ) pp on true
      where %s
      order by s.sale_date desc, s.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset);

  execute v_sql into v_rows;

  if v_filtered then
    execute format($sql$
      select count(*) from public.sales s where %s
    $sql$, array_to_string(v_where, ' and ')) into v_total;
  else
    select greatest(round(reltuples::numeric), 0)::bigint into v_estimate
    from pg_class where relname = 'sales' and relnamespace = 'public'::regnamespace;
    if coalesce(v_estimate, 0) > 0 then
      v_total := v_estimate;
    else
      execute 'select count(*) from public.sales' into v_total;
    end if;
  end if;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'total_is_estimate', not v_filtered);
end $$;

revoke all on function public.sales_page(text, date, date, text, uuid, text, text, int, int) from public, anon;
grant execute on function public.sales_page(text, date, date, text, uuid, text, text, int, int) to authenticated, service_role;

-- ===========================================================================
-- purchase_orders_page  (from 0009_phase4_business_operations.sql — body re-anchored to store timezone)
-- ===========================================================================

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
  v_tz      text;
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
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
    v_where := v_where || format('po.order_date >= %L', (p_date_from::timestamp at time zone v_tz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('po.order_date < %L', ((p_date_to + 1)::timestamp at time zone v_tz)::text);
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


-- ===========================================================================
-- purchase_invoices_page  (from 0009_phase4_business_operations.sql — body re-anchored to store timezone)
-- ===========================================================================

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
  v_tz      text;
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
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
    v_where := v_where || format('pi.invoice_date >= %L', (p_date_from::timestamp at time zone v_tz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('pi.invoice_date < %L', ((p_date_to + 1)::timestamp at time zone v_tz)::text);
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


-- ===========================================================================
-- purchase_returns_page  (from 0009_phase4_business_operations.sql — body re-anchored to store timezone)
-- ===========================================================================

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
  v_tz      text;
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
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
    v_where := v_where || format('pr.return_date >= %L', (p_date_from::timestamp at time zone v_tz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('pr.return_date < %L', ((p_date_to + 1)::timestamp at time zone v_tz)::text);
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


-- ===========================================================================
-- sales_returns_page  (from 0009_phase4_business_operations.sql — body re-anchored to store timezone)
-- ===========================================================================

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
  v_tz      text;
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
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
    v_where := v_where || format('r.return_date >= %L', (p_date_from::timestamp at time zone v_tz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('r.return_date < %L', ((p_date_to + 1)::timestamp at time zone v_tz)::text);
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


-- ===========================================================================
-- exchanges_page  (from 0009_phase4_business_operations.sql — body re-anchored to store timezone)
-- ===========================================================================

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
  v_tz      text;
  v_where    text[] := array['true'];
  v_filtered boolean := false;
  v_rows     jsonb;
  v_total    bigint;
  v_estimate bigint;
  v_sql      text;
begin
  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
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
    v_where := v_where || format('e.exchange_date >= %L', (p_date_from::timestamp at time zone v_tz)::text);
  end if;
  if p_date_to is not null then
    v_filtered := true;
    v_where := v_where || format('e.exchange_date < %L', ((p_date_to + 1)::timestamp at time zone v_tz)::text);
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


-- ===========================================================================
-- payments_page  (from 0009_phase4_business_operations.sql — body re-anchored to store timezone)
-- ===========================================================================

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
  v_tz      text;
  v_rows  jsonb;
  v_total bigint;
  v_can_view_sales   boolean;
  v_can_view_purch   boolean;
  v_can_view_exp     boolean;
begin
  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
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
      and (p_date_from is null or entry_at >= (p_date_from::timestamp at time zone v_tz))
      and (p_date_to is null or entry_at < ((p_date_to + 1)::timestamp at time zone v_tz))
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

-- ===========================================================================
-- customer_statement  (from 0011_phase4_statement_till_payments.sql — body re-anchored to store timezone)
-- ===========================================================================

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
  v_tz       text := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_customer public.customers%rowtype;
  v_from     date := coalesce(p_from, '1970-01-01'::date);
  v_to       date := coalesce(p_to, current_date);
  v_to_ts    timestamptz := (v_to + 1)::timestamp at time zone v_tz;
  v_from_ts  timestamptz := v_from::timestamp at time zone v_tz;
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
