#!/usr/bin/env bun
/** Phase 4 browser-verification test user (admin). Deleted after the round. */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const TEST_EMAIL = 'pg-phase4-test@praveengarments.com'
const TEST_PASSWORD = 'P4Test-' + crypto.randomUUID().slice(0, 8)

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
    user_metadata: { full_name: 'Phase 4 Test', app_role: 'admin' },
  }),
})
const body = (await res.json().catch(() => null)) as { message?: string; id?: string } | null
if (!res.ok || !body?.id) {
  console.error('CREATE FAILED:', res.status, body?.message ?? body)
  process.exit(1)
}
console.log(JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, id: body.id }))
