#!/usr/bin/env bun
/**
 * TEMPORARY Phase 5 browser-verification user (admin role) created via the
 * Supabase Auth Admin API. Deleted again by scripts/delete-test-user.ts
 * (same pattern as create-test-user.ts from Phase 1).
 *
 * Run: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *      bun run scripts/create-phase5-test-user.ts
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://YOUR-PROJECT.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL ?? 'pg-phase5-test@praveengarments.com'
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'Phase5-Verify-2026'

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var is required')
  process.exit(1)
}

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
    user_metadata: { full_name: 'Phase 5 Verify', app_role: 'admin' },
  }),
})

const body = await res.json().catch(() => null)
if (!res.ok) {
  const msg = body?.message ?? body?.msg ?? String(res.status)
  if (typeof msg === 'string' && /already been registered|already exists/i.test(msg)) {
    console.log('STATUS: already_exists')
  } else {
    console.error(`FAILED: ${msg}`)
    process.exit(1)
  }
} else {
  console.log('STATUS: created')
  console.log(`EMAIL: ${body?.email ?? TEST_EMAIL}`)
  console.log(`USER_ID: ${body?.id ?? ''}`)
}
console.log(`EMAIL_FINAL: ${TEST_EMAIL}`)
console.log(`PASSWORD_FINAL: ${TEST_PASSWORD}`)
