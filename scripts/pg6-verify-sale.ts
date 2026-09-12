/** Phase 6: verify the browser-created sale chain on the CLOUD (read-only). */
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  })
)
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function get(path: string) {
  const res = await fetch(`${URL}${path}`, { headers: H })
  return res.json()
}

const sale = (await get(`/rest/v1/sales?sale_number=eq.INV-2026-000011&select=id,sale_number,status,grand_total,paid_amount,due_amount,payment_status,location_name,cashier_name`))[0]
console.log('SALE:', JSON.stringify(sale))
const items = await get(`/rest/v1/sale_items?sale_id=eq.${sale.id}&select=sku,quantity,unit_price,mrp,line_total`)
console.log('ITEMS:', JSON.stringify(items))
const pays = await get(`/rest/v1/sale_payments?sale_id=eq.${sale.id}&select=method,amount,cash_received,cash_change,is_credit`)
console.log('PAYMENTS:', JSON.stringify(pays))
const variant = (await get(`/rest/v1/product_variants?sku=eq.P6-AUDIT-SHIRT-M&select=id`))[0]
const bal = await get(`/rest/v1/stock_balances?variant_id=eq.${variant.id}&select=quantity,location_id`)
console.log('STOCK BALANCES:', JSON.stringify(bal))
const mv = await get(`/rest/v1/stock_movements?variant_id=eq.${variant.id}&reference_id=eq.${sale.id}&select=movement_type,quantity,balance_after,reference_type`)
console.log('MOVEMENTS for this sale:', JSON.stringify(mv))
const audit = await get(`/rest/v1/audit_logs?entity_id=eq.${sale.id}&action=eq.sale_created&select=action,metadata`)
console.log('AUDIT:', JSON.stringify(audit))
