import 'server-only'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

/**
 * Service-role client. SERVER ONLY — bypasses RLS.
 *
 * Guardrails:
 *  - importing this module from client code fails at build time via
 *    the `server-only` package
 *  - every API route that uses it must first authenticate the caller and
 *    verify the required permission with has_app_permission()
 *
 * The key is never shipped to the browser (no NEXT_PUBLIC_ prefix).
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured on the server')
  }

  return createSupabaseClient<Database>(url, serviceKey, {
    auth: {
      // Service key is static; no session round-trips needed
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
