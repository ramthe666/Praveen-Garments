-- ---------------------------------------------------------------------------
-- 0012_phase5_reporting.sql
--
-- WHAT: Phase 5 reporting layer. Adds the full set of report aggregation
--       functions (all database-side, bounded, permission-gated) plus the
--       index audit additions for report/lookup access patterns.
--
-- CONTENTS
--   PART 1  Index additions (index audit — access patterns that had no
--           matching index after the Phase 1-4 review)
--   PART 2  variant_unit_costs()  — internal cost-basis helper
--           (purchase-history weighted average, net of tax and returns)
--   PART 3  dashboard_summary()   — real dashboard data, period aware
--   PART 4  sales_report()        — invoice-level sales report + summary
--   PART 5  product_sales_report()— variant-level product sales
--   PART 6  catalog_performance_report() — category / brand performance
--   PART 7  payment_report()      — payment method breakdown + refunds
--   PART 8  gst_report()          — HSN-wise GST summary (sales+returns,
--                                    purchases+purchase returns)
--   PART 9  profit_report()       — labelled COGS estimate + profit
--   PART 10 stock_valuation_report() — cost / selling / MRP valuation
--   PART 11 stock_performance_report() — fast / slow / dead movers
--   PART 12 purchase_report()     — invoice-level purchase report + summary
--   PART 13 supplier_report()     — per-supplier aggregates
--   PART 14 customer_report()     — per-customer aggregates
--   PART 15 expense_report()      — expense summary + breakdowns
--   PART 16 returns_report()      — sales returns / exchanges / purchase
--                                    returns aggregates
--   PART 17 cash_report()         — daily cash position (ledger derived)
--   PART 18 audit_page()          — admin audit log viewer
--
-- COSTING (documented, not invented):
--   app_settings.inventory.costing_method = 'average' is honored:
--   unit cost = weighted average of RECEIVED purchase invoice lines
--   (line_total net of tax, net of purchase returns) per variant.
--   Variants with no purchase history fall back to the current
--   variant/product cost_price and are flagged cost_basis='current_cost'.
--   Historical sale lines are valued with that unit cost — an ESTIMATE,
--   clearly labelled in the UI; no figure is presented as exact historical
--   COGS because per-sale cost snapshots were not captured at billing time.
--
-- SAFETY: additive only. No table changes, no data changes, no policy
--         changes. Same grants pattern as 0009/0010/0011 (revoke from
--         public/anon, grant to authenticated + service_role). Idempotent.
-- ---------------------------------------------------------------------------

begin;

-- ===========================================================================
-- PART 1 — INDEX AUDIT ADDITIONS
-- ===========================================================================
-- Review of Phases 1-4 found these access patterns without a matching index:
--   * report/date filters constantly combine sales status + date
--   * location-wise sales / stock listing (sales.location_id unindexed)
--   * payment reports scan sale_payments by created_at (method index only
--     covers (method, created_at))
--   * stock reports list balances by location (unique index is
--     variant-leading)
--   * expense reports group by method / location
--   * purchase reports combine invoice status + date
-- All indexes are created IF NOT EXISTS (idempotent) and match real query
-- patterns from the report functions below. No index was dropped — the
-- existing set is otherwise well aligned with access patterns.

create index if not exists sales_status_date_idx      on public.sales (status, sale_date desc);
create index if not exists sales_location_date_idx    on public.sales (location_id, sale_date desc);
create index if not exists sale_payments_created_idx  on public.sale_payments (created_at desc, id desc);
create index if not exists sale_payments_sale_credit_idx on public.sale_payments (sale_id, is_credit);
create index if not exists stock_balances_location_idx on public.stock_balances (location_id, variant_id);
create index if not exists expenses_method_idx        on public.expenses (method);
create index if not exists expenses_location_idx      on public.expenses (location_id);
create index if not exists expenses_status_date_idx   on public.expenses (status, expense_date desc);
create index if not exists purchase_invoices_status_date_idx on public.purchase_invoices (status, invoice_date desc);
create index if not exists purchase_invoices_due_idx on public.purchase_invoices (due_amount) where due_amount > 0;
create index if not exists sales_due_idx             on public.sales (due_amount) where due_amount > 0;

-- ===========================================================================
-- PART 2 — variant_unit_costs()  (internal helper, no API grants)
-- ===========================================================================
-- Weighted-average purchase cost per variant from RECEIVED purchase invoice
-- items, net of tax (line_total - tax_amount) and net of returned quantity.
-- Fallback: current variant/product cost_price (flagged 'current_cost').

create or replace function public.variant_unit_costs()
returns table (variant_id uuid, unit_cost numeric, cost_basis text)
language sql
stable
security definer set search_path = public as $$
  select pv.id as variant_id,
         round(coalesce(
                 purch.net_cost / nullif(purch.net_qty, 0),
                 coalesce(pv.cost_price, p.cost_price, 0)
               )::numeric, 4) as unit_cost,
         case
           when purch.net_qty > 0 then 'purchase_average'
           when coalesce(pv.cost_price, p.cost_price) is not null then 'current_cost'
           else 'zero'
         end as cost_basis
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  left join lateral (
    select coalesce(sum(pii.quantity - pii.returned_quantity), 0) as net_qty,
           coalesce(sum(
             round((pii.line_total - pii.tax_amount)
                   * (pii.quantity - pii.returned_quantity)
                   / nullif(pii.quantity, 0), 2)
           ), 0) as net_cost
    from public.purchase_invoice_items pii
    join public.purchase_invoices pi2 on pi2.id = pii.invoice_id
    where pii.variant_id = pv.id
      and pi2.status = 'RECEIVED'
  ) purch on true;
$$;

revoke all on function public.variant_unit_costs() from public, anon, authenticated;

-- ===========================================================================
-- PART 3 — dashboard_summary(p_from, p_to)
-- ===========================================================================
-- One round trip for the whole dashboard. Sections the caller lacks
-- permission for come back as null (the UI shows a "requires X" hint).
-- Dues/inventory are POINT-IN-TIME balances (not window sums); sales,
-- purchases, expenses and profit are window aggregates.

