import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import { AppShell } from '@/components/layout/app-shell'
import type { AppContextData } from '@/components/providers/app-provider'
import { SetupNotice } from '@/components/shared/setup-notice'
import { DisabledAccount } from '@/components/auth/disabled-account'
import { DEFAULT_COMPANY_NAME } from '@/lib/auth/constants'

/**
 * Protected application shell:
 *  1. middleware refreshes the session; here we verify again server-side
 *  2. profile/permissions/company data are loaded once per navigation
 *  3. disabled accounts are force-signed-out
 *  4. pre-migration state renders a visible setup notice (never silent)
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?auth=signin-required')
  }

  const bootstrap = await loadAppBootstrap(user.id)

  // Disabled staff must not use the app: sign them out with an explanation.
  if (bootstrap.profile && !bootstrap.profile.is_active) {
    return <DisabledAccount />
  }

  let contextData: AppContextData
  if (bootstrap.profile) {
    const permissions = bootstrap.permissions
    contextData = {
      userId: user.id,
      userEmail: user.email ?? bootstrap.profile.email,
      profile: bootstrap.profile,
      permissions,
      companyName: bootstrap.branding.companyName,
      logoUrl: bootstrap.branding.logoUrl,
      settings: bootstrap.settings,
      dbReady: bootstrap.dbReady,
    }
  } else {
    // Profile layer unavailable (pre-migration): minimal usable context.
    // Built inline — server code cannot invoke helpers exported by client modules.
    contextData = {
      userId: user.id,
      userEmail: user.email ?? '',
      profile: null,
      permissions: [],
      companyName: DEFAULT_COMPANY_NAME,
      logoUrl: null,
      settings: {},
      dbReady: false,
    }
  }

  return (
    <AppShell contextData={contextData}>
      {bootstrap.dbReady ? null : <SetupNotice className="mb-4" />}
      {/* Explicit boundary: keeps shell hydration deterministic while the
          (database-backed) page content streams in. */}
      <Suspense fallback={<div className="space-y-4" aria-busy="true" aria-label="Loading page"><div className="h-7 w-48 animate-pulse rounded-md bg-muted" /><div className="h-24 w-full animate-pulse rounded-md bg-muted" /><div className="h-24 w-full animate-pulse rounded-md bg-muted" /></div>}>
        {children}
      </Suspense>
    </AppShell>
  )
}
