import type { Metadata } from 'next'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'
import { AppLogo } from '@/components/shared/app-logo'
import { loadPublicBranding } from '@/lib/data/app-data'
import { DEFAULT_COMPANY_NAME } from '@/lib/auth/constants'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export const metadata: Metadata = {
  title: `Reset password — ${DEFAULT_COMPANY_NAME}`,
  robots: { index: false, follow: false },
}

// Branding is fetched with a plain anon client (no cookies), so this screen
// can be prerendered; revalidate keeps branding changes visible quickly.
export const revalidate = 300

export default async function ForgotPasswordPage() {
  const branding = await loadPublicBranding()
  const companyName = branding?.company_name || DEFAULT_COMPANY_NAME

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <AppLogo logoUrl={branding?.logo_url} companyName={companyName} size={44} />
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Reset your password</h1>
        <p className="text-sm text-muted-foreground">
          Enter your work email and we&apos;ll send a reset link.
        </p>
      </div>

      <ForgotPasswordForm />

      <p className="mt-6 text-center">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
