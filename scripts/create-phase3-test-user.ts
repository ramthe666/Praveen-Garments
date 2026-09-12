#!/usr/bin/env bun
/**
 * Phase 3 browser-verification test user (P3TEST).
 * Created via the Supabase Auth Admin API; the handle_new_user trigger
 * auto-creates the profile with app_role 'admin'.
 * Removed after the verification round by purge-phase3-test-data.sql.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const TEST_EMAIL = 'pg-phase3-test@praveengarments.com'
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'P3Test-' + crypto.randomUUID().slice(0, 8)

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
    user_metadata: { full_name: 'Phase 3 Test', app_role: 'admin' },
  }),
})

const body = (await res.json().catch(() => null)) as { message?: string; id?: string } | null

if (!res.ok) {
  const msg = body?.message ?? String(res.status)
  if (/already been registered|already exists/i.test(msg)) {
    console.log('STATUS: already_exists')
  } else {
    console.error(`FAILED: ${msg}`)
    process.exit(1)
  }
} else {
  console.log(`CREATED: ${TEST_EMAIL}`)
  console.log(`PASSWORD: ${TEST_PASSWORD}`)
  console.log(`USER_ID: ${body?.id}`)
}