create or replace function public.dashboard_summary(
  p_from date default null,
  p_to   date default null
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz              text;
  v_from_ts         timestamptz;
  v_to_ts           timestamptz;
  v_from_date       date;
  v_to_date         date;
  v_can_sales       boolean;
  v_can_purchases   boolean;
  v_can_expenses    boolean;
  v_can_customers   boolean;
  v_can_suppliers   boolean;
  v_can_inventory   boolean;
  v_can_profit      boolean;
  v_sales           jsonb;
  v_purchases       jsonb;
  v_expenses        jsonb;
  v_customers       jsonb;
  v_suppliers       jsonb;
  v_inventory       jsonb;
  v_profit          jsonb;
  v_stats           jsonb;
  v_gross           numeric := 0;
  v_returns_value   numeric := 0;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_dashboard') then
    raise exception 'You do not have permission to view the dashboard.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_date := coalesce(p_from, '1970-01-01'::date);
  v_to_date   := coalesce(p_to, (now() at time zone v_tz)::date);
  v_from_ts   := v_from_date::timestamp at time zone v_tz;
  v_to_ts     := (v_to_date + 1)::timestamp at time zone v_tz;

  v_can_sales     := auth.uid() is null or public.has_app_permission('view_sales');
  v_can_purchases := auth.uid() is null or public.has_app_permission('view_purchases');
  v_can_expenses  := auth.uid() is null or public.has_app_permission('manage_expenses');
  v_can_customers := auth.uid() is null
                     or public.has_app_permission('manage_customers')
                     or public.has_app_permission('record_customer_payment')
                     or public.has_app_permission('view_sales');
  v_can_suppliers := auth.uid() is null
                     or public.has_app_permission('view_purchases')
                     or public.has_app_permission('manage_suppliers')
                     or public.has_app_permission('record_supplier_payment');
  v_can_inventory := auth.uid() is null or public.has_app_permission('view_inventory');
  v_can_profit    := auth.uid() is null
                     or (public.has_app_permission('view_reports')
                         and public.has_app_permission('view_sales'));

  if v_can_sales then
    select jsonb_build_object(
      'bills',            count(*),
      'items_sold',       coalesce((select sum(si.quantity)
                                     from public.sale_items si
                                     join public.sales s2 on s2.id = si.sale_id
                                     where s2.status = 'COMPLETED'
                                       and s2.sale_date >= v_from_ts
                                       and s2.sale_date <  v_to_ts), 0),
      'gross_sales',      coalesce(sum(s.grand_total), 0),
      'item_discounts',   coalesce(sum(s.item_discount_total), 0),
      'bill_discounts',   coalesce(sum(s.bill_discount), 0),
      'tax_collected',    coalesce(sum(s.tax_total), 0),
      'round_off',        coalesce(sum(s.round_off), 0),
      'paid_amount',      coalesce(sum(s.paid_amount), 0),
      'due_amount',       coalesce(sum(s.due_amount), 0),
      'returns_value',    coalesce((select sum(r.applied_to_due + r.refund_amount)
                                     from public.sales_returns r
                                     where r.return_date >= v_from_ts
                                       and r.return_date <  v_to_ts), 0),
      'refunds',          coalesce((select sum(r.refund_amount)
                                     from public.sales_returns r
                                     where r.refund_amount > 0
                                       and r.return_date >= v_from_ts
                                       and r.return_date <  v_to_ts), 0),
      'exchanges',        coalesce((select count(*)
                                     from public.exchanges e
                                     where e.exchange_date >= v_from_ts
                                       and e.exchange_date <  v_to_ts), 0)
    ) into v_sales
    from public.sales s
    where s.status = 'COMPLETED'
      and s.sale_date >= v_from_ts
      and s.sale_date <  v_to_ts;

    v_gross         := coalesce((v_sales ->> 'gross_sales')::numeric, 0);
    v_returns_value := coalesce((v_sales ->> 'returns_value')::numeric, 0);
    v_sales := v_sales || jsonb_build_object(
      'net_sales',     round(v_gross - v_returns_value, 2),
      'avg_bill_value', case when coalesce((v_sales ->> 'bills')::bigint, 0) > 0
                             then round(v_gross / (v_sales ->> 'bills')::numeric, 2)
                             else 0 end
    );
  end if;

  if v_can_purchases then
    select jsonb_build_object(
      'invoices',       count(*),
      'purchase_value', coalesce(sum(pi.grand_total), 0),
      'purchase_tax',   coalesce(sum(pi.tax_total), 0),
      'returns_value',  coalesce((select sum(pr.grand_total)
                                   from public.purchase_returns pr
                                   where pr.return_date >= v_from_ts
                                     and pr.return_date <  v_to_ts), 0)
    ) into v_purchases
    from public.purchase_invoices pi
    where pi.status = 'RECEIVED'
      and pi.invoice_date >= v_from_ts
      and pi.invoice_date <  v_to_ts;
  end if;

  if v_can_expenses then
    select jsonb_build_object(
      'count',         count(*),
      'total',         coalesce(sum(e.amount), 0),
      'pending_total', coalesce(sum(case when e.status = 'PENDING'  then e.amount else 0 end), 0),
      'approved_total',coalesce(sum(case when e.status = 'APPROVED' then e.amount else 0 end), 0)
    ) into v_expenses
    from public.expenses e
    where e.status in ('PENDING', 'APPROVED')
      and e.expense_date >= v_from_date
      and e.expense_date <= v_to_date;
  end if;

  if v_can_customers then
    select jsonb_build_object(
      'active',      coalesce((select count(*) from public.customers c where c.is_active), 0),
      'outstanding', coalesce((select sum(s.due_amount) from public.sales s
                                where s.status = 'COMPLETED' and s.due_amount > 0), 0),
      'advance',     coalesce((select sum(cp.amount - cp.allocated_amount)
                                from public.customer_payments cp
                                where cp.amount > cp.allocated_amount), 0)
    ) into v_customers;
  end if;

  if v_can_suppliers then
    select jsonb_build_object(
      'active',    coalesce((select count(*) from public.suppliers sup where sup.is_active), 0),
      'payable',   coalesce((select sum(pi.due_amount) from public.purchase_invoices pi
                              where pi.status = 'RECEIVED' and pi.due_amount > 0), 0),
      'advance',   coalesce((select sum(sp.amount - sp.allocated_amount)
                              from public.supplier_payments sp
                              where sp.amount > sp.allocated_amount), 0)
    ) into v_suppliers;
  end if;

  if v_can_inventory then
    select jsonb_build_object(
      'total_qty',     coalesce((select sum(sb.quantity) from public.stock_balances sb), 0),
      'cost_value',    coalesce((select round(sum(sb.quantity * c.unit_cost), 2)
                                  from public.stock_balances sb
                                  join public.variant_unit_costs() c on c.variant_id = sb.variant_id), 0),
      'selling_value', coalesce((select round(sum(sb.quantity * coalesce(pv.selling_price, p.selling_price, 0)), 2)
                                  from public.stock_balances sb
                                  join public.product_variants pv on pv.id = sb.variant_id
                                  join public.products p on p.id = pv.product_id), 0)
    ) into v_inventory;
    begin
      v_stats := public.get_inventory_stats();
    exception when others then
      v_stats := null;
    end;
    if v_stats is not null then
      v_inventory := v_inventory
        || jsonb_build_object('low_stock',  coalesce((v_stats ->> 'low_stock')::int, 0),
                              'out_of_stock', coalesce((v_stats ->> 'out_of_stock')::int, 0));
    end if;
  end if;

  if v_can_profit then
    with cogs as (
      select coalesce(sum(greatest(si.quantity - coalesce(ret.returned, 0), 0) * c.unit_cost), 0) as cogs_value,
             coalesce(sum(case when c.cost_basis = 'purchase_average'
                               then greatest(si.quantity - coalesce(ret.returned, 0), 0) else 0 end), 0) as covered_qty,
             coalesce(sum(si.quantity), 0) as total_qty
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.variant_unit_costs() c on c.variant_id = si.variant_id
      left join lateral (
        select coalesce((select sum(sri.quantity) from public.sales_return_items sri
                          where sri.sale_item_id = si.id), 0)
             + coalesce((select sum(eii.quantity) from public.exchange_items_in eii
                          where eii.sale_item_id = si.id), 0) as returned
      ) ret on true
      where s.status = 'COMPLETED'
        and s.sale_date >= v_from_ts
        and s.sale_date <  v_to_ts
    )
    select jsonb_build_object(
      'net_sales',        round(v_gross - v_returns_value, 2),
      'cogs',             round(cogs.cogs_value, 2),
      'cost_coverage_pct', case when cogs.total_qty > 0
                                 then round(100.0 * cogs.covered_qty / cogs.total_qty, 1)
                                 else 0 end,
      'gross_profit',     round(v_gross - v_returns_value - cogs.cogs_value, 2),
      'expenses',         coalesce((select round(sum(e.amount), 2) from public.expenses e
                                     where e.status in ('PENDING', 'APPROVED')
                                       and e.expense_date >= v_from_date
                                       and e.expense_date <= v_to_date), 0)
    ) into v_profit
    from cogs;
    v_profit := v_profit || jsonb_build_object(
      'net_profit', round(coalesce((v_profit ->> 'gross_profit')::numeric, 0)
                          - coalesce((v_profit ->> 'expenses')::numeric, 0), 2));
  end if;

  return jsonb_build_object(
    'period',     jsonb_build_object('from', v_from_date, 'to', v_to_date, 'timezone', v_tz),
    'sales',      v_sales,
    'purchases',  v_purchases,
    'expenses',   v_expenses,
    'customers',  v_customers,
    'suppliers',  v_suppliers,
    'inventory',  v_inventory,
    'profit',     v_profit
  );
end $$;

revoke all on function public.dashboard_summary(date, date) from public, anon;
grant execute on function public.dashboard_summary(date, date) to authenticated, service_role;

-- ===========================================================================
-- PART 4 — sales_report(...)  invoice-level sales report + summary
-- ===========================================================================
-- Filters: date range, search (invoice no / customer name / phone),
-- customer, cashier, payment method (incl. 'Credit'), product variant,
-- category (category or subcategory), brand, location, status.
-- Summary block aggregates the FULL filtered set (not just the page) and
-- adds window returns/refunds for net sales.

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
  p_offset         int  default 0
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

revoke all on function public.sales_report(date, date, text, uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, int, int) from public, anon;
grant execute on function public.sales_report(date, date, text, uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, int, int) to authenticated, service_role;

-- ===========================================================================
-- PART 5 — product_sales_report(...)  variant-level product sales
-- ===========================================================================

create or replace function public.product_sales_report(
  p_date_from   date default null,
  p_date_to     date default null,
  p_search      text default null,
  p_category_id uuid default null,
  p_brand_id    uuid default null,
  p_variant_id  uuid default null,
  p_sort        text default 'revenue_desc',
  p_limit       int  default 25,
  p_offset      int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz       text;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
  v_where    text[] := array['true'];
  v_order    text;
  v_rows     jsonb;
  v_total    bigint;
  v_summary  jsonb;
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

  v_where := v_where || format('s.sale_date >= %L::timestamptz', v_from_ts);
  v_where := v_where || format('s.sale_date < %L::timestamptz', v_to_ts);
  v_where := array_append(v_where, 's.status = ''COMPLETED''');

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_where := v_where || format('(p.name ILIKE %1$L OR pv.sku ILIKE %1$L)',
                                  '%' || trim(p_search) || '%');
  end if;
  if p_category_id is not null then
    v_where := v_where || format('(p.category_id = %L or p.subcategory_id = %L)',
                                  p_category_id, p_category_id);
  end if;
  if p_brand_id is not null then
    v_where := v_where || format('p.brand_id = %L', p_brand_id);
  end if;
  if p_variant_id is not null then
    v_where := v_where || format('pv.id = %L', p_variant_id);
  end if;

  case p_sort
    when 'qty_desc'   then v_order := 'qty desc, revenue desc, pv.sku asc';
    when 'qty_asc'    then v_order := 'qty asc, pv.sku asc';
    when 'revenue_asc' then v_order := 'revenue asc, pv.sku asc';
    when 'name_asc'   then v_order := 'pv.sku asc';
    else                   v_order := 'revenue desc, qty desc, pv.sku asc';
  end case;

  execute format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select pv.id as variant_id, p.id as product_id, p.name as product_name,
             pv.sku, sz.name as size_name, col.name as color_name,
             agg.qty as quantity, agg.gross, agg.discount, agg.tax, agg.revenue,
             agg.bills
      from (
        select si.variant_id,
               sum(si.quantity)                                   as qty,
               round(sum(si.unit_price * si.quantity), 2)          as gross,
               round(sum(si.discount_amount), 2)                   as discount,
               round(sum(si.tax_amount), 2)                        as tax,
               round(sum(si.line_total), 2)                        as revenue,
               count(distinct s.id)                                as bills
        from public.sale_items si
        join public.sales s on s.id = si.sale_id
        join public.product_variants pv on pv.id = si.variant_id
        join public.products p on p.id = pv.product_id
        where %s
        group by si.variant_id
      ) agg
      join public.product_variants pv on pv.id = agg.variant_id
      join public.products p on p.id = pv.product_id
      left join public.sizes sz on sz.id = pv.size_id
      left join public.colors col on col.id = pv.color_id
      order by %s
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), v_order, p_limit, p_offset) into v_rows;

  execute format($sql$
    select count(*) from (
      select si.variant_id
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.product_variants pv on pv.id = si.variant_id
      join public.products p on p.id = pv.product_id
      where %s
      group by si.variant_id
    ) u
  $sql$, array_to_string(v_where, ' and ')) into v_total;

  execute format($sql$
    select jsonb_build_object(
      'variants',  count(*),
      'quantity',  coalesce(sum(agg.qty), 0),
      'gross',     coalesce(round(sum(agg.gross), 2), 0),
      'discount',  coalesce(round(sum(agg.discount), 2), 0),
      'tax',       coalesce(round(sum(agg.tax), 2), 0),
      'revenue',   coalesce(round(sum(agg.revenue), 2), 0),
      'bills',     coalesce(sum(agg.bills), 0)
    )
    from (
      select si.variant_id,
             sum(si.quantity) as qty,
             round(sum(si.unit_price * si.quantity), 2) as gross,
             round(sum(si.discount_amount), 2) as discount,
             round(sum(si.tax_amount), 2) as tax,
             round(sum(si.line_total), 2) as revenue,
             count(distinct s.id) as bills
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.product_variants pv on pv.id = si.variant_id
      join public.products p on p.id = pv.product_id
      where %s
      group by si.variant_id
    ) agg
  $sql$, array_to_string(v_where, ' and ')) into v_summary;

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'total_is_estimate', false, 'summary', v_summary);
end $$;

