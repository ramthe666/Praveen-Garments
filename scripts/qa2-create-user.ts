#!/usr/bin/env bun
/**
 * TEMPORARY QA user for the hydration-fix verification round (pg-qa2).
 * Admin role via user_metadata (handle_new_user trigger creates profile).
 * Deleted again at the end of the round by scripts/qa2-cleanup.ts.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const TEST_EMAIL = 'pg-qa2@praveengarments.com'
const TEST_PASSWORD = 'Qa2Verify-2026'

export {}

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
    user_metadata: { full_name: 'QA Round 2', app_role: 'admin' },
  }),
})

const body = (await res.json().catch(() => null)) as { message?: string; id?: string } | null
if (!res.ok || !body?.id) {
  console.error('CREATE FAILED', res.status, body)
  process.exit(1)
}
console.log(`CREATED id=${body.id} email=${TEST_EMAIL} password=${TEST_PASSWORD}`)
