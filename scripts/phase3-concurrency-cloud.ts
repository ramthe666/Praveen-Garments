#!/usr/bin/env bun
/**
 * Cloud CONCURRENCY test — the last-unit double-sale guard.
 *
 * Two different cashiers fire create_sale at the SAME millisecond for the
 * same variant that has exactly 1 unit left. The engine must let EXACTLY ONE
 * succeed (row-locked stock upsert), reject the other with an insufficient
 * stock error, and leave the ledger with zero orphan rows.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const ADMIN_EMAIL = 'pg-phase3-test@praveengarments.com'
const ADMIN_PASSWORD = 'P3Test-ac43d031'
const CASHIER_EMAIL = 'pg-phase3-cashier@praveengarments.com'
const CASHIER_PASSWORD = 'P3Cash-b7e2m91x'

const VARIANT_ID = '827cb1a1-f854-4073-b11a-387dc4cf2d43' // P2TEST-SKU-005
const LOCATION_ID = '1786b200-9df9-405f-abb9-5c9d687e2a3a' // MAIN

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

// ---------------------------------------------------------------- helpers ---
async function json(path: string, init?: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}${path}`, init)
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function login(email: string, password: string) {
  const { status, body } = await json('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (status !== 200 || !body?.access_token) throw new Error(`login failed for ${email}: ${status}`)
  return body.access_token as string
}

async function rpc(token: string, fn: string, args: Record<string, unknown>) {
  return json(`/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
}

// ------------------------------------------------- 1. second test cashier ---
const createRes = await json('/auth/v1/admin/users', {
  method: 'POST',
  headers: svc,
  body: JSON.stringify({
    email: CASHIER_EMAIL,
    password: CASHIER_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: 'Phase 3 Cashier', app_role: 'cashier' },
  }),
})
const alreadyExists =
  /already/i.test(String(createRes.body?.message ?? createRes.body?.msg ?? '')) ||
  createRes.body?.error_code === 'email_exists'
if (createRes.status >= 400 && !alreadyExists) {
  console.error('cashier creation failed:', createRes.status, createRes.body)
  process.exit(1)
}
console.log(`1. cashier ready (${createRes.status === 201 ? 'created' : 'already exists'}): ${CASHIER_EMAIL}`)

// --------------------------------------------------------------- 2. logins ---
const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD)
const cashierToken = await login(CASHIER_EMAIL, CASHIER_PASSWORD)
console.log('2. both cashiers logged in (two independent sessions)')

// -------------------------------------------------- 3. stock := exactly 1 ---
// set_opening_stock refuses a second opening for this variant+location (the
// Phase 2 ledger already has one), so use the delta-based adjust_stock:
// current balance is 5 -> adjust by -4 to leave exactly 1 unit.
const setStock = await rpc(adminToken, 'adjust_stock', {
  p_variant_id: VARIANT_ID,
  p_location_id: LOCATION_ID,
  p_quantity: -4,
  p_reason: 'P3 concurrency E2E: set last unit',
})
console.log(`3. adjust_stock -4 -> 1 unit: status ${setStock.status}`)
if (setStock.status !== 200) {
  console.error(JSON.stringify(setStock.body).slice(0, 300))
  process.exit(1)
}

const bal = await json(`/rest/v1/stock_balances?select=quantity&variant_id=eq.${VARIANT_ID}&location_id=eq.${LOCATION_ID}`, { headers: svc })
console.log(`   balance now: ${JSON.stringify(bal.body)} (must be 1)`)
if (bal.body?.[0]?.quantity !== 1) { console.error('setup failed'); process.exit(1) }

// --------------------------------------------- 4. simultaneous create_sale ---
const salePayload = (variant: string) => ({
  items: [{ variant_id: variant, quantity: 1 }],
  payments: [{ method: 'Cash', amount: 949, cash_received: 1000 }],
  location_id: LOCATION_ID,
  notes: 'P3 cloud concurrency test — last unit',
})

const salesBefore = (await json('/rest/v1/sales?select=id', { headers: svc })).body.length

console.log('4. firing TWO create_sale calls at the same instant...')
const t0 = Date.now()
const [r1, r2] = await Promise.all([
  rpc(adminToken, 'create_sale', { p_payload: salePayload(VARIANT_ID) }),
  rpc(cashierToken, 'create_sale', { p_payload: salePayload(VARIANT_ID) }),
])
const dt = Date.now() - t0
console.log(`   both settled in ${dt}ms`)
console.log(`   cashier A (admin):    ${r1.status} ${JSON.stringify(r1.body).slice(0, 140)}`)
console.log(`   cashier B (cashier):  ${r2.status} ${JSON.stringify(r2.body).slice(0, 140)}`)

// ------------------------------------------------------------ 5. verdicts ---
const okA = r1.status === 200
const okB = r2.status === 200
const successes = [okA, okB].filter(Boolean).length
console.log(`5. successes = ${successes} (MUST be exactly 1)`)

const balAfter = await json(`/rest/v1/stock_balances?select=quantity&variant_id=eq.${VARIANT_ID}&location_id=eq.${LOCATION_ID}`, { headers: svc })
console.log(`   final balance: ${JSON.stringify(balAfter.body)} (MUST be 0)`)

const salesAfter = (await json('/rest/v1/sales?select=id', { headers: svc })).body.length
console.log(`   sales created: ${salesAfter - salesBefore} (MUST be 1)`)

const lastMove = await json(`/rest/v1/stock_movements?select=id,movement_type,quantity,balance_after,reason&variant_id=eq.${VARIANT_ID}&order=id.desc&limit=1`, { headers: svc })
console.log(`   last ledger row: ${JSON.stringify(lastMove.body?.[0])}`)

const loser = okA ? r2 : r1
const loserMsg = JSON.stringify(loser.body ?? {})
console.log(`   loser message mentions stock: ${/stock|available|insufficient/i.test(loserMsg) ? 'YES' : 'NO — ' + loserMsg.slice(0, 120)}`)

const pass =
  successes === 1 &&
  balAfter.body?.[0]?.quantity === 0 &&
  salesAfter - salesBefore === 1 &&
  /stock|available|insufficient/i.test(loserMsg)

console.log('\n' + (pass ? 'CONCURRENCY TEST PASSED — no oversell, no orphans.' : 'CONCURRENCY TEST FAILED.'))
process.exit(pass ? 0 : 1)
