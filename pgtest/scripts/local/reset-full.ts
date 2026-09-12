/**
 * Full-chain fresh validation (Phase 4): drops the local harness and applies
 * the COMPLETE migration chain 0001 -> 0012 in order — the exact path the
 * cloud Supabase will take. NEVER touches the real project.
 */
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', database: 'postgres' }
const MIGRATIONS = [
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
]

const c = new Client(CONN)
await c.connect()

await c.query('drop schema if exists public cascade; create schema public;')
await c.query('drop schema if exists auth cascade;')
await c.query('drop schema if exists storage cascade;')
for (const role of ['anon', 'authenticated', 'service_role']) {
  await c.query(`drop owned by ${role} cascade;`).catch(() => {})
  await c.query(`drop role if exists ${role};`)
  await c.query(`create role ${role} nologin;`)
}
await c.query(`create schema auth;
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
$$;
create schema storage;
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
grant all on all tables in schema auth, storage to postgres, authenticated, service_role;
`)
await c.query('grant all on schema public to postgres; grant usage on schema public to authenticated;')

for (const file of MIGRATIONS) {
  const sql = readFileSync(file, 'utf8')
  try {
    await c.query(sql)
    console.log(`APPLIED: ${file.split('/').pop()}`)
  } catch (e) {
    console.error(`FAILED: ${file.split('/').pop()} — ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
    break
  }
}
await c.end()
