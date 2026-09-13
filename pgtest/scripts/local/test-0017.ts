/**
 * 0017 (purchase invoice tax fix) — local test suite.
 * Runs against the local Supabase-compatible harness (NOT production).
 *
 * Strategy: the test resets a FRESH chain 0001 -> 0016 (NOT 0017), creates
 * invoices under the OLD (buggy) math — reproducing P9-BUG-2 in this very
 * run — then applies 0017 mid-suite and proves:
 *
 *   A. the data repair: existing DRAFT/RECEIVED invoices get document totals
 *      recomputed from their (always mode-correct) item rows;
 *      paid_amount is never rewritten; due floors at 0; payment_status
 *      follows the engine convention; CANCELLED invoices untouched;
 *   B. the new math: default tax_mode 'exclusive' (cost + GST on top),
 *      PO/PI agreement for identical items, explicit 'inclusive' honoured,
 *      grand = Σ line_total in BOTH modes (also for multi-line + discounts);
 *   C. downstream consistency: return credits, FIFO payments, the
 *      PAYMENT_EXCEEDS_DUE guard, purchase_report / dashboard payables /
 *      gst_report (relational sums straight from the database);
 *   D. idempotency: re-applying 0017 changes nothing (row hash compare);
 *   E. security + grants: anon denied at the ACL, cashier/accountant denied
 *      by the permission gate, authenticated + service_role keep EXECUTE,
 *      RLS policy count on purchase_invoices unchanged;
 *   F. non-regression: purchase ORDER math is untouched (identical totals
 *      before and after 0017).
 *
 * Run: PGPASSWORD=postgres bun run scripts/local/test-0017.ts
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'postgres' }
const MIGRATIONS_0016 = [
  '../supabase/migrations/0001_core_schema.sql',
  '../supabase/migrations/0002_rls_policies.sql',
  '../supabase/migrations/0003_storage.sql',
  '../supabase/migrations/0004_products_catalog.sql',
  '../supabase/migrations/0005_inventory_stock.sql',
  '../supabase/migrations/0006_product_images_storage.sql',
  '../supabase/migrations/0007_audit_email_attribution.sql',
  '../supabase/migrations/0008_pos_billing.sql',
  '../supabase/migrations/0009_phase4_business_operations.sql',
  '../supabase/migrations/0010_phase4_active_filter_fix.sql',
  '../supabase/migrations/0011_phase4_statement_till_payments.sql',
  '../supabase/migrations/0012_phase5_reporting.sql',
  '../supabase/migrations/0013_sales_report_payment_status.sql',
  '../supabase/migrations/0014_phase6_report_exchange_cash.sql',
  '../supabase/migrations/0015_phase8_ist_date_boundaries.sql',
  '../supabase/migrations/0016_phase8_search_attributes.sql',
]

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`) }
}
const close = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps
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
  await root.query("set timezone to 'UTC'")

  // =========================================================================
  console.log('== 0. FRESH RESET: chain 0001 -> 0016 (old math in force) ==')
  await root.query('drop schema if exists public cascade; create schema public;')
  await root.query('drop schema if exists auth cascade;')
  await root.query('drop schema if exists storage cascade;')
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await root.query(`drop owned by ${role} cascade;`).catch(() => {})
    await root.query(`drop role if exists ${role};`)
    await root.query(`create role ${role} nologin;`)
  }
  await root.query(`create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;`)
  await root.query(`create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);
grant usage on schema auth, storage to postgres, authenticated, service_role;
grant all on all tables in schema auth, storage to postgres, authenticated, service_role;`)
  await root.query('grant all on schema public to postgres; grant usage on schema public to authenticated;')
  for (const file of MIGRATIONS_0016) {
    await root.query(readFileSync(file, 'utf8'))
  }
  console.log('  chain applied (16 migrations)')

  async function as(userId: string | null): Promise<Client> {
    const c = new Client(CONN)
    await c.connect()
    if (userId === null) await c.query('set role anon')
    else {
      await c.query('set role authenticated')
      await c.query("select set_config('request.jwt.claim.sub', $1, false)", [userId])
    }
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

  // =========================================================================
  console.log('\n== 1. SEED (users, supplier, catalog, PO before 0017) ==')
  async function mkUser(email: string, name: string, role: string) {
    const id = (await root.query(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify({ app_role: role, full_name: name })]
    )).rows[0].id as string
    await root.query(
      `insert into public.profiles (id, email, full_name, role)
       values ($1, $2, $3, $4::public.user_role)
       on conflict (id) do update set role = $4::public.user_role, is_active = true, email = $2, full_name = $3`,
      [id, email, name, role])
    return id
  }
  const adminId = await mkUser('t17-admin@t.local', 'T17 Admin', 'admin')
  const cashId = await mkUser('t17-cash@t.local', 'T17 Cashier', 'cashier')
  const acctId = await mkUser('t17-acct@t.local', 'T17 Accountant', 'accountant')
  const admin = await as(adminId)
  const cashier = await as(cashId)
  const accountant = await as(acctId)
  const anon = await as(null)

  const supplier = (await val(root, `insert into public.suppliers (name, phone) values ('T17 Fabrics', '9876500001') returning id`)).id
  const supplierB = (await val(root, `insert into public.suppliers (name, phone) values ('T17 Trims', '9876500002') returning id`)).id
  const supplierC = (await val(root, `insert into public.suppliers (name, phone) values ('T17 Cottons', '9876500003') returning id`)).id
  const mainLoc = (await val(root, `select id from public.stock_locations where code = 'MAIN'`)).id
  const cat = (await val(root, `insert into public.categories (name) values ('T17 Shirts') returning id`)).id
  const brand = (await val(root, `insert into public.brands (name) values ('T17 Brand') returning id`)).id
  const sizeM = (await val(root, `select id from public.sizes where name = 'M'`)).id
  const colorBlk = (await val(root, `select id from public.colors where name = 'Black'`)).id

  // 12% GST product (apparel) + 5% product
  const p12 = (await val(root, `insert into public.products
    (name, product_code, category_id, brand_id, hsn_code, gst_rate, mrp, cost_price, selling_price)
    values ('T17 Formal Shirt', 'T17FS', $1, $2, '620520', 12, 999, 600, 899) returning id`, [cat, brand])).id
  const p5 = (await val(root, `insert into public.products
    (name, product_code, category_id, brand_id, hsn_code, gst_rate, mrp, cost_price, selling_price)
    values ('T17 Kid Tee', 'T17KT', $1, $2, '610910', 5, 399, 320, 349) returning id`, [cat, brand])).id
  const v12 = (await val(root, `insert into public.product_variants
    (product_id, sku, size_id, color_id, cost_price, mrp, selling_price)
    values ($1, 'T17FS-M-BLK', $2, $3, 600, 999, 899) returning id`, [p12, sizeM, colorBlk])).id
  const v5 = (await val(root, `insert into public.product_variants
    (product_id, sku, size_id, color_id, cost_price, mrp, selling_price)
    values ($1, 'T17KT-M-BLK', $2, $3, 320, 399, 349) returning id`, [p5, sizeM, colorBlk])).id
  check('seed: users/supplier/catalog ready', !!(supplier && mainLoc && v12 && v5))

  // PO under the OLD code — non-regression anchor
  const poOld = await rpc(admin, 'create_purchase_order', {
    p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc,
      items: [{ variant_id: v12, quantity: 10, unit_cost: 600 }] }),
  })
  const poOldRow = await val(root, `select * from public.purchase_orders where id = $1`, [poOld.po_id])
  check('OLD: PO math (10 x 600 @ 12%) = 6000 / 720 / 6720',
    Number(poOldRow.subtotal) === 6000 && Number(poOldRow.tax_total) === 720 && Number(poOldRow.grand_total) === 6720, poOldRow)
  await rpc(admin, 'set_purchase_order_status', { p_po_id: poOld.po_id, p_status: 'ORDERED' })
  const poOldItem = (await val(root, `select id from public.purchase_order_items where po_id = $1`, [poOld.po_id])).id

  // =========================================================================
  console.log('\n== 2. OLD-MATH INVOICES (reproducing P9-BUG-2 in this run) ==')
  // PI-A: no tax_mode -> old fallback inherited pos.default_tax_mode = 'inclusive'
  const piA = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc,
      po_id: poOld.po_id, supplier_invoice_no: 'T17-A',
      items: [{ variant_id: v12, quantity: 10, unit_cost: 600, po_item_id: poOldItem }], status: 'RECEIVED' }),
  })
  const piARow = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-A'`)
  check('OLD repro A: mode inherited INCLUSIVE from the POS sales setting',
    piARow.tax_mode === 'inclusive', piARow.tax_mode)
  check('OLD repro A: grand inflated 6642.86 (6000 + 642.86 extracted tax added again)',
    close(Number(piARow.grand_total), 6642.86) && Number(piARow.due_amount) === Number(piARow.grand_total), piARow)
  // partial payment 3000 against the inflated payable
  await rpc(admin, 'record_supplier_payment', { p_supplier_id: supplier, p_amount: 3000, p_method: 'Cash', p_reference: 't17-a-part' })
  // purchase return 3 of 10 (credit is line-proportional: 1800)
  const piAItem = (await val(root, `select id from public.purchase_invoice_items where invoice_id = $1`, [piARow.id])).id
  const retA = await rpc(admin, 'create_purchase_return', {
    p_payload: JSON.stringify({ purchase_invoice_id: piARow.id, reason: 't17 colour bleed',
      items: [{ invoice_item_id: piAItem, quantity: 3 }] }),
  })
  check('OLD: return credit 1800 (3 units of the 600-per-unit inclusive line)', close(Number(retA.grand_total), 1800), retA)

  // PI-B: fully paid at the inflated total (mirrors the live cloud invoice PI-2026-000002)
  // separate supplier so the FIFO engine cannot reallocate this payment to PI-A
  const piB = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplierB, location_id: mainLoc,
      supplier_invoice_no: 'T17-B', status: 'RECEIVED',
      items: [{ variant_id: v5, quantity: 5, unit_cost: 320 }] }),
  })
  const piBRow = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-B'`)
  check('OLD repro B: 5 x 320 @ 5% inclusive inflated grand 1676.19', close(Number(piBRow.grand_total), 1676.19), piBRow)
  await rpc(admin, 'record_supplier_payment', { p_supplier_id: supplierB, p_amount: 1676.19, p_method: 'UPI', p_reference: 't17-b-full' })

  // PI-C: explicit EXCLUSIVE draft — old math double-counted here too
  const piC = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc,
      supplier_invoice_no: 'T17-C', status: 'DRAFT', tax_mode: 'exclusive',
      items: [{ variant_id: v12, quantity: 10, unit_cost: 600 }] }),
  })
  const piCRow = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-C'`)
  check('OLD repro C: exclusive 10 x 600 @ 12% inflated grand 7440 (tax added twice)', close(Number(piCRow.grand_total), 7440), piCRow)

  // PI-D: explicit INCLUSIVE draft with a line discount
  const piD = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc,
      supplier_invoice_no: 'T17-D', status: 'DRAFT', tax_mode: 'inclusive',
      items: [{ variant_id: v5, quantity: 4, unit_cost: 250, discount_amount: 100 }] }),
  })
  const piDRow = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-D'`)
  check('OLD repro D: inclusive + 100 line discount inflated grand 842.86 (discount subtracted twice + tax on top)',
    close(Number(piDRow.grand_total), 842.86), piDRow)

  const rlsCount = Number((await val(root,
    `select count(*)::int as c from pg_policies where schemaname = 'public' and tablename = 'purchase_invoices'`)).c)

  // =========================================================================
  console.log('\n== 3. APPLY 0017 ==')
  await root.query(readFileSync('../supabase/migrations/0017_phase11_purchase_tax_fix.sql', 'utf8'))
  console.log('  0017 applied OK')

  // =========================================================================
  console.log('\n== 4. DATA REPAIR VERIFICATION ==')
  const piARow2 = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-A'`)
  check('repair A: totals from items — sub 6000, disc 0, tax 642.86, grand 6000 (Σ line)',
    Number(piARow2.subtotal) === 6000 && Number(piARow2.discount_total) === 0 &&
    close(Number(piARow2.tax_total), 642.86) && Number(piARow2.grand_total) === 6000, piARow2)
  check('repair A: paid stays 3000 (real payment untouched)',
    Number(piARow2.paid_amount) === 3000, piARow2)
  check('repair A: due = 6000 - 3000 paid - 1800 return credit = 1200, PARTIALLY_PAID',
    Number(piARow2.due_amount) === 1200 && piARow2.payment_status === 'PARTIALLY_PAID', piARow2)

  const piBRow2 = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-B'`)
  check('repair B: grand 1600 (the true inclusive total); paid 1676.19 kept; due floored 0; PAID',
    Number(piBRow2.grand_total) === 1600 && Number(piBRow2.paid_amount) === 1676.19 &&
    Number(piBRow2.due_amount) === 0 && piBRow2.payment_status === 'PAID', piBRow2)
  check('repair B: the 76.19 historical over-charge stays visible in the columns (documented, not rewritten)',
    close(Number(piBRow2.paid_amount) - Number(piBRow2.grand_total), 76.19), piBRow2)

  const piCRow2 = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-C'`)
  check('repair C (DRAFT): sub 6000, tax 720, grand 6720 — discount not double-subtracted',
    Number(piCRow2.subtotal) === 6000 && Number(piCRow2.tax_total) === 720 && Number(piCRow2.grand_total) === 6720, piCRow2)
  check('repair C (DRAFT): payable side untouched pre-receive (due 0, DUE)',
    Number(piCRow2.due_amount) === 0 && piCRow2.payment_status === 'DUE', piCRow2)
  // confirming a repaired DRAFT uses the repaired grand
  await rpc(admin, 'confirm_purchase_invoice', { p_invoice_id: piCRow2.id })
  const piCRow3 = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-C'`)
  check('repair C: confirm a repaired DRAFT -> due = repaired grand 6720',
    piCRow3.status === 'RECEIVED' && Number(piCRow3.due_amount) === 6720, piCRow3)

  const piDRow2 = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-D'`)
  check('repair D (DRAFT, discount): sub 1000, disc 100, tax 42.86, grand 900 (= Σ line)',
    Number(piDRow2.subtotal) === 1000 && Number(piDRow2.discount_total) === 100 &&
    close(Number(piDRow2.tax_total), 42.86) && Number(piDRow2.grand_total) === 900, piDRow2)

  const rlsCount2 = Number((await val(root,
    `select count(*)::int as c from pg_policies where schemaname = 'public' and tablename = 'purchase_invoices'`)).c)
  check('repair: RLS policy count on purchase_invoices unchanged', rlsCount === rlsCount2, { before: rlsCount, after: rlsCount2 })

  // =========================================================================
  console.log('\n== 5. NEW MATH (post-0017 create_purchase_invoice) ==')
  // N1: default — must be EXCLUSIVE now and agree with the PO (own supplier:
  // keeps the FIFO engine away from the other test invoices)
  const poN1 = await rpc(admin, 'create_purchase_order', {
    p_payload: JSON.stringify({ supplier_id: supplierC, location_id: mainLoc,
      items: [{ variant_id: v12, quantity: 10, unit_cost: 600 }] }),
  })
  const poN1Row = await val(root, `select * from public.purchase_orders where id = $1`, [poN1.po_id])
  check('non-regression: PO math identical after 0017 (6000 / 720 / 6720)',
    Number(poN1Row.subtotal) === 6000 && Number(poN1Row.tax_total) === 720 && Number(poN1Row.grand_total) === 6720, poN1Row)
  await rpc(admin, 'set_purchase_order_status', { p_po_id: poN1.po_id, p_status: 'ORDERED' })
  const poN1Item = (await val(root, `select id from public.purchase_order_items where po_id = $1`, [poN1.po_id])).id

  const n1 = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplierC, location_id: mainLoc,
      po_id: poN1.po_id, supplier_invoice_no: 'T17-N1', status: 'RECEIVED',
      items: [{ variant_id: v12, quantity: 10, unit_cost: 600, po_item_id: poN1Item }] }),
  })
  const n1Row = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-N1'`)
  check('NEW default: tax_mode stored EXCLUSIVE (pos sales setting no longer leaks)',
    n1Row.tax_mode === 'exclusive', n1Row.tax_mode)
  check('NEW default: PI grand 6720 == PO grand 6720 for the same 10 x 600 @ 12%',
    Number(n1Row.grand_total) === 6720 && Number(n1Row.grand_total) === Number(poN1Row.grand_total),
    { pi: n1Row.grand_total, po: poN1Row.grand_total })
  check('NEW default: sub 6000 / tax 720 / due 6720 (payable = corrected grand)',
    Number(n1Row.subtotal) === 6000 && Number(n1Row.tax_total) === 720 && Number(n1Row.due_amount) === 6720, n1Row)
  check('NEW default: RPC return payload grand matches the stored grand',
    close(Number(n1.grand_total), 6720) && close(Number(n1.due_amount), 6720), n1)

  // N2: explicit inclusive honoured
  const n2 = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc,
      supplier_invoice_no: 'T17-N2', status: 'RECEIVED', tax_mode: 'inclusive',
      items: [{ variant_id: v12, quantity: 10, unit_cost: 600 }] }),
  })
  const n2Row = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-N2'`)
  check('NEW inclusive (explicit): grand 6000 — costs contain the GST; tax 642.86 reported inside',
    n2Row.tax_mode === 'inclusive' && Number(n2Row.grand_total) === 6000 && close(Number(n2Row.tax_total), 642.86) &&
    Number(n2Row.due_amount) === 6000, n2Row)

  // N3: exclusive + line discount
  const n3 = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc,
      supplier_invoice_no: 'T17-N3', status: 'DRAFT', tax_mode: 'exclusive',
      items: [{ variant_id: v12, quantity: 10, unit_cost: 600, discount_amount: 200 }] }),
  })
  const n3Row = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-N3'`)
  check('NEW exclusive + 200 discount: sub 6000, disc 200, tax 696, grand 6496 = Σ line (5800 taxable + 696)',
    Number(n3Row.subtotal) === 6000 && Number(n3Row.discount_total) === 200 &&
    close(Number(n3Row.tax_total), 696) && Number(n3Row.grand_total) === 6496, n3Row)

  // N4: multi-line, mixed GST rates
  const n4 = await rpc(admin, 'create_purchase_invoice', {
    p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc,
      supplier_invoice_no: 'T17-N4', status: 'DRAFT',
      items: [
        { variant_id: v12, quantity: 3, unit_cost: 400 },
        { variant_id: v5, quantity: 5, unit_cost: 200 },
      ] }),
  })
  const n4Row = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-N4'`)
  check('NEW multi-line: sub 2200, tax 194 (144 + 50), grand 2394 = Σ lines',
    Number(n4Row.subtotal) === 2200 && close(Number(n4Row.tax_total), 194) && Number(n4Row.grand_total) === 2394, n4Row)

  // global invariant: grand == Σ line_total for every non-cancelled invoice
  const bad = await root.query(`
    select pi.invoice_number, pi.grand_total, round(coalesce(sum(pii.line_total), 0), 2) as lines
      from public.purchase_invoices pi
      left join public.purchase_invoice_items pii on pii.invoice_id = pi.id
     where pi.status <> 'CANCELLED'
     group by pi.id, pi.invoice_number, pi.grand_total
    having abs(pi.grand_total - round(coalesce(sum(pii.line_total), 0), 2)) > 0.005`)
  check('INVARIANT: grand_total = Σ line_total on EVERY non-cancelled invoice', bad.rows.length === 0, bad.rows)

  // =========================================================================
  console.log('\n== 6. DOWNSTREAM: return credits + payments on corrected payables ==')
  const n1Item = (await val(root, `select id, quantity from public.purchase_invoice_items where invoice_id = $1`, [n1Row.id])).id
  const retN1 = await rpc(admin, 'create_purchase_return', {
    p_payload: JSON.stringify({ purchase_invoice_id: n1Row.id, reason: 't17 three defective',
      items: [{ invoice_item_id: n1Item, quantity: 3 }] }),
  })
  check('return credit on corrected invoice: 3 of 10 units = 2016 (672 per line unit)',
    close(Number(retN1.grand_total), 2016), retN1)
  const n1Row2 = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-N1'`)
  check('payable after return: 6720 - 2016 = 4704', Number(n1Row2.due_amount) === 4704, n1Row2)
  await rpc(admin, 'record_supplier_payment', { p_supplier_id: supplierC, p_amount: 4704, p_method: 'Cash', p_reference: 't17-n1-rest' })
  const n1Row3 = await val(root, `select * from public.purchase_invoices where supplier_invoice_no = 'T17-N1'`)
  check('paying the corrected remainder settles exactly (due 0, PAID)',
    Number(n1Row3.due_amount) === 0 && n1Row3.payment_status === 'PAID' && Number(n1Row3.paid_amount) === 4704, n1Row3)
  await expectError('PAYMENT_EXCEEDS_DUE now guards the CORRECTED payable (nothing left)',
    () => rpc(admin, 'record_supplier_payment', { p_supplier_id: supplierC, p_amount: 1, p_method: 'Cash' }),
    'PAYMENT_EXCEEDS_DUE')

  // =========================================================================
  console.log('\n== 7. REPORT-LEVEL (relational sums straight from the database) ==')
  const pr = await rpc(admin, 'purchase_report', { p_date_from: null, p_date_to: null, p_limit: 50 })
  const expVal = Number((await val(root,
    `select coalesce(sum(grand_total), 0) as v from public.purchase_invoices where status = 'RECEIVED'`)).v)
  const expDue = Number((await val(root,
    `select coalesce(sum(due_amount), 0) as d from public.purchase_invoices where status = 'RECEIVED' and due_amount > 0`)).d)
  check('purchase_report value == Σ repaired grand (RECEIVED only)', close(Number(pr.summary.value), expVal),
    { report: pr.summary.value, db: expVal })
  check('purchase_report due == Σ repaired due', close(Number(pr.summary.due), expDue),
    { report: pr.summary.due, db: expDue })

  const dash = await rpc(admin, 'dashboard_summary', {})
  const expPayable = Number((await val(root,
    `select coalesce(sum(pi.due_amount), 0) as p from public.purchase_invoices pi
      where pi.status = 'RECEIVED' and pi.due_amount > 0`)).p)
  check('dashboard supplier payable == Σ repaired due', close(Number(dash.suppliers.payable), expPayable),
    { dash: dash.suppliers.payable, db: expPayable })
  const expPurVal = Number((await val(root,
    `select coalesce(sum(pi.grand_total), 0) as v from public.purchase_invoices pi where pi.status = 'RECEIVED'`)).v)
  check('dashboard purchase value == Σ repaired grand', close(Number(dash.purchases.purchase_value), expPurVal),
    { dash: dash.purchases.purchase_value, db: expPurVal })

  const gst = await rpc(admin, 'gst_report', { p_date_from: null, p_date_to: null })
  const expGst = await val(root, `
    select round(coalesce(sum(pii.tax_amount), 0), 2) as tax,
           round(coalesce(sum(pii.line_total - pii.tax_amount), 0), 2) as taxable
      from public.purchase_invoice_items pii
      join public.purchase_invoices pi on pi.id = pii.invoice_id
     where pi.status = 'RECEIVED'`)
  const gstPurch = (gst.purchases ?? gst.purchase ?? []).reduce((s: number, r: any) => s + Number(r.total_tax ?? 0), 0)
  check('gst_report purchase tax == Σ item tax (item-level, never affected by the bug)',
    close(gstPurch, Number(expGst.tax)), { report: gstPurch, db: expGst.tax })

  // weighted-average cost basis is item-level and untouched
  const avgRow = await val(root, `
    select round(coalesce(sum(pii.line_total - pii.tax_amount) / nullif(sum(pii.quantity - pii.returned_quantity), 0), 0), 2) as avg
      from public.purchase_invoice_items pii
      join public.purchase_invoices pi on pi.id = pii.invoice_id
     where pi.status = 'RECEIVED' and pii.variant_id = $1`, [v12])
  check('weighted-average cost still derives from (line - tax) at the item level',
    Number(avgRow.avg) > 0, avgRow)

  // =========================================================================
  console.log('\n== 8. IDEMPOTENCY (re-apply 0017 — nothing changes) ==')
  const hashBefore = (await val(root, `
    select md5(string_agg(t::text, '|' order by t.id)) as h from (
      select id, invoice_number, status, tax_mode, subtotal, discount_total, tax_total,
             grand_total, paid_amount, due_amount, payment_status
        from public.purchase_invoices
    ) t`)).h
  await root.query(readFileSync('../supabase/migrations/0017_phase11_purchase_tax_fix.sql', 'utf8'))
  const hashAfter = (await val(root, `
    select md5(string_agg(t::text, '|' order by t.id)) as h from (
      select id, invoice_number, status, tax_mode, subtotal, discount_total, tax_total,
             grand_total, paid_amount, due_amount, payment_status
        from public.purchase_invoices
    ) t`)).h
  check('re-applying 0017 leaves every invoice row byte-identical', hashBefore === hashAfter, { hashBefore, hashAfter })

  // =========================================================================
  console.log('\n== 9. SECURITY + GRANTS ==')
  await expectError('anon cannot call create_purchase_invoice (ACL)',
    () => rpc(anon, 'create_purchase_invoice', {
      p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc, items: [{ variant_id: v12, quantity: 1, unit_cost: 1 }] }),
    }), 'permission')
  await expectError('cashier denied by the manage_purchases gate',
    () => rpc(cashier, 'create_purchase_invoice', {
      p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc, items: [{ variant_id: v12, quantity: 1, unit_cost: 1 }] }),
    }), 'permission')
  await expectError('accountant denied too (view-only on purchases)',
    () => rpc(accountant, 'create_purchase_invoice', {
      p_payload: JSON.stringify({ supplier_id: supplier, location_id: mainLoc, items: [{ variant_id: v12, quantity: 1, unit_cost: 1 }] }),
    }), 'permission')

  const grants = await val(root, `
    select bool_or(has_function_privilege('authenticated', 'public.create_purchase_invoice(jsonb)', 'EXECUTE')) as auth_ok,
           bool_or(has_function_privilege('service_role', 'public.create_purchase_invoice(jsonb)', 'EXECUTE')) as svc_ok,
           bool_or(has_function_privilege('anon', 'public.create_purchase_invoice(jsonb)', 'EXECUTE')) as anon_bad
      from pg_proc where oid = 'public.create_purchase_invoice(jsonb)'::regprocedure`)
  check('grants: authenticated + service_role EXECUTE, anon none',
    grants.auth_ok === true && grants.svc_ok === true && (grants.anon_bad ?? false) === false, grants)

  await admin.end(); await cashier.end(); await accountant.end(); await anon.end()
  await root.end()

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`)
  if (failures.length) { console.log(failures.map((f) => `  FAIL: ${f}`).join('\n')); process.exit(1) }
}

main().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1) })
