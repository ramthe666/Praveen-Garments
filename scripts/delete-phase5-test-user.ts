#!/usr/bin/env bun
/**
 * Deletes the TEMPORARY Phase 5 browser-verification user (auth user +
 * profile, cascaded via FK). Mirror of delete-test-user.ts for the
 * pg-phase5 email used by create-phase5-test-user.ts.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://YOUR-PROJECT.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const TEST_EMAIL = 'pg-phase5-test@praveengarments.com'

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var is required')
  process.exit(1)
}

const listRes = await fetch(
  `${SUPABASE_URL}/auth/v1/admin/users?page=&per_page=1&emails=${encodeURIComponent(TEST_EMAIL)}`,
  { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
)
const listBody = await listRes.json().catch(() => null)
const user = listBody?.users?.[0]

if (!user) {
  console.log('STATUS: not_found (nothing to delete)')
  process.exit(0)
}

const delRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
  method: 'DELETE',
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
)

if (delRes.ok || delRes.status === 404) {
  console.log(`STATUS: deleted (${TEST_EMAIL})`)
} else {
  console.error(`FAILED: ${delRes.status} ${await delRes.text().catch(() => '')}`)
  process.exit(1)
}
