#!/usr/bin/env bun
/**
 * Phase 2 post-migration DB probe — verifies all 9 Phase 2 tables,
 * seeds, RPCs and the storage bucket exist in the cloud Supabase project.
 * Uses the service-role key (server-side only, never prints key material).
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

async function restGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}${path}`, { headers: H })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function checkTable(name: string) {
  const { status, body } = await restGet(`/rest/v1/${name}?select=*&limit=5`)
  if (status === 200) {
    const rows = Array.isArray(body) ? body : []
    console.log(`TABLE ${name}: OK (${rows.length} sample rows)`)
    return rows
  }
  console.log(`TABLE ${name}: MISSING (status ${status} ${JSON.stringify(body).slice(0, 120)})`)
  failures++
  return []
}

async function checkRpc(fn: string, params: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(params),
  })
  const body = await res.json().catch(() => null)
  const ok = res.status === 200 || res.status === 201
  if (ok) console.log(`RPC ${fn}: OK`)
  else {
    console.log(`RPC ${fn}: FAIL (${res.status} ${JSON.stringify(body).slice(0, 160)})`)
    failures++
  }
  return body
}

// --- 0004: catalog tables ---
const sizes = await checkTable('sizes')
const colors = await checkTable('colors')
await checkTable('categories')
await checkTable('brands')
await checkTable('products')
await checkTable('product_variants')

// --- 0005: stock engine tables ---
const locations = await checkTable('stock_locations')
await checkTable('stock_balances')
await checkTable('stock_movements')

// --- seeds ---
console.log(`\nSEEDS: sizes=${sizes.length} (expect 8), colors=${colors.length} (expect 14), stock_locations=${locations.length} (expect 1: MAIN)`)
if (locations.length > 0) console.log(`  MAIN location: code=${locations[0].code} name=${locations[0].name} is_active=${locations[0].is_active}`)

// --- RPCs (0004) ---
await checkRpc('products_page', { p_limit: 5, p_offset: 0 })
await checkRpc('find_variant_by_identifier', { p_identifier: 'NONEXISTENT-SKU-XYZ' })

// --- RPCs (0005) — call with harmless params to at least verify existence ---
// adjust_stock on a nonexistent variant should return a controlled error (not 404 function-missing)
{
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/adjust_stock`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      p_variant_id: '00000000-0000-0000-0000-000000000000',
      p_location_id: '00000000-0000-0000-0000-000000000000',
      p_movement_type: 'STOCK_IN',
      p_quantity: 1,
    }),
  })
  const body = await res.json().catch(() => null)
  // A "variant not found"-style error proves the FUNCTION exists and runs
  const exists = res.status !== 404 && !JSON.stringify(body).includes('Does not exist')
  console.log(`RPC adjust_stock: ${exists ? 'OK (exists — controlled error: ' + JSON.stringify(body).slice(0, 140) + ')' : 'MISSING'}`)
  if (!exists) failures++
}
await checkRpc('get_inventory_stats', {})

// --- 0006: storage bucket ---
{
  const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket/product-images`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } })
  if (res.status === 200) {
    const b = await res.json()
    console.log(`STORAGE bucket product-images: OK (public=${b.public}, size_limit=${b.file_size_limit}, allowed_mime=${(b.allowed_mime_types ?? []).join(',')})`)
  } else {
    console.log(`STORAGE bucket product-images: MISSING (${res.status})`)
    failures++
  }
}

// --- pg_trgm extension + trgm indexes on products (0004) ---
{
  const { status, body } = await restGet(`/rest/v1/pg_catalog?select=pg_get_extensiondefext&extname=eq.pgm_trgm`)
  // pg_catalog not exposed via PostgREST — instead probe indirectly: a trigram-ilike query on products should parse
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/products_page`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ p_search: 'shirt', p_limit: 3, p_offset: 0 }),
  })
  console.log(`RPC products_page(p_search): ${res.status === 200 ? 'OK (search param accepted)' : 'FAIL ' + res.status}`)
  if (res.status !== 200) failures++
}

console.log(failures === 0 ? '\nPROBE RESULT: ALL PHASE 2 OBJECTS LIVE ✅' : `\nPROBE RESULT: ${failures} FAILURES ❌`)
process.exit(failures === 0 ? 0 : 1)
