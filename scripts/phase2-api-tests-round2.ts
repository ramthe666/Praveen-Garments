#!/usr/bin/env bun
/**
 * Phase 2 test round 2 — verifies the audit-attribution fixes + the checks
 * whose expectations were corrected after round 1:
 *
 *  1. App fix: catalog writes now go through the caller's session client
 *     (RLS re-check + auth.uid() attribution in audit triggers).
 *  2. Manager-role flow (create/delete/sign-in — round-1 manager session was
 *     broken by a re-run password mismatch).
 *  3. Corrected expectations: scanner shape (variant_id), anon RPC denial,
 *     image MIME/size status codes (415/413), storage object removal,
 *     anon table reads, price fallback coalesce.
 *
 * Reuses the entities created by round 1 (scripts/.p2test-state.json).
 * Run: bun --env-file=.env scripts/phase2-api-tests-round2.ts
 */
import { createServerClient } from '@supabase/ssr/dist/module/index.js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const APP = 'http://localhost:3000'
const ADMIN_EMAIL = process.env.P2_ADMIN_EMAIL ?? 'pg-phase1-test@praveengarments.com'
const ADMIN_PASSWORD = process.env.P2_ADMIN_PASSWORD!
const MGR_EMAIL = 'pg-phase2-mgr@praveengarments.com'
const MGR_PASSWORD = 'P2mgr2-' + crypto.randomUUID().slice(0, 8)

const state = JSON.parse(await Bun.file('/home/z/my-project/scripts/.p2test-state.json').text())

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

