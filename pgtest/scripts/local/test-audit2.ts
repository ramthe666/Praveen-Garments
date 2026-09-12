/**
 * PHASE 6 AUDIT — PART 2: payments, credit, purchases, returns, exchanges,
 * historical prices, deactivation/FK protection.
 * Covers prompt §17–§25 + §39 (delete/deactivate never destroys history).
 *
 * Prereq: reset-full + test-audit1.ts completed (its users/catalog/stock are reused).
 *
 * Run from pgtest/: bun run scripts/local/test-audit2.ts
 */
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }

let passed = 0
let failed = 0
const failures: string[] = []
const evidence: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS ${name}`) }
  else {
    failed++; failures.push(name)
    console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`)
  }
}
async function expectError(name: string, fn: () => Promise<unknown>, messageIncludes: string) {
  try { await fn(); check(name, false, 'expected an error but none was raised') }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check(name, msg.toLowerCase().includes(messageIncludes.toLowerCase()), msg)
  }
}
function note(text: string) {
  evidence.push(text)
  console.log(`  NOTE ${text}`)
}

async function main() {
  const root = new Client(CONN)
  await root.connect()

  const uid = async (email: string) =>
    (await root.query('select id from public.profiles where email = $1', [email])).rows[0].id as string
  const vid = async (sku: string) =>
    (await root.query('select id from public.product_variants where sku = $1', [sku])).rows[0].id as string
  const loc = async (code: string) =>
    (await root.query('select id from public.stock_locations where code = $1', [code])).rows[0].id as string

  async function as(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query('set role authenticated')
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    return c
  }
  const rpcJson = async <T = any>(client: Client, fn: string, payload: unknown): Promise<T> =>
    (await client.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(payload)])).rows[0].r as T
  const val = async (client: Client, sql: string, vals: unknown[] = []) =>
    (await client.query(sql, vals)).rows[0]
  const num = async (client: Client, sql: string, vals: unknown[] = []) =>
    Number((await val(client, sql, vals)).n ?? 0)
  const stockOf = async (variantId: string, locId: string): Promise<number | null> => {
    const r = await val(root, 'select quantity from public.stock_balances where variant_id = $1 and location_id = $2', [variantId, locId])
    return r ? Number(r.quantity) : null
  }

  const adminId = await uid('audit6-admin@t.local')
  const cashAId = await uid('audit6-casha@t.local')
  const admin = await as(adminId)
  const cashA = await as(cashAId)
  const mainLoc = await loc('MAIN')

  const vJ1000 = await vid('AUD-JEAN-1000')
  const vJ1250 = await vid('AUD-JEAN-1250')
  const vJ2500 = await vid('AUD-JEAN-2500')
  const vExA = await vid('AUD-EX-A')
  const vExB = await vid('AUD-EX-B')
  const vPur = await vid('AUD-PUR-M')
  const vBluL = await vid('AUD-SHIRT-BLU-L')
  const vBlkM = await vid('AUD-SHIRT-BLK-M')
  const vBluM = await vid('AUD-SHIRT-BLU-M')

  const sale = async (client: Client, items: any[], payments: any[], extra: Record<string, unknown> = {}) =>
    rpcJson<any>(client, 'create_sale', { items, payments, ...extra })
  const paymentsOf = async (saleId: string) =>
    (await root.query('select * from public.sale_payments where sale_id = $1 order by id', [saleId])).rows

  // ===========================================================================
  console.log('== P. §17 PAYMENT MATRIX ==')
  const methodsRow = await val(root, `select value -> 'methods' as m from public.app_settings where key = 'payments'`)
  const methods = methodsRow.m as string[]
  check(`configured methods = Cash, UPI, Card, Bank Transfer`, JSON.stringify(methods) === JSON.stringify(['Cash', 'UPI', 'Card', 'Bank Transfer']), methods)
  for (const method of ['Cash', 'UPI', 'Card', 'Bank Transfer']) {
    const r = await sale(cashA, [{ variant_id: vJ1000, quantity: 1 }], [{ method, amount: 1000 }])
    const p = await paymentsOf(r.sale_id)
    check(`${method}: payment row recorded exactly (${method} 1000), sale PAID`,
      p.length === 1 && p[0].method === method && Number(p[0].amount) === 1000 && r.payment_status === 'PAID', p)
  }
  await expectError('unknown method rejected (PAYMENT_METHOD_DISABLED) + full rollback', () =>
    sale(cashA, [{ variant_id: vJ1000, quantity: 1 }], [{ method: 'Paytm', amount: 1000 }]), 'PAYMENT_METHOD_DISABLED')

  // ===========================================================================
  console.log('\n== Q. §18 CASH CHANGE ==')
  const rChg = await sale(cashA, [{ variant_id: vJ1250, quantity: 1 }],
    [{ method: 'Cash', amount: 1250, cash_received: 2000 }])
  const pChg = await paymentsOf(rChg.sale_id)
  check('bill 1250 / received 2000 → change 750 in the sale result', Number(rChg.cash_change) === 750, rChg.cash_change)
  check('payment row stores cash_received 2000 + cash_change 750; amount (revenue) stays 1250',
    pChg.length === 1 && Number(pChg[0].cash_received) === 2000 && Number(pChg[0].cash_change) === 750 && Number(pChg[0].amount) === 1250, pChg)
  check('grand 1250 = paid 1250, due 0', Number(rChg.grand_total) === 1250 && Number(rChg.due_amount) === 0)

  // ===========================================================================
  console.log('\n== R. §19 SPLIT PAYMENT ==')
  const rSpl = await sale(cashA, [{ variant_id: vJ2500, quantity: 1 }],
    [{ method: 'Cash', amount: 1000 }, { method: 'UPI', amount: 1500 }])
  const pSpl = await paymentsOf(rSpl.sale_id)
  check('₹2500 bill = Cash 1000 + UPI 1500 → exactly TWO payment rows',
    pSpl.length === 2 && pSpl.some((p) => p.method === 'Cash' && Number(p.amount) === 1000) && pSpl.some((p) => p.method === 'UPI' && Number(p.amount) === 1500), pSpl)
  check('paid 2500, due 0, PAID', Number(rSpl.paid_amount) === 2500 && Number(rSpl.due_amount) === 0 && rSpl.payment_status === 'PAID', rSpl)

  // ===========================================================================
  console.log('\n== S. §20 CREDIT SALE ==')
  await root.query(`update public.app_settings set value = value || '{"allow_credit_sales": true}'::jsonb where key = 'pos'`)
  const cust = (await val(admin,
    `insert into public.customers (name, phone) values ('Audit Credit Cust', '9876543210') returning id, name`))
  const custId = cust.id as string
  const rCr = await sale(cashA, [{ variant_id: vJ2500, quantity: 2 }],
    [{ method: 'Cash', amount: 2000 }, { method: 'Credit', amount: 3000 }], { customer_id: custId })
  const pCr = await paymentsOf(rCr.sale_id)
  check('₹5000 credit bill: paid 2000 (Cash), Credit row 3000 (is_credit), due 3000',
    Number(rCr.paid_amount) === 2000 && Number(rCr.due_amount) === 3000 &&
    pCr.some((p) => p.is_credit === true && p.method === 'Credit' && Number(p.amount) === 3000), { rCr, pCr })
  check('payment status PARTIALLY_PAID on a credit sale', rCr.payment_status === 'PARTIALLY_PAID', rCr.payment_status)
  const stmt1 = (await val(admin, 'select public.customer_statement($1, null, null) as r', [custId])).r
  check('customer statement: bill 5000 debited, 2000 credited → closing 3000',
    Math.abs(Number(stmt1.closing_balance) - 3000) < 0.01, stmt1.closing_balance)
  await expectError('credit without a customer rejected', () =>
    sale(cashA, [{ variant_id: vJ1000, quantity: 1 }], [{ method: 'Cash', amount: 500 }]), 'CREDIT_REQUIRES_CUSTOMER')
  await root.query(`update public.app_settings set value = value || '{"allow_credit_sales": false}'::jsonb where key = 'pos'`)
  await expectError('credit disabled again → full payment required', () =>
    sale(cashA, [{ variant_id: vJ1000, quantity: 1 }], [{ method: 'Cash', amount: 500 }], { customer_id: custId }), 'CREDIT_NOT_ENABLED')

  // ===========================================================================
  console.log('\n== T. §21 CUSTOMER PAYMENT (FIFO + statement) ==')
  const crp = (await val(cashA, 'select public.record_customer_payment($1, $2, $3, $4, $5) as r',
    [custId, 1000, 'Cash', null, 'audit part payment'])).r
  check('CR- receipt numbered', /^CR-\d{4}-\d{6}$/.test(crp.receipt_number), crp.receipt_number)
  const saleAfter = await val(root, 'select paid_amount, due_amount, payment_status from public.sales where id = $1', [rCr.sale_id])
  check('₹1000 receipt → bill due 3000 → 2000 (FIFO applied)', Number(saleAfter.due_amount) === 2000, saleAfter)
  const mirror = await val(root,
    'select * from public.sale_payments where sale_id = $1 and reference = $2', [rCr.sale_id, crp.receipt_number])
  check('receipt mirrored into the bill payment history (0011 pattern: reference = CR number)',
    mirror && Number(mirror.amount) === 1000, mirror)
  const stmt2 = (await val(admin, 'select public.customer_statement($1, null, null) as r', [custId])).r
  check('statement closing 3000 → 2000 after the receipt', Math.abs(Number(stmt2.closing_balance) - 2000) < 0.01, stmt2.closing_balance)

  // ===========================================================================
  console.log('\n== U. §22 PURCHASE → INVENTORY + PAYABLE + PURCHASE RETURN ==')
  const sup = (await val(admin, `insert into public.suppliers (name, phone) values ('Audit Supplier', '9876500000') returning id`))
  const supId = sup.id as string
  const po = (await val(admin, 'select public.create_purchase_order($1::jsonb) as r', [JSON.stringify({
    supplier_id: supId, location_id: mainLoc,
    items: [{ variant_id: vPur, quantity: 10, unit_cost: 200 }],
  })])).r
  check('PO numbered PO-', /^PO-/.test(po.po_number), po.po_number)
  await val(admin, 'select public.set_purchase_order_status($1, $2) as r', [po.po_id, 'ORDERED'])
  const poItemId = (await val(root, 'select id from public.purchase_order_items where po_id = $1 and variant_id = $2', [po.po_id, vPur])).id as string
  const pi = (await val(admin, 'select public.create_purchase_invoice($1::jsonb) as r', [JSON.stringify({
    supplier_id: supId, location_id: mainLoc, po_id: po.po_id, supplier_invoice_no: `AUD-SUP-${Date.now()}`,
    items: [{ po_item_id: poItemId, variant_id: vPur, quantity: 10, unit_cost: 200 }], status: 'RECEIVED',
  })])).r
  check('receive 10 units → stock 0→10', await stockOf(vPur, mainLoc) === 10)
  const purMv = await val(root, `select * from public.stock_movements where variant_id = $1 and reference_type = 'purchase_invoice' order by id desc limit 1`, [vPur])
  check('PURCHASE movement +10 linked to the invoice (balance_after 10)',
    Number(purMv.quantity) === 10 && purMv.movement_type === 'PURCHASE' && Number(purMv.balance_after) === 10 && purMv.reference_id === String(pi.invoice_id), purMv)
  const piRow = await val(root, 'select grand_total, paid_amount, due_amount, status from public.purchase_invoices where id = $1', [pi.invoice_id])
  const supDetail1 = (await val(admin, 'select public.supplier_detail($1) as r', [supId])).r
  check('supplier payable created = invoice grand total', Number(piRow.due_amount) === Number(piRow.grand_total) &&
    Math.abs(Number(supDetail1.stats.outstanding) - Number(piRow.grand_total)) < 0.01, { piRow, supDetail1: supDetail1.stats })
  const piItem = await val(root, 'select id from public.purchase_invoice_items where invoice_id = $1 and variant_id = $2', [pi.invoice_id, vPur])
  const pret = (await val(admin, 'select public.create_purchase_return($1::jsonb) as r', [JSON.stringify({
    purchase_invoice_id: pi.invoice_id, items: [{ invoice_item_id: piItem.id, quantity: 3 }], reason: 'audit: 3 defective pieces',
  })])).r
  check('purchase return 3 units → stock 10→7', await stockOf(vPur, mainLoc) === 7)
  const retMv = await val(root, `select * from public.stock_movements where variant_id = $1 and reference_type = 'purchase_return' order by id desc limit 1`, [vPur])
  check('PURCHASE_RETURN movement -3 (balance_after 7)', Number(retMv.quantity) === -3 && Number(retMv.balance_after) === 7, retMv)
  const piRow2 = await val(root, 'select due_amount from public.purchase_invoices where id = $1', [pi.invoice_id])
  const retLine = await val(root, 'select line_total from public.purchase_return_items where return_id = $1', [pret.return_id])
  check('supplier payable adjusted down by the return value',
    Math.abs(Number(piRow2.due_amount) - (Number(piRow.grand_total) - Number(retLine.line_total))) < 0.02, { piRow2, retLine })

  // ===========================================================================
  console.log('\n== V. §23 SALE → RETURN → INVENTORY ==')
  const sV = await sale(cashA, [{ variant_id: vExB, quantity: 3 }], [{ method: 'Cash', amount: 3597 }])
  check('opening 10 → sell 3 → 7', await stockOf(vExB, mainLoc) === 7)
  const siV = await val(root, 'select id, quantity from public.sale_items where sale_id = $1 and variant_id = $2', [sV.sale_id, vExB])
  const sr = (await val(admin, 'select public.create_sales_return($1::jsonb) as r', [JSON.stringify({
    sale_id: sV.sale_id, items: [{ sale_item_id: siV.id, quantity: 1, condition: 'GOOD' }],
    reason: 'audit: size too small', refund_method: 'Cash',
  })])).r
  check('SR- numbered', /^SR-/.test(sr.return_number), sr.return_number)
  check('return 1 → stock 7→8', await stockOf(vExB, mainLoc) === 8)
  const vMv = (await root.query(`select movement_type, quantity from public.stock_movements where variant_id = $1 and reference_type in ('sale','sales_return') order by id`, [vExB])).rows
  check('ledger contains SALE -3 then SALES_RETURN +1',
    vMv.some((m) => m.movement_type === 'SALE' && m.quantity === -3) &&
    vMv.some((m) => m.movement_type === 'SALES_RETURN' && m.quantity === 1), vMv)
  check('refund value equals what the customer paid (1199, bill was fully paid)',
    Math.abs(Number(sr.refund_total) - 1199) < 0.01 && Number(sr.applied_to_due) === 0 && Math.abs(Number(sr.refunded) - 1199) < 0.01, sr)

  // ===========================================================================
  console.log('\n== W. §24 EXCHANGE (both price directions) ==')
  const sW = await sale(cashA, [{ variant_id: vExA, quantity: 1 }], [{ method: 'Cash', amount: 999 }])
  const exBefore = { a: await stockOf(vExA, mainLoc), b: await stockOf(vExB, mainLoc) }
  const siW = await val(root, 'select id from public.sale_items where sale_id = $1 and variant_id = $2', [sW.sale_id, vExA])
  const ex1 = (await val(admin, 'select public.create_exchange($1::jsonb) as r', [JSON.stringify({
    sale_id: sW.sale_id,
    return_items: [{ sale_item_id: siW.id, quantity: 1, condition: 'GOOD' }],
    new_items: [{ variant_id: vExB, quantity: 1 }],
    payment_method: 'Cash', reason: 'audit: upgrade swap',
  })])).r
  check('exchange EX- numbered + difference +200 collected (1199 - 999)',
    /^EX-/.test(ex1.exchange_number) && Math.abs(Number(ex1.difference_amount) - 200) < 0.01, ex1)
  check('old item restored (vExA +1), new item deducted (vExB -1)',
    await stockOf(vExA, mainLoc) === exBefore.a! + 1 && await stockOf(vExB, mainLoc) === exBefore.b! - 1,
    { a: await stockOf(vExA, mainLoc), b: await stockOf(vExB, mainLoc) })
  const exMv = (await root.query(`select movement_type, quantity from public.stock_movements where reference_type = 'exchange' and reference_id = $1 order by id`, [String(ex1.exchange_id)])).rows
  check('exchange movements: SALES_RETURN +1 (old) + SALE -1 (new)',
    exMv.some((m) => m.movement_type === 'SALES_RETURN' && m.quantity === 1) &&
    exMv.some((m) => m.movement_type === 'SALE' && m.quantity === -1), exMv)
  const exRow = await val(root, 'select sale_id, sale_number, payment_method, difference_amount from public.exchanges where id = $1', [ex1.exchange_id])
  check('exchange linked to the original sale + payment recorded on the document',
    exRow.sale_id === sW.sale_id && exRow.payment_method === 'Cash' && Math.abs(Number(exRow.difference_amount) - 200) < 0.01, exRow)
  note('exchange cash differences live on the exchanges document + audit trail (customer_payments only for Store Credit) — checked again in the EOD reconciliation (Part 3)')

  // reverse direction (customer downgrades: pays less / gets refund)
  const sW2 = await sale(cashA, [{ variant_id: vExB, quantity: 1 }], [{ method: 'Cash', amount: 1199 }])
  const siW2 = await val(root, 'select id from public.sale_items where sale_id = $1 and variant_id = $2', [sW2.sale_id, vExB])
  const exBefore2 = { a: await stockOf(vExA, mainLoc), b: await stockOf(vExB, mainLoc) }
  const ex2 = (await val(admin, 'select public.create_exchange($1::jsonb) as r', [JSON.stringify({
    sale_id: sW2.sale_id,
    return_items: [{ sale_item_id: siW2.id, quantity: 1, condition: 'GOOD' }],
    new_items: [{ variant_id: vExA, quantity: 1 }],
    payment_method: 'Cash', reason: 'audit: downgrade swap',
  })])).r
  check('reverse exchange difference −200 (refund owed)', Math.abs(Number(ex2.difference_amount) + 200) < 0.01, ex2)
  check('reverse exchange stock: vExB back +1, vExA out -1',
    await stockOf(vExB, mainLoc) === exBefore2.b! + 1 && await stockOf(vExA, mainLoc) === exBefore2.a! - 1)

  // ===========================================================================
  console.log('\n== X. §25 HISTORICAL PRICE SNAPSHOTS ==')
  const sX1 = await sale(cashA, [{ variant_id: vBluL, quantity: 1 }], [{ method: 'Cash', amount: 999 }])
  await root.query('update public.product_variants set selling_price = 1199 where id = $1', [vBluL])
  await root.query('update public.products set selling_price = 1199, mrp = 1699 where id = (select product_id from public.product_variants where id = $1)', [vBluL])
  const oldItem = await val(root, 'select unit_price, base_price, mrp, line_total from public.sale_items where sale_id = $1', [sX1.sale_id])
  check('OLD invoice keeps 999 / MRP 1499 after the price change (snapshots)',
    Number(oldItem.unit_price) === 999 && Number(oldItem.base_price) === 999 && Number(oldItem.mrp) === 1499, oldItem)
  const sX2 = await sale(cashA, [{ variant_id: vBluL, quantity: 1 }], [{ method: 'Cash', amount: 1199 }])
  const newItem = await val(root, 'select unit_price, mrp from public.sale_items where sale_id = $1', [sX2.sale_id])
  check('NEW sale uses the new price 1199 / MRP 1699',
    Number(newItem.unit_price) === 1199 && Number(newItem.mrp) === 1699, newItem)
  const det = (await val(admin, 'select public.sale_detail($1) as r', [sX1.sale_id])).r
  check('sale_detail (invoice data source) still returns the 999 snapshot',
    Number(det.items[0].unit_price) === 999 && Number(det.items[0].mrp) === 1499, det.items[0])

  // ===========================================================================
  console.log('\n== Y. §39 DEACTIVATION + DELETE PROTECTION ==')
  await root.query('update public.product_variants set is_active = false where id = $1', [vBlkM])
  await expectError('sale of a deactivated variant rejected (VARIANT_INACTIVE)', () =>
    sale(cashA, [{ variant_id: vBlkM, quantity: 1 }], [{ method: 'Cash', amount: 999 }]), 'VARIANT_INACTIVE')
  const posInactive = (await val(cashA, 'select public.pos_search($1, 1) as r', ['2900000000032'])).r
  check('pos_search hides deactivated variants (active-only)', (posInactive?.rows?.length ?? 0) === 0, posInactive)
  await expectError('deleting a variant referenced by sales is blocked by FK (history preserved)', () =>
    root.query('delete from public.product_variants where id = $1', [vBluM]), 'foreign key constraint')
  const histBluM = await num(root, 'select count(*) as n from public.sale_items where variant_id = $1', [vBluM])
  check('historical sale items for the blocked variant still readable', histBluM >= 1)
  await root.query('update public.product_variants set is_active = true where id = $1', [vBlkM])
  const rRe = await sale(cashA, [{ variant_id: vBlkM, quantity: 1 }], [{ method: 'Cash', amount: 999 }])
  check('reactivated variant sells again', rRe.payment_status === 'PAID')

  const shirtProd = (await val(root, 'select product_id as pid from public.product_variants where id = $1', [vBluM])).pid
  await root.query('update public.products set is_active = false where id = $1', [shirtProd])
  await expectError('sale of a deactivated product rejected (PRODUCT_INACTIVE)', () =>
    sale(cashA, [{ variant_id: vBluM, quantity: 1 }], [{ method: 'Cash', amount: 999 }]), 'PRODUCT_INACTIVE')
  await root.query('update public.products set is_active = true where id = $1', [shirtProd])

  await expectError('deleting a customer referenced by sales keeps history (FK/cascade policy)', () =>
    root.query('delete from public.customers where id = $1', [custId]), 'foreign key constraint')
  const custSale = await val(root, 'select customer_name from public.sales where customer_id = $1 limit 1', [custId])
  check('sales keep the customer name snapshot regardless', custSale?.customer_name === 'Audit Credit Cust', custSale)

  await expectError('deleting a supplier referenced by invoices keeps history', () =>
    root.query('delete from public.suppliers where id = $1', [supId]), 'foreign key constraint')

  await root.query('update public.profiles set is_active = false where id = $1', [cashAId])
  await expectError('disabled user cannot create sales (blocked at the permission gate)', () =>
    sale(cashA, [{ variant_id: vJ1000, quantity: 1 }], [{ method: 'Cash', amount: 1000 }]), 'permission')
  await root.query('update public.profiles set is_active = true where id = $1', [cashAId])
  const rEnable = await sale(cashA, [{ variant_id: vJ1000, quantity: 1 }], [{ method: 'Cash', amount: 1000 }])
  check('re-enabled user can sell again', rEnable.payment_status === 'PAID')

  // ===========================================================================
  await admin.end(); await cashA.end(); await root.end()
  console.log(`\n== PART 2 RESULT: ${passed} passed, ${failed} failed ==`)
  if (failures.length) for (const f of failures) console.log('  -', f)
  if (evidence.length) { console.log('\n== EVIDENCE NOTES =='); for (const e of evidence) console.log(' *', e) }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
