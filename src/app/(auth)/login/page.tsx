import { Suspense } from 'react'
import type { Metadata } from 'next'
import { loadPublicBranding } from '@/lib/data/app-data'
import { LoginForm } from '@/components/auth/login-form'
import { AppLogo } from '@/components/shared/app-logo'
import { DEFAULT_COMPANY_NAME } from '@/lib/auth/constants'

export const metadata: Metadata = {
  title: `Sign in — ${DEFAULT_COMPANY_NAME}`,
  robots: { index: false, follow: false },
}

// Branding is fetched from the DB with a plain anon client, so this page can
// be prerendered/cached; revalidate keeps logo/name changes visible within
// five minutes without sacrificing cacheability.
export const revalidate = 300

export default async function LoginPage() {
  // Branding comes from the database (get_public_branding RPC) so the
  // company name is never hardcoded. Falls back to defaults pre-migration.
  const branding = await loadPublicBranding()
  const companyName = branding?.company_name || DEFAULT_COMPANY_NAME

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <AppLogo logoUrl={branding?.logo_url} companyName={companyName} size={44} />
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{companyName}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Billing &amp; Inventory workspace
          </p>
        </div>
      </div>

      {/* LoginForm reads search params (auth notices, next path) — it must sit
          inside a Suspense boundary so this page can be prerendered. */}
      <Suspense
        fallback={
          <div
            className="rounded-lg border bg-card p-6 shadow-sm"
            aria-busy="true"
            aria-label="Loading sign-in form"
          >
            <div className="h-5 w-24 animate-pulse rounded bg-muted" />
            <div className="mt-4 h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="mt-6 h-9 w-full animate-pulse rounded bg-muted" />
            <div className="mt-4 h-9 w-full animate-pulse rounded bg-muted" />
            <div className="mt-6 h-9 w-full animate-pulse rounded bg-muted" />
          </div>
        }
      >
        <LoginForm companyName={companyName} />
      </Suspense>

      <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
        Private application — authorised staff only.
        <br />
        Accounts are created by the administrator.
      </p>
    </div>
  )
}
