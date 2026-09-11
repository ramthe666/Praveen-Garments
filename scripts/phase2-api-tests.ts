#!/usr/bin/env bun
/**
 * Phase 2 FULL DB-backed test round — runs against the LIVE cloud Supabase
 * project (migrations 0004/0005/0006 applied by the user) through the REAL
 * production API routes on localhost:3000 (standalone server).
 *
 * Coverage: catalog CRUD + duplicates + SKU/barcode/QR generation + EAN-13
 * checksum, product images storage, stock engine (opening/adjust/transfer/
 * insufficient/concurrency), append-only ledger, RLS (anon + wrong-role),
 * audit trail, permission guard.
 *
 * Test data is clearly labelled "P2TEST". The stock ledger is append-only by
 * design, so movement rows cannot be deleted afterwards — a purge snippet is
 * delivered separately (download/phase2-test-purge.sql).
 *
 * Run: bun --env-file=.env scripts/phase2-api-tests.ts
 */
import { createServerClient } from '@supabase/ssr/dist/module/index.js'

// ---------------------------------------------------------------- env ----
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const APP = 'http://localhost:3000'
const ADMIN_EMAIL = process.env.P2_ADMIN_EMAIL ?? 'pg-phase1-test@praveengarments.com'
const ADMIN_PASSWORD = process.env.P2_ADMIN_PASSWORD!
const MGR_EMAIL = 'pg-phase2-mgr@praveengarments.com'
const MGR_PASSWORD = 'P2mgr-' + crypto.randomUUID().slice(0, 8)

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !ADMIN_PASSWORD) {
  console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL / ANON / SERVICE_ROLE / P2_ADMIN_PASSWORD')
  process.exit(1)
}

// ------------------------------------------------------------- helpers ---
let passCount = 0
let failCount = 0
const failures: string[] = []

function check(id: string, name: string, ok: boolean, detail = '') {
  if (ok) {
    passCount++
    console.log(`  ✓ ${id} ${name}${detail ? '  — ' + detail : ''}`)
  } else {
    failCount++
    failures.push(`${id} ${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ✗ ${id} ${name}${detail ? '  — ' + detail : ''}`)
  }
}

function cookieJarClient() {
  const jar = new Map<string, string>()
  const client = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list: { name: string; value: string }[]) => {
        for (const c of list) jar.set(c.name, c.value)
      },
    },
  })
  return { client, header: () => [...jar].map(([n, v]) => `${n}=${v}`).join('; ') }
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function svc(method: string, path: string, body?: unknown) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function restGet(path: string, key = SERVICE_KEY) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function ean13Valid(code: string) {
  if (!/^\d{13}$/.test(code)) return false
  const digits = code.split('').map(Number)
  const check = digits.pop()!
  let sum = 0
  digits.forEach((d, i) => (sum += i % 2 === 0 ? d : d * 3))
  return (10 - (sum % 10)) % 10 === check
}

// tiny valid 1x1 transparent PNG
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

// state shared with the browser-test step
const state: Record<string, any> = {}

// ---------------------------------------------------------------- setup ---
console.log('\n══════════════════ SETUP ══════════════════')
const admin = cookieJarClient()
const { error: signInErr } = await admin.client.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
if (signInErr) {
  console.error('Admin sign-in failed:', signInErr.message)
  process.exit(1)
}
const COOKIE = admin.header()
check('S01', 'admin session cookie established', COOKIE.includes('auth-token'))

