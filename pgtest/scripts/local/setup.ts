/**
 * Local PostgreSQL harness that emulates the Supabase environment closely
 * enough to validate migrations + RLS + RPC logic WITHOUT touching the real
 * Supabase project:
 *   - roles: anon / authenticated / service_role
 *   - schema auth: auth.users table + auth.uid() reading the
 *     `request.jwt.claim.sub` GUC (exactly how PostgREST passes the JWT sub)
 *   - schema storage: buckets + objects stubs for storage policies
 *
 * Run: bun run scripts/local/setup.ts
 */
import { Client } from 'pg'

const CONN = { host: 'localhost', port: 5433, user: 'postgres', database: 'postgres' }

async function main() {
  const c = new Client(CONN)
  await c.connect()

  // -- roles (Supabase API roles) --
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await c.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then
        create role ${role} nologin;
      end if;
    end $$;`)
  }

  // -- auth schema stub --
  await c.query(`create schema if not exists auth;`)
  await c.query(`
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique,
      encrypted_password text,
      email_confirmed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );`)
  // auth.uid() mirrors PostgREST: reads the JWT `sub` claim GUC
  await c.query(`
    create or replace function auth.uid()
    returns uuid
    language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;`)
  await c.query(`grant usage on schema auth to anon, authenticated, service_role;`)

  // -- storage schema stub --
  await c.query(`create schema if not exists storage;`)
  await c.query(`
    create table if not exists storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[],
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );`)
  await c.query(`
    create table if not exists storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text references storage.buckets (id),
      name text not null,
      owner uuid,
      metadata jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );`)
  await c.query(`grant usage on schema storage to anon, authenticated, service_role;`)

  await c.query(`grant usage on schema public to anon, authenticated, service_role;`)

  console.log('Local Supabase-compatible harness ready on localhost:5433')
  await c.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
