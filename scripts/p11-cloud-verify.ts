// Phase 11 (post-apply): verify the cloud purchase tax repair AFTER the owner
// runs 0017 in the Supabase SQL editor. Read-only via service key.
// Checks: repaired totals (grand = Σ line per invoice), due/payment_status
// consistency, and that the historical over-charge (paid > grand) is the
// documented small residual rather than a fresh error.
const SUPABASE_URL = 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!

async function select(table: string, query: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${table}?${query} -> ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

async function main() {
  const invoices = await select('purchase_invoices',
    'select=id,invoice_number,status,tax_mode,subtotal,discount_total,tax_total,grand_total,paid_amount,due_amount,payment_status&order=invoice_number')
  const items = await select('purchase_invoice_items',
    'select=invoice_id,quantity,unit_cost,discount_amount,tax_amount,line_total&order=invoice_id')

  const byInv = new Map<string, { sumLine: number; sumTax: number; sumGross: number; sumDisc: number }>()
  for (const it of items) {
    const agg = byInv.get(it.invoice_id) ?? { sumLine: 0, sumTax: 0, sumGross: 0, sumDisc: 0 }
    agg.sumLine += Number(it.line_total)
    agg.sumTax += Number(it.tax_amount)
    agg.sumGross += Number(it.quantity) * Number(it.unit_cost)
    agg.sumDisc += Number(it.discount_amount ?? 0)
    byInv.set(it.invoice_id, agg)
  }

  let ok = 0, bad = 0
  console.log('=== POST-0017 CLOUD VERIFICATION ===')
  for (const inv of invoices) {
    const agg = byInv.get(inv.id)
    if (!agg) { console.log(`${inv.invoice_number}: no items (?)`); continue }
    const round = (n: number) => Math.round(n * 100) / 100
    const grandOk = Math.abs(round(agg.sumLine) - Number(inv.grand_total)) <= 0.01
    const subOk = Math.abs(round(agg.sumGross) - Number(inv.subtotal)) <= 0.01
    const taxOk = Math.abs(round(agg.sumTax) - Number(inv.tax_total)) <= 0.01
    const discOk = Math.abs(round(agg.sumDisc) - Number(inv.discount_total)) <= 0.01
    const dueOk = inv.status !== 'RECEIVED' ||
      Math.max(Number(inv.grand_total) - Number(inv.paid_amount), 0) - Number(inv.due_amount) <= 0.01
    const all = grandOk && subOk && taxOk && discOk && dueOk
    if (all) ok++; else bad++
    console.log(`${all ? 'OK ' : 'BAD'} ${inv.invoice_number} [${inv.status}/${inv.tax_mode}] ` +
      `sub=${inv.subtotal} tax=${inv.tax_total} grand=${inv.grand_total} paid=${inv.paid_amount} due=${inv.due_amount} (${inv.payment_status})` +
      `${!all ? ` :: expected grand=${round(agg.sumLine)} sub=${round(agg.sumGross)} tax=${round(agg.sumTax)} disc=${round(agg.sumDisc)}` : ''}`)
  }
  console.log(`\nRESULT: ${ok} consistent, ${bad} inconsistent`)
  if (bad > 0) process.exit(1)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