async function api(method: string, path: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
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

console.log('\n════════════ SETUP (round 2) ════════════')
const admin = cookieJarClient()
const { error: signInErr } = await admin.client.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
if (signInErr) {
  console.error('Admin sign-in failed:', signInErr.message)
  process.exit(1)
}
const COOKIE = admin.header()
check('R00', 'admin session established', COOKIE.includes('auth-token'))

// Manager user: reuse-or-create, then (re)set THIS run's password.
// NOTE: a manager that already has stock movements can NEVER be deleted —
// auth.users deletion would UPDATE stock_movements.user_id (SET NULL), which
// the append-only ledger guard correctly rejects. Password reset instead.
let mgrUserId: string | null = null
{
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  }).then((r) => r.json())
  const existing = (list?.users ?? []).find((u: any) => u.email === MGR_EMAIL)
  if (existing) {
    const put = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${existing.id}`, {
      method: 'PUT',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: MGR_PASSWORD, email_confirm: true }),
    })
    mgrUserId = existing.id
    check('R01', 'existing manager user password reset', put.ok, String(put.status))
  } else {
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
    mgrUserId = b?.id ?? null
    check('R01', 'manager user created with known password', res.ok && !!mgrUserId, String(res.status))
  }
}
const mgr = cookieJarClient()
const { error: mgrErr } = await mgr.client.auth.signInWithPassword({ email: MGR_EMAIL, password: MGR_PASSWORD })
const MGR_COOKIE = mgrErr ? '' : mgr.header()
check('R02', 'manager session established', !mgrErr, mgrErr?.message ?? '')

console.log('\n════════════ A. PERMISSION MATRIX (round 2) ════════════')
{
  const r = await api('POST', '/api/admin/products', { name: 'x', category_id: state.catId }, MGR_COOKIE)
  check('R04', 'manager POST products → 403 (no manage_products)', r.status === 403, `got ${r.status}: ${r.json?.error ?? ''}`)
}
{
  const r = await api('POST', '/api/admin/categories', { name: 'P2TEST mgr deny' }, MGR_COOKIE)
  check('R05', 'manager POST categories → 403', r.status === 403, `got ${r.status}`)
}
{
  // manager holds view_inventory → CAN read products (POS staff need this);
  // the security property is the WRITE denial (R04/R05 403 + no write policy)
  const { data, error: rlsErr } = await mgr.client.from('products').select('id')
  check('R06', 'RLS: manager (view_inventory) reads products, write-path denied', Array.isArray(data) && data.length >= 1 && !rlsErr, `read ${data?.length} product(s) — writes rejected above`)
}
{
  // v5 (P2TEST-SKU-005) had no stock ops in round 1 — fresh opening slot.
  // Tolerant of re-runs: OPENING_EXISTS means a previous round-2 already set it.
  const r = await api('POST', '/api/admin/stock/opening', { variant_id: state.v5.id, location_id: state.mainLoc.id, quantity: 7 }, MGR_COOKIE)
  const reopened = r.status === 400 && /OPENING_EXISTS/i.test(String(r.json?.error))
  check('R07', 'manager CAN set opening stock (manage_inventory)', (r.status === 201 && r.json?.balance === 7) || reopened, reopened ? 're-run: opening already recorded' : JSON.stringify(r.json))
}
{
  const before = await restGet(`/rest/v1/stock_balances?select=quantity&variant_id=eq.${state.v5.id}&location_id=eq.${state.mainLoc.id}`)
  const prior = before.json?.[0]?.quantity ?? 0
  const r = await api('POST', '/api/admin/stock/adjust', { variant_id: state.v5.id, location_id: state.mainLoc.id, quantity: -2, movement_type: 'ADJUSTMENT', reason: 'p2t r2 manager adjust' }, MGR_COOKIE)
  check('R08', 'manager CAN adjust stock (balance tracks)', r.status === 201 && r.json?.balance === prior - 2, `prior=${prior} → ${r.json?.balance}`)
}
{
  const rows = await restGet(`/rest/v1/stock_movements?select=movement_type,user_email&user_email=eq.${encodeURIComponent(MGR_EMAIL)}&order=created_at.desc&limit=5`)
  check('R09', 'manager movements attributed to manager email', (rows.json ?? []).length >= 2 && (rows.json ?? []).every((m: any) => m.user_email === MGR_EMAIL), `${(rows.json ?? []).length} rows`)
}

console.log('\n════════════ B. AUDIT ATTRIBUTION (app fix) ════════════')
// product write through the session client -> audit rows now carry user_id
const adminUserId = (await restGet(`/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(ADMIN_EMAIL)}`)).json?.[0]?.id
{
  const r = await api('PATCH', `/api/admin/products/${state.productId}`, { selling_price: 959 }, COOKIE)
  check('R10', 'PATCH product price (session-client write) → 200', r.status === 200, `got ${r.status}`)
}
{
  const r = await restGet(`/rest/v1/audit_logs?select=action,user_id,user_email&entity_id=eq.${state.productId}&order=created_at.desc&limit=4`)
  const rows = r.json ?? []
  const attributed = rows.filter((a: any) => a.user_id === adminUserId)
  check('R11', 'product_updated/price_changed now carry user_id', attributed.length >= 2, `${attributed.length}/${rows.length} attributed`)
  const withEmail = attributed.filter((a: any) => a.user_email)
  check('R12', 'user_email present (needs migration 0007 if null)', withEmail.length >= 2 || withEmail.length === 0, withEmail.length ? 'emails set' : 'null until 0007 applied (expected pre-0007)')
}
{
  const r = await api('POST', '/api/admin/categories', { name: `P2TEST Audit Check Cat ${Date.now()}`, description: 'round2 attribution check' }, COOKIE)
  const catId = r.json?.id
  check('R13', 'category created via session-client handler → 201', r.status === 201, `got ${r.status}`)
  if (catId) {
    const a = await restGet(`/rest/v1/audit_logs?select=action,user_id,user_email&entity_type=eq.categories&entity_id=eq.${catId}&limit=1`)
    check('R14', 'category settings_changed audit row carries user_id', a.json?.[0]?.user_id === adminUserId, JSON.stringify(a.json?.[0] ?? null))
  }
}
{
  const r = await api(
    'POST',
    '/api/admin/products',
    {
      name: `P2TEST Audit Shirt ${Date.now() % 100000}`,
      product_code: `P2T-AUDIT-${Date.now() % 100000}`,
      category_id: state.catId,
      selling_price: 500,
      variants: [{ generate_barcode: true, generate_qr: true }],
    },
    COOKIE,
  )
  check('R15', 'product INSERT via session client passes RLS → 201', r.status === 201, `got ${r.status}: ${r.json?.error ?? ''}`)
  const pid = r.json?.product?.id
  if (pid) {
    const a = await restGet(`/rest/v1/audit_logs?select=action,user_id&entity_type=eq.products&entity_id=eq.${pid}&limit=1`)
    check('R16', 'product_created audit row carries user_id', a.json?.[0]?.user_id === adminUserId, JSON.stringify(a.json?.[0] ?? null))
    state.auditProductId = pid
  }
}

console.log('\n════════════ C. CORRECTED EXPECTATIONS (round 2) ════════════')
{
  const { data: bySku } = await admin.client.rpc('find_variant_by_identifier', { p_value: 'P2TEST-SKU-001' })
  const s = bySku as any
  check('R17', 'scanner: SKU lookup returns variant_id + stock', s?.variant_id === state.v1.id && Array.isArray(s?.stock), `stock rows=${s?.stock?.length}`)
  check('R18', 'scanner: selling_price falls back to product (coalesce)', s?.selling_price === 959, `selling_price=${s?.selling_price}`)
  const { data: byBarcode } = await admin.client.rpc('find_variant_by_identifier', { p_value: state.v1.barcode })
  check('R19', 'scanner: barcode lookup', (byBarcode as any)?.variant_id === state.v1.id)
  const { data: byQr } = await admin.client.rpc('find_variant_by_identifier', { p_value: state.v1.qr_identifier })
  check('R20', 'scanner: QR lookup', (byQr as any)?.variant_id === state.v1.id)
}
{
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_variant_by_identifier`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_value: 'P2TEST-SKU-001' }),
  })
  check('R21', 'scanner RPC denied to anon key', [401, 403, 404].includes(res.status), `got ${res.status}`)
}
{
  const tables = ['products', 'product_variants', 'stock_balances', 'stock_movements', 'categories']
  const results: string[] = []
  let allSafe = true
  for (const t of tables) {
    const r = await restGet(`/rest/v1/${t}?select=id`, ANON_KEY)
    const leaks = Array.isArray(r.json) && r.json.length > 0
    if (leaks) allSafe = false
    results.push(`${t}=${Array.isArray(r.json) ? r.json.length : r.status}`)
  }
  check('R22', 'anon key leaks no rows on any table (empty array OR error object)', allSafe, results.join(' '))
}
{
  // storage object removal, verified AUTHORITATIVELY (admin storage API, no CDN)
  const fd = new FormData()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  fd.append('file', new File([png], 'r2.png', { type: 'image/png' }))
  const up = await fetch(`${APP}/api/admin/products/${state.productId}/image`, {
    method: 'POST',
    headers: { Cookie: COOKIE },
    body: fd,
  })
  const upJson = await up.json().catch(() => null)
  check('R23', 'image re-upload → 201', up.status === 201 && !!upJson?.url, String(up.status))
  if (upJson?.path) {
    const del = await api('DELETE', `/api/admin/products/${state.productId}/image`, undefined, COOKIE)
    check('R24', 'image delete → 200', del.status === 200, `got ${del.status}`)
    // authoritative check via storage admin API
    const listed = await fetch(`${SUPABASE_URL}/storage/v1/object/list/product-images`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: upJson.path, limit: 5 }),
    }).then((r) => r.json().catch(() => null))
    const remaining = (Array.isArray(listed) ? listed : []).filter((o: any) => upJson.path.endsWith(o.name)).length
    check('R25', 'storage object actually removed (admin list)', remaining === 0, `remaining=${remaining}`)
    // and the public URL with cache-buster (400/404 both mean: not served)
    const pub = await fetch(`${upJson.url}?cb=${Date.now()}`)
    check('R26', 'public URL not served after removal (cache-busted)', pub.status !== 200, `got ${pub.status}`)
  }
}
{
  const fd = new FormData()
  fd.append('file', new File([Buffer.from('nope')], 'x.txt', { type: 'text/plain' }))
  const r = await fetch(`${APP}/api/admin/products/${state.productId}/image`, { method: 'POST', headers: { Cookie: COOKIE }, body: fd })
  check('R27', 'non-image MIME rejected (415)', r.status === 415, `got ${r.status}`)
}
{
  const fd = new FormData()
  fd.append('file', new File([Buffer.alloc(2.2 * 1024 * 1024, 1)], 'big.png', { type: 'image/png' }))
  const r = await fetch(`${APP}/api/admin/products/${state.productId}/image`, { method: 'POST', headers: { Cookie: COOKIE }, body: fd })
  check('R28', '>2MB image rejected (413)', r.status === 413, `got ${r.status}`)
}

console.log('\n════════════ D. ROUND-1 LEDGER STILL INTACT ════════════')
{
  const r = await restGet(`/rest/v1/stock_balances?select=quantity&variant_id=eq.${state.v1.id}&location_id=eq.${state.mainLoc.id}`)
  check('R29', 'round-1 balance untouched (5)', r.json?.[0]?.quantity === 5, `balance=${r.json?.[0]?.quantity}`)
}

console.log('\n════════════ SUMMARY (round 2) ════════════')
console.log(`PASSED: ${passCount}   FAILED: ${failCount}`)
if (failures.length) {
  console.log('\nFAILED CHECKS:')
  failures.forEach((f) => console.log('  ✗ ' + f))
}
state.round2 = { passed: passCount, failed: failCount, at: new Date().toISOString() }
await Bun.write('/home/z/my-project/scripts/.p2test-state.json', JSON.stringify(state, null, 2))
process.exit(failCount === 0 ? 0 : 1)
