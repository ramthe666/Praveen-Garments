#!/usr/bin/env bun
/** Quick local PG state probe: is 0009 applied? */
import { Client } from 'pg'
const c = new Client({ host: 'localhost', port: 5433, user: 'postgres', database: 'postgres' })
await c.connect()
const q = async (sql: string) => (await c.query(sql)).rows
const tables = await q(`select tablename from pg_tables where schemaname='public' order by 1`)
console.log('tables:', tables.map((r: any) => r.tablename).join(', '))
const fns = await q(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('record_customer_payment','create_purchase_order','create_purchase_invoice','create_sales_return','create_exchange','create_expense','payments_page','customers_page','next_doc_number','doc_prefix') order by 1`)
console.log('phase4 fns:', fns.map((r: any) => r.proname).join(', '))
const perms = await q(`select unnest(enum_range(null::public.app_permission))::text as p order by 1`)
console.log('permissions:', perms.map((r: any) => r.p).join(', '))
const counters = await q(`select * from public.doc_number_counters order by 1 limit 10`)
console.log('doc_number_counters:', JSON.stringify(counters))
await c.end()
