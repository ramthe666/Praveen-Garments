import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'

/**
 * Browser-side Supabase client (anon/publishable key — safe to expose).
 * Cookie-based sessions are handled by @supabase/ssr.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
