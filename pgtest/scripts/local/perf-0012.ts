/**
 * 0012 large-dataset architecture validation (local harness only).
 * Seeds ~50k sales / ~150k sale_items / 20k payments / 4k variants and runs
 * EXPLAIN (ANALYZE, BUFFERS) on the report queries that matter at scale.
 * No data is left behind that affects functional tests (purge at start;
 * the dataset stays for inspection and is wiped by reset-full.ts).
 *
 * Run from pgtest/: bun run scripts/local/perf-0012.ts
 */
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }

async function main() {
  const c = new Client(CONN)
  await c.connect()

  // clean slate for the perf dataset (keep the functional data purged too)
  await c.query('set role postgres')
  await c.query('alter table public.stock_movements disable trigger stock_movements_append_only')
  await c.query('alter table public.stock_balances disable trigger stock_balances_engine_guard')
  for (const t of ['exchange_items_in', 'exchange_items_out', 'exchanges', 'sales_return_items',
    'sales_returns', 'purchase_return_items', 'purchase_returns', 'customer_payment_allocations',
    'customer_payments', 'supplier_payment_allocations', 'supplier_payments', 'sale_payments',
    'sale_items', 'sales', 'held_bills', 'purchase_invoice_items', 'purchase_invoices',
    'purchase_order_items', 'purchase_orders', 'suppliers', 'customers', 'expenses',
    'sale_number_counters', 'audit_logs', 'stock_movements', 'stock_balances',
    'product_variants', 'products', 'categories', 'brands', 'sizes', 'colors']) {
    await c.query(`delete from public.${t}`)
  }
  await c.query('alter table public.stock_balances enable trigger stock_balances_engine_guard')
  await c.query('alter table public.stock_movements enable trigger stock_movements_append_only')

  console.log('seeding catalog…')
  const cat = (await c.query(`insert into public.categories (name) values ('PerfCat') returning id`)).rows[0].id
  const brand = (await c.query(`insert into public.brands (name) values ('PerfBrand') returning id`)).rows[0].id
  const prod = (await c.query(
    `insert into public.products (name, category_id, brand_id, hsn_code, gst_rate, mrp, cost_price, selling_price)
     values ('Perf Shirt', $1, $2, '620520', 5, 999, 400, 799) returning id`, [cat, brand])).rows[0].id
  await c.query(`insert into public.product_variants (product_id, sku, cost_price, mrp, selling_price)
     select $1, 'PERF-' || g, 400, 999, 799 from generate_series(1, 4000) g`, [prod])
  await c.query('analyze public.product_variants')

  console.log('seeding 50k sales / 150k items / 60k payments (direct, engine-free)…')
  await c.query(`
    insert into public.sales (sale_number, sale_date, customer_name, cashier_name, location_name,
      status, payment_status, subtotal, item_discount_total, tax_total, grand_total, paid_amount, due_amount, tax_mode)
    select 'PERF-' || lpad(g::text, 6, '0'),
           now() - (random() * 365) * interval '1 day',
           'Customer ' || (g % 500), 'Cashier ' || (g % 20), 'Main Store',
           'COMPLETED', case when g % 10 = 0 then 'PARTIALLY_PAID' else 'PAID' end,
           1000, 50, 40, 950, case when g % 10 = 0 then 450 else 950 end,
           case when g % 10 = 0 then 500 else 0 end, 'inclusive'
    from generate_series(1, 50000) g`)
  await c.query(`
    with numbered as (
      select s.id, row_number() over (order by s.sale_date, s.id) as rn
      from public.sales s
    )
    insert into public.sale_items (sale_id, variant_id, product_name, sku, quantity,
      base_price, unit_price, discount_amount, tax_amount, line_total)
    select n.id, pv.id, 'Perf Shirt', pv.sku, 1 + (n.rn % 3),
      799, 799, 10, 30, 789
    from numbered n
    join public.product_variants pv on pv.sku = 'PERF-' || ((n.rn % 4000) + 1)::text`)
  await c.query(`
    insert into public.sale_payments (sale_id, method, amount, is_credit, created_at)
    select s.id,
           case (hashtext(s.sale_number) & 3) when 0 then 'Cash' when 1 then 'UPI' when 2 then 'Card' else 'Bank Transfer' end,
           s.paid_amount, false, s.sale_date
    from public.sales s where s.paid_amount > 0`)
  await c.query('analyze public.sales')
  await c.query('analyze public.sale_items')
  await c.query('analyze public.sale_payments')
  console.log('seeded.')

  const queries: { name: string; sql: string }[] = [
    { name: 'sales_report page (date range)', sql: `select * from public.sales_report(p_date_from => current_date - 30, p_date_to => current_date, p_limit => 25, p_offset => 0)` },
    { name: 'sales_report summary (same filters)', sql: `select (public.sales_report(p_date_from => current_date - 30, p_date_to => current_date, p_limit => 0))->'summary'` },
    { name: 'product_sales_report (30d)', sql: `select * from public.product_sales_report(p_date_from => current_date - 30, p_date_to => current_date, p_limit => 25, p_offset => 0)` },
    { name: 'payment_report (30d)', sql: `select public.payment_report(p_date_from => current_date - 30, p_date_to => current_date)` },
    { name: 'gst_report (30d)', sql: `select public.gst_report(p_date_from => current_date - 30, p_date_to => current_date)` },
    { name: 'dashboard_summary (30d)', sql: `select public.dashboard_summary(p_from => current_date - 30, p_to => current_date)` },
    { name: 'profit_report (30d)', sql: `select public.profit_report(p_date_from => current_date - 30, p_to_date => null)`.replace('p_to_date', 'p_date_to') },
    { name: 'stock_valuation_report', sql: `select * from public.stock_valuation_report(p_limit => 25, p_offset => 0)` },
    { name: 'stock_performance_report (90d)', sql: `select * from public.stock_performance_report(p_date_from => current_date - 90, p_date_to => current_date, p_limit => 25, p_offset => 0)` },
    { name: 'customer_report (30d)', sql: `select * from public.customer_report(p_date_from => current_date - 30, p_date_to => current_date, p_limit => 25, p_offset => 0)` },
    { name: 'audit_page (30d)', sql: `select * from public.audit_page(p_date_from => current_date - 30, p_date_to => current_date, p_limit => 25, p_offset => 0)` },
  ]

  console.log('\nrunning EXPLAIN ANALYZE…')
  for (const q of queries) {
    try {
      const res = await c.query(`explain (analyze, costs off, timing off, summary on) ${q.sql}`)
      const planLines = res.rows.map((r: any) => Object.values(r)[0] as string)
      const scans = planLines.filter((l) => /Seq Scan/.test(l)).length
      const idx = planLines.filter((l) => /Index Scan|Index Only Scan|Bitmap/.test(l)).length
      const execMatch = planLines.join('\n').match(/Execution Time: ([\d.]+) ms/)
      const ms = execMatch ? execMatch[1] : '?'
      console.log(`  ${q.name}: ${ms} ms (seq scans: ${scans}, index scans: ${idx})`)
    } catch (e) {
      console.log(`  ${q.name}: FAILED ${(e as Error).message.split('\n')[0]}`)
    }
  }

  await c.end()
}

main().catch((e) => { console.error('CRASH', e); process.exit(1) })