revoke all on function public.product_sales_report(date, date, text, uuid, uuid, uuid, text, int, int) from public, anon;
grant execute on function public.product_sales_report(date, date, text, uuid, uuid, uuid, text, int, int) to authenticated, service_role;

-- ===========================================================================
-- PART 6 — catalog_performance_report(...)  category / brand performance
-- ===========================================================================

create or replace function public.catalog_performance_report(
  p_date_from date default null,
  p_date_to   date default null,
  p_group_by  text default 'category'
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz        text;
  v_from_ts   timestamptz;
  v_to_ts     timestamptz;
  v_rows      jsonb;
  v_total     numeric;
  v_summary   jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;
  if p_group_by not in ('category', 'brand') then
    raise exception 'INVALID_GROUP_BY: use ''category'' or ''brand''.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts := coalesce(p_date_from, '1970-01-01'::date)::timestamp at time zone v_tz;
  v_to_ts   := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;

  if p_group_by = 'category' then
    select coalesce(jsonb_agg(t), '[]'::jsonb), coalesce(sum(t.value), 0) into v_rows, v_total
    from (
      select c.id, c.name,
             sum(si.quantity) as quantity,
             round(sum(si.line_total), 2) as value,
             count(distinct s.id) as bills
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.product_variants pv on pv.id = si.variant_id
      join public.products p on p.id = pv.product_id
      join public.categories c on c.id = p.category_id
      where s.status = 'COMPLETED'
        and s.sale_date >= v_from_ts and s.sale_date < v_to_ts
      group by c.id, c.name
      order by 4 desc nulls last
    ) t;
  else
    select coalesce(jsonb_agg(t), '[]'::jsonb), coalesce(sum(t.value), 0) into v_rows, v_total
    from (
      select b.id, b.name,
             sum(si.quantity) as quantity,
             round(sum(si.line_total), 2) as value,
             count(distinct s.id) as bills
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join public.product_variants pv on pv.id = si.variant_id
      join public.products p on p.id = pv.product_id
      join public.brands b on b.id = p.brand_id
      where s.status = 'COMPLETED'
        and s.sale_date >= v_from_ts and s.sale_date < v_to_ts
      group by b.id, b.name
      order by 4 desc nulls last
    ) t;
  end if;

  v_rows := coalesce((
    select jsonb_agg(row || jsonb_build_object(
             'pct', case when v_total > 0 then round(100.0 * (row ->> 'value')::numeric / v_total, 1)
                         else 0 end))
    from jsonb_array_elements(v_rows) row
  ), '[]'::jsonb);

  v_summary := jsonb_build_object(
    'total_value',  round(coalesce(v_total, 0), 2),
    'total_qty',    coalesce((select sum((row ->> 'quantity')::numeric) from jsonb_array_elements(v_rows) row), 0),
    'total_bills',  coalesce((select sum((row ->> 'bills')::numeric) from jsonb_array_elements(v_rows) row), 0),
    'dimensions',   jsonb_array_length(v_rows));

  return jsonb_build_object('rows', v_rows, 'total', jsonb_array_length(v_rows),
                            'total_is_estimate', false, 'summary', v_summary);
end $$;

revoke all on function public.catalog_performance_report(date, date, text) from public, anon;
grant execute on function public.catalog_performance_report(date, date, text) to authenticated, service_role;

-- ===========================================================================
-- PART 7 — payment_report(p_date_from, p_date_to)
-- ===========================================================================
-- Method-wise money movement. Inflow = till payments at checkout (genuine
-- sale_payments rows, mirror-safe like 0011) + customer receipts
-- (customer_payments, excluding Store Credit conversions). Refunds,
-- expenses and supplier payments are reported separately, per method.

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

  select coalesce(round(sum((r ->> 'amount')::numeric), 2), 0) into v_total_in
  from jsonb_array_elements(v_till || v_receipts) r;

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
    'inflows', v_inflows,
    'refunds', v_refunds,
    'expenses', v_expenses,
    'supplier_payments', v_supplier,
    'summary', jsonb_build_object(
      'total_inflow',  v_total_in,
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

-- ===========================================================================
-- PART 8 — gst_report(p_date_from, p_date_to)
-- ===========================================================================
-- HSN-wise GST summary built from stored line snapshots (sale_items /
-- purchase_invoice_items tax amounts + rates + inter_state flags).
-- taxable value = line_total - tax_amount (correct for both inclusive
-- and exclusive tax modes). CGST/SGST split is half of the line tax for
-- intra-state sales; IGST is the full line tax for inter-state.
-- No rates are hardcoded anywhere.

create or replace function public.gst_report(
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
  v_sales    jsonb;
  v_sreturns jsonb;
  v_purch    jsonb;
  v_preturns jsonb;
  v_summary  jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts := coalesce(p_date_from, '1970-01-01'::date)::timestamp at time zone v_tz;
  v_to_ts   := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_sales
  from (
    select nullif(si.hsn_code, '') as hsn, si.gst_rate,
           round(sum(si.line_total - si.tax_amount), 2) as taxable,
           round(sum(case when s.inter_state then 0 else si.tax_amount / 2 end), 2) as cgst,
           round(sum(case when s.inter_state then 0 else si.tax_amount - si.tax_amount / 2 end), 2) as sgst,
           round(sum(case when s.inter_state then si.tax_amount else 0 end), 2) as igst,
           round(sum(si.tax_amount), 2) as total_tax
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.status = 'COMPLETED'
      and s.sale_date >= v_from_ts and s.sale_date < v_to_ts
    group by nullif(si.hsn_code, ''), si.gst_rate
    order by 3 desc nulls last
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_sreturns
  from (
    select nullif(oi.hsn_code, '') as hsn, sri.tax_rate as gst_rate,
           round(sum(sri.line_refund - sri.tax_amount), 2) as taxable,
           round(sum(case when s.inter_state then 0 else sri.tax_amount / 2 end), 2) as cgst,
           round(sum(case when s.inter_state then 0 else sri.tax_amount - sri.tax_amount / 2 end), 2) as sgst,
           round(sum(case when s.inter_state then sri.tax_amount else 0 end), 2) as igst,
           round(sum(sri.tax_amount), 2) as total_tax
    from public.sales_return_items sri
    join public.sales_returns sr on sr.id = sri.return_id
    join public.sales s on s.id = sr.sale_id
    left join public.sale_items oi on oi.id = sri.sale_item_id
    where sr.return_date >= v_from_ts and sr.return_date < v_to_ts
    group by nullif(oi.hsn_code, ''), sri.tax_rate
    order by 3 desc nulls last
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_purch
  from (
    select nullif(po.hsn_code, '') as hsn, pii.gst_rate,
           round(sum(pii.line_total - pii.tax_amount), 2) as taxable,
           round(sum(case when pi.inter_state then 0 else pii.tax_amount / 2 end), 2) as cgst,
           round(sum(case when pi.inter_state then 0 else pii.tax_amount - pii.tax_amount / 2 end), 2) as sgst,
           round(sum(case when pi.inter_state then pii.tax_amount else 0 end), 2) as igst,
           round(sum(pii.tax_amount), 2) as total_tax
    from public.purchase_invoice_items pii
    join public.purchase_invoices pi on pi.id = pii.invoice_id
    left join public.product_variants pvo on pvo.id = pii.variant_id
    left join public.products po on po.id = pvo.product_id
    where pi.status = 'RECEIVED'
      and pi.invoice_date >= v_from_ts and pi.invoice_date < v_to_ts
    group by nullif(po.hsn_code, ''), pii.gst_rate
    order by 3 desc nulls last
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_preturns
  from (
    select nullif(po.hsn_code, '') as hsn, pri.tax_rate as gst_rate,
           round(sum(pri.line_total - pri.tax_amount), 2) as taxable,
           round(sum(case when pi.inter_state then 0 else pri.tax_amount / 2 end), 2) as cgst,
           round(sum(case when pi.inter_state then 0 else pri.tax_amount - pri.tax_amount / 2 end), 2) as sgst,
           round(sum(case when pi.inter_state then pri.tax_amount else 0 end), 2) as igst,
           round(sum(pri.tax_amount), 2) as total_tax
    from public.purchase_return_items pri
    join public.purchase_returns pr on pr.id = pri.return_id
    join public.purchase_invoices pi on pi.id = pr.purchase_invoice_id
    left join public.product_variants pvo on pvo.id = pri.variant_id
    left join public.products po on po.id = pvo.product_id
    where pr.return_date >= v_from_ts and pr.return_date < v_to_ts
    group by nullif(po.hsn_code, ''), pri.tax_rate
    order by 3 desc nulls last
  ) t;

  v_summary := jsonb_build_object(
    'taxable_sales',        coalesce((select round(sum((r ->> 'taxable')::numeric), 2)
                                       from jsonb_array_elements(v_sales) r), 0),
    'output_tax',           coalesce((select round(sum((r ->> 'total_tax')::numeric), 2)
                                       from jsonb_array_elements(v_sales) r), 0),
    'taxable_return_sales', coalesce((select round(sum((r ->> 'taxable')::numeric), 2)
                                       from jsonb_array_elements(v_sreturns) r), 0),
    'return_tax',           coalesce((select round(sum((r ->> 'total_tax')::numeric), 2)
                                       from jsonb_array_elements(v_sreturns) r), 0),
    'taxable_purchases',    coalesce((select round(sum((r ->> 'taxable')::numeric), 2)
                                       from jsonb_array_elements(v_purch) r), 0),
    'input_tax',            coalesce((select round(sum((r ->> 'total_tax')::numeric), 2)
                                       from jsonb_array_elements(v_purch) r), 0),
    'taxable_return_purch', coalesce((select round(sum((r ->> 'taxable')::numeric), 2)
                                       from jsonb_array_elements(v_preturns) r), 0),
    'return_input_tax',     coalesce((select round(sum((r ->> 'total_tax')::numeric), 2)
                                       from jsonb_array_elements(v_preturns) r), 0));
  v_summary := v_summary || jsonb_build_object(
    'net_output_tax', round(coalesce((v_summary ->> 'output_tax')::numeric, 0)
                            - coalesce((v_summary ->> 'return_tax')::numeric, 0), 2),
    'net_input_tax',  round(coalesce((v_summary ->> 'input_tax')::numeric, 0)
                            - coalesce((v_summary ->> 'return_input_tax')::numeric, 0), 2));
  v_summary := v_summary || jsonb_build_object(
    'net_gst_payable', round(coalesce((v_summary ->> 'net_output_tax')::numeric, 0)
                             - coalesce((v_summary ->> 'net_input_tax')::numeric, 0), 2));

  return jsonb_build_object(
    'sales', v_sales, 'sales_returns', v_sreturns,
    'purchases', v_purch, 'purchase_returns', v_preturns,
    'summary', v_summary);
end $$;

revoke all on function public.gst_report(date, date) from public, anon;
grant execute on function public.gst_report(date, date) to authenticated, service_role;

-- ===========================================================================
-- PART 9 — profit_report(p_date_from, p_date_to)
-- ===========================================================================
-- Clearly-labelled estimate. COGS = sold quantity x unit cost where unit
-- cost = weighted average of received purchase lines (net of tax and
-- purchase returns), falling back to the current cost price when a
-- variant has no purchase history (cost_coverage_pct shows how much of
-- the sold quantity had real purchase history). No value here is
-- presented as exact historical COGS.

create or replace function public.profit_report(
  p_date_from date default null,
  p_date_to   date default null
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz        text;
  v_from_ts   timestamptz;
  v_to_ts     timestamptz;
  v_from_date date;
  v_to_date   date;
  v_result    jsonb;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('view_reports')
              and public.has_app_permission('view_sales')) then
    raise exception 'You do not have permission to view the profit report.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts   := coalesce(p_date_from, '1970-01-01'::date)::timestamp at time zone v_tz;
  v_to_ts     := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;
  v_from_date := coalesce(p_date_from, '1970-01-01'::date);
  v_to_date   := coalesce(p_date_to, (now() at time zone v_tz)::date);

  with sales_agg as (
    select coalesce(sum(s.grand_total), 0) as gross_sales,
           coalesce((select sum(r.applied_to_due + r.refund_amount)
                     from public.sales_returns r
                     where r.return_date >= v_from_ts
                       and r.return_date <  v_to_ts), 0) as returns_value,
           coalesce((select sum(r.refund_amount)
                     from public.sales_returns r
                     where r.refund_amount > 0
                       and r.return_date >= v_from_ts
                       and r.return_date <  v_to_ts), 0) as refunds
    from public.sales s
    where s.status = 'COMPLETED'
      and s.sale_date >= v_from_ts and s.sale_date < v_to_ts
  ),
  cogs as (
    select coalesce(sum(greatest(si.quantity - coalesce(ret.returned, 0), 0) * c.unit_cost), 0) as cogs_value,
           coalesce(sum(case when c.cost_basis = 'purchase_average'
                             then greatest(si.quantity - coalesce(ret.returned, 0), 0) else 0 end), 0) as covered_qty,
           coalesce(sum(si.quantity), 0) as total_qty,
           coalesce(sum(greatest(si.quantity - coalesce(ret.returned, 0), 0) * c.unit_cost)
                      filter (where c.cost_basis = 'current_cost'), 0) as fallback_cogs
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    join public.variant_unit_costs() c on c.variant_id = si.variant_id
    left join lateral (
      select coalesce((select sum(sri.quantity) from public.sales_return_items sri
                        where sri.sale_item_id = si.id), 0)
           + coalesce((select sum(eii.quantity) from public.exchange_items_in eii
                        where eii.sale_item_id = si.id), 0) as returned
    ) ret on true
    where s.status = 'COMPLETED'
      and s.sale_date >= v_from_ts and s.sale_date < v_to_ts
  ),
  exp_agg as (
    select coalesce(sum(e.amount), 0) as expenses
    from public.expenses e
    where e.status in ('PENDING', 'APPROVED')
      and e.expense_date >= v_from_date and e.expense_date <= v_to_date
  )
  select jsonb_build_object(
    'gross_sales',   round(sa.gross_sales, 2),
    'returns_value', round(sa.returns_value, 2),
    'refunds',       round(sa.refunds, 2),
    'net_sales',     round(sa.gross_sales - sa.returns_value, 2),
    'cogs',          round(co.cogs_value, 2),
    'cogs_on_current_cost', round(co.fallback_cogs, 2),
    'cost_coverage_pct', case when co.total_qty > 0
                               then round(100.0 * co.covered_qty / co.total_qty, 1) else 0 end,
    'gross_profit',  round(sa.gross_sales - sa.returns_value - co.cogs_value, 2),
    'expenses',      round(ex.expenses, 2),
    'exchanges_net', coalesce((select round(sum(e.difference_amount), 2)
                                from public.exchanges e
                                where e.exchange_date >= v_from_ts
                                  and e.exchange_date <  v_to_ts), 0),
    'net_profit',    round(sa.gross_sales - sa.returns_value - co.cogs_value - ex.expenses, 2),
    'costing_note',  'COGS is an estimate: sold quantity (net of returns and '
                     'exchange trade-ins) valued at the weighted average cost '
                     'of received purchase lines (net of tax and purchase '
                     'returns); variants without purchase history use the '
                     'current cost price. Exchange issues are not part of COGS; '
                     'their net value is reported separately.'
  ) into v_result
  from sales_agg sa cross join cogs co cross join exp_agg ex;

  return v_result;
end $$;

revoke all on function public.profit_report(date, date) from public, anon;
grant execute on function public.profit_report(date, date) to authenticated, service_role;

-- ===========================================================================
-- PART 10 — stock_valuation_report(...)  cost / selling / MRP valuation
-- ===========================================================================
-- Distinguishes stock quantity, cost value (variant_unit_costs basis),
-- selling value (current selling price) and MRP value. Rows are variants
-- with non-zero stock matching the filters.

create or replace function public.stock_valuation_report(
  p_location_id uuid default null,
  p_category_id uuid default null,
  p_brand_id    uuid default null,
  p_search      text default null,
  p_sort        text default 'cost_desc',
  p_limit       int  default 25,
  p_offset      int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_where    text[] := array['true'];
  v_order    text;
  v_rows     jsonb;
  v_total    bigint;
  v_summary  jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 10000);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if p_location_id is not null then
    v_where := v_where || format('sb.location_id = %L', p_location_id);
  end if;
  if p_category_id is not null then
    v_where := v_where || format('(p.category_id = %L or p.subcategory_id = %L)',
                                  p_category_id, p_category_id);
  end if;
  if p_brand_id is not null then
    v_where := v_where || format('p.brand_id = %L', p_brand_id);
  end if;
  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_where := v_where || format('(pv.sku ILIKE %1$L OR p.name ILIKE %1$L)',
                                  '%' || trim(p_search) || '%');
  end if;

  case p_sort
    when 'cost_asc'      then v_order := 'cost_value asc, pv.sku asc';
    when 'selling_desc'  then v_order := 'selling_value desc, pv.sku asc';
    when 'mrp_desc'      then v_order := 'mrp_value desc, pv.sku asc';
    when 'qty_desc'      then v_order := 'qty desc, pv.sku asc';
    when 'sku_asc'       then v_order := 'pv.sku asc';
    else                      v_order := 'cost_value desc, pv.sku asc';
  end case;

  execute format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select pv.id as variant_id, pv.sku, p.name as product_name,
             sz.name as size_name, col.name as color_name,
             val.qty as quantity, val.cost_value, val.selling_value, val.mrp_value, val.cost_basis
      from (
        select sb.variant_id,
               sum(sb.quantity) as qty,
               round(sum(sb.quantity * c.unit_cost), 2) as cost_value,
               round(sum(sb.quantity * coalesce(pv2.selling_price, p2.selling_price, 0)), 2) as selling_value,
               round(sum(sb.quantity * coalesce(pv2.mrp, p2.mrp, 0)), 2) as mrp_value,
               min(c.cost_basis) as cost_basis
        from public.stock_balances sb
        join public.product_variants pv2 on pv2.id = sb.variant_id
        join public.products p2 on p2.id = pv2.product_id
        join public.variant_unit_costs() c on c.variant_id = sb.variant_id
        where %s
        group by sb.variant_id
        having sum(sb.quantity) > 0
      ) val
      join public.product_variants pv on pv.id = val.variant_id
      join public.products p on p.id = pv.product_id
      left join public.sizes sz on sz.id = pv.size_id
      left join public.colors col on col.id = pv.color_id
      order by %s
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), v_order, p_limit, p_offset) into v_rows;

  execute format($sql$
    select count(*) from (
      select sb.variant_id
      from public.stock_balances sb
      join public.product_variants pv on pv.id = sb.variant_id
      join public.products p on p.id = pv.product_id
      where %s
      group by sb.variant_id
      having sum(sb.quantity) > 0
    ) u
  $sql$, array_to_string(v_where, ' and ')) into v_total;

  execute format($sql$
    select jsonb_build_object(
      'variants',       count(*),
      'quantity',       coalesce(sum(val.qty), 0),
      'cost_value',     coalesce(round(sum(val.cost_value), 2), 0),
      'selling_value',  coalesce(round(sum(val.selling_value), 2), 0),
      'mrp_value',      coalesce(round(sum(val.mrp_value), 2), 0),
      'on_purchase_avg_cost', coalesce(sum(case when val.cost_basis = 'purchase_average'
                                                 then val.cost_value else 0 end), 0),
      'on_current_cost',      coalesce(sum(case when val.cost_basis = 'current_cost'
                                                 then val.cost_value else 0 end), 0)
    )
    from (
      select sb.variant_id,
             sum(sb.quantity) as qty,
             round(sum(sb.quantity * c.unit_cost), 2) as cost_value,
             round(sum(sb.quantity * coalesce(pv.selling_price, p.selling_price, 0)), 2) as selling_value,
             round(sum(sb.quantity * coalesce(pv.mrp, p.mrp, 0)), 2) as mrp_value,
             min(c.cost_basis) as cost_basis
      from public.stock_balances sb
      join public.product_variants pv on pv.id = sb.variant_id
      join public.products p on p.id = pv.product_id
      join public.variant_unit_costs() c on c.variant_id = sb.variant_id
      where %s
      group by sb.variant_id
      having sum(sb.quantity) > 0
    ) val
  $sql$, array_to_string(v_where, ' and ')) into v_summary;

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'total_is_estimate', false, 'summary', v_summary);
end $$;

revoke all on function public.stock_valuation_report(uuid, uuid, uuid, text, text, int, int) from public, anon;
grant execute on function public.stock_valuation_report(uuid, uuid, uuid, text, text, int, int) to authenticated, service_role;

-- ===========================================================================
-- PART 11 — stock_performance_report(...)  fast / slow / dead movers
-- ===========================================================================
-- Classifies variants over the window:
--   dead         : zero sales in window while holding stock
--   out_of_stock : no stock now (regardless of sales)
--   fast          : sales velocity >= 1 unit/day
--   slow          : 0 < velocity < 1 unit/day
-- Rows include active variants plus any variant that sold in the window.

create or replace function public.stock_performance_report(
  p_date_from date default null,
  p_date_to   date default null,
  p_class     text default null,
  p_search    text default null,
  p_sort      text default 'qty_desc',
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz       text;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
  v_days     numeric;
  v_where    text[] := array['true'];
  v_order    text;
  v_rows     jsonb;
  v_total    bigint;
  v_summary  jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts := coalesce(p_date_from, (now() at time zone v_tz)::date - 30)::timestamp at time zone v_tz;
  v_to_ts   := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;
  v_days    := greatest(((coalesce(p_date_to, (now() at time zone v_tz)::date)
                          - (v_from_ts at time zone v_tz)::date) + 1)::numeric, 1);

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 10000);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  if p_class in ('fast', 'slow', 'dead', 'out_of_stock') then
    v_where := v_where || format('t.class = %L', p_class);
  end if;
  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_where := v_where || format('(t.sku ILIKE %1$L OR t.product_name ILIKE %1$L)',
                                  '%' || trim(p_search) || '%');
  end if;

  case p_sort
    when 'revenue_desc' then v_order := 't.revenue desc, t.qty_sold desc';
    when 'revenue_asc'  then v_order := 't.revenue asc, t.qty_sold asc';
    when 'stock_desc'   then v_order := 't.current_stock desc';
    when 'stock_asc'    then v_order := 't.current_stock asc';
    when 'name_asc'     then v_order := 't.sku asc';
    when 'qty_asc'      then v_order := 't.qty_sold asc, t.sku asc';
    else                     v_order := 't.qty_sold desc, t.revenue desc';
  end case;

  execute format($sql$
    select coalesce(jsonb_agg(r), '[]'::jsonb) from (
      select * from (
        select pv.id as variant_id, pv.sku, p.name as product_name,
               sz.name as size_name, col.name as color_name,
               coalesce(sold.qty_sold, 0)   as qty_sold,
               coalesce(sold.revenue, 0)    as revenue,
               coalesce(sold.bills, 0)      as bills,
               coalesce(stock.current_stock, 0) as current_stock,
               round(coalesce(sold.qty_sold, 0) / %s, 3) as velocity,
               case
                 when coalesce(stock.current_stock, 0) <= 0 then 'out_of_stock'
                 when coalesce(sold.qty_sold, 0) = 0 then 'dead'
                 when coalesce(sold.qty_sold, 0) / %s >= 1 then 'fast'
                 else 'slow'
               end as class
        from public.product_variants pv
        join public.products p on p.id = pv.product_id
        left join public.sizes sz on sz.id = pv.size_id
        left join public.colors col on col.id = pv.color_id
        left join (
          select si.variant_id,
                 sum(si.quantity) as qty_sold,
                 round(sum(si.line_total), 2) as revenue,
                 count(distinct s.id) as bills
          from public.sale_items si
          join public.sales s on s.id = si.sale_id
          where s.status = 'COMPLETED'
            and s.sale_date >= %L::timestamptz and s.sale_date < %L::timestamptz
          group by si.variant_id
        ) sold on sold.variant_id = pv.id
        left join (
          select sb.variant_id, sum(sb.quantity) as current_stock
          from public.stock_balances sb
          group by sb.variant_id
        ) stock on stock.variant_id = pv.id
        where pv.is_active or sold.qty_sold is not null
      ) t
      where %s
      order by %s
      limit %s offset %s
    ) r
  $sql$, v_days, v_days, v_from_ts, v_to_ts,
         array_to_string(v_where, ' and '), v_order, p_limit, p_offset) into v_rows;

  execute format($sql$
    select count(*) from (
      select t.class, t.sku, t.product_name from (
        select pv.id,
               coalesce(sold.qty_sold, 0)   as qty_sold,
               coalesce(stock.current_stock, 0) as current_stock,
               pv.sku, p.name as product_name,
               case
                 when coalesce(stock.current_stock, 0) <= 0 then 'out_of_stock'
                 when coalesce(sold.qty_sold, 0) = 0 then 'dead'
                 when coalesce(sold.qty_sold, 0) / %s >= 1 then 'fast'
                 else 'slow'
               end as class
        from public.product_variants pv
        join public.products p on p.id = pv.product_id
        left join (
          select si.variant_id, sum(si.quantity) as qty_sold
          from public.sale_items si
          join public.sales s on s.id = si.sale_id
          where s.status = 'COMPLETED'
            and s.sale_date >= %L::timestamptz and s.sale_date < %L::timestamptz
          group by si.variant_id
        ) sold on sold.variant_id = pv.id
        left join (
          select sb.variant_id, sum(sb.quantity) as current_stock
          from public.stock_balances sb
          group by sb.variant_id
        ) stock on stock.variant_id = pv.id
        where pv.is_active or sold.qty_sold is not null
      ) t
      where %s
    ) u
  $sql$, v_days, v_from_ts, v_to_ts, array_to_string(v_where, ' and ')) into v_total;

  execute format($sql$
    select jsonb_build_object(
      'fast',        coalesce(sum(case when u.class = 'fast' then 1 else 0 end), 0),
      'slow',        coalesce(sum(case when u.class = 'slow' then 1 else 0 end), 0),
      'dead',        coalesce(sum(case when u.class = 'dead' then 1 else 0 end), 0),
      'out_of_stock',coalesce(sum(case when u.class = 'out_of_stock' then 1 else 0 end), 0),
      'total',       count(*)
    )
    from (
      select case
               when coalesce(stock.current_stock, 0) <= 0 then 'out_of_stock'
               when coalesce(sold.qty_sold, 0) = 0 then 'dead'
               when coalesce(sold.qty_sold, 0) / %s >= 1 then 'fast'
               else 'slow'
             end as class
      from public.product_variants pv
      left join (
        select si.variant_id, sum(si.quantity) as qty_sold
        from public.sale_items si
        join public.sales s on s.id = si.sale_id
        where s.status = 'COMPLETED'
          and s.sale_date >= %L::timestamptz and s.sale_date < %L::timestamptz
        group by si.variant_id
      ) sold on sold.variant_id = pv.id
      left join (
        select sb.variant_id, sum(sb.quantity) as current_stock
        from public.stock_balances sb
        group by sb.variant_id
      ) stock on stock.variant_id = pv.id
      where pv.is_active or sold.qty_sold is not null
    ) u
  $sql$, v_days, v_from_ts, v_to_ts) into v_summary;

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'total_is_estimate', false, 'summary', v_summary,
                            'window_days', v_days);
end $$;

revoke all on function public.stock_performance_report(date, date, text, text, text, int, int) from public, anon;
grant execute on function public.stock_performance_report(date, date, text, text, text, int, int) to authenticated, service_role;

-- ===========================================================================
-- PART 12 — purchase_report(...)  invoice-level purchase report + summary
-- ===========================================================================

create or replace function public.purchase_report(
  p_date_from       date default null,
  p_date_to         date default null,
  p_search          text default null,
  p_supplier_id     uuid default null,
  p_status          text default 'RECEIVED',
  p_payment_status  text default null,
  p_sort            text default 'date_desc',
  p_limit           int  default 25,
  p_offset          int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz       text;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
  v_where    text[] := array['true'];
  v_order    text;
  v_rows     jsonb;
  v_total    bigint;
  v_summary  jsonb;
begin
  if auth.uid() is not null
     and not (public.has_app_permission('view_reports')
              or public.has_app_permission('view_purchases')) then
    raise exception 'You do not have permission to view purchase reports.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts := coalesce(p_date_from, '1970-01-01'::date)::timestamp at time zone v_tz;
  v_to_ts   := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 10000);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  v_where := v_where || format('pi.invoice_date >= %L::timestamptz', v_from_ts);
  v_where := v_where || format('pi.invoice_date < %L::timestamptz', v_to_ts);

  if p_status in ('DRAFT', 'RECEIVED', 'CANCELLED') then
    v_where := v_where || format('pi.status = %L', p_status);
  end if;
  if p_payment_status in ('PAID', 'PARTIALLY_PAID', 'DUE') then
    v_where := v_where || format('pi.payment_status = %L', p_payment_status);
  end if;
  if p_supplier_id is not null then
    v_where := v_where || format('pi.supplier_id = %L', p_supplier_id);
  end if;
  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_where := v_where || format(
      '(pi.invoice_number ILIKE %1$L OR pi.supplier_name ILIKE %1$L OR pi.supplier_invoice_no ILIKE %1$L OR pi.po_number ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;

  case p_sort
    when 'date_asc'    then v_order := 'pi.invoice_date asc, pi.id asc';
    when 'value_desc'  then v_order := 'pi.grand_total desc, pi.id desc';
    when 'value_asc'   then v_order := 'pi.grand_total asc, pi.id asc';
    when 'due_desc'    then v_order := 'pi.due_amount desc, pi.id desc';
    else                    v_order := 'pi.invoice_date desc, pi.id desc';
  end case;

  execute format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select pi.id, pi.invoice_number, pi.supplier_name, pi.supplier_invoice_no,
             pi.po_number, pi.invoice_date, pi.status, pi.payment_status,
             pi.subtotal, pi.discount_total, pi.tax_total, pi.grand_total,
             pi.paid_amount, pi.due_amount,
             coalesce(it.items, 0) as items,
             coalesce(it.qty, 0)   as quantity
      from public.purchase_invoices pi
      left join lateral (
        select count(*) as items, sum(pii.quantity) as qty
        from public.purchase_invoice_items pii where pii.invoice_id = pi.id
      ) it on true
      where %s
      order by %s
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), v_order, p_limit, p_offset) into v_rows;

  execute format('select count(*) from public.purchase_invoices pi where %s',
                 array_to_string(v_where, ' and ')) into v_total;

  execute format($sql$
    select jsonb_build_object(
      'invoices',  count(*),
      'value',     coalesce(round(sum(pi.grand_total), 2), 0),
      'tax',       coalesce(round(sum(pi.tax_total), 2), 0),
      'discounts', coalesce(round(sum(pi.discount_total), 2), 0),
      'paid',      coalesce(round(sum(pi.paid_amount), 2), 0),
      'due',       coalesce(round(sum(pi.due_amount), 2), 0),
      'returns_value', coalesce((
        select round(sum(pr.grand_total), 2) from public.purchase_returns pr
        where pr.return_date >= %L::timestamptz and pr.return_date < %L::timestamptz), 0)
    )
    from public.purchase_invoices pi
    where %s
  $sql$, v_from_ts, v_to_ts, array_to_string(v_where, ' and ')) into v_summary;

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'total_is_estimate', false, 'summary', v_summary);
end $$;

