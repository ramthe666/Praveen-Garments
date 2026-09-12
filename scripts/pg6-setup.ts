/**
 * Phase 6 browser-E2E setup (CLOUD, service-role):
 * - creates two clearly-labelled temp users (admin + cashier)
 * - creates one clearly-labelled test product + variant (barcode/QR) + opening stock
 * Writes ONLY new rows; no existing data touched. Users/products are
 * deactivated/removed in pg6-cleanup.ts after the audit.
 *
 * Run: cd Praveen-Garments && bun run scripts/pg6-setup.ts
 */
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

async function j(method: string, path: string, body?: unknown, prefer?: string) {
  const headers = { ...H, ...(prefer ? { Prefer: prefer } : {}) }
  const res = await fetch(`${URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* non-json */ }
  return { status: res.status, json, text }
}

const ADMIN_EMAIL = 'pg6-admin@praveengarments.com'
const CASHIER_EMAIL = 'pg6-cashier@praveengarments.com'
const PASSWORD = 'Phase6Audit!2026'

async function upsertUser(email: string, name: string, role: string) {
  // find existing (re-runnability) — filter client-side; the server-side email filter is unreliable
  const list = await j('GET', '/auth/v1/admin/users?per_page=200')
  const existing = (list.json?.users ?? []).find((u: any) => u.email === email)
  let id: string
  if (existing) {
    id = existing.id
    await j('PUT', '/auth/v1/admin/users/' + id, { email_confirm: true, ban_duration: 'none' })
  } else {
    const created = await j('POST', '/auth/v1/admin/users', {
      email, password: PASSWORD, email_confirm: true,
      user_metadata: { app_role: role, full_name: name },
    })
    if (created.status !== 200) throw new Error(`create user failed: ${created.text}`)
    id = created.json.id
  }
  await j('POST', `/rest/v1/profiles?on_conflict=id`, { id, email, full_name: name, role, is_active: true })
  return id
}

const adminId = await upsertUser(ADMIN_EMAIL, 'Phase6 Audit Admin', 'admin')
const cashierId = await upsertUser(CASHIER_EMAIL, 'Phase6 Audit Cashier', 'cashier')
console.log('admin:', adminId)
console.log('cashier:', cashierId)

// category (idempotent by name)
let cat = (await j('GET', `/rest/v1/categories?name=eq.Audit&select=id`)).json?.[0]
if (!cat) {
  const c = await j('POST', '/rest/v1/categories', { name: 'Audit', is_active: true })
  cat = c.json?.[0] ?? (await j('GET', `/rest/v1/categories?name=eq.Audit&select=id`)).json?.[0]
}
console.log('category:', cat?.id)

// test product + variant (idempotent by product_code)
let prod = (await j('GET', `/rest/v1/products?product_code=eq.P6AUDIT&select=id`)).json?.[0]
if (!prod) {
  const created = await j('POST', '/rest/v1/products', {
    name: 'Phase6 Audit Shirt', product_code: 'P6AUDIT', gender: 'men',
    category_id: cat.id, gst_rate: 5, mrp: 1499, selling_price: 999, hsn_code: '6205',
  }, 'return=representation')
  if (created.status !== 201) throw new Error('product create failed: ' + created.text)
  prod = created.json?.[0] ?? (await j('GET', `/rest/v1/products?product_code=eq.P6AUDIT&select=id`)).json?.[0]
}
const productId = prod.id
console.log('product:', productId)

// variant (idempotent by sku)
let variant = (await j('GET', `/rest/v1/product_variants?sku=eq.P6-AUDIT-SHIRT-M&select=id`)).json?.[0]
if (!variant) {
  const created = await j('POST', `/rest/v1/product_variants`, {
    product_id: productId, sku: 'P6-AUDIT-SHIRT-M',
    barcode: '2900000000111', qr_identifier: 'P6QRTEST01',
    selling_price: 999, mrp: 1499, is_active: true,
  }, 'return=representation')
  if (created.status !== 201) throw new Error('variant create failed: ' + created.text)
  variant = created.json?.[0] ?? (await j('GET', `/rest/v1/product_variants?sku=eq.P6-AUDIT-SHIRT-M&select=id`)).json?.[0]
}
const variantId = variant.id
console.log('variant:', variantId)

// Main Store location
const loc = (await j('GET', `/rest/v1/stock_locations?code=eq.MAIN&select=id,name`)).json?.[0]
console.log('main location:', loc?.id, loc?.name)

// opening stock if none
const bal = (await j('GET', `/rest/v1/stock_balances?variant_id=eq.${variantId}&location_id=eq.${loc.id}&select=quantity`)).json?.[0]
if (!bal) {
  const r = await j('POST', '/rest/v1/rpc/set_opening_stock', {
    p_variant_id: variantId, p_location_id: loc.id, p_quantity: 10,
    p_reason: 'Phase6 audit E2E stock', p_user_email: 'pg6-admin@praveengarments.com',
  })
  if (r.status !== 200) throw new Error('opening stock failed: ' + r.text)
}
const bal2 = (await j('GET', `/rest/v1/stock_balances?variant_id=eq.${variantId}&location_id=eq.${loc.id}&select=quantity`)).json?.[0]
console.log('stock after setup:', bal2?.quantity)

// company settings sanity (invoice fields exist)
const company = (await j('GET', '/rest/v1/company_settings?select=company_name,gstin,state,invoice_prefix&limit=1')).json?.[0]
console.log('company:', company)
console.log('\nSETUP COMPLETE — login:', ADMIN_EMAIL, '/', PASSWORD)
