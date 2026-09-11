import type { Metadata } from 'next'
import { ProductsView } from '@/components/products/products-view'
import { NoPermission } from '@/components/shared/no-permission'
import { AppProvider } from '@/components/providers/app-provider'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import type { AppContextData } from '@/components/providers/app-provider'

export const metadata: Metadata = { title: 'Products' }
export const dynamic = 'force-dynamic'

/**
 * Product catalog list. Read authorization happens through RLS on every
 * query (view_inventory holders); the page itself only checks the shell
 * context so users without the permission get a clear explanation instead
 * of an empty screen.
 */
export default async function ProductsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const bootstrap = await loadAppBootstrap(user.id)
  if (!bootstrap.permissions.includes('view_inventory')) {
    return <NoPermission moduleName="the product catalog" />
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
      <ProductsView />
    </AppProvider>
  )
}
