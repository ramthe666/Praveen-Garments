#!/usr/bin/env bun
/**
 * Builds supabase/migrations/0013_sales_report_payment_status.sql from the
 * 0012 file itself (guarantees the function body is byte-identical except
 * for the deliberate additions):
 *   1. drop the 0012 14-arg sales_report (signature changes -> CREATE OR
 *      REPLACE alone would create an overload, which PostgREST hates)
 *   2. append p_payment_status text default null to the parameter list
 *   3. add the s.payment_status filter block next to the p_status block
 *   4. refresh revoke/grant lines with the 15-arg signature
 * 0001-0012 are never modified.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'supabase/migrations/0012_phase5_reporting.sql'
const OUT = 'supabase/migrations/0013_sales_report_payment_status.sql'

const lines = readFileSync(SRC, 'utf8').split('\n')
const start = lines.findIndex((l) => /^create or replace function public\.sales_report\($/.test(l.trimEnd()))
if (start < 0) throw new Error('sales_report create line not found')
const grantIdx = lines.findIndex((l, i) => i > start && /^grant execute on function public\.sales_report/.test(l))
if (grantIdx < 0) throw new Error('sales_report grant line not found')
const section = lines.slice(start, grantIdx + 1)

// 1. param: append after the p_offset line
const pOffsetIdx = section.findIndex((l) => /^\s*p_offset\s+int\s+default 0,?$/.test(l))
if (pOffsetIdx < 0) throw new Error('p_offset param line not found')
// p_offset was the LAST parameter (no trailing comma) — it needs one now
section[pOffsetIdx] = section[pOffsetIdx].replace(/default 0,?$/, 'default 0,')
section.splice(pOffsetIdx + 1, 0, '  p_payment_status text default null')

// 2. filter block: insert right after the p_status if-block (3 lines)
const statusIfIdx = section.findIndex((l) => /^\s*if p_status in \('COMPLETED', 'CANCELLED'\) then/.test(l))
if (statusIfIdx < 0) throw new Error('p_status filter block not found')
section.splice(statusIfIdx + 3, 0, '',
  '  if p_payment_status in (\'PAID\', \'PARTIALLY_PAID\', \'DUE\') then',
  '    v_where := v_where || format(\'s.payment_status = %L\', p_payment_status);',
  '  end if;')

// 3. revoke/grant signatures: 14-arg -> 15-arg
const OLD_SIG = '(date, date, text, uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, int, int)'
const NEW_SIG = '(date, date, text, uuid, uuid, text, uuid, uuid, uuid, uuid, text, text, int, int, text)'
const body = section.map((l) =>
  l.includes(`public.sales_report${OLD_SIG}`) ? l.replace(OLD_SIG, NEW_SIG) : l,
).join('\n')

const out = `-- ---------------------------------------------------------------------------
-- 0013_sales_report_payment_status.sql
--
-- WHAT: Adds the payment-status filter (PAID / PARTIALLY_PAID / DUE) to
--       sales_report(). The Phase 5 frontend sends a p_payment_status
--       argument on the Sales report page; 0012's sales_report does not
--       accept it, so PostgREST cannot match the function (PGRST202) and
--       the page shows "Could not load this report" even though 0012 is
--       applied. This migration makes the filter a first-class RPC arg.
--
-- HOW:  The parameter list changes (14 -> 15 args), so the 0012 version is
--       dropped first — CREATE OR REPLACE alone would create a second
--       overload. Everything else is byte-identical to 0012 PART 4.
--       Invalid p_payment_status values are ignored (same lenient pattern
--       as p_status). Existing callers that omit the new argument keep
--       working unchanged.
--
-- ORDER: Run AFTER 0012_phase5_reporting.sql. Additive only — no table or
--       data changes; 0001-0012 are untouched.
-- ---------------------------------------------------------------------------

drop function if exists public.sales_report${OLD_SIG};

${body}
`
writeFileSync(OUT, out)
console.log(`wrote ${OUT} (${out.split('\n').length} lines)`)
console.log('--- verify additions ---')
console.log(out.split('\n').filter((l) => /p_payment_status|drop function|revoke all|grant execute/.test(l)).join('\n'))