revoke all on function public.purchase_report(date, date, text, uuid, text, text, text, int, int) from public, anon;
grant execute on function public.purchase_report(date, date, text, uuid, text, text, text, int, int) to authenticated, service_role;

-- ===========================================================================
-- PART 13 — supplier_report(...)  per-supplier aggregates
-- ===========================================================================
-- Purchases / payments / returns are window sums; outstanding is the
-- all-time payable balance (point-in-time).

create or replace function public.supplier_report(
  p_date_from date default null,
  p_date_to   date default null,
  p_search    text default null,
  p_sort      text default 'purchases_desc',
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz       text;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
  v_where    text[] := array['true'];
  v_order    text;
  v_rows     jsonb;
  v_total    bigint;
  v_summary  jsonb;
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

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_where := v_where || format('(sup.name ILIKE %1$L OR sup.phone ILIKE %1$L OR sup.gstin ILIKE %1$L)',
                                  '%' || trim(p_search) || '%');
  end if;

  case p_sort
    when 'purchases_asc'   then v_order := 'purchase_value asc, sup.name asc';
    when 'outstanding_desc' then v_order := 'outstanding desc, sup.name asc';
    when 'payments_desc'   then v_order := 'payments desc, sup.name asc';
    when 'name_asc'        then v_order := 'sup.name asc';
    else                        v_order := 'purchase_value desc, sup.name asc';
  end case;

  execute format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select sup.id, sup.name, sup.phone, sup.gstin, sup.is_active,
             coalesce(pur.value, 0)      as purchase_value,
             coalesce(pur.invoices, 0)   as invoices,
             coalesce(pay.paid, 0)       as payments,
             coalesce(ret.value, 0)      as returns_value,
             coalesce(du.outstanding, 0) as outstanding
      from public.suppliers sup
      left join lateral (
        select coalesce(sum(pi.grand_total), 0) as value, count(*) as invoices
        from public.purchase_invoices pi
        where pi.supplier_id = sup.id
          and pi.status = 'RECEIVED'
          and pi.invoice_date >= %L::timestamptz and pi.invoice_date < %L::timestamptz
      ) pur on true
      left join lateral (
        select coalesce(sum(sp.amount), 0) as paid
        from public.supplier_payments sp
        where sp.supplier_id = sup.id
          and sp.recorded_at >= %L::timestamptz and sp.recorded_at < %L::timestamptz
      ) pay on true
      left join lateral (
        select coalesce(sum(pr.grand_total), 0) as value
        from public.purchase_returns pr
        where pr.supplier_id = sup.id
          and pr.return_date >= %L::timestamptz and pr.return_date < %L::timestamptz
      ) ret on true
      left join lateral (
        select coalesce(sum(pi.due_amount), 0) as outstanding
        from public.purchase_invoices pi
        where pi.supplier_id = sup.id and pi.status = 'RECEIVED'
      ) du on true
      where %s
      order by %s
      limit %s offset %s
    ) t
  $sql$, v_from_ts, v_to_ts, v_from_ts, v_to_ts, v_from_ts, v_to_ts,
         array_to_string(v_where, ' and '), v_order, p_limit, p_offset) into v_rows;

  execute format('select count(*) from public.suppliers sup where %s',
                 array_to_string(v_where, ' and ')) into v_total;

  execute format($sql$
    select jsonb_build_object(
      'suppliers',    count(*),
      'active',       coalesce(sum(case when sup.is_active then 1 else 0 end), 0),
      'purchase_value', coalesce(round(sum(pur.value), 2), 0),
      'payments',     coalesce(round(sum(pay.paid), 2), 0),
      'returns_value',coalesce(round(sum(ret.value), 2), 0),
      'outstanding',  coalesce(round(sum(du.outstanding), 2), 0)
    )
    from public.suppliers sup
    left join lateral (
      select coalesce(sum(pi.grand_total), 0) as value
      from public.purchase_invoices pi
      where pi.supplier_id = sup.id and pi.status = 'RECEIVED'
        and pi.invoice_date >= %L::timestamptz and pi.invoice_date < %L::timestamptz
    ) pur on true
    left join lateral (
      select coalesce(sum(sp.amount), 0) as paid
      from public.supplier_payments sp
      where sp.supplier_id = sup.id
        and sp.recorded_at >= %L::timestamptz and sp.recorded_at < %L::timestamptz
    ) pay on true
    left join lateral (
      select coalesce(sum(pr.grand_total), 0) as value
      from public.purchase_returns pr
      where pr.supplier_id = sup.id
        and pr.return_date >= %L::timestamptz and pr.return_date < %L::timestamptz
    ) ret on true
    left join lateral (
      select coalesce(sum(pi.due_amount), 0) as outstanding
      from public.purchase_invoices pi
      where pi.supplier_id = sup.id and pi.status = 'RECEIVED'
    ) du on true
    where %s
  $sql$, v_from_ts, v_to_ts, v_from_ts, v_to_ts, v_from_ts, v_to_ts,
         array_to_string(v_where, ' and ')) into v_summary;

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'total_is_estimate', false, 'summary', v_summary);
end $$;

