/**
 * 0015 (store-timezone date boundaries) — local test suite.
 * Runs against the local Supabase-compatible harness (NOT production).
 *
 * Proves, at the DATABASE layer (Phase 8 Part 19):
 *   1. boundaries are store-local (IST) — a 00:00:30 IST sale on the From
 *      date is INCLUDED, a 00:00:30 IST sale the day AFTER the To date is
 *      EXCLUDED, and the To date is fully inclusive;
 *   2. month/year boundaries behave the same;
 *   3. results are IDENTICAL under session timezone UTC and Asia/Kolkata
 *      (the old bodies were session-tz dependent — this is the regression);
 *   4. the page RPCs agree with the 0012 report RPCs on the same range;
 *   5. purchase invoices (incl. form-style UTC-midnight dates), payments,
 *      sales returns and the customer statement follow the same rules;
 *   6. idempotent re-apply, grants and anon denial intact.
 *
 * Prerequisite: reset-full chain 0001 -> 0015 applied.
 * Run from pgtest/: PGPASSWORD=postgres bun run scripts/local/test-0015.ts
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'

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
async function expectError(name: string, fn: () => Promise<unknown>, messageIncludes: string) {
  try { await fn(); check(name, false, 'expected an error but none was raised') }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    check(name, msg.toLowerCase().includes(messageIncludes.toLowerCase()), msg)
  }
}

async function main() {
  const root = new Client(CONN)
  await root.connect()
  // The Supabase/PostgREST reality: session timezone is UTC.
  await root.query("set timezone to 'UTC'")

  async function as(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query('set role authenticated')
    await c.query("set timezone to 'UTC'")
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    return c
  }
  async function rpc<T = any>(client: Client, fn: string, args: Record<string, unknown>): Promise<T> {
    const keys = Object.keys(args)
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
    const vals = keys.map((k) => args[k])
    const res = await client.query(`select public.${fn}(${named}) as result`, vals)
    return res.rows[0].result as T
  }

  // ---- A. structure + grants --------------------------------------------
  console.log('A. structure + grants')
  for (const fn of [
    'sales_page', 'purchase_orders_page', 'purchase_invoices_page',
    'purchase_returns_page', 'sales_returns_page', 'exchanges_page',
    'payments_page', 'customer_statement',
  ]) {
    const rows = (await root.query(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where p.proname = $1 and ns.nspname = 'public'`, [fn])).rows
    check(`${fn} exists (single)`, rows.length === 1, rows.length)
    const auth = (await root.query(
      `select has_function_privilege($2, ns.nspname || '.' || p.oid::regprocedure::text, 'EXECUTE') as ok
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where p.proname = $1 and ns.nspname = 'public'`, [fn, 'authenticated'])).rows[0].ok
    check(`${fn} executable by authenticated`, auth === true)
  }
  // no old session-tz casts remain in any deployed body
  const bodies = (await root.query(`
    select p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname in
      ('sales_page','purchase_orders_page','purchase_invoices_page','purchase_returns_page',
       'sales_returns_page','exchanges_page','payments_page','customer_statement')`)).rows
  for (const b of bodies) {
    check(`${b.proname}: no ::timestamptz cast on date param`,
      !/p_date_(from|to)::timestamptz/.test(b.def) && !/v_(from|to)_ts\s+timestamptz\s*:=\s*v_(from|to)::timestamptz/.test(b.def))
    check(`${b.proname}: uses at time zone v_tz`, /at time zone v_tz/.test(b.def))
  }

  // ---- B. users + boundary data ------------------------------------------
  console.log('B. boundary data')
  // purge leftovers from earlier partial runs (children before parents)
  await root.query(`
    delete from public.exchanges where exchange_number like 'P15%';
    delete from public.sales_returns where return_number like 'P15%';
    delete from public.sale_payments where sale_id in (select id from public.sales where sale_number like 'P15S%');
    delete from public.sales where sale_number like 'P15S%';
    delete from public.purchase_returns where return_number like 'P15%';
    delete from public.purchase_invoices where invoice_number like 'P15PI%';
    delete from public.customer_payments where receipt_number like 'P15CR%';
    delete from public.customers where name like 'P15 Customer%';
    delete from public.suppliers where name like 'P15 Supplier%';
  `)
  await root.query(`delete from public.profiles where email like 'pg15-%'`)
  await root.query(`delete from auth.users where email like 'pg15-%'`)
  const adminId = (await root.query(
    `insert into auth.users (email, raw_user_meta_data) values ('pg15-admin@test.local', '{"app_role":"admin"}'::jsonb) returning id`)).rows[0].id as string
  await root.query(
    `insert into public.profiles (id, email, full_name, role)
     values ($1, 'pg15-admin@test.local', 'P15 Admin', 'admin')
     on conflict (id) do update set role = 'admin'::public.user_role, is_active = true`,
    [adminId])
  const admin = await as(adminId)

  const cust = (await root.query(
    `insert into public.customers (name) values ('P15 Customer') returning id, name`)).rows[0]

  // sales at exact IST boundary instants (B = before/early, E = evening)
  const mk = async (num: string, instant: string, total: number, custId: string | null = null) =>
    (await root.query(
      `insert into public.sales (sale_number, sale_date, grand_total, paid_amount, customer_id, customer_name, status, payment_status)
       values ($1, $2::timestamptz, $3, $3, $4, $5, 'COMPLETED', 'PAID') returning id, sale_number`,
      [num, instant, total, custId, custId ? 'P15 Customer' : null])).rows[0]

  const s1 = await mk('P15S1', '2026-09-11 00:00:30+05:30', 100, cust.id) // From day, first minute
  const s2 = await mk('P15S2', '2026-09-11 23:59:30+05:30', 200)          // From day, last minute
  const s3 = await mk('P15S3', '2026-09-12 00:00:30+05:30', 300)          // To day, first minute
  const s4 = await mk('P15S4', '2026-09-12 21:30:00+05:30', 400)          // To day, store hours
  const s5 = await mk('P15S5', '2026-09-13 00:00:30+05:30', 500)          // day AFTER To
  const s6 = await mk('P15S6', '2026-08-31 23:00:00+05:30', 600)          // month boundary
  const s7 = await mk('P15S7', '2026-09-01 00:00:30+05:30', 700)          // month boundary
  const s8 = await mk('P15S8', '2026-12-31 23:00:00+05:30', 800)          // year boundary
  const s9 = await mk('P15S9', '2027-01-01 00:00:30+05:30', 900)          // year boundary
  console.log('  staged 9 boundary sales')

  const numbers = (result: { rows: { sale_number: string }[] } | null) =>
    (result?.rows ?? []).map((r) => r.sale_number).sort().join(',')

  // ---- C. sales_page boundaries (session tz = UTC, like PostgREST) ------
  console.log('C. sales_page boundaries')
  const runSales = async (client: Client, from: string | null, to: string | null) =>
    rpc<{ rows: { sale_number: string }[] }>(client, 'sales_page', {
      p_date_from: from, p_date_to: to, p_limit: 100, p_offset: 0,
    })

  check('11-09 → 12-09 includes both whole days (To inclusive)',
    numbers(await runSales(admin, '2026-09-11', '2026-09-12')) === 'P15S1,P15S2,P15S3,P15S4',
    numbers(await runSales(admin, '2026-09-11', '2026-09-12')))
  check('11-09 → 11-09 = exactly 11 Sep (IST)',
    numbers(await runSales(admin, '2026-09-11', '2026-09-11')) === 'P15S1,P15S2')
  check('12-09 → 12-09 = exactly 12 Sep (IST)',
    numbers(await runSales(admin, '2026-09-12', '2026-09-12')) === 'P15S3,P15S4')
  check('day after To excluded', numbers(await runSales(admin, '2026-09-11', '2026-09-12')).includes('P15S5') === false)
  check('month boundary: August range holds 31 Aug late sale',
    numbers(await runSales(admin, '2026-08-01', '2026-08-31')) === 'P15S6')
  check('month boundary: September range holds 1 Sep first-minute sale',
    numbers(await runSales(admin, '2026-09-01', '2026-09-01')) === 'P15S7')
  check('year boundary: 2026 range = every 2026 sale incl. 31 Dec late sale, excluding only 1 Jan 2027',
    numbers(await runSales(admin, '2026-01-01', '2026-12-31')) === 'P15S1,P15S2,P15S3,P15S4,P15S5,P15S6,P15S7,P15S8',
    numbers(await runSales(admin, '2026-01-01', '2026-12-31')))
  check('year boundary: 2027 range holds only 1 Jan sale',
    numbers(await runSales(admin, '2027-01-01', '2027-12-31')) === 'P15S9')
  const unfiltered = numbers(await runSales(admin, null, null))
  check('null dates = unfiltered (all 9)', unfiltered.split(',').length === 9, unfiltered)
  check('inverted range (from > to) = empty',
    numbers(await runSales(admin, '2026-09-12', '2026-09-11')) === '')

  // ---- D. session-timezone independence ---------------------------------
  console.log('D. session timezone independence')
  const kolkata = new Client(CONN)
  await kolkata.connect()
  await kolkata.query('set role authenticated')
  await kolkata.query("set timezone to 'Asia/Kolkata'")
  await kolkata.query("select set_config('request.jwt.claim.sub', $1, false)", [adminId])
  for (const [from, to] of [['2026-09-11', '2026-09-12'], ['2026-01-01', '2026-12-31'], ['2026-08-01', '2026-08-31']] as const) {
    const utcSet = numbers(await runSales(admin, from, to))
    const istSet = numbers(await rpc<{ rows: { sale_number: string }[] }>(kolkata, 'sales_page', {
      p_date_from: from, p_date_to: to, p_limit: 100, p_offset: 0,
    }))
    check(`UTC session === Kolkata session (${from} → ${to})`, utcSet === istSet, `${utcSet} vs ${istSet}`)
  }

  // ---- E. agreement with the 0012 report RPC ---------------------------
  console.log('E. page/report agreement')
  const report = await rpc<{ rows: { sale_number: string }[] }>(admin, 'sales_report', {
    p_date_from: '2026-09-11', p_date_to: '2026-09-12',
  })
  check('sales_report 11-09 → 12-09 = same 4 rows as sales_page',
    numbers(report) === 'P15S1,P15S2,P15S3,P15S4', numbers(report))

  // ---- F. other page RPCs ----------------------------------------------
  console.log('F. purchase invoices / payments / returns / statement')
  // stock location + supplier for the invoice
  const loc = (await root.query(`select id, name from public.stock_locations order by location_type limit 1`)).rows[0]
  const sup = (await root.query(`insert into public.suppliers (name) values ('P15 Supplier') returning id, name`)).rows[0]
  const inv1 = (await root.query(
    `insert into public.purchase_invoices (invoice_number, supplier_id, supplier_name, location_id, location_name, invoice_date, status)
     values ('P15PI1', $1, $2, $3, $4, '2026-09-12 00:00:00+00'::timestamptz, 'RECEIVED') returning id, invoice_number`,
    [sup.id, sup.name, loc.id, loc.name])).rows[0]
  const inv2 = (await root.query(
    `insert into public.purchase_invoices (invoice_number, supplier_id, supplier_name, location_id, location_name, invoice_date, status)
     values ('P15PI2', $1, $2, $3, $4, '2026-09-12 21:00:00+05:30'::timestamptz, 'RECEIVED') returning id, invoice_number`,
    [sup.id, sup.name, loc.id, loc.name])).rows[0]
  const inv3 = (await root.query(
    `insert into public.purchase_invoices (invoice_number, supplier_id, supplier_name, location_id, location_name, invoice_date, status)
     values ('P15PI3', $1, $2, $3, $4, '2026-09-13 00:00:30+05:30'::timestamptz, 'RECEIVED') returning id, invoice_number`,
    [sup.id, sup.name, loc.id, loc.name])).rows[0]
  const piRows = (await rpc<{ rows: { invoice_number: string }[] }>(admin, 'purchase_invoices_page', {
    p_date_from: '2026-09-11', p_date_to: '2026-09-12', p_limit: 100, p_offset: 0,
  })).rows.map((r) => r.invoice_number).sort().join(',')
  check('purchase_invoices_page 11→12 Sep: form-style UTC-midnight date AND evening date both in; 13 Sep out',
    piRows === 'P15PI1,P15PI2', piRows)

  // payments: a customer payment at 12 Sep 00:30 IST must appear in 11→12
  await root.query(
    `insert into public.customer_payments (receipt_number, customer_id, customer_name, amount, method, recorded_at)
     values ('P15CR1', $1, $2, 50, 'Cash', '2026-09-12 00:00:30+05:30'::timestamptz)`,
    [cust.id, cust.name])
  const payRows = (await rpc<{ rows: { doc_number: string }[] }>(admin, 'payments_page', {
    p_date_from: '2026-09-11', p_date_to: '2026-09-12', p_limit: 100, p_offset: 0,
  })).rows.map((r) => r.doc_number).sort().join(',')
  check('payments_page 11→12 Sep includes first-minute-of-To-day payment', payRows.includes('P15CR1'), payRows)
  const payRows13 = (await rpc<{ rows: { doc_number: string }[] }>(admin, 'payments_page', {
    p_date_from: '2026-09-13', p_date_to: '2026-09-13', p_limit: 100, p_offset: 0,
  })).rows.map((r) => r.doc_number).join(',')
  check('payments_page 13 Sep excludes the 12 Sep payment', !payRows13.includes('P15CR1'), payRows13)

  // sales return at 12 Sep 00:30 IST
  await root.query(
    `insert into public.sales_returns (return_number, sale_id, sale_number, customer_id, customer_name, return_date, reason, refund_method, refund_amount)
     values ('P15SR1', $1, $2, $3, $4, '2026-09-12 00:00:30+05:30'::timestamptz, 'Size too small', 'Cash', 10)`,
    [s3.id, s3.sale_number, cust.id, cust.name])
  const srRows = (await rpc<{ rows: { return_number: string }[] }>(admin, 'sales_returns_page', {
    p_date_from: '2026-09-11', p_date_to: '2026-09-12', p_limit: 100, p_offset: 0,
  })).rows.map((r) => r.return_number).join(',')
  check('sales_returns_page 11→12 Sep includes first-minute-of-To-day return', srRows.includes('P15SR1'), srRows)

  // exchange at 12 Sep 00:30 IST
  await root.query(
    `insert into public.exchanges (exchange_number, sale_id, sale_number, customer_id, customer_name, exchange_date, reason, difference_amount, payment_method, payment_amount)
     values ('P15EX1', $1, $2, $3, $4, '2026-09-12 00:00:30+05:30'::timestamptz, 'Different size', 20, 'Cash', 20)`,
    [s3.id, s3.sale_number, cust.id, cust.name])
  const exRows = (await rpc<{ rows: { exchange_number: string }[] }>(admin, 'exchanges_page', {
    p_date_from: '2026-09-11', p_date_to: '2026-09-12', p_limit: 100, p_offset: 0,
  })).rows.map((r) => r.exchange_number).join(',')
  check('exchanges_page 11→12 Sep includes first-minute-of-To-day exchange', exRows.includes('P15EX1'), exRows)

  // customer statement: bill 11 Sep 23:59 IST (₹100, s1) + till payment 12 Sep
  // 00:30 IST (₹50) inside 11→12; closing = 100 − 50 = 50
  await root.query(
    `insert into public.sale_payments (sale_id, method, amount, created_at)
     values ($1, 'Cash', 50, '2026-09-12 00:00:30+05:30'::timestamptz)`,
    [s1.id])
  const stmt = await rpc<{ opening_balance: number; closing_balance: number; lines: unknown[] }>(admin, 'customer_statement', {
    p_customer_id: cust.id, p_from: '2026-09-11', p_to: '2026-09-12',
  })
  // Ledger for this customer in 11→12 Sep: DEBIT bill s1 ₹100; CREDITS till
  // payment ₹50 (12 Sep 00:30 IST) + recorded receipt P15CR1 ₹50 (12 Sep
  // 00:30 IST) + return credit P15SR1 ₹10 (refund) → 100 − 110 = −10.
  check('statement 11→12 Sep: closing = bill 100 − till 50 − receipt 50 − return 10 = −10',
    Number(stmt.closing_balance) === -10, stmt.closing_balance)
  const stmtLines = (stmt.lines as { kind: string }[]).map((l) => l.kind).sort().join(',')
  check('statement lines include bill + till_payment', stmtLines.includes('bill') && stmtLines.includes('till_payment'), stmtLines)
  const stmtDay = await rpc<{ closing_balance: number }>(admin, 'customer_statement', {
    p_customer_id: cust.id, p_from: '2026-09-11', p_to: '2026-09-11',
  })
  check('statement 11→11 Sep: only the 11 Sep bill (₹100 due)',
    Number(stmtDay.closing_balance) === 100, stmtDay.closing_balance)

  // ---- G. idempotency + security ----------------------------------------
  console.log('G. idempotency + security')
  const sql15 = readFileSync('/home/z/my-project/supabase/migrations/0015_phase8_ist_date_boundaries.sql', 'utf8')
  await root.query(sql15)
  await root.query(sql15)
  check('0015 re-applies twice without error', true)
  const afterRe = numbers(await runSales(admin, '2026-09-11', '2026-09-12'))
  check('boundaries unchanged after re-apply', afterRe === 'P15S1,P15S2,P15S3,P15S4', afterRe)

  const anon = new Client(CONN)
  await anon.connect()
  await anon.query('set role anon')
  await expectError('anon cannot call sales_page', () => rpc(anon, 'sales_page', {}), 'permission')
  await expectError('anon cannot call customer_statement',
    () => rpc(anon, 'customer_statement', { p_customer_id: cust.id, p_from: null, p_to: null }), 'permission')

  // ---- cleanup -----------------------------------------------------------
  await root.query(`delete from public.profiles where email like 'pg15-%'`)
  await root.query(`delete from auth.users where email like 'pg15-%'`)

  await root.end()
  await kolkata.end()
  await anon.end()
  await admin.end()

  console.log(`\n0015 suite: ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('FAILED:', failures.join(' | '))
    process.exitCode = 1
  }
}

await main().catch((e) => {
  console.error(e)
  process.exit(1)
})
