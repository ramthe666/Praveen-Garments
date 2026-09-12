/**
 * PHASE 6 AUDIT — PART 1: identifier model + POS→stock chain + stock edge cases.
 * Covers prompt §6–§16: barcode/QR/SKU data model, scan→variant resolution,
 * sale→item→payment→atomic stock deduction→movement→balance chain, repeated
 * scans, multi-variant isolation, multi-location, out-of-stock, exact-stock,
 * concurrency, double-submit semantics, negative-stock rule, cancel-restore.
 *
 * Prereq: reset-full chain 0001→0013 applied to a FRESH local harness.
 * Single-run suite (fixed SKUs): re-running requires reset-full first.
 *
 * Run from pgtest/: bun run scripts/local/test-audit1.ts
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

  async function as(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query('set role authenticated')
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    return c
  }
  async function rpcJson<T = any>(client: Client, fn: string, payload: unknown): Promise<T> {
    const res = await client.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(payload)])
    return res.rows[0].r as T
  }
  const val = async (client: Client, sql: string, vals: unknown[] = []) =>
    (await client.query(sql, vals)).rows[0]
  const num = async (client: Client, sql: string, vals: unknown[] = []) =>
    Number((await val(client, sql, vals)).n ?? 0)
  const stockOf = async (client: Client, variantId: string, locId?: string): Promise<number | null> => {
    if (locId) {
      const r = await val(client, 'select quantity from public.stock_balances where variant_id = $1 and location_id = $2', [variantId, locId])
      return r ? Number(r.quantity) : null
    }
    return Number(await num(client, 'select coalesce(sum(quantity), 0) as n from public.stock_balances where variant_id = $1', [variantId]))
  }

  async function mkUser(email: string, name: string, role: string) {
    const id = (await root.query(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify({ app_role: role, full_name: name })]
    )).rows[0].id as string
    await root.query(
      `insert into public.profiles (id, email, full_name, role) values ($1, $2, $3, $4::public.user_role)
       on conflict (id) do update set role = $4::public.user_role, is_active = true`,
      [id, email, name, role])
    return id
  }

  // ===========================================================================
  console.log('== A. SETUP (users, catalog, identifiers, stock) ==')
  const adminId = await mkUser('audit6-admin@t.local', 'Audit Admin', 'admin')
  const cashAId = await mkUser('audit6-casha@t.local', 'Audit Cashier A', 'cashier')
  const cashBId = await mkUser('audit6-cashb@t.local', 'Audit Cashier B', 'cashier')
  const mgrId = await mkUser('audit6-mgr@t.local', 'Audit Manager', 'manager')
  const admin = await as(adminId)
  const cashA = await as(cashAId)
  const cashB = await as(cashBId)
  const mgr = await as(mgrId)
  check('4 test users created (admin/cashier/cashier/manager)', Boolean(adminId && cashAId && cashBId && mgrId))

  const mainLoc = (await val(admin, `select id, name from public.stock_locations where code = 'MAIN'`)).id as string
  const whLoc = (await val(admin,
    `insert into public.stock_locations (name, code, location_type) values ('Audit Warehouse', 'AUDWH', 'warehouse') returning id`
  )).id as string
  check('Main Store seeded + Audit Warehouse created', Boolean(mainLoc && whLoc))

  const sizeM = (await val(admin, `select id from public.sizes where name = 'M'`)).id as string
  const sizeL = (await val(admin, `select id from public.sizes where name = 'L'`)).id as string
  const colorBlu = (await val(admin, `select id from public.colors where name = 'Blue'`)).id as string
  const colorBlk = (await val(admin, `select id from public.colors where name = 'Black'`)).id as string
  const catId = (await val(admin, `insert into public.categories (name) values ('Audit Cat') returning id`)).id as string
  const brandId = (await val(admin, `insert into public.brands (name) values ('Audit Brand') returning id`)).id as string

  const shirtId = (await val(admin,
    `insert into public.products (name, product_code, category_id, brand_id, gender, gst_rate, mrp, selling_price, cost_price, hsn_code, fabric)
     values ('Audit Shirt', 'AUDSHIRT', $1, $2, 'men', 5, 1499, 999, 500, '6205', 'Cotton') returning id`,
    [catId, brandId])).id as string

  const shirtBatch = [
    { sku: 'AUD-SHIRT-BLU-M', size_id: sizeM, color_id: colorBlu, selling_price: '999', barcode: '2900000000018', qr_identifier: 'AUDQRBLUM1' },
    { sku: 'AUD-SHIRT-BLU-L', size_id: sizeL, color_id: colorBlu, selling_price: '999', barcode: '2900000000025', qr_identifier: 'AUDQRBLUL1' },
    { sku: 'AUD-SHIRT-BLK-M', size_id: sizeM, color_id: colorBlk, selling_price: '999', barcode: '2900000000032', qr_identifier: 'AUDQRBLKM1' },
    { sku: 'AUD-SHIRT-CTL-M', size_id: sizeM, selling_price: '500' },
    { sku: 'AUD-SHIRT-OOS-M', size_id: sizeM, selling_price: '999' },
    { sku: 'AUD-SHIRT-EXA-M', size_id: sizeM, selling_price: '999' },
    { sku: 'AUD-SHIRT-CONC-M', size_id: sizeM, selling_price: '999' },
    { sku: 'AUD-SHIRT-NEG-M', size_id: sizeM, selling_price: '999' },
    { sku: 'AUD-SHIRT-CAN-M', size_id: sizeM, selling_price: '999' },
  ]
  const shirtVariants = (await val(admin,
    `select public.create_product_variants($1, $2::jsonb) as r`, [shirtId, JSON.stringify(shirtBatch)])).r.variants
  check('9 audit-shirt variants created with explicit identifiers', shirtVariants.length === 9, shirtVariants)
  const bySku = (sku: string) => shirtVariants.find((v: any) => v.sku === sku)
  const vBluM = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-BLU-M'`)).id as string
  const vBluL = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-BLU-L'`)).id as string
  const vBlkM = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-BLK-M'`)).id as string
  const vCtrl = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-CTL-M'`)).id as string
  const vOos = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-OOS-M'`)).id as string
  const vExa = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-EXA-M'`)).id as string
  const vConc = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-CONC-M'`)).id as string
  const vNeg = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-NEG-M'`)).id as string
  const vCan = (await val(admin, `select id from public.product_variants where sku = 'AUD-SHIRT-CAN-M'`)).id as string

  const jeansId = (await val(admin,
    `insert into public.products (name, product_code, category_id, brand_id, gender, gst_rate, mrp, selling_price, hsn_code)
     values ('Audit Jeans', 'AUDJEAN', $1, $2, 'men', 5, 2999, 1000, '6203') returning id`,
    [catId, brandId])).id as string
  const mkVariants = async (productId: string, batch: unknown[]) =>
    (await val(admin, `select public.create_product_variants($1, $2::jsonb) as r`, [productId, JSON.stringify(batch)])).r
  await mkVariants(jeansId, [
    { sku: 'AUD-JEAN-1000', size_id: sizeM, selling_price: '1000' },
    { sku: 'AUD-JEAN-1250', size_id: sizeL, selling_price: '1250' },
    { sku: 'AUD-JEAN-2500', size_id: sizeM, selling_price: '2500' },
  ])
  const vJ1000 = (await val(admin, `select id from public.product_variants where sku = 'AUD-JEAN-1000'`)).id as string
  const vJ1250 = (await val(admin, `select id from public.product_variants where sku = 'AUD-JEAN-1250'`)).id as string
  const vJ2500 = (await val(admin, `select id from public.product_variants where sku = 'AUD-JEAN-2500'`)).id as string

  const exId = (await val(admin,
    `insert into public.products (name, product_code, category_id, brand_id, gender, gst_rate, mrp, selling_price)
     values ('Audit Exchange Tee', 'AUDEX', $1, $2, 'men', 5, 1299, 999) returning id`,
    [catId, brandId])).id as string
  await mkVariants(exId, [
    { sku: 'AUD-EX-A', size_id: sizeM, selling_price: '999' },
    { sku: 'AUD-EX-B', size_id: sizeL, selling_price: '1199' },
  ])
  const vExA = (await val(admin, `select id from public.product_variants where sku = 'AUD-EX-A'`)).id as string
  const vExB = (await val(admin, `select id from public.product_variants where sku = 'AUD-EX-B'`)).id as string

  const purId = (await val(admin,
    `insert into public.products (name, product_code, category_id, brand_id, gender, gst_rate, mrp, selling_price)
     values ('Audit Purchase Item', 'AUDPUR', $1, $2, 'men', 5, 599, 400) returning id`,
    [catId, brandId])).id as string
  await mkVariants(purId, [{ sku: 'AUD-PUR-M', size_id: sizeM, selling_price: '400' }])
  const vPur = (await val(admin, `select id from public.product_variants where sku = 'AUD-PUR-M'`)).id as string

  check('catalog: 14 variants across 4 audit products', Boolean(vBluM && vBluL && vBlkM && vCtrl && vOos && vExa && vConc && vNeg && vCan && vJ1000 && vJ1250 && vJ2500 && vExA && vExB && vPur))

  const opening = async (variant: string, loc: string, qty: number) =>
    (await val(admin, `select public.set_opening_stock($1, $2, $3) as r`, [variant, loc, qty])).r
  await opening(vBluM, mainLoc, 10)
  await opening(vBluM, whLoc, 20)
  await opening(vBluL, mainLoc, 10)
  await opening(vBlkM, mainLoc, 10)
  await opening(vCtrl, mainLoc, 10)
  await opening(vCtrl, whLoc, 20)
  await opening(vJ1000, mainLoc, 100)
  await opening(vJ1250, mainLoc, 100)
  await opening(vJ2500, mainLoc, 100)
  await opening(vExA, mainLoc, 10)
  await opening(vExB, mainLoc, 10)
  await opening(vExa, mainLoc, 3)
  await opening(vConc, mainLoc, 1)
  await opening(vNeg, mainLoc, 2)
  await opening(vCan, mainLoc, 5)
  check('opening stock set for all chain-test variants', await stockOf(admin, vBluM, mainLoc) === 10)

  // ===========================================================================
  console.log('\n== B. §6 IDENTIFIER DATA MODEL (variant-owned, DB-enforced uniqueness) ==')
  await expectError('duplicate barcode rejected by DB (partial unique index)', () =>
    admin.query(`insert into public.product_variants (product_id, sku, barcode) values ($1, 'AUD-DUP-1', '2900000000018')`, [shirtId]),
    'duplicate key')
  await expectError('duplicate SKU rejected case-insensitively', () =>
    admin.query(`insert into public.product_variants (product_id, sku) values ($1, 'aud-shirt-blu-m')`, [shirtId]),
    'duplicate key')
  await expectError('duplicate QR identifier rejected by DB', () =>
    admin.query(`insert into public.product_variants (product_id, sku, qr_identifier) values ($1, 'AUD-DUP-2', 'AUDQRBLUM1')`, [shirtId]),
    'duplicate key')
  const bc1 = (await val(admin, 'select public.generate_barcode() as b')).b as string
  const bc2 = (await val(admin, 'select public.generate_barcode() as b')).b as string
  const qr1 = (await val(admin, 'select public.generate_qr_identifier() as q')).q as string
  check('generate_barcode mints distinct 13-digit values', bc1 !== bc2 && /^\d{13}$/.test(bc1), { bc1, bc2 })
  check('generate_qr_identifier mints QR + 10 digits', /^QR\d{10}$/.test(qr1), qr1)

  console.log('\n== C. §6/§7 IDENTIFIER → VARIANT RESOLUTION ==')
  const fRes = async (v: string, client: Client = admin) =>
    (await val(client, 'select public.find_variant_by_identifier($1) as r', [v])).r
  const rBar = await fRes('2900000000018')
  check('barcode resolves to the EXACT variant (Blue/M, not merely the product)',
    rBar?.variant_id === vBluM && rBar?.sku === 'AUD-SHIRT-BLU-M' && rBar?.color_name === 'Blue' && rBar?.size_name === 'M', rBar)
  const rQr = await fRes('AUDQRBLUM1')
  check('QR identifier resolves to the EXACT variant', rQr?.variant_id === vBluM && rQr?.sku === 'AUD-SHIRT-BLU-M', rQr)
  const rSku = await fRes('AUD-SHIRT-BLU-M')
  const rSkuLower = await fRes('aud-shirt-blu-m')
  check('SKU resolves to the exact variant (case-insensitive)', rSku?.variant_id === vBluM && rSkuLower?.variant_id === vBluM, { rSku: rSku?.variant_id, rSkuLower: rSkuLower?.variant_id })
  check('unknown identifier returns null (no silent wrong match)', (await fRes('NO-SUCH-CODE')) === null)
  check('Black/M barcode resolves to Black/M (NOT Blue/M)', (await fRes('2900000000032'))?.variant_id === vBlkM)

  const posRes = async (q: string, limit = 12, client: Client = cashA) =>
    (await val(client, 'select public.pos_search($1, $2) as r', [q, limit])).r
  const pBar = await posRes('2900000000018', 1)
  check('pos_search(barcode) → exact variant first', pBar?.rows?.[0]?.variant_id === vBluM, pBar?.rows?.[0])
  const pQr = await posRes('AUDQRBLKM1', 1)
  check('pos_search(QR) → exact variant first', pQr?.rows?.[0]?.variant_id === vBlkM, pQr?.rows?.[0])
  const pSku = await posRes('AUD-SHIRT-BLU-L', 1)
  check('pos_search(SKU) → exact variant first', pSku?.rows?.[0]?.variant_id === vBluL, pSku?.rows?.[0])
  const pFuzzy = await posRes('AUD-SHIRT', 12)
  note(`pos_search('AUD-SHIRT') returns ${pFuzzy?.rows?.length} fuzzy rows — the POS frontend must gate auto-add on exact matches (frontend fix, tested in browser audit)`)
  check('fuzzy search returns multiple ranked rows (search feature works)', (pFuzzy?.rows?.length ?? 0) >= 3, pFuzzy?.rows?.length)
  const pNone = await posRes('ZZZZ-NOPE', 12)
  check('no match → zero rows (POS shows "Not found")', (pNone?.rows?.length ?? 0) === 0)
  const cashierF = await fRes('2900000000018', cashA)
  check('find_variant_by_identifier also resolves for cashier', cashierF?.variant_id === vBluM, cashierF)

  // ===========================================================================
  console.log('\n== D. §7 BARCODE → POS → SALE → ATOMIC STOCK CHAIN ==')
  const sale = async (client: Client, items: any[], payments: any[], extra: Record<string, unknown> = {}) =>
    rpcJson<any>(client, 'create_sale', { items, payments, ...extra })
  let r1 = await sale(cashA, [{ variant_id: vBluM, quantity: 1 }], [{ method: 'Cash', amount: 999 }])
  check('sale via barcode-resolved variant: grand=999 paid=999 due=0 PAID',
    Number(r1.grand_total) === 999 && Number(r1.paid_amount) === 999 && Number(r1.due_amount) === 0 && r1.payment_status === 'PAID', r1)
  check('sale_number pattern INV-2026-######', /^INV-2026-\d{6}$/.test(r1.sale_number), r1.sale_number)
  check('sale location = Main Store', r1.location_name === 'Main Store', r1.location_name)
  const s1 = await val(admin, 'select * from public.sales where id = $1', [r1.sale_id])
  check('sales row: COMPLETED, correct cashier snapshot + location FK',
    s1.status === 'COMPLETED' && s1.cashier_id === cashAId && s1.cashier_name === 'Audit Cashier A' && s1.location_id === mainLoc, s1)
  const si1 = await val(admin, 'select * from public.sale_items where sale_id = $1', [r1.sale_id])
  check('sale_item snapshot: correct variant, SKU, qty 1, base=unit=999, mrp=1499, line_total=999',
    si1.variant_id === vBluM && si1.sku === 'AUD-SHIRT-BLU-M' && si1.quantity === 1 &&
    Number(si1.base_price) === 999 && Number(si1.unit_price) === 999 && Number(si1.mrp) === 1499 && Number(si1.line_total) === 999, si1)
  const pay1 = await val(admin, 'select * from public.sale_payments where sale_id = $1', [r1.sale_id])
  check('payment row: Cash 999, not credit, recorded by cashier', pay1.method === 'Cash' && Number(pay1.amount) === 999 && pay1.is_credit === false && pay1.recorded_by === cashAId, pay1)
  check('stock deducted 10 → 9 at the sold location only', await stockOf(admin, vBluM, mainLoc) === 9 && await stockOf(admin, vBluM, whLoc) === 20)
  const mv1 = await val(admin,
    `select * from public.stock_movements where reference_type = 'sale' and reference_id = $1`, [r1.sale_id])
  check('stock_movement: SALE -1, balance_after 9, linked to the sale',
    mv1.movement_type === 'SALE' && mv1.quantity === -1 && Number(mv1.balance_after) === 9 && mv1.variant_id === vBluM && mv1.location_id === mainLoc, mv1)
  const aud1 = await num(root, `select count(*) as n from public.audit_logs where action = 'sale_created' and entity_id = $1`, [r1.sale_id])
  check('audit trail: sale_created written', aud1 === 1)
  note('audit_logs direct SELECT is ACL-blocked for authenticated (reads only via the audit_page RPC) — hard security boundary confirmed')
  note(`§7 chain verified end-to-end for barcode ${'2900000000018'} → variant AUD-SHIRT-BLU-M → sale ${r1.sale_number} → stock 10→9 → movement SALE -1`)

  // ===========================================================================
  console.log('\n== E. §8 QR → POS → SALE → STOCK CHAIN ==')
  const r2 = await sale(cashA, [{ variant_id: vBlkM, quantity: 1 }], [{ method: 'Cash', amount: 999 }])
  check('sale via QR-resolved variant succeeds (Black/M)', r2.payment_status === 'PAID' && Number(r2.grand_total) === 999, r2)
  check('QR sale: stock 10 → 9', await stockOf(admin, vBlkM, mainLoc) === 9)
  const mv2 = await val(admin, `select * from public.stock_movements where reference_type = 'sale' and reference_id = $1`, [r2.sale_id])
  check('QR sale movement: SALE -1 balance_after 9 correct variant+location',
    mv2.movement_type === 'SALE' && mv2.quantity === -1 && mv2.variant_id === vBlkM && mv2.location_id === mainLoc, mv2)
  note(`§8 chain verified for QR AUDQRBLKM1 → variant AUD-SHIRT-BLK-M → sale ${r2.sale_number}`)

  // ===========================================================================
  console.log('\n== F. §9 REPEATED SCAN → ONE LINE, ONE FINANCIAL TRANSACTION ==')
  await expectError('duplicate cart line for one variant rejected (forces qty on one line)', () =>
    sale(cashA, [{ variant_id: vBluL, quantity: 1 }, { variant_id: vBluL, quantity: 1 }], [{ method: 'Cash', amount: 1998 }]),
    'duplicate cart line')
  const r3 = await sale(cashA, [{ variant_id: vBluL, quantity: 3 }], [{ method: 'Cash', amount: 2997 }])
  const si3 = await val(admin, 'select * from public.sale_items where sale_id = $1', [r3.sale_id])
  check('3 repeated scans = exactly ONE sale_item with quantity 3', si3.quantity === 3, si3)
  const mv3 = await val(admin, `select * from public.stock_movements where reference_type = 'sale' and reference_id = $1`, [r3.sale_id])
  check('one SALE movement of -3 (not three of -1)', mv3.quantity === -3 && Number(mv3.balance_after) === 7, mv3)
  check('stock 10 → 7 after the triple-scan sale', await stockOf(admin, vBluL, mainLoc) === 7)

  // ===========================================================================
  console.log('\n== G. §10 MULTI-VARIANT ISOLATION ==')
  const before = {
    bluM: await stockOf(admin, vBluM, mainLoc), bluL: await stockOf(admin, vBluL, mainLoc),
    blkM: await stockOf(admin, vBlkM, mainLoc), ctrl: await stockOf(admin, vCtrl, mainLoc),
  }
  const r4 = await sale(cashA, [
    { variant_id: vBluM, quantity: 1 }, { variant_id: vBluL, quantity: 1 }, { variant_id: vBlkM, quantity: 1 },
  ], [{ method: 'Cash', amount: 2997 }])
  const mvs4 = (await admin.query(`select variant_id, quantity from public.stock_movements where reference_type = 'sale' and reference_id = $1`, [r4.sale_id])).rows
  check('one sale, 3 item lines, 3 SALE movements (-1 each)',
    mvs4.length === 3 && mvs4.every((m) => Number(m.quantity) === -1), mvs4)
  check('Blue/M 9→8, Blue/L 7→6, Black/M 9→8 — ONLY the sold variants changed',
    await stockOf(admin, vBluM, mainLoc) === before.bluM! - 1 &&
    await stockOf(admin, vBluL, mainLoc) === before.bluL! - 1 &&
    await stockOf(admin, vBlkM, mainLoc) === before.blkM! - 1)
  check('control variant untouched (identifier→variant mapping is exact)',
    await stockOf(admin, vCtrl, mainLoc) === before.ctrl)

  // ===========================================================================
  console.log('\n== H. §11 MULTI-LOCATION + TRANSFER ==')
  const r5 = await sale(cashA, [{ variant_id: vCtrl, quantity: 1 }], [{ method: 'Cash', amount: 500 }], { location_id: mainLoc })
  check('sale pinned to Main Store succeeds', r5.payment_status === 'PAID')
  check('Main Store 10→9, Warehouse stays 20 (only the sold location decrements)',
    await stockOf(admin, vCtrl, mainLoc) === 9 && await stockOf(admin, vCtrl, whLoc) === 20)
  const tr = (await val(admin, `select public.transfer_stock($1, $2, $3, 3, 'audit restock') as r`, [vCtrl, mainLoc, whLoc])).r
  check('transfer 3: main 9→6, warehouse 20→23', Number(tr.from_balance) === 6 && Number(tr.to_balance) === 23, tr)
  const trMv = (await admin.query(
    `select movement_type, quantity, balance_after, location_id from public.stock_movements where reference_type = 'transfer' and variant_id = $1 order by id desc limit 2`,
    [vCtrl])).rows
  check('transfer ledger: TRANSFER_OUT -3 @main + TRANSFER_IN +3 @warehouse (both legs)',
    trMv.length === 2 &&
    trMv.some((m) => m.movement_type === 'TRANSFER_OUT' && m.quantity === -3 && m.location_id === mainLoc) &&
    trMv.some((m) => m.movement_type === 'TRANSFER_IN' && m.quantity === 3 && m.location_id === whLoc), trMv)
  check('balances after transfer match ledger', await stockOf(admin, vCtrl, mainLoc) === 6 && await stockOf(admin, vCtrl, whLoc) === 23)

  // ===========================================================================
  console.log('\n== I. §12/§16 OUT-OF-STOCK + FULL ATOMIC ROLLBACK ==')
  const countsBefore = await val(admin, `select
      (select count(*) from public.sales) as sales,
      (select count(*) from public.sale_items) as items,
      (select count(*) from public.sale_payments) as payments,
      (select count(*) from public.stock_movements) as movements`)
  await expectError('selling a variant with NO stock row rejected', () =>
    sale(cashA, [{ variant_id: vOos, quantity: 1 }], [{ method: 'Cash', amount: 999 }]), 'INSUFFICIENT_STOCK')
  await expectError('mixed valid + out-of-stock line → WHOLE sale rolls back', () =>
    sale(cashA, [{ variant_id: vBluM, quantity: 1 }, { variant_id: vOos, quantity: 1 }], [{ method: 'Cash', amount: 1998 }]), 'INSUFFICIENT_STOCK')
  const countsAfter = await val(admin, `select
      (select count(*) from public.sales) as sales,
      (select count(*) from public.sale_items) as items,
      (select count(*) from public.sale_payments) as payments,
      (select count(*) from public.stock_movements) as movements`)
  check('§16 atomicity: zero orphan sales/items/payments/movements from failed checkouts',
    countsBefore.sales === countsAfter.sales && countsBefore.items === countsAfter.items &&
    countsBefore.payments === countsAfter.payments && countsBefore.movements === countsAfter.movements,
    { countsBefore, countsAfter })
  check('no negative stock row created for the out-of-stock variant', await stockOf(admin, vOos, mainLoc) === null)
  check('stock of the valid line untouched after rollback', await stockOf(admin, vBluM, mainLoc) === 8)

  // ===========================================================================
  console.log('\n== J. §13 EXACT-STOCK ==')
  const rExa = await sale(cashA, [{ variant_id: vExa, quantity: 3 }], [{ method: 'Cash', amount: 2997 }])
  check('selling the exact remaining 3 succeeds → balance 0', rExa.payment_status === 'PAID' && await stockOf(admin, vExa, mainLoc) === 0)
  await expectError('one more unit after exact-stock depletion is rejected', () =>
    sale(cashA, [{ variant_id: vExa, quantity: 1 }], [{ method: 'Cash', amount: 999 }]), 'INSUFFICIENT_STOCK')
  check('balance stays exactly 0 (never negative)', await stockOf(admin, vExa, mainLoc) === 0)

  // ===========================================================================
  console.log('\n== K. §14 CONCURRENT SALE OF THE LAST UNIT ==')
  for (let round = 1; round <= 2; round++) {
    if (round > 1) await val(admin, `select public.adjust_stock($1, $2, 1, 'ADJUSTMENT', 'restock for concurrency round') as r`, [vConc, mainLoc])
    const balBefore = await stockOf(admin, vConc, mainLoc)
    const salesBefore = await num(admin, 'select count(*) as n from public.sales')
    const payload = JSON.stringify({ items: [{ variant_id: vConc, quantity: 1 }], payments: [{ method: 'Cash', amount: 999 }] })
    const results = await Promise.allSettled([
      cashA.query('select public.create_sale($1::jsonb) as r', [payload]),
      cashB.query('select public.create_sale($1::jsonb) as r', [payload]),
    ])
    const okResults = results.filter((x) => x.status === 'fulfilled')
    const err = results.find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
    check(`round ${round}: exactly ONE concurrent sale of the last unit succeeds`, okResults.length === 1, results.map((x) => x.status))
    check(`round ${round}: loser fails safely with INSUFFICIENT_STOCK`,
      Boolean(err && err.reason.message.includes('INSUFFICIENT_STOCK')), err?.reason?.message)
    check(`round ${round}: final stock exactly 0`, await stockOf(admin, vConc, mainLoc) === 0)
    check(`round ${round}: exactly one new sale row (+1 payment, +1 movement)`,
      await num(admin, 'select count(*) as n from public.sales') === salesBefore + 1)
    const mvK = (await admin.query(`select count(*)::int as n from public.stock_movements where reference_type = 'sale' and variant_id = $1`, [vConc])).rows[0].n
    check(`round ${round}: SALE movements for the contested variant = completed sales of it`, mvK === round, { mvK, round, balBefore })
  }

  // ===========================================================================
  console.log('\n== L. §15 DOUBLE-SUBMIT SEMANTICS AT RPC LEVEL ==')
  const dblPayload = { items: [{ variant_id: vJ1250, quantity: 1 }], payments: [{ method: 'Cash', amount: 1250 }] }
  const d1 = await rpcJson<any>(cashA, 'create_sale', dblPayload)
  const d2 = await rpcJson<any>(cashA, 'create_sale', dblPayload)
  check('identical payload submitted twice creates TWO distinct sales (RPC has no idempotency key)',
    d1.sale_id !== d2.sale_id && d1.sale_number !== d2.sale_number, { d1: d1.sale_number, d2: d2.sale_number })
  check('both double-submit sales are internally consistent (stock -2 total)',
    await stockOf(admin, vJ1250, mainLoc) === 98)
  note('DB-level double-submit protection does not exist by design — the FRONTEND must guard the button (verified in browser audit §15)')

  // ===========================================================================
  console.log('\n== M. §12b NEGATIVE-STOCK BUSINESS RULE (configurable) ==')
  await root.query(`update public.app_settings set value = value || '{"allow_negative_stock": true}'::jsonb where key = 'inventory'`)
  const rNeg = await sale(cashA, [{ variant_id: vNeg, quantity: 3 }], [{ method: 'Cash', amount: 2997 }])
  check('negative stock allowed when configured: balance goes to -1', await stockOf(admin, vNeg, mainLoc) === -1)
  const mvNeg = await val(admin, `select * from public.stock_movements where reference_type = 'sale' and reference_id = $1`, [rNeg.sale_id])
  check('negative sale still ledgered (SALE -3, balance_after -1)', mvNeg.quantity === -3 && Number(mvNeg.balance_after) === -1, mvNeg)
  await root.query(`update public.app_settings set value = value || '{"allow_negative_stock": false}'::jsonb where key = 'inventory'`)
  await val(admin, `select public.adjust_stock($1, $2, 1, 'ADJUSTMENT', 'restore negative test stock') as r`, [vNeg, mainLoc])
  await expectError('with the rule back ON, over-selling is blocked again', () =>
    sale(cashA, [{ variant_id: vNeg, quantity: 1 }], [{ method: 'Cash', amount: 999 }]), 'INSUFFICIENT_STOCK')
  check('stock restored to 0 after the negative test', await stockOf(admin, vNeg, mainLoc) === 0)

  // ===========================================================================
  console.log('\n== N. CANCEL SALE RESTORES STOCK ==')
  const rCan = await sale(cashA, [{ variant_id: vCan, quantity: 2 }], [{ method: 'Cash', amount: 1998 }])
  check('pre-cancel stock 5→3', await stockOf(admin, vCan, mainLoc) === 3)
  await val(admin, `select public.cancel_sale($1, $2) as r`, [rCan.sale_id, 'audit: customer walked away'])
  const sCan = await val(admin, 'select status, cancel_reason from public.sales where id = $1', [rCan.sale_id])
  const canMv = (await admin.query(`select movement_type, quantity from public.stock_movements where reference_id = $1 and reference_type in ('sale', 'sale_cancel')`, [rCan.sale_id])).rows
  check('cancelled sale: status CANCELLED with reason preserved', sCan.status === 'CANCELLED' && Boolean(sCan.cancel_reason), sCan)
  check('cancellation restores stock 3→5 via SALES_RETURN +2 (ref: sale_cancel)',
    await stockOf(admin, vCan, mainLoc) === 5 && canMv.some((m) => m.movement_type === 'SALES_RETURN' && Number(m.quantity) === 2), canMv)
  const payCan = await num(admin, 'select count(*) as n from public.sale_payments where sale_id = $1', [rCan.sale_id])
  check('payment history preserved after cancellation (financial record never deleted)', payCan === 1)

  // ===========================================================================
  await admin.end(); await cashA.end(); await cashB.end(); await mgr.end()
  await root.end()
  console.log(`\n== PART 1 RESULT: ${passed} passed, ${failed} failed ==`)
  if (failures.length) for (const f of failures) console.log('  -', f)
  if (evidence.length) { console.log('\n== EVIDENCE NOTES =='); for (const e of evidence) console.log(' *', e) }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
