import type { Metadata } from 'next'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'
import { AppLogo } from '@/components/shared/app-logo'
import { loadPublicBranding } from '@/lib/data/app-data'
import { DEFAULT_COMPANY_NAME } from '@/lib/auth/constants'

export const metadata: Metadata = {
  title: `Set new password — ${DEFAULT_COMPANY_NAME}`,
  robots: { index: false, follow: false },
}

// Branding is fetched with a plain anon client (no cookies), so this screen
// can be prerendered; revalidate keeps branding changes visible quickly.
export const revalidate = 300

export default async function ResetPasswordPage() {
  const branding = await loadPublicBranding()
  const companyName = branding?.company_name || DEFAULT_COMPANY_NAME

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <AppLogo logoUrl={branding?.logo_url} companyName={companyName} size={44} />
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Set a new password</h1>
        <p className="text-sm text-muted-foreground">
          Choose a strong password for your account.
        </p>
      </div>

      <ResetPasswordForm />
    </div>
  )
}