revoke all on function public.supplier_report(date, date, text, text, int, int) from public, anon;
grant execute on function public.supplier_report(date, date, text, text, int, int) to authenticated, service_role;

-- ===========================================================================
-- PART 14 — customer_report(...)  per-customer aggregates
-- ===========================================================================
-- Purchases / payments / returns are window sums; outstanding and advance
-- are all-time point-in-time balances (consistent with customer_detail).

create or replace function public.customer_report(
  p_date_from date default null,
  p_date_to   date default null,
  p_search    text default null,
  p_type      text default null,
  p_sort      text default 'purchases_desc',
  p_limit     int  default 25,
  p_offset    int  default 0
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz       text;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
  v_where    text[] := array['true'];
  v_order    text;
  v_rows     jsonb;
  v_total    bigint;
  v_summary  jsonb;
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

  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_where := v_where || format('(c.name ILIKE %1$L OR c.phone ILIKE %1$L OR c.email ILIKE %1$L)',
                                  '%' || trim(p_search) || '%');
  end if;
  if p_type in ('retail', 'wholesale') then
    v_where := v_where || format('c.customer_type = %L', p_type);
  end if;

  case p_sort
    when 'purchases_asc'   then v_order := 'purchases asc, c.name asc';
    when 'outstanding_desc' then v_order := 'outstanding desc, c.name asc';
    when 'payments_desc'   then v_order := 'payments desc, c.name asc';
    when 'bills_desc'      then v_order := 'bills desc, c.name asc';
    when 'name_asc'        then v_order := 'c.name asc';
    else                        v_order := 'purchases desc, c.name asc';
  end case;

  execute format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select c.id, c.name, c.phone, c.customer_type, c.is_active,
             coalesce(bil.value, 0)      as purchases,
             coalesce(bil.bills, 0)      as bills,
             coalesce(bil.days, 0)       as purchase_days,
             bil.last_purchase,
             coalesce(pay.paid, 0)       as payments,
             coalesce(ret.value, 0)      as returns_value,
             coalesce(du.outstanding, 0) as outstanding,
             coalesce(adv.advance, 0)    as advance
      from public.customers c
      left join lateral (
        select coalesce(sum(s.grand_total), 0) as value,
               count(*) as bills,
               count(distinct (s.sale_date at time zone %L)::date) as days,
               max(s.sale_date) as last_purchase
        from public.sales s
        where s.customer_id = c.id and s.status = 'COMPLETED'
          and s.sale_date >= %L::timestamptz and s.sale_date < %L::timestamptz
      ) bil on true
      left join lateral (
        select coalesce(sum(cp.amount), 0) as paid
        from public.customer_payments cp
        where cp.customer_id = c.id
          and cp.recorded_at >= %L::timestamptz and cp.recorded_at < %L::timestamptz
      ) pay on true
      left join lateral (
        select coalesce(sum(r.applied_to_due + r.refund_amount), 0) as value
        from public.sales_returns r
        where r.customer_id = c.id
          and r.return_date >= %L::timestamptz and r.return_date < %L::timestamptz
      ) ret on true
      left join lateral (
        select coalesce(sum(s.due_amount), 0) as outstanding
        from public.sales s
        where s.customer_id = c.id and s.status = 'COMPLETED'
      ) du on true
      left join lateral (
        select coalesce(sum(cp.amount - cp.allocated_amount), 0) as advance
        from public.customer_payments cp
        where cp.customer_id = c.id
      ) adv on true
      where %s
      order by %s
      limit %s offset %s
    ) t
  $sql$, v_tz, v_from_ts, v_to_ts, v_from_ts, v_to_ts, v_from_ts, v_to_ts,
         array_to_string(v_where, ' and '), v_order, p_limit, p_offset) into v_rows;

  execute format('select count(*) from public.customers c where %s',
                 array_to_string(v_where, ' and ')) into v_total;

  execute format($sql$
    select jsonb_build_object(
      'customers',    count(*),
      'active',       coalesce(sum(case when c.is_active then 1 else 0 end), 0),
      'with_purchases', coalesce(sum(case when bil.bills > 0 then 1 else 0 end), 0),
      'purchases',    coalesce(round(sum(bil.value), 2), 0),
      'payments',     coalesce(round(sum(pay.paid), 2), 0),
      'returns_value',coalesce(round(sum(ret.value), 2), 0),
      'outstanding',  coalesce(round(sum(du.outstanding), 2), 0),
      'advance',      coalesce(round(sum(adv.advance), 2), 0)
    )
    from public.customers c
    left join lateral (
      select coalesce(sum(s.grand_total), 0) as value, count(*) as bills
      from public.sales s
      where s.customer_id = c.id and s.status = 'COMPLETED'
        and s.sale_date >= %L::timestamptz and s.sale_date < %L::timestamptz
    ) bil on true
    left join lateral (
      select coalesce(sum(cp.amount), 0) as paid
      from public.customer_payments cp
      where cp.customer_id = c.id
        and cp.recorded_at >= %L::timestamptz and cp.recorded_at < %L::timestamptz
    ) pay on true
    left join lateral (
      select coalesce(sum(r.applied_to_due + r.refund_amount), 0) as value
      from public.sales_returns r
      where r.customer_id = c.id
        and r.return_date >= %L::timestamptz and r.return_date < %L::timestamptz
    ) ret on true
    left join lateral (
      select coalesce(sum(s.due_amount), 0) as outstanding
      from public.sales s
      where s.customer_id = c.id and s.status = 'COMPLETED'
    ) du on true
    left join lateral (
      select coalesce(sum(cp.amount - cp.allocated_amount), 0) as advance
      from public.customer_payments cp
      where cp.customer_id = c.id
    ) adv on true
    where %s
  $sql$, v_from_ts, v_to_ts, v_from_ts, v_to_ts, v_from_ts, v_to_ts,
         array_to_string(v_where, ' and ')) into v_summary;

  return jsonb_build_object('rows', v_rows, 'total', v_total,
                            'total_is_estimate', false, 'summary', v_summary);
