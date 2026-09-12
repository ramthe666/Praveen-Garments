/**
 * 0012 (Phase 5 reporting layer) — local test suite.
 * Runs against the local Supabase-compatible harness (NOT production).
 *
 * Prerequisite: boot.ts running, chain 0001 -> 0012 applied
 * (bun run scripts/local/apply.ts ../supabase/migrations/0012_phase5_reporting.sql).
 *
 * Stages:
 *   A. purge + settings + users (admin / cashier / accountant / inventory_manager)
 *   B. catalog (categories, brands, products, variants)
 *   C. supplier + purchases (RECEIVED) + supplier payment  -> purchase-average cost
 *   D. opening stock for a purchase-less variant           -> current-cost basis
 *   E. sales: cash till, UPI+Credit, split cash+card, credit-only
 *   F. customer payment receipts (mirror rows)
 *   G. sales return (cash refund)
 *   H. exchange (refund difference in cash)
 *   I. purchase return
 *   J. expenses (cash PENDING, UPI APPROVED)
 *   K. every report RPC: output vs independent direct-SQL recomputation
 *   L. permission matrix + grants + audit viewer gating
 *   M. ledger integrity (stock ledger vs balances, dues invariant, payables)
 *   N. concurrency (last-unit oversell, parallel doc numbering)
 *
 * Run from pgtest/: bun run scripts/local/test-0012.ts
 */
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS ${name}`) }
  else {
    failed++; failures.push(name)
    console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`)
  }
}
function close(a: number | null | undefined, b: number | null | undefined, tol = 0.011): boolean {
  return Math.abs(Number(a ?? 0) - Number(b ?? 0)) < tol
}
async function expectError(name: string, fn: () => Promise<unknown>, messageIncludes: string) {
  try { await fn(); check(name, false, 'expected an error but none was raised') }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check(name, msg.toLowerCase().includes(messageIncludes.toLowerCase()), msg)
  }
}

