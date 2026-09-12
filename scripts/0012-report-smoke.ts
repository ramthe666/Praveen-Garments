#!/usr/bin/env bun
/**
 * 0012 report RPC smoke (READ-ONLY — no writes, no data changes).
 * Calls every Phase 5 report RPC on the live cloud with default-style args
 * (exactly what the app sends on first load) and reports status + error text.
 * Goal: reproduce the single error page the user reported.
 *
 * Run: cd Praveen-Garments && set -a && . ./.env.local && set +a && \
 *      bun run scripts/0012-report-smoke.ts
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!SERVICE_KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

const calls: [string, Record<string, unknown>][] = [
  ['dashboard_summary', { p_from: null, p_to: null }],
  ['sales_report', { p_date_from: null, p_date_to: null, p_search: null, p_customer_id: null, p_cashier_id: null, p_payment_method: null, p_variant_id: null, p_category_id: null, p_brand_id: null, p_location_id: null, p_status: 'COMPLETED', p_sort: 'date_desc', p_limit: 25, p_offset: 0 }],
  ['product_sales_report', { p_date_from: null, p_date_to: null, p_search: null, p_category_id: null, p_brand_id: null, p_variant_id: null, p_sort: 'revenue_desc', p_limit: 25, p_offset: 0 }],
  ['catalog_performance_report', { p_date_from: null, p_date_to: null, p_group_by: 'category' }],
  ['payment_report', { p_date_from: null, p_date_to: null }],
  ['gst_report', { p_date_from: null, p_date_to: null }],
  ['profit_report', { p_date_from: null, p_date_to: null }],
  ['stock_valuation_report', { p_location_id: null, p_category_id: null, p_brand_id: null, p_search: null, p_sort: 'cost_desc', p_limit: 25, p_offset: 0 }],
  ['stock_performance_report', { p_date_from: null, p_date_to: null, p_class: null, p_search: null, p_sort: 'qty_desc', p_limit: 25, p_offset: 0 }],
  ['purchase_report', { p_date_from: null, p_date_to: null, p_search: null, p_supplier_id: null, p_status: 'RECEIVED', p_payment_status: null, p_sort: 'date_desc', p_limit: 25, p_offset: 0 }],
  ['supplier_report', { p_date_from: null, p_date_to: null, p_search: null, p_sort: 'purchases_desc', p_limit: 25, p_offset: 0 }],
  ['customer_report', { p_date_from: null, p_date_to: null, p_search: null, p_type: null, p_sort: 'purchases_desc', p_limit: 25, p_offset: 0 }],
  ['expense_report', { p_date_from: null, p_date_to: null }],
  ['returns_report', { p_date_from: null, p_date_to: null }],
  ['cash_report', { p_date: null }],
  ['audit_page', { p_search: null, p_action: null, p_user_id: null, p_date_from: null, p_date_to: null, p_entity_type: null, p_limit: 25, p_offset: 0 }],
]

let failed = 0
for (const [name, args] of calls) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: H, body: JSON.stringify(args) })
    const text = await res.text()
    if (res.ok) {
      console.log(`OK   ${name} -> ${text.slice(0, 200)}`)
    } else {
      failed++
      console.log(`ERR  ${name} -> HTTP ${res.status}: ${text.slice(0, 600)}`)
    }
  } catch (e: any) {
    failed++
    console.log(`ERR  ${name} -> fetch failed: ${e.message}`)
  }
}

// app users + permission matrix (diagnosis context for logged-in gates)
async function getAll(path: string): Promise<any[]> {
  const rows: any[] = []
  let offset = 0
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=1000&offset=${offset}`, { headers: H })
    if (!res.ok) { console.log(`(skipping ${path}: HTTP ${res.status} ${await res.text().then(t => t.slice(0, 120))})`); return [] }
    const page = await res.json()
    rows.push(...page)
    if (page.length < 1000) return rows
    offset += 1000
  }
}
const profiles = await getAll('profiles?select=*')
console.log(`\nprofiles on cloud: ${profiles.length}`)
for (const p of profiles) {
  const role = p.role ?? p.app_role ?? p.roles ?? '(no role column)'
  console.log(`  - ${p.id} role=${role} active=${p.is_active ?? '?'} name=${p.full_name ?? p.display_name ?? ''}`)
}
const rolePerms = await getAll('role_permissions?select=*')
console.log(`role_permissions rows: ${rolePerms.length}`)
const byRole = new Map<string, string[]>()
for (const rp of rolePerms) {
  const role = rp.role ?? rp.role_key ?? '?'
  const perm = rp.permission ?? rp.permission_code ?? '?'
  byRole.set(role, [...(byRole.get(role) ?? []), perm])
}
for (const [role, perms] of byRole) console.log(`  ${role}: ${perms.join(', ')}`)

console.log(`\n== SMOKE RESULT: ${failed} of ${calls.length} RPCs failed ==`)
process.exit(failed ? 1 : 0)
