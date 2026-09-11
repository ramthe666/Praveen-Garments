#!/usr/bin/env bun
/**
 * TEMPORARY test user for browser verification of the auth flow fixes
 * (trailing-slash redirect loop + wrong-password inline error).
 *
 * Created via the Supabase Auth Admin API (service key, server-side only).
 * The handle_new_user DB trigger auto-creates the profile with app_role.
 *
 * Deleted again by scripts/delete-test-user.ts after the test round.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://YOUR-PROJECT.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var is required')
  process.exit(1)
}

const TEST_EMAIL = 'pg-phase1-test@praveengarments.com'
// Password for this throwaway account: TEST_PASSWORD env var, or randomly
// generated (printed below when created). The account is deleted after tests.
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'Test-' + crypto.randomUUID().slice(0, 8)

const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: 'Phase 1 Test', app_role: 'admin' },
  }),
})

const body = await res.json().catch(() => null)

if (!res.ok) {
  const msg = body?.message ?? body?.msg ?? String(res.status)
  if (typeof msg === 'string' && /already been registered|already exists/i.test(msg)) {
    console.log('STATUS: already_exists')
    process.exit(0)
  }
  console.error(`FAILED: ${msg}`)
  process.exit(1)
}

console.log('STATUS: created')
console.log(`EMAIL: ${body?.email ?? TEST_EMAIL}`)
console.log(`PASSWORD: ${TEST_PASSWORD}`)
console.log(`ID: ${body?.id}`)
