/**
 * Phase 11 generator: 0017_phase11_purchase_tax_fix.sql
 *
 * Extracts create_purchase_invoice VERBATIM from 0009 and applies six
 * surgical edits (P9-BUG-2: purchase invoice tax double-count):
 *   E1  declare v_grand
 *   E2  tax_mode default: 'exclusive' (cost-side document), no longer
 *       inherits the pos SALES default_tax_mode
 *   E3  subtotal accumulates Σ gross (PO convention) + v_grand accumulates
 *       Σ line_total
 *   E4  INSERT grand_total = v_grand
 *   E5  audit metadata grand_total = v_grand
 *   E6  return grand/due = v_grand
 * plus a data-repair block (recompute document totals of existing
 * non-cancelled invoices from their — always mode-correct — item rows) and
 * the verbatim grants.
 *
 * Run: bun scripts/p11-gen-0017.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'supabase/migrations/0009_phase4_business_operations.sql'
const OUT = 'supabase/migrations/0017_phase11_purchase_tax_fix.sql'

const src = readFileSync(SRC, 'utf8')

// ---- verbatim extract: create_purchase_invoice --------------------------
const START = 'create or replace function public.create_purchase_invoice(p_payload jsonb)'
const startIdx = src.indexOf(START)
if (startIdx < 0) throw new Error('function start not found')
const endMarker = 'end $$;'
const endIdx = src.indexOf(endMarker, startIdx)
if (endIdx < 0) throw new Error('function end not found')
let fn = src.slice(startIdx, endIdx + endMarker.length)
const original = fn

// ---- surgical edits (each must match EXACTLY once) ----------------------
function replaceOnce(name: string, from: string, to: string) {
  const n = fn.split(from).length - 1
  if (n !== 1) throw new Error(`edit ${name}: expected 1 occurrence, found ${n}`)
  fn = fn.replace(from, to)
}

// E1 — declare v_grand
replaceOnce('E1 declare v_grand',
`  v_subtotal numeric := 0; v_disc_total numeric := 0; v_tax_total numeric := 0;
  v_tax_enabled boolean; v_default_rate numeric;`,
`  v_subtotal numeric := 0; v_disc_total numeric := 0; v_tax_total numeric := 0;
  v_grand    numeric := 0;
  v_tax_enabled boolean; v_default_rate numeric;`)

// E2 — tax_mode resolution: purchases are cost-side documents
replaceOnce('E2 tax_mode default',
`  v_tax_mode := coalesce(nullif(p_payload ->> 'tax_mode', ''),
                         nullif((select value ->> 'default_tax_mode'
                                 from public.app_settings where key = 'pos'), ''),
                         'inclusive');`,
`  -- 0017: a purchase invoice is a COST-side document — the entered unit cost
  -- is the pre-tax cost and GST is added on top, exactly like purchase orders
  -- and the app's purchase UIs ("tax added by the server"). The POS
  -- default_tax_mode is a SALES price setting (MRP-style) and must never leak
  -- into supplier bills. An explicit payload tax_mode is still honoured
  -- ('inclusive' = the entered costs already contain the GST).
  v_tax_mode := coalesce(nullif(p_payload ->> 'tax_mode', ''), 'exclusive');`)

// E3 — subtotal accumulates gross (PO convention); v_grand accumulates lines
replaceOnce('E3 accumulate gross + grand',
`    v_subtotal := round(v_subtotal + v_line, 2);
    v_disc_total := round(v_disc_total + v_disc, 2);
    v_tax_total := round(v_tax_total + v_taxamt, 2);`,
`    -- 0017: subtotal is the pre-discount cost base (Σ gross) — the same
    -- convention as purchase orders — NOT the tax-inclusive line total.
    -- v_grand accumulates the line totals, which are mode-correct by
    -- construction (inclusive: tax inside the line; exclusive: tax on top),
    -- so grand_total = Σ line_total in BOTH modes. This is the exact value
    -- purchase-return credits and FIFO payments are computed against.
    v_subtotal := round(v_subtotal + v_gross, 2);
    v_grand    := round(v_grand + v_line, 2);
    v_disc_total := round(v_disc_total + v_disc, 2);
    v_tax_total := round(v_tax_total + v_taxamt, 2);`)

// E4 — INSERT grand_total
replaceOnce('E4 insert grand',
`    'DRAFT', v_subtotal, v_disc_total, v_tax_total,
    round(v_subtotal - v_disc_total + v_tax_total, 2),`,
`    'DRAFT', v_subtotal, v_disc_total, v_tax_total,
    v_grand,`)

// E5 — audit metadata grand_total
replaceOnce('E5 audit grand',
`            'items', jsonb_array_length(v_items),
            'grand_total', round(v_subtotal - v_disc_total + v_tax_total, 2),
            'status', v_status`,
`            'items', jsonb_array_length(v_items),
            'grand_total', v_grand,
            'status', v_status`)

// E6 — return object
replaceOnce('E6 return grand/due',
`    'grand_total', round(v_subtotal - v_disc_total + v_tax_total, 2),
    'due_amount', round(v_subtotal - v_disc_total + v_tax_total, 2),
    'result', v_result`,
`    'grand_total', v_grand,
    'due_amount', v_grand,
    'result', v_result`)

// ---- assemble the migration ---------------------------------------------
const out = `-- =============================================================================
-- 0017_phase11_purchase_tax_fix.sql
--
-- Fix (run after 0016): Phase 9 P9-BUG-2 — purchase invoice tax double-count.
--
-- WHAT WAS WRONG
--   create_purchase_invoice (0009) accumulated v_subtotal from the LINE
--   totals (tax-inclusive amounts in both tax modes) and then computed
--   grand_total = subtotal - discount_total + tax_total, i.e. it ADDED the
--   tax on top of a subtotal that already contained it and subtracted the
--   line discounts a second time. Both modes were wrong:
--     * inclusive, 10 x 600 @ 12% GST: stored grand 6642.86
--       (correct: 6000 — the entered costs already contain the tax)
--     * exclusive, 10 x 600 @ 12% GST: stored grand 7440.00
--       (correct: 6720 — 6000 + 720 tax, matching the purchase order)
--   The purchase ORDER for the same items showed 6720, and purchase returns
--   credited proportionally to the line (mode-correct), so the invoice
--   payable was the inconsistent figure: supplier payables (due_amount =
--   grand_total) were overstated by roughly one tax amount per invoice.
--   The app UI also never sends tax_mode, and the RPC silently fell back to
--   the POS *sales* setting (default_tax_mode = 'inclusive') — a customer-
--   price convention leaking into a supplier cost document.
--
-- THE FIX (function replacement — same signature, same permission gate,
--   same audit shape; item-line math is untouched because it was always
--   correct in both modes):
--   1. grand_total = Σ line_total in BOTH modes (sales-engine invariant).
--      inclusive: grand = Σ(gross - line disc)      — costs contain GST
--      exclusive: grand = Σ(gross - line disc + GST) — GST added on top
--      => grand always equals what purchase-return credits and FIFO
--         payments are computed against.
--   2. subtotal = Σ gross (pre-discount cost base) — the same convention as
--      purchase orders, so a PO and its PI now agree for the same items.
--   3. Purchases default to tax_mode 'exclusive' (cost + GST added on top),
--      matching the purchase UIs ("tax added by the server") and PO math.
--      The POS default_tax_mode no longer leaks into supplier bills. An
--      explicit payload tax_mode is still honoured.
--
-- DATA REPAIR (idempotent — recomputes from item rows, which are and always
--   were mode-correct):
--   * every non-CANCELLED purchase invoice gets its document totals
--     recomputed from its items: subtotal = Σ(qty x unit_cost),
--     discount_total = Σ(line discounts), tax_total = Σ(item tax),
--     grand_total = Σ(line_total).
--   * RECEIVED invoices additionally get due_amount = grand - paid - return
--     credits (floor 0) and payment_status per the engine convention
--     (PAID / PARTIALLY_PAID / DUE). paid_amount is NOT rewritten — those
--     are real recorded payments.
--   * CANCELLED invoices are left untouched (excluded from payables and
--     reports by status filters).
--   * Note for fully-paid historical invoices: if a payment was recorded at
--     the old inflated total, paid_amount can now exceed grand_total. The
--     difference is the historical tax over-charge recorded before this
--     fix; due_amount is floored at 0 and the invoice shows PAID. The
--     purchase reports (which sum grand_total) become correct from the
--     moment this migration is applied.
--
-- No tables, columns, constraints, RLS policies or signatures change.
-- Grants are re-issued verbatim. Additive and idempotent.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PART 1 — create_purchase_invoice with corrected totals math.
--   Verbatim body from 0009 with six surgical edits (E1..E6) marked with
--   "0017:" comments. Item validation, PO linking, numbering, stock,
--   payable and audit flows are byte-identical.
-- ---------------------------------------------------------------------------
${fn}

revoke all on function public.create_purchase_invoice(jsonb) from public, anon;
grant execute on function public.create_purchase_invoice(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 2 — data repair: recompute document totals of existing invoices from
-- their item rows (mode-correct by construction). Pure recompute — running
-- it twice produces the same numbers (idempotent).
-- ---------------------------------------------------------------------------

-- 2a. every non-cancelled invoice: the four money columns.
with re as (
  select pi.id,
         round(coalesce(sum(pii.quantity * pii.unit_cost), 0), 2) as sub,
         round(coalesce(sum(pii.discount_amount), 0), 2)          as disc,
         round(coalesce(sum(pii.tax_amount), 0), 2)               as tax,
         round(coalesce(sum(pii.line_total), 0), 2)               as grand
    from public.purchase_invoices pi
    join public.purchase_invoice_items pii on pii.invoice_id = pi.id
   where pi.status in ('DRAFT', 'RECEIVED')
   group by pi.id
)
update public.purchase_invoices pi
   set subtotal       = re.sub,
       discount_total = re.disc,
       tax_total      = re.tax,
       grand_total    = re.grand
  from re
 where pi.id = re.id;

-- 2b. RECEIVED invoices: payable + payment status from the repaired grand.
--     paid_amount is untouched (real payments); return credits (applied_to_due)
--     are honoured, exactly like the engine's own arithmetic.
update public.purchase_invoices pi
   set due_amount = greatest(
         pi.grand_total - pi.paid_amount
           - coalesce((select sum(pr.applied_to_due)
                         from public.purchase_returns pr
                        where pr.purchase_invoice_id = pi.id), 0),
         0),
       payment_status = case
         when greatest(pi.grand_total - pi.paid_amount
                         - coalesce((select sum(pr.applied_to_due)
                                       from public.purchase_returns pr
                                      where pr.purchase_invoice_id = pi.id), 0),
                      0) <= 0 then 'PAID'
         when pi.paid_amount > 0 then 'PARTIALLY_PAID'
         else 'DUE' end
 where pi.status = 'RECEIVED';

commit;
`

writeFileSync(OUT, out)

// ---- report the diff for review -----------------------------------------
const a = original.split('\n')
const b = fn.split('\n')
console.log(`WROTE ${OUT} (${out.length} bytes)`)
console.log(`function body: ${a.length} -> ${b.length} lines`)
console.log('\n--- SURGICAL DIFF (original vs new function body) ---')
let i = 0, j = 0
while (i < a.length || j < b.length) {
  if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue }
  // removed block
  const rm: string[] = []
  let k = i
  while (k < a.length && a[k] !== b[j]) { rm.push(a[k]); k++ }
  if (rm.length && k < a.length) {
    console.log(`  - ${rm.join('\n  - ')}`)
    i = k
    continue
  }
  // added block
  const ad: string[] = []
  let m = j
  while (m < b.length && b[m] !== a[i]) { ad.push(b[m]); m++ }
  if (ad.length && m < b.length) {
    console.log(`  + ${ad.join('\n  + ')}`)
    j = m
    continue
  }
  i++; j++
}
console.log('--- END DIFF ---')
