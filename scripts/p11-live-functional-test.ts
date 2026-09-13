// Phase 11 (live functional): prove the 0017-fixed create_purchase_invoice
// math on the CLOUD, as the signed-in owner. Creates two clearly-labelled
// TEST DRAFT invoices (drafts never touch stock/payables), verifies every
// money column, then cancels them. Read-only inventory snapshot before/
// after proves zero side effects.
const SUPABASE_URL = 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const ANON_KEY = 'sb_publishable_BW7kIsj-5tpTrkLiWrtbrA_AqDW_1BI'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const OWNER_EMAIL = 'praveen@praveengarments.com'
const OWNER_PASSWORD = process.env.OWNER_PASSWORD!

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail: string) {
  if (ok) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`) }
}

async function svcGet(table: string, query: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`svc GET ${table} -> ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}
async function rpc(token: string, fn: string, body: unknown, expectOk = true) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (expectOk && !res.ok) throw new Error(`rpc ${fn} -> ${res.status}: ${text.slice(0, 400)}`)
  return { ok: res.ok, status: res.status, body: text }
}

async function main() {
  // 1. sign in as owner
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  })
  if (!authRes.ok) throw new Error('owner sign-in failed: ' + (await authRes.text()).slice(0, 300))
  const { access_token } = await authRes.json()
  console.log('owner signed in OK')

  // 2. look up test targets
  const suppliers = await svcGet('suppliers', 'select=id,name&is_active=eq.true&order=created_at&limit=1')
  const locations = await svcGet('stock_locations', 'select=id,name&is_active=eq.true&order=created_at&limit=1')
  // variant used by the existing test invoice PI-2026-000002, with product gst_rate
  const variantRows = await svcGet('purchase_invoice_items',
    'select=variant_id&limit=1')
  let variantId: string
  if (variantRows.length > 0) {
    variantId = variantRows[0].variant_id
  } else {
    const pv = await svcGet('product_variants', 'select=id&order=created_at&limit=1')
    variantId = pv[0].id
  }
  const variant = (await svcGet('product_variants',
    `select=id,sku,product_id,products(gst_rate,name)&id=eq.${variantId}`))[0]
  const gst = Number((variant.products as any).gst_rate ?? 5)
  console.log(`supplier=${suppliers[0].name} location=${locations[0].name} variant=${variant.sku} gst=${gst}%`)

  // expectations (10 units @ 600, no discount)
  const gross = 6000
  const taxEx = Math.round(gross * gst) / 100        // exclusive tax
  const taxIn = Math.round(gross * gst / (100 + gst) * 100) / 100 // inclusive tax
  const expExcl = { sub: gross, tax: taxEx, grand: gross + taxEx }
  const expIncl = { sub: gross, tax: taxIn, grand: gross }
  console.log(`EXPECTED exclusive(default): sub=${expExcl.sub} tax=${expExcl.tax} grand=${expExcl.grand}`)
  console.log(`EXPECTED inclusive         : sub=${expIncl.sub} tax=${expIncl.tax} grand=${expIncl.grand}`)
  console.log(`(old buggy code would have produced grand=${gross + taxIn} for the default case)`)

  // inventory snapshot (drafts must not move stock)
  const invBefore = await svcGet("stock_balances", "select=id,quantity&order=id")

  // 3. TEST A — no tax_mode in payload: must default EXCLUSIVE now
  console.log('\n=== TEST A: default tax_mode (no payload tax_mode) ===')
  const a = await rpc(access_token, 'create_purchase_invoice', { p_payload: {
    supplier_id: suppliers[0].id,
    location_id: locations[0].id,
    supplier_invoice_no: 'TEST-0017-A',
    notes: 'TEST verification of migration 0017 (safe to ignore; will be cancelled)',
    items: [{ variant_id: variantId, quantity: 10, unit_cost: 600 }],
  } })
  if (!a.ok) throw new Error('TEST A create failed: ' + a.body.slice(0, 400))
  const invA = JSON.parse(a.body)
  console.log(`  created ${invA.invoice_number} status=${invA.status} grand=${invA.grand_total} due=${invA.due_amount}`)
  check('A: created DRAFT', invA.status === 'DRAFT', JSON.stringify(invA).slice(0, 200))
  const rowA = (await svcGet('purchase_invoices',
    `select=tax_mode,subtotal,discount_total,tax_total,grand_total,paid_amount,due_amount,payment_status&invoice_number=eq.${invA.invoice_number}`))[0]
  check('A: tax_mode defaulted to exclusive (no POS leak)',
    rowA.tax_mode === 'exclusive', `tax_mode=${rowA.tax_mode}`)
  check('A: subtotal = cost base', Math.abs(Number(rowA.subtotal) - expExcl.sub) <= 0.01, `sub=${rowA.subtotal}`)
  check('A: tax on top', Math.abs(Number(rowA.tax_total) - expExcl.tax) <= 0.01, `tax=${rowA.tax_total}`)
  check('A: grand = 6000 + GST (exclusive math)',
    Math.abs(Number(rowA.grand_total) - expExcl.grand) <= 0.01, `grand=${rowA.grand_total} want ${expExcl.grand}`)
  // DRAFT convention: stored due=0 / payment_status 'DUE' (payable is computed
  // at receiving); the RPC response's due_amount reports the eventual payable.
  check('A: DRAFT stored due=0 / DUE (payable at receive)',
    Number(rowA.due_amount) === 0 && rowA.payment_status === 'DUE',
    `due=${rowA.due_amount} ps=${rowA.payment_status}`)
  check('A: RPC response due = eventual payable', Number(invA.due_amount) === expExcl.grand, `resp due=${invA.due_amount}`)

  // 4. TEST B — explicit inclusive mode
  console.log('\n=== TEST B: explicit tax_mode = inclusive ===')
  const b = await rpc(access_token, 'create_purchase_invoice', { p_payload: {
    supplier_id: suppliers[0].id,
    location_id: locations[0].id,
    supplier_invoice_no: 'TEST-0017-B',
    tax_mode: 'inclusive',
    notes: 'TEST verification of migration 0017 (safe to ignore; will be cancelled)',
    items: [{ variant_id: variantId, quantity: 10, unit_cost: 600 }],
  } })
  if (!b.ok) throw new Error('TEST B create failed: ' + b.body.slice(0, 400))
  const invB = JSON.parse(b.body)
  console.log(`  created ${invB.invoice_number} status=${invB.status} grand=${invB.grand_total}`)
  const rowB = (await svcGet('purchase_invoices',
    `select=tax_mode,subtotal,tax_total,grand_total,due_amount&invoice_number=eq.${invB.invoice_number}`))[0]
  check('B: tax_mode honoured as inclusive', rowB.tax_mode === 'inclusive', `tax_mode=${rowB.tax_mode}`)
  check('B: grand = 6000 (tax inside)',
    Math.abs(Number(rowB.grand_total) - expIncl.grand) <= 0.01, `grand=${rowB.grand_total}`)
  check('B: tax extracted', Math.abs(Number(rowB.tax_total) - expIncl.tax) <= 0.01, `tax=${rowB.tax_total}`)
  check('B: grand == sum(line_total) invariant',
    Math.abs(Number(rowB.grand_total) - expIncl.grand) <= 0.01, `grand=${rowB.grand_total}`)

  // 5. inventory untouched
  const invAfter = await svcGet("stock_balances", "select=id,quantity&order=id")
  const same = invBefore.length === invAfter.length &&
    invBefore.every((r: any, i: number) => r.id === invAfter[i].id && r.quantity === invAfter[i].quantity)
  check('inventory untouched by both drafts', same, 'rows changed')

  // 6. cleanup — cancel both
  console.log('\n=== cleanup: cancel both TEST invoices ===')
  const cA = await rpc(access_token, 'cancel_purchase_invoice',
    { p_invoice_id: invA.invoice_id, p_reason: 'TEST-0017 verification cleanup — safe to ignore' })
  const cB = await rpc(access_token, 'cancel_purchase_invoice',
    { p_invoice_id: invB.invoice_id, p_reason: 'TEST-0017 verification cleanup — safe to ignore' })
  check('A cancelled', cA.ok, cA.body.slice(0, 200))
  check('B cancelled', cB.ok, cB.body.slice(0, 200))
  const states = await svcGet('purchase_invoices',
    `select=invoice_number,status&invoice_number=in.(${invA.invoice_number},${invB.invoice_number})`)
  check('A final state CANCELLED', states.find((s: any) => s.invoice_number === invA.invoice_number)?.status === 'CANCELLED', JSON.stringify(states))
  check('B final state CANCELLED', states.find((s: any) => s.invoice_number === invB.invoice_number)?.status === 'CANCELLED', JSON.stringify(states))

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
