/**
 * 0011 (customer_statement till-payment fix) — focused local test suite.
 * Runs against the local Supabase-compatible harness (NOT production).
 *
 * Prerequisite: bun run scripts/local/reset-full.ts  (chain 0001 -> 0010,
 * i.e. the exact state of the cloud right now). This script then:
 *
 *   1. reproduces the reported bug  (statement closing ₹1,418 vs ₹618 dues)
 *   2. applies 0011_phase4_statement_till_payments.sql
 *   3. verifies the fix + every regression branch:
 *        - closing == real dues (₹618 -> ₹0)
 *        - ledger receipts (record_customer_payment) NOT double-counted
 *        - advance / 'Store Credit' mirrors NOT double-counted
 *        - credit-sale marker rows (is_credit) never credited
 *        - opening balance across a date boundary includes till payments
 *        - sales-return credit branch unchanged
 *        - cancelled sale: bill AND its till payment both excluded
 *        - permission gate + grants intact
 *
 * Run from pgtest/: bun run scripts/local/test-0011.ts
 */
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }
const M0011 = '../supabase/migrations/0011_phase4_statement_till_payments.sql'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`)
  }
}

async function expectError(name: string, fn: () => Promise<unknown>, messageIncludes: string) {
  try {
    await fn()
    check(name, false, 'expected an error but none was raised')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check(name, msg.toLowerCase().includes(messageIncludes.toLowerCase()), msg)
  }
}

async function main() {
  const root = new Client(CONN)
  await root.connect()

  // ---- purge (makes reruns safe; mirrors test-phase4 patterns) -----------
  async function purgeAll() {
    await root.query('alter table public.stock_movements disable trigger stock_movements_append_only')
    await root.query('alter table public.stock_balances disable trigger stock_balances_engine_guard')
    await root.query(`delete from public.exchange_items_in`)
    await root.query(`delete from public.exchange_items_out`)
    await root.query(`delete from public.exchanges`)
    await root.query(`delete from public.sales_return_items`)
    await root.query(`delete from public.sales_returns`)
    await root.query(`delete from public.customer_payment_allocations`)
    await root.query(`delete from public.customer_payments`)
    await root.query('delete from public.sale_payments')
    await root.query('delete from public.sale_items')
    await root.query('delete from public.sales')
    await root.query('delete from public.held_bills')
    await root.query('delete from public.customers')
    await root.query('delete from public.sale_number_counters')
    await root.query('delete from public.stock_movements')
    await root.query('delete from public.stock_balances')
    await root.query('alter table public.stock_balances enable trigger stock_balances_engine_guard')
    await root.query('alter table public.stock_movements enable trigger stock_movements_append_only')
    await root.query('delete from public.audit_logs')
    await root.query('delete from public.product_variants')
    await root.query('delete from public.products')
    await root.query('delete from public.categories')
    await root.query('delete from public.sizes')
    await root.query('delete from public.colors')
    await root.query(`delete from public.profiles where email like 'pg11-%'`)
    await root.query(`delete from auth.users where email like 'pg11-%'`)
  }
  await purgeAll()

  // ---- settings -----------------------------------------------------------
  await root.query(`update public.app_settings set value = jsonb_build_object(
    'require_customer', false, 'allow_price_edit', false, 'round_off', false,
    'default_payment_method', 'Cash', 'bill_footer_note', 'x',
    'allow_credit_sales', true, 'default_tax_mode', 'inclusive',
    'max_item_discount_pct', 10, 'max_bill_discount_pct', 10
  ) where key = 'pos'`)
  await root.query(`update public.app_settings set value = jsonb_build_object(
    'methods', '["Cash","UPI","Card","Bank Transfer"]'::jsonb,
    'allow_advance_payments', false
  ) where key = 'payments'`)
  await root.query(`update public.company_settings set company_name = 'P11TEST Retail', state = 'Tamil Nadu', timezone = 'Asia/Kolkata' where id = 1`)

  // ---- users --------------------------------------------------------------
  async function mkUser(email: string, name: string, role: string) {
    const id = (await root.query(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify({ app_role: role, full_name: name })]
    )).rows[0].id as string
    await root.query(
      `insert into public.profiles (id, email, full_name, role)
       values ($1, $2, $3, $4::public.user_role)
       on conflict (id) do update set role = $4::public.user_role, is_active = true`,
      [id, email, name, role]
    )
    return id
  }
  const adminId = await mkUser('pg11-admin@test.local', 'P11 Admin', 'admin')
  const cashierId = await mkUser('pg11-cashier@test.local', 'P11 Cashier', 'cashier')
  const managerId = await mkUser('pg11-manager@test.local', 'P11 Manager', 'manager')
  const buyerId = await mkUser('pg11-buyer@test.local', 'P11 Buyer', 'purchase_manager')

  async function asUser(userId: string | null, role = 'authenticated'): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query(`set role ${role}`)
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    return c
  }
  const admin = await asUser(adminId)
  const cashier = await asUser(cashierId)
  const manager = await asUser(managerId)
  const buyer = await asUser(buyerId)

  // ---- catalog + stock ----------------------------------------------------
  const catId = (await root.query(`insert into public.categories (name) values ('P11TEST Shirts') returning id`)).rows[0].id
  const sizeM = (await root.query(`insert into public.sizes (name) values ('M') returning id`)).rows[0].id
  const colorId = (await root.query(`insert into public.colors (name) values ('Blue') returning id`)).rows[0].id
  const shirtProd = (await root.query(
    `insert into public.products (name, product_code, category_id, hsn_code, gst_rate, mrp, selling_price)
     values ('P11TEST Shirt', 'P11T-SHIRT', $1, '6105', 0, 999, 500) returning id`, [catId]
  )).rows[0].id
  const vShirt = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, barcode, qr_identifier)
     values ($1, 'P11T-SHIRT-M', $2, $3, '4000000000117', 'P11TQR0001') returning id`,
    [shirtProd, sizeM, colorId]
  )).rows[0].id
  const socksProd = (await root.query(
    `insert into public.products (name, product_code, category_id, hsn_code, gst_rate, mrp, selling_price)
     values ('P11TEST Socks', 'P11T-SOCKS', $1, '6115', 0, 300, 209) returning id`, [catId]
  )).rows[0].id
  const vSocks = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, barcode, qr_identifier)
     values ($1, 'P11T-SOCKS-M', $2, $3, '4000000000124', 'P11TQR0002') returning id`,
    [socksProd, sizeM, colorId]
  )).rows[0].id
  const mainLoc = (await root.query(`select id from public.stock_locations where code = 'MAIN'`)).rows[0].id as string
  for (const [vid, qty] of [[vShirt, 20], [vSocks, 20]] as [string, number][]) {
    await admin.query('select public.set_opening_stock($1, $2, $3, $4)', [vid, mainLoc, qty, 'P11 opening'])
  }

  // ---- customer -----------------------------------------------------------
  const cust = (await root.query(
    `insert into public.customers (name, phone, email, city, state, customer_type, credit_limit)
     values ('P11TEST Ravi Kumar', '9876543210', 'ravi11@test.local', 'Chennai', 'Tamil Nadu', 'retail', 5000)
     returning id`
  )).rows[0].id as string

  async function mkSale(c: Client, items: { variant_id: string; quantity: number }[], customerId: string | null, pay: { method: string; amount: number }[]) {
    const r = (await c.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items, customer_id: customerId,
      bill_discount_type: 'pct', bill_discount_value: 0,
      payments: pay.map(p => ({ ...p, cash_received: p.amount })),
      notes: 'P11 statement test',
    })])).rows[0].r
    if (!r?.sale_id) throw new Error('create_sale failed: ' + JSON.stringify(r))
    return r
  }
  async function statement(c: Client, from: string | null = null, to: string | null = null) {
    const r = (await c.query('select public.customer_statement($1::uuid, $2::date, $3::date) as s', [cust, from, to])).rows[0].s
    if (!r) throw new Error('customer_statement returned null')
    return r as any
  }
  const dues = async () =>
    Number((await root.query(
      `select coalesce(sum(s.due_amount), 0) as d from public.sales s
       where s.customer_id = $1 and s.status = 'COMPLETED'`, [cust]
    )).rows[0].d)

  console.log('\n== PHASE B: reproduce the reported bug (pre-0011) ==')
  // bill A: 2 x 500 = 1000, 500 paid at the till -> due 500
  const billA = await mkSale(cashier, [{ variant_id: vShirt, quantity: 2 }], cust, [{ method: 'Cash', amount: 500 }])
  check('bill A: 1,000 billed, 500 till-paid, due 500', Number(billA.due_amount) === 500 && Number(billA.grand_total) === 1000, billA)
  // bill B: 2 x 209 = 418, 300 paid at the till -> due 118
  const billB = await mkSale(cashier, [{ variant_id: vSocks, quantity: 2 }], cust, [{ method: 'UPI', amount: 300 }])
  check('bill B: 418 billed, 300 till-paid, due 118', Number(billB.due_amount) === 118 && Number(billB.grand_total) === 418, billB)

  check('real dues everywhere else: 618', (await dues()) === 618)

  const pre = await statement(manager)
  const preKinds = new Set((pre.lines as any[]).map(l => l.kind))
  if (Number(pre.closing_balance) === 618 && preKinds.has('till_payment')) {
    console.log('  NOTE: 0011 already applied on this database — bug repro skipped (fix present)')
  } else {
    check('BUG REPRO: statement closing shows 1,418 (overstated by the 800 till-paid)', Number(pre.closing_balance) === 1418, pre.closing_balance)
    check('BUG REPRO: no till_payment credit lines exist pre-fix', !preKinds.has('till_payment'))
  }

  console.log('\n== PHASE C: apply 0011 ==')
  await root.query(readFileSync(M0011, 'utf8'))
  console.log('  applied 0011_phase4_statement_till_payments.sql')

  const fixed = await statement(manager)
  check('FIX: closing balance == real dues 618', Number(fixed.closing_balance) === 618, fixed.closing_balance)
  const tillLines = (fixed.lines as any[]).filter(l => l.kind === 'till_payment')
  check('till payment lines present: exactly 2, crediting 500 + 300', tillLines.length === 2 && Math.abs(tillLines.reduce((s, l) => s + Number(l.credit), 0) - 800) < 0.01, tillLines)
  check('till payment doc_number is the sale it settled', tillLines.every(l => l.doc_number === billA.sale_number || l.doc_number === billB.sale_number), tillLines)
  check('output shape unchanged (all keys, line fields)', ['customer', 'from_date', 'to_date', 'opening_balance', 'lines', 'closing_balance'].every(k => k in fixed)
    && (fixed.lines as any[]).every(l => ['entry_date', 'kind', 'doc_number', 'debit', 'credit', 'link_id'].every(k => k in l)))
  check('full-range opening balance still 0', Number(fixed.opening_balance) === 0)

  console.log('\n== PHASE D: ledger receipts must NOT be double-counted ==')
  const cr1 = (await cashier.query('select public.record_customer_payment($1, $2, $3, $4, $5) as r',
    [cust, 618, 'Cash', null, 'FIFO settle'])).rows[0].r
  check('receipt CR- recorded and fully allocated', String(cr1.receipt_number).startsWith('CR-') && Number(cr1.allocated_amount) === 618, cr1)
  check('dues now 0', (await dues()) === 0)
  const afterD = await statement(manager)
  check('closing 0 after FIFO receipt (mirror rows in sale_payments NOT credited again)', Number(afterD.closing_balance) === 0, afterD.closing_balance)

  console.log('\n== PHASE E: advance + Store Credit mirror + credit-sale marker ==')
  await root.query(`update public.app_settings set value = jsonb_set(value, '{allow_advance_payments}', 'true') where key = 'payments'`)
  const cr2 = (await cashier.query('select public.record_customer_payment($1, $2, $3) as r',
    [cust, 200, 'UPI'])).rows[0].r
  check('advance receipt stored unallocated', Number(cr2.advance_amount) === 200, cr2)
  // bill C: 1 x 500 credit sale (nothing paid at the till)
  const billC = await mkSale(cashier, [{ variant_id: vShirt, quantity: 1 }], cust, [])
  check('credit sale: due 500, PARTIALLY/DUE status', Number(billC.due_amount) === 500, billC)
  const applied = (await cashier.query('select public.apply_customer_advance($1) as r', [cust])).rows[0].r
  check('advance of 200 applied to bill C', Number(applied.applied_amount) === 200, applied)
  check('dues now 300', (await dues()) === 300)
  const afterE = await statement(manager)
  const tillLinesE = (afterE.lines as any[]).filter(l => l.kind === 'till_payment')
  check('closing 300 == dues (Store Credit mirror not double-counted, advance netted)', Number(afterE.closing_balance) === 300, afterE.closing_balance)
  check('till payment lines still exactly 2 / 800 (mirrors + Credit marker excluded)', tillLinesE.length === 2 && Math.abs(tillLinesE.reduce((s, l) => s + Number(l.credit), 0) - 800) < 0.01, tillLinesE)

  console.log('\n== PHASE F: date range — opening balance carries prior till payments ==')
  await root.query(`update public.sales set sale_date = now() - interval '40 days' where id = $1`, [billA.sale_id])
  await root.query(`update public.sale_payments set created_at = now() - interval '40 days' where sale_id = $1`, [billA.sale_id])
  const ranged = await statement(manager, new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10), null)
  check('opening includes old bill minus its till payment (1000 - 500)', Number(ranged.opening_balance) === 500, ranged.opening_balance)
  check('ranged closing still 300', Number(ranged.closing_balance) === 300, ranged.closing_balance)

  console.log('\n== PHASE G: sales-return credit branch unchanged ==')
  const siC = (await root.query('select id from public.sale_items where sale_id = $1 and variant_id = $2', [billC.sale_id, vShirt])).rows[0].id
  const ret = (await manager.query('select public.create_sales_return($1::jsonb) as r', [JSON.stringify({
    sale_id: billC.sale_id, items: [{ sale_item_id: siC, quantity: 1, condition: 'GOOD' }],
    reason: 'P11 statement return test', refund_method: 'Cash',
  })])).rows[0].r
  const retRow = (await root.query('select applied_to_due, refund_amount from public.sales_returns where id = $1', [ret.return_id ?? ret.id])).rows[0]
  check('return recorded with credit values', !!retRow, ret)
  const beforeG = Number(ranged.closing_balance)
  const afterG = await statement(manager, new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10), null)
  const expectedG = beforeG - (Number(retRow.applied_to_due) + Number(retRow.refund_amount))
  check('return credited exactly once (applied_to_due + refund_amount)', Math.abs(Number(afterG.closing_balance) - expectedG) < 0.01, { before: beforeG, after: afterG.closing_balance, retRow })
  check("'return' line kind still rendered", (afterG.lines as any[]).some(l => l.kind === 'return'))

  console.log('\n== PHASE H: cancelled sale — bill and till payment both excluded ==')
  const beforeH = Number((await statement(manager)).closing_balance)
  const billD = await mkSale(cashier, [{ variant_id: vShirt, quantity: 1 }], cust, [{ method: 'Cash', amount: 500 }])
  check('bill D fully paid at till', Number(billD.due_amount) === 0, billD)
  const midH = Number((await statement(manager)).closing_balance)
  check('paid bill changes nothing while COMPLETED (debit 500 == till credit 500)', Math.abs(midH - beforeH) < 0.01, { beforeH, midH })
  await manager.query('select public.cancel_sale($1, $2)', [billD.sale_id, 'P11 cancel test'])
  const afterH = Number((await statement(manager)).closing_balance)
  check('cancelled sale: bill AND its till payment both excluded', Math.abs(afterH - beforeH) < 0.01, { beforeH, afterH })

  console.log('\n== PHASE I/J: permission gate + grants ==')
  await expectError('unauthorized role denied', async () => {
    await buyer.query('select public.customer_statement($1::uuid, null, null)', [cust])
  }, 'You do not have permission to view customers')
  const anon = await asUser(null, 'anon')
  await expectError('anon cannot execute (grant revoked)', async () => {
    await anon.query('select public.customer_statement($1::uuid, null, null)', [cust])
  }, 'permission denied')

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`)
  if (failures.length) console.log('failures:', failures.join(' | '))
  for (const c of [root, admin, cashier, manager, buyer, anon]) await c.end().catch(() => {})
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