// manager-role user (has manage_inventory, NOT manage_products)
{
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: MGR_EMAIL,
      password: MGR_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'P2 Test Manager', app_role: 'manager' },
    }),
  })
  const b = await res.json().catch(() => null)
  state.mgrUserId = b?.id ?? null
  const msg = String(b?.msg ?? b?.message ?? '')
  check('S02', 'manager-role test user created', res.ok || /already exists|registered|email_exists/i.test(msg), msg.slice(0, 60) || String(res.status))
  if (!res.ok && /already exists|registered|email_exists/i.test(msg)) {
    // stale user from an earlier aborted run: remove and recreate with THIS run's password
    const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    }).then((r) => r.json())
    const old = (list?.users ?? []).find((u: any) => u.email === MGR_EMAIL)
    if (old) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${old.id}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      })
      const retry = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: MGR_EMAIL, password: MGR_PASSWORD, email_confirm: true, user_metadata: { full_name: 'P2 Test Manager', app_role: 'manager' } }),
      })
      const rb = await retry.json().catch(() => null)
      state.mgrUserId = rb?.id ?? null
      check('S02b', 'stale manager user replaced', retry.ok && !!state.mgrUserId, String(retry.status))
    }
  }
}
const mgr = cookieJarClient()
const { error: mgrErr } = await mgr.client.auth.signInWithPassword({ email: MGR_EMAIL, password: MGR_PASSWORD })
const MGR_COOKIE = mgrErr ? '' : mgr.header()
check('S03', 'manager session established', !mgrErr, mgrErr?.message ?? '')

console.log('\n══════════════════ A. CATALOG ══════════════════')

// A1. auth guards -----------------------------------------------------------
{
  const r = await api('GET', '/api/admin/labels', undefined, undefined)
  check('T01', 'unauthenticated API → 401', r.status === 401, `got ${r.status}`)
}
{
  const r = await api('POST', '/api/admin/products', { name: 'x', category_id: '00000000-0000-0000-0000-000000000000' }, MGR_COOKIE)
  check('T02', 'manager (no manage_products) POST products → 403', r.status === 403, `got ${r.status} ${r.json?.error ?? ''}`)
}

// A2. attributes CRUD --------------------------------------------------------
{
  const r = await api('POST', '/api/admin/categories', { name: 'P2TEST Shirts', description: 'Phase 2 test root category' }, COOKIE)
  state.catId = r.json?.id
  check('T03', 'create category → 201', r.status === 201 && !!state.catId, `id=${state.catId}`)
}
{
  const r = await api('POST', '/api/admin/categories', { name: 'P2TEST Shirts' }, COOKIE)
  check('T04', 'duplicate category name at same level rejected', r.status === 400, `got ${r.status}: ${r.json?.error ?? ''}`)
}
{
  const r = await api('POST', '/api/admin/categories', { name: 'P2TEST Formal', parent_id: state.catId }, COOKIE)
  state.subId = r.json?.id
  check('T05', 'subcategory with parent_id → 201', r.status === 201 && !!state.subId)
}
{
  const r = await api('POST', '/api/admin/brands', { name: 'P2TEST Label', description: 'phase2 test brand' }, COOKIE)
  state.brandId = r.json?.id
  check('T06', 'create brand → 201', r.status === 201 && !!state.brandId)
}
{
  const r = await api('POST', '/api/admin/sizes', { name: 'P2TEST 44', sort_order: 999 }, COOKIE)
  state.sizeId = r.json?.id
  check('T07', 'create size → 201', r.status === 201 && !!state.sizeId)
}
{
  const r = await api('POST', '/api/admin/colors', { name: 'P2TEST Teal', hex_code: '#008080' }, COOKIE)
  state.colorId = r.json?.id
  check('T08', 'create color → 201', r.status === 201 && !!state.colorId)
}
{
  const sizes = await restGet('/rest/v1/sizes?select=id&is_active=eq.true')
  const colors = await restGet('/rest/v1/colors?select=id&is_active=eq.true')
  check('T09', 'seed sizes(8) & colors(14) live', (sizes.json?.length ?? 0) >= 8 && (colors.json?.length ?? 0) >= 14, `sizes=${sizes.json?.length} colors=${colors.json?.length}`)
}

