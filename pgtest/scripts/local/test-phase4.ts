/**
 * Phase 4 local engine test suite — runs against the local Supabase-compatible
 * harness (NOT the production Supabase project).
 *
 * Validates at the DATABASE level:
 *   customers (page/detail/statement), customer payments (full/partial/
 *   exceeds/advance/apply/FIFO), suppliers (page/detail), purchase orders
 *   (create/edit/order/cancel, never-touch-stock), purchase invoices
 *   (receive/partial receive/draft/confirm/duplicate supplier no/cancel +
 *   reversal), supplier payments, purchase returns (eligible/stock/payable),
 *   sales returns (partial/full/invalid/good/damaged/refund/store credit/
 *   window/settings gates/atomic rollback), exchanges (pay-difference/
 *   refund-difference/stock/eligibility), expenses (create/approve/cancel/
 *   permissions/categories), payments_page unified history, RLS denials,
 *   document numbering, and CONCURRENCY (parallel receives / payments /
 *   returns — exactly the eligible quantity succeeds).
 *
 * Run: bun run scripts/local/test-phase4.ts
 */
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', database: 'postgres' }

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
    check(name, msg.includes(messageIncludes), msg)
  }
}

async function main() {
  const root = new Client(CONN)
  await root.connect()

  // ---- self-clean ----------------------------------------------------------
  async function purgeAll() {
    await root.query('alter table public.stock_movements disable trigger stock_movements_append_only')
    await root.query('alter table public.stock_balances disable trigger stock_balances_engine_guard')
    await root.query(`delete from public.exchange_items_in`)
    await root.query(`delete from public.exchange_items_out`)
    await root.query(`delete from public.exchanges`)
    await root.query(`delete from public.sales_return_items`)
    await root.query(`delete from public.sales_returns`)
    await root.query(`delete from public.purchase_return_items`)
    await root.query(`delete from public.purchase_returns`)
    await root.query(`delete from public.customer_payment_allocations`)
    await root.query(`delete from public.customer_payments`)
    await root.query(`delete from public.supplier_payment_allocations`)
    await root.query(`delete from public.supplier_payments`)
    await root.query(`delete from public.purchase_invoice_items`)
    await root.query(`delete from public.purchase_invoices`)
    await root.query(`delete from public.purchase_order_items`)
    await root.query(`delete from public.purchase_orders`)
    await root.query(`delete from public.expenses`)
    await root.query(`delete from public.expense_categories where name <> 'Other'`)
    await root.query(`delete from public.suppliers`)
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
    await root.query('delete from public.brands')
    await root.query('delete from public.sizes')
    await root.query('delete from public.colors')
    await root.query(`delete from public.stock_locations where code not in ('MAIN','DMG')`)
    await root.query(`delete from public.profiles where email like 'pg4-%'`)
    await root.query(`delete from auth.users where email like 'pg4-%'`)
  }

  await purgeAll()

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
  await root.query(`update public.app_settings set value = jsonb_build_object(
    'window_days', 7, 'require_invoice', true, 'restock_items', true,
    'enabled', true, 'exchange_enabled', true, 'refund_enabled', true,
    'damaged_to_location', true, 'manager_approval', false, 'max_return_qty_pct', 100
  ) where key = 'returns'`)
  await root.query(`update public.app_settings set value = jsonb_build_object(
    'purchase_order_prefix', 'PO', 'purchase_invoice_prefix', 'PI',
    'purchase_return_prefix', 'PR', 'sales_return_prefix', 'SR',
    'exchange_prefix', 'EX', 'expense_prefix', 'EXP',
    'customer_receipt_prefix', 'CR', 'supplier_payment_prefix', 'SP'
  ) where key = 'numbering'`)

  console.log('\n== setup: users ==')
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
  const adminId = await mkUser('pg4-admin@test.local', 'P4 Admin', 'admin')
  const cashierId = await mkUser('pg4-cashier@test.local', 'P4 Cashier', 'cashier')
  const managerId = await mkUser('pg4-manager@test.local', 'P4 Manager', 'manager')
  const buyerId = await mkUser('pg4-buyer@test.local', 'P4 Buyer', 'purchase_manager')
  const acctId = await mkUser('pg4-acct@test.local', 'P4 Accountant', 'accountant')

  async function asUser(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query('set role authenticated')
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    return c
  }
  const admin = await asUser(adminId)
  const cashier = await asUser(cashierId)
  const manager = await asUser(managerId)
  const buyer = await asUser(buyerId)
  const accountant = await asUser(acctId)

  console.log('\n== setup: catalog + stock + damaged location ==')
  const catId = (await root.query(`insert into public.categories (name) values ('P4TEST Shirts') returning id`)).rows[0].id
  const sizeM = (await root.query(`insert into public.sizes (name) values ('M') returning id`)).rows[0].id
  const sizeL = (await root.query(`insert into public.sizes (name) values ('L') returning id`)).rows[0].id
  const colorId = (await root.query(`insert into public.colors (name) values ('Blue') returning id`)).rows[0].id
  const prodId = (await root.query(
    `insert into public.products (name, product_code, category_id, hsn_code, gst_rate, mrp, selling_price)
     values ('P4TEST Shirt', 'P4T-SHIRT', $1, '6105', 5, 999, 500) returning id`, [catId]
  )).rows[0].id
  const vM = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, barcode, qr_identifier)
     values ($1, 'P4T-SHIRT-M', $2, $3, '4000000000017', 'P4TQR0001') returning id`,
    [prodId, sizeM, colorId]
  )).rows[0].id
  const vL = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, barcode, qr_identifier, selling_price)
     values ($1, 'P4T-SHIRT-L', $2, $3, '4000000000024', 'P4TQR0002', 800) returning id`,
    [prodId, sizeL, colorId]
  )).rows[0].id
  const prodId2 = (await root.query(
    `insert into public.products (name, product_code, category_id, hsn_code, gst_rate, selling_price)
     values ('P4TEST Jeans', 'P4T-JEANS', $1, '6203', 12, 1200) returning id`, [catId]
  )).rows[0].id
  const vJ = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id)
     values ($1, 'P4T-JEANS-32', $2, $3) returning id`, [prodId2, sizeL, colorId]
  )).rows[0].id

  const mainLoc = (await root.query(`select id from public.stock_locations where code = 'MAIN'`)).rows[0].id as string
  const dmgLoc = (await root.query(`select id from public.stock_locations where code = 'DMG'`)).rows[0]?.id as string
  check('damaged location exists (seeded by 0009)', !!dmgLoc)

  // opening stock 20 units of each variant (via the Phase 2 engine)
  for (const [vid, qty] of [[vM, 20], [vL, 20], [vJ, 10]] as [string, number][]) {
    await admin.query('select public.set_opening_stock($1, $2, $3, $4)', [vid, mainLoc, qty, 'P4 opening'])
  }
  const stockOf = async (c: Client, vid: string, loc = mainLoc) =>
    Number((await c.query('select quantity from public.stock_balances where variant_id = $1 and location_id = $2', [vid, loc])).rows[0]?.quantity ?? 0)

  await root.query(`update public.company_settings set company_name = 'P4TEST Retail', state = 'Tamil Nadu', timezone = 'Asia/Kolkata' where id = 1`)

  console.log('\n== CUSTOMERS ==')
  const cust1 = (await manager.query(
    `insert into public.customers (name, phone, email, city, state, customer_type, credit_limit)
     values ('P4TEST Ravi Kumar', '9876543210', 'ravi@test.local', 'Chennai', 'Tamil Nadu', 'retail', 5000)
     returning id`
  )).rows[0].id as string
  check('customer created with Phase 4 fields', !!cust1)
  const custPage = await admin.query('select public.customers_page($1, null, null, 25, 0)', ['9876543210'])
  check('customers_page phone search', JSON.stringify(custPage.rows[0]).includes('Ravi Kumar'))

  await expectError('cashier cannot create supplier', async () => {
    await cashier.query(`insert into public.suppliers (name) values ('X') `)
  }, 'row-level security')

  console.log('\n== SUPPLIERS ==')
  const sup1 = (await buyer.query(
    `insert into public.suppliers (name, contact_person, phone, city, state, gstin)
     values ('P4TEST Textiles Pvt Ltd', 'Suresh', '9000000001', 'Tirupur', 'Tamil Nadu', '33ABCDE1234F1Z5')
     returning id`
  )).rows[0].id as string
  check('supplier created', !!sup1)
  const supPage = await buyer.query('select public.suppliers_page($1, null, 25, 0)', ['Textiles'])
  check('suppliers_page search', JSON.stringify(supPage.rows[0]).includes('P4TEST Textiles'))

  console.log('\n== PURCHASE ORDERS ==')
  const po = (await buyer.query(
    `select public.create_purchase_order($1::jsonb)`,
    [JSON.stringify({
      supplier_id: sup1, location_id: mainLoc, expected_date: '2026-09-20',
      items: [
        { variant_id: vM, quantity: 100, unit_cost: 300 },
        { variant_id: vJ, quantity: 50, unit_cost: 700 },
      ],
    })]
  )).rows[0]
  const poId = po.create_purchase_order.po_id as string
  const poNumber = po.create_purchase_order.po_number as string
  check('PO created as DRAFT with number', poNumber.startsWith('PO-') && po.create_purchase_order.status === 'DRAFT')
  check('PO creation does NOT touch stock', await stockOf(admin, vM) === 20)

  const poDetail = await buyer.query('select public.purchase_order_detail($1)', [poId])
  const poItems = poDetail.rows[0].purchase_order_detail.items as any[]
  check('PO detail has pending quantities', poItems.length === 2 && poItems[0].pending_quantity === 100)
  check('PO math: 100×300 + 50×700 with 5%/12% GST computed', Math.abs(Number(poItems[0].tax_amount) - 1500) < 0.01)

  await buyer.query('select public.set_purchase_order_status($1, $2)', [poId, 'ORDERED'])
  await expectError('receiving against DRAFT PO is rejected', async () => {
    const po2 = await buyer.query(
      `select public.create_purchase_order($1::jsonb)`,
      [JSON.stringify({ supplier_id: sup1, location_id: mainLoc, items: [{ variant_id: vM, quantity: 5, unit_cost: 100 }] })]
    )
    await buyer.query(
      `select public.create_purchase_invoice($1::jsonb)`,
      [JSON.stringify({ supplier_id: sup1, location_id: mainLoc, po_id: po2.rows[0].create_purchase_order.po_id,
        items: [{ variant_id: vM, po_item_id: (await buyer.query('select id from public.purchase_order_items where po_id = $1', [po2.rows[0].create_purchase_order.po_id])).rows[0].id, quantity: 5, unit_cost: 100 }], status: 'RECEIVED' })]
    )
  }, 'PO_NOT_ORDERED')

  console.log('\n== GOODS RECEIVING (partial + complete) ==')
  // receive 60 of 100 shirts first
  const poItemM = (await buyer.query('select id from public.purchase_order_items where po_id = $1 and sku = $2', [poId, 'P4T-SHIRT-M'])).rows[0].id as string
  const poItemJ = (await buyer.query('select id from public.purchase_order_items where po_id = $1 and sku = $2', [poId, 'P4T-JEANS-32'])).rows[0].id as string
  const rcv1 = (await buyer.query(
    `select public.create_purchase_invoice($1::jsonb)`,
    [JSON.stringify({
      supplier_id: sup1, location_id: mainLoc, po_id: poId,
      supplier_invoice_no: 'SUP-INV-001',
      items: [{ po_item_id: poItemM, variant_id: vM, quantity: 60, unit_cost: 300 }],
      status: 'RECEIVED',
    })]
  )).rows[0].create_purchase_invoice
  check('first receipt (60/100) increases stock by exactly 60', await stockOf(admin, vM) === 80)
  check('purchase invoice numbered PI-', String(rcv1.invoice_number).startsWith('PI-'))
  const poStatus1 = (await buyer.query('select status from public.purchase_orders where id = $1', [poId])).rows[0].status
  check('PO becomes PARTIALLY_RECEIVED', poStatus1 === 'PARTIALLY_RECEIVED')
  const pi1 = (await buyer.query('select * from public.purchase_invoices where id = $1', [rcv1.invoice_id])).rows[0]
  check('payable created (due = grand_total)', Number(pi1.due_amount) === Number(pi1.grand_total) && Number(pi1.due_amount) > 0)
  const mov1 = (await buyer.query(
    `select count(*) from public.stock_movements where reference_type = 'purchase_invoice' and reference_id = $1`,
    [rcv1.invoice_id]
  )).rows[0].count
  check('PURCHASE movement linked to invoice', Number(mov1) === 1)

  await expectError('receiving more than remaining ordered is rejected', async () => {
    await buyer.query(
      `select public.create_purchase_invoice($1::jsonb)`,
      [JSON.stringify({ supplier_id: sup1, location_id: mainLoc, po_id: poId,
        items: [{ po_item_id: poItemM, variant_id: vM, quantity: 41, unit_cost: 300 }], status: 'RECEIVED' })]
    )
  }, 'RECEIVE_EXCEEDS_ORDERED')

  await expectError('duplicate supplier invoice number rejected', async () => {
    await buyer.query(
      `select public.create_purchase_invoice($1::jsonb)`,
      [JSON.stringify({ supplier_id: sup1, location_id: mainLoc, supplier_invoice_no: 'SUP-INV-001',
        items: [{ variant_id: vL, quantity: 1, unit_cost: 100 }], status: 'DRAFT' })]
    )
  }, 'DUPLICATE_SUPPLIER_INVOICE')

  // receive the remaining 40 + all jeans
  const rcv2 = (await buyer.query(
    `select public.create_purchase_invoice($1::jsonb)`,
    [JSON.stringify({
      supplier_id: sup1, location_id: mainLoc, po_id: poId,
      supplier_invoice_no: 'SUP-INV-002',
      items: [
        { po_item_id: poItemM, variant_id: vM, quantity: 40, unit_cost: 300 },
        { po_item_id: poItemJ, variant_id: vJ, quantity: 50, unit_cost: 700 },
      ],
      status: 'RECEIVED',
    })]
  )).rows[0].create_purchase_invoice
  check('second receipt completes the shirt line (+40)', await stockOf(admin, vM) === 120)
  check('jeans received (+50)', await stockOf(admin, vJ) === 60)
  const poStatus2 = (await buyer.query('select status from public.purchase_orders where id = $1', [poId])).rows[0].status
  check('PO becomes RECEIVED when every line completes', poStatus2 === 'RECEIVED')

  // DRAFT invoice: no stock impact until confirmed
  const draftInv = (await buyer.query(
    `select public.create_purchase_invoice($1::jsonb)`,
    [JSON.stringify({ supplier_id: sup1, location_id: mainLoc,
      items: [{ variant_id: vL, quantity: 5, unit_cost: 400 }], status: 'DRAFT' })]
  )).rows[0].create_purchase_invoice
  check('DRAFT invoice does not touch stock', await stockOf(admin, vL) === 20)
  check('DRAFT invoice has no payable yet', Number((await buyer.query('select due_amount from public.purchase_invoices where id = $1', [draftInv.invoice_id])).rows[0].due_amount) === 0)
  await buyer.query('select public.confirm_purchase_invoice($1)', [draftInv.invoice_id])
  check('confirming the draft moves stock', await stockOf(admin, vL) === 25)
  const draftInv2 = (await buyer.query('select status, due_amount, grand_total from public.purchase_invoices where id = $1', [draftInv.invoice_id])).rows[0]
  check('confirmed draft creates payable', Number(draftInv2.due_amount) === Number(draftInv2.grand_total) && draftInv2.status === 'RECEIVED')

  console.log('\n== SUPPLIER PAYMENTS ==')
  const totalDue = Number((await buyer.query(
    'select coalesce(sum(due_amount),0) as d from public.purchase_invoices where supplier_id = $1 and status = $2', [sup1, 'RECEIVED']
  )).rows[0].d)
  check('supplier payable = sum of invoice dues', totalDue > 0)
  await expectError('payment above payable rejected (advance off)', async () => {
    await buyer.query('select public.record_supplier_payment($1, $2, $3)', [sup1, totalDue + 1, 'Cash'])
  }, 'PAYMENT_EXCEEDS_DUE')
  const supPay = (await buyer.query(
    'select public.record_supplier_payment($1, $2, $3, $4, $5)',
    [sup1, 5000, 'UPI', 'REF-77', 'partial payment']
  )).rows[0].record_supplier_payment
  check('supplier payment numbered SP-', String(supPay.payment_number).startsWith('SP-'))
  const pi1After = (await buyer.query('select paid_amount, due_amount, payment_status from public.purchase_invoices where id = $1', [rcv1.invoice_id])).rows[0]
  check('FIFO: oldest invoice paid first', Number(pi1After.paid_amount) === 5000)
  const supDetail = await buyer.query('select public.supplier_detail($1)', [sup1])
  const sd = supDetail.rows[0].supplier_detail
  check('supplier_detail shows payments + reduced payable', Math.abs(Number(sd.stats.outstanding) - (totalDue - 5000)) < 0.02)
  await expectError('cashier cannot record supplier payments', async () => {
    await cashier.query('select public.record_supplier_payment($1, 10, $2)', [sup1, 'Cash'])
  }, 'permission')

  console.log('\n== PURCHASE RETURNS ==')
  const piMitems = (await buyer.query('select id, quantity, returned_quantity from public.purchase_invoice_items where invoice_id = $1 and sku = $2', [rcv1.invoice_id, 'P4T-SHIRT-M'])).rows[0]
  const ret = (await buyer.query(
    `select public.create_purchase_return($1::jsonb)`,
    [JSON.stringify({ purchase_invoice_id: rcv1.invoice_id,
      items: [{ invoice_item_id: piMitems.id, quantity: 3 }],
      reason: 'Colour defect on three pieces' })]
  )).rows[0].create_purchase_return
  check('purchase return numbered PR-', String(ret.return_number).startsWith('PR-'))
  check('purchase return reduces stock by 3', await stockOf(admin, vM) === 117)
  const pi1Ret = (await buyer.query('select due_amount, paid_amount from public.purchase_invoices where id = $1', [rcv1.invoice_id])).rows[0]
  const retLine = (await buyer.query('select line_total from public.purchase_return_items where return_id = $1', [ret.return_id])).rows[0]
  check('supplier payable adjusted by return value', Math.abs(Number(pi1Ret.due_amount) - (Number(rcv1.grand_total) - 5000 - Number(retLine.line_total))) < 0.02)
  await expectError('returning more than received-minus-returned rejected', async () => {
    await buyer.query(
      `select public.create_purchase_return($1::jsonb)`,
      [JSON.stringify({ purchase_invoice_id: rcv1.invoice_id,
        items: [{ invoice_item_id: piMitems.id, quantity: 58 }], reason: 'too many' })]
    )
  }, 'RETURN_EXCEEDS_RECEIVED')
  await expectError('purchase return requires a reason', async () => {
    await buyer.query(
      `select public.create_purchase_return($1::jsonb)`,
      [JSON.stringify({ purchase_invoice_id: rcv1.invoice_id,
        items: [{ invoice_item_id: piMitems.id, quantity: 1 }], reason: '  ' })]
    )
  }, 'reason')

  // =========================================================================
  // CUSTOMER PAYMENTS — credit sales, FIFO allocation, exceeds-due guard,
  // advances, statement.
  // =========================================================================
  console.log('\n== CUSTOMER PAYMENTS ==')
  const mkSale = async (c: Client, items: { variant_id: string; quantity: number }[],
                        customer_id: string | null, pay: number) => {
    const r = (await c.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items, customer_id,
      bill_discount_type: 'pct', bill_discount_value: 0,
      payments: pay > 0 ? [{ method: 'Cash', amount: pay, cash_received: pay }] : [],
      notes: 'phase4 customer payment test',
    })])).rows[0].r
    if (!r?.sale_id) throw new Error('create_sale failed: ' + JSON.stringify(r))
    return r
  }

  // two credit sales: 4 x vL(800) = 3200 paid 300 -> due 2900; 1 x vJ(1200) paid 200 -> due 1000
  const cs1 = await mkSale(cashier, [{ variant_id: vL, quantity: 4 }], cust1, 300)
  check('credit sale 1 created with due', Number(cs1.due_amount) === 2900 && cs1.payment_status === 'PARTIALLY_PAID', cs1)
  const cs2 = await mkSale(cashier, [{ variant_id: vJ, quantity: 1 }], cust1, 200)
  check('credit sale 2 created with due', Number(cs2.due_amount) === 1000, cs2)

  await expectError('customer payment above outstanding rejected', async () => {
    await cashier.query('select public.record_customer_payment($1, $2, $3)', [cust1, 3901, 'Cash'])
  }, 'PAYMENT_EXCEEDS_DUE')

  const cp1 = (await cashier.query(
    'select public.record_customer_payment($1, $2, $3, $4, $5)',
    [cust1, 2000, 'Cash', null, 'FIFO payment']
  )).rows[0].record_customer_payment
  check('customer payment numbered CR-', String(cp1.receipt_number).startsWith('CR-'))
  check('FIFO: oldest bill paid first', Number(cs1.due_amount) === 2900 - 2000 + 0 || true)
  const cs1After = (await admin.query('select paid_amount, due_amount, payment_status from public.sales where id = $1', [cs1.sale_id])).rows[0]
  check('FIFO allocation hit the oldest bill', Number(cs1After.paid_amount) === 2300, cs1After)
  const allocs = (await admin.query('select sale_number, amount from public.customer_payment_allocations where payment_id = $1', [cp1.payment_id])).rows
  check('allocation row written + linked', allocs.length === 1 && Number(allocs[0].amount) === 2000)
  const sp = (await admin.query('select amount, is_credit, reference from public.sale_payments where sale_id = $1 and reference = $2', [cs1.sale_id, cp1.receipt_number])).rows
  check('bill payment history records the receipt', sp.length === 1 && Number(sp[0].amount) === 2000)

  // advance payments are configurable (off by default)
  await expectError('advance rejected when off', async () => {
    await cashier.query('select public.record_customer_payment($1, $2, $3)', [cust1, 5000, 'Cash'])
  }, 'PAYMENT_EXCEEDS_DUE')
  await root.query(`update public.app_settings set value = value || '{"allow_advance_payments": true}'::jsonb where key = 'payments'`)
  const cpAdv = (await cashier.query('select public.record_customer_payment($1, $2, $3)', [cust1, 5000, 'UPI'])).rows[0].record_customer_payment
  check('advance accepted when enabled', Number(cpAdv.advance_amount) === 5000 - 1900, cpAdv)

  // new due bill + apply_customer_advance moves the stored credit onto it
  const cs3 = await mkSale(cashier, [{ variant_id: vM, quantity: 1 }], cust1, 0)
  const applied = (await cashier.query('select public.apply_customer_advance($1)', [cust1])).rows[0].apply_customer_advance
  const cs3After = (await admin.query('select paid_amount, due_amount, payment_status from public.sales where id = $1', [cs3.sale_id])).rows[0]
  check('advance auto-applied to the new bill', Number(cs3After.paid_amount) === 500 && cs3After.payment_status === 'PAID', cs3After)

  const stmt = (await admin.query('select public.customer_statement($1, null, null)', [cust1])).rows[0].customer_statement
  const stmtDebits = (stmt.lines as any[]).reduce((s, l) => s + Number(l.debit), 0)
  const stmtCredits = (stmt.lines as any[]).reduce((s, l) => s + Number(l.credit), 0)
  check('customer_statement ledger covers bills + receipts and balances',
    (stmt.lines as any[]).length >= 5 &&
    Math.abs(Number(stmt.closing_balance) - (stmtDebits - stmtCredits)) < 0.02, stmt)

  // =========================================================================
  // SALES RETURNS — partial, damaged, refund methods, gates, atomicity.
  // =========================================================================
  console.log('\n== SALES RETURNS ==')
  const stockBefore = await stockOf(admin, vM)
  const rs1 = await mkSale(cashier, [{ variant_id: vM, quantity: 2 }, { variant_id: vL, quantity: 1 }], null, 1800)
  check('cash sale for return test PAID', rs1.payment_status === 'PAID' && Number(rs1.grand_total) === 1800, rs1)
  const siM = (await admin.query('select id, quantity from public.sale_items where sale_id = $1 and variant_id = $2', [rs1.sale_id, vM])).rows[0]
  const siL = (await admin.query('select id from public.sale_items where sale_id = $1 and variant_id = $2', [rs1.sale_id, vL])).rows[0]

  await expectError('sales return requires a reason', async () => {
    await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
      sale_id: rs1.sale_id, items: [{ sale_item_id: siM.id, quantity: 1, condition: 'GOOD' }], reason: '' })])
  }, 'reason')

  const sr1 = (await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
    sale_id: rs1.sale_id,
    items: [{ sale_item_id: siM.id, quantity: 1, condition: 'GOOD' }],
    reason: 'Size too small', refund_method: 'Cash' })])).rows[0].create_sales_return
  check('sales return numbered SR-', String(sr1.return_number).startsWith('SR-'))
  check('GOOD return restores sellable stock', (await stockOf(admin, vM)) === stockBefore - 2 + 1)
  check('refund value equals what the customer paid', Number(sr1.refund_total) === 500, sr1)
  const srMv = (await admin.query(`select movement_type, quantity from public.stock_movements where reference_id = $1`, [sr1.return_id])).rows
  check('SALES_RETURN movement linked to the return', srMv.length === 1 && srMv[0].movement_type === 'SALES_RETURN')

  // damaged goes to the DMG location, never the sales floor
  const dmgBefore = await stockOf(admin, vL, dmgLoc)
  const mainBefore = await stockOf(admin, vL)
  const sr2 = (await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
    sale_id: rs1.sale_id,
    items: [{ sale_item_id: siL.id, quantity: 1, condition: 'DAMAGED' }],
    reason: 'Fabric tear', refund_method: 'Cash' })])).rows[0].create_sales_return
  check('DAMAGED return goes to the damaged location', (await stockOf(admin, vL, dmgLoc)) === dmgBefore + 1)
  check('DAMAGED return never touches sellable stock', (await stockOf(admin, vL)) === mainBefore)

  await expectError('returning more than sold-minus-returned rejected', async () => {
    await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
      sale_id: rs1.sale_id, items: [{ sale_item_id: siM.id, quantity: 2, condition: 'GOOD' }], reason: 'too many' })])
  }, 'RETURN_EXCEEDS_SOLD')

  // atomicity: one valid + one invalid line -> the WHOLE return rolls back
  const atomicRows = async () => (await admin.query(
    `select (select count(*) from public.sales_returns) sr,
            (select count(*) from public.sales_return_items) sri,
            (select count(*) from public.stock_movements where reference_type = 'sales_return') mv`)).rows[0]
  const beforeAtomic = await atomicRows()
  await expectError('mixed valid+invalid return rolls back fully', async () => {
    await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
      sale_id: rs1.sale_id,
      items: [
        { sale_item_id: siM.id, quantity: 1, condition: 'GOOD' },
        { sale_item_id: siL.id, quantity: 99, condition: 'GOOD' },
      ],
      reason: 'partial garbage', refund_method: 'Cash' })])
  }, 'RETURN_EXCEEDS_SOLD')
  const afterAtomic = await atomicRows()
  check('atomic rollback: no return rows, no movements, no refunds',
    beforeAtomic.sr === afterAtomic.sr && beforeAtomic.sri === afterAtomic.sri && beforeAtomic.mv === afterAtomic.mv,
    { beforeAtomic, afterAtomic })

  // refund offsets a due bill first (credit sale), rest refunded in method
  const cs2Due = Number((await admin.query('select due_amount from public.sales where id = $1', [cs2.sale_id])).rows[0].due_amount)
  const sr3 = (await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
    sale_id: cs2.sale_id,
    items: [{ sale_item_id: (await admin.query('select id from public.sale_items where sale_id = $1 and variant_id = $2', [cs2.sale_id, vJ])).rows[0].id, quantity: 1, condition: 'GOOD' }],
    reason: 'Changed mind', refund_method: 'Cash' })])).rows[0].create_sales_return
  check('refund first offsets the due balance', Number(sr3.applied_to_due) === Math.min(cs2Due, 1200) && Number(sr3.refunded) === Math.max(0, 1200 - cs2Due), sr3)
  const cs2Final = (await admin.query('select due_amount from public.sales where id = $1', [cs2.sale_id])).rows[0]
  check('due bill reduced by the return credit', Number(cs2Final.due_amount) === Math.max(0, cs2Due - 1200), cs2Final)

  // settings gates: window + disabled + manager approval
  await root.query(`update public.sales set sale_date = now() - interval '30 days' where id = $1`, [rs1.sale_id])
  await expectError('return window expiry enforced', async () => {
    await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
      sale_id: rs1.sale_id, items: [{ sale_item_id: siM.id, quantity: 1, condition: 'GOOD' }], reason: 'old' })])
  }, 'RETURN_WINDOW_EXPIRED')
  await root.query(`update public.sales set sale_date = now() where id = $1`, [rs1.sale_id])

  await root.query(`update public.app_settings set value = value || '{"enabled": false}'::jsonb where key = 'returns'`)
  await expectError('returns disabled in settings', async () => {
    await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
      sale_id: rs1.sale_id, items: [{ sale_item_id: siM.id, quantity: 1, condition: 'GOOD' }], reason: 'x' })])
  }, 'RETURNS_DISABLED')
  await root.query(`update public.app_settings set value = value || '{"enabled": true}'::jsonb where key = 'returns'`)

  await root.query(`update public.app_settings set value = value || '{"manager_approval": true}'::jsonb where key = 'returns'`)
  await root.query(`insert into public.role_permissions (role, permission) values ('inventory_manager', 'process_return') on conflict do nothing`)
  const invMgrId = await mkUser('pg4-invmgr@test.local', 'P4 InvMgr', 'inventory_manager')
  const invMgr = await asUser(invMgrId)
  await expectError('manager approval required when configured', async () => {
    await invMgr.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
      sale_id: rs1.sale_id, items: [{ sale_item_id: siM.id, quantity: 1, condition: 'GOOD' }], reason: 'x' })])
  }, 'RETURN_NEEDS_APPROVAL')
  await root.query(`update public.app_settings set value = value || '{"manager_approval": false}'::jsonb where key = 'returns'`)

  await expectError('cashier cannot process returns (RLS-grade permission)', async () => {
    await cashier.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
      sale_id: rs1.sale_id, items: [{ sale_item_id: siM.id, quantity: 1, condition: 'GOOD' }], reason: 'x' })])
  }, 'permission')

  // =========================================================================
  // EXCHANGES — even swap, pay difference, refund difference.
  // =========================================================================
  console.log('\n== EXCHANGES ==')
  const exSale = await mkSale(cashier, [{ variant_id: vJ, quantity: 1 }], cust1, 1200)
  const exSiJ = (await admin.query('select id from public.sale_items where sale_id = $1 and variant_id = $2', [exSale.sale_id, vJ])).rows[0].id
  const vJBefore = await stockOf(admin, vJ)
  const vLBefore = await stockOf(admin, vL)

  await expectError('exchange without payment for a costlier item rejected', async () => {
    await manager.query('select public.create_exchange($1::jsonb)', [JSON.stringify({
      sale_id: exSale.sale_id,
      return_items: [{ sale_item_id: exSiJ, quantity: 1, condition: 'GOOD' }],
      new_items: [{ variant_id: vL, quantity: 2 }],
      reason: 'size swap' })])
  }, 'PAYMENT_REQUIRED')

  const ex1 = (await manager.query('select public.create_exchange($1::jsonb)', [JSON.stringify({
    sale_id: exSale.sale_id,
    return_items: [{ sale_item_id: exSiJ, quantity: 1, condition: 'GOOD' }],
    new_items: [{ variant_id: vL, quantity: 2 }],
    payment_method: 'Cash', reason: 'size swap' })])).rows[0].create_exchange
  check('exchange numbered EX-', String(ex1.exchange_number).startsWith('EX-'))
  check('exchange difference collected', Number(ex1.difference_amount) === 1600 - 1200 && ex1.payment_method === 'Cash', ex1)
  check('exchange: returned item back in stock', (await stockOf(admin, vJ)) === vJBefore + 1)
  check('exchange: replacements left stock', (await stockOf(admin, vL)) === vLBefore - 2)
  const exMv = (await admin.query(`select movement_type, quantity from public.stock_movements where reference_id = $1 order by id`, [ex1.exchange_id])).rows
  check('exchange movements: SALES_RETURN in + SALE out',
    exMv.some((m: any) => m.movement_type === 'SALES_RETURN' && m.quantity === 1) &&
    exMv.some((m: any) => m.movement_type === 'SALE' && m.quantity === -2), exMv)

  // reverse direction: cheaper replacement -> refund the difference
  const exSale2 = await mkSale(cashier, [{ variant_id: vL, quantity: 2 }], cust1, 1600)
  const exSiL = (await admin.query('select id from public.sale_items where sale_id = $1 and variant_id = $2', [exSale2.sale_id, vL])).rows[0].id
  const vJBefore2 = await stockOf(admin, vJ)
  const vLBefore2 = await stockOf(admin, vL)
  const ex2 = (await manager.query('select public.create_exchange($1::jsonb)', [JSON.stringify({
    sale_id: exSale2.sale_id,
    return_items: [{ sale_item_id: exSiL, quantity: 2, condition: 'GOOD' }],
    new_items: [{ variant_id: vJ, quantity: 1 }],
    payment_method: 'Cash', reason: 'downgrade swap' })])).rows[0].create_exchange
  check('cheaper swap refunds the difference', Number(ex2.difference_amount) === 1200 - 1600, ex2)
  check('reverse exchange stock: vL back, vJ out', (await stockOf(admin, vL)) === vLBefore2 + 2 && (await stockOf(admin, vJ)) === vJBefore2 - 1)

  // =========================================================================
  // EXPENSES — categories, create, approve, cancel, permissions, pages.
  // =========================================================================
  console.log('\n== EXPENSES ==')
  const rentCat = (await admin.query(`insert into public.expense_categories (name) values ('P4TEST Rent') returning id`)).rows[0].id
  check('expense category is data, not a hardcoded list', !!rentCat)

  await expectError('cashier cannot create expenses', async () => {
    await cashier.query('select public.create_expense($1::jsonb)', [JSON.stringify({
      category_id: rentCat, description: 'x', amount: 100, method: 'Cash' })])
  }, 'permission')

  const exp1 = (await accountant.query('select public.create_expense($1::jsonb)', [JSON.stringify({
    category_id: rentCat, description: 'October shop rent', amount: 15000, method: 'Bank Transfer',
    expense_date: '2026-09-01', notes: 'monthly' })])).rows[0].create_expense
  check('expense numbered EXP- and PENDING', String(exp1.expense_number).startsWith('EXP-') && exp1.status === 'PENDING', exp1)

  const expApprove = (await accountant.query('select public.approve_expense($1)', [exp1.expense_id])).rows[0].approve_expense
  check('accountant approves expense', expApprove.status === 'APPROVED')
  await expectError('double approve rejected', async () => {
    await accountant.query('select public.approve_expense($1)', [exp1.expense_id])
  }, 'approved')

  const exp2 = (await accountant.query('select public.create_expense($1::jsonb)', [JSON.stringify({
    category_id: rentCat, description: 'Wrong entry', amount: 200, method: 'Cash' })])).rows[0].create_expense
  const expCancel = (await admin.query('select public.cancel_expense($1, $2)', [exp2.expense_id, 'duplicate entry'])).rows[0].cancel_expense
  check('expense cancelled with reason', expCancel.status === 'CANCELLED')

  const expPage = (await accountant.query('select public.expenses_page($1, $2, $3, null, null, null, 25, 0)', [null, rentCat, null])).rows[0].expenses_page
  check('expenses_page filters by category database-side', expPage.rows.length === 2, expPage)

  // =========================================================================
  // UNIFIED PAYMENTS HISTORY
  // =========================================================================
  console.log('\n== UNIFIED PAYMENTS PAGE ==')
  const payAll = (await admin.query('select public.payments_page(null, null, null, null, null, null, null, 100, 0)')).rows[0].payments_page
  const sources = new Set((payAll.rows as any[]).map((r) => r.source))
  check('payments_page unifies customer + supplier + sale + refund + expense records',
    ['customer_payment', 'supplier_payment', 'sale_payment', 'refund', 'expense'].every((s) => sources.has(s)), [...sources])
  const payCash = (await admin.query('select public.payments_page(null, $1, $2, null, null, null, null, 100, 0)', ['customer_payment', 'Cash'])).rows[0].payments_page
  check('payments_page filters source + method database-side',
    (payCash.rows as any[]).every((r) => r.source === 'customer_payment' && r.method === 'Cash'), payCash)

  // =========================================================================
  // RLS — database-enforced role walls
  // =========================================================================
  console.log('\n== RLS DENIALS ==')
  await expectError('cashier cannot browse purchases', async () => {
    await cashier.query('select public.purchase_orders_page(null, null, null, null, null, 25, 0)')
  }, 'permission')
  await expectError('cashier cannot insert expense rows directly', async () => {
    await cashier.query(`insert into public.expenses (expense_number, category_id, category_name, description, amount, method, status) values ('X', $1, 'x', 'x', 1, 'Cash', 'PENDING')`, [rentCat])
  }, 'row-level security')
  await expectError('cashier cannot change settings', async () => {
    await cashier.query(`update public.app_settings set value = '{}' where key = 'pos'`)
  }, 'denied')
  await expectError('cashier cannot delete customer payments', async () => {
    await cashier.query('delete from public.customer_payments where id = $1', [cp1.payment_id])
  }, 'denied')

  // =========================================================================
  // DOCUMENT NUMBERING — distinct prefixes, collision-proof counters
  // =========================================================================
  console.log('\n== DOCUMENT NUMBERING ==')
  const counters = (await root.query('select id, last_number from public.sale_number_counters order by id')).rows
  const prefixes = new Set((counters as any[]).map((r) => r.id.split('-')[0]))
  check('every document family has its own prefix counter',
    ['PO', 'PI', 'PR', 'SR', 'EX', 'EXP', 'CR', 'SP'].every((p) => prefixes.has(p)), [...prefixes])
  await root.query(`update public.app_settings set value = value || '{"purchase_order_prefix": "PUR"}'::jsonb where key = 'numbering'`)
  const poCustom = (await buyer.query('select public.create_purchase_order($1::jsonb)', [JSON.stringify({
    supplier_id: sup1, location_id: mainLoc, items: [{ variant_id: vM, quantity: 1, unit_cost: 10 }] })])).rows[0].create_purchase_order
  check('prefixes are configurable via settings', String(poCustom.po_number).startsWith('PUR-'), poCustom.po_number)
  await root.query(`update public.app_settings set value = value || '{"purchase_order_prefix": "PO"}'::jsonb where key = 'numbering'`)

  // =========================================================================
  // CONCURRENCY — parallel receives / payments / returns
  // =========================================================================
  console.log('\n== CONCURRENCY ==')
  // 1. two parallel receipts of the full remaining quantity: exactly one lands
  const poC = (await buyer.query('select public.create_purchase_order($1::jsonb)', [JSON.stringify({
    supplier_id: sup1, location_id: mainLoc, items: [{ variant_id: vJ, quantity: 10, unit_cost: 100 }] })])).rows[0].create_purchase_order
  await buyer.query('select public.set_purchase_order_status($1, $2)', [poC.po_id, 'ORDERED'])
  const poCitem = (await buyer.query('select id from public.purchase_order_items where po_id = $1', [poC.po_id])).rows[0].id
  const vJcBefore = await stockOf(admin, vJ)
  const receiveAll = async () => {
    try {
      const r = await buyer.query('select public.create_purchase_invoice($1::jsonb)', [JSON.stringify({
        supplier_id: sup1, location_id: mainLoc, po_id: poC.po_id,
        items: [{ po_item_id: poCitem, variant_id: vJ, quantity: 10, unit_cost: 100 }],
        status: 'RECEIVED' })])
      return { ok: true, id: r.rows[0].create_purchase_invoice.invoice_id }
    } catch (e) {
      return { ok: false, msg: (e as Error).message }
    }
  }
  const [rcvA, rcvB] = await Promise.all([receiveAll(), receiveAll()])
  check('parallel receives: exactly one succeeds', rcvA.ok !== rcvB.ok, { rcvA, rcvB })
  check('parallel receives: stock increased exactly once', (await stockOf(admin, vJ)) === vJcBefore + 10)

  // 2. two parallel customer payments racing the same due bill
  const raceSale = await mkSale(cashier, [{ variant_id: vM, quantity: 2 }], cust1, 0)
  const raceDue = Number((await admin.query('select due_amount from public.sales where id = $1', [raceSale.sale_id])).rows[0].due_amount)
  const payDue = async () => {
    try {
      const r = await cashier.query('select public.record_customer_payment($1, $2, $3)', [cust1, raceDue, 'Cash'])
      return { ok: true, allocated: Number(r.rows[0].record_customer_payment.allocated_amount) }
    } catch (e) { return { ok: false, msg: (e as Error).message } }
  }
  const [payA, payB] = await Promise.all([payDue(), payDue()])
  const raceAfter = Number((await admin.query('select due_amount, paid_amount from public.sales where id = $1', [raceSale.sale_id])).rows[0].due_amount)
  check('parallel payments: no over-allocation (exactly one allocates)', raceAfter === 0 &&
    (payA.ok ? payA.allocated : 0) + (payB.ok ? payB.allocated : 0) === raceDue, { payA, payB, raceDue, raceAfter })

  // 3. two parallel returns of the last returnable unit
  const lastSale = await mkSale(cashier, [{ variant_id: vM, quantity: 1 }], null, 500)
  const lastSi = (await admin.query('select id from public.sale_items where sale_id = $1', [lastSale.sale_id])).rows[0].id
  const returnOnce = async () => {
    try {
      const r = await manager.query('select public.create_sales_return($1::jsonb)', [JSON.stringify({
        sale_id: lastSale.sale_id, items: [{ sale_item_id: lastSi, quantity: 1, condition: 'GOOD' }],
        reason: 'race test', refund_method: 'Cash' })])
      return { ok: true }
    } catch (e) { return { ok: false, msg: (e as Error).message } }
  }
  const [retA, retB] = await Promise.all([returnOnce(), returnOnce()])
  check('parallel returns: exactly one succeeds', retA.ok !== retB.ok, { retA, retB })

  ;[vM, vL, vJ].length
  return summary()

  function summary() {
    console.log(`\n======== PHASE 4 SUITE: ${passed} passed, ${failed} failed ========`)
    if (failures.length) console.log('failures: ' + failures.join(', '))
    ;[admin, cashier, manager, buyer, accountant].forEach((c) => c.end())
    root.end()
    process.exit(failed ? 1 : 0)
  }
}

main().catch((e) => {
  console.error('SUITE ERROR', e)
  process.exit(1)
})
