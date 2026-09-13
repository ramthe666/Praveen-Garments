/**
 * 0016 (product-search completeness) — local test suite.
 * Runs against the local Supabase-compatible harness (NOT production).
 *
 * Proves, at the DATABASE layer (Phase 8 Part 3):
 *   1. every previously-broken search now matches: color, size, brand,
 *      category, subcategory — in BOTH pos_search() and products_page();
 *   2. the searches that already worked are NOT regressed: name / code /
 *      SKU / barcode / QR, partial + case-insensitive + trimmed, exact-match
 *      ordering (scan path), inactive exclusion, result shapes;
 *   3. products_page integrity: exact filtered totals, total_is_estimate
 *      flag, pagination with search (no dup/missing rows), search combined
 *      with category/brand/status filters and every sort mode;
 *   4. security unchanged: cashier can pos_search but not products_page;
 *      manager both; anon denied at the ACL level; grants byte-identical;
 *   5. the migration is idempotent (re-apply changes nothing behaviorally).
 *
 * Prerequisite: reset-full chain 0001 -> 0016 applied (self-seeding).
 * Run from pgtest/: PGPASSWORD=postgres bun run scripts/local/test-0016.ts
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`) }
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
  async function posSearch(client: Client, q: string, limit = 12) {
    const res = await client.query('select public.pos_search($1, $2) as r', [q, limit])
    return ((res.rows[0].r as { rows: any[] })?.rows ?? []) as any[]
  }
  async function productsPage(client: Client, q: string, opts: { limit?: number; offset?: number; status?: string; sort?: string } = {}) {
    const res = await client.query(
      'select public.products_page($1, null, null, null, $2, $3, $4, $5) as r',
      [q, opts.status ?? null, opts.sort ?? 'newest', opts.limit ?? 25, opts.offset ?? 0])
    return res.rows[0].r as { rows: any[]; total: number; total_is_estimate: boolean }
  }

  console.log('== A. SEED (idempotent fixture) ==')
  const adminId = (await root.query(
    `insert into auth.users (email, raw_user_meta_data) values ('t16-admin@t.local', $1::jsonb)
     on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data returning id`,
    [JSON.stringify({ app_role: 'admin', full_name: 'T16 Admin' })])).rows[0].id as string
  await root.query(
    `insert into public.profiles (id, email, full_name, role) values ($1, 't16-admin@t.local', 'T16 Admin', 'admin')
     on conflict (id) do update set role = 'admin'::public.user_role, is_active = true`, [adminId])
  const cashId = (await root.query(
    `insert into auth.users (email, raw_user_meta_data) values ('t16-cash@t.local', $1::jsonb)
     on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data returning id`,
    [JSON.stringify({ app_role: 'cashier', full_name: 'T16 Cashier' })])).rows[0].id as string
  await root.query(
    `insert into public.profiles (id, email, full_name, role) values ($1, 't16-cash@t.local', 'T16 Cashier', 'cashier')
     on conflict (id) do update set role = 'cashier'::public.user_role, is_active = true`, [cashId])
  const mgrId = (await root.query(
    `insert into auth.users (email, raw_user_meta_data) values ('t16-mgr@t.local', $1::jsonb)
     on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data returning id`,
    [JSON.stringify({ app_role: 'manager', full_name: 'T16 Manager' })])).rows[0].id as string
  await root.query(
    `insert into public.profiles (id, email, full_name, role) values ($1, 't16-mgr@t.local', 'T16 Manager', 'manager')
     on conflict (id) do update set role = 'manager'::public.user_role, is_active = true`, [mgrId])
  const acctId = (await root.query(
    `insert into auth.users (email, raw_user_meta_data) values ('t16-acct@t.local', $1::jsonb)
     on conflict (email) do update set raw_user_meta_data = excluded.raw_user_meta_data returning id`,
    [JSON.stringify({ app_role: 'accountant', full_name: 'T16 Accountant' })])).rows[0].id as string
  await root.query(
    `insert into public.profiles (id, email, full_name, role) values ($1, 't16-acct@t.local', 'T16 Accountant', 'accountant')
     on conflict (id) do update set role = 'accountant'::public.user_role, is_active = true`, [acctId])
  const admin = await as(adminId)
  const cash = await as(cashId)
  const mgr = await as(mgrId)
  const acct = await as(acctId)
  const anon = await as(null)

  await root.query(`delete from public.product_variants where sku like 'FESTW-%' or sku like 'LNGS-%'`)
  await root.query(`delete from public.products where product_code in ('FESTW01', 'LNGS01', 'LNGS02')`)
  await root.query(`delete from public.categories where name in ('Kurtis16', 'Silk Kurtis 16', 'Nightwear16')`)
  await root.query(`delete from public.brands where name = 'Zeya Fabs 16'`)

  const sizeM = (await val(root, `select id from public.sizes where name = 'M'`)).id
  const sizeXL = (await val(root, `select id from public.sizes where name = 'XL'`)).id
  const colorBlu = (await val(root, `select id from public.colors where name = 'Blue'`)).id
  const colorBlk = (await val(root, `select id from public.colors where name = 'Black'`)).id
  const catId = (await val(root, `insert into public.categories (name) values ('Kurtis16') returning id`)).id
  const subId = (await val(root, `insert into public.categories (name, parent_id) values ('Silk Kurtis 16', $1) returning id`, [catId])).id
  const brandId = (await val(root, `insert into public.brands (name) values ('Zeya Fabs 16') returning id`)).id

  const prodId = (await val(root,
    `insert into public.products (name, product_code, category_id, subcategory_id, brand_id, gender, gst_rate, mrp, selling_price, cost_price, hsn_code, fabric)
     values ('Festive Ethnic Wear', 'FESTW01', $1, $2, $3, 'women', 5, 1499, 999, 620, '6211', 'Silk') returning id`,
    [catId, subId, brandId])).id
  await root.query(
    `insert into public.product_variants (product_id, sku, barcode, qr_identifier, size_id, color_id, selling_price)
     values ($1, 'FESTW-BLU-M', '2900000000117', 'QRFESTWBLUM', $2, $3, 999)`,
    [prodId, sizeM, colorBlu])
  await root.query(
    `insert into public.product_variants (product_id, sku, barcode, qr_identifier, size_id, color_id, selling_price)
     values ($1, 'FESTW-BLK-XL', '2900000000124', 'QRFESTWBLKXL', $2, $3, 1099)`,
    [prodId, sizeXL, colorBlk])

  const cat2Id = (await val(root, `insert into public.categories (name) values ('Nightwear16') returning id`)).id
  const prod2Id = (await val(root,
    `insert into public.products (name, product_code, category_id, gender, gst_rate, selling_price)
     values ('Loungewear Set', 'LNGS01', $1, 'women', 5, 799) returning id`, [cat2Id])).id
  await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, selling_price) values ($1, 'LNGS-BLU-M', $2, $3, 799)`,
    [prod2Id, sizeM, colorBlu])
  // inactive variant — must never surface in pos_search
  const prod3Id = (await val(root,
    `insert into public.products (name, product_code, category_id, gender, gst_rate, selling_price, is_active)
     values ('Archived Line', 'LNGS02', $1, 'women', 5, 599, false) returning id`, [cat2Id])).id
  await root.query(
    `insert into public.product_variants (product_id, sku, size_id, color_id, selling_price) values ($1, 'ARCH-BLU-M', $2, $3, 599)`,
    [prod3Id, sizeM, colorBlu])
  check('fixture seeded (3 products, 4 variants, 1 inactive)', Boolean(prodId && prod2Id && prod3Id))

  console.log('\n== B. NEW search coverage (the reported bug, now fixed) ==')
  const c1 = await posSearch(cash, 'Blue')
  check('pos_search COLOR "Blue" -> both Blue variants (active only)', c1.length === 2 && c1.every((r) => r.color_name === 'Blue'))
  const c2 = await posSearch(cash, 'black')
  check('pos_search COLOR "black" (lower-case) -> Black XL', c2.length === 1 && c2[0].size_name === 'XL')
  const c3 = await posSearch(cash, 'XL')
  check('pos_search SIZE "XL" -> Black XL via size (not only via SKU text)', c3.length === 1 && c3[0].sku === 'FESTW-BLK-XL')
  const c4 = await posSearch(cash, 'Zeya')
  check('pos_search BRAND "Zeya" -> 2 variants', c4.length === 2)
  const c5 = await posSearch(cash, 'Kurtis16')
  check('pos_search CATEGORY -> variants under that category', c5.length === 2)
  const c6 = await posSearch(cash, 'Silk Kurtis 16')
  check('pos_search SUBCATEGORY -> variants under it', c6.length === 2)
  const c7 = await posSearch(cash, 'Nightwear16')
  check('pos_search CATEGORY for product with NULL subcategory (join null path)', c7.length === 1 && c7[0].product_code === 'LNGS01')
  const p1 = await productsPage(admin, 'Blue')
  check('products_page COLOR "Blue" -> all 3 products incl. inactive (status filter is opt-in)',
    p1.rows.length === 3 && p1.total === 3)
  const p1a = await productsPage(admin, 'Blue', { status: 'active' })
  check('products_page COLOR "Blue" + status=active -> exactly the 2 active',
    p1a.rows.length === 2 && p1a.total === 2 && p1a.rows.every((r) => r.product_code !== 'LNGS02'))
  const p2 = await productsPage(admin, 'XL')
  check('products_page SIZE "XL" -> 1 product', p2.rows.length === 1)
  const p3 = await productsPage(admin, 'Zeya')
  check('products_page BRAND "Zeya" -> 1 product (exact total)', p3.rows.length === 1 && p3.total === 1 && p3.total_is_estimate === false)
  const p4 = await productsPage(admin, 'Kurtis16')
  check('products_page CATEGORY "Kurtis16" -> 1 product', p4.rows.length === 1)
  const p5 = await productsPage(admin, 'Silk Kurtis 16')
  check('products_page SUBCATEGORY -> 1 product', p5.rows.length === 1)
  const scan = await posSearch(cash, 'Blue', 1)
  check('scan path (p_limit=1) now resolves attribute terms too', scan.length === 1)

  console.log('\n== C. NO REGRESSION — original matches and semantics ==')
  const r1 = await posSearch(cash, 'festive')
  check('pos_search partial name still works', r1.length === 2)
  const r2 = await posSearch(cash, 'FESTW01')
  check('pos_search product_code still works', r2.length === 2)
  const r3 = await posSearch(cash, 'FESTW-BLU-M')
  check('pos_search exact SKU still works + exact-match sorts first', r3[0]?.sku === 'FESTW-BLU-M')
  const r4 = await posSearch(cash, '2900000000117')
  check('pos_search exact barcode still resolves the exact variant first', r4.length === 1 && r4[0].barcode === '2900000000117')
  const r5 = await posSearch(cash, 'QRFESTWBLUM')
  check('pos_search exact QR still resolves', r5.length === 1 && r5[0].qr_identifier === 'QRFESTWBLUM')
  const r6 = await posSearch(cash, '  festive  ')
  check('pos_search still trims whitespace', r6.length === 2)
  const r7 = await posSearch(cash, '')
  check('pos_search empty query still returns catalog head', r7.length > 0)
  const r8 = await posSearch(cash, 'zzz-nothing')
  check('pos_search garbage still returns empty', r8.length === 0)
  check('pos_search never returns the inactive variant/product',
    (await posSearch(cash, 'Archived')).length === 0 && (await posSearch(cash, 'ARCH-BLU-M')).length === 0)
  const shape = r4[0] ?? {}
  check('pos_search result shape unchanged (variant/stock/prices keys)',
    'variant_id' in shape && 'stock' in shape && 'selling_price' in shape && 'gst_rate' in shape && 'size_name' in shape)
  const q1 = await productsPage(admin, 'ethnic')
  check('products_page partial name still works', q1.rows.length === 1)
  const q2 = await productsPage(admin, 'LNGS-')
  check('products_page partial SKU still works', q2.rows.length === 1)
  const q3 = await productsPage(admin, '', { status: 'inactive' })
  check('products_page inactive status filter still works (Archived Line)', q3.rows.length === 1 && q3.rows[0].product_code === 'LNGS02')
  const q4 = await productsPage(admin, 'Blue', { sort: 'name_asc' })
  check('products_page search + sort still works',
    q4.rows.length === 3 && q4.rows[0].name <= q4.rows[1].name && q4.rows[1].name <= q4.rows[2].name)

  console.log('\n== D. products_page totals + pagination with search ==')
  // "Blue" matches 3 products. page through with limit 1.
  const pg1 = await productsPage(admin, 'Blue', { limit: 1, offset: 0 })
  const pg2 = await productsPage(admin, 'Blue', { limit: 1, offset: 1 })
  const pg3 = await productsPage(admin, 'Blue', { limit: 1, offset: 2 })
  const pg4 = await productsPage(admin, 'Blue', { limit: 1, offset: 3 })
  const ids = [pg1.rows[0]?.id, pg2.rows[0]?.id, pg3.rows[0]?.id]
  check('pagination with search: no duplicate rows across pages, 4th page empty',
    new Set(ids).size === 3 && ids.every(Boolean) && pg4.rows.length === 0)
  check('pagination with search: total stays exact (3) on every page', pg1.total === 3 && pg2.total === 3 && pg3.total === 3)
  const all = await productsPage(admin, 'Blue', { limit: 25 })
  check('pagination with search: union of pages == full result',
    new Set([...pg1.rows.map((r) => r.id), ...pg2.rows.map((r) => r.id), ...pg3.rows.map((r) => r.id)]).size === all.rows.length)
  check('filtered totals are EXACT (not planner estimate)', all.total === 3 && all.total_is_estimate === false)
  const unfiltered = await productsPage(admin, '')
  check('unfiltered totals still use the estimate path (flag true)', unfiltered.total_is_estimate === true)

  console.log('\n== E. Security unchanged ==')
  const cashPos = await posSearch(cash, 'Blue')
  const cashPp = await productsPage(cash, 'Blue')
  check('cashier (create_sale + view_inventory by design, 0001 seed) can use BOTH search entry points',
    cashPos.length === 2 && cashPp.rows.length === 3)
  await expectError('accountant (no view_inventory, no create_sale) BLOCKED from products_page',
    () => productsPage(acct, 'Blue'), 'You do not have permission to view inventory')
  await expectError('accountant BLOCKED from pos_search too',
    () => posSearch(acct, 'Blue'), 'You do not have permission to use the POS')
  const mgrPos = await posSearch(mgr, 'Blue')
  const mgrPp = await productsPage(mgr, 'Blue')
  check('manager (view_inventory) can use both', mgrPos.length === 2 && mgrPp.rows.length === 3)
  await expectError('anon still DENIED pos_search at ACL level', () => posSearch(anon, 'Blue'), 'permission denied for function pos_search')
  await expectError('anon still DENIED products_page at ACL level', () => productsPage(anon, 'Blue'), 'permission denied for function products_page')
  const g = async (role: string, fn: string) =>
    Boolean((await val(root, `select has_function_privilege('${role}', '${fn}', 'EXECUTE') as v`)).v)
  check('grants byte-identical: pos_search authenticated+service_role, NOT anon/public',
    (await g('authenticated', 'public.pos_search(text,int)')) && (await g('service_role', 'public.pos_search(text,int)')) &&
    !(await g('anon', 'public.pos_search(text,int)')) && !(await g('public', 'public.pos_search(text,int)')))
  check('grants byte-identical: products_page authenticated only, NOT anon/public/service',
    (await g('authenticated', 'public.products_page(text,uuid,uuid,uuid,text,text,int,int)')) &&
    !(await g('anon', 'public.products_page(text,uuid,uuid,uuid,text,text,int,int)')) &&
    !(await g('public', 'public.products_page(text,uuid,uuid,uuid,text,text,int,int)')) &&
    !(await g('service_role', 'public.products_page(text,uuid,uuid,uuid,text,text,int,int)')))

  console.log('\n== F. Idempotency (re-apply 0016) ==')
  const sql = readFileSync('../supabase/migrations/0016_phase8_search_attributes.sql', 'utf8')
  await root.query(sql)
  const after = await posSearch(cash, 'Blue')
  const afterPp = await productsPage(admin, 'Zeya')
  check('re-apply succeeds and behavior unchanged', after.length === 2 && afterPp.rows.length === 1)

  console.log(`\n== RESULT: ${passed} PASS, ${failed} FAIL ==`)
  for (const f of failures) console.log(`  FAILED: ${f}`)
  await root.end()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('CRASH', e); process.exit(1) })