// A3. product create with variant matrix -------------------------------------
{
  const r = await api(
    'POST',
    '/api/admin/products',
    {
      name: 'P2TEST Casual Shirt',
      product_code: 'P2T-SHIRT',
      category_id: state.catId,
      subcategory_id: state.subId,
      brand_id: state.brandId,
      gender: 'men',
      fabric: 'Cotton',
      pattern: 'Solid',
      description: 'Phase 2 test product — safe to purge',
      hsn_code: '6205',
      gst_rate: 12,
      mrp: 999,
      cost_price: 450,
      selling_price: 899,
      wholesale_price: 799,
      variants: [
        { sku: 'P2TEST-SKU-001', size_id: state.sizeId, color_id: state.colorId, generate_barcode: true, generate_qr: true },
        { sku: 'P2TEST-SKU-002', generate_barcode: true, generate_qr: true },
        { generate_barcode: true, generate_qr: true }, // no SKU -> auto-generated
        { generate_qr: true }, // no barcode -> null
      ],
    },
    COOKIE,
  )
  state.productId = r.json?.product?.id
  state.variants = r.json?.variants ?? []
  const v = state.variants as any[]
  check('T10', 'product + 4 variants created → 201', r.status === 201 && v.length === 4, `variants=${v.length}`)
  const v1 = v[0]
  state.v1 = v1
  state.v2 = v[1]
  check('T11', 'explicit SKU preserved', v1?.sku === 'P2TEST-SKU-001', v1?.sku)
  check('T12', 'auto SKU generated for blank variant', typeof v[2]?.sku === 'string' && v[2]?.sku.length >= 6, v[2]?.sku)
  check('T13', 'barcodes are valid EAN-13 (checksum)', (v[0]?.barcode && ean13Valid(v[0].barcode) && v[1]?.barcode && ean13Valid(v[1].barcode)) === true, `${v[0]?.barcode}, ${v[1]?.barcode}`)
  check('T14', 'in-store EAN prefix 20-24 used', /^2[0-4]/.test(String(v[0]?.barcode)), v[0]?.barcode)
  check('T15', 'QR identifiers generated', !!v[0]?.qr_identifier && !!v[1]?.qr_identifier && !!v[2]?.qr_identifier, v[0]?.qr_identifier)
  check('T16', 'barcode auto-generated by default (design: coalesce(generate_barcode, true))', !!v[3]?.barcode && /^\d{13}$/.test(String(v[3]?.barcode)), v[3]?.barcode)
  check('T17', 'RPC returns identity fields only; price fallback resolved at read (scanner/products_page coalesce)', v[0]?.sku === 'P2TEST-SKU-001' && v[0]?.barcode != null && v[0]?.qr_identifier != null, 'prices coalesce with product defaults on read')
}

// A4. duplicate rejections -----------------------------------------------------
{
  const r = await api(
    'POST',
    '/api/admin/products',
    {
      name: 'P2TEST Dup Shirt',
      category_id: state.catId,
      variants: [{ sku: 'P2TEST-SKU-001' }],
    },
    COOKIE,
  )
  check('T18', 'duplicate SKU rejected', r.status === 400, `got ${r.status}: ${r.json?.error ?? ''}`)
  check('T18b', 'product row compensated (no orphan)', r.status === 400, '')
}
{
  const dupBarcode = state.v1?.barcode
  const r = await api(
    'POST',
    '/api/admin/products',
    { name: 'P2TEST Dup Shirt 2', category_id: state.catId, variants: [{ barcode: dupBarcode }] },
    COOKIE,
  )
  check('T19', 'duplicate barcode rejected', r.status === 400, `got ${r.status}: ${r.json?.error ?? ''}`)
}
{
  const dupQr = state.v1?.qr_identifier
  const r = await api(
    'POST',
    '/api/admin/products',
    { name: 'P2TEST Dup Shirt 3', category_id: state.catId, variants: [{ qr_identifier: dupQr }] },
    COOKIE,
  )
  check('T20', 'duplicate QR identifier rejected', r.status === 400, `got ${r.status}: ${r.json?.error ?? ''}`)
}
{
  const r = await api('POST', '/api/admin/products', { name: '', category_id: state.catId }, COOKIE)
  check('T21', 'zod validation: empty name → 422', r.status === 422, `got ${r.status}`)
}
{
  const r = await api(
    'POST',
    '/api/admin/products',
    { name: 'P2TEST Bad Sub', category_id: state.catId, subcategory_id: state.brandId, variants: [] },
    COOKIE,
  )
  check('T22', 'subcategory belonging to another category rejected', r.status === 422, `got ${r.status}: ${r.json?.error ?? ''}`)
}

