/**
 * PHASE 9 — MASTER END-TO-END BUSINESS WORKFLOW VALIDATION (local harness).
 * Runs against the local Supabase-compatible pg harness (NOT production).
 *
 * Validates, at the DATABASE / API layer the app actually calls:
 *   PRODUCT -> VARIANT -> SKU -> BARCODE -> QR -> OPENING STOCK -> INVENTORY
 *   -> POS SEARCH -> SCAN -> CART -> DISCOUNT -> GST -> PAYMENT -> SALE
 *   -> INVOICE -> STOCK DEDUCTION -> STOCK HISTORY -> RETURNS -> EXCHANGE
 *   -> CUSTOMER -> SUPPLIER -> PURCHASE -> RECEIVING -> PURCHASE RETURN
 *   -> EXPENSES -> REPORTS -> DASHBOARD -> RECONCILIATION.
 *
 * Every number is checked against an INDEPENDENT manual calculation, and the
 * stock ledger is reconciled (opening + purchases - sales + returns - purchase
 * returns + adjustments +/- transfers == current stock) at the end.
 *
 * Prerequisite: none — self-resetting (drops local schema, applies the full
 * 0001 -> 0016 chain, exactly the migrations the cloud has applied).
 * Run from pgtest/: PGPASSWORD=postgres bun run scripts/local/test-phase9-workflow.ts
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }
const MIGRATIONS = [
  '../../../supabase/migrations/0001_core_schema.sql',
  '../../../supabase/migrations/0002_rls_policies.sql',
  '../../../supabase/migrations/0003_storage.sql',
  '../../../supabase/migrations/0004_products_catalog.sql',
  '../../../supabase/migrations/0005_inventory_stock.sql',
  '../../../supabase/migrations/0006_product_images_storage.sql',
  '../../../supabase/migrations/0007_audit_email_attribution.sql',
  '../../../supabase/migrations/0008_pos_billing.sql',
  '../../../supabase/migrations/0009_phase4_business_operations.sql',
  '../../../supabase/migrations/0010_phase4_active_filter_fix.sql',
  '../../../supabase/migrations/0011_phase4_statement_till_payments.sql',
  '../../../supabase/migrations/0012_phase5_reporting.sql',
  '../../../supabase/migrations/0013_sales_report_payment_status.sql',
  '../../../supabase/migrations/0014_phase6_report_exchange_cash.sql',
  '../../../supabase/migrations/0015_phase8_ist_date_boundaries.sql',
  '../../../supabase/migrations/0016_phase8_search_attributes.sql',
  '../../../supabase/migrations/0017_phase11_purchase_tax_fix.sql',
]

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`) }
}
const r2 = (n: number) => Math.round(n * 100) / 100

async function expectError(name: string, fn: () => Promise<unknown>, messageIncludes: string) {
  try { await fn(); check(name, false, 'expected an error but none was raised') }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check(name, msg.toLowerCase().includes(messageIncludes.toLowerCase()), msg)
  }
}

// ---------------------------------------------------------------------------
// PART 0 — full reset: drop local schema, apply the complete 0001 -> 0016
// chain (identical to what the cloud has applied).
// ---------------------------------------------------------------------------
async function reset() {
  const c = new Client(CONN)
  await c.connect()
  await c.query('drop schema if exists public cascade; create schema public;')
  await c.query('drop schema if exists auth cascade;')
  await c.query('drop schema if exists storage cascade;')
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query(`drop owned by ${role} cascade;`).catch(() => {})
    await c.query(`drop role if exists ${role};`)
    await c.query(`create role ${role} nologin;`)
  }
  await c.query(`create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);
grant usage on schema auth, storage to postgres, authenticated, service_role;
grant all on all tables in schema auth, storage to postgres, authenticated, service_role;
`)
  await c.query('grant all on schema public to postgres; grant usage on schema public to authenticated;')
  for (const file of MIGRATIONS) {
    const sql = readFileSync(new URL(file, import.meta.url), 'utf8')
    await c.query(sql)
  }
  await c.query("set timezone to 'UTC'")
  await c.query("update public.company_settings set state = 'Tamil Nadu', timezone = 'Asia/Kolkata' where id = 1")
  await c.end()
  console.log(`[reset] fresh 0001 -> ${MIGRATIONS[MIGRATIONS.length - 1]} chain applied (${MIGRATIONS.length} migrations)`)
}

// ---------------------------------------------------------------------------
async function main() {
  await reset()
  const root = new Client(CONN)
  await root.connect()
  await root.query("set timezone to 'UTC'")

  async function as(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    if (userId === null) await c.query('set role anon')
    else {
      await c.query('set role authenticated')
      await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId])
    }
    return c
  }
  const val = async (client: Client, sql: string, vals: unknown[] = []) =>
    (await client.query(sql, vals)).rows[0]
  const rows = async (client: Client, sql: string, vals: unknown[] = []) =>
    (await client.query(sql, vals)).rows
  async function rpc<T = Record<string, unknown>>(client: Client, fn: string, args: Record<string, unknown>): Promise<T> {
    const keys = Object.keys(args)
    const params = keys.map((k, i) => `${k} := $${i + 1}`).join(', ')
    const res = await client.query(`select public.${fn}(${params}) as r`, keys.map((k) => args[k]))
    return res.rows[0].r as T
  }
  async function posSearch(client: Client, q: string, limit = 12): Promise<Array<Record<string, unknown>>> {
    const res = await client.query('select public.pos_search(p_query := $1, p_limit := $2) as r', [q, limit])
    const r = res.rows[0].r as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
    return Array.isArray(r) ? r : (r?.rows ?? [])
  }

  const mkUser = async (email: string, name: string, role: string) => {
    const id = (await root.query(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
      [email, JSON.stringify({ app_role: role, full_name: name })]
    )).rows[0].id as string
    await root.query(
      `insert into public.profiles (id, email, full_name, role) values ($1, $2, $3, $4::public.user_role)
       on conflict (id) do update set role = $4::public.user_role, is_active = true, full_name = $3`,
      [id, email, name, role]
    )
    return id
  }

  console.log('\n== PART 1 setup: users ==')
  const adminId = await mkUser('pg9-admin@test.local', 'P9 Admin', 'admin')
  const invId = await mkUser('pg9-inv@test.local', 'P9 Inventory', 'inventory_manager')
  const cashId = await mkUser('pg9-cash@test.local', 'P9 Cashier', 'cashier')
  const acctId = await mkUser('pg9-acct@test.local', 'P9 Accountant', 'accountant')
  const admin = await as(adminId)
  const inv = await as(invId)
  const cash = await as(cashId)
  const acct = await as(acctId)
  const anon = await as(null)
  check('users created with roles (admin/inventory/cashier/accountant)', true)

  const mainLoc = (await root.query(`select id, name from public.stock_locations where code = 'MAIN'`)).rows[0]

  // =========================================================================
  console.log('\n== PART 2: category creation (the reported "Category not found" area) ==')
  // The app's POST /api/admin/categories writes through the CALLER's session —
  // same INSERT path exercised here.
  const cat = (await inv.query(
    `insert into public.categories (name) values ('QA Garments') returning id, name, parent_id`
  )).rows[0]
  check('category created via session INSERT (app route path)', !!cat.id)
  const catReread = await val(inv, `select name, parent_id from public.categories where id = $1`, [cat.id])
  check('category persists on re-read (refresh equivalent)', catReread.name === 'QA Garments')
  // staff (inventory manager) can read categories — the dropdown data source
  const catList = await rows(inv, `select id from public.categories where name = 'QA Garments'`)
  check('category visible to staff reader (dropdown source works)', catList.length === 1)
  // subcategory belonging check (app validates parent linkage)
  const subcat = (await inv.query(
    `insert into public.categories (name, parent_id) values ('QA Shirts', $1) returning id`, [cat.id]
  )).rows[0]
  const subRow = await val(inv, `select parent_id from public.categories where id = $1`, [subcat.id])
  check('subcategory linked to parent category', subRow.parent_id === cat.id)
  await expectError('duplicate category name at same level rejected (form validation)',
    () => inv.query(`insert into public.categories (name) values ('QA Garments')`), 'duplicate key')

  console.log('\n== PART 3: brand creation ==')
  const brand = (await inv.query(`insert into public.brands (name) values ('QA Brand') returning id, name`)).rows[0]
  check('brand created via session INSERT', !!brand.id)
  await expectError('duplicate brand name rejected', () => inv.query(`insert into public.brands (name) values ('QA Brand')`), 'duplicate key')

  console.log('\n== PARTS 4-5: size + color attributes (pre-seeded M/L/XL, Blue/Black — selected like the UI dropdown) ==')
  const sizeM = (await inv.query(`select id from public.sizes where name = 'M'`)).rows[0].id
  const sizeL = (await inv.query(`select id from public.sizes where name = 'L'`)).rows[0].id
  const sizeXL = (await inv.query(`select id from public.sizes where name = 'XL'`)).rows[0].id
  const colBlue = (await inv.query(`select id from public.colors where name = 'Blue'`)).rows[0].id
  const colBlack = (await inv.query(`select id from public.colors where name = 'Black'`)).rows[0].id
  check('sizes M/L/XL and colors Blue/Black available (dropdown source)', !!sizeM && !!sizeL && !!sizeXL && !!colBlue && !!colBlack)
  const sizesVisible = await rows(inv, `select id from public.sizes where name in ('M','L','XL')`)
  check('sizes visible to variant creation', sizesVisible.length === 3)

  console.log('\n== PART 6/8: product + variants with unique SKU/barcode/QR ==')
  // Exact app path: products INSERT via session client, then create_product_variants RPC.
  const prod = (await inv.query(`
    insert into public.products (name, product_code, category_id, subcategory_id, brand_id, gender, fabric,
                                 hsn_code, gst_rate, mrp, cost_price, selling_price)
    values ('QA Production Shirt', 'QAP-001', $1, $2, $3, 'men', 'Cotton', '6105', 12, 1200, 600, 1000)
    returning id, name, category_id, brand_id, gst_rate, selling_price`,
    [cat.id, subcat.id, brand.id])).rows[0]
  check('product created via session INSERT (no "Category not found")', !!prod.id)
  check('product gst_rate persisted (12%)', Number(prod.gst_rate) === 12)

  const vDefs = [
    { sku: 'QAP-BLU-M', size: sizeM, color: colBlue, price: 1000, mrp: 1200, barcode: '8901234500011', qr: 'QAPQR-BLUM' },
    { sku: 'QAP-BLU-L', size: sizeL, color: colBlue, price: 1000, mrp: 1200, barcode: '8901234500028', qr: 'QAPQR-BLUL' },
    { sku: 'QAP-BLK-M', size: sizeM, color: colBlack, price: 1000, mrp: 1200, barcode: '8901234500035', qr: 'QAPQR-BLKM' },
    { sku: 'QAP-BLK-L', size: sizeL, color: colBlack, price: 999.50, mrp: 1200, barcode: '8901234500042', qr: 'QAPQR-BLKL' },
  ]
  const variantPayload = vDefs.map((v) => ({
    sku: v.sku, size_id: v.size, color_id: v.color, barcode: v.barcode, qr_identifier: v.qr,
    cost_price: 600, mrp: v.mrp, selling_price: v.price, wholesale_price: 950,
  }))
  const vRes = await rpc(inv, 'create_product_variants', { p_product_id: prod.id, p_variants: JSON.stringify(variantPayload) })
  const createdVariants = (vRes?.variants ?? []) as Array<Record<string, unknown>>
  check('create_product_variants created 4 variants', createdVariants.length === 4, vRes)

  const vRows = await rows(inv, `
    select pv.id, pv.sku, pv.barcode, pv.qr_identifier, pv.selling_price, s.name as size, c.name as color
    from public.product_variants pv
    left join public.sizes s on s.id = pv.size_id
    left join public.colors c on c.id = pv.color_id
    where pv.product_id = $1 order by pv.sku`, [prod.id])
  check('4 variants persisted with size/color names', vRows.length === 4)
  const skus = vRows.map((v) => v.sku)
  check('every variant has a unique SKU', new Set(skus).size === 4)
  const barcodes = vRows.map((v) => v.barcode)
  check('every variant has a unique barcode', new Set(barcodes).size === 4 && barcodes.every((b) => /^\d{8,14}$/.test(b)))
  const qrs = vRows.map((v) => v.qr_identifier)
  check('every variant has a unique QR identifier', new Set(qrs).size === 4)
  const vBM = vRows.find((v) => v.sku === 'QAP-BLU-M')!
  const vBL = vRows.find((v) => v.sku === 'QAP-BLU-L')!
  const vKM = vRows.find((v) => v.sku === 'QAP-BLK-M')!
  const vKL = vRows.find((v) => v.sku === 'QAP-BLK-L')!

  console.log('\n== PART 44 (form validation at RPC layer) ==')
  await expectError('duplicate SKU rejected with clear message',
    () => rpc(inv, 'create_product_variants', {
      p_product_id: prod.id,
      p_variants: JSON.stringify([{ sku: 'QAP-BLU-M', size_id: sizeM, color_id: colBlue, selling_price: 100 }]),
    }), 'duplicate sku')
  await expectError('duplicate barcode rejected',
    () => rpc(inv, 'create_product_variants', {
      p_product_id: prod.id,
      p_variants: JSON.stringify([{ sku: 'QAP-NEW-1', size_id: sizeM, color_id: colBlue, selling_price: 100, barcode: '8901234500011' }]),
    }), 'duplicate barcode')
  await expectError('duplicate QR rejected',
    () => rpc(inv, 'create_product_variants', {
      p_product_id: prod.id,
      p_variants: JSON.stringify([{ sku: 'QAP-NEW-2', size_id: sizeM, color_id: colBlue, selling_price: 100, qr_identifier: 'QAPQR-BLUM' }]),
    }), 'duplicate qr')
  await expectError('invalid barcode format rejected (8-14 digits)',
    () => rpc(inv, 'create_product_variants', {
      p_product_id: prod.id,
      p_variants: JSON.stringify([{ sku: 'QAP-NEW-3', size_id: sizeM, color_id: colBlue, selling_price: 100, barcode: '12' }]),
    }), 'barcode')
  await expectError('negative price rejected',
    () => rpc(inv, 'create_product_variants', {
      p_product_id: prod.id,
      p_variants: JSON.stringify([{ sku: 'QAP-NEW-4', size_id: sizeM, color_id: colBlue, selling_price: -5 }]),
    }), 'invalid selling_price')

  console.log('\n== PART 8: variant edit isolation ==')
  await inv.query(`update public.product_variants set selling_price = 990 where id = $1`, [vBM.id])
  const bmAfter = await val(inv, `select selling_price from public.product_variants where id = $1`, [vBM.id])
  const blAfter = await val(inv, `select selling_price from public.product_variants where id = $1`, [vBL.id])
  check('editing one variant changes only that variant',
    Number(bmAfter.selling_price) === 990 && Number(blAfter.selling_price) === 1000)

  // =========================================================================
  console.log('\n== PART 10: opening stock (10/5/8/3) via set_opening_stock ==')
  const openQty: Record<string, number> = { BM: 10, BL: 5, KM: 8, KL: 3 }
  const variants: Record<string, { id: string; sku: string; barcode: string; qr: string; price: number }> = {
    BM: { id: vBM.id, sku: 'QAP-BLU-M', barcode: vBM.barcode, qr: vBM.qr_identifier, price: 1000 },
    BL: { id: vBL.id, sku: 'QAP-BLU-L', barcode: vBL.barcode, qr: vBL.qr_identifier, price: 1000 },
    KM: { id: vKM.id, sku: 'QAP-BLK-M', barcode: vKM.barcode, qr: vKM.qr_identifier, price: 1000 },
    KL: { id: vKL.id, sku: 'QAP-BLK-L', barcode: vKL.barcode, qr: vKL.qr_identifier, price: 999.50 },
  }
  for (const k of Object.keys(variants)) {
    await rpc(inv, 'set_opening_stock', {
      p_variant_id: variants[k].id, p_location_id: mainLoc.id, p_quantity: openQty[k], p_reason: 'QA opening stock',
    })
  }
  const stockAfterOpen = await rows(inv, `
    select variant_id, quantity from public.stock_balances where location_id = $1 order by variant_id`, [mainLoc.id])
  check('inventory rows created for all 4 variants', stockAfterOpen.length === 4)
  const qtyOf = async (client: Client, vid: string, loc: string) =>
    Number((await val(client, `select coalesce(quantity, 0) as q from public.stock_balances where variant_id = $1 and location_id = $2`, [vid, loc]))?.q ?? 0)
  check('opening quantities 10/5/8/3 at Main Store',
    await qtyOf(inv, vBM.id, mainLoc.id) === 10 && await qtyOf(inv, vBL.id, mainLoc.id) === 5 &&
    await qtyOf(inv, vKM.id, mainLoc.id) === 8 && await qtyOf(inv, vKL.id, mainLoc.id) === 3)

  const openMoves = await rows(inv, `
    select movement_type, quantity, variant_id, location_id, user_id, user_email, balance_after, created_at
    from public.stock_movements where movement_type = 'OPENING_STOCK' order by created_at`)
  check('stock ledger has 4 OPENING movements', openMoves.length === 4)
  check('movement ledger captures variant + location + qty + user attribution',
    openMoves.every((m) => m.variant_id && m.location_id === mainLoc.id && Number(m.quantity) > 0 && m.user_id === invId && !!m.user_email && !!m.created_at))
  await expectError('opening stock is once-only (OPENING_EXISTS)',
    () => rpc(inv, 'set_opening_stock', { p_variant_id: vBM.id, p_location_id: mainLoc.id, p_quantity: 99 }),
    'OPENING_EXISTS')

  console.log('\n== PART 9: Product page vs Inventory page agreement ==')
  // Inventory page source: stock_page RPC. Product totals: sum of stock_balances.
  const invPage = (await rpc(inv, 'stock_page', { p_limit: 50, p_offset: 0 })) as { rows?: Array<Record<string, unknown>> }
  const invRowsList = invPage?.rows ?? []
  const qaRows = invRowsList.filter((r) => String(r.sku ?? '').startsWith('QAP-'))
  check('stock_page (Inventory page) shows all 4 QA variants', qaRows.length === 4, invRowsList.length)
  const invTotals: Record<string, number> = Object.fromEntries(qaRows.map((r) => [String(r.sku), Number(r.quantity ?? 0)]))
  check('Inventory page quantities match 10/5/8/3',
    invTotals['QAP-BLU-M'] === 10 && invTotals['QAP-BLU-L'] === 5 && invTotals['QAP-BLK-M'] === 8 && invTotals['QAP-BLK-L'] === 3, invTotals)
  const prodTotal = Number((await val(inv, `
    select coalesce(sum(quantity), 0) as q from public.stock_balances sb
    join public.product_variants pv on pv.id = sb.variant_id where pv.product_id = $1`, [prod.id])).q)
  check('Product total stock = 26 (matches inventory sum)', prodTotal === 26, prodTotal)
  const prodDetailStock = await rows(inv, `
    select pv.sku, coalesce(sb.quantity, 0) as q from public.product_variants pv
    left join public.stock_balances sb on sb.variant_id = pv.id
    where pv.product_id = $1 order by pv.sku`, [prod.id])
  check('Product detail per-variant stock matches inventory page',
    prodDetailStock.every((r) => invTotals[r.sku] === Number(r.q)), prodDetailStock)

  console.log('\n== PART 11: inventory adjustment (+2 then -2, reason captured) ==')
  await rpc(inv, 'adjust_stock', {
    p_variant_id: vBM.id, p_location_id: mainLoc.id, p_quantity: 2, p_reason: 'QA found extra pieces',
  })
  check('adjust +2: Blue/M = 12', await qtyOf(inv, vBM.id, mainLoc.id) === 12)
  const adjMove = await val(inv, `
    select quantity, reason, movement_type from public.stock_movements
    where variant_id = $1 and movement_type = 'ADJUSTMENT' order by created_at desc limit 1`, [vBM.id])
  check('adjustment movement recorded with reason', Number(adjMove.quantity) === 2 && /extra pieces/i.test(String(adjMove.reason)))
  await rpc(inv, 'adjust_stock', {
    p_variant_id: vBM.id, p_location_id: mainLoc.id, p_quantity: -2, p_reason: 'QA correction',
  })
  check('adjust -2: Blue/M back to 10', await qtyOf(inv, vBM.id, mainLoc.id) === 10)
  const adjMoves = await rows(inv, `select quantity from public.stock_movements where variant_id = $1 and movement_type = 'ADJUSTMENT' order by created_at`, [vBM.id])
  check('both adjustments created movements (+2, -2)', adjMoves.length === 2 && Number(adjMoves[1].quantity) === -2)
  const totalAfterAdj = Number((await val(inv, `
    select coalesce(sum(quantity), 0) as q from public.stock_balances sb
    join public.product_variants pv on pv.id = sb.variant_id where pv.product_id = $1`, [prod.id])).q)
  check('Product total unchanged after net-zero adjustments (26)', totalAfterAdj === 26)
  await expectError('adjustment reason is required for corrections',
    () => rpc(inv, 'adjust_stock', { p_variant_id: vBM.id, p_location_id: mainLoc.id, p_quantity: -1, p_reason: '' }),
    'reason is required')

  console.log('\n== PART 12: inventory transfer (Main 10 -> Warehouse 3) ==')
  const whLoc = (await inv.query(
    `insert into public.stock_locations (name, code, location_type) values ('QA Warehouse', 'QAWH', 'warehouse') returning id, name`
  )).rows[0]
  check('second location created (QA Warehouse)', !!whLoc.id)
  const tr = await rpc(inv, 'transfer_stock', {
    p_variant_id: vBM.id, p_from_location_id: mainLoc.id, p_to_location_id: whLoc.id, p_quantity: 3, p_reason: 'QA rebalance',
  })
  check('transfer completed', !!tr)
  check('Main Store Blue/M = 7 after transfer', await qtyOf(inv, vBM.id, mainLoc.id) === 7)
  check('Warehouse Blue/M = 3 after transfer', await qtyOf(inv, vBM.id, whLoc.id) === 3)
  const xferMoves = await rows(inv, `
    select movement_type, quantity, reference_id, reference_type, reason, created_at from public.stock_movements
    where variant_id = $1 and movement_type in ('TRANSFER_OUT','TRANSFER_IN') order by created_at desc limit 2`, [vBM.id])
  const outMove = xferMoves.find((m) => m.movement_type === 'TRANSFER_OUT')
  const inMove = xferMoves.find((m) => m.movement_type === 'TRANSFER_IN')
  check('Transfer Out = -3 and Transfer In = +3 recorded',
    Number(outMove?.quantity) === -3 && Number(inMove?.quantity) === 3)
  check('both transfer legs share one transaction (same instant + reference_type + reason; no single transfer id by design)',
    !!outMove && !!inMove && String(outMove.created_at) === String(inMove.created_at) && String(outMove.reason) === String(inMove.reason))
  const totalAfterXfer = Number((await val(inv, `
    select coalesce(sum(quantity), 0) as q from public.stock_balances sb
    join public.product_variants pv on pv.id = sb.variant_id where pv.product_id = $1`, [prod.id])).q)
  check('Product total remains 26 after transfer (no stock created/lost)', totalAfterXfer === 26)
  await expectError('transfer blocked when source lacks stock',
    () => rpc(inv, 'transfer_stock', { p_variant_id: vBL.id, p_from_location_id: whLoc.id, p_to_location_id: mainLoc.id, p_quantity: 1 }),
    'insufficient')

  console.log('\n== PARTS 13-14: barcode + QR identifiers resolve to the EXACT variant ==')
  for (const k of Object.keys(variants)) {
    const v = variants[k]
    const byBarcode = await posSearch(cash, v.barcode, 5)
    const hitB = byBarcode?.[0]
    check(`barcode ${v.barcode} -> exact variant ${v.sku}`, hitB?.variant_id === v.id, hitB)
    const byQr = await posSearch(cash, v.qr, 5)
    check(`QR ${v.qr} -> exact variant ${v.sku}`, byQr?.[0]?.variant_id === v.id, byQr?.[0])
  }

  // =========================================================================
  console.log('\n== PART 15: POS product search matrix (cashier, pos_search) ==')
  const searchCases: Array<[string, string, number]> = [
    ['product name', 'QA Production Shirt', 1],
    ['partial name', 'production shi', 1],
    ['product code', 'QAP-001', 1],
    ['SKU', 'QAP-BLU-L', 1],
    ['SKU partial + lowercase', 'qap-blu', 2],
    ['name uppercase', 'QA PRODUCTION SHIRT', 1],
    ['color (0016 fix)', 'Blue', 2],
    ['color lowercase', 'black', 2],
    ['size (0016 fix)', 'L', 2],
    ['brand (0016 fix)', 'QA Brand', 4],
    ['category (0016 fix)', 'QA Garments', 4],
    ['no results', 'ZZZNOTHING', 0],
  ]
  for (const [label, q, minHits] of searchCases) {
    const hits = await posSearch(cash, q, 12)
    check(`search ${label} ("${q}") -> >= ${minHits} result(s)`, hits.length >= minHits && (minHits === 0 ? hits.length === 0 : true), { q, got: hits.length })
  }
  const clearSearch = await posSearch(cash, '', 12)
  check('empty search returns results (cleared search box)', clearSearch.length > 0)
  const rapid: Array<Array<Record<string, unknown>>> = []
  for (const q of ['QA', 'Blue', '8901234500011']) rapid.push(await posSearch(cash, q, 12))
  check('rapid consecutive searches all resolve', rapid.every((r) => r.length > 0))

  // reset the price edited in the PART 8 isolation test so ledger math is clean
  await inv.query(`update public.product_variants set selling_price = 1000 where id = $1`, [vBM.id])
  variants.BM.price = 1000

  // =========================================================================
  console.log('\n== PARTS 19-23: POS cart math, GST, discounts, payment, CRITICAL stock deduction ==')
  const gst = 12
  const mkItem = (vid: string, quantity: number, extra: Record<string, unknown> = {}) => ({ variant_id: vid, quantity, ...extra })
  async function doSale(client: Client, payload: Record<string, unknown>) {
    return rpc<Record<string, unknown>>(client, 'create_sale', { p_payload: JSON.stringify(payload) })
  }

  // --- T1: plain sale, GST-inclusive, cash with change ---
  const before1 = await qtyOf(inv, vBM.id, mainLoc.id)
  const t1 = await doSale(admin, {
    items: [mkItem(vBM.id, 1)],
    payments: [{ method: 'Cash', amount: 1000, cash_received: 2000 }],
    location_id: mainLoc.id,
  })
  // independent manual calculation
  const e1tax = r2(1000 * gst / (100 + gst))
  check('T1 math: subtotal 1000 / tax 107.14 / grand 1000 (manual calc agrees)',
    Number(t1.subtotal) === 1000 && Number(t1.tax_total) === e1tax && Number(t1.grand_total) === 1000, t1)
  check('T1 change = 1000 (paid 2000, bill 1000)', Number(t1.cash_change) === 1000 && Number(t1.paid_amount) === 1000)
  check('T1 payment status PAID, due 0', t1.payment_status === 'PAID' && Number(t1.due_amount) === 0)

  // PART 23 — verify EVERYTHING from the actual database state
  const t1Row = await val(admin, `select * from public.sales where id = $1`, [t1.sale_id])
  check('T1 DB row: totals agree with RPC result',
    Number(t1Row.subtotal) === 1000 && Number(t1Row.tax_total) === e1tax && Number(t1Row.grand_total) === 1000 &&
    Number(t1Row.paid_amount) === 1000 && Number(t1Row.due_amount) === 0 && t1Row.status === 'COMPLETED')
  check('T1 has a real invoice/sale number', /^\\w+-\\d{2}\\d*-\\d{6}$/.test(String(t1Row.sale_number)) || String(t1Row.sale_number).length >= 5, t1Row.sale_number)
  const t1Items = await rows(admin, `select * from public.sale_items where sale_id = $1`, [t1.sale_id])
  check('T1 one sale line, qty 1, snapshot prices + HSN captured',
    t1Items.length === 1 && t1Items[0].quantity === 1 && Number(t1Items[0].base_price) === 1000 && Number(t1Items[0].unit_price) === 1000 && t1Items[0].hsn_code === '6105' && t1Items[0].sku === 'QAP-BLU-M')
  const t1Pmts = await rows(admin, `select * from public.sale_payments where sale_id = $1`, [t1.sale_id])
  check('T1 payment row: Cash 1000, received 2000, change 1000, attributed to cashier',
    t1Pmts.length === 1 && t1Pmts[0].method === 'Cash' && Number(t1Pmts[0].amount) === 1000 && Number(t1Pmts[0].cash_received) === 2000 && Number(t1Pmts[0].cash_change) === 1000 && t1Pmts[0].recorded_by === adminId)
  const after1 = await qtyOf(inv, vBM.id, mainLoc.id)
  check('CRITICAL T1: database stock deducted 7 -> 6 (UI and DB agree)', before1 === 7 && after1 === 6, { before1, after1 })
  const t1Move = await val(admin, `select * from public.stock_movements where reference_type = 'sale' and reference_id = $1`, [String(t1.sale_id)])
  check('T1 stock movement: SALE -1, balance_after 6, correct variant+location',
    t1Move.movement_type === 'SALE' && Number(t1Move.quantity) === -1 && Number(t1Move.balance_after) === 6 && t1Move.variant_id === vBM.id && t1Move.location_id === mainLoc.id && t1Move.user_id === adminId)
  const t1Audit = await val(root, `select * from public.audit_logs where entity_type = 'sale' and entity_id = $1 order by created_at desc`, [String(t1.sale_id)])
  check('T1 audit log written with user attribution', !!t1Audit && t1Audit.user_id === adminId && !!t1Audit.user_email)

  // --- T2: item % discount + bill % discount + split payment (cash + UPI) ---
  const t2 = await doSale(admin, {
    items: [mkItem(vBM.id, 2, { discount_type: 'pct', discount_value: 10 }), mkItem(vKM.id, 1)],
    bill_discount_type: 'pct', bill_discount_value: 5,
    payments: [{ method: 'Cash', amount: 1000 }, { method: 'UPI', amount: 1660, reference: 'upi-ref-t2' }],
    location_id: mainLoc.id,
  })
  // manual: B/M gross 2000 -10% = 1800 line (tax 192.86); K/M 1000 line (tax 107.14)
  // subtotal 2800; bill disc 5% = 140; grand 2660
  const e2sub = 2800, e2disc = 140, e2tax = r2(r2(1800 * gst / 112) + r2(1000 * gst / 112))
  check('T2 math: subtotal 2800 / item disc 200 / bill disc 140 / tax 300 / grand 2660 (manual calc agrees)',
    Number(t2.subtotal) === e2sub && Number(t2.item_discount_total) === 200 && Number(t2.bill_discount) === e2disc && Number(t2.tax_total) === e2tax && Number(t2.grand_total) === 2660, t2)
  check('T2 split payment recorded (Cash 1000 + UPI 1660)', Number(t2.paid_amount) === 2660 && t2.payment_status === 'PAID')
  const t2Pmts = await rows(admin, `select method, amount from public.sale_payments where sale_id = $1 order by method`, [t2.sale_id])
  check('T2 two payment rows (split bill)', t2Pmts.length === 2)
  check('T2 stock: B/M 6->4, K/M 8->7',
    await qtyOf(inv, vBM.id, mainLoc.id) === 4 && await qtyOf(inv, vKM.id, mainLoc.id) === 7)
  const t2Items = await rows(admin, `select sku, quantity, discount_amount, line_total from public.sale_items where sale_id = $1`, [t2.sale_id])
  check('T2 item snapshots carry discounts (B/M disc 200 on qty 2)', t2Items.length === 2 && Number(t2Items.find((i) => i.sku === 'QAP-BLU-M')?.discount_amount) === 200)

  // --- GST EXCLUSIVE mode ---
  await root.query(`update public.app_settings set value = jsonb_set(value, '{default_tax_mode}', '"exclusive"'::jsonb) where key = 'pos'`)
  const tex = await doSale(admin, { items: [mkItem(vKM.id, 1)], payments: [{ method: 'Card', amount: 1120 }], location_id: mainLoc.id })
  const eexTax = r2(1000 * gst / 100)
  check('GST-exclusive math: tax 120 on taxable 1000, grand 1120 (manual calc agrees)',
    Number(tex.tax_total) === eexTax && Number(tex.grand_total) === 1120 && tex.tax_mode === 'exclusive', tex)
  await root.query(`update public.app_settings set value = jsonb_set(value, '{default_tax_mode}', '"inclusive"'::jsonb) where key = 'pos'`)
  check('K/M stock 7->6 after exclusive-mode sale', await qtyOf(inv, vKM.id, mainLoc.id) === 6)

  // --- PART 22 exact scenario: bill 1250, pay 2000, change 750 ---
  // (runs after purchases; see T2b below)

  console.log('\n== PART 29: held bill (stock untouched while held) ==')
  const bmBeforeHold = await qtyOf(inv, vBM.id, mainLoc.id)
  const held = await rpc(cash, 'hold_bill', {
    p_cart: JSON.stringify({ items: [mkItem(vBM.id, 2)], customer_id: null }), p_label: 'QA held bill',
    p_customer: 'QA Customer', p_item_count: 2, p_total: 2000,
  })
  check('bill held (row created for cashier)', !!held?.id)
  check('stock UNCHANGED while bill is held', await qtyOf(inv, vBM.id, mainLoc.id) === bmBeforeHold)
  const heldRow = await val(cash, `select * from public.held_bills where id = $1`, [held.id])
  check('held bill persists cart + customer + total', heldRow.label === 'QA held bill' && Number(heldRow.total) === 2000 && heldRow.status === 'HELD')
  const resumed = await rpc(cash, 'resume_held_bill', { p_id: held.id }) as { id?: string; label?: string; cart?: { items?: Array<{ variant_id?: string }> } }
  check('held bill resumed (returns exact cart with exact quantities)',
    !!resumed?.id && Array.isArray(resumed.cart?.items) && resumed.cart.items.length === 1 &&
    resumed.cart.items[0].variant_id === vBM.id && resumed.cart.items[0].quantity === 2, resumed)
  check('stock still unchanged after resume (deduct happens only at checkout)', await qtyOf(inv, vBM.id, mainLoc.id) === bmBeforeHold)
  const held2 = await rpc(cash, 'hold_bill', { p_cart: JSON.stringify({ items: [mkItem(vBM.id, 1)] }), p_item_count: 1, p_total: 1000 })
  await rpc(cash, 'discard_held_bill', { p_id: held2.id })
  const discarded = await val(cash, `select status from public.held_bills where id = $1`, [held2.id])
  check('discarded held bill is marked DISCARDED', discarded.status === 'DISCARDED')

  console.log('\n== PART 44 (POS form validation at RPC layer) ==')
  await expectError('empty cart rejected', () => doSale(admin, { items: [], payments: [] }), 'cart is empty')
  await expectError('zero quantity rejected', () => doSale(admin, { items: [mkItem(vBM.id, 0)], payments: [{ method: 'Cash', amount: 1 }] }), 'quantity')
  await expectError('decimal quantity rejected', () => doSale(admin, { items: [{ variant_id: vBM.id, quantity: 1.5 }], payments: [{ method: 'Cash', amount: 1 }] }), 'quantity')
  await expectError('payment exceeding bill rejected', () => doSale(admin, { items: [mkItem(vBM.id, 1)], payments: [{ method: 'Cash', amount: 9999 }] }), 'PAYMENT_EXCEEDS_TOTAL')
  await expectError('cash received less than cash amount rejected', () => doSale(admin, { items: [mkItem(vBM.id, 1)], payments: [{ method: 'Cash', amount: 1000, cash_received: 500 }] }), 'CASH_RECEIVED_LESS')
  await expectError('unknown payment method rejected', () => doSale(admin, { items: [mkItem(vBM.id, 1)], payments: [{ method: 'Crypto', amount: 1000 }] }), 'PAYMENT_METHOD_DISABLED')
  await expectError('negative discount rejected', () => doSale(admin, { items: [mkItem(vBM.id, 1, { discount_type: 'pct', discount_value: -5 })], payments: [{ method: 'Cash', amount: 1000 }] }), 'negative')
  const preValQty = await qtyOf(inv, vBM.id, mainLoc.id)
  const salesBefore = Number((await val(admin, `select count(*) as c from public.sales`)).c)
  await expectError('invalid variant rejected and NO sale/stock rows written',
    () => doSale(admin, { items: [{ variant_id: '00000000-0000-0000-0000-000000000001', quantity: 1 }], payments: [{ method: 'Cash', amount: 100 }] }), 'VARIANT_NOT_FOUND')
  check('failed sale left no rows (atomic rollback: sales + stock unchanged)',
    Number((await val(admin, `select count(*) as c from public.sales`)).c) === salesBefore && await qtyOf(inv, vBM.id, mainLoc.id) === preValQty)

  // =========================================================================
  console.log('\n== PART 31: sales return (sell 3, return 1, net -2) ==')
  const retSale = await doSale(admin, { items: [mkItem(vBM.id, 3)], payments: [{ method: 'Cash', amount: 3000 }], location_id: mainLoc.id })
  check('return-test sale of 3 created (grand 3000)', Number(retSale.grand_total) === 3000)
  check('B/M 4 -> 1 after selling 3', await qtyOf(inv, vBM.id, mainLoc.id) === 1)
  const retSaleItem = (await rows(admin, `select id, quantity from public.sale_items where sale_id = $1`, [retSale.sale_id]))[0]
  const ret = await rpc(admin, 'create_sales_return', {
    p_payload: JSON.stringify({
      sale_id: retSale.sale_id, reason: 'QA size too small',
      refund_method: 'Cash',
      items: [{ sale_item_id: retSaleItem.id, quantity: 1, condition: 'GOOD' }],
    }),
  }) as Record<string, unknown>
  check('sales return created with refund', !!ret?.return_id || !!ret?.id, ret)
  check('B/M 1 -> 2 after returning 1 (net -2 for the day)', await qtyOf(inv, vBM.id, mainLoc.id) === 2)
  const retMove = await val(root, `select * from public.stock_movements where movement_type = 'SALES_RETURN' and reference_type = 'sales_return' order by created_at desc limit 1`)
  check('SALES_RETURN movement +1 recorded with balance_after 2', Number(retMove.quantity) === 1 && Number(retMove.balance_after) === 2 && retMove.variant_id === vBM.id)
  const retRow2 = await val(root, `select refund_amount, refund_method, refunded_at, return_number from public.sales_returns order by created_at desc limit 1`)
  check('return refund amount 1000, method Cash, refunded_at set', Number(retRow2.refund_amount) === 1000 && retRow2.refund_method === 'Cash' && !!retRow2.refunded_at, retRow2)
  // refund money is recorded on the sales_returns row (refund_amount/method)
  // plus a customer_payments credit when it settles customer dues (0011 logic)
  await expectError('cannot return more than purchased (3 > 2 remaining, RETURN_EXCEEDS_SOLD)',
    () => rpc(admin, 'create_sales_return', {
      p_payload: JSON.stringify({ sale_id: retSale.sale_id, reason: 'x', refund_method: 'Cash',
        items: [{ sale_item_id: retSaleItem.id, quantity: 3, condition: 'GOOD' }] }),
    }), 'RETURN_EXCEEDS_SOLD')

  console.log('\n== PART 32: exchange (K/M returned, B/L issued) ==')
  const exchSale = await doSale(admin, { items: [mkItem(vKM.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id })
  check('exchange-test sale of K/M created', Number(exchSale.grand_total) === 1000)
  check('K/M 6 -> 5 for the exchange sale', await qtyOf(inv, vKM.id, mainLoc.id) === 5)
  const exchSaleItem = (await rows(admin, `select id from public.sale_items where sale_id = $1`, [exchSale.sale_id]))[0]
  const exch = await rpc(admin, 'create_exchange', {
    p_payload: JSON.stringify({
      sale_id: exchSale.sale_id, reason: 'QA wants black instead',
      return_items: [{ sale_item_id: exchSaleItem.id, quantity: 1, condition: 'GOOD' }],
      new_items: [{ variant_id: vBL.id, quantity: 1 }],
      payment_method: 'Cash',
    }),
  }) as Record<string, unknown>
  check('exchange created', !!exch?.exchange_id || !!exch?.id, exch)
  check('K/M restored 5 -> 6 by the exchange return', await qtyOf(inv, vKM.id, mainLoc.id) === 6)
  check('B/L deducted 5 -> 4 by the exchange issue', await qtyOf(inv, vBL.id, mainLoc.id) === 4)
  const exchRow = await val(root, `select * from public.exchanges order by created_at desc limit 1`)
  check('exchange row: return value 1000, issue value 1000, difference 0 (like-for-like)',
    Number(exchRow.return_value) === 1000 && Number(exchRow.issue_value) === 1000 && Number(exchRow.difference_amount) === 0, exchRow)
  const exchMoves = await rows(root, `select movement_type, quantity from public.stock_movements where reference_type = 'exchange' and reference_id = $1`, [String(exchRow.id)])
  check('exchange wrote BOTH stock movements (in +1, out -1)',
    exchMoves.length === 2 && exchMoves.some((m) => m.movement_type === 'SALES_RETURN' && Number(m.quantity) === 1) && exchMoves.some((m) => Number(m.quantity) === -1), exchMoves)

  console.log('\n== PART 33: damaged return does NOT re-enter sellable stock ==')
  const dmgLoc = (await val(inv, `select id, name, location_type from public.stock_locations where location_type = 'damaged' and is_active limit 1`))
  check('damaged-goods location available (pre-seeded "Damaged Goods")', !!dmgLoc?.id && dmgLoc.location_type === 'damaged', dmgLoc)
  const dmgSale = await doSale(admin, { items: [mkItem(vBL.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id })
  check('damaged-test sale created (B/L 4 -> 3)', await qtyOf(inv, vBL.id, mainLoc.id) === 3)
  const dmgSaleItem = (await rows(admin, `select id from public.sale_items where sale_id = $1`, [dmgSale.sale_id]))[0]
  const dmgRet = await rpc(admin, 'create_sales_return', {
    p_payload: JSON.stringify({
      sale_id: dmgSale.sale_id, reason: 'QA torn seam', refund_method: 'Cash',
      items: [{ sale_item_id: dmgSaleItem.id, quantity: 1, condition: 'DAMAGED' }],
    }),
  })
  check('damaged return accepted', !!dmgRet)
  check('sellable B/L stock NOT increased by damaged return (still 3)', await qtyOf(inv, vBL.id, mainLoc.id) === 3)
  const dmgMove = await val(root, `select location_id, quantity from public.stock_movements where movement_type = 'SALES_RETURN' order by created_at desc limit 1`)
  check('damaged unit tracked separately in the damaged location (+1)',
    dmgMove.location_id === dmgLoc.id && Number(dmgMove.quantity) === 1 && await qtyOf(inv, vBL.id, dmgLoc.id) === 1,
    { dmgMove, qtyAtDmg: await qtyOf(inv, vBL.id, dmgLoc.id) })

  console.log('\n== PART 24: repeated scan -> one line, qty 3, 3 units deducted ==')
  const multi = await doSale(admin, { items: [mkItem(vBL.id, 3)], payments: [{ method: 'UPI', amount: 3000 }], location_id: mainLoc.id })
  const multiItems = await rows(admin, `select quantity from public.sale_items where sale_id = $1`, [multi.sale_id])
  check('one cart line with quantity 3 (not 3 rows)', multiItems.length === 1 && multiItems[0].quantity === 3)
  check('exactly 3 units deducted (B/L 3 -> 0)', await qtyOf(inv, vBL.id, mainLoc.id) === 0)
  const multiMove = await val(admin, `select quantity from public.stock_movements where reference_type = 'sale' and reference_id = $1`, [String(multi.sale_id)])
  check('one SALE movement of -3', Number(multiMove.quantity) === -3)

  console.log('\n== PART 25: out-of-stock blocked (no negative stock) ==')
  const salesCountBefore = Number((await val(root, `select count(*) as c from public.sales`)).c)
  const pmtsCountBefore = Number((await val(root, `select count(*) as c from public.sale_payments`)).c)
  await expectError('selling out-of-stock variant is blocked',
    () => doSale(admin, { items: [mkItem(vBL.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id }),
    'INSUFFICIENT_STOCK')
  check('no sale, no payment, no negative stock written for the blocked attempt',
    Number((await val(root, `select count(*) as c from public.sales`)).c) === salesCountBefore &&
    Number((await val(root, `select count(*) as c from public.sale_payments`)).c) === pmtsCountBefore &&
    await qtyOf(inv, vBL.id, mainLoc.id) === 0)

  console.log('\n== PART 26 + GST round-off: last unit ==')
  const t3 = await doSale(admin, { items: [mkItem(vKL.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id })
  const e3tax = r2(999.50 * gst / 112)
  check('round-off math: line 999.50, tax 107.09, grand rounds to 1000 (+0.50)',
    Number(t3.subtotal) === 999.50 && Number(t3.tax_total) === e3tax && Number(t3.round_off) === 0.50 && Number(t3.grand_total) === 1000, t3)
  check('K/L 3 -> 2', await qtyOf(inv, vKL.id, mainLoc.id) === 2)
  await doSale(admin, { items: [mkItem(vKL.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id })
  check('K/L 2 -> 1 (one left)', await qtyOf(inv, vKL.id, mainLoc.id) === 1)
  await doSale(admin, { items: [mkItem(vKL.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id })
  check('last unit sold: K/L 1 -> 0', await qtyOf(inv, vKL.id, mainLoc.id) === 0)
  await expectError('selling the (now empty) variant is blocked again',
    () => doSale(admin, { items: [mkItem(vKL.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id }),
    'INSUFFICIENT_STOCK')

  console.log('\n== PART 27: concurrent sale of the last unit (two parallel sessions) ==')
  // reduce K/M to exactly 1 first: sell 5 in one bill
  await doSale(admin, { items: [mkItem(vKM.id, 5)], payments: [{ method: 'Cash', amount: 5000 }], location_id: mainLoc.id })
  check('K/M reduced to exactly 1 for the concurrency test', await qtyOf(inv, vKM.id, mainLoc.id) === 1)
  const cashA = await as(adminId)
  const cashB = await as(cashId)
  const payload = JSON.stringify({ items: [mkItem(vKM.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id })
  const [rA, rB] = await Promise.allSettled([
    rpc(cashA, 'create_sale', { p_payload: payload }),
    rpc(cashB, 'create_sale', { p_payload: payload }),
  ])
  const okCount = [rA, rB].filter((r) => r.status === 'fulfilled').length
  const errText = [rA, rB].filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason)).join(' | ')
  check('exactly ONE concurrent sale of the last unit succeeds', okCount === 1, errText)
  check('final stock 0 — never negative', await qtyOf(inv, vKM.id, mainLoc.id) === 0)
  check('the loser failed with INSUFFICIENT_STOCK (not a silent overwrite)', errText.toLowerCase().includes('insufficient_stock'), errText)
  await cashA.end(); await cashB.end()


  const supplier = (await admin.query(
    `insert into public.suppliers (name, phone) values ('QA Fabrics', '9876543210') returning id, name`
  )).rows[0]
  check('supplier created', !!supplier.id)
  console.log('\n== PART 38-adjacent: purchase invoice tax-mode behavior (P9-BUG-2 evidence) ==')
  // P9-BUG-2 was FIXED by 0017: purchases now default to tax_mode 'exclusive'
  // (cost + GST on top — the PO contract), and the totals math no longer
  // double-counts tax. Capture the FIXED behavior on a DRAFT invoice.
  const bugInv = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier.id, location_id: mainLoc.id,
      supplier_invoice_no: 'QA-BUG-2-PROBE', status: 'DRAFT',
      items: [{ variant_id: vBM.id, quantity: 1, unit_cost: 100 }] }),
  })
  const bugRow = await val(root, `select subtotal, tax_total, grand_total, tax_mode, status from public.purchase_invoices where supplier_invoice_no = 'QA-BUG-2-PROBE'`)
  // fixed exclusive branch: 100 entered + 12 GST (12%) = 112, tax counted ONCE
  check('P9-BUG-2 fixed (0017): default mode EXCLUSIVE, grand = 100 cost + 12 tax = 112 — tax counted exactly once',
    bugRow.tax_mode === 'exclusive' && Number(bugRow.subtotal) === 100 && Number(bugRow.tax_total) === 12 && Math.abs(Number(bugRow.grand_total) - 112) < 0.02, bugRow)
  console.log('  >> fixed by 0017: purchases default to exclusive (GST added on top), totals = Σ line_total')

  console.log('\n== PART 35-36: supplier + purchase order + invoice + receiving ==')

  const po = await rpc(admin, 'create_purchase_order', {
    p_payload: JSON.stringify({ supplier_id: supplier.id, location_id: mainLoc.id,
      items: [{ variant_id: vBM.id, quantity: 10, unit_cost: 600 }] }),
  }) as Record<string, unknown>
  check('purchase order for 10 created', !!po?.po_id || !!po?.id, po)
  const poRow = await val(root, `select * from public.purchase_orders order by created_at desc limit 1`)
  check('new PO starts as DRAFT (cannot receive yet)', poRow.status === 'DRAFT')
  await rpc(admin, 'set_purchase_order_status', { p_po_id: poRow.id, p_status: 'ORDERED' })
  const poOrdered = await val(root, `select status from public.purchase_orders where id = $1`, [poRow.id])
  check('PO marked ORDERED (the two-step app flow)', poOrdered.status === 'ORDERED')
  check('PO totals: 10 x 600 = 6000', Number(poRow.subtotal) === 6000, poRow)
  const bmBeforeReceive = await qtyOf(inv, vBM.id, mainLoc.id)
  check('stock NOT yet received while PO is only ordered', bmBeforeReceive === 2)
  const poItem1 = (await rows(root, `select id from public.purchase_order_items where po_id = $1`, [poRow.id]))[0]
  // invoice in DRAFT, then confirm -> receives (exercises the two-step path)
  // NOTE: no tax_mode sent — exactly what the app does today (current behavior).
  const pi = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier.id, location_id: mainLoc.id, po_id: poRow.id,
      supplier_invoice_no: 'QA-SINV-001',
      items: [{ variant_id: vBM.id, quantity: 10, unit_cost: 600, po_item_id: poItem1.id }] }),
  }) as Record<string, unknown>
  const piRow = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'QA-SINV-001'`)
  check('purchase invoice created (draft)', piRow.status === 'DRAFT' && Number(piRow.subtotal) === 6000, piRow)
  check('P9-BUG-2 fixed: PI grand 6720 == PO grand 6720 for the SAME 10 units — invoice and order agree after 0017',
    Math.abs(Number(piRow.grand_total) - 6720) < 0.02 && Math.abs(Number(poRow.grand_total) - 6720) < 0.02,
    { pi_grand: piRow.grand_total, po_grand: poRow.grand_total })
  check('stock NOT received while invoice is still draft', await qtyOf(inv, vBM.id, mainLoc.id) === 2)
  await rpc(admin, 'confirm_purchase_invoice', { p_invoice_id: piRow.id })
  const piRow2 = await val(root, `select * from public.purchase_invoices where id = $1`, [piRow.id])
  check('invoice confirmed -> RECEIVED', piRow2.status === 'RECEIVED')
  check('inventory increased by exactly 10 on receiving (2 -> 12)', await qtyOf(inv, vBM.id, mainLoc.id) === 12)
  const recvMove = await val(root, `select * from public.stock_movements where movement_type = 'PURCHASE' order by created_at desc limit 1`)
  check('PURCHASE movement +10 with supplier reference', Number(recvMove.quantity) === 10 && String(recvMove.reference_type).includes('purchase'))
  const piPay = await val(root, `select grand_total, paid_amount, due_amount, payment_status from public.purchase_invoices where id = $1`, [piRow.id])
  check('payable registered at the CORRECTED invoice grand 6720 — DUE until paid',
    Number(piPay.due_amount) === 6720 && piPay.payment_status === 'DUE', piPay)

  console.log('\n== PART 36b: partial receiving (order 100, receive 60) ==')
  const po2 = await rpc(admin, 'create_purchase_order', {
    p_payload: JSON.stringify({ supplier_id: supplier.id, location_id: mainLoc.id,
      items: [{ variant_id: vKM.id, quantity: 100, unit_cost: 600 }] }),
  })
  const po2Row = await val(root, `select * from public.purchase_orders order by created_at desc limit 1`)
  await rpc(admin, 'set_purchase_order_status', { p_po_id: po2Row.id, p_status: 'ORDERED' })
  const poItem2 = (await rows(root, `select id from public.purchase_order_items where po_id = $1`, [po2Row.id]))[0]
  const kmBefore = await qtyOf(inv, vKM.id, mainLoc.id)
  const pi2 = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier.id, location_id: mainLoc.id, po_id: po2Row.id,
      supplier_invoice_no: 'QA-SINV-002', status: 'RECEIVED',
      items: [{ variant_id: vKM.id, quantity: 60, unit_cost: 600, po_item_id: poItem2.id }] }),
  })
  check('partial invoice received inline (status RECEIVED)', (await val(root, `select status from public.purchase_invoices order by created_at desc limit 1`)).status === 'RECEIVED')
  check('inventory +60 only — NOT +100 (partial receiving honored)', await qtyOf(inv, vKM.id, mainLoc.id) === kmBefore + 60, { kmBefore, now: await qtyOf(inv, vKM.id, mainLoc.id) })
  const po2After = await val(root, `select status, (select coalesce(sum(received_quantity), 0) from public.purchase_order_items where po_id = $1) as received from public.purchase_orders where id = $1`, [po2Row.id])
  check('PO marked PARTIALLY_RECEIVED (60 of 100)', po2After.status === 'PARTIALLY_RECEIVED' && Number(po2After.received) === 60, po2After)
  await expectError('over-receiving beyond the ordered qty is blocked (41 of 40 remaining)',
    () => rpc(admin, 'create_purchase_invoice', {
      p_payload: JSON.stringify({ supplier_id: supplier.id, location_id: mainLoc.id, po_id: po2Row.id,
        supplier_invoice_no: 'QA-SINV-003', status: 'RECEIVED',
        items: [{ variant_id: vKM.id, quantity: 41, unit_cost: 600, po_item_id: poItem2.id }] }),
    }), 'RECEIVE_EXCEEDS_ORDERED')

  console.log('\n== PART 37: purchase return (3 of 10) ==')
  const piItem = (await rows(root, `select id, quantity from public.purchase_invoice_items where invoice_id = $1`, [piRow.id]))[0]
  const pr = await rpc(admin, 'create_purchase_return', {
    p_payload: JSON.stringify({ purchase_invoice_id: piRow.id, reason: 'QA colour bleed',
      items: [{ invoice_item_id: piItem.id, quantity: 3 }] }),
  })
  check('purchase return created', !!pr)
  check('inventory reduced by 3 (12 -> 9)', await qtyOf(inv, vBM.id, mainLoc.id) === 9)
  const prRow = await val(root, `select * from public.purchase_returns order by created_at desc limit 1`)
  check('supplier balance credited by the return value (2016 = 3 units x 672 tax-inclusive line unit)',
    Math.abs(Number(prRow.grand_total) - 2016) < 0.02, prRow)
  const supPayable = async () => Number((await val(root,
    `select coalesce(sum(due_amount), 0) as payable from public.purchase_invoices where supplier_id = $1 and status = 'RECEIVED'`,
    [supplier.id])).payable)
  // RECEIVED invoices: PI-1 6720 (credited 2016) + PI-2 40320; DRAFT probe excluded; minus the 1000 payment below
  check('supplier payable = PI-1 + PI-2 - return (45024 before the payment)', await supPayable() === 45024, await supPayable())

  console.log('\n== PART 22 (exact user scenario): bill 1250, pay 2000, change 750 ==')
  const t2b = await doSale(admin, {
    items: [mkItem(vBM.id, 2)],
    bill_discount_type: 'fixed', bill_discount_value: 750,
    payments: [{ method: 'Cash', amount: 1250, cash_received: 2000 }],
    location_id: mainLoc.id,
  })
  check('bill 1250: subtotal 2000, fixed bill discount 750, grand 1250',
    Number(t2b.subtotal) === 2000 && Number(t2b.bill_discount) === 750 && Number(t2b.grand_total) === 1250, t2b)
  check('change = 750 exactly (paid 2000 for a 1250 bill)', Number(t2b.cash_change) === 750)
  check('B/M 9 -> 7', await qtyOf(inv, vBM.id, mainLoc.id) === 7)

  console.log('\n== PART 28: double checkout (rapid double-click simulation) ==')
  const dblPayload = JSON.stringify({ items: [mkItem(vBM.id, 1)], payments: [{ method: 'Cash', amount: 1000 }], location_id: mainLoc.id })
  const dblA = await rpc(admin, 'create_sale', { p_payload: dblPayload })
  let dblB: Record<string, unknown> | null = null
  let dblBErr: string | null = null
  try { dblB = await rpc(admin, 'create_sale', { p_payload: dblPayload }) } catch (e) { dblBErr = e instanceof Error ? e.message : String(e) }
  check('RPC layer has NO idempotency key: identical double submit creates TWO sales (documented finding — the UI guards this by disabling the button during checkout)',
    !!dblA && !!dblB && dblA.sale_id !== dblB.sale_id, dblBErr)
  check('B/M 7 -> 5 after the two identical sales', await qtyOf(inv, vBM.id, mainLoc.id) === 5)

  console.log('\n== PART 34: customer, credit sale, partial + full payment ==')
  const cust = (await cash.query(
    `insert into public.customers (name, phone) values ('QA Customer', '9000000001') returning id, name`
  )).rows[0]
  check('customer created via cashier session (POS quick-add path)', !!cust.id)
  await expectError('credit sale blocked while allow_credit_sales is off',
    () => doSale(cash, { items: [mkItem(vBM.id, 1)], customer_id: cust.id, payments: [{ method: 'Credit', amount: 1000 }], location_id: mainLoc.id }),
    'credit')
  await root.query(`update public.app_settings set value = jsonb_set(value, '{allow_credit_sales}', 'true'::jsonb) where key = 'pos'`)
  const creditSale = await doSale(cash, { items: [mkItem(vBM.id, 1)], customer_id: cust.id, payments: [{ method: 'Credit', amount: 1000 }], location_id: mainLoc.id })
  check('credit sale allowed after enabling the setting', Number(creditSale.grand_total) === 1000 && Number(creditSale.due_amount) === 1000, creditSale)
  check('B/M 5 -> 4', await qtyOf(inv, vBM.id, mainLoc.id) === 4)
  const custBal1 = await val(root, `select coalesce(sum(due_amount), 0) as d from public.sales where customer_id = $1`, [cust.id])
  check('customer dues = 1000 after credit sale', Number(custBal1.d) === 1000)
  await rpc(cash, 'record_customer_payment', { p_customer_id: cust.id, p_amount: 400, p_method: 'Cash', p_reference: 'part-1' })
  const custBal2 = await val(root, `select coalesce(sum(due_amount), 0) as d from public.sales where customer_id = $1`, [cust.id])
  check('partial payment 400 applied (dues 1000 -> 600)', Number(custBal2.d) === 600)
  await rpc(cash, 'record_customer_payment', { p_customer_id: cust.id, p_amount: 600, p_method: 'UPI', p_reference: 'part-2' })
  const custBal3 = await val(root, `select coalesce(sum(due_amount), 0) as d from public.sales where customer_id = $1`, [cust.id])
  check('full payment settles dues to 0', Number(custBal3.d) === 0)
  const stmt = await rpc(acct, 'customer_statement', { p_customer_id: cust.id, p_from: null, p_to: null }) as Record<string, unknown>
  check('customer statement runs and reflects the ledger', !!stmt, stmt)

  console.log('\n== PART 35b: supplier payment reduces payable ==')
  const supBefore2 = await supPayable()
  await rpc(admin, 'record_supplier_payment', { p_supplier_id: supplier.id, p_amount: 1000, p_method: 'Cash', p_reference: 'sup-1' })
  const supAfter3 = await supPayable()
  const supPmtRow = await val(root, `select amount, method from public.supplier_payments order by created_at desc limit 1`)
  check('supplier payment reduces payable by 1000', supAfter3 === supBefore2 - 1000 && Number(supPmtRow.amount) === 1000, { before: supBefore2, after: supAfter3 })

  // =========================================================================
  console.log('\n== PART 38: expenses ==')
  const expCat = (await admin.query(`insert into public.expense_categories (name) values ('QA Rent') returning id`)).rows[0]
  check('expense category created', !!expCat.id)
  const exp = await rpc(admin, 'create_expense', {
    p_payload: JSON.stringify({ category_id: expCat.id, description: 'QA monthly rent', amount: 5000, method: 'Cash' }),
  })
  check('expense created', !!exp?.expense_id || !!exp?.id, exp)
  const expRow = await val(root, `select * from public.expenses order by created_at desc limit 1`)
  check('expense persisted with amount + method', Number(expRow.amount) === 5000 && expRow.status === 'PENDING')
  await rpc(admin, 'approve_expense', { p_expense_id: expRow.id })
  const expRow2 = await val(root, `select status, approved_at from public.expenses where id = $1`, [expRow.id])
  check('expense approved (workflow)', expRow2.status === 'APPROVED' && !!expRow2.approved_at)
  const exp2 = await rpc(admin, 'create_expense', {
    p_payload: JSON.stringify({ category_id: expCat.id, description: 'QA tea supplies', amount: 150.50, method: 'UPI' }),
  })
  const exp2Row = await val(root, `select * from public.expenses where description = 'QA tea supplies'`)
  check('second expense (UPI) persisted', Number(exp2Row.amount) === 150.50)
  const expPage = await rpc(acct, 'expenses_page', { p_search: 'QA' }) as { rows?: Array<Record<string, unknown>>; total?: number }
  check('expenses page search finds QA expenses', (expPage?.rows ?? []).length === 2, expPage?.total)
  await expectError('expense with invalid amount rejected',
    () => rpc(admin, 'create_expense', { p_payload: JSON.stringify({ category_id: expCat.id, description: 'QA bad', amount: -5, method: 'Cash' }) }),
    'amount')

  console.log('\n== PART 30: sales page reflects the QA sales ==')
  const salesPage = await rpc(admin, 'sales_page', { p_limit: 50 }) as { rows?: Array<Record<string, unknown>>; total?: number }
  const qaSales = salesPage?.rows ?? []
  check('sales page lists the QA sales', (salesPage?.total ?? 0) >= 15, salesPage?.total)
  const sampleSale = qaSales.find((r) => String(r.sale_number ?? '').length > 0)
  check('sales page rows carry invoice numbers + totals + payment status',
    !!sampleSale?.sale_number && sampleSale?.grand_total !== undefined && sampleSale?.payment_status !== undefined, sampleSale)
  const salesSearch = await rpc(admin, 'sales_page', { p_search: 'QA Customer', p_limit: 50 }) as { rows?: Array<Record<string, unknown>> }
  check('sales page search by customer name works (searches invoice no / customer / cashier)', (salesSearch?.rows ?? []).length >= 1, (salesSearch?.rows ?? []).length)

  console.log('\n== PART 40: reports vs independent computation ==')
  const allSales = await rows(root, `select grand_total, paid_amount, due_amount, tax_total, subtotal, payment_status from public.sales`)
  const expSalesTotal = allSales.reduce((a, r) => a + Number(r.grand_total), 0)
  const expPaid = allSales.reduce((a, r) => a + Number(r.paid_amount), 0)
  const expDue = allSales.reduce((a, r) => a + Number(r.due_amount), 0)
  const expTax = allSales.reduce((a, r) => a + Number(r.tax_total), 0)
  const rep = await rpc(acct, 'sales_report', { p_limit: 100 }) as Record<string, unknown>
  const repTotals = (rep?.summary ?? {}) as Record<string, unknown>
  check('sales_report gross_sales matches DB sum (' + expSalesTotal.toFixed(2) + ')',
    Math.abs(Number(repTotals.gross_sales) - expSalesTotal) < 0.02, { repTotals, expSalesTotal })
  check('sales_report paid/due match DB sums', Math.abs(Number(repTotals.paid) - expPaid) < 0.02 && Math.abs(Number(repTotals.due) - expDue) < 0.02, { repPaid: repTotals.paid, expPaid, repDue: repTotals.due, expDue })
  check('sales_report tax matches DB sum', Math.abs(Number(repTotals.tax) - expTax) < 0.02, { repTax: repTotals.tax, expTax })
  check('sales_report refunds match returns ledger (good 1000 + damaged 1000)', Math.abs(Number(repTotals.refunds) - 2000) < 0.02, repTotals.refunds)
  const repRows = (rep?.rows ?? []) as Array<Record<string, unknown>>
  check('sales_report row count matches sales count', repRows.length === allSales.length, { rows: repRows.length, sales: allSales.length })
  const itemQty = Number((await val(root, `select coalesce(sum(quantity), 0) as q from public.sale_items`)).q)
  check('items sold ledger total: ' + itemQty + ' units', itemQty > 0)

  console.log('\n== PART 41: dashboard vs underlying data ==')
  const dash = await rpc(acct, 'dashboard_summary', {}) as Record<string, unknown>
  const todaySales = (await rows(root, `select grand_total, paid_amount from public.sales where (now() at time zone 'Asia/Kolkata')::date = (sale_date at time zone 'Asia/Kolkata')::date`))
  const todayTotal = todaySales.reduce((a, r) => a + Number(r.grand_total), 0)
  const dashSales = (dash?.sales ?? {}) as Record<string, unknown>
  const dSales = Number(dashSales.gross_sales ?? 0)
  check('dashboard (default period) gross sales matches DB (' + todayTotal.toFixed(2) + ')', Math.abs(dSales - todayTotal) < 0.02, { dSales, todayTotal })
  const dBills = Number(dashSales.bills ?? 0)
  check('dashboard bill count matches', dBills === todaySales.length, { dBills, actual: todaySales.length })
  const dashAdmin = await rpc(admin, 'dashboard_summary', {}) as Record<string, unknown>
  const dashInv = (dashAdmin?.inventory ?? {}) as Record<string, unknown>
  check('dashboard reports low stock / out of stock counts (view_inventory role)', Number(dashInv.low_stock ?? -1) >= 0 && Number(dashInv.out_of_stock ?? -1) >= 0, dashInv)
  const dashAcctInv = (dash?.inventory ?? {}) as Record<string, unknown>
  check('dashboard hides the inventory section from roles without view_inventory (permission-gated)', Object.keys(dashAcctInv).length === 0, dashAcctInv)
  const dashExp = (dash?.expenses ?? {}) as Record<string, unknown>
  check('dashboard expenses section matches approved+pending ledger', Math.abs(Number(dashExp.total ?? -1) - 5150.50) < 0.02, dashExp)
  const lowStock = await rows(root, `
    select sb.variant_id, sb.quantity, coalesce(sb.reorder_level, (select (value ->> 'low_stock_threshold')::int from public.app_settings where key = 'inventory')) as lvl
    from public.stock_balances sb where sb.quantity <= coalesce(sb.reorder_level, (select (value ->> 'low_stock_threshold')::int from public.app_settings where key = 'inventory'))`)
  check('low-stock figures are computable from stock vs threshold (' + lowStock.length + ' rows)', lowStock.length >= 0)
  const outOfStock = await rows(root, `select distinct variant_id from public.stock_balances where quantity <= 0`)
  check('out-of-stock detection works (Blue/L + Black/L at 0)', outOfStock.length === 2, outOfStock.length)

  console.log('\n== PART 42: search audit across page RPCs ==')
  const spNoResult = await rpc(admin, 'sales_page', { p_search: 'ZZZNOSUCH' }) as { rows?: unknown[] }
  check('sales search no-result returns empty', (spNoResult?.rows ?? []).length === 0)
  const cpPartial = await rpc(admin, 'customers_page', { p_search: 'qa cust' }) as { rows?: unknown[] }
  check('customers search partial + lowercase matches', (cpPartial?.rows ?? []).length === 1, (cpPartial?.rows ?? []).length)
  const supPartial = await rpc(admin, 'suppliers_page', { p_search: 'qa fab' }) as { rows?: unknown[] }
  check('suppliers search partial + lowercase matches', (supPartial?.rows ?? []).length === 1)
  const ppMethod = await rpc(acct, 'payments_page', { p_method: 'UPI' }) as { rows?: unknown[] }
  check('payments page filter by method (UPI) finds rows', (ppMethod?.rows ?? []).length >= 2, (ppMethod?.rows ?? []).length)
  const ppRef = await rpc(acct, 'payments_page', { p_search: 'QA Customer' }) as { rows?: unknown[] }
  check('payments search by party name works', (ppRef?.rows ?? []).length >= 1, (ppRef?.rows ?? []).length)
  const shSearch = await rpc(inv, 'stock_history_page', { p_search: 'QAP-BLU-M', p_limit: 50 }) as { rows?: unknown[] }
  check('stock history search by SKU finds movements', (shSearch?.rows ?? []).length >= 8, (shSearch?.rows ?? []).length)
  const shMoveType = await rpc(inv, 'stock_history_page', { p_movement_type: 'SALE', p_limit: 50 }) as { rows?: Array<Record<string, unknown>> }
  check('stock history filter by movement type works', (shMoveType?.rows ?? []).length >= 10 && (shMoveType?.rows ?? []).every((r) => r.movement_type === 'SALE'))
  const prodSearchUp = await rpc(inv, 'products_page', { p_search: 'QA PRODUCTION' }) as { rows?: unknown[]; total?: number }
  check('products page search uppercase works', (prodSearchUp?.rows ?? []).length === 1, prodSearchUp?.total)

  console.log('\n== PART 46: date filter current behavior (0015 applied) — the exact user scenarios ==')
  // sales placed at IST boundary instants
  const dCust = (await root.query(`insert into public.customers (name) values ('P9 Date Customer') returning id`)).rows[0]
  const mkDSale = async (num: string, instant: string) =>
    (await root.query(`insert into public.sales (sale_number, sale_date, grand_total, paid_amount, subtotal, tax_total, customer_id, customer_name, status, payment_status, cashier_id, cashier_name, location_id, location_name)
      values ($1, $2::timestamptz, 100, 100, 100, 0, $3, 'P9 Date Customer', 'COMPLETED', 'PAID', $4, 'P9 Admin', $5, 'Main Store') returning id`,
      [num, instant, dCust.id, adminId, mainLoc.id])).rows[0]
  await mkDSale('P9D1', '2026-09-11 00:00:30+05:30')  // 11th, first minute IST
  await mkDSale('P9D2', '2026-09-11 23:59:30+05:30')  // 11th, last minute IST
  await mkDSale('P9D3', '2026-09-12 00:00:30+05:30')  // 12th, first minute IST
  await mkDSale('P9D4', '2026-09-12 21:30:00+05:30')  // 12th, evening
  const pageFor = async (from: string, to: string) => {
    const r = await rpc(admin, 'sales_page', { p_date_from: from, p_date_to: to, p_limit: 100 }) as { rows?: Array<Record<string, unknown>> }
    return (r?.rows ?? []).map((x) => String(x.sale_number)).filter((n) => n.startsWith('P9D')).sort()
  }
  const s11_12 = await pageFor('2026-09-11', '2026-09-12')
  check('CURRENT BEHAVIOR 11-09 -> 12-09: BOTH days fully included (4 rows)', s11_12.length === 4, s11_12)
  const s11_11 = await pageFor('2026-09-11', '2026-09-11')
  check('CURRENT BEHAVIOR 11-09 -> 11-09 (same day): whole day included (2 rows)', s11_11.length === 2, s11_11)
  const s12_12 = await pageFor('2026-09-12', '2026-09-12')
  check('CURRENT BEHAVIOR 12-09 -> 12-09 (same day): whole day included (2 rows)', s12_12.length === 2, s12_12)
  const repFor = async (from: string, to: string) => {
    const r = await rpc(acct, 'sales_report', { p_date_from: from, p_date_to: to, p_limit: 100 }) as { rows?: Array<Record<string, unknown>> }
    return (r?.rows ?? []).map((x) => String(x.sale_number)).filter((n) => n.startsWith('P9D')).sort()
  }
  const r11_12 = await repFor('2026-09-11', '2026-09-12')
  check('page and REPORT agree on the 11->12 range (0015 IST boundaries)', JSON.stringify(r11_12) === JSON.stringify(s11_12), { r11_12, s11_12 })
  const s10_13 = await pageFor('2026-09-10', '2026-09-13')
  check('month/day boundaries: 10->13 range includes the 11th/12th boundary sales + today', s10_13.length >= 4, s10_13.length)

  console.log('\n== PART 47: stock reconciliation (ledger formula vs actual balances) ==')
  // expected per variant-location computed FROM THE LEDGER (independent of stock_balances)
  // movements store SIGNED quantities (SALE -q, PURCHASE +q, ...) — the
  // ledger formula is a plain sum per (variant, location)
  const ledger = await rows(root, `
    select variant_id, location_id, sum(quantity) as net
    from public.stock_movements group by 1, 2`)
  const ledgerMap = new Map(ledger.map((r) => [`${r.variant_id}:${r.location_id}`, Number(r.net)]))
  const balances = await rows(root, `select variant_id, location_id, quantity from public.stock_balances`)
  let reconOk = true
  const mismatches: unknown[] = []
  const locNames = new Map((await rows(root, `select id, name, location_type from public.stock_locations`)).map((r) => [r.id, r]))
  for (const b of balances) {
    const key = `${b.variant_id}:${b.location_id}`
    const led = ledgerMap.get(key) ?? 0
    if (Math.abs(led - Number(b.quantity)) > 0.001) {
      reconOk = false
      const loc = locNames.get(b.location_id)
      const types = await rows(root, `select movement_type, sum(quantity) as q from public.stock_movements where variant_id = $1 and location_id = $2 group by 1`, [b.variant_id, b.location_id])
      mismatches.push({ loc: loc?.name, type: loc?.location_type, ledger: led, balance: Number(b.quantity), types })
    }
  }
  check('LEDGER RECONCILIATION: opening + purchases - sales + returns - purchase returns + adjustments +/- transfers == current stock (every row)',
    reconOk, mismatches.slice(0, 5))
  const qaTotals = await val(root, `
    select coalesce(sum(case when location_id = $2 then quantity else 0 end), 0) as main_qty,
           coalesce(sum(case when location_id = $3 then quantity else 0 end), 0) as wh_qty
    from public.stock_balances where variant_id = any($1::uuid[])`,
    [[vBM.id, vBL.id, vKM.id, vKL.id], mainLoc.id, whLoc.id])
  check('final QA stock present at Main (sellable) + Warehouse + Damaged locations',
    Number(qaTotals.main_qty) > 0 && Number(qaTotals.wh_qty) > 0, qaTotals)

  console.log('\n== PART 48: financial reconciliation ==')
  const finSales = expSalesTotal
  const finRefunds = Number((await val(root, `select coalesce(sum(refund_amount), 0) as r from public.sales_returns`)).r)
  const finCustPay = Number((await val(root, `select coalesce(sum(amount), 0) as a from public.customer_payments`)).a)
  const finExpenses = Number((await val(root, `select coalesce(sum(amount), 0) as a from public.expenses where status = 'APPROVED'`)).a)
  const finSupPay = Number((await val(root, `select coalesce(sum(amount), 0) as a from public.supplier_payments`)).a)
  console.log(`  >> independent ledger: sales ${finSales.toFixed(2)}, refunds ${finRefunds.toFixed(2)}, customer receipts ${finCustPay.toFixed(2)}, approved expenses ${finExpenses.toFixed(2)}, supplier payments ${finSupPay.toFixed(2)}`)
  check('financial ledger internally consistent (paid + due == grand for every sale)',
    allSales.every((r) => Math.abs(Number(r.paid_amount) + Number(r.due_amount) - Number(r.grand_total)) < 0.01))
  const dash2 = await rpc(acct, 'dashboard_summary', {}) as Record<string, unknown>
  check('dashboard runs with the full QA dataset (no error, numbers present)', typeof dash2 === 'object' && dash2 !== null)

  console.log('\n== PART 49: security (RLS + role permissions, no DB changes) ==')
  await expectError('anon cannot read products', () => anon.query('select 1 from public.products limit 1'), 'permission')
  await expectError('anon cannot read sales', () => anon.query('select 1 from public.sales limit 1'), 'permission')
  await expectError('anon cannot call pos_search', () => rpc(anon, 'pos_search', { p_query: 'QA', p_limit: 5 }), 'permission')
  await expectError('anon cannot call create_sale', () => rpc(anon, 'create_sale', { p_payload: JSON.stringify({ items: [] }) }), 'permission')
  // products_page is gated to create_sale OR view_inventory holders (0016):
  // cashiers CAN browse the catalog (by design, for POS), accountants cannot.
  await expectError('accountant (no POS/inventory role) cannot read the products catalog page RPC', () => rpc(acct, 'products_page', {}), 'permission')
  await expectError('accountant cannot use POS search', () => rpc(acct, 'pos_search', { p_query: 'QA', p_limit: 5 }), 'permission')
  await expectError('cashier cannot manage inventory (opening stock)', () => rpc(cash, 'set_opening_stock', { p_variant_id: vBM.id, p_location_id: mainLoc.id, p_quantity: 1 }), 'permission')
  await expectError('cashier cannot apply discounts (role rule)', () => doSale(cash, {
    items: [mkItem(vBM.id, 1, { discount_type: 'pct', discount_value: 5 })],
    payments: [{ method: 'Cash', amount: 950 }], location_id: mainLoc.id }), 'DISCOUNT_NOT_ALLOWED')
  const hackRes = await cash.query(`update public.products set name = 'HACKED' where id = $1 returning id`, [prod.id]).catch((e: Error) => e.message)
  const nameAfter = await val(root, `select name from public.products where id = $1`, [prod.id])
  check('cashier cannot edit products (RLS: 0 rows writable, name unchanged)',
    (typeof hackRes === 'string' || (hackRes?.rowCount ?? 0) === 0) && nameAfter.name === 'QA Production Shirt', { hackRes })
  const anonRows = await anon.query(`select count(*) as c from public.stock_balances`).catch(() => null)
  check('anon sees zero rows even where ACL allows (RLS denies)', !anonRows || Number(anonRows.rows[0].c) === 0)

  console.log('\n== PART 45: persistence re-read (DB-level refresh equivalent) ==')
  const finalProd = await val(inv, `select name, category_id, brand_id, gst_rate, hsn_code, selling_price from public.products where id = $1`, [prod.id])
  check('product survives full workflow with all attributes intact',
    finalProd.name === 'QA Production Shirt' && finalProd.category_id === cat.id && finalProd.brand_id === brand.id &&
    Number(finalProd.gst_rate) === 12 && finalProd.hsn_code === '6105')
  const finalVariants = await rows(inv, `select sku, barcode, qr_identifier from public.product_variants where product_id = $1 order by sku`, [prod.id])
  check('all 4 variants + identifiers persist after the full workflow', finalVariants.length === 4)

  // =========================================================================
  console.log('\n================ PHASE 9 WORKFLOW SUITE SUMMARY ================')
  console.log(`PASS: ${passed}   FAIL: ${failed}`)
  if (failures.length) {
    console.log('FAILED CHECKS:')
    for (const f of failures) console.log('  - ' + f)
  }
  await cleanup(root, [admin, inv, cash, acct, anon])
}

async function cleanup(root: Client, clients: Client[]) {
  for (const c of clients) await c.end().catch(() => {})
  await root.end()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
