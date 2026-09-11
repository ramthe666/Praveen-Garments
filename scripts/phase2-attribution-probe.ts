#!/usr/bin/env bun
/**
 * Isolation probe: does a catalog-table INSERT through an AUTHENTICATED
 * session client (outside the app) produce an audit row WITH user_id?
 * - If YES → the DB path is fine and the app build is stale.
 * - If NO  → something deeper with triggers/JWT attribution.
 */
import { createServerClient } from '@supabase/ssr/dist/module/index.js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const EMAIL = process.env.P2_ADMIN_EMAIL ?? 'pg-phase1-test@praveengarments.com'
const PASSWORD = process.env.P2_ADMIN_PASSWORD!

const jar = new Map<string, string>()
const client = createServerClient(SUPABASE_URL, ANON_KEY, {
  cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (list: { name: string; value: string }[]) => {
      for (const c of list) jar.set(c.name, c.value)
    },
  },
})

const { error } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (error) {
  console.error('sign-in failed:', error.message)
  process.exit(1)
}

const name = 'PROBE-direct-' + Date.now()
const { data, error: insertErr } = await client.from('categories').insert({ name, description: 'direct session insert probe' }).select().single()
console.log('insert:', insertErr ? 'FAILED — ' + insertErr.message : 'OK', JSON.stringify(data)?.slice(0, 80))

// fetch the audit row for it via service key
const res = await fetch(`${SUPABASE_URL}/rest/v1/audit_logs?select=action,user_id,user_email&entity_type=eq.categories&entity_id=eq.${data?.id}&limit=1`, {
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
})
const audit = await res.json()
console.log('audit row:', JSON.stringify(audit))

// also: whoami via RPC to confirm the JWT identity on data-plane calls
const who = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_inventory_stats`, {
  method: 'POST',
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
  body: '{}',
})
console.log('(sanity) anon stats call:', who.status)