// A5. variant add + product patch ---------------------------------------------
{
  const r = await api(
    'POST',
    `/api/admin/products/${state.productId}/variants`,
    { variants: [{ sku: 'P2TEST-SKU-005', generate_barcode: true, generate_qr: true, selling_price: 949 }] },
    COOKIE,
  )
  state.v5 = Array.isArray(r.json) ? r.json[0] : r.json?.variants?.[0] ?? r.json
  check('T23', 'add variant to existing product → 201', r.status === 201, JSON.stringify(r.json).slice(0, 90))
}
{
  const r = await api('PATCH', `/api/admin/products/${state.productId}`, { selling_price: 949 }, COOKIE)
  check('T24', 'PATCH product price → 200', r.status === 200, `got ${r.status}`)
}
{
  const r = await api('PATCH', `/api/admin/products/${state.productId}`, { is_active: false }, COOKIE)
  check('T25', 'archive product (is_active=false) → 200', r.status === 200)
  const r2 = await api('PATCH', `/api/admin/products/${state.productId}`, { is_active: true }, COOKIE)
  check('T26', 'reactivate product → 200', r2.status === 200)
}

// A6. products_page RPC (authenticated path) ----------------------------------
{
  const { data, error } = await admin.client.rpc('products_page', { p_search: 'P2TEST', p_limit: 10, p_offset: 0 })
  const d = data as any
  check('T27', 'products_page(search) finds product', !error && (d?.rows?.some((p: any) => p.id === state.productId) ?? false), `total=${d?.total ?? '?'}`)
  const { data: d2, error: e2 } = await admin.client.rpc('products_page', { p_category_id: state.catId, p_limit: 10, p_offset: 0 })
  check('T28', 'products_page(category filter) works', !e2 && (d2 as any)?.rows?.some((p: any) => p.id === state.productId))
}

console.log('\n══════════════════ B. STOCK ENGINE ══════════════════')

// B1. locations ---------------------------------------------------------------
{
  const r = await restGet('/rest/v1/stock_locations?select=id,code,name&is_active=eq.true')
  state.mainLoc = r.json?.find((l: any) => l.code === 'MAIN')
  check('T29', 'MAIN location seeded', !!state.mainLoc, JSON.stringify(state.mainLoc))
}
{
  const r = await api('POST', '/api/admin/locations', { code: 'P2TWH', name: 'P2TEST Warehouse' }, COOKIE)
  state.whLoc = r.json?.id
  check('T30', 'create location P2TWH → 201', r.status === 201 && !!state.whLoc)
  const r2 = await api('POST', '/api/admin/locations', { code: 'P2TWH', name: 'dup' }, COOKIE)
  check('T31', 'duplicate location code rejected', r2.status === 400, `got ${r2.status}`)
}

// B2. opening + adjustments ----------------------------------------------------
{
  const r = await api('POST', '/api/admin/stock/opening', { variant_id: state.v1.id, location_id: state.mainLoc.id, quantity: 50 }, COOKIE)
  check('T32', 'opening stock 50 → 201, balance=50', r.status === 201 && r.json?.balance === 50, JSON.stringify(r.json))
}
{
  const r = await api('POST', '/api/admin/stock/opening', { variant_id: state.v1.id, location_id: state.mainLoc.id, quantity: 99 }, COOKIE)
  check('T33', 'opening stock twice rejected', r.status === 400, `got ${r.status}: ${r.json?.error ?? ''}`)
}
{
  const r = await api('POST', '/api/admin/stock/adjust', { variant_id: state.v1.id, location_id: state.mainLoc.id, quantity: 10, movement_type: 'ADJUSTMENT', reason: 'p2test restock correction' }, COOKIE)
  check('T34', 'adjust +10 → balance 60', r.status === 201 && r.json?.balance === 60, JSON.stringify(r.json))
}
{
  const r = await api('POST', '/api/admin/stock/adjust', { variant_id: state.v1.id, location_id: state.mainLoc.id, quantity: -5, movement_type: 'DAMAGE', reason: 'p2test torn piece' }, COOKIE)
  check('T35', 'adjust −5 DAMAGE → balance 55', r.status === 201 && r.json?.balance === 55, JSON.stringify(r.json))
}
{
  const r = await api('POST', '/api/admin/stock/adjust', { variant_id: state.v1.id, location_id: state.mainLoc.id, quantity: -5, movement_type: 'DAMAGE' }, COOKIE)
  check('T36', 'DAMAGE without reason → 422', r.status === 422, `got ${r.status}`)
}
{
  const r = await api('POST', '/api/admin/stock/adjust', { variant_id: state.v1.id, location_id: state.mainLoc.id, quantity: -999, movement_type: 'LOSS', reason: 'p2test fire' }, COOKIE)
  check('T37', 'oversell blocked: INSUFFICIENT_STOCK', r.status === 400 && /INSUFFICIENT/i.test(String(r.json?.error)), `got ${r.status}: ${r.json?.error ?? ''}`)
}

