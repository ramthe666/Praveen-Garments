#!/usr/bin/env bun
/** Quick verification: does the REBUILT app's PATCH route now attribute audit rows? */
import { createServerClient } from '@supabase/ssr/dist/module/index.js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const EMAIL = process.env.P2_ADMIN_EMAIL ?? 'pg-phase1-test@praveengarments.com'
const PASSWORD = process.env.P2_ADMIN_PASSWORD!
const state = JSON.parse(await Bun.file('/home/z/my-project/scripts/.p2test-state.json').text())

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
const COOKIE = [...jar].map(([n, v]) => `${n}=${v}`).join('; ')

const price = 900 + Math.floor(Math.random() * 50)
const res = await fetch(`http://localhost:3000/api/admin/products/${state.productId}`, {
  method: 'PATCH',
  headers: { Cookie: COOKIE, 'Content-Type': 'application/json' },
  body: JSON.stringify({ selling_price: price }),
})
console.log('PATCH status:', res.status, 'price:', price)

// latest audit rows for this product
const audit = await fetch(`${SUPABASE_URL}/rest/v1/audit_logs?select=action,user_id,user_email&entity_id=eq.${state.productId}&order=created_at.desc&limit=3`, {
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
}).then((r) => r.json())
console.log('latest audit rows:', JSON.stringify(audit, null, 2))
