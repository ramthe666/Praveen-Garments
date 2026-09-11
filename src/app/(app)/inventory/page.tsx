import type { Metadata } from 'next'
import { InventoryView } from '@/components/inventory/inventory-view'
import { NoPermission } from '@/components/shared/no-permission'
import { AppProvider } from '@/components/providers/app-provider'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import type { AppContextData } from '@/components/providers/app-provider'

export const metadata: Metadata = { title: 'Inventory' }
export const dynamic = 'force-dynamic'

export default async function InventoryPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const bootstrap = await loadAppBootstrap(user.id)
  if (!bootstrap.permissions.includes('view_inventory')) {
    return <NoPermission moduleName="inventory" />
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
      <InventoryView />
    </AppProvider>
  )
}