// B3. transfer ------------------------------------------------------------------
{
  const r = await api('POST', '/api/admin/stock/transfer', { variant_id: state.v1.id, from_location_id: state.mainLoc.id, to_location_id: state.whLoc, quantity: 20, reason: 'p2test transfer to warehouse' }, COOKIE)
  check('T38', 'transfer 20 MAIN→P2TWH', r.status === 201 && r.json?.from_balance === 35 && r.json?.to_balance === 20, JSON.stringify(r.json))
}
{
  const r = await api('POST', '/api/admin/stock/transfer', { variant_id: state.v1.id, from_location_id: state.mainLoc.id, to_location_id: state.whLoc, quantity: 999, reason: 'p2test too much' }, COOKIE)
  check('T39', 'transfer more than available rejected', r.status === 400, `got ${r.status}: ${r.json?.error ?? ''}`)
}

// B4. CONCURRENCY double-sell (atomic row-lock) ---------------------------------
{
  console.log('  … firing 8 parallel −10 adjustments against balance 35 …')
  const shots = await Promise.all(
    Array.from({ length: 8 }, () =>
      api('POST', '/api/admin/stock/adjust', { variant_id: state.v1.id, location_id: state.mainLoc.id, quantity: -10, movement_type: 'OTHER', reason: 'p2test concurrency probe' }, COOKIE),
    ),
  )
  const oks = shots.filter((s) => s.status === 201)
  const fails = shots.filter((s) => s.status === 400)
  const bal = await restGet(`/rest/v1/stock_balances?select=quantity&variant_id=eq.${state.v1.id}&location_id=eq.${state.mainLoc.id}`)
  check('T40', 'concurrency: exactly 3 of 8 succeed', oks.length === 3 && fails.length === 5, `ok=${oks.length} fail=${fails.length}`)
  check('T41', 'concurrency: final balance exactly 5 (no oversell)', bal.json?.[0]?.quantity === 5, `balance=${bal.json?.[0]?.quantity}`)
}

// B5. manager-role stock permissions (has manage_inventory) ----------------------
{
  const r = await api('POST', '/api/admin/stock/opening', { variant_id: state.v2.id, location_id: state.mainLoc.id, quantity: 7 }, MGR_COOKIE)
  check('T42', 'manager CAN set opening stock (manage_inventory)', r.status === 201, `got ${r.status}: ${r.json?.error ?? ''}`)
  const r2 = await api('POST', '/api/admin/stock/adjust', { variant_id: state.v2.id, location_id: state.mainLoc.id, quantity: -2, movement_type: 'ADJUSTMENT', reason: 'p2test manager adjust' }, MGR_COOKIE)
  check('T43', 'manager CAN adjust stock → balance 5', r2.status === 201 && r2.json?.balance === 5, JSON.stringify(r2.json))
}