async function main() {
  const root = new Client(CONN)
  await root.connect()

  // role helper: run as a given user (PostgREST-style JWT claim)
  async function as(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query('set role authenticated')
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    return c
  }
  async function rpc<T = any>(client: Client, fn: string, args: Record<string, unknown>): Promise<T> {
    const keys = Object.keys(args)
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
    const vals = keys.map((k) => args[k])
    const res = await client.query(`select public.${fn}(${named}) as result`, vals)
    return res.rows[0].result as T
  }
  const one = async (client: Client, sql: string, vals: unknown[] = []) =>
    (await client.query(sql, vals)).rows
  const val = async (client: Client, sql: string, vals: unknown[] = []) =>
    (await client.query(sql, vals)).rows[0]

  // ---- A. purge ------------------------------------------------------------
  async function purgeAll() {
    await root.query('set role postgres')
    await root.query('alter table public.stock_movements disable trigger stock_movements_append_only')
    await root.query('alter table public.stock_balances disable trigger stock_balances_engine_guard')
    for (const t of [
      'exchange_items_in', 'exchange_items_out', 'exchanges',
      'sales_return_items', 'sales_returns', 'purchase_return_items', 'purchase_returns',
      'customer_payment_allocations', 'customer_payments',
      'supplier_payment_allocations', 'supplier_payments',
      'sale_payments', 'sale_items', 'sales', 'held_bills', 'customers',
      'purchase_invoice_items', 'purchase_invoices', 'purchase_order_items', 'purchase_orders',
      'suppliers', 'expenses',
      'sale_number_counters', 'stock_movements', 'stock_balances',
      'audit_logs', 'product_variants', 'products',
      'categories', 'brands', 'sizes', 'colors',
    ]) {
      await root.query(`delete from public.${t}`)
    }
    await root.query('alter table public.stock_balances enable trigger stock_balances_engine_guard')
    await root.query('alter table public.stock_movements enable trigger stock_movements_append_only')
    await root.query(`delete from public.profiles where email like 'pg12-%'`)
    await root.query(`delete from auth.users where email like 'pg12-%'`)
  }
  await purgeAll()

  await root.query(`update public.app_settings set value = jsonb_build_object(
    'require_customer', false, 'allow_price_edit', false, 'round_off', false,
    'default_payment_method', 'Cash', 'bill_footer_note', 'x',
    'allow_credit_sales', true, 'default_tax_mode', 'inclusive',
    'max_item_discount_pct', 10, 'max_bill_discount_pct', 10
  ) where key = 'pos'`)
  await root.query(`update public.app_settings set value = jsonb_build_object(
    'enabled', true, 'default_rate', 5,
    'intra_state_label', 'CGST + SGST', 'inter_state_label', 'IGST'
  ) where key = 'tax'`)
  await root.query(`update public.app_settings set value = jsonb_build_object(
    'methods', '["Cash","UPI","Card","Bank Transfer"]'::jsonb,
    'allow_advance_payments', false
  ) where key = 'payments'`)
  await root.query(`update public.company_settings set company_name = 'P12 Retail',
    state = 'Karnataka', timezone = 'Asia/Kolkata' where id = 1`)

  async function mkUser(email: string, name: string, role: string) {
    const id = (await root.query(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify({ app_role: role, full_name: name })]
    )).rows[0].id as string
    await root.query(
      `insert into public.profiles (id, email, full_name, role)
       values ($1, $2, $3, $4::public.user_role)
       on conflict (id) do update set role = $4::public.user_role, is_active = true`,
      [id, email, name, role])
    return id
  }
  const adminId = await mkUser('pg12-admin@test.local', 'P12 Admin', 'admin')
  const cashierId = await mkUser('pg12-cashier@test.local', 'P12 Cashier', 'cashier')
  const acctId = await mkUser('pg12-acct@test.local', 'P12 Accountant', 'accountant')
  const invId = await mkUser('pg12-inv@test.local', 'P12 InvMgr', 'inventory_manager')
  const admin = await as(adminId)
  const cashier = await as(cashierId)
  const accountant = await as(acctId)
  const invMgr = await as(invId)
  console.log('A. users ready')

  // ---- B. catalog ----------------------------------------------------------
  const cat1 = (await val(root, `insert into public.categories (name) values ('Shirts') returning id`)).id
  const cat2 = (await val(root, `insert into public.categories (name, parent_id) values ('T-Shirts', $1) returning id`, [cat1])).id
  const brand1 = (await val(root, `insert into public.brands (name) values ('AlphaWear') returning id`)).id
  const brand2 = (await val(root, `insert into public.brands (name) values ('BetaStyle') returning id`)).id
  const sizeM = (await val(root, `insert into public.sizes (name) values ('M') returning id`)).id
  const sizeL = (await val(root, `insert into public.sizes (name) values ('L') returning id`)).id
  const colorRed = (await val(root, `insert into public.colors (name) values ('Red') returning id`)).id
  const colorBlue = (await val(root, `insert into public.colors (name) values ('Blue') returning id`)).id

  const p1 = (await val(root, `insert into public.products
    (name, category_id, brand_id, hsn_code, gst_rate, mrp, cost_price, selling_price)
    values ('Oxford Shirt', $1, $2, '620520', 5, 250, 100, 200) returning id`, [cat1, brand1])).id
  const p2 = (await val(root, `insert into public.products
    (name, category_id, brand_id, hsn_code, gst_rate, mrp, cost_price, selling_price)
    values ('Graphic Tee', $1, $2, '610910', 12, 199, 80, 150) returning id`, [cat2, brand2])).id

  const v1 = (await val(root, `insert into public.product_variants
    (product_id, sku, size_id, color_id, cost_price, mrp, selling_price)
    values ($1, 'OX-M-RED', $2, $3, 100, 250, 200) returning id`, [p1, sizeM, colorRed])).id
  const v2 = (await val(root, `insert into public.product_variants
    (product_id, sku, size_id, color_id, cost_price, mrp, selling_price)
    values ($1, 'OX-L-BLU', $2, $3, 100, 250, 200) returning id`, [p1, sizeL, colorBlue])).id
  const v3 = (await val(root, `insert into public.product_variants
    (product_id, sku, size_id, color_id, cost_price, mrp, selling_price)
    values ($1, 'GT-M-BLU', $2, $3, 80, 199, 150) returning id`, [p2, sizeM, colorBlue])).id
  const v4 = (await val(root, `insert into public.product_variants
    (product_id, sku, size_id, color_id, cost_price, mrp, selling_price)
    values ($1, 'GT-L-RED', $2, $3, 80, 199, 150) returning id`, [p2, sizeL, colorRed])).id
  console.log('B. catalog ready')

  // ---- C. supplier + purchases ---------------------------------------------
  const supplier = (await val(admin, `insert into public.suppliers (name, phone, state)
    values ('Metro Textiles', '9800000001', 'Karnataka') returning id`)).id
  const storeLoc = (await val(root, `select id from public.stock_locations where code = 'MAIN'`)).id
  // purchase 1: v1 x10 @100 (net 1000, gst 5 inclusive), v3 x10 @80 (net 800, gst 12)
  const pi1 = (await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({
      supplier_id: supplier, location_id: storeLoc, status: 'RECEIVED',
      supplier_invoice_no: 'MET-001', tax_mode: 'inclusive',
      items: [
        { variant_id: v1, quantity: 10, unit_cost: 100 },
        { variant_id: v3, quantity: 10, unit_cost: 80 },
      ],
    }),
  })).invoice_id
  // purchase 2: v1 x5 @120 (net 600) -> weighted avg cost for v1 = 1600/15
  const pi2 = (await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({
      supplier_id: supplier, location_id: storeLoc, status: 'RECEIVED',
      supplier_invoice_no: 'MET-002', tax_mode: 'inclusive',
      items: [{ variant_id: v1, quantity: 5, unit_cost: 120 }],
    }),
  })).invoice_id
  // supplier payment 500 UPI against pi1
  await rpc(accountant, 'record_supplier_payment', {
    p_supplier_id: supplier, p_amount: 500, p_method: 'UPI', p_reference: 'UPI-SP-1',
  })
  console.log('C. purchases ready')

  // ---- D. opening stock for purchase-less variant v2 (current-cost basis) ---
  await rpc(invMgr, 'set_opening_stock', {
    p_variant_id: v2, p_location_id: storeLoc, p_quantity: 4, p_reason: 'initial',
  })
  await rpc(invMgr, 'set_opening_stock', {
    p_variant_id: v4, p_location_id: storeLoc, p_quantity: 6, p_reason: 'initial',
  })
  console.log('D. opening stock ready')

  // ---- E. sales -------------------------------------------------------------
  const cust = (await val(cashier, `insert into public.customers (name, phone, state)
    values ('Ravi Kumar', '9876543210', 'Karnataka') returning id`)).id
  const cust2 = (await val(cashier, `insert into public.customers (name, phone, state)
    values ('Inter State Buyer', '9800000002', 'Tamil Nadu') returning id`)).id

  // S1: v1 x2, cash 400 at till
  const s1 = (await rpc(cashier, 'create_sale', {
    p_payload: JSON.stringify({
      items: [{ variant_id: v1, quantity: 2 }],
      payments: [{ method: 'Cash', amount: 400, cash_received: 500 }],
      customer_id: cust,
    }),
  }))
  // S2: v3 x2 (300) + v1 x1 (200) = 500; UPI 300 + Credit 200
  const s2 = (await rpc(cashier, 'create_sale', {
    p_payload: JSON.stringify({
      items: [{ variant_id: v3, quantity: 2 }, { variant_id: v1, quantity: 1 }],
      payments: [{ method: 'UPI', amount: 300 }, { method: 'Credit', amount: 200 }],
      customer_id: cust,
    }),
  }))
  // S3: v4 x2 = 300; split cash 100 + card 200 (walk-in, inter-state customer for IGST)
  const s3 = (await rpc(cashier, 'create_sale', {
    p_payload: JSON.stringify({
      items: [{ variant_id: v4, quantity: 2 }],
      payments: [{ method: 'Cash', amount: 100 }, { method: 'Card', amount: 200 }],
      customer_id: cust2,
    }),
  }))
  // S4: v2 x1 = 200 credit-only (due 200)
  const s4 = (await rpc(cashier, 'create_sale', {
    p_payload: JSON.stringify({
      items: [{ variant_id: v2, quantity: 1 }],
      payments: [{ method: 'Credit', amount: 200 }],
      customer_id: cust,
    }),
  }))
  console.log('E. sales ready:', s1.sale_number, s2.sale_number, s3.sale_number, s4.sale_number)

  // ---- F. customer payment receipts -----------------------------------------
  // pay 250 cash against dues (S2 due 200, S4 due 200) -> allocates 200 to S2 + 50 to S4
  const cr1 = (await rpc(cashier, 'record_customer_payment', {
    p_customer_id: cust, p_amount: 250, p_method: 'Cash', p_reference: 'CASH-1',
  }))
  console.log('F. receipts ready:', cr1.receipt_number, 'allocated', cr1.allocated_amount)

  // ---- G. sales return on S1 (fully paid): 1 unit v1, GOOD, cash refund 200 --
  const s1Item = (await val(admin, `select id from public.sale_items where sale_id = $1 and variant_id = $2`, [s1.sale_id, v1])).id
  const ret1 = (await rpc(admin, 'create_sales_return', {
    p_payload: JSON.stringify({
      sale_id: s1.sale_id, reason: 'Size too small',
      refund_method: 'Cash',
      items: [{ sale_item_id: s1Item, quantity: 1, condition: 'GOOD' }],
    }),
  }))
  console.log('G. return ready:', ret1.return_number, 'refund', ret1.refunded)

  // ---- H. exchange on S2: return v1 x1, issue v3 x1 (diff refund) -----------
  const s2ItemV1 = (await val(admin, `select id from public.sale_items where sale_id = $1 and variant_id = $2`, [s2.sale_id, v1])).id
  const ex1 = (await rpc(admin, 'create_exchange', {
    p_payload: JSON.stringify({
      sale_id: s2.sale_id, reason: 'Colour preference',
      return_items: [{ sale_item_id: s2ItemV1, quantity: 1, condition: 'GOOD' }],
      new_items: [{ variant_id: v3, quantity: 1 }],
      payment_method: 'Cash',
    }),
  }))
  console.log('H. exchange ready:', ex1.exchange_number, 'difference', ex1.difference_amount)

  // ---- I. purchase return: 1 x v1 back to supplier ---------------------------
  const pi1ItemV1 = (await val(admin, `select id from public.purchase_invoice_items where invoice_id = $1 and variant_id = $2`, [pi1, v1])).id
  const pr1 = (await rpc(admin, 'create_purchase_return', {
    p_payload: JSON.stringify({
      purchase_invoice_id: pi1, reason: 'Damaged in transit, returned one piece',
      items: [{ invoice_item_id: pi1ItemV1, quantity: 1 }],
    }),
  }))
  console.log('I. purchase return ready:', pr1.return_number)

  // ---- J. expenses -----------------------------------------------------------
  async function ensureExpCat(name: string) {
    await root.query(`insert into public.expense_categories (name) values ($1) on conflict do nothing`, [name])
    return (await val(root, `select id from public.expense_categories where name = $1`, [name])).id
  }
  const expCat = await ensureExpCat('Rent')
  const expCat2 = await ensureExpCat('Electricity')
  await rpc(accountant, 'create_expense', {
    p_payload: JSON.stringify({
      category_id: expCat, description: 'Shop rent September',
      amount: '1000', method: 'Cash',
    }),
  })
  const exp2 = (await rpc(accountant, 'create_expense', {
    p_payload: JSON.stringify({
      category_id: expCat2, description: 'Electricity bill',
      amount: '300', method: 'UPI',
    }),
  }))
  await rpc(admin, 'approve_expense', { p_expense_id: exp2.expense_id })
  console.log('J. expenses ready')

  await fileScopeChecks()
  await permissionChecks()
  await integrityChecks()
  await concurrencyChecks()

  async function fileScopeChecks() {
    console.log('\nK. report function verification (independent recomputation)')

    // ---- dashboard_summary ---------------------------------------------------
    const dash = await rpc(admin, 'dashboard_summary', { p_from: null, p_to: null })
    const expGross = (await val(admin, `select coalesce(sum(grand_total),0) g, count(*) c,
      coalesce(sum(item_discount_total),0) id, coalesce(sum(bill_discount),0) bd,
      coalesce(sum(tax_total),0) t, coalesce(sum(paid_amount),0) p, coalesce(sum(due_amount),0) d
      from public.sales where status='COMPLETED'`))
    check('dash: gross sales', close(dash.sales.gross_sales, expGross.g), { got: dash.sales.gross_sales, want: expGross.g })
    check('dash: bills', dash.sales.bills === Number(expGross.c), { got: dash.sales.bills, want: expGross.c })
    check('dash: tax', close(dash.sales.tax_collected, expGross.t))
    check('dash: paid', close(dash.sales.paid_amount, expGross.p))
    const expQty = (await val(admin, `select coalesce(sum(si.quantity),0) q from public.sale_items si
      join public.sales s on s.id=si.sale_id where s.status='COMPLETED'`)).q
    check('dash: items sold', close(dash.sales.items_sold, expQty))
    const expRet = (await val(admin, `select coalesce(sum(applied_to_due+refund_amount),0) v, coalesce(sum(refund_amount),0) r
      from public.sales_returns`))
    check('dash: returns value', close(dash.sales.returns_value, expRet.v))
    check('dash: refunds', close(dash.sales.refunds, expRet.r))
    check('dash: net sales = gross - returns', close(dash.sales.net_sales, Number(expGross.g) - Number(expRet.v)))
    const expPur = (await val(admin, `select coalesce(sum(grand_total),0) v, count(*) c, coalesce(sum(tax_total),0) t
      from public.purchase_invoices where status='RECEIVED'`))
    check('dash: purchase value', close(dash.purchases.purchase_value, expPur.v))
    check('dash: invoices', dash.purchases.invoices === Number(expPur.c))
    const expExp = (await val(admin, `select coalesce(sum(amount),0) v, count(*) c from public.expenses
      where status in ('PENDING','APPROVED')`))
    check('dash: expenses', close(dash.expenses.total, expExp.v))
    check('dash: expense count', dash.expenses.count === Number(expExp.c))
    const expDue = (await val(admin, `select coalesce(sum(due_amount),0) d from public.sales where status='COMPLETED'`))
    check('dash: customer dues', close(dash.customers.outstanding, expDue.d))
    const expPay = (await val(admin, `select coalesce(sum(due_amount),0) d from public.purchase_invoices where status='RECEIVED'`))
    check('dash: supplier dues', close(dash.suppliers.payable, expPay.d))
    const expQty2 = (await val(admin, `select coalesce(sum(quantity),0) q from public.stock_balances`))
    check('dash: inventory qty', close(dash.inventory.total_qty, expQty2.q))
    // profit section internal consistency
    check('dash: profit gross = net_sales - cogs',
      close(dash.profit.gross_profit, Number(dash.profit.net_sales) - Number(dash.profit.cogs)),
      dash.profit)
    check('dash: profit net = gross - expenses',
      close(dash.profit.net_profit, Number(dash.profit.gross_profit) - Number(dash.profit.expenses)))

    // ---- sales_report ----------------------------------------------------------
    const sr = await rpc(admin, 'sales_report', {
      p_date_from: null, p_date_to: null, p_limit: 50, p_offset: 0,
    })
    check('sales_report: total rows', sr.total === 4, { got: sr.total })
    check('sales_report: summary bills', sr.summary.bills === 4)
    check('sales_report: summary gross', close(sr.summary.gross_sales, expGross.g))
    const srCust = await rpc(admin, 'sales_report', {
      p_date_from: null, p_date_to: null, p_customer_id: cust, p_limit: 50,
    })
    const expCustBills = (await val(admin, `select count(*) c, coalesce(sum(grand_total),0) g
      from public.sales where status='COMPLETED' and customer_id=$1`, [cust]))
    check('sales_report: customer filter count', srCust.total === Number(expCustBills.c))
    check('sales_report: customer filter gross', close(srCust.summary.gross_sales, expCustBills.g))
    const srUpi = await rpc(admin, 'sales_report', {
      p_date_from: null, p_date_to: null, p_payment_method: 'UPI', p_limit: 50,
    })
    const expUpi = (await val(admin, `select count(distinct s.id) c from public.sales s
      join public.sale_payments sp on sp.sale_id = s.id where sp.method='UPI' and s.status='COMPLETED'`))
    check('sales_report: UPI filter', srUpi.total === Number(expUpi.c), { got: srUpi.total, want: expUpi.c })
    const srCat = await rpc(admin, 'sales_report', {
      p_date_from: null, p_date_to: null, p_category_id: cat2, p_limit: 50,
    })
    const expCatBills = (await val(admin, `select count(distinct s.id) c from public.sales s
      where s.status='COMPLETED' and exists (
        select 1 from public.sale_items si join public.product_variants pv on pv.id=si.variant_id
        join public.products p on p.id=pv.product_id
        where si.sale_id=s.id and (p.category_id=$1 or p.subcategory_id=$1))`, [cat2]))
    check('sales_report: category filter (subcategory rolled in)', srCat.total === Number(expCatBills.c))

    // ---- product_sales_report ---------------------------------------------------
    const psr = await rpc(admin, 'product_sales_report', { p_date_from: null, p_date_to: null, p_limit: 50 })
    const expVariants = (await val(admin, `select count(distinct si.variant_id) c from public.sale_items si
      join public.sales s on s.id=si.sale_id where s.status='COMPLETED'`))
    check('product_sales: variants', psr.total === Number(expVariants.c), { got: psr.total })
    const v1Row = psr.rows.find((r: any) => r.sku === 'OX-M-RED')
    const expV1 = (await val(admin, `select coalesce(sum(si.quantity),0) q, coalesce(round(sum(si.line_total),2),0) v
      from public.sale_items si join public.sales s on s.id=si.sale_id
      where s.status='COMPLETED' and si.variant_id=$1`, [v1]))
    check('product_sales: v1 qty', close(v1Row?.quantity, expV1.q), v1Row)
    check('product_sales: v1 revenue', close(v1Row?.revenue, expV1.v))
    const psrBrand = await rpc(admin, 'product_sales_report', {
      p_date_from: null, p_date_to: null, p_brand_id: brand1, p_limit: 50,
    })
    const expBrand = (await val(admin, `select count(distinct si.variant_id) c from public.sale_items si
      join public.sales s on s.id=si.sale_id join public.product_variants pv on pv.id=si.variant_id
      join public.products p on p.id=pv.product_id
      where s.status='COMPLETED' and p.brand_id=$1`, [brand1]))
    check('product_sales: brand filter', psrBrand.total === Number(expBrand.c))

    // ---- catalog performance ------------------------------------------------------
    const cpc = await rpc(admin, 'catalog_performance_report', { p_group_by: 'category' })
    const shirtRow = cpc.rows.find((r: any) => r.name === 'T-Shirts')
    const expTee = (await val(admin, `select coalesce(sum(si.quantity),0) q, coalesce(round(sum(si.line_total),2),2) v, count(distinct s.id) b
      from public.sale_items si join public.sales s on s.id=si.sale_id
      join public.product_variants pv on pv.id=si.variant_id join public.products p on p.id=pv.product_id
      where s.status='COMPLETED' and p.category_id=$1`, [cat2]))
    check('catalog: T-Shirts qty', close(shirtRow?.quantity, expTee.q))
    check('catalog: T-Shirts value', close(shirtRow?.value, expTee.v))
    check('catalog: T-Shirts bills', shirtRow?.bills === Number(expTee.b))
    const pctSum = cpc.rows.reduce((s: number, r: any) => s + Number(r.pct), 0)
    check('catalog: pct sums to 100', Math.abs(pctSum - 100) < 0.5, pctSum)

    // ---- payment_report -------------------------------------------------------
    const payr = await rpc(admin, 'payment_report', { p_date_from: null, p_date_to: null })
    // expected inflows: till (400 cash S1 + 100 cash S3 + 200 card S3 + 300 UPI S2) + receipts (250 cash CR)
    const expTill = (await one(admin, `select sp.method, round(sum(sp.amount),2) amt
      from public.sale_payments sp join public.sales s on s.id=sp.sale_id
      where s.status='COMPLETED' and sp.is_credit=false and sp.method<>'Store Credit'
      and not exists (select 1 from public.customer_payments cp where cp.receipt_number=sp.reference)
      group by sp.method`))
    const tillCash = expTill.find((r: any) => r.method === 'Cash')?.amt
    check('payment: till Cash = 500', close(payr.till.find((r: any) => r.method === 'Cash')?.amount, tillCash ?? 0))
    const inflowCash = payr.inflows.find((r: any) => r.method === 'Cash')
    check('payment: inflow Cash = till + receipts', close(inflowCash?.amount, 400 + 100 + 250), inflowCash)
    check('payment: refunds cash = 200 return + 50 exchange',
      close(payr.refunds.find((r: any) => r.method === 'Cash')?.amount, 250),
      payr.refunds)
    check('payment: expenses UPI = 300', close(payr.expenses.find((r: any) => r.method === 'UPI')?.amount, 300))
    check('payment: supplier UPI = 500', close(payr.supplier_payments.find((r: any) => r.method === 'UPI')?.amount, 500))

    // ---- gst_report -----------------------------------------------------------
    const gst = await rpc(admin, 'gst_report', { p_date_from: null, p_date_to: null })
    const expSaleTax = (await val(admin, `select coalesce(round(sum(si.tax_amount),2),0) t
      from public.sale_items si join public.sales s on s.id=si.sale_id where s.status='COMPLETED'`))
    check('gst: output tax total', close(gst.summary.output_tax, expSaleTax.t),
      { got: gst.summary.output_tax, want: expSaleTax.t })
    const expCgst = (await val(admin, `select coalesce(round(sum(case when s.inter_state then 0 else si.tax_amount/2 end),2),0) c
      from public.sale_items si join public.sales s on s.id=si.sale_id where s.status='COMPLETED'`))
    check('gst: cgst total', close(sumKey(gst.sales, 'cgst'), expCgst.c),
      { got: sumKey(gst.sales, 'cgst'), want: expCgst.c })
    const expIgst = (await val(admin, `select coalesce(round(sum(case when s.inter_state then si.tax_amount else 0 end),2),0) i
      from public.sale_items si join public.sales s on s.id=si.sale_id where s.status='COMPLETED'`))
    check('gst: igst total', close(sumKey(gst.sales, 'igst'), expIgst.i))
    const expPurchTax = (await val(admin, `select coalesce(round(sum(pii.tax_amount),2),0) t
      from public.purchase_invoice_items pii join public.purchase_invoices pi on pi.id=pii.invoice_id
      where pi.status='RECEIVED'`))
    check('gst: input tax total', close(sumKey(gst.purchases, 'total_tax'), expPurchTax.t))
    check('gst: return tax reverses', close(sumKey(gst.sales_returns, 'total_tax'),
      (await val(admin, `select coalesce(round(sum(sri.tax_amount),2),0) t from public.sales_return_items sri`)).t))
    const expPrTax = (await val(admin, `select coalesce(round(sum(pri.tax_amount),2),0) t from public.purchase_return_items pri`))
    check('gst: purchase return tax', close(sumKey(gst.purchase_returns, 'total_tax'), expPrTax.t))

    // ---- profit_report ----------------------------------------------------------
    const profit = await rpc(admin, 'profit_report', { p_date_from: null, p_date_to: null })
    // expected COGS: v1 net sold = 3 - 1 returned = 2 @ (1600/15=106.6667) = 213.3333
    // v3 net sold = 2 + 1 exchange-issued = 3 @ 80 = 240  | v4 = 2 @ 80 (current_cost? v4 HAS no purchases -> current 80)
    // v2 = 1 @ 100 (current_cost, opening stock only)
    const cogsRow = (await val(root, `
      with costs as (select * from public.variant_unit_costs())
      select coalesce(round(sum(greatest(si.quantity - coalesce(ret.r,0),0) * c.unit_cost),2),0) cogs
      from public.sale_items si
      join public.sales s on s.id=si.sale_id
      join costs c on c.variant_id=si.variant_id
      left join lateral (select coalesce((
        select sum(sri.quantity) from public.sales_return_items sri where sri.sale_item_id=si.id),0)
        + coalesce((select sum(eii.quantity) from public.exchange_items_in eii where eii.sale_item_id=si.id),0) as r) ret on true
      where s.status='COMPLETED'`))
    check('profit: cogs matches net-of-returns recomputation', close(profit.cogs, cogsRow.cogs),
      { got: profit.cogs, want: cogsRow.cogs })
    check('profit: net profit = gross - returns - cogs - expenses', close(profit.net_profit,
      Number(profit.gross_sales) - Number(profit.returns_value) - Number(profit.cogs) - Number(profit.expenses)))

    // ---- stock_valuation_report ----------------------------------------------------
    const sval = await rpc(admin, 'stock_valuation_report', { p_limit: 50 })
    // v1 stock: 15 bought - 3 sold + 1 SR return + 1 EX trade-in - 1 PR = 13
    // v3 stock: 10 - 2 - 1(exchange) = 7 @ 80 = 560 ... wait exchange issue deducts v3: 10-2-1=7
    const expVal = (await val(root, `
      with costs as (select * from public.variant_unit_costs())
      select coalesce(round(sum(sb.quantity * c.unit_cost),2),0) cost,
             coalesce(round(sum(sb.quantity * coalesce(pv.selling_price,p.selling_price,0)),2),0) sell
      from public.stock_balances sb
      join costs c on c.variant_id=sb.variant_id
      join public.product_variants pv on pv.id=sb.variant_id
      join public.products p on p.id=pv.product_id
      where sb.quantity > 0`))
    check('valuation: total cost', close(sval.summary.cost_value, expVal.cost), { got: sval.summary.cost_value, want: expVal.cost })
    check('valuation: total selling', close(sval.summary.selling_value, expVal.sell))
    const v1Val = sval.rows.find((r: any) => r.sku === 'OX-M-RED')
    check('valuation: v1 cost basis = purchase_average', v1Val?.cost_basis === 'purchase_average', v1Val)
    const v2Val = sval.rows.find((r: any) => r.sku === 'OX-L-BLU')
    check('valuation: v2 cost basis = current_cost', v2Val?.cost_basis === 'current_cost', v2Val)
    check('valuation: v1 qty = 13', v1Val?.quantity === 13, v1Val)

    // ---- stock_performance_report ---------------------------------------------------
    const today = new Date().toISOString().slice(0, 10)
    const perf = await rpc(admin, 'stock_performance_report', { p_date_from: today, p_date_to: today, p_limit: 100 })
    const v1Perf = perf.rows.find((r: any) => r.sku === 'OX-M-RED')
    check('performance: v1 qty sold = 3', v1Perf?.qty_sold === 3, v1Perf)
    check('performance: v1 class = fast', v1Perf?.class === 'fast', v1Perf)
    const dead = perf.rows.find((r: any) => r.sku === 'GT-L-RED')
    check('performance: v4 sold 2', dead?.qty_sold === 2, dead)
    const summaryTotal = perf.summary.fast + perf.summary.slow + perf.summary.dead + perf.summary.out_of_stock
    check('performance: class counts cover all rows', summaryTotal === perf.summary.total,
      { sum: summaryTotal, total: perf.summary.total })

    // ---- purchase_report ------------------------------------------------------------
    const prr = await rpc(admin, 'purchase_report', { p_date_from: null, p_date_to: null, p_limit: 50 })
    check('purchase_report: total = 2', prr.total === 2, { got: prr.total })
    check('purchase_report: value', close(prr.summary.value, expPur.v))
    check('purchase_report: due', close(prr.summary.due,
      (await val(admin, `select coalesce(sum(due_amount),0) d from public.purchase_invoices where status='RECEIVED'`)).d))
    check('purchase_report: returns value', close(prr.summary.returns_value,
      (await val(admin, `select coalesce(sum(grand_total),0) v from public.purchase_returns`)).v))

    // ---- supplier_report ---------------------------------------------------------------
    const sup = await rpc(admin, 'supplier_report', { p_date_from: null, p_date_to: null, p_limit: 50 })
    const supRow = sup.rows.find((r: any) => r.name === 'Metro Textiles')
    check('supplier: purchase value', close(supRow?.purchase_value, expPur.v), supRow)
    check('supplier: payments 500', close(supRow?.payments, 500))
    check('supplier: outstanding = pi1+pi2 - 500 - purchase return applied', close(supRow?.outstanding,
      (await val(admin, `select coalesce(sum(due_amount),0) d from public.purchase_invoices where status='RECEIVED'`)).d))

    // ---- customer_report -----------------------------------------------------------------
    const cr = await rpc(admin, 'customer_report', { p_date_from: null, p_date_to: null, p_limit: 50 })
    const crRow = cr.rows.find((r: any) => r.name === 'Ravi Kumar')
    const expC = (await val(admin, `select coalesce(sum(s.grand_total),0) v, count(*) b,
      coalesce(sum(s.due_amount),0) d from public.sales s where s.customer_id=$1 and s.status='COMPLETED'`, [cust]))
    check('customer: purchases value', close(crRow?.purchases, expC.v), crRow)
    check('customer: bills', crRow?.bills === Number(expC.b))
    check('customer: payments = 250', close(crRow?.payments, 250))
    check('customer: outstanding = sales dues', close(crRow?.outstanding, expC.d))
    const crSum = (await val(admin, `select count(*) c from public.customers`))
    check('customer: total customers', cr.total === Number(crSum.c))

    // ---- expense_report ----------------------------------------------------------------
    const expr = await rpc(admin, 'expense_report', { p_date_from: null, p_date_to: null })
    check('expense: total = 1300', close(expr.summary.total, 1300), expr.summary)
    check('expense: approved total = 300', close(expr.summary.approved_total, 300))
    const rentRow = expr.by_category.find((r: any) => r.name === 'Rent')
    check('expense: rent category = 1000', close(rentRow?.amount, 1000))
    const cashRow = expr.by_method.find((r: any) => r.method === 'Cash')
    check('expense: cash method = 1000', close(cashRow?.amount, 1000))

    // ---- returns_report ----------------------------------------------------------------
    const rr = await rpc(admin, 'returns_report', { p_date_from: null, p_date_to: null })
    check('returns: sales return count', rr.sales_returns.count === 1, rr.sales_returns)
    check('returns: refund amount = 200', close(rr.sales_returns.refund_amount, 200))
    check('returns: exchanges count', rr.exchanges.count === 1)
    check('returns: exchange refunded = 50', close(rr.exchanges.refunded, 50))
    check('returns: purchase returns count', rr.purchase_returns.count === 1)
    const condGood = rr.sales_returns.by_condition.find((r: any) => r.condition === 'GOOD')
    check('returns: good condition qty 1', condGood?.quantity === 1, rr.sales_returns.by_condition)

    // ---- cash_report ---------------------------------------------------------------------
    const cash = await rpc(admin, 'cash_report', { p_date: null })
    // opening 0; in: till cash 400 (S1) + 100 (S3) + receipts 250; out: refund 200 + exchange refund 50 + expenses cash 1000
    check('cash: opening = 0', close(cash.opening_cash, 0), cash)
    check('cash: cash sales = 500', close(cash.cash_sales, 500))
    check('cash: cash receipts = 250', close(cash.cash_receipts, 250))
    check('cash: refunds out = 250', close(cash.cash_refunds, 250))
    check('cash: expenses = 1000', close(cash.cash_expenses, 1000))
    check('cash: expected = 0 + 750 - 1250', close(cash.expected_cash, -500), cash)

    // ---- audit_page ----------------------------------------------------------------------
    const audit = await rpc(admin, 'audit_page', { p_limit: 50, p_offset: 0 })
    const expAudit = (await val(root, `select count(*) c from public.audit_logs`))
    check('audit: total rows', audit.total === Number(expAudit.c), { got: audit.total, want: expAudit.c })
    check('audit: actions list non-empty', Array.isArray(audit.actions) && audit.actions.length >= 40,
      audit.actions?.length)
    const auditSale = await rpc(admin, 'audit_page', { p_action: 'sale_created', p_limit: 10 })
    check('audit: action filter', auditSale.total === 4, { got: auditSale.total })
    const auditSearch = await rpc(admin, 'audit_page', { p_search: s1.sale_number, p_limit: 10 })
    check('audit: search by sale number', auditSearch.total >= 1)
    await expectError('audit: invalid action rejected', () =>
      rpc(admin, 'audit_page', { p_action: 'not_an_action' }), 'INVALID_ACTION')
  }

  function sumKey(rows: any[] | undefined, key: string): number {
    return (rows ?? []).reduce((s, r) => s + Number(r[key] ?? 0), 0)
  }

  async function permissionChecks() {
    console.log('\nL. permission matrix')

    await expectError('cashier blocked from sales_report', () =>
      rpc(cashier, 'sales_report', { p_limit: 5 }), 'permission')
    await expectError('cashier blocked from dashboard report fns', () =>
      rpc(cashier, 'product_sales_report', { p_limit: 5 }), 'permission')
    await expectError('cashier blocked from audit_page', () =>
      rpc(cashier, 'audit_page', { p_limit: 5 }), 'permission')
    await expectError('cashier blocked from cash_report', () =>
      rpc(cashier, 'cash_report', {}), 'permission')
    const invDash = await rpc(invMgr, 'dashboard_summary', {})
    check('inventory_manager: sales section null (no view_sales)', invDash.sales === null, invDash.sales)
    check('inventory_manager: inventory section present', invDash.inventory !== null)
    const cashierDash = await rpc(cashier, 'dashboard_summary', {})
    check('cashier: sales section present', cashierDash.sales !== null)
    check('cashier: profit section null (no view_reports)', cashierDash.profit === null)
    const acctDash = await rpc(accountant, 'dashboard_summary', {})
    check('accountant: profit section present', acctDash.profit !== null)
    const anonTest = new Client(CONN)
    await anonTest.connect()
    await anonTest.query('set role anon')
    await expectError('anon role blocked from sales_report (no execute grant)', () =>
      rpc(anonTest, 'sales_report', { p_limit: 5 }), 'permission')
    await anonTest.end()

    // grants: anon must NOT execute; authenticated must
    const g = await val(root, `select
      has_function_privilege('anon', 'public.sales_report(date,date,text,uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,integer,integer)', 'EXECUTE') as a,
      has_function_privilege('authenticated', 'public.sales_report(date,date,text,uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,integer,integer)', 'EXECUTE') as au,
      has_function_privilege('anon', 'public.audit_page(text,text,uuid,date,date,text,integer,integer)', 'EXECUTE') as aud_a,
      has_function_privilege('authenticated', 'public.audit_page(text,text,uuid,date,date,text,integer,integer)', 'EXECUTE') as aud_au,
      has_function_privilege('authenticated', 'public.variant_unit_costs()', 'EXECUTE') as costs_au,
      has_function_privilege('service_role', 'public.dashboard_summary(date,date)', 'EXECUTE') as svc`)
    check('grants: anon denied sales_report', g.a === false)
    check('grants: authenticated allowed sales_report', g.au === true)
    check('grants: anon denied audit_page', g.aud_a === false)
    check('grants: authenticated allowed audit_page', g.aud_au === true)
    check('grants: variant_unit_costs internal only', g.costs_au === false)
    check('grants: service_role allowed dashboard_summary', g.svc === true)

    // RLS spot checks on sensitive tables for cashier (no manage_users / view_audit)
    // audit_logs is INSERT-only for authenticated: every read goes through the
    // SECURITY DEFINER audit_page RPC (view_audit_logs gated). Direct SELECT is
    // denied at the GRANT level for every API role (admin included).
    await expectError('RLS: cashier cannot read audit_logs directly (no table grant)',
      () => one(cashier, `select count(*) c from public.audit_logs`), 'permission denied')
    const profilesSeen = await one(cashier, `select count(*) c from public.profiles`)
    check('RLS: cashier sees only own profile', Number(profilesSeen[0].c) === 1)
    const salesSeen = await one(cashier, `select count(*) c from public.sales`)
    check('RLS: cashier sees sales (view_sales)', Number(salesSeen[0].c) === 4)
  }

  async function integrityChecks() {
    console.log('\nM. ledger integrity')

    // stock ledger vs balances for every variant
    const mismatches = await one(root, `
      select sb.variant_id, sb.location_id, sb.quantity, m.ledger_qty
      from public.stock_balances sb
      left join lateral (
        select coalesce(sum(sm.quantity), 0) as ledger_qty
        from public.stock_movements sm
        where sm.variant_id = sb.variant_id and sm.location_id = sb.location_id
      ) m on true
      where sb.quantity <> m.ledger_qty`)
    check('stock: balances == movement ledger for every (variant,location)', mismatches.length === 0, mismatches)

    // dues invariant: paid_amount = genuine payments (incl mirrors), grand = paid + due
    const badSales = await one(root, `
      select s.id, s.sale_number, s.grand_total, s.paid_amount, s.due_amount,
        coalesce((select round(sum(sp.amount),2) from public.sale_payments sp
                  where sp.sale_id = s.id and sp.is_credit = false), 0) as pay_rows
      from public.sales s where s.status = 'COMPLETED'
        and (abs(s.paid_amount - coalesce((select round(sum(sp.amount),2) from public.sale_payments sp
              where sp.sale_id = s.id and sp.is_credit = false), 0)) > 0.01
          or abs(s.grand_total - s.paid_amount - s.due_amount) > 0.01)`)
    check('sales: paid_amount = Σ non-credit sale_payments; grand = paid + due', badSales.length === 0, badSales)

    // no negative payment rows anywhere
    const neg = await one(root, `
      select 'sale_payments' src, count(*) c from public.sale_payments where amount <= 0
      union all select 'customer_payments', count(*) from public.customer_payments where amount <= 0
      union all select 'supplier_payments', count(*) from public.supplier_payments where amount <= 0
      union all select 'expenses', count(*) from public.expenses where amount <= 0
      union all select 'allocations', count(*) from public.customer_payment_allocations where amount <= 0`)
    check('no zero/negative money rows', neg.every((r: any) => Number(r.c) === 0), neg)

    // supplier payable == Σ invoice due
    const pay = await val(root, `select coalesce(sum(due_amount),0) d from public.purchase_invoices where status='RECEIVED'`)
    const paidOut = await val(root, `select coalesce(sum(allocated_amount),0) a from public.supplier_payments`)
    const purVal = await val(root, `select coalesce(sum(grand_total),0) v from public.purchase_invoices where status='RECEIVED'`)
    const prApplied = await val(root, `select coalesce(sum(applied_to_due),0) a from public.purchase_returns`)
    check('payables: invoice dues reconcile with purchases - payments - return credits',
      close(Number(pay.d), Number(purVal.v) - Number(paidOut.a) - Number(prApplied.a)),
      { dues: pay.d, calc: Number(purVal.v) - Number(paidOut.a) - Number(prApplied.a) })

    // orphan checks
    const orphans = await one(root, `
      select 'sale_items' t, count(*) c from public.sale_items si
        left join public.sales s on s.id = si.sale_id where s.id is null
      union all select 'sale_payments', count(*) from public.sale_payments sp
        left join public.sales s on s.id = sp.sale_id where s.id is null
      union all select 'return_items', count(*) from public.sales_return_items sri
        left join public.sales_returns r on r.id = sri.return_id where r.id is null
      union all select 'exchange_out', count(*) from public.exchange_items_out eio
        left join public.exchanges e on e.id = eio.exchange_id where e.id is null`)
    check('no orphan rows', orphans.every((r: any) => Number(r.c) === 0), orphans)

    // allocations never exceed payment amount
    const over = await one(root, `
      select cp.id, cp.receipt_number, cp.amount, coalesce(sum(a.amount),0) alloc
      from public.customer_payments cp
      left join public.customer_payment_allocations a on a.payment_id = cp.id
      group by cp.id, cp.receipt_number, cp.amount
      having coalesce(sum(a.amount),0) > cp.amount + 0.01 or cp.allocated_amount <> coalesce(sum(a.amount),0)`)
    check('customer payments: allocations == allocated_amount and never exceed amount', over.length === 0, over)
  }

  async function concurrencyChecks() {
    console.log('\nN. concurrency')

    // 1. two cashiers race for the last unit of v2 (stock = 3 after S4 sold 1 of 4)
    const c1 = await as(cashierId)
    const c2 = await as((await mkUser('pg12-cashier2@test.local', 'P12 Cashier2', 'cashier')))
    const race: Promise<any>[] = []
    for (const c of [c1, c2]) {
      race.push(rpc(c, 'create_sale', {
        p_payload: JSON.stringify({
          items: [{ variant_id: v2, quantity: 3 }],
          payments: [{ method: 'Cash', amount: 600 }],
        }),
      }))
    }
    const results = await Promise.allSettled(race)
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    const errCount = results.filter((r) => r.status === 'rejected').length
    check('concurrency: exactly one sale wins the last units', okCount === 1 && errCount === 1,
      { okCount, errCount, reasons: results.filter((r) => r.status === 'rejected').map((r: any) => r.reason?.message) })
    const v2After = (await val(root, `select coalesce(sum(quantity),0) q from public.stock_balances where variant_id=$1`, [v2])).q
    check('concurrency: v2 stock = 0 after race (no oversell)', Number(v2After) === 0, v2After)

    // 2. parallel sales -> distinct invoice numbers (counter atomicity)
    const numbers: string[] = []
    await Promise.allSettled(Array.from({ length: 8 }, () =>
      rpc(c1, 'create_sale', {
        p_payload: JSON.stringify({
          items: [{ variant_id: v1, quantity: 1 }],
          payments: [{ method: 'UPI', amount: 200 }],
        }),
      }).then((r: any) => numbers.push(r.sale_number))))
    const distinct = new Set(numbers)
    check('concurrency: 8 parallel sales -> 8 distinct invoice numbers',
      numbers.length === 8 && distinct.size === 8, numbers)

    // 3. two parallel payments recording against same customer dues -> no double allocation
    const dueBefore = (await val(root, `select coalesce(sum(due_amount),0) d from public.sales where customer_id=$1 and status='COMPLETED'`, [cust])).d
    await Promise.allSettled([
      rpc(c1, 'record_customer_payment', { p_customer_id: cust, p_amount: 50, p_method: 'Cash' }),
      rpc(c2, 'record_customer_payment', { p_customer_id: cust, p_amount: 50, p_method: 'Cash' }),
    ])
    const dueAfter = (await val(root, `select coalesce(sum(due_amount),0) d from public.sales where customer_id=$1 and status='COMPLETED'`, [cust])).d
    check('concurrency: parallel payments apply exactly 100',
      close(Number(dueBefore) - Number(dueAfter), 100), { before: dueBefore, after: dueAfter })

    for (const c of [admin, cashier, accountant, invMgr, c1, c2]) {
      try { await c.end() } catch { /* ignore */ }
    }
    await root.end()

    console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`)
    if (failures.length) {
      console.log('FAILURES:')
      for (const f of failures) console.log('  -', f)
    }
    process.exit(failed ? 1 : 0)
  }
}

main().catch((e) => {
  console.error('SUITE CRASHED:', e)
  process.exit(1)
})
