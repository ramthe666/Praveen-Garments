/**
 * Phase 8 — generates migration 0015 (IST-anchored date boundaries for the
 * page/statement RPCs) by EXTRACTING each function verbatim from its source
 * migration and applying minimal, surgical replacements. No existing
 * migration file is modified. Output: supabase/migrations/0015_*.sql
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/z/my-project/supabase/migrations'

type Target = {
  fn: string
  file: string
  replaces: [string, string][]
  /** customer_statement: tz default lives in the declare initializer */
  declareTzInit?: boolean
}

const TZ_INIT = `  v_tz := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');`
const TZ_DECL = `  v_tz      text;`
const TZ_DECL_INIT = `  v_tz       text := coalesce((select c.timezone from public.company_settings c where c.id = 1), 'Asia/Kolkata');`

const istFrom = (col: string) => [
  `format('${col} >= %L', (p_date_from::timestamptz)::text)`,
  `format('${col} >= %L', (p_date_from::timestamp at time zone v_tz)::text)`,
]
const istTo = (col: string) => [
  `format('${col} < (%L::date + 1)::timestamptz', (p_date_to)::text)`,
  `format('${col} < %L', ((p_date_to + 1)::timestamp at time zone v_tz)::text)`,
]

const targets: Target[] = [
  {
    fn: 'sales_page',
    file: '0008_pos_billing.sql',
    replaces: [istFrom('s.sale_date'), istTo('s.sale_date')],
  },
  {
    fn: 'purchase_orders_page',
    file: '0009_phase4_business_operations.sql',
    replaces: [istFrom('po.order_date'), istTo('po.order_date')],
  },
  {
    fn: 'purchase_invoices_page',
    file: '0009_phase4_business_operations.sql',
    replaces: [istFrom('pi.invoice_date'), istTo('pi.invoice_date')],
  },
  {
    fn: 'purchase_returns_page',
    file: '0009_phase4_business_operations.sql',
    replaces: [istFrom('pr.return_date'), istTo('pr.return_date')],
  },
  {
    fn: 'sales_returns_page',
    file: '0009_phase4_business_operations.sql',
    replaces: [istFrom('r.return_date'), istTo('r.return_date')],
  },
  {
    fn: 'exchanges_page',
    file: '0009_phase4_business_operations.sql',
    replaces: [istFrom('e.exchange_date'), istTo('e.exchange_date')],
  },
  {
    fn: 'payments_page',
    file: '0009_phase4_business_operations.sql',
    replaces: [
      [`entry_at >= (p_date_from::timestamptz)`, `entry_at >= (p_date_from::timestamp at time zone v_tz)`],
      [`entry_at < ((p_date_to + 1)::timestamptz)`, `entry_at < ((p_date_to + 1)::timestamp at time zone v_tz)`],
    ],
  },
  {
    fn: 'customer_statement',
    file: '0011_phase4_statement_till_payments.sql',
    declareTzInit: true,
    replaces: [
      [`v_to_ts    timestamptz := (v_to + 1)::timestamptz;`, `v_to_ts    timestamptz := (v_to + 1)::timestamp at time zone v_tz;`],
      [`v_from_ts  timestamptz := v_from::timestamptz;`, `v_from_ts  timestamptz := v_from::timestamp at time zone v_tz;`],
    ],
  },
]

function extractBlock(src: string, fn: string): { block: string; grants: string } {
  const startMarker = `create or replace function public.${fn}(`
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`function ${fn} not found`)
  const end = src.indexOf('end $$;', start)
  if (end < 0) throw new Error(`end $$; not found for ${fn}`)
  const blockEnd = end + 'end $$;'.length
  // capture trailing revoke/grant lines (skipping blank lines, stopping at
  // the first non-revoke/grant content line)
  const rest = src.slice(blockEnd)
  const grantLines: string[] = []
  for (const line of rest.split('\n')) {
    if (line.trim() === '') {
      if (grantLines.length > 0) break
      continue
    }
    if (/^(revoke|grant)\b/i.test(line.trim()) && line.includes(`public.${fn}(`)) grantLines.push(line)
    else break
  }
  return { block: src.slice(start, blockEnd), grants: grantLines.join('\n') }
}

