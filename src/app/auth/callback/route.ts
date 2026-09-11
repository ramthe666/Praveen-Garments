import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Auth callback: exchanges the one-time code (PKCE) from email links —
 * e.g. password-reset emails — for a session, then forwards to `next`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const nextParam = searchParams.get('next') ?? '/reset-password'

  // Only allow internal paths (no open redirects)
  const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/reset-password'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
    console.error('[auth/callback] code exchange failed:', error.code ?? 'UNKNOWN')
  }

  // Missing or invalid code — send to login with an explanatory flag
  return NextResponse.redirect(`${origin}/login?auth=invalid-link`)
}
