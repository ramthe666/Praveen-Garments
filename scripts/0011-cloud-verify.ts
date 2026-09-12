#!/usr/bin/env bun
/**
 * 0011 cloud E2E verification (READ-ONLY — no write RPC, no data changes).
 *
 * Verifies the deployed customer_statement() against the live cloud data by
 * independently recomputing every customer's closing balance from the raw
 * tables and comparing with the RPC output:
 *
 *   expected closing = Σ billed(COMPLETED sales)
 *                    − Σ customer_payments.amount
 *                    − Σ till payments (sale_payments written at checkout:
 *                        non-credit, method <> 'Store Credit', reference not
 *                        matching any CR receipt number = ledger mirrors)
 *                    − Σ sales_returns (applied_to_due + refund_amount)
 *
 * Also cross-checks the "dues correct everywhere" invariant:
 *   Σ due_amount = Σ billed − Σ all non-credit sale_payments (incl. mirrors)
 *                − Σ returns.applied_to_due
 * and asserts each statement's till_payment credit lines sum to the
 * customer's till total (deployed-fix detector: the pre-0011 function has
 * no till_payment lines and overstates closing by exactly the till total).
 *
 * Run: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *      bun run scripts/0011-cloud-verify.ts
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SERVICE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const H = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

// ---- fetch helpers (PostgREST pagination) --------------------------------
async function getAll(path: string): Promise<any[]> {
  const rows: any[] = []
  let offset = 0
  for (;;) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=1000&offset=${offset}`, { headers: H })
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`)
    const page = (await res.json()) as any[]
    rows.push(...page)
    if (page.length < 1000) return rows
    offset += 1000
  }
}
async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: H, body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(`rpc ${name} -> ${res.status}: ${await res.text()}`)
  return res.json()
}

// ---- load raw data --------------------------------------------------------
const customers = await getAll('customers?select=id,name,phone')
const sales = await getAll('sales?select=id,customer_id,sale_number,grand_total,paid_amount,due_amount,status,sale_date')
const salePayments = await getAll('sale_payments?select=id,sale_id,method,amount,reference,is_credit,created_at')
const custPayments = await getAll('customer_payments?select=id,receipt_number,customer_id,amount,allocated_amount,recorded_at')
const returns = await getAll('sales_returns?select=id,customer_id,return_number,applied_to_due,refund_amount,return_date')

console.log(`loaded: ${customers.length} customers, ${sales.length} sales, ${salePayments.length} sale_payments, ` +
            `${custPayments.length} customer_payments, ${returns.length} sales_returns`)

const saleById = new Map(sales.map(s => [s.id, s]))
const receiptNumbers = new Set(custPayments.map(cp => cp.receipt_number))

// per-customer aggregates from raw data
type Agg = {
  billed: number; dues: number; cpTotal: number; tillTotal: number
  mirrorTotal: number; creditMarkers: number; returnsTotal: number
  appliedToDue: number; allPayTotal: number
}
const aggs = new Map<string, Agg>()
function agg(id: string): Agg {
  let a = aggs.get(id)
  if (!a) { a = { billed: 0, dues: 0, cpTotal: 0, tillTotal: 0, mirrorTotal: 0, creditMarkers: 0, returnsTotal: 0, appliedToDue: 0, allPayTotal: 0 }; aggs.set(id, a) }
  return a
}
for (const s of sales) {
  if (!s.customer_id || s.status !== 'COMPLETED') continue
  const a = agg(s.customer_id)
  a.billed += Number(s.grand_total)
  a.dues += Number(s.due_amount)
}
for (const cp of custPayments) agg(cp.customer_id).cpTotal += Number(cp.amount)
for (const r of returns) {
  if (!r.customer_id) continue
  const a = agg(r.customer_id)
  a.returnsTotal += Number(r.applied_to_due) + Number(r.refund_amount)
  a.appliedToDue += Number(r.applied_to_due)
}
for (const sp of salePayments) {
  const s = saleById.get(sp.sale_id)
  if (!s?.customer_id || s.status !== 'COMPLETED') continue
  const a = agg(s.customer_id)
  const isMirror = sp.method === 'Store Credit' || (sp.reference != null && receiptNumbers.has(sp.reference))
  if (sp.is_credit) { a.creditMarkers += Number(sp.amount); continue }
  a.allPayTotal += Number(sp.amount)               // every non-credit row (mirrors included)
  if (!isMirror) a.tillTotal += Number(sp.amount)  // checkout-time payments only
}

// ---- per-customer verification -------------------------------------------
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`) }
}

console.log('\n== CUSTOMER STATEMENT AUDIT (every customer, live data) ==')
const interested: any[] = []
for (const c of customers) {
  const a = aggs.get(c.id) ?? { billed: 0, dues: 0, cpTotal: 0, tillTotal: 0, mirrorTotal: 0, creditMarkers: 0, returnsTotal: 0, appliedToDue: 0, allPayTotal: 0 }
  if (a.billed === 0 && a.cpTotal === 0 && a.tillTotal === 0 && a.returnsTotal === 0) continue // no activity
  const stmt = await rpc('customer_statement', { p_customer_id: c.id, p_from: null, p_to: null })
  const lines = (stmt.lines ?? []) as any[]
  const tillLines = lines.filter(l => l.kind === 'till_payment')
  const tillCredit = tillLines.reduce((s, l) => s + Number(l.credit), 0)
  const expectedClosing = a.billed - a.cpTotal - a.tillTotal - a.returnsTotal
  const expectedDues = a.billed - a.allPayTotal - a.appliedToDue
  const round = (n: number) => Math.round(n * 100) / 100

  const okClosing = Math.abs(Number(stmt.closing_balance) - round(expectedClosing)) < 0.01
  const okTillLines = Math.abs(tillCredit - round(a.tillTotal)) < 0.01 && (a.tillTotal === 0 ? tillLines.length === 0 : tillLines.length > 0)
  const okDues = Math.abs(round(a.dues) - round(expectedDues)) < 0.01
  const okOpening = Number(stmt.opening_balance) === 0

  const row = {
    customer: c.name, id: c.id,
    billed: round(a.billed), till_paid: round(a.tillTotal), receipts: round(a.cpTotal),
    returns: round(a.returnsTotal), dues: round(a.dues),
    stmt_closing: Number(stmt.closing_balance), expected: round(expectedClosing),
    till_lines: tillLines.length, ok: okClosing && okTillLines,
  }
  interested.push(row)
  const label = `${c.name}: closing ${row.stmt_closing} vs expected ${row.expected} (billed ${row.billed}, till ${row.till_paid}, receipts ${row.receipts}, returns ${row.returns}; dues ${row.dues})`
  check(label, okClosing && okTillLines && okOpening, { ...row, okDues, tillCredit, okOpening })
  if (!okDues) check(`${c.name}: dues invariant (raw tables)`, false, { dues: a.dues, expectedDues })
}

console.log('\n== SUMMARY TABLE ==')
for (const r of interested) console.log(JSON.stringify(r))

// deployed-fix detector: pre-0011 function has no till_payment lines at all
const anyTill = interested.some(r => r.till_lines > 0)
const totalTill = [...aggs.values()].reduce((s, a) => s + a.tillTotal, 0)
console.log(`\ntill payments across all customers: ${Math.round(totalTill * 100) / 100}`)
check('0011 is deployed (till_payment lines present where till payments exist)', anyTill || totalTill === 0)

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`)
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log('  -', f)
}
process.exit(fail ? 1 : 0)
