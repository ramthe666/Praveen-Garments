#!/usr/bin/env bun
/**
 * READ-ONLY E2E planning survey: what products / variants / stock exist in the
 * cloud, and is the Phase 3 test admin profile active with the right role?
 * (No writes.)
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

const get = async (path: string) => {
  const res = await fetch(`${SUPABASE_URL}${path}`, { headers: H })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// 1. Products
const { body: products } = await get('/rest/v1/products?select=id,name,product_code,is_active&order=product_code.asc&limit=30')
console.log(`PRODUCTS (${products?.length ?? 0}):`)
for (const p of products ?? []) console.log(`  ${p.product_code} | ${p.name} | active=${p.is_active} | ${p.id}`)

// 2. Variants of active products
const { body: variants } = await get('/rest/v1/product_variants?select=id,product_id,sku,barcode,mrp,selling_price,is_active,product:products!inner(product_code,name,is_active)&product.is_active=eq.true&order=sku.asc&limit=50')
console.log(`\nVARIANTS under active products (${variants?.length ?? 0}):`)
for (const v of variants ?? []) console.log(`  ${v.sku} | ${v.product.product_code} ${v.product.name} | mrp=${v.mrp} selling=${v.selling_price} | barcode=${v.barcode ?? '-'}`)

// 3. Stock balances
const { body: stock } = await get('/rest/v1/stock_balances?select=variant_id,location_id,quantity,variant:product_variants!inner(sku),location:stock_locations!inner(name,code)&order=variant_id.asc&limit=60')
console.log(`\nSTOCK BALANCES (${stock?.length ?? 0}):`)
for (const s of stock ?? []) console.log(`  ${s.variant?.sku ?? s.variant_id} @ ${s.location?.code ?? s.location_id} (${s.location?.name}) = ${s.quantity}`)

// 4. Test admin profile
const { body: profiles } = await get(`/rest/v1/profiles?select=id,full_name,role,is_active,pos_discount_limit_pct,email&order=created_at.asc`)
console.log(`\nPROFILES (${profiles?.length ?? 0}):`)
for (const pr of profiles ?? []) console.log(`  ${pr.email ?? pr.id} | ${pr.full_name} | role=${pr.role} | active=${pr.is_active} | pos_discount_limit=${pr.pos_discount_limit_pct}`)

// 5. Stock locations
const { body: locs } = await get('/rest/v1/stock_locations?select=id,name,code,location_type,is_active&order=code')
console.log(`\nLOCATIONS (${locs?.length ?? 0}):`)
for (const l of locs ?? []) console.log(`  ${l.code} | ${l.name} | ${l.location_type} | active=${l.is_active} | ${l.id}`)

// 6. Existing customers
const { body: cust } = await get('/rest/v1/customers?select=id,name,phone,is_active&limit=10')
console.log(`\nCUSTOMERS (${cust?.length ?? 0}):`)
for (const c of cust ?? []) console.log(`  ${c.name} | ${c.phone} | active=${c.is_active}`)