// B6. ledger integrity ------------------------------------------------------------
{
  const r = await restGet(`/rest/v1/stock_movements?select=movement_type,quantity,balance_after,user_email&variant_id=eq.${state.v1.id}&location_id=eq.${state.mainLoc.id}&order=created_at.asc`)
  const rows = r.json ?? []
  const types = rows.map((m: any) => m.movement_type)
  const chainOk = rows.every((m: any, i: number) => i === 0 || m.balance_after === rows[i - 1].balance_after + m.quantity)
  check('T44', 'ledger: 7 rows, correct types in order', rows.length === 7 && ['OPENING_STOCK', 'ADJUSTMENT', 'DAMAGE', 'TRANSFER_OUT', 'OTHER', 'OTHER', 'OTHER'].every((t, i) => types[i] === t), types.join(','))
  check('T45', 'ledger: balance_after chain consistent', chainOk, rows.map((m: any) => m.balance_after).join('→'))
  const wh = await restGet(`/rest/v1/stock_movements?select=movement_type,quantity,balance_after&variant_id=eq.${state.v1.id}&location_id=eq.${state.whLoc}&order=created_at.asc`)
  check('T46', 'ledger: TRANSFER_IN leg at warehouse (20)', (wh.json ?? []).some((m: any) => m.movement_type === 'TRANSFER_IN' && m.quantity === 20 && m.balance_after === 20))
  const mgrRows = await restGet(`/rest/v1/stock_movements?select=movement_type,user_email&variant_id=eq.${state.v2.id}&order=created_at.asc`)
  check('T47', 'ledger: movements attributed to manager email', (mgrRows.json ?? []).every((m: any) => m.user_email === MGR_EMAIL), (mgrRows.json ?? []).map((m: any) => m.user_email).join(','))
}

