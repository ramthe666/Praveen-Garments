#!/usr/bin/env bun
/**
 * 0012 cloud deployment verification (READ-ONLY — no writes, no data changes).
 *
 * Verifies the Phase 5 reporting layer the user just applied on the cloud:
 *   1. Deployment fingerprint — all 16 public report RPCs live in the
 *      PostgREST schema cache (service-role view); internal
 *      variant_unit_costs() refused for unauthenticated callers (anon key
 *      -> 401 permission denied — verified on cloud: revokes from
 *      public/anon/authenticated are effective; service_role retains execute
 *      as the trusted backend role, which is acceptable); report RPCs not
 *      callable with the anon key either (grants hardening).
 *   2. Functional audit — dashboard_summary / sales_report / payment_report /
 *      customer_report outputs recomputed independently from raw tables and
 *      compared to the paisa (same technique as 0011-cloud-verify).
 *   3. Data untouched — core row counts vs the 0011 audit baseline
 *      (informational; 0012 contains no DML, so it cannot change data).
 *
 * Run: cd Praveen-Garments && set -a && . ./.env.local && set +a && \
 *      bun run scripts/0012-cloud-verify.ts
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

if (!SERVICE_KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

// 16 public report RPCs (audit_page included) — variant_unit_costs is internal
const REPORT_RPCS = [
  'dashboard_summary', 'sales_report', 'product_sales_report', 'catalog_performance_report',
  'payment_report', 'gst_report', 'profit_report', 'stock_valuation_report',
  'stock_performance_report', 'purchase_report', 'supplier_report', 'customer_report',
  'expense_report', 'returns_report', 'cash_report', 'audit_page',
]
const INTERNAL_RPC = 'variant_unit_costs'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`) }
}
const r = (n: number, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f }
const eq = (a: unknown, b: unknown, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol
async function section(name: string, fn: () => Promise<void>) {
  console.log(`\n== ${name} ==`)
  try { await fn() } catch (e: any) { fail++; console.log(`  FAIL section crashed: ${e.message}`) }
}

async function getAll(path: string): Promise<any[]> {
  const rows: any[] = []
  let offset = 0
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=1000&offset=${offset}`, { headers: H })
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`)
    const page = (await res.json()) as any[]
    rows.push(...page)
    if (page.length < 1000) return rows
    offset += 1000
  }
}
async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: H, body: JSON.stringify(args) })
  if (!res.ok) throw new Error(`rpc ${name} -> ${res.status}: ${await res.text()}`)
  return res.json()
}
async function rpcRaw(name: string, args: Record<string, unknown>, key: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { status: res.status, text: await res.text() }
}

// ===========================================================================
// SECTION 0 — deployment fingerprint (OpenAPI + grant hardening)
// ===========================================================================
await section('DEPLOYMENT FINGERPRINT', async () => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } })
  if (!res.ok) throw new Error(`OpenAPI fetch -> ${res.status}`)
  const spec = await res.json()
  const rpcNames: string[] = Object.keys(spec.paths ?? {})
    .filter((p: string) => p.startsWith('/rpc/'))
    .map((p: string) => p.slice(5))
  const tables = Object.keys(spec.definitions ?? {})
  console.log(`  schema cache: ${rpcNames.length} rpcs, ${tables.length} tables/views (service-role view)`)

  for (const name of REPORT_RPCS) check(`rpc live in schema cache: ${name}`, rpcNames.includes(name))
  check(`0011 customer_statement still live`, rpcNames.includes('customer_statement'))
  check('control: unknown rpc absent from schema cache', !rpcNames.includes('pgtest_missing_fn_xyz'))

  // internal helper + report rpcs must NOT be callable with the anon key
  // (revokes from public/anon/authenticated verified effective; service_role
  // retains execute — trusted backend role, acceptable by design)
  if (ANON_KEY) {
    const helperProbe = await rpcRaw(INTERNAL_RPC, {}, ANON_KEY)
    check(`internal helper ${INTERNAL_RPC} refused for anon key (401/403/404)`,
      [401, 403, 404].includes(helperProbe.status), { status: helperProbe.status, text: helperProbe.text.slice(0, 120) })
    const anonProbe = await rpcRaw('sales_report', { p_status: 'COMPLETED' }, ANON_KEY)
    check('report rpc not callable with anon key (grants hardening)', [401, 403, 404].includes(anonProbe.status), { status: anonProbe.status })
    const anonCtrl = await rpcRaw('pgtest_missing_fn_xyz', {}, ANON_KEY)
    check('control: unknown rpc 404 with anon key too', anonCtrl.status === 404, { status: anonCtrl.status })
  } else {
    console.log('  (anon key not set — skipping anon probe)')
  }
})

// ===========================================================================
// SECTION 1 — raw data load (independent recomputation basis)
// ===========================================================================
const [customers, sales, saleItems, salePayments, custPayments, returns,
  expenses, supplierPayments, exchanges, purchaseInvoices, purchaseReturns,
  purchaseInvoiceItems, stockBalances, variants, products, suppliers,
  returnItems, exchItemsIn] = await Promise.all([
  getAll('customers?select=id,name,phone,is_active,customer_type'),
  getAll('sales?select=id,sale_number,customer_id,customer_name,customer_phone,grand_total,paid_amount,due_amount,status,sale_date,tax_total,item_discount_total,bill_discount,round_off'),
  getAll('sale_items?select=id,sale_id,quantity,variant_id'),
  getAll('sale_payments?select=id,sale_id,method,amount,reference,is_credit,created_at'),
  getAll('customer_payments?select=id,receipt_number,customer_id,amount,allocated_amount,method,recorded_at'),
  getAll('sales_returns?select=id,customer_id,applied_to_due,refund_amount,refund_method,return_date'),
  getAll('expenses?select=id,method,amount,status,expense_date'),
  getAll('supplier_payments?select=id,method,amount,allocated_amount,recorded_at'),
  getAll('exchanges?select=id,payment_method,difference_amount,exchange_date'),
  getAll('purchase_invoices?select=id,grand_total,tax_total,due_amount,status,invoice_date'),
  getAll('purchase_returns?select=id,grand_total,return_date'),
  getAll('purchase_invoice_items?select=id,invoice_id,variant_id,quantity,returned_quantity,line_total,tax_amount'),
  getAll('stock_balances?select=variant_id,quantity'),
  getAll('product_variants?select=id,cost_price,selling_price,product_id'),
  getAll('products?select=id,cost_price,selling_price'),
  getAll('suppliers?select=id,is_active'),
  getAll('sales_return_items?select=id,sale_item_id,quantity'),
  getAll('exchange_items_in?select=id,sale_item_id,quantity'),
])

console.log(`\n== RAW DATA (row counts; 0011-audit baseline in parentheses) ==`)
console.log(`  customers ${customers.length} (1) | sales ${sales.length} (10) | sale_payments ${salePayments.length} (13)`)
console.log(`  customer_payments ${custPayments.length} (1) | sales_returns ${returns.length} (1)`)
console.log(`  [info] sale_items ${saleItems.length}, expenses ${expenses.length}, supplier_payments ${supplierPayments.length},`)
console.log(`  exchanges ${exchanges.length}, purchase_invoices ${purchaseInvoices.length}, purchase_returns ${purchaseReturns.length},`)
console.log(`  purchase_invoice_items ${purchaseInvoiceItems.length}, stock_balances ${stockBalances.length},`)
console.log(`  product_variants ${variants.length}, products ${products.length}, suppliers ${suppliers.length}`)

// ---- shared recomputation basis -------------------------------------------
const completed = sales.filter(s => s.status === 'COMPLETED')
const completedIds = new Set(completed.map(s => s.id))
const receiptNumbers = new Set(custPayments.map(cp => cp.receipt_number))
const gross = completed.reduce((a, s) => a + Number(s.grand_total), 0)
const sumBy = <T,>(arr: T[], f: (x: T) => number) => arr.reduce((a, x) => a + f(x), 0)

// variant_unit_costs() recomputed from purchase history (mirrors 0012 PART 2)
const receivedInvoiceIds = new Set(purchaseInvoices.filter(pi => pi.status === 'RECEIVED').map(pi => pi.id))
const purchAgg = new Map<string, { netQty: number; netCost: number }>()
for (const pii of purchaseInvoiceItems) {
  if (!receivedInvoiceIds.has(pii.invoice_id)) continue
  const qty = Number(pii.quantity), rq = Number(pii.returned_quantity || 0)
  let agg = purchAgg.get(pii.variant_id)
  if (!agg) { agg = { netQty: 0, netCost: 0 }; purchAgg.set(pii.variant_id, agg) }
  agg.netQty += qty - rq
  if (qty > 0) agg.netCost += r((Number(pii.line_total) - Number(pii.tax_amount)) * (qty - rq) / qty, 2)
}
const variantById = new Map(variants.map(v => [v.id, v]))
const productById = new Map(products.map(p => [p.id, p]))
const costMap = new Map<string, { unitCost: number; basis: string }>()
for (const v of variants) {
  const p = productById.get(v.product_id)
  if (!p) continue // inner join products
  const agg = purchAgg.get(v.id)
  const netQty = agg?.netQty ?? 0
  const netCost = agg?.netCost ?? 0
  const fallback = v.cost_price ?? p.cost_price ?? null
  const unitCost = r(netQty > 0 ? (netCost / netQty) : (fallback ?? 0), 4)
  const basis = netQty > 0 ? 'purchase_average' : (fallback != null ? 'current_cost' : 'zero')
  costMap.set(v.id, { unitCost, basis })
}

// per sale_item returned qty (sales_return_items + exchange_items_in)
const returnedByItem = new Map<string, number>()
for (const sri of returnItems) returnedByItem.set(sri.sale_item_id, (returnedByItem.get(sri.sale_item_id) ?? 0) + Number(sri.quantity))
for (const eii of exchItemsIn) returnedByItem.set(eii.sale_item_id, (returnedByItem.get(eii.sale_item_id) ?? 0) + Number(eii.quantity))

const expSales = {
  bills: completed.length,
  items_sold: sumBy(saleItems.filter(si => completedIds.has(si.sale_id)), si => Number(si.quantity)),
  gross_sales: gross,
  item_discounts: sumBy(completed, s => Number(s.item_discount_total)),
  bill_discounts: sumBy(completed, s => Number(s.bill_discount)),
  tax_collected: sumBy(completed, s => Number(s.tax_total)),
  round_off: sumBy(completed, s => Number(s.round_off)),
  paid_amount: sumBy(completed, s => Number(s.paid_amount)),
  due_amount: sumBy(completed, s => Number(s.due_amount)),
  returns_value: sumBy(returns, x => Number(x.applied_to_due) + Number(x.refund_amount)),
  refunds: sumBy(returns.filter(x => Number(x.refund_amount) > 0), x => Number(x.refund_amount)),
  exchanges: exchanges.length,
}

// ===========================================================================
// SECTION 2 — dashboard_summary deep verification
// ===========================================================================
await section('DASHBOARD_SUMMARY (full history, service key)', async () => {
  const dash = await rpc('dashboard_summary', { p_from: null, p_to: null })
  console.log(`  period: ${JSON.stringify(dash.period)}`)

  const d = dash.sales ?? {}
  for (const [k, v] of Object.entries(expSales)) check(`sales.${k} = ${v}`, eq(d[k], v), { got: d[k], want: v })
  check(`sales.net_sales = ${r(gross - expSales.returns_value)}`, eq(d.net_sales, r(gross - expSales.returns_value)), { got: d.net_sales })
  check(`sales.avg_bill_value = ${completed.length ? r(gross / completed.length) : 0}`, eq(d.avg_bill_value, completed.length ? r(gross / completed.length) : 0), { got: d.avg_bill_value })

  const dc = dash.customers ?? {}
  const expActive = customers.filter(c => c.is_active).length
  const expOutstanding = sumBy(completed.filter(s => Number(s.due_amount) > 0), s => Number(s.due_amount))
  const expAdvance = sumBy(custPayments.filter(cp => Number(cp.amount) > Number(cp.allocated_amount)), cp => Number(cp.amount) - Number(cp.allocated_amount))
  check(`customers.active = ${expActive}`, dc.active === expActive, { got: dc.active })
  check(`customers.outstanding = ${r(expOutstanding)}`, eq(dc.outstanding, expOutstanding), { got: dc.outstanding })
  check(`customers.advance = ${r(expAdvance)}`, eq(dc.advance, expAdvance), { got: dc.advance })

  const dp = dash.purchases ?? {}
  const received = purchaseInvoices.filter(pi => pi.status === 'RECEIVED')
  check(`purchases.invoices = ${received.length}`, dp.invoices === received.length, { got: dp.invoices })
  check(`purchases.purchase_value = ${r(sumBy(received, pi => Number(pi.grand_total)))}`, eq(dp.purchase_value, sumBy(received, pi => Number(pi.grand_total))), { got: dp.purchase_value })
  check(`purchases.purchase_tax = ${r(sumBy(received, pi => Number(pi.tax_total)))}`, eq(dp.purchase_tax, sumBy(received, pi => Number(pi.tax_total))), { got: dp.purchase_tax })
  check(`purchases.returns_value = ${r(sumBy(purchaseReturns, x => Number(x.grand_total)))}`, eq(dp.returns_value, sumBy(purchaseReturns, x => Number(x.grand_total))), { got: dp.returns_value })

  const de = dash.expenses ?? {}
  const liveExp = expenses.filter(e => e.status === 'PENDING' || e.status === 'APPROVED')
  check(`expenses.count = ${liveExp.length}`, de.count === liveExp.length, { got: de.count })
  check(`expenses.total = ${r(sumBy(liveExp, e => Number(e.amount)))}`, eq(de.total, sumBy(liveExp, e => Number(e.amount))), { got: de.total })
  check(`expenses.pending_total = ${r(sumBy(liveExp.filter(e => e.status === 'PENDING'), e => Number(e.amount)))}`, eq(de.pending_total, sumBy(liveExp.filter(e => e.status === 'PENDING'), e => Number(e.amount))), { got: de.pending_total })
  check(`expenses.approved_total = ${r(sumBy(liveExp.filter(e => e.status === 'APPROVED'), e => Number(e.amount)))}`, eq(de.approved_total, sumBy(liveExp.filter(e => e.status === 'APPROVED'), e => Number(e.amount))), { got: de.approved_total })

  const ds = dash.suppliers ?? {}
  check(`suppliers.active = ${suppliers.filter(s => s.is_active).length}`, ds.active === suppliers.filter(s => s.is_active).length, { got: ds.active })
  check(`suppliers.payable = ${r(sumBy(received.filter(pi => Number(pi.due_amount) > 0), pi => Number(pi.due_amount)))}`, eq(ds.payable, sumBy(received.filter(pi => Number(pi.due_amount) > 0), pi => Number(pi.due_amount))), { got: ds.payable })
  check(`suppliers.advance = ${r(sumBy(supplierPayments.filter(sp => Number(sp.amount) > Number(sp.allocated_amount)), sp => Number(sp.amount) - Number(sp.allocated_amount)))}`, eq(ds.advance, sumBy(supplierPayments.filter(sp => Number(sp.amount) > Number(sp.allocated_amount)), sp => Number(sp.amount) - Number(sp.allocated_amount))), { got: ds.advance })

  const di = dash.inventory ?? {}
  check(`inventory.total_qty = ${r(sumBy(stockBalances, b => Number(b.quantity)))}`, eq(di.total_qty, sumBy(stockBalances, b => Number(b.quantity))), { got: di.total_qty })
  const costValue = sumBy(stockBalances.filter(b => costMap.has(b.variant_id)), b => Number(b.quantity) * (costMap.get(b.variant_id)!.unitCost))
  check(`inventory.cost_value = ${r(costValue)}`, eq(di.cost_value, costValue, 0.06), { got: di.cost_value })
  const sellingValue = sumBy(stockBalances.filter(b => variantById.has(b.variant_id) && productById.has(variantById.get(b.variant_id)!.product_id)),
    b => Number(b.quantity) * ((variantById.get(b.variant_id)!.selling_price ?? productById.get(variantById.get(b.variant_id)!.product_id)!.selling_price ?? 0)))
  check(`inventory.selling_value = ${r(sellingValue)}`, eq(di.selling_value, sellingValue), { got: di.selling_value })

  // profit section (COGS via recomputed variant_unit_costs, net of returns)
  const prf = dash.profit ?? {}
  const cogsRows = saleItems.filter(si => completedIds.has(si.sale_id) && costMap.has(si.variant_id))
  const cogs = sumBy(cogsRows, si => Math.max(Number(si.quantity) - (returnedByItem.get(si.id) ?? 0), 0) * costMap.get(si.variant_id)!.unitCost)
  const coveredQty = sumBy(cogsRows, si => costMap.get(si.variant_id)!.basis === 'purchase_average' ? Math.max(Number(si.quantity) - (returnedByItem.get(si.id) ?? 0), 0) : 0)
  const cogsTotalQty = sumBy(cogsRows, si => Number(si.quantity))
  const expGrossProfit = r(gross - expSales.returns_value - cogs)
  check(`profit.net_sales = ${r(gross - expSales.returns_value)}`, eq(prf.net_sales, r(gross - expSales.returns_value)), { got: prf.net_sales })
  check(`profit.cogs = ${r(cogs)}`, eq(prf.cogs, cogs, 0.06), { got: prf.cogs })
  check(`profit.gross_profit = ${expGrossProfit}`, eq(prf.gross_profit, expGrossProfit, 0.06), { got: prf.gross_profit })
  check(`profit.expenses = ${r(sumBy(liveExp, e => Number(e.amount)))}`, eq(prf.expenses, sumBy(liveExp, e => Number(e.amount))), { got: prf.expenses })
  check(`profit.net_profit = ${r(expGrossProfit - sumBy(liveExp, e => Number(e.amount)))}`, eq(prf.net_profit, r(expGrossProfit - sumBy(liveExp, e => Number(e.amount))), 0.06), { got: prf.net_profit })
  check(`profit.cost_coverage_pct = ${cogsTotalQty > 0 ? r(100 * coveredQty / cogsTotalQty, 1) : 0}`, eq(prf.cost_coverage_pct, cogsTotalQty > 0 ? r(100 * coveredQty / cogsTotalQty, 1) : 0, 0.06), { got: prf.cost_coverage_pct })
  if (di.low_stock !== undefined) console.log(`  info: inventory.low_stock=${di.low_stock}, out_of_stock=${di.out_of_stock}`)
})

// ===========================================================================
// SECTION 3 — sales_report (unfiltered + payment-method + search filters)
// ===========================================================================
await section('SALES_REPORT (full history + filters)', async () => {
  const fullArgs = {
    p_date_from: null, p_date_to: null, p_search: null, p_customer_id: null,
    p_cashier_id: null, p_payment_method: null, p_variant_id: null,
    p_category_id: null, p_brand_id: null, p_location_id: null,
    p_status: 'COMPLETED', p_sort: 'date_desc', p_limit: 10000, p_offset: 0,
  }
  const sr = await rpc('sales_report', fullArgs)
  check(`total = ${completed.length}`, sr.total === completed.length, { got: sr.total })
  check(`rows.length = total (bounded page)`, sr.rows?.length === completed.length, { got: sr.rows?.length })
  check(`total_is_estimate = false`, sr.total_is_estimate === false)
  const gotNumbers = new Set((sr.rows ?? []).map((row: any) => row.sale_number))
  const wantNumbers = new Set(completed.map(s => s.sale_number))
  check('sale_number sets equal', gotNumbers.size === wantNumbers.size && [...wantNumbers].every(n => gotNumbers.has(n)))
  check(`rows gross sum = ${r(gross)}`, eq(sumBy(sr.rows ?? [], (row: any) => Number(row.grand_total)), gross), { got: r(sumBy(sr.rows ?? [], (row: any) => Number(row.grand_total))) })
  const dates = (sr.rows ?? []).map((row: any) => new Date(row.sale_date).getTime())
  check('rows sorted date_desc', dates.every((t: number, i: number) => i === 0 || dates[i - 1] >= t))

  const sm = sr.summary ?? {}
  check(`summary.bills = ${completed.length}`, sm.bills === completed.length, { got: sm.bills })
  check(`summary.quantity = ${expSales.items_sold}`, eq(sm.quantity, expSales.items_sold), { got: sm.quantity })
  check(`summary.gross_sales = ${r(gross)}`, eq(sm.gross_sales, gross), { got: sm.gross_sales })
  check(`summary.paid = ${r(expSales.paid_amount)}`, eq(sm.paid, expSales.paid_amount), { got: sm.paid })
  check(`summary.due = ${r(expSales.due_amount)}`, eq(sm.due, expSales.due_amount), { got: sm.due })
  check(`summary.tax = ${r(expSales.tax_collected)}`, eq(sm.tax, expSales.tax_collected), { got: sm.tax })
  check(`summary.net_sales = ${r(gross - expSales.returns_value)}`, eq(sm.net_sales, r(gross - expSales.returns_value)), { got: sm.net_sales })
  check(`summary.avg_bill_value = ${completed.length ? r(gross / completed.length) : 0}`, eq(sm.avg_bill_value, completed.length ? r(gross / completed.length) : 0), { got: sm.avg_bill_value })

  // filter: payment method Cash (SQL: exists sale_payments with method='Cash')
  const methodsBySale = new Map<string, Set<string>>()
  for (const sp of salePayments) {
    let m = methodsBySale.get(sp.sale_id)
    if (!m) { m = new Set(); methodsBySale.set(sp.sale_id, m) }
    m.add(sp.method)
  }
  const cashSales = completed.filter(s => methodsBySale.get(s.id)?.has('Cash'))
  const srCash = await rpc('sales_report', { ...fullArgs, p_payment_method: 'Cash' })
  check(`filter p_payment_method='Cash' -> total = ${cashSales.length}`, srCash.total === cashSales.length, { got: srCash.total, want: cashSales.length })
  const cashNums = new Set((srCash.rows ?? []).map((row: any) => row.sale_number))
  check('filter Cash: sale_number sets equal', cashSales.every(s => cashNums.has(s.sale_number)))

  // filter: search by a sale-number fragment (ILIKE %frag% on number/name/phone)
  const frag = completed[0]?.sale_number?.slice(-6) ?? ''
  if (frag) {
    const fl = frag.toLowerCase()
    const matches = completed.filter(s =>
      (s.sale_number ?? '').toLowerCase().includes(fl)
      || (s.customer_name ?? '').toLowerCase().includes(fl)
      || (s.customer_phone ?? '').toLowerCase().includes(fl))
    const srSearch = await rpc('sales_report', { ...fullArgs, p_search: frag })
    check(`filter p_search='${frag}' -> total = ${matches.length}`, srSearch.total === matches.length, { got: srSearch.total, want: matches.length })
  }
})

// ===========================================================================
// SECTION 4 — payment_report (method breakdown, mirrors/refunds semantics)
// ===========================================================================
await section('PAYMENT_REPORT (full history)', async () => {
  const pr = await rpc('payment_report', { p_date_from: null, p_date_to: null })
  const mapify = (arr: any[]) => new Map((arr ?? []).map((x: any) => [x.method, { count: Number(x.count), amount: r(Number(x.amount)) }]))
  const cmp = (label: string, gotArr: any[], wantMap: Map<string, { count: number; amount: number }>) => {
    const got = mapify(gotArr)
    const okKeys = got.size === wantMap.size && [...wantMap.keys()].every(k => got.has(k))
    const okVals = okKeys && [...wantMap.entries()].every(([k, v]) => got.get(k)!.count === v.count && eq(got.get(k)!.amount, v.amount))
    check(`${label} (${[...wantMap.entries()].map(([k, v]) => `${k}: ${v.count}/₹${v.amount}`).join(', ') || 'empty'})`, okVals,
      { got: [...got.entries()].map(([k, v]) => `${k}: ${v.count}/₹${v.amount}`) })
  }

  // till: COMPLETED sales, non-credit, method <> 'Store Credit', not CR mirrors
  const till = new Map<string, { count: number; amount: number }>()
  for (const sp of salePayments) {
    if (!completedIds.has(sp.sale_id)) continue
    if (sp.is_credit) continue
    if (sp.method === 'Store Credit') continue
    if (sp.reference != null && receiptNumbers.has(sp.reference)) continue
    const e = till.get(sp.method) ?? { count: 0, amount: 0 }
    e.count++; e.amount = r(e.amount + Number(sp.amount))
    till.set(sp.method, e)
  }
  cmp('till section', pr.till, till)

  const receipts = new Map<string, { count: number; amount: number }>()
  for (const cp of custPayments) {
    if (cp.method === 'Store Credit') continue
    const e = receipts.get(cp.method) ?? { count: 0, amount: 0 }
    e.count++; e.amount = r(e.amount + Number(cp.amount))
    receipts.set(cp.method, e)
  }
  cmp('receipts section', pr.receipts, receipts)

  const refunds = new Map<string, { count: number; amount: number }>()
  for (const ret of returns) {
    if (!(Number(ret.refund_amount) > 0) || ret.refund_method == null || ret.refund_method === 'Store Credit') continue
    const e = refunds.get(ret.refund_method) ?? { count: 0, amount: 0 }
    e.count++; e.amount = r(e.amount + Number(ret.refund_amount))
    refunds.set(ret.refund_method, e)
  }
  for (const ex of exchanges) {
    if (!(Number(ex.difference_amount) < 0) || ex.payment_method == null || ex.payment_method === 'Store Credit') continue
    const e = refunds.get(ex.payment_method) ?? { count: 0, amount: 0 }
    e.count++; e.amount = r(e.amount - Number(ex.difference_amount))
    refunds.set(ex.payment_method, e)
  }
  cmp('refunds section', pr.refunds, refunds)

  const expByMethod = new Map<string, { count: number; amount: number }>()
  for (const e of expenses.filter(x => x.status === 'PENDING' || x.status === 'APPROVED')) {
    const v = expByMethod.get(e.method) ?? { count: 0, amount: 0 }
    v.count++; v.amount = r(v.amount + Number(e.amount))
    expByMethod.set(e.method, v)
  }
  cmp('expenses section', pr.expenses, expByMethod)

  const sup = new Map<string, { count: number; amount: number }>()
  for (const sp of supplierPayments) {
    const v = sup.get(sp.method) ?? { count: 0, amount: 0 }
    v.count++; v.amount = r(v.amount + Number(sp.amount))
    sup.set(sp.method, v)
  }
  cmp('supplier_payments section', pr.supplier_payments, sup)

  const totalIn = [...till.values(), ...receipts.values()].reduce((a, v) => a + v.amount, 0)
  check(`summary.total_inflow = ${r(totalIn)}`, eq(pr.summary?.total_inflow, totalIn), { got: pr.summary?.total_inflow })
  const totalRefund = [...refunds.values()].reduce((a, v) => a + v.amount, 0)
  check(`summary.total_refund = ${r(totalRefund)}`, eq(pr.summary?.total_refund, totalRefund), { got: pr.summary?.total_refund })
  const totalExpense = [...expByMethod.values()].reduce((a, v) => a + v.amount, 0)
  check(`summary.total_expense = ${r(totalExpense)}`, eq(pr.summary?.total_expense, totalExpense), { got: pr.summary?.total_expense })
  const totalSupplier = [...sup.values()].reduce((a, v) => a + v.amount, 0)
  check(`summary.total_supplier = ${r(totalSupplier)}`, eq(pr.summary?.total_supplier, totalSupplier), { got: pr.summary?.total_supplier })
  const scRefunds = sumBy(returns.filter(x => x.refund_method === 'Store Credit' && Number(x.refund_amount) > 0), x => Number(x.refund_amount))
  check(`summary.store_credit_refunds = ${r(scRefunds)}`, eq(pr.summary?.store_credit_refunds, scRefunds), { got: pr.summary?.store_credit_refunds })

  // inflows = till + receipts merged
  const inflow = new Map<string, { count: number; amount: number }>()
  for (const src of [till, receipts]) {
    for (const [m, v] of src) {
      const e = inflow.get(m) ?? { count: 0, amount: 0 }
      e.count += v.count; e.amount = r(e.amount + v.amount)
      inflow.set(m, e)
    }
  }
  cmp('inflows section', pr.inflows, inflow)
})

// ===========================================================================
// SECTION 5 — customer_report (per-customer aggregates vs raw tables)
// ===========================================================================
await section('CUSTOMER_REPORT (full history)', async () => {
  const cr = await rpc('customer_report', {
    p_date_from: null, p_date_to: null, p_search: null, p_type: null,
    p_sort: 'purchases_desc', p_limit: 1000, p_offset: 0,
  })
  check(`total = ${customers.length}`, cr.total === customers.length, { got: cr.total })
  const rows: any[] = cr.rows ?? []
  for (const row of rows) {
    const salesOf = completed.filter(s => s.customer_id === row.id)
    const cpsOf = custPayments.filter(cp => cp.customer_id === row.id)
    const retsOf = returns.filter(x => x.customer_id === row.id)
    const want = {
      purchases: r(sumBy(salesOf, s => Number(s.grand_total))),
      bills: salesOf.length,
      payments: r(sumBy(cpsOf, cp => Number(cp.amount))),
      returns_value: r(sumBy(retsOf, x => Number(x.applied_to_due) + Number(x.refund_amount))),
      outstanding: r(sumBy(salesOf, s => Number(s.due_amount))),
      advance: r(sumBy(cpsOf, cp => Number(cp.amount) - Number(cp.allocated_amount))),
    }
    const label = `${row.name ?? row.id}: `
    check(`${label}purchases/bills = ${want.purchases}/${want.bills}`, eq(row.purchases, want.purchases) && row.bills === want.bills, { got: [row.purchases, row.bills] })
    check(`${label}payments = ${want.payments}`, eq(row.payments, want.payments), { got: row.payments })
    check(`${label}returns_value = ${want.returns_value}`, eq(row.returns_value, want.returns_value), { got: row.returns_value })
    check(`${label}outstanding = ${want.outstanding}`, eq(row.outstanding, want.outstanding), { got: row.outstanding })
    check(`${label}advance = ${want.advance}`, eq(row.advance, want.advance), { got: row.advance })
  }
})

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
