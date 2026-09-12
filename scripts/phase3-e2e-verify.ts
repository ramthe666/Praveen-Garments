#!/usr/bin/env bun
/**
 * READ-ONLY verification of the E2E sale: checks every table create_sale
 * should have touched — sale row, item snapshots, payments, stock balances,
 * stock movement ledger, audit log, invoice counter.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }
const get = async (path: string) => (await fetch(`${SUPABASE_URL}${path}`, { headers: H })).json()

const sale = (await get('/rest/v1/sales?select=*&order=created_at.desc&limit=1'))[0]
console.log('=== SALE ROW ===')
console.log(JSON.stringify(sale, null, 2))

if (sale) {
  console.log('\n=== SALE ITEMS (snapshots) ===')
  const items = await get(`/rest/v1/sale_items?select=*&sale_id=eq.${sale.id}`)
  for (const i of items) console.log(JSON.stringify(i))

  console.log('\n=== SALE PAYMENTS ===')
  const pays = await get(`/rest/v1/sale_payments?select=*&sale_id=eq.${sale.id}`)
  for (const p of pays) console.log(JSON.stringify(p))

  console.log('\n=== STOCK MOVEMENTS (last 3) ===')
  const moves = await get('/rest/v1/stock_movements?select=*&order=created_at.desc&limit=3')
  for (const m of moves) console.log(JSON.stringify(m))

  console.log('\n=== COUNTER ===')
  const counters = await get('/rest/v1/sale_number_counters?select=*')
  console.log(JSON.stringify(counters))

  console.log('\n=== AUDIT (last 5) ===')
  const audits = await get('/rest/v1/audit_logs?select=*&order=created_at.desc&limit=5')
  for (const a of audits) console.log(JSON.stringify(a))
}

console.log('\n=== STOCK BALANCE SKU-005 @ MAIN ===')
const v = (await get('/rest/v1/product_variants?select=id&sku=eq.P2TEST-SKU-005'))[0]
const loc = (await get('/rest/v1/stock_locations?select=id&code=eq.MAIN'))[0]
const bal = await get(`/rest/v1/stock_balances?select=quantity&variant_id=eq.${v.id}&location_id=eq.${loc.id}`)
console.log('quantity =', JSON.stringify(bal), '(expected 3 after selling 2 of 5)')

console.log('\n=== CUSTOMERS ===')
const cust = await get('/rest/v1/customers?select=*')
console.log(JSON.stringify(cust))
