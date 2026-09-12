/**
 * 0013 (sales_report payment-status filter) — local test suite.
 * Runs against the local Supabase-compatible harness (NOT production).
 *
 * Prerequisite: reset-full chain 0001 -> 0013 applied, then test-0012.ts
 * has run (its staged business data is reused here).
 *
 * Run from pgtest/: bun run scripts/local/test-0013.ts
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

  async function as(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    await c.query('set role authenticated')
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
  const val = async (client: Client, sql: string, vals: unknown[] = []) =>
    (await client.query(sql, vals)).rows[0]

  // ---- A. structure: single 15-arg sales_report, old overload dropped -----
  console.log('A. structure')
  const proc = await val(root, `select
      (select count(*)::int from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where p.proname = 'sales_report' and ns.nspname = 'public') as procs,
      (select p.pronargs from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where p.proname = 'sales_report' and ns.nspname = 'public') as args`)
  check('exactly one sales_report function (no leftover 0012 overload)', proc.procs === 1, proc)
  check('sales_report has 15 parameters (p_payment_status added)', proc.args === 15, proc)

  // ---- B. baseline (arg omitted = no filter) ------------------------------
  console.log('B. baseline without p_payment_status')
  const base = await val(root, `select count(*)::int as n, coalesce(sum(grand_total), 0) as gross
      from public.sales where status = 'COMPLETED'`)
  const noArg = await rpc(root, 'sales_report', { p_limit: 10000 })
  check(`omitted arg -> total = ${base.n}`, noArg.total === base.n, { got: noArg.total })
  check(`omitted arg -> summary.bills = ${base.n}`, noArg.summary.bills === base.n, { got: noArg.summary.bills })
  check('omitted arg -> summary.gross_sales matches', Math.abs(Number(noArg.summary.gross_sales) - Number(base.gross)) < 0.011, { got: noArg.summary.gross_sales })
  const nullArg = await rpc(root, 'sales_report', { p_payment_status: null, p_limit: 10000 })
  check('explicit null arg -> same as omitted', nullArg.total === base.n, { got: nullArg.total })
  const bogus = await rpc(root, 'sales_report', { p_payment_status: 'BOGUS', p_limit: 10000 })
  check('invalid value ignored -> same as unfiltered', bogus.total === base.n, { got: bogus.total })

  // ---- C. filter correctness per status -----------------------------------
  console.log('C. payment-status filter correctness')
  for (const status of ['PAID', 'PARTIALLY_PAID', 'DUE']) {
    const direct = await val(root, `select count(*)::int as n, coalesce(sum(grand_total), 0) as gross
        from public.sales where status = 'COMPLETED' and payment_status = $1`, [status])
    const res = await rpc(root, 'sales_report', { p_payment_status: status, p_limit: 10000 })
    const rowsOk = (res.rows ?? []).every((r: any) => r.payment_status === status)
    check(`${status}: total = ${direct.n}`, res.total === direct.n, { got: res.total, want: direct.n })
    check(`${status}: every row has payment_status ${status}`, rowsOk)
    check(`${status}: rows.length = total`, (res.rows ?? []).length === res.total)
    check(`${status}: summary.gross_sales matches`, Math.abs(Number(res.summary.gross_sales) - Number(direct.gross)) < 0.011, { got: res.summary.gross_sales, want: direct.gross })
  }

  // ---- D. combination with other filters ----------------------------------
  console.log('D. combined filters')
  const combDirect = await val(root, `select count(*)::int as n
      from public.sales where status = 'COMPLETED' and payment_status = 'DUE'`)
  const comb = await rpc(root, 'sales_report', { p_payment_status: 'DUE', p_status: 'COMPLETED', p_limit: 10000 })
  check(`DUE + COMPLETED -> total = ${combDirect.n}`, comb.total === combDirect.n, { got: comb.total, want: combDirect.n })

  // ---- E. permission gate unchanged ---------------------------------------
  console.log('E. permission gate')
  async function mkUser(email: string, name: string, role: string) {
    const id = (await root.query(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify({ app_role: role, full_name: name })]
    )).rows[0].id as string
    await root.query(
      `insert into public.profiles (id, email, full_name, role)
       values ($1, $2, $3, $4::public.user_role)
       on conflict (id) do update set role = $4::public.user_role, is_active = true`,
      [id, email, name, role])
    return id
  }
  const cashierId = await mkUser('pg13-cashier@t.local', 'PG13 Cashier', 'cashier')
  const adminId = await mkUser('pg13-admin@t.local', 'PG13 Admin', 'admin')
  const cashier = await as(cashierId)
  const admin = await as(adminId)
  await expectError('cashier (no view_reports) denied', () => rpc(cashier, 'sales_report', { p_limit: 5 }), 'permission to view reports')
  const adminRes = await rpc(admin, 'sales_report', { p_payment_status: 'DUE', p_limit: 10000 })
  check('admin with view_reports allowed', adminRes.total === combDirect.n, { got: adminRes.total })
  await cashier.end()
  await admin.end()

  // ---- F. grants on the 15-arg signature ----------------------------------
  console.log('F. grants')
  const g = await val(root, `select
      has_function_privilege('anon', 'public.sales_report(date,date,text,uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,integer,integer,text)', 'EXECUTE') as a,
      has_function_privilege('authenticated', 'public.sales_report(date,date,text,uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,integer,integer,text)', 'EXECUTE') as au,
      has_function_privilege('service_role', 'public.sales_report(date,date,text,uuid,uuid,text,uuid,uuid,uuid,uuid,text,text,integer,integer,text)', 'EXECUTE') as sv`)
  check('anon denied sales_report', g.a === false)
  check('authenticated allowed sales_report', g.au === true)
  check('service_role allowed sales_report', g.sv === true)

  // ---- cleanup temp users --------------------------------------------------
  await root.query(`delete from public.profiles where email like 'pg13-%'`)
  await root.query(`delete from auth.users where email like 'pg13-%'`)
  await root.end()

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`)
  if (failures.length) for (const f of failures) console.log('  -', f)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
