/** Phase 6 cleanup: deactivate audit test entities (never hard-delete history). */
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  })
)
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${URL}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, text: await res.text() }
}

// 1) deactivate the test product + variant (history preserved)
console.log('product:', (await req('PATCH', '/rest/v1/products?product_code=eq.P6AUDIT', { is_active: false })).status)
console.log('variant:', (await req('PATCH', '/rest/v1/product_variants?sku=eq.P6-AUDIT-SHIRT-M', { is_active: false })).status)

// 2) deactivate pg6 audit users + ban auth
for (const email of ['pg6-admin@praveengarments.com', 'pg6-cashier@praveengarments.com']) {
  const list = await (await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: H })).json()
  const u = (list.users ?? []).find((x: any) => x.email === email)
  if (u) {
    await req('PUT', `/auth/v1/admin/users/${u.id}`, { ban_duration: '876000h' })
    console.log(`banned+deactivated: ${email}`, (await req('PATCH', `/rest/v1/profiles?id=eq.${u.id}`, { is_active: false })).status)
  }
}

// 3) deactivate STALE active test accounts from earlier phases (security hygiene;
//    the owner's praveen@ account is never touched)
for (const email of [
  'pg-phase3-cashier@praveengarments.com', 'pg-phase3-test@praveengarments.com',
  'pg-phase4-test@praveengarments.com',
]) {
  const list = await (await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: H })).json()
  const u = (list.users ?? []).find((x: any) => x.email === email)
  if (u) {
    await req('PUT', `/auth/v1/admin/users/${u.id}`, { ban_duration: '876000h' })
    console.log(`deactivated stale: ${email}`, (await req('PATCH', `/rest/v1/profiles?id=eq.${u.id}`, { is_active: false })).status)
  }
}

// final state
const profiles = await (await fetch(`${URL}/rest/v1/profiles?select=email,role,is_active&order=email`, { headers: H })).json()
console.log('\nFINAL CLOUD USER STATE:')
for (const p of profiles) console.log(`  ${p.is_active ? 'ACTIVE  ' : 'inactive'} ${p.role.padEnd(8)} ${p.email}`)
const prod = await (await fetch(`${URL}/rest/v1/products?product_code=eq.P6AUDIT&select=is_active`, { headers: H })).json()
console.log('P6AUDIT product active:', prod[0]?.is_active)
