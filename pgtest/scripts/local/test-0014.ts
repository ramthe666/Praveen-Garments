/**
 * 0014 (payment/cash reports include exchange collections) — local test suite.
 * Runs against the local harness with the Phase-6 audit data present
 * (reset-full + test-audit1/2/3): the dataset contains exchange EX +200 Cash
 * (upgrade, collection) and EX -200 Cash (downgrade, refund), a Cash sales
 * return of 1199, CR receipts, and a Cash expense.
 *
 * Run from pgtest/: bun run scripts/local/test-0014.ts
 */
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS ${name}`) }
  else {
    failed++; failures.push(name)
    console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`)
  }
}
const money = (x: unknown) => Number(x ?? 0)

async function main() {
  const root = new Client(CONN)
  await root.connect()
  const val = async (sql: string, vals: unknown[] = []) => (await root.query(sql, vals)).rows[0]

  // ---- A. structure: signatures unchanged, one function each ---------------
  console.log('A. structure')
  const proc = await val(`select
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = 'payment_report' and n.nspname = 'public') as pay_procs,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = 'cash_report' and n.nspname = 'public') as cash_procs`)
  check('exactly one payment_report / one cash_report (replaced in place)', proc.pay_procs === 1 && proc.cash_procs === 1, proc)
  const grants = await val(`select
      has_function_privilege('anon', 'public.payment_report(date,date)', 'EXECUTE') as anon_pay,
      has_function_privilege('authenticated', 'public.payment_report(date,date)', 'EXECUTE') as auth_pay,
      has_function_privilege('service_role', 'public.payment_report(date,date)', 'EXECUTE') as sv_pay,
      has_function_privilege('anon', 'public.cash_report(date)', 'EXECUTE') as anon_cash,
      has_function_privilege('authenticated', 'public.cash_report(date)', 'EXECUTE') as auth_cash`)
  check('grants preserved: anon denied, authenticated + service_role allowed',
    grants.anon_pay === false && grants.auth_pay === true && grants.sv_pay === true &&
    grants.anon_cash === false && grants.auth_cash === true, grants)

  // ---- B. payment_report includes exchange collections --------------------
  console.log('B. payment_report')
  const pay = (await val('select public.payment_report() as r')).r
  const rawExchIn = await val(`select coalesce(sum(e.difference_amount), 0) as total
    from public.exchanges e
    where e.difference_amount > 0 and e.payment_method is not null and e.payment_method <> 'Store Credit'`)
  const exchSection = pay.exchange_collections ?? []
  check('exchange_collections section present with the collected total',
    Math.abs(money(exchSection.reduce((s: number, r: any) => s + money(r.amount), 0)) - money(rawExchIn.total)) < 0.011,
    { got: exchSection, want: rawExchIn.total })
  check('summary.total_exchange_in = raw positive exchange differences',
    Math.abs(money(pay.summary.total_exchange_in) - money(rawExchIn.total)) < 0.011, pay.summary)

  // inflows = till + receipts + exchange collections (all-time window)
  const rawIn = await val(`
    select
      coalesce((select sum(sp.amount) from public.sale_payments sp
        join public.sales s on s.id = sp.sale_id
        where s.status = 'COMPLETED' and sp.is_credit = false and sp.method <> 'Store Credit'
          and not exists (select 1 from public.customer_payments cp where cp.receipt_number = sp.reference)), 0)
    + coalesce((select sum(cp.amount) from public.customer_payments cp where cp.method <> 'Store Credit'), 0)
    + coalesce((select sum(e.difference_amount) from public.exchanges e
        where e.difference_amount > 0 and e.payment_method is not null and e.payment_method <> 'Store Credit'), 0) as total`)
  check('summary.total_inflow now equals till + receipts + exchange collections',
    Math.abs(money(pay.summary.total_inflow) - money(rawIn.total)) < 0.011, { got: pay.summary.total_inflow, want: rawIn.total })
  const inflowTotal = (pay.inflows ?? []).reduce((s: number, r: any) => s + money(r.amount), 0)
  check('inflows rows sum to the same total', Math.abs(inflowTotal - money(rawIn.total)) < 0.011, { inflowTotal, want: rawIn.total })
  // refunds unchanged by 0014
  const rawRefunds = await val(`select
      coalesce((select sum(r.refund_amount) from public.sales_returns r
        where r.refund_amount > 0 and r.refund_method is not null and r.refund_method <> 'Store Credit'), 0)
    + coalesce((select sum(-e.difference_amount) from public.exchanges e
        where e.difference_amount < 0 and e.payment_method is not null and e.payment_method <> 'Store Credit'), 0) as total`)
  check('refunds semantics unchanged (return cash + exchange refunds)',
    Math.abs(money(pay.summary.total_refund) - money(rawRefunds.total)) < 0.011, { got: pay.summary.total_refund, want: rawRefunds.total })

  // ---- C. cash_report includes exchange collections ------------------------
  console.log('C. cash_report')
  const day = (await val(`select (now() at time zone 'Asia/Kolkata')::date::text as d`)).d
  const cash = (await val('select public.cash_report($1) as r', [day])).r
  const rawExchDay = await val(`select coalesce(sum(e.difference_amount), 0) as total
    from public.exchanges e
    where e.difference_amount > 0 and e.payment_method = 'Cash'
      and (e.exchange_date at time zone 'Asia/Kolkata')::date = $1::date`, [day])
  check('cash_exchange_in = Cash upgrade differences collected today',
    Math.abs(money(cash.cash_exchange_in) - money(rawExchDay.total)) < 0.011, { got: cash.cash_exchange_in, want: rawExchDay.total })
  // independent full recomputation of expected cash for the day
  const rawExpected = await val(`
    select
      coalesce((select sum(sp.amount) from public.sale_payments sp
        join public.sales s on s.id = sp.sale_id
        where s.status = 'COMPLETED' and sp.is_credit = false and sp.method = 'Cash'
          and (sp.created_at at time zone 'Asia/Kolkata')::date < $1::date
          and not exists (select 1 from public.customer_payments cp where cp.receipt_number = sp.reference)), 0)
    + coalesce((select sum(cp.amount) from public.customer_payments cp
        where cp.method = 'Cash' and (cp.recorded_at at time zone 'Asia/Kolkata')::date < $1::date), 0)
    + coalesce((select sum(e.difference_amount) from public.exchanges e
        where e.difference_amount > 0 and e.payment_method = 'Cash'
          and (e.exchange_date at time zone 'Asia/Kolkata')::date < $1::date), 0)
    - coalesce((select sum(r.refund_amount) from public.sales_returns r
        where r.refund_method = 'Cash' and r.refund_amount > 0
          and (r.return_date at time zone 'Asia/Kolkata')::date < $1::date), 0)
    - coalesce((select sum(-e.difference_amount) from public.exchanges e
        where e.difference_amount < 0 and e.payment_method = 'Cash'
          and (e.exchange_date at time zone 'Asia/Kolkata')::date < $1::date), 0)
    - coalesce((select sum(x.amount) from public.expenses x
        where x.method = 'Cash' and x.status in ('PENDING','APPROVED')
          and x.expense_date < $1::date), 0)
    - coalesce((select sum(spay.amount) from public.supplier_payments spay
        where spay.method = 'Cash' and (spay.recorded_at at time zone 'Asia/Kolkata')::date < $1::date), 0)
    -- today's movements
    + coalesce((select sum(sp.amount) from public.sale_payments sp
        join public.sales s on s.id = sp.sale_id
        where s.status = 'COMPLETED' and sp.is_credit = false and sp.method = 'Cash'
          and (sp.created_at at time zone 'Asia/Kolkata')::date = $1::date
          and not exists (select 1 from public.customer_payments cp where cp.receipt_number = sp.reference)), 0)
    + coalesce((select sum(cp.amount) from public.customer_payments cp
        where cp.method = 'Cash' and (cp.recorded_at at time zone 'Asia/Kolkata')::date = $1::date), 0)
    + coalesce((select sum(e.difference_amount) from public.exchanges e
        where e.difference_amount > 0 and e.payment_method = 'Cash'
          and (e.exchange_date at time zone 'Asia/Kolkata')::date = $1::date), 0)
    - coalesce((select sum(r.refund_amount) from public.sales_returns r
        where r.refund_method = 'Cash' and r.refund_amount > 0
          and (r.return_date at time zone 'Asia/Kolkata')::date = $1::date), 0)
    - coalesce((select sum(-e.difference_amount) from public.exchanges e
        where e.difference_amount < 0 and e.payment_method = 'Cash'
          and (e.exchange_date at time zone 'Asia/Kolkata')::date = $1::date), 0)
    - coalesce((select sum(x.amount) from public.expenses x
        where x.method = 'Cash' and x.status in ('PENDING','APPROVED')
          and x.expense_date = $1::date), 0)
    - coalesce((select sum(spay.amount) from public.supplier_payments spay
        where spay.method = 'Cash' and (spay.recorded_at at time zone 'Asia/Kolkata')::date = $1::date), 0)
    as expected`, [day])
  check('expected_cash equals an INDEPENDENT full recomputation (incl. exchange cash)',
    Math.abs(money(cash.expected_cash) - money(rawExpected.expected)) < 0.011,
    { got: cash.expected_cash, want: rawExpected.expected })
  check('total_in = cash sales + receipts + exchange collections',
    Math.abs(money(cash.total_in) - money(cash.cash_sales) - money(cash.cash_receipts) - money(cash.cash_exchange_in)) < 0.011, cash.total_in)

  // ---- D. permission gate unchanged ----------------------------------------
  console.log('D. permission gate')
  const c = new Client(CONN)
  await c.connect()
  await c.query('set role authenticated')
  const cashierId = (await root.query("select id from public.profiles where email = 'audit6-casha@t.local'")).rows[0].id
  await c.query("select set_config('request.jwt.claim.sub', $1, false)", [cashierId])
  let denied = false
  try { await c.query('select public.payment_report()'); } catch { denied = true }
  check('cashier (no view_reports) still denied payment_report', denied)
  let deniedCash = false
  try { await c.query('select public.cash_report()'); } catch { deniedCash = true }
  check('cashier still denied cash_report', deniedCash)
  await c.end()

  await root.end()
  console.log(`\n== 0014 RESULT: ${passed} passed, ${failed} failed ==`)
  if (failures.length) for (const f of failures) console.log('  -', f)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
