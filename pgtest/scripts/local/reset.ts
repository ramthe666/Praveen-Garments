/**
 * Resets the LOCAL harness from scratch: drops public/auth/storage schemas
 * and re-applies all migrations 0001 -> 0006 in order.
 * NEVER touches the real Supabase project.
 *
 * Run: bun run scripts/local/reset.ts
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
]

const c = new Client(CONN)
await c.connect()

// fresh stub environment
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
create or replace function auth.uid()
returns uuid language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;
create schema storage;
create table storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[],
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id), name text not null, owner uuid,
  metadata jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
grant usage on schema auth, storage, public to anon, authenticated, service_role;`)

for (const m of MIGRATIONS) {
  const sql = readFileSync(m, 'utf8')
  await c.query(sql)
  console.log(`applied ${m.split('/').pop()}`)
}

await c.end()
console.log('local harness reset complete')
