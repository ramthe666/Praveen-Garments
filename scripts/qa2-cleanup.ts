#!/usr/bin/env bun
/** Delete the temporary QA round-2 user (auth user + profile). */
const SUPABASE_URL = 'https://vrbtgvglbmzdtdutbbpc.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

export {}

// find user id
const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=500`, {
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
})
const { users } = (await list.json()) as { users: Array<{ id: string; email: string }> }
const target = users.find((u) => u.email === 'pg-qa2@praveengarments.com')
if (!target) {
  console.log('QA2 user already absent — nothing to clean.')
  process.exit(0)
}
const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${target.id}`, {
  method: 'DELETE',
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
})
console.log(res.ok ? `DELETED pg-qa2 (${target.id}) + profile cascade` : `DELETE FAILED ${res.status}`)
process.exit(res.ok ? 0 : 1)
