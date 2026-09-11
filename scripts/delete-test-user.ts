#!/usr/bin/env bun
/**
 * Deletes the TEMPORARY Phase 1 test user created by
 * scripts/create-test-user.ts (auth user + profile, which cascades via FK).
 * Run after browser verification rounds.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://YOUR-PROJECT.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var is required')
  process.exit(1)
}

const TEST_EMAIL = 'pg-phase1-test@praveengarments.com'

// Look up the user by email first (admin API needs the id)
const listRes = await fetch(
  `${SUPABASE_URL}/auth/v1/admin/users?page=&per_page=1&emails=${encodeURIComponent(TEST_EMAIL)}`,
  {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  },
)
const listBody = await listRes.json().catch(() => null)
const user = listBody?.users?.[0]

if (!user) {
  console.log('STATUS: not_found (nothing to delete)')
  process.exit(0)
}

const delRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
  method: 'DELETE',
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  },
})

if (delRes.ok || delRes.status === 404) {
  console.log(`STATUS: deleted (${TEST_EMAIL})`)
  console.log('NOTE: profiles row removed automatically by ON DELETE CASCADE.')
} else {
  const body = await delRes.text().catch(() => '')
  console.error(`FAILED: ${delRes.status} ${body}`)
  process.exit(1)
}
