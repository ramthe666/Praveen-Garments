#!/usr/bin/env bun
/**
 * Phase 4 read-only cloud probe: has migration 0009 been applied?
 * Uses the PostgREST OpenAPI catalog only — no write RPC is ever executed.
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

const specRes = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: H })
const spec = (await specRes.json().catch(() => null)) as any
if (specRes.status !== 200 || !spec?.paths) {
  console.error(`FATAL: could not read PostgREST catalog (status ${specRes.status})`)
  process.exit(1)
}
const pathNames = Object.keys(spec.paths) as string[]
const defs = Object.keys(spec.definitions ?? {}) as string[]
const rpcs = pathNames.filter((p) => p.startsWith('/rpc/'))

const wantedTables = [
  'customers', 'suppliers',
  'purchase_orders', 'purchase_order_items',
  'purchase_invoices', 'purchase_invoice_items',
  'customer_payments', 'customer_payment_allocations',
  'supplier_payments', 'supplier_payment_allocations',
  'sales_returns', 'sales_return_items',
  'purchase_returns', 'purchase_return_items',
  'exchanges', 'exchange_items_in', 'exchange_items_out',
  'expenses', 'expense_categories', 'expense_attachments',
]
console.log('== 0009 TABLES ==')
let miss = 0
for (const t of wantedTables) {
  const found = pathNames.includes(`/${t}`) && defs.includes(t)
  console.log(`${found ? '  OK ' : '  MISS'} ${t}`)
  if (!found) miss++
}

console.log('\n== 0009 RPCs (sample of key surface) ==')
const wantedRpcs = [
  'customers_page', 'customer_detail', 'record_customer_payment', 'customer_statement',
  'suppliers_page', 'supplier_detail',
  'create_purchase_order', 'receive_purchase_order', 'create_purchase_invoice',
  'record_supplier_payment', 'create_purchase_return',
  'create_sales_return', 'record_refund', 'create_exchange',
  'expenses_page', 'create_expense', 'decide_expense',
  'next_document_number',
]
for (const r of wantedRpcs) {
  const found = rpcs.includes(`/rpc/${r}`)
  console.log(`${found ? '  OK ' : '  MISS'} ${r}`)
  if (!found) miss++
}

// read-only settings probe
const sRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?select=key&key=like.returns*`, { headers: H })
const sData = sRes.ok ? await sRes.json() : []
console.log('\nreturns settings keys:', (sData as any[]).map((r) => r.key))

const bRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?select=key&key=like.expenses*`, { headers: H })
const bData = bRes.ok ? await bRes.json() : []
console.log('expenses settings keys:', (bData as any[]).map((r) => r.key))

const cRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?select=key&key=like.customers*`, { headers: H })
const cData = cRes.ok ? await cRes.json() : []
console.log('customers settings keys:', (cData as any[]).map((r) => r.key))

console.log(miss === 0 ? '\n=> 0009 APPLIED (fully present in catalog)' : `\n=> 0009 NOT (fully) APPLIED — ${miss} missing`)
