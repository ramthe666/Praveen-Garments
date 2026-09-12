import type { Metadata } from 'next'
import { NoPermission } from '@/components/shared/no-permission'
import { AppProvider } from '@/components/providers/app-provider'
import { PosView } from '@/components/pos/pos-view'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import type { AppContextData } from '@/components/providers/app-provider'

export const metadata: Metadata = { title: 'POS / Billing' }
export const dynamic = 'force-dynamic'

export default async function PosPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const bootstrap = await loadAppBootstrap(user.id)
  if (!bootstrap.permissions.includes('create_sale')) {
    return <NoPermission moduleName="POS / Billing" />
  }

  const contextData: AppContextData = {
    userId: user.id,
    userEmail: user.email ?? bootstrap.profile?.email ?? '',
    profile: bootstrap.profile,
    permissions: bootstrap.permissions,
    companyName: bootstrap.branding.companyName,
    logoUrl: bootstrap.branding.logoUrl,
    settings: bootstrap.settings,
    dbReady: bootstrap.dbReady,
  }

  return (
    <AppProvider data={contextData}>
      <PosView />
    </AppProvider>
  )
}
