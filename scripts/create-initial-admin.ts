#!/usr/bin/env bun
/**
 * Creates the initial Admin account for Praveen Garments via the Supabase
 * Auth Admin API (service key, server-side only — nothing hardcoded in the
 * application). Prints credentials ONCE for secure handover.
 *
 * Safe to re-run: existing users are left untouched.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://YOUR-PROJECT.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var is required')
  process.exit(1)
}

const ADMIN_EMAIL = 'praveen@praveengarments.com'

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$'
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

const password = generatePassword()

const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    email: ADMIN_EMAIL,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Praveen (Owner)', app_role: 'admin' },
  }),
})

const body = await res.json().catch(() => null)

if (!res.ok) {
  const msg = body?.message ?? body?.msg ?? String(res.status)
  if (typeof msg === 'string' && /already been registered|already exists/i.test(msg)) {
    console.log('STATUS: already_exists (no changes made)')
    console.log(`EMAIL: ${ADMIN_EMAIL}`)
    process.exit(0)
  }
  console.error(`FAILED: ${msg}`)
  process.exit(1)
}

console.log('STATUS: created')
console.log(`EMAIL: ${body?.email ?? ADMIN_EMAIL}`)
console.log(`ID: ${body?.id}`)
console.log(`PASSWORD: ${password}`)
console.log('NOTE: change this password after first sign-in.')
