import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * Edge middleware:
 *  1. refreshes the Supabase session cookie on every matched request
 *     (transparent token rotation; expired/revoked refresh tokens end here)
 *  2. protects every route except the public allow-list
 *  3. bounces signed-in users away from the login/forgot screens
 *
 * The hosting preview proxy ADDS a trailing slash when redirecting
 * (e.g. /dashboard -> /dashboard/). Combined with next.config's
 * skipTrailingSlashRedirect, this app serves BOTH forms, so every path
 * check below runs on a normalised pathname (trailing slashes stripped)
 * to guarantee identical protection for /dashboard and /dashboard/ alike.
 */
export async function middleware(request: NextRequest) {
  const { user, supabaseResponse } = await updateSession(request)

  // Normalise: '/dashboard/' -> '/dashboard' (root '/' stays '/').
  const rawPath = request.nextUrl.pathname
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath

  const isPublicPath =
    path.startsWith('/login') ||
    path.startsWith('/forgot-password') ||
    path.startsWith('/auth/callback') ||
    path === '/api/health'

  // Sign-in state passed via query so the login screen can explain itself
  // (session expiry, forced sign-out, disabled account, …)
  const hasAuthMessage = request.nextUrl.searchParams.has('auth')

  /**
   * Redirect helper that PRESERVES the cookies Supabase set while refreshing
   * the session. Returning a bare redirect instead of supabaseResponse would
   * drop the rotated tokens -> the browser would keep stale cookies and
   * flip-flop between signed-in/signed-out states (redirect loops).
   */
  const redirectTo = (pathname: string, search?: string) => {
    // Built from the origin (not nextUrl.clone()) so the redirect target is
    // always the canonical slash-free URL regardless of how the request path
    // was written.
    const url = new URL(pathname + (search ?? ''), request.nextUrl.origin)
    const response = NextResponse.redirect(url)
    for (const cookie of supabaseResponse.cookies.getAll()) {
      response.cookies.set(cookie)
    }
    return response
  }

  if (!user && !isPublicPath) {
    // API callers get a clean 401 JSON instead of an HTML redirect
    if (path.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not authenticated.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!hasAuthMessage && path !== '/') {
      return redirectTo('/login', `?auth=signin-required&next=${encodeURIComponent(path)}`)
    }
    return redirectTo('/login')
  }

  if (user && (path === '/login' || path === '/forgot-password')) {
    return redirectTo('/dashboard')
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     *  - Next.js internals (_next/*)
     *  - static assets & files with extensions (favicon, images, manifest…)
     */
    '/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest|js|css|map)$).*)',
  ],
}
