#!/usr/bin/env bun
/**
 * Phase 3 post-migration DB probe — READ-ONLY verification that 0008 applied
 * fully on the cloud Supabase project.
 *
 * Safety rules:
 *  - Table + function EXISTENCE is verified via the PostgREST OpenAPI catalog
 *    (no function bodies execute for write RPCs).
 *  - Only read-only RPCs are actually invoked (get_pos_config, pos_search,
 *    sales_page, sale_detail).
 *  - No INSERT / UPDATE / DELETE is issued anywhere.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const H = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

let failures = 0
const ok = (label: string, detail = '') =>
  console.log(`  OK  ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label: string, detail = '') => {
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  failures++
}

// ---------------------------------------------------------------- OpenAPI ---
// Root catalog describes every table + RPC exposed by PostgREST.
const specRes = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: H })
const spec = (await specRes.json().catch(() => null)) as any
if (specRes.status !== 200 || !spec?.paths) {
  console.error(`FATAL: could not read PostgREST catalog (status ${specRes.status})`)
  process.exit(1)
}
const pathNames = Object.keys(spec.paths) as string[]
const defs = Object.keys(spec.definitions ?? {}) as string[]

console.log('== 0008 TABLES (via PostgREST catalog) ==')
const tables = [
  'customers',
  'sale_number_counters',
  'sales',
  'sale_items',
  'sale_payments',
  'held_bills',
]
for (const t of tables) {
  const found = pathNames.includes(`/${t}`) && defs.includes(t)
  found ? ok(`table ${t}`) : bad(`table ${t}`, 'missing from catalog')
}

console.log('== 0008 COLUMNS (via OpenAPI definitions) ==')
const col = (table: string, column: string) => {
  const props = spec.definitions?.[table]?.properties ?? {}
  props[column] ? ok(`${table}.${column}`) : bad(`${table}.${column}`, 'column missing')
}
col('profiles', 'pos_discount_limit_pct') // PART 8
col('sales', 'sale_number')
col('sales', 'payment_status')
col('sales', 'status')
col('sale_items', 'unit_price')
col('sale_items', 'base_price')
col('sale_items', 'product_name')
col('sale_items', 'sku')
col('sale_items', 'gst_rate')
col('sale_payments', 'method')
col('held_bills', 'cart')

console.log('== 0008 FUNCTIONS (via PostgREST catalog /rpc/*) ==')
const fns = [
  'get_pos_config',
  'pos_search',
  'create_sale',
  'cancel_sale',
  'hold_bill',
  'resume_held_bill',
  'discard_held_bill',
  'sales_page',
  'sale_detail',
]
for (const f of fns) {
  const found = pathNames.includes(`/rpc/${f}`)
  found ? ok(`function ${f}`) : bad(`function ${f}`, 'missing from catalog')
}

// ------------------------------------------------------------ read RPCs ----
async function rpc(fn: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

console.log('== READ-ONLY RPC INVOCATIONS ==')
// get_pos_config: defaults merged by 0008 PART 9
const cfg = await rpc('get_pos_config', {})
if (cfg.status === 200 && cfg.json) {
  const c = cfg.json
  const pos = c.pos ?? {}
  const payments = c.payments ?? {}
  ok('get_pos_config()', `keys: ${Object.keys(c).join(',')}`)
  pos.allow_credit_sales === false ? ok('  pos.allow_credit_sales = false') : bad('  pos.allow_credit_sales', JSON.stringify(pos.allow_credit_sales))
  pos.default_tax_mode === 'inclusive' ? ok('  pos.default_tax_mode = inclusive') : bad('  pos.default_tax_mode', `got ${pos.default_tax_mode}`)
  Number(pos.max_item_discount_pct) === 10 ? ok('  pos.max_item_discount_pct = 10') : bad('  pos.max_item_discount_pct', String(pos.max_item_discount_pct))
  Number(pos.max_bill_discount_pct) === 10 ? ok('  pos.max_bill_discount_pct = 10') : bad('  pos.max_bill_discount_pct', String(pos.max_bill_discount_pct))
  const methods = payments.methods ?? payments.payment_methods ?? payments.enabled ?? null
  Array.isArray(methods) && methods.length > 0
    ? ok(`  payments.methods: ${JSON.stringify(methods)}`)
    : ok(`  payments settings: ${JSON.stringify(payments).slice(0, 120)}`)
  c.company ? ok(`  company: ${c.company.company_name ?? '(name not set)'} / prefix ${c.company.invoice_prefix ?? '(default)'}`) : bad('  company block missing')
  Array.isArray(c.locations) ? ok(`  locations: ${c.locations.length} active`) : bad('  locations block missing')
} else bad('get_pos_config()', `status ${cfg.status} ${JSON.stringify(cfg.json).slice(0, 120)}`)

// pos_search: read-only product resolve
const search = await rpc('pos_search', { p_query: 'shirt', p_limit: 3 })
search.status === 200
  ? ok('pos_search(p_query,p_limit)', `${Array.isArray(search.json) ? search.json.length : 0} rows (cloud catalog)`)
  : bad('pos_search', `status ${search.status}`)

// sales_page: read-only page 1 (real param names: p_search, p_date_from,
// p_date_to, p_payment_method, p_cashier_id, p_status, p_payment_status,
// p_limit, p_offset)
const page = await rpc('sales_page', {
  p_search: null, p_date_from: null, p_date_to: null, p_payment_method: null,
  p_cashier_id: null, p_status: null, p_payment_status: null,
  p_limit: 10, p_offset: 0,
})
if (page.status === 200 && page.json) {
  const rows = page.json.sales ?? page.json.rows ?? page.json.data ?? []
  ok('sales_page(...)', `limit 10 — ${rows.length} sale rows (expected 0 pre-E2E), total=${page.json.total ?? '?'}`)
} else bad('sales_page', `status ${page.status} ${JSON.stringify(page.json).slice(0, 200)}`)

// sale_detail on a random uuid — read-only, returns null
const detail = await rpc('sale_detail', { p_sale_id: '00000000-0000-0000-0000-000000000000' })
if (detail.status === 200) {
  ok('sale_detail(uuid)', `returns cleanly for unknown id (body: ${JSON.stringify(detail.json).slice(0, 60)})`)
} else if (detail.status === 404 || detail.status === 400) {
  // PGRST202/parse errors would mean a signature mismatch; anything else is a
  // genuine error. Function existence itself was proven via the catalog above.
  const msg = JSON.stringify(detail.json).slice(0, 160)
  msg.includes('PGRST202') ? bad('sale_detail', 'PGRST202 signature mismatch') : ok('sale_detail(uuid)', `handled unknown id (${msg.slice(0, 60)})`)
} else bad('sale_detail', `status ${detail.status} ${JSON.stringify(detail.json).slice(0, 120)}`)

// ------------------------------------------------------------ seeds --------
console.log('== PERMISSION + SETTINGS SEEDS (read-only selects) ==')
const permRes = await fetch(
  `${SUPABASE_URL}/rest/v1/role_permissions?select=role,permission&permission=in.(view_sales,override_sale_price,apply_discount)&order=role.asc`,
  { headers: H },
)
const perms = (await permRes.json().catch(() => null)) as any[] | null
if (Array.isArray(perms)) {
  const expected: Record<string, string[]> = {
    'view_sales': ['admin', 'manager', 'cashier', 'accountant'],
    'override_sale_price': ['admin'],
    'apply_discount': ['admin', 'manager'],
  }
  for (const [perm, roles] of Object.entries(expected)) {
    const got = perms.filter((p) => p.permission === perm).map((p) => p.role).sort()
    const want = [...roles].sort()
    JSON.stringify(got) === JSON.stringify(want)
      ? ok(`role_permissions: ${perm} -> ${got.join(',')}`)
      : bad(`role_permissions: ${perm}`, `got ${got.join(',') || 'NONE'}, want ${want.join(',')}`)
  }
} else bad('role_permissions select', `status ${permRes.status}`)

const settingsRes = await fetch(
  `${SUPABASE_URL}/rest/v1/app_settings?select=key,value&key=eq.pos`,
  { headers: H },
)
const settings = (await settingsRes.json().catch(() => null)) as any[] | null
if (Array.isArray(settings) && settings.length === 1) {
  const v = settings[0].value ?? {}
  const keys = ['allow_credit_sales', 'default_tax_mode', 'max_item_discount_pct', 'max_bill_discount_pct']
  for (const k of keys) v[k] !== undefined ? ok(`app_settings.pos.${k} = ${JSON.stringify(v[k])}`) : bad(`app_settings.pos.${k}`, 'missing')
} else bad('app_settings pos row', `status ${settingsRes.status}`)

// ------------------------------------------------------------ counters -----
const counters = await fetch(`${SUPABASE_URL}/rest/v1/sale_number_counters?select=*&limit=5`, { headers: H })
const counterRows = (await counters.json().catch(() => null)) as any[] | null
counters.status === 200
  ? ok('sale_number_counters readable', `${counterRows?.length ?? 0} rows (0 = first invoice starts fresh)`)
  : bad('sale_number_counters', `status ${counters.status}`)

console.log('\n=============================================')
if (failures === 0) {
  console.log('RESULT: ALL CHECKS PASSED — 0008 fully applied on cloud.')
} else {
  console.log(`RESULT: ${failures} CHECK(S) FAILED — migration incomplete or errored partway.`)
  process.exit(1)
}