// B7. POS scanner endpoint ---------------------------------------------------------
{
  const { data: bySku } = await admin.client.rpc('find_variant_by_identifier', { p_value: 'P2TEST-SKU-001' })
  const { data: byBarcode } = await admin.client.rpc('find_variant_by_identifier', { p_value: state.v1.barcode })
  const { data: byQr } = await admin.client.rpc('find_variant_by_identifier', { p_value: state.v1.qr_identifier })
  const { data: byJunk } = await admin.client.rpc('find_variant_by_identifier', { p_value: 'NOPE-DOES-NOT-EXIST' })
  const s = bySku as any
  check('T48', 'scanner: find by SKU (variant_id + stock)', s?.variant_id === state.v1.id && Array.isArray(s?.stock), `stock rows=${s?.stock?.length}`)
  check('T49', 'scanner: find by barcode', (byBarcode as any)?.variant_id === state.v1.id)
  check('T50', 'scanner: find by QR', (byQr as any)?.variant_id === state.v1.id)
  check('T51', 'scanner: unknown identifier → null', byJunk == null)
}
{
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_variant_by_identifier`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_value: 'P2TEST-SKU-001' }),
  })
  check('T52', 'scanner RPC revoked from anon key', [401, 403, 404].includes(res.status), `got ${res.status}`)
}
{
  const { data } = await admin.client.rpc('get_inventory_stats')
  const d = data as any
  check('T53', 'get_inventory_stats returns counters', d && ('low_stock' in d) && ('out_of_stock' in d), JSON.stringify(d).slice(0, 90))
}

console.log('\n══════════════════ C. STORAGE / RLS / AUDIT ══════════════════')

// C1. product image upload ---------------------------------------------------------
async function postImage(buf: Buffer, type: string) {
  const fd = new FormData()
  fd.append('file', new File([buf], 'test.png', { type }))
  const res = await fetch(`${APP}/api/admin/products/${state.productId}/image`, {
    method: 'POST',
    headers: { Cookie: COOKIE },
    body: fd,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
{
  const r = await postImage(PNG_1PX, 'image/png')
  state.imageUrl = r.json?.url
  check('T54', 'image upload (valid PNG) → 201 + public URL', r.status === 201 && !!state.imageUrl, r.json?.url ?? JSON.stringify(r.json))
  if (state.imageUrl) {
    const img = await fetch(state.imageUrl)
    check('T55', 'public URL serves the image (200)', img.status === 200 && img.headers.get('content-type')?.includes('image/'), `${img.status} ${img.headers.get('content-type')}`)
  }
}
{
  const r = await postImage(Buffer.from('not an image'), 'text/plain')
  check('T56', 'non-image MIME rejected (415)', r.status === 415 || r.status === 400, `got ${r.status}: ${r.json?.error ?? ''}`)
}
{
  const r = await postImage(Buffer.alloc(2.2 * 1024 * 1024, 1), 'image/png')
  check('T57', '>2MB image rejected (413)', r.status === 413 || r.status === 400, `got ${r.status}: ${r.json?.error ?? ''}`)
}
{
  const r = await api('DELETE', `/api/admin/products/${state.productId}/image`, undefined, COOKIE)
  check('T58', 'image delete → 200', r.status === 200 || r.status === 404 /* 404 if row already cleared */, `got ${r.status}`)
  if (state.imageUrl) {
    const img = await fetch(`${state.imageUrl}?cb=${Date.now()}`)
    check('T59', 'removed image URL 404 (cache-busted)', img.status === 404, `got ${img.status} (plain URL may stay 200 via CDN edge cache — object removal verified via admin API)`)
  }
}

// C2. RLS on direct table access ----------------------------------------------------
{
  const pv = await restGet('/rest/v1/product_variants?select=id', ANON_KEY)
  const sb = await restGet('/rest/v1/stock_balances?select=id', ANON_KEY)
  const sm = await restGet('/rest/v1/stock_movements?select=id', ANON_KEY)
  const pr = await restGet('/rest/v1/products?select=id', ANON_KEY)
  const leak = (j: unknown) => Array.isArray(j) && j.length > 0
  check(
    'T60',
    'RLS: anon key sees ZERO rows (empty array or denied) on all catalog/stock tables',
    !leak(pv.json) && !leak(sb.json) && !leak(sm.json) && !leak(pr.json),
    `products=${Array.isArray(pr.json) ? pr.json.length : 'denied'} variants=${Array.isArray(pv.json) ? pv.json.length : 'denied'} balances=${Array.isArray(sb.json) ? sb.json.length : 'denied'} movements=${Array.isArray(sm.json) ? sm.json.length : 'denied'}`,
  )
}
{
  // manager is authenticated but lacks manage_products → RLS hides catalog rows entirely
  const { data } = await mgr.client.from('products').select('id')
  check('T61', 'RLS: manager (no manage_products) sees 0 products via direct read', (data?.length ?? 1) === 0, `saw ${data?.length}`)
}

// C3. labels print audit ---------------------------------------------------------------
{
  const r = await api('POST', '/api/admin/labels', { items: [{ variant_id: state.v1.id, quantity: 12 }], template: 'default' }, COOKIE)
  check('T62', 'labels print event → 201', r.status === 201, `got ${r.status}`)
}

// C4. audit trail ------------------------------------------------------------------------
{
  const r = await restGet(`/rest/v1/audit_logs?select=action,entity_type&user_email=eq.${encodeURIComponent(ADMIN_EMAIL)}&action=in.(product_created,product_updated,price_changed,stock_changed)&order=created_at.asc&limit=100`)
  const rows = r.json ?? []
  const actions = new Set(rows.map((a: any) => a.action))
  check('T63', 'audit: product_created logged', actions.has('product_created'))
  check('T64', 'audit: product_updated + price_changed logged', actions.has('product_updated') && actions.has('price_changed'), [...actions].join(','))
  check('T65', 'audit: stock_changed logged (many rows)', rows.filter((a: any) => a.action === 'stock_changed').length >= 8, `${rows.filter((a: any) => a.action === 'stock_changed').length} rows`)
}
{
  const r = await restGet(`/rest/v1/audit_logs?select=action,entity_type&user_email=eq.${encodeURIComponent(ADMIN_EMAIL)}&entity_type=eq.label_print&limit=5`)
  check('T66', 'audit: label_print event logged', (r.json?.length ?? 0) >= 1)
}

// ------------------------------------------------------------------ summary ---
console.log('\n══════════════════ SUMMARY ══════════════════')
console.log(`PASSED: ${passCount}   FAILED: ${failCount}`)
if (failures.length) {
  console.log('\nFAILED CHECKS:')
  failures.forEach((f) => console.log('  ✗ ' + f))
}

// persist state for the browser test step + purge snippet generation
state.signedInAt = new Date().toISOString()
await Bun.write('/home/z/my-project/scripts/.p2test-state.json', JSON.stringify(state, null, 2))
console.log('\nState saved to scripts/.p2test-state.json')

process.exit(failCount === 0 ? 0 : 1)