end $$;

revoke all on function public.customer_report(date, date, text, text, text, int, int) from public, anon;
grant execute on function public.customer_report(date, date, text, text, text, int, int) to authenticated, service_role;

-- ===========================================================================
-- PART 15 — expense_report(p_date_from, p_date_to)
-- ===========================================================================
-- Scope: PENDING + APPROVED expenses (CANCELLED excluded), matching
-- payments_page / expenses_page conventions.

create or replace function public.expense_report(
  p_date_from date default null,
  p_date_to   date default null
)
returns jsonb
language plpgsql
stable
security definer set search_path = public as $$
declare
  v_tz        text;
  v_from_date date;
  v_to_date   date;
  v_summary   jsonb;
  v_category  jsonb;
  v_method    jsonb;
  v_location  jsonb;
  v_day       jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_date := coalesce(p_date_from, '1970-01-01'::date);
  v_to_date   := coalesce(p_date_to, (now() at time zone v_tz)::date);

  select jsonb_build_object(
    'count',         count(*),
    'total',         coalesce(round(sum(e.amount), 2), 0),
    'pending_count', coalesce(sum(case when e.status = 'PENDING' then 1 else 0 end), 0),
    'pending_total', coalesce(round(sum(case when e.status = 'PENDING' then e.amount else 0 end), 2), 0),
    'approved_count',coalesce(sum(case when e.status = 'APPROVED' then 1 else 0 end), 0),
    'approved_total',coalesce(round(sum(case when e.status = 'APPROVED' then e.amount else 0 end), 2), 0)
  ) into v_summary
  from public.expenses e
  where e.status in ('PENDING', 'APPROVED')
    and e.expense_date >= v_from_date and e.expense_date <= v_to_date;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_category
  from (
    select e.category_name as name, count(*) as count, round(sum(e.amount), 2) as amount
    from public.expenses e
    where e.status in ('PENDING', 'APPROVED')
      and e.expense_date >= v_from_date and e.expense_date <= v_to_date
    group by e.category_name
    order by 3 desc
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_method
  from (
    select e.method, count(*) as count, round(sum(e.amount), 2) as amount
    from public.expenses e
    where e.status in ('PENDING', 'APPROVED')
      and e.expense_date >= v_from_date and e.expense_date <= v_to_date
    group by e.method
    order by 3 desc
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_location
  from (
    select coalesce(e.location_name, 'Unassigned') as name,
           count(*) as count, round(sum(e.amount), 2) as amount
    from public.expenses e
    where e.status in ('PENDING', 'APPROVED')
      and e.expense_date >= v_from_date and e.expense_date <= v_to_date
    group by coalesce(e.location_name, 'Unassigned')
    order by 3 desc
  ) t;

  select coalesce(jsonb_agg(t), '[]'::jsonb) into v_day
  from (
    select to_char(e.expense_date, 'YYYY-MM-DD') as day,
           count(*) as count, round(sum(e.amount), 2) as amount
    from public.expenses e
    where e.status in ('PENDING', 'APPROVED')
      and e.expense_date >= v_from_date and e.expense_date <= v_to_date
    group by e.expense_date
    order by e.expense_date
  ) t;

  return jsonb_build_object(
    'summary', v_summary, 'by_category', v_category, 'by_method', v_method,
    'by_location', v_location, 'by_day', v_day);
end $$;

revoke all on function public.expense_report(date, date) from public, anon;
grant execute on function public.expense_report(date, date) to authenticated, service_role;

-- ===========================================================================
-- PART 16 — returns_report(p_date_from, p_date_to)
-- ===========================================================================

create or replace function public.returns_report(
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
  v_sr       jsonb;
  v_ex       jsonb;
  v_pr       jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_reports') then
    raise exception 'You do not have permission to view reports.';
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts := coalesce(p_date_from, '1970-01-01'::date)::timestamp at time zone v_tz;
  v_to_ts   := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;

  select jsonb_build_object(
    'count',           count(*),
    'quantity',        coalesce((select sum(sri.quantity)
                                  from public.sales_return_items sri
                                  join public.sales_returns r2 on r2.id = sri.return_id
                                  where r2.return_date >= v_from_ts
                                    and r2.return_date <  v_to_ts), 0),
    'value',           coalesce(round(sum(r.applied_to_due + r.refund_amount), 2), 0),
    'refund_amount',   coalesce(round(sum(r.refund_amount), 2), 0),
    'applied_to_due',  coalesce(round(sum(r.applied_to_due), 2), 0),
    'by_reason',       coalesce((select jsonb_agg(t) from (
                                   select r2.reason, count(*) as count,
                                          round(sum(r2.applied_to_due + r2.refund_amount), 2) as value
                                   from public.sales_returns r2
                                   where r2.return_date >= v_from_ts and r2.return_date < v_to_ts
                                   group by r2.reason
                                   order by 3 desc
                                 ) t), '[]'::jsonb),
    'by_condition',    coalesce((select jsonb_agg(t) from (
                                   select sri.condition, sum(sri.quantity) as quantity,
                                          round(sum(sri.line_refund), 2) as value
                                   from public.sales_return_items sri
                                   join public.sales_returns r2 on r2.id = sri.return_id
                                   where r2.return_date >= v_from_ts and r2.return_date < v_to_ts
                                   group by sri.condition
                                 ) t), '[]'::jsonb),
    'by_day',          coalesce((select jsonb_agg(t) from (
                                   select to_char((r2.return_date at time zone v_tz)::date, 'YYYY-MM-DD') as day,
                                          count(*) as count,
                                          round(sum(r2.applied_to_due + r2.refund_amount), 2) as value
                                   from public.sales_returns r2
                                   where r2.return_date >= v_from_ts and r2.return_date < v_to_ts
                                   group by (r2.return_date at time zone v_tz)::date
                                   order by (r2.return_date at time zone v_tz)::date
                                 ) t), '[]'::jsonb)
  ) into v_sr
  from public.sales_returns r
  where r.return_date >= v_from_ts and r.return_date < v_to_ts;

  select jsonb_build_object(
    'count',         count(*),
    'return_value',  coalesce(round(sum(e.return_value), 2), 0),
    'issue_value',   coalesce(round(sum(e.issue_value), 2), 0),
    'difference',    coalesce(round(sum(e.difference_amount), 2), 0),
    'collected',     coalesce(round(sum(e.payment_amount), 2), 0),
    'refunded',      coalesce(round(sum(case when e.difference_amount < 0
                                            then -e.difference_amount else 0 end), 2), 0),
    'by_day',        coalesce((select jsonb_agg(t) from (
                                 select to_char((e2.exchange_date at time zone v_tz)::date, 'YYYY-MM-DD') as day,
                                        count(*) as count,
                                        round(sum(e2.difference_amount), 2) as value
                                 from public.exchanges e2
                                 where e2.exchange_date >= v_from_ts and e2.exchange_date < v_to_ts
                                 group by (e2.exchange_date at time zone v_tz)::date
                                 order by (e2.exchange_date at time zone v_tz)::date
                               ) t), '[]'::jsonb)
  ) into v_ex
  from public.exchanges e
  where e.exchange_date >= v_from_ts and e.exchange_date < v_to_ts;

  select jsonb_build_object(
    'count',          count(*),
    'value',          coalesce(round(sum(pr.grand_total), 2), 0),
    'applied_to_due', coalesce(round(sum(pr.applied_to_due), 2), 0),
    'by_supplier',    coalesce((select jsonb_agg(t) from (
                                  select pr2.supplier_name as name, count(*) as count,
                                         round(sum(pr2.grand_total), 2) as value
                                  from public.purchase_returns pr2
                                  where pr2.return_date >= v_from_ts and pr2.return_date < v_to_ts
                                  group by pr2.supplier_name
                                  order by 3 desc
                                ) t), '[]'::jsonb)
  ) into v_pr
  from public.purchase_returns pr
  where pr.return_date >= v_from_ts and pr.return_date < v_to_ts;

  return jsonb_build_object('sales_returns', v_sr, 'exchanges', v_ex,
                            'purchase_returns', v_pr);
end $$;

revoke all on function public.returns_report(date, date) from public, anon;
grant execute on function public.returns_report(date, date) to authenticated, service_role;

-- ===========================================================================
-- PART 17 — cash_report(p_date)  daily cash position
-- ===========================================================================
-- Ledger-derived (no separate cash register module exists). Money in:
-- till Cash payments (mirror-safe), Cash customer receipts. Money out:
-- Cash refunds (sales returns + exchange refunds), Cash expenses
-- (PENDING + APPROVED), Cash supplier payments. Opening = the same
-- ledger cumulative before the day. Known limitation (documented): an
-- expense cancelled after the fact shifts later days by that amount.

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
    'cash_refunds',   round(v_refunds, 2),
    'cash_expenses',  round(v_expenses, 2),
    'cash_supplier',  round(v_supplier, 2),
    'total_in',       round(v_sales + v_receipts, 2),
    'total_out',      round(v_refunds + v_expenses + v_supplier, 2),
    'expected_cash',  round(v_opening + v_sales + v_receipts
                            - v_refunds - v_expenses - v_supplier, 2),
    'note', 'Ledger-derived daily cash position. Till cash = genuine checkout '
            'cash (receipt mirrors excluded). Expenses include PENDING + '
            'APPROVED; a later cancellation shifts subsequent days.'
  );
end $$;

revoke all on function public.cash_report(date) from public, anon;
grant execute on function public.cash_report(date) to authenticated, service_role;

-- ===========================================================================
-- PART 18 — audit_page(...)  admin audit log viewer
-- ===========================================================================

create or replace function public.audit_page(
  p_search      text default null,
  p_action      text default null,
  p_user_id     uuid default null,
  p_date_from   date default null,
  p_date_to     date default null,
  p_entity_type text default null,
  p_limit       int  default 25,
  p_offset      int  default 0
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
  v_rows      jsonb;
  v_total     bigint;
  v_action    public.audit_action;
  v_actions   jsonb;
  v_entities  jsonb;
  v_users     jsonb;
begin
  if auth.uid() is not null
     and not public.has_app_permission('view_audit_logs') then
    raise exception 'You do not have permission to view audit logs.';
  end if;

  if nullif(trim(coalesce(p_action, '')), '') is not null then
    begin
      v_action := trim(p_action)::public.audit_action;
    exception when invalid_text_representation then
      raise exception 'INVALID_ACTION: unknown audit action "%".', trim(p_action);
    end;
  end if;

  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');
  v_from_ts := coalesce(p_date_from, '1970-01-01'::date)::timestamp at time zone v_tz;
  v_to_ts   := ((coalesce(p_date_to, (now() at time zone v_tz)::date) + 1))::timestamp at time zone v_tz;

  p_limit  := least(greatest(coalesce(p_limit, 25), 1), 10000);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  v_where := v_where || format('a.created_at >= %L::timestamptz', v_from_ts);
  v_where := v_where || format('a.created_at < %L::timestamptz', v_to_ts);
  if v_action is not null then
    v_where := v_where || format('a.action = %L::public.audit_action', v_action);
  end if;
  if p_user_id is not null then
    v_where := v_where || format('a.user_id = %L', p_user_id);
  end if;
  if nullif(trim(coalesce(p_entity_type, '')), '') is not null then
    v_where := v_where || format('a.entity_type = %L', trim(p_entity_type));
  end if;
  if nullif(trim(coalesce(p_search, '')), '') is not null then
    v_where := v_where || format(
      '(a.user_email ILIKE %1$L OR a.entity_id ILIKE %1$L OR a.entity_type ILIKE %1$L OR a.action::text ILIKE %1$L OR a.metadata::text ILIKE %1$L)',
      '%' || trim(p_search) || '%');
  end if;

  execute format($sql$
    select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select a.id, a.created_at, a.user_id, a.user_email,
             a.action::text as action, a.entity_type, a.entity_id,
             a.metadata, a.old_values, a.new_values
      from public.audit_logs a
      where %s
      order by a.created_at desc, a.id desc
      limit %s offset %s
    ) t
  $sql$, array_to_string(v_where, ' and '), p_limit, p_offset) into v_rows;

  execute format('select count(*) from public.audit_logs a where %s',
                 array_to_string(v_where, ' and ')) into v_total;

  select coalesce(jsonb_agg(e::text), '[]'::jsonb) into v_actions
  from unnest(enum_range(null::public.audit_action)) e;

  select coalesce(jsonb_agg(distinct a.entity_type), '[]'::jsonb) into v_entities
  from public.audit_logs a;

  select coalesce(jsonb_agg(distinct a.user_email), '[]'::jsonb) into v_users
  from public.audit_logs a;

  return jsonb_build_object(
    'rows', v_rows, 'total', v_total, 'total_is_estimate', false,
    'actions', v_actions, 'entity_types', v_entities, 'user_emails', v_users);
end $$;

revoke all on function public.audit_page(text, text, uuid, date, date, text, int, int) from public, anon;
grant execute on function public.audit_page(text, text, uuid, date, date, text, int, int) to authenticated, service_role;

commit;
