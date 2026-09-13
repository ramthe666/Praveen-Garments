/**
 * Phase 8 Part 3 — PRODUCT SEARCH REPRODUCTION (pre-0016 state).
 *
 * The user reported "some searches may not be working correctly".
 * This suite PROVES the exact gap at the database layer:
 *
 *   pos_search()      matches name / product_code / SKU / barcode / QR —
 *                     but NOT color, size, brand or category names
 *                     (it even SELECTs size_name/color_name/brand_name/
 *                     category_name but never matches them).
 *   products_page()   matches name / product_code / variant SKU/barcode/QR —
 *                     but NOT color, size, brand, category or subcategory.
 *
 * For a garments shop, cashiers search "Blue", "XL", a brand or a category
 * all day. Those queries return EMPTY today.
 *
 * Also verifies the searches that DO work (baseline that must not regress):
 * name exact/partial/case, product_code, SKU partial, barcode, QR, trim,
 * unicode text, and empty-query behaviour.
 *
 * Prerequisite: reset-full chain 0001 -> 0015 applied.
 * Run from pgtest/: PGPASSWORD=postgres bun run scripts/local/test-search-p3.ts
 */
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }

let pass = 0
let fail = 0
const failures: string[] = []
const bugs: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`) }
}
/** A confirmed reproduction: the check FAILS on the current code (bug alive). */
function bug(name: string, searchFoundRows: boolean, detail?: unknown) {
  if (!searchFoundRows) { bugs.push(name); console.log(`  BUG-CONFIRMED ${name} :: found ${JSON.stringify(detail)} row(s)`) }
  else console.log(`  NOT-REPRODUCED ${name} :: found ${JSON.stringify(detail)} row(s)`)
}

async function main() {
  const root = new Client(CONN)
  await root.connect()
  await root.query("set timezone to 'UTC'")

  async function as(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query('set role authenticated')
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    return c
  }
  const val = async (client: Client, sql: string, vals: unknown[] = []) =>
    (await client.query(sql, vals)).rows[0]

  async function posSearch(client: Client, q: string, limit = 12) {
    const res = await client.query('select public.pos_search($1, $2) as r', [q, limit])
    return ((res.rows[0].r as { rows: any[] })?.rows ?? []) as any[]
  }
  async function productsPage(client: Client, q: string) {
    const res = await client.query(
      'select public.products_page($1, null, null, null, null, $2, 25, 0) as r', [q, 'newest'])
    return ((res.rows[0].r as { rows: any[] })?.rows ?? []) as any[]
  }

  console.log('== A. SETUP ==')
  const adminId = (await root.query(
    `insert into auth.users (email, raw_user_meta_data) values ('p3-admin@t.local', $1::jsonb)
     on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data returning id`,
    [JSON.stringify({ app_role: 'admin', full_name: 'P3 Admin' })])).rows[0].id as string
  await root.query(
    `insert into public.profiles (id, email, full_name, role) values ($1, 'p3-admin@t.local', 'P3 Admin', 'admin')
     on conflict (id) do update set role = 'admin'::public.user_role, is_active = true`,
    [adminId])
  const admin = await as(adminId)
  const cashId = (await root.query(
    `insert into auth.users (email, raw_user_meta_data) values ('p3-cash@t.local', $1::jsonb)
     on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data returning id`,
    [JSON.stringify({ app_role: 'cashier', full_name: 'P3 Cashier' })])).rows[0].id as string
  await root.query(
    `insert into public.profiles (id, email, full_name, role) values ($1, 'p3-cash@t.local', 'P3 Cashier', 'cashier')
     on conflict (id) do update set role = 'cashier'::public.user_role, is_active = true`,
    [cashId])
  const cash = await as(cashId)

  // idempotent re-run guard: unique product/variant/SKU codes (superuser; the
  // app itself never deletes catalog rows client-side)
  await root.query(`delete from public.product_variants where sku like 'FESTW-%' or sku = 'LNGS-PNK-M'`)
  await root.query(`delete from public.products where product_code in ('FESTW01', 'LNGS01')`)
  await root.query(`delete from public.categories where name in ('Kurtis', 'Silk Kurtis', 'Nightwear')`)
  await root.query(`delete from public.brands where name = 'Zeya Fabs'`)

  const sizeM = (await val(admin, `select id from public.sizes where name = 'M'`)).id
  const sizeXL = (await val(admin, `select id from public.sizes where name = 'XL'`)).id
  const colorBlu = (await val(admin, `select id from public.colors where name = 'Blue'`)).id
  const colorBlk = (await val(admin, `select id from public.colors where name = 'Black'`)).id
  const catId = (await val(admin, `insert into public.categories (name) values ('Kurtis') returning id`)).id
  const subId = (await val(admin, `insert into public.categories (name, parent_id) values ('Silk Kurtis', $1) returning id`, [catId])).id
  const brandId = (await val(admin, `insert into public.brands (name) values ('Zeya Fabs') returning id`)).id

  // Product name deliberately contains NO color/size/brand/category words.
  const prodId = (await val(admin,
    `insert into public.products (name, product_code, category_id, subcategory_id, brand_id, gender, gst_rate, mrp, selling_price, cost_price, hsn_code, fabric)
     values ('Festive Ethnic Wear', 'FESTW01', $1, $2, $3, 'women', 5, 1499, 999, 620, '6211', 'Silk') returning id`,
    [catId, subId, brandId])).id

  const vBluM = (await val(admin,
    `insert into public.product_variants (product_id, sku, barcode, qr_identifier, size_id, color_id, selling_price)
     values ($1, 'FESTW-BLU-M', '2900000000117', 'QRFESTWBLUM', $2, $3, 999) returning id`,
    [prodId, sizeM, colorBlu])).id
  const vBlkXL = (await val(admin,
    `insert into public.product_variants (product_id, sku, barcode, qr_identifier, size_id, color_id, selling_price)
     values ($1, 'FESTW-BLK-XL', '2900000000124', 'QRFESTWBLKXL', $2, $3, 1099) returning id`,
    [prodId, sizeXL, colorBlk])).id
  check('catalog seeded (1 product, 2 variants: Blue M / Black XL)', Boolean(vBluM && vBlkXL))

  // another product in a different category to prove filtering not accidental
  const cat2Id = (await val(admin, `insert into public.categories (name) values ('Nightwear') returning id`)).id
  const prod2Id = (await val(admin,
    `insert into public.products (name, product_code, category_id, gender, gst_rate, selling_price)
     values ('Loungewear Set', 'LNGS01', $1, 'women', 5, 799) returning id`, [cat2Id])).id
  await admin.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, selling_price) values ($1, 'LNGS-PNK-M', $2, $3, 799)`,
    [prod2Id, sizeM, colorBlu])

  console.log('\n== B. BASELINE — searches that must already work ==')
  const byName = await posSearch(cash, 'festive')
  check('pos_search partial name (case-insensitive)', byName.length === 2)
  const byNameUpper = await posSearch(cash, 'FESTIVE ETHNIC')
  check('pos_search exact name upper-case', byNameUpper.length === 2)
  const byCode = await posSearch(cash, 'FESTW01')
  check('pos_search product_code', byCode.length === 2)
  const bySku = await posSearch(cash, 'festw-blu')
  check('pos_search partial SKU', bySku.length === 1 && bySku[0].sku === 'FESTW-BLU-M')
  const byBarcode = await posSearch(cash, '2900000000117')
  check('pos_search barcode exact', byBarcode.length === 1 && byBarcode[0].variant_id === vBluM)
  const byQr = await posSearch(cash, 'QRFESTWBLUM')
  check('pos_search QR exact', byQr.length === 1 && byQr[0].variant_id === vBluM)
  const trimmed = await posSearch(cash, '  festive  ')
  check('pos_search trims whitespace', trimmed.length === 2)
  const unicode = await posSearch(cash, 'Loungewear Set')
  check('pos_search unicode-safe text', unicode.length === 1)
  const ppName = await productsPage(admin, 'ethnic')
  check('products_page partial name', ppName.length === 1)
  const ppSku = await productsPage(admin, 'LNGS-')
  check('products_page partial SKU', ppSku.length === 1)
  const empty = await posSearch(cash, '')
  check('pos_search empty query returns catalog head (bounded)', empty.length > 0)
  const none = await posSearch(cash, 'zzz-no-such-thing')
  check('pos_search garbage query returns empty', none.length === 0)

  console.log('\n== C. REPRODUCTION — searches the user reported as broken ==')
  // COLOR — the #1 garments search term. MUST match the Blue variant.
  const posColor = await posSearch(cash, 'Blue')
  bug('pos_search COLOR name "Blue" finds 0 rows', posColor.length > 0, posColor.length)
  const posColor2 = await posSearch(cash, 'black')
  bug('pos_search COLOR name "black" finds 0 rows', posColor2.length > 0, posColor2.length)
  // SIZE
  const posSize = await posSearch(cash, 'XL')
  bug('pos_search SIZE name "XL" finds 0 rows', posSize.length > 0, posSize.length)
  // BRAND
  const posBrand = await posSearch(cash, 'Zeya')
  bug('pos_search BRAND name "Zeya" finds 0 rows', posBrand.length > 0, posBrand.length)
  // CATEGORY / SUBCATEGORY
  const posCat = await posSearch(cash, 'Kurtis')
  bug('pos_search CATEGORY name "Kurtis" finds 0 rows', posCat.length > 0, posCat.length)
  const posSub = await posSearch(cash, 'Silk')
  bug('pos_search SUBCATEGORY "Silk Kurtis" finds 0 rows', posSub.length > 0, posSub.length)

  // products_page — same gap
  const ppColor = await productsPage(admin, 'Blue')
  bug('products_page COLOR "Blue" finds 0 rows', ppColor.length > 0, ppColor.length)
  const ppSize = await productsPage(admin, 'XL')
  bug('products_page SIZE "XL" finds 0 rows', ppSize.length > 0, ppSize.length)
  const ppBrand = await productsPage(admin, 'Zeya')
  bug('products_page BRAND "Zeya" finds 0 rows', ppBrand.length > 0, ppBrand.length)
  const ppCat = await productsPage(admin, 'Kurtis')
  bug('products_page CATEGORY "Kurtis" finds 0 rows', ppCat.length > 0, ppCat.length)

  console.log('\n== D. SCAN PATH (cashier types identifier into scan box) ==')
  // resolveAndAdd() calls pos_search(p_query, 1) — a color search must surface
  // the variant so the fallback-to-search UX works for attribute terms too.
  const scan = await posSearch(cash, 'Blue', 1)
  bug('scan lookup via pos_search("Blue")', scan.length > 0, scan.length)

  console.log(`\n== RESULT: ${pass} baseline PASS, ${fail} baseline FAIL, ${bugs.length} bugs confirmed ==`)
  if (bugs.length) {
    console.log('\nROOT CAUSE: pos_search()/products_page() match name/code/SKU/barcode/QR only —')
    console.log('color/size/brand/category/subcategory names are never searched.')
  }
  await root.end()
  process.exit(fail > 0 ? 1 : (bugs.length > 0 ? 2 : 0))
}

main().catch((e) => { console.error('CRASH', e); process.exit(1) })