function patchFunction(t: Target, src: string): string {
  const { block } = extractBlock(src, t.fn)
  let out = block

  // 1. boundary replacements (must ALL match)
  for (const [oldStr, newStr] of t.replaces) {
    if (!out.includes(oldStr)) throw new Error(`[${t.fn}] replacement source not found: ${oldStr.slice(0, 60)}`)
    const occurrences = out.split(oldStr).length - 1
    if (occurrences !== 1) throw new Error(`[${t.fn}] expected 1 occurrence, found ${occurrences}: ${oldStr.slice(0, 60)}`)
    out = out.replace(oldStr, newStr)
  }

  // 2. declare v_tz
  if (t.declareTzInit) {
    if (!out.includes('declare\n')) throw new Error(`[${t.fn}] declare block not found`)
    out = out.replace('declare\n', `declare\n${TZ_DECL_INIT}\n`)
  } else {
    if (!out.includes('declare\n')) throw new Error(`[${t.fn}] declare block not found`)
    out = out.replace('declare\n', `declare\n${TZ_DECL}\n`)
    // 3. init v_tz right after the function-body begin
    const beginIdx = out.indexOf('\nbegin\n')
    if (beginIdx < 0) throw new Error(`[${t.fn}] body begin not found`)
    out = out.slice(0, beginIdx + '\nbegin\n'.length) + `${TZ_INIT}\n` + out.slice(beginIdx + '\nbegin\n'.length)
  }

  // sanity: no leftover ::timestamptz date casts remain (statement keeps none)
  if (/p_date_(from|to)::timestamptz/.test(out) && !t.declareTzInit) {
    throw new Error(`[${t.fn}] leftover ::timestamptz cast on date param`)
  }
  return out
}

const header = `-- 0015_phase8_ist_date_boundaries.sql
-- Phase 8, Part 19 (date-filter correctness at the database layer).
--
-- PURPOSE
--   The page/list RPCs (0008 sales_page; 0009 purchase_orders_page,
--   purchase_invoices_page, purchase_returns_page, sales_returns_page,
--   exchanges_page, payments_page) and customer_statement (0011) anchored
--   calendar-date filters at the SESSION timezone (UTC on Supabase):
--     (p_date_from::timestamptz)              -> 00:00 UTC  = 05:30 IST
--     ((p_date_to + 1)::timestamptz)          -> 00:00 UTC  = 05:30 IST
--   The report RPCs (0012+) already anchor at the STORE timezone
--   (company_settings.timezone, default Asia/Kolkata). The two conventions
--   disagree for records created between 00:00 and 05:29 IST, and the same
--   filter can return different rows on a page vs its report.
--
--   This migration redefines ONLY those function bodies so every date
--   boundary is store-timezone anchored, matching 0012 exactly:
--     (p_date_from::timestamp at time zone v_tz)        -> 00:00 IST
--     ((p_date_to + 1)::timestamp at time zone v_tz)    -> 00:00 IST next day
--   Filter semantics stay [from 00:00, to+1 00:00) — the To date remains
--   INCLUSIVE of the whole store-local day, now for every module.
--
-- SAFETY
--   - ADDITIVE and IDEMPOTENT: create-or-replace of function bodies only.
--   - No table, column, data or grant changes (grants re-issued verbatim,
--     identical to the originals).
--   - Existing migrations 0001-0014 are untouched.
--   - Signatures and result shapes are byte-identical to the originals.

`

const parts: string[] = []
for (const t of targets) {
  const src = readFileSync(`${ROOT}/${t.file}`, 'utf8')
  const { grants } = extractBlock(src, t.fn)
  const patched = patchFunction(t, src)
  parts.push(
    `-- ===========================================================================\n` +
    `-- ${t.fn}  (from ${t.file} — body re-anchored to store timezone)\n` +
    `-- ===========================================================================\n\n` +
    patched + `\n\n` + (grants ? grants + `\n` : '')
  )
  console.log(`patched ${t.fn} (${t.file})`)
}

const out = header + parts.join('\n')
writeFileSync(`${ROOT}/0015_phase8_ist_date_boundaries.sql`, out)
console.log(`\nwrote 0015_phase8_ist_date_boundaries.sql (${out.split('\n').length} lines)`)
