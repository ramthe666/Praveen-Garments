/**
 * Phase 3 local engine test suite — runs against the local Supabase-compatible
 * harness (NOT the production Supabase project).
 *
 * Validates the POS / billing engine end-to-end at the database level:
 *   search (name/SKU/barcode/QR/nonexistent), scanner identifier resolve,
 *   atomic create_sale (rows + stock + ledger + audit + numbering), duplicate
 *   cart lines, insufficient stock + full rollback, price override permission
 *   + setting gates, item/bill discounts with per-employee limits, tax
 *   inclusive/exclusive + inter-state, round-off, payments (split, change,
 *   overpay, disabled method, credit rules), held bills (no stock impact,
 *   owner isolation, resume, discard), cancel_sale (restock, ledger, audit,
 *   permission), sales_page filters + pagination, sale_detail, RLS, and the
 *   two-cashiers-one-item concurrency guarantee.
 *
 * Run: bun run scripts/local/test-phase3.ts
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

  // ---- self-clean (local harness only; mirrors phase 2 suite) -------------
  async function purgeAll() {
    await root.query('alter table public.stock_movements disable trigger stock_movements_append_only')
    await root.query('alter table public.stock_balances disable trigger stock_balances_engine_guard')
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
    await root.query('delete from public.stock_locations where code <> \'MAIN\'')
    await root.query('delete from public.profiles where email like \'pg3-%\'')
    await root.query('delete from auth.users where email like \'pg3-%\'')
    // reset pos settings to migration defaults for deterministic tests
    await root.query(`update public.app_settings set value = jsonb_build_object(
      'require_customer', false, 'allow_price_edit', false, 'round_off', true,
      'default_payment_method', 'Cash', 'bill_footer_note', 'Thank you!',
      'allow_credit_sales', false, 'default_tax_mode', 'inclusive',
      'max_item_discount_pct', 10, 'max_bill_discount_pct', 10
    ) where key = 'pos'`)
    await root.query(`update public.app_settings set value = jsonb_build_object(
      'methods', '["Cash","UPI","Card","Bank Transfer"]'::jsonb
    ) where key = 'payments'`)
  }
  await purgeAll()

  console.log('\n== setup: users ==')
  async function mkUser(email: string, name: string, role: string, extra?: { limit?: number }) {
    const id = (await root.query(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify({ app_role: role, full_name: name })]
    )).rows[0].id as string
    await root.query(
      `insert into public.profiles (id, email, full_name, role, pos_discount_limit_pct)
       values ($1, $2, $3, $4::public.user_role, $5)
       on conflict (id) do update set role = $4::public.user_role, is_active = true, pos_discount_limit_pct = $5`,
      [id, email, name, role, extra?.limit ?? null]
    )
    return id
  }
  const adminId = await mkUser('pg3-admin@test.local', 'P3 Admin', 'admin')
  const cashierId = await mkUser('pg3-cashier@test.local', 'P3 Cashier', 'cashier')
  const cashier2Id = await mkUser('pg3-cashier2@test.local', 'P3 Cashier 2', 'cashier')
  const managerId = await mkUser('pg3-manager@test.local', 'P3 Manager', 'manager')
  const acctId = await mkUser('pg3-acct@test.local', 'P3 Accountant', 'accountant')

  async function asUser(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query('set role authenticated')
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    return c
  }
  const admin = await asUser(adminId)
  const cashier = await asUser(cashierId)
  const cashier2 = await asUser(cashier2Id)
  const manager = await asUser(managerId)
  const accountant = await asUser(acctId)

  console.log('\n== setup: catalog + stock ==')
  const catId = (await root.query(
    `insert into public.categories (name) values ('P3TEST Shirts') returning id`
  )).rows[0].id
  const brandId = (await root.query(
    `insert into public.brands (name) values ('P3TEST Brand') returning id`
  )).rows[0].id
  const sizeId = (await root.query(
    `insert into public.sizes (name) values ('M') returning id`
  )).rows[0].id
  const colorId = (await root.query(
    `insert into public.colors (name) values ('Blue') returning id`
  )).rows[0].id
  const prodId = (await root.query(
    `insert into public.products (name, product_code, category_id, brand_id, hsn_code, gst_rate, mrp, selling_price)
     values ('P3TEST Casual Shirt', 'P3T-SHIRT', $1, $2, '6105', 5, 999, 500) returning id`,
    [catId, brandId]
  )).rows[0].id
  const vA = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, barcode, qr_identifier)
     values ($1, 'P3T-SHIRT-M-BLU', $2, $3, '2000000000017', 'P3TQR0001') returning id`,
    [prodId, sizeId, colorId]
  )).rows[0].id
  const sizeLId = (await root.query(`insert into public.sizes (name) values ('L') returning id`)).rows[0].id
  const vB = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, barcode, qr_identifier, selling_price)
     values ($1, 'P3T-SHIRT-L-BLU', $2, $3, '2000000000024', 'P3TQR0002', 750) returning id`,
    [prodId, sizeLId, colorId]
  )).rows[0].id
  // second product: 12% GST for tax math variety
  const prod2Id = (await root.query(
    `insert into public.products (name, product_code, category_id, brand_id, hsn_code, gst_rate, mrp, selling_price)
     values ('P3TEST Denim Jeans', 'P3T-JEANS', $1, $2, '6203', 12, 2499, 1200) returning id`,
    [catId, brandId]
  )).rows[0].id
  const vC = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, barcode, qr_identifier)
     values ($1, 'P3T-JEANS-M-BLU', $2, $3, '2000000000031', 'P3TQR0003') returning id`,
    [prod2Id, sizeId, colorId]
  )).rows[0].id
  const vLast = (await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, barcode, qr_identifier)
     values ($1, 'P3T-JEANS-L-BLU', $2, $3, '2000000000048', 'P3TQR0004') returning id`,
    [prod2Id, sizeLId, colorId]
  )).rows[0].id

  const mainLoc = (await root.query(`select id from public.stock_locations where code = 'MAIN'`)).rows[0].id
  await root.query('select public.set_opening_stock($1, $2, 10)', [vA, mainLoc])
  await root.query('select public.set_opening_stock($1, $2, 3)', [vB, mainLoc])
  await root.query('select public.set_opening_stock($1, $2, 5)', [vC, mainLoc])
  await root.query('select public.set_opening_stock($1, $2, 1)', [vLast, mainLoc])

  const custId = (await root.query(
    `insert into public.customers (name, phone, state) values ('P3TEST Ravi Kumar', '9876543210', 'Karnataka') returning id`
  )).rows[0].id

  console.log('\n== search ==')
  {
    const r = await cashier.query('select public.pos_search($1, 10) as r', ['shirt'])
    const rows = (r.rows[0].r as any).rows
    check('search by name', rows.some((x: any) => x.sku === 'P3T-SHIRT-M-BLU'), rows?.length)
  }
  {
    const r = await cashier.query('select public.pos_search($1, 10) as r', ['P3T-SHIRT-M-BLU'])
    const rows = (r.rows[0].r as any).rows
    check('search by exact SKU', rows.some((x: any) => x.sku === 'P3T-SHIRT-M-BLU'), rows)
  }
  {
    const r = await cashier.query('select public.pos_search($1, 10) as r', ['2000000000017'])
    const rows = (r.rows[0].r as any).rows
    check('search by barcode', rows.some((x: any) => x.sku === 'P3T-SHIRT-M-BLU'), rows)
  }
  {
    const r = await cashier.query('select public.pos_search($1, 10) as r', ['P3TQR0003'])
    const rows = (r.rows[0].r as any).rows
    check('search by QR', rows.some((x: any) => x.sku === 'P3T-JEANS-M-BLU'), rows)
  }
  {
    const r = await cashier.query('select public.pos_search($1, 10) as r', ['doesnotexist999'])
    const rows = (r.rows[0].r as any).rows
    check('search nonexistent returns empty', rows.length === 0, rows)
  }
  {
    const r = await cashier.query('select public.pos_search($1, 10) as r', ['P3T'])
    const rows = (r.rows[0].r as any).rows
    check('search results carry price + stock', rows.every((x: any) => typeof x.selling_price === 'number' && typeof x.total_available === 'number') && rows.length >= 4, rows)
  }

  console.log('\n== scanner identifier resolve ==')
  {
    const r = await cashier.query('select public.find_variant_by_identifier($1) as r', ['2000000000017'])
    const v = r.rows[0].r as any
    check('resolve barcode', v?.sku === 'P3T-SHIRT-M-BLU' && v.stock?.length > 0, v)
  }
  {
    const r = await cashier.query('select public.find_variant_by_identifier($1) as r', ['P3TQR0002'])
    check('resolve QR', (r.rows[0].r as any)?.sku === 'P3T-SHIRT-L-BLU')
  }
  {
    const r = await cashier.query('select public.find_variant_by_identifier($1) as r', ['p3t-shirt-m-blu'])
    check('resolve SKU case-insensitive', (r.rows[0].r as any)?.sku === 'P3T-SHIRT-M-BLU')
  }
  {
    const r = await cashier.query('select public.find_variant_by_identifier($1) as r', ['9999999999999'])
    check('resolve unknown identifier returns null', r.rows[0].r === null)
  }

  console.log('\n== POS config ==')
  {
    const r = await cashier.query('select public.get_pos_config() as r')
    const cfg = r.rows[0].r as any
    check('config has methods', Array.isArray(cfg.payments?.methods) && cfg.payments.methods.includes('Cash'), cfg.payments)
    check('config has company', cfg.company?.company_name === 'Praveen Garments', cfg.company?.company_name)
    check('config has locations', cfg.locations?.length >= 1)
  }

  console.log('\n== create_sale: atomic happy path ==')
  let sale1: any
  {
    const payload = {
      items: [{ variant_id: vA, quantity: 2 }],
      customer_id: null,
      bill_discount_type: 'pct', bill_discount_value: 0,
      payments: [{ method: 'Cash', amount: 1000, cash_received: 1000 }],
      notes: 'engine test sale 1',
    }
    const r = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify(payload)])
    sale1 = r.rows[0].r as any
    check('sale created', !!sale1?.sale_id, sale1)
    check('invoice number format', /^INV-2026-\d{6}$/.test(sale1.sale_number), sale1.sale_number)
    check('totals: subtotal 1000 (incl tax)', Number(sale1.subtotal) === 1000, sale1.subtotal)
    check('totals: tax 47.62 (2 x 500 incl 5%)', Number(sale1.tax_total) === 47.62, sale1.tax_total)
    check('paid/due', Number(sale1.paid_amount) === 1000 && Number(sale1.due_amount) === 0, sale1)
    check('payment status PAID', sale1.payment_status === 'PAID', sale1.payment_status)

    const stock = (await root.query('select quantity from public.stock_balances where variant_id = $1 and location_id = $2', [vA, mainLoc])).rows[0]
    check('stock reduced 10 -> 8', stock.quantity === 8, stock)
    const mv = (await root.query(`select * from public.stock_movements where reference_id = $1 and movement_type = 'SALE'`, [sale1.sale_id])).rows
    check('SALE movement written', mv.length === 1 && mv[0].quantity === -2, mv)
    const items = (await root.query('select * from public.sale_items where sale_id = $1', [sale1.sale_id])).rows
    check('item snapshot: sku + price + tax', items[0].sku === 'P3T-SHIRT-M-BLU' && Number(items[0].unit_price) === 500 && Number(items[0].tax_amount) === 47.62 && Number(items[0].line_total) === 1000, items[0])
    const pmts = (await root.query('select * from public.sale_payments where sale_id = $1', [sale1.sale_id])).rows
    check('payment row recorded', pmts.length === 1 && pmts[0].method === 'Cash' && Number(pmts[0].amount) === 1000, pmts)
    const audit = (await root.query(`select * from public.audit_logs where action = 'sale_created' and entity_id = $1`, [sale1.sale_id])).rows
    check('audit sale_created', audit.length === 1 && audit[0].user_email === 'pg3-cashier@test.local', audit)
  }

  console.log('\n== create_sale: validation failures (each must roll back fully) ==')
  {
    const before = (await root.query('select count(*)::int as c from public.sales')).rows[0].c
    await expectError('empty cart rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({ items: [], payments: [{ method: 'Cash', amount: 10 }] })]), 'cart is empty')
    await expectError('duplicate variant line rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1 }, { variant_id: vA, quantity: 1 }],
      payments: [{ method: 'Cash', amount: 1000 }],
    })]), 'Duplicate cart line')
    await expectError('zero quantity rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 0 }], payments: [{ method: 'Cash', amount: 1 }],
    })]), 'Invalid quantity')
    await expectError('insufficient stock rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 4 }], payments: [{ method: 'Cash', amount: 3000 }],
    })]), 'INSUFFICIENT_STOCK')
    const after = (await root.query('select count(*)::int as c from public.sales')).rows[0].c
    check('atomic rollback: no orphan sale rows', before === after, { before, after })
    const stockB = (await root.query('select quantity from public.stock_balances where variant_id = $1', [vB])).rows[0]
    check('atomic rollback: stock untouched', stockB.quantity === 3, stockB)
    const pmtCount = (await root.query('select count(*)::int as c from public.sale_payments')).rows[0].c
    check('atomic rollback: no orphan payments', pmtCount === 1, pmtCount)
  }

  console.log('\n== price override permission + setting gates ==')
  {
    // setting OFF by default: even admin cannot override
    await expectError('override blocked while setting off (admin)', () => admin.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1, unit_price: 400 }],
      payments: [{ method: 'Cash', amount: 400 }],
    })]), 'PRICE_OVERRIDE_NOT_ALLOWED')
    // enable the setting
    await root.query(`update public.app_settings set value = jsonb_set(value, '{allow_price_edit}', 'true'::jsonb) where key = 'pos'`)
    await expectError('override blocked without permission (cashier)', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1, unit_price: 400 }],
      payments: [{ method: 'Cash', amount: 400 }],
    })]), 'PRICE_OVERRIDE_NOT_ALLOWED')
    // admin with permission + setting succeeds; audited
    const r = await admin.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1, unit_price: 400 }],
      payments: [{ method: 'Cash', amount: 400 }],
    })])
    const s = r.rows[0].r as any
    check('override succeeds for admin (setting + permission)', !!s?.sale_id, s)
    const item = (await root.query('select base_price, unit_price, price_overridden from public.sale_items where sale_id = $1', [s.sale_id])).rows[0]
    check('override snapshot keeps base price', Number(item.base_price) === 500 && Number(item.unit_price) === 400 && item.price_overridden === true, item)
    const audit = (await root.query(`select count(*)::int as c from public.audit_logs where action = 'price_override_applied' and entity_id = $1`, [s.sale_id])).rows[0].c
    check('price override audited', audit === 1, audit)
    // restore setting
    await root.query(`update public.app_settings set value = jsonb_set(value, '{allow_price_edit}', 'false'::jsonb) where key = 'pos'`)
  }

  console.log('\n== discounts: permission, limits, caps ==')
  {
    await expectError('cashier discount rejected (no permission)', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1, discount_type: 'pct', discount_value: 5 }],
      payments: [{ method: 'Cash', amount: 475 }],
    })]), 'DISCOUNT_NOT_ALLOWED')
    // grant cashier the apply_discount permission (admin action via matrix)
    await root.query(`insert into public.role_permissions (role, permission) values ('cashier','apply_discount') on conflict do nothing`)
    const r = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1, discount_type: 'pct', discount_value: 5 }],
      payments: [{ method: 'Cash', amount: 475 }],
    })])
    const s = r.rows[0].r as any
    check('cashier 5% item discount works (within cap)', !!s?.sale_id, s)
    const item = (await root.query('select discount_amount, line_total from public.sale_items where sale_id = $1', [s.sale_id])).rows[0]
    check('item discount math (500 - 5% = 475)', Number(item.discount_amount) === 25 && Number(item.line_total) === 475, item)
    const dAudit = (await root.query(`select count(*)::int as c from public.audit_logs where action = 'discount_applied' and entity_id = $1`, [s.sale_id])).rows[0].c
    check('discount audited', dAudit >= 1, dAudit)
    // personal limit 3%: 5% must now fail for this cashier
    await root.query('update public.profiles set pos_discount_limit_pct = 3 where id = $1', [cashierId])
    await expectError('discount over personal limit rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1, discount_type: 'pct', discount_value: 5 }],
      payments: [{ method: 'Cash', amount: 475 }],
    })]), 'DISCOUNT_LIMIT')
    // clear personal limit again; global cap 10 applies
    await root.query('update public.profiles set pos_discount_limit_pct = null where id = $1', [cashierId])
    await expectError('discount over global cap rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1, discount_type: 'pct', discount_value: 15 }],
      payments: [{ method: 'Cash', amount: 425 }],
    })]), 'DISCOUNT_LIMIT')
    await expectError('discount greater than line rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1, discount_type: 'fixed', discount_value: 600 }],
      payments: [{ method: 'Cash', amount: 1 }],
    })]), 'Discount greater than the line amount')
    // bill-level: within cap ok
    const rb = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 2 }],
      bill_discount_type: 'pct', bill_discount_value: 10,
      payments: [{ method: 'Cash', amount: 900 }],
    })])
    const sb = rb.rows[0].r as any
    check('bill discount 10% (cap) works', !!sb?.sale_id && Number(sb.bill_discount) === 100 && Number(sb.grand_total) === 900, sb)
    await expectError('bill discount over cap rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 2 }],
      bill_discount_type: 'pct', bill_discount_value: 15,
      payments: [{ method: 'Cash', amount: 850 }],
    })]), 'DISCOUNT_LIMIT')
    // remove the cashier permission again for later tests
    await root.query(`delete from public.role_permissions where role = 'cashier' and permission = 'apply_discount'`)
  }
  await root.query(`delete from public.role_permissions where role = 'cashier' and permission = 'apply_discount'`)

  console.log('\n== tax: exclusive mode + inter-state + disabled ==')
  {
    await root.query(`update public.app_settings set value = jsonb_set(value, '{default_tax_mode}', '"exclusive"'::jsonb) where key = 'pos'`)
    const r = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vC, quantity: 1 }],
      payments: [{ method: 'UPI', amount: 1344, reference: 'UPI123' }],
    })])
    const s = r.rows[0].r as any
    check('exclusive tax: 1200 + 12% = 1344', Number(s.tax_total) === 144 && Number(s.grand_total) === 1344, s)
    const pmt = (await root.query('select method, reference from public.sale_payments where sale_id = $1', [s.sale_id])).rows[0]
    check('UPI reference recorded', pmt.method === 'UPI' && pmt.reference === 'UPI123', pmt)
    await root.query(`update public.app_settings set value = jsonb_set(value, '{default_tax_mode}', '"inclusive"'::jsonb) where key = 'pos'`)
  }
  {
    const r = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1 }],
      customer_id: custId,   // Karnataka vs company state (null) -> not inter-state
      payments: [{ method: 'Cash', amount: 500 }],
    })])
    const s = r.rows[0].r as any
    check('customer attached + snapshot', s.customer_name === 'P3TEST Ravi Kumar', s)
    check('not inter-state (company state unset)', s.inter_state === false, s)
  }
  {
    // set company state -> inter-state kicks in
    await root.query(`update public.company_settings set state = 'Tamil Nadu' where id = 1`)
    const r = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1 }],
      customer_id: custId,
      payments: [{ method: 'Cash', amount: 500 }],
    })])
    check('inter-state flagged (TN vs Karnataka)', (r.rows[0].r as any).inter_state === true)
    await root.query(`update public.company_settings set state = null where id = 1`)
  }
  {
    await root.query(`update public.app_settings set value = jsonb_set(value, '{enabled}', 'false'::jsonb) where key = 'tax'`)
    const r = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vA, quantity: 1 }],
      payments: [{ method: 'Cash', amount: 500 }],
    })])
    const s = r.rows[0].r as any
    check('tax disabled -> zero tax', Number(s.tax_total) === 0, s)
    await root.query(`update public.app_settings set value = jsonb_set(value, '{enabled}', 'true'::jsonb) where key = 'tax'`)
  }

  console.log('\n== payments: split, change, overpay, disabled method, credit ==')
  {
    const r = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 2 }],   // 1500 incl tax
      payments: [
        { method: 'Cash', amount: 700, cash_received: 1000 },
        { method: 'UPI', amount: 800, reference: 'UPI-SPLIT-1' },
      ],
    })])
    const s = r.rows[0].r as any
    check('split payment accepted', !!s?.sale_id && Number(s.paid_amount) === 1500, s)
    check('cash change 300', Number(s.cash_change) === 300, s.cash_change)
    const rows = (await root.query('select method, amount, cash_received, cash_change from public.sale_payments where sale_id = $1 order by method', [s.sale_id])).rows
    check('payment rows stored (Cash + UPI)', rows.length === 2 && rows.some((x: any) => x.method === 'Cash' && Number(x.cash_change) === 300), rows)
  }
  {
    await expectError('cash received less than amount rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 1 }],
      payments: [{ method: 'Cash', amount: 750, cash_received: 500 }],
    })]), 'CASH_RECEIVED_LESS')
    await expectError('overpay rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 1 }],
      payments: [{ method: 'Cash', amount: 800 }],
    })]), 'PAYMENT_EXCEEDS_TOTAL')
    await expectError('disabled payment method rejected', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 1 }],
      payments: [{ method: 'Cheque', amount: 750 }],
    })]), 'PAYMENT_METHOD_DISABLED')
    await expectError('partial payment rejected when credit off', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 1 }],
      payments: [{ method: 'Cash', amount: 500 }],
    })]), 'CREDIT_NOT_ENABLED')
  }
  {
    // enable credit sales
    await root.query(`update public.app_settings set value = jsonb_set(value, '{allow_credit_sales}', 'true'::jsonb) where key = 'pos'`)
    await expectError('credit requires customer', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 1 }],
      payments: [{ method: 'Cash', amount: 500 }],
    })]), 'CREDIT_REQUIRES_CUSTOMER')
    const r = await cashier.query('select public.create_sale($1::jsonb) as r', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 1 }],
      customer_id: custId,
      payments: [{ method: 'Cash', amount: 500 }, { method: 'Credit', amount: 250 }],
    })])
    const s = r.rows[0].r as any
    check('credit sale: partially paid', s.payment_status === 'PARTIALLY_PAID' && Number(s.due_amount) === 250, s)
    const creditRow = (await root.query('select is_credit, amount from public.sale_payments where sale_id = $1 and is_credit', [s.sale_id])).rows
    check('credit payment row flagged', creditRow.length === 1 && Number(creditRow[0].amount) === 250, creditRow)
    await expectError('credit row must equal remaining balance', () => cashier.query('select public.create_sale($1::jsonb)', [JSON.stringify({
      items: [{ variant_id: vB, quantity: 1 }],
      customer_id: custId,
      payments: [{ method: 'Cash', amount: 500 }, { method: 'Credit', amount: 100 }],
    })]), 'CREDIT_MISMATCH')
    await root.query(`update public.app_settings set value = jsonb_set(value, '{allow_credit_sales}', 'false'::jsonb) where key = 'pos'`)
  }

  console.log('\n== invoice numbering sequence ==')
  {
    const nums = (await root.query('select sale_number from public.sales order by sale_number')).rows.map((x: any) => x.sale_number)
    const unique = new Set(nums)
    check('all invoice numbers unique', unique.size === nums.length, nums)
    check('numbers strictly increasing', nums.every((n: string, i: number) => i === 0 || n > nums[i - 1]), nums)
  }

  console.log('\n== held bills: never touch stock ==')
  {
    const stockBefore = (await root.query('select quantity from public.stock_balances where variant_id = $1', [vA])).rows[0].quantity
    const cart = { items: [{ variant_id: vA, quantity: 3 }], customer_id: null, bill_discount_type: 'pct', bill_discount_value: 0 }
    const h = (await cashier.query('select public.hold_bill($1::jsonb, $2, $3, $4, $5) as r', [JSON.stringify(cart), 'Walk-in pending', null, 1, 1500])).rows[0].r as any
    check('bill held', !!h?.id, h)
    const stockAfter = (await root.query('select quantity from public.stock_balances where variant_id = $1', [vA])).rows[0].quantity
    check('stock NOT deducted while held', stockBefore === stockAfter, { stockBefore, stockAfter })
    const myHeld = (await cashier.query('select * from public.held_bills where status = \'HELD\'')).rows
    const otherHeld = (await cashier2.query('select * from public.held_bills where status = \'HELD\'')).rows
    check('held list private to owner', myHeld.length === 1 && otherHeld.length === 0, { my: myHeld.length, other: otherHeld.length })
    await expectError('another cashier cannot resume', () => cashier2.query('select public.resume_held_bill($1)', [h.id]), 'another cashier')
    const res = (await cashier.query('select public.resume_held_bill($1) as r', [h.id])).rows[0].r as any
    check('resume returns cart', res?.cart?.items?.[0]?.variant_id === vA, res)
    const hAudit = (await root.query(`select count(*)::int as c from public.audit_logs where action in ('bill_held','bill_resumed')`)).rows[0].c
    check('hold/resume audited', hAudit >= 2, hAudit)
    const d = (await cashier.query('select public.discard_held_bill($1) as r', [h.id])).rows[0].r as any
    check('discard works', d?.status === 'DISCARDED', d)
    const stockFinal = (await root.query('select quantity from public.stock_balances where variant_id = $1', [vA])).rows[0].quantity
    check('stock still untouched after resume+discard', stockBefore === stockFinal)
  }

  console.log('\n== sales history: filters + pagination ==')
  {
    const r = await cashier.query('select public.sales_page($1, null, null, null, null, null, null, 5, 0) as r', ['P3TEST Ravi'])
    const page = r.rows[0].r as any
    check('search by customer name', page.rows.length >= 1 && page.rows.every((x: any) => x.customer_name === 'P3TEST Ravi Kumar'), page.rows?.length)
    const r2 = await cashier.query('select public.sales_page($1, null, null, null, null, null, null, 100, 0) as r', [null])
    const all = r2.rows[0].r as any
    check('unfiltered page returns rows + total', all.rows.length >= 8 && Number(all.total) >= 8, { rows: all.rows.length, total: all.total })
    const r3 = await cashier.query('select public.sales_page($1, null, null, $2, null, null, null, 100, 0) as r', [null, 'UPI'])
    check('filter by payment method UPI', (r3.rows[0].r as any).rows.length >= 1, (r3.rows[0].r as any).rows?.length)
    const r4 = await cashier.query('select public.sales_page($1, null, null, null, $2, null, null, 100, 0) as r', [null, cashierId])
    check('filter by cashier', (r4.rows[0].r as any).rows.length >= 1)
    const r5 = await cashier.query('select public.sales_page($1, null, null, null, null, null, $2, 100, 0) as r', [null, 'PARTIALLY_PAID'])
    check('filter by payment status', (r5.rows[0].r as any).rows.length >= 1)
    const r6 = await accountant.query('select public.sales_page(null, null, null, null, null, null, null, 5, 0) as r', [])
    check('accountant (view_sales) can list sales', (r6.rows[0].r as any).rows !== undefined)
    // pagination
    const p1 = (await cashier.query('select public.sales_page(null, null, null, null, null, null, null, 3, 0) as r')).rows[0].r as any
    const p2 = (await cashier.query('select public.sales_page(null, null, null, null, null, null, null, 3, 3) as r')).rows[0].r as any
    check('pagination windows differ', p1.rows[0]?.id !== p2.rows[0]?.id, { a: p1.rows[0]?.id, b: p2.rows[0]?.id })
  }

  console.log('\n== sale_detail ==')
  {
    const anySale = (await root.query('select id from public.sales where status = \'COMPLETED\' order by created_at limit 1')).rows[0].id
    const r = await cashier.query('select public.sale_detail($1) as r', [anySale])
    const d = r.rows[0].r as any
    check('detail: sale + items + payments + movements', !!d.sale && Array.isArray(d.items) && Array.isArray(d.payments) && Array.isArray(d.movements), Object.keys(d ?? {}))
    check('detail: movement references sale', d.movements.every((m: any) => m.reference_id === anySale || m.reference_type === 'sale_cancel'), d.movements?.length)
  }

  console.log('\n== RLS: direct writes blocked, reads enforced ==')
  {
    await expectError('direct INSERT into sales denied (grant/RLS)', () => cashier.query(
      `insert into public.sales (sale_number, grand_total) values ('HACK-1', 1)`
    ), 'permission denied')
    await expectError('direct UPDATE of stock quantity denied', () => cashier.query(
      `update public.stock_balances set quantity = 999 where variant_id = $1`, [vA]
    ), 'permission denied')
    // accountant lacks manage_customers -> cannot read customers
    const custR = await accountant.query('select count(*)::int as c from public.customers')
    check('accountant cannot read customers (no policy rows)', custR.rows[0].c === 0, custR.rows[0].c)
    const custCashier = await cashier.query('select count(*)::int as c from public.customers')
    check('cashier (manage_customers) reads customers', custCashier.rows[0].c >= 1, custCashier.rows[0].c)
    // inventory_manager role cannot see sales (no view/create/cancel permission)
    const invId = await mkUser('pg3-inv@test.local', 'P3 InvMgr', 'inventory_manager')
    const inv = await asUser(invId)
    await expectError('inventory manager cannot list sales', () => inv.query('select public.sales_page(null, null, null, null, null, null, null, 5, 0)'), 'permission')
  }

  console.log('\n== cancel_sale: permission, restock, audit, preservation ==')
  {
    // pick the credit sale (has customer + partial payment)
    const creditSale = (await root.query(`select id, sale_number, paid_amount, grand_total from public.sales where payment_status = 'PARTIALLY_PAID' limit 1`)).rows[0]
    await expectError('cashier cannot cancel', () => cashier.query('select public.cancel_sale($1, $2)', [creditSale.id, 'test']), 'permission')
    await expectError('reason required', () => manager.query('select public.cancel_sale($1, $2)', [creditSale.id, '  ']), 'reason is required')

    const stockBefore = (await root.query('select quantity from public.stock_balances where variant_id = $1', [vB])).rows[0].quantity
    const r = await manager.query('select public.cancel_sale($1, $2) as r', [creditSale.id, 'Customer returned the goods'])
    const c = r.rows[0].r as any
    check('manager cancels sale', c?.status === 'CANCELLED', c)
    const stockAfter = (await root.query('select quantity from public.stock_balances where variant_id = $1', [vB])).rows[0].quantity
    check('stock restored', stockAfter === stockBefore + 1, { stockBefore, stockAfter })
    const rev = (await root.query(`select * from public.stock_movements where reference_id = $1 and reference_type = 'sale_cancel'`, [creditSale.id])).rows
    check('SALES_RETURN reversal movement', rev.length === 1 && rev[0].quantity === 1, rev)
    const saleRow = (await root.query('select status, cancel_reason, cancelled_by, paid_amount from public.sales where id = $1', [creditSale.id])).rows[0]
    check('sale record preserved with reason', saleRow.status === 'CANCELLED' && saleRow.cancel_reason === 'Customer returned the goods' && !!saleRow.cancelled_by, saleRow)
    await expectError('double cancel rejected', () => manager.query('select public.cancel_sale($1, $2)', [creditSale.id, 'again']), 'Only completed sales')
    const cAudit = (await root.query(`select count(*)::int as c from public.audit_logs where action = 'sale_cancelled' and entity_id = $1`, [creditSale.id])).rows[0].c
    check('cancellation audited', cAudit === 1, cAudit)
    // cancelled sale visible with status filter
    const cc = (await manager.query('select public.sales_page(null, null, null, null, null, $1, null, 100, 0) as r', ['CANCELLED'])).rows[0].r as any
    check('cancelled sales listed under filter', cc.rows.some((x: any) => x.id === creditSale.id), cc.rows?.length)
  }

  console.log('\n== CONCURRENCY: two cashiers, one last unit ==')
  {
    // vLast has exactly 1 unit in stock
    const mkPayload = () => JSON.stringify({
      items: [{ variant_id: vLast, quantity: 1 }],
      payments: [{ method: 'Cash', amount: 1200 }],
    })
    const salesBefore = (await root.query('select count(*)::int as c from public.sales')).rows[0].c
    const [r1, r2] = await Promise.allSettled([
      cashier.query('select public.create_sale($1::jsonb) as r', [mkPayload()]),
      cashier2.query('select public.create_sale($1::jsonb) as r', [mkPayload()]),
    ])
    const ok1 = r1.status === 'fulfilled'
    const ok2 = r2.status === 'fulfilled'
    const err1 = r1.status === 'rejected' ? String(r1.reason?.message ?? r1.reason) : ''
    const err2 = r2.status === 'rejected' ? String(r2.reason?.message ?? r2.reason) : ''
    const failedOne = err1.includes('INSUFFICIENT_STOCK') || err2.includes('INSUFFICIENT_STOCK')
    check('exactly one sale succeeded', ok1 !== ok2, { ok1, ok2 })
    check('the other failed with INSUFFICIENT_STOCK', failedOne, { r1: err1.slice(0, 80), r2: err2.slice(0, 80) })
    const salesAfter = (await root.query('select count(*)::int as c from public.sales')).rows[0].c
    check('no extra sale rows', salesAfter === salesBefore + 1, { salesBefore, salesAfter })
    const stock = (await root.query('select quantity from public.stock_balances where variant_id = $1', [vLast])).rows[0]
    check('final stock is exactly 0 (not negative)', stock.quantity === 0, stock)
    const movements = (await root.query(`select * from public.stock_movements where variant_id = $1 and movement_type = 'SALE'`, [vLast])).rows
    check('exactly one SALE movement', movements.length === 2 - 1, movements.length) // opening(1) + sale(1) = all movements for variant... count SALE only
    const saleMovements = movements.filter((m: any) => m.movement_type === 'SALE')
    check('SALE movement count 1', saleMovements.length === 1, saleMovements.length)
    const winnerResult = ok1 && r1.status === 'fulfilled' ? r1.value : r2.status === 'fulfilled' ? r2.value : null
    const winnerId = (winnerResult?.rows[0]?.r as any)?.sale_id
    const orphanItems = (await root.query(`select count(*)::int as c from public.sale_items where sale_id not in (select id from public.sales)`)).rows[0].c
    const orphanPmts = (await root.query(`select count(*)::int as c from public.sale_payments where sale_id not in (select id from public.sales)`)).rows[0].c
    check('no orphan items / payments', orphanItems === 0 && orphanPmts === 0, { orphanItems, orphanPmts })
    check('winner has exactly 1 item + 1 payment',
      (await root.query('select count(*)::int as c from public.sale_items where sale_id = $1', [winnerId])).rows[0].c === 1
      && (await root.query('select count(*)::int as c from public.sale_payments where sale_id = $1', [winnerId])).rows[0].c === 1)
  }

  console.log('\n== invoice numbers after everything: still unique ==')
  {
    const nums = (await root.query('select sale_number from public.sales')).rows.map((x: any) => x.sale_number)
    check('uniqueness holds globally', new Set(nums).size === nums.length, nums.length)
  }

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`)
  if (failures.length) console.log('Failures:\n  ' + failures.join('\n  '))

  for (const c of [root, admin, cashier, cashier2, manager, accountant]) await c.end()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('SUITE CRASHED:', e)
  process.exit(1)
})
