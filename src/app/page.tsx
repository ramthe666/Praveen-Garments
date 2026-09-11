import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * Entry point: authenticated users land on the dashboard, everyone else on
 * the private login screen. (Middleware already guards deeper routes.)
 */
export default async function RootPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  redirect(user ? '/dashboard' : '/login')
}
