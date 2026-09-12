import type { Metadata } from 'next'
import { NoPermission } from '@/components/shared/no-permission'
import { AppProvider } from '@/components/providers/app-provider'
import { SupplierDetailView } from '@/components/suppliers/supplier-detail-view'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import type { AppContextData } from '@/components/providers/app-provider'

export const metadata: Metadata = { title: 'Supplier' }
export const dynamic = 'force-dynamic'

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const bootstrap = await loadAppBootstrap(user.id)
  const canManage = bootstrap.permissions.includes('manage_suppliers')
  const canPay = bootstrap.permissions.includes('record_supplier_payment')
  if (!canManage && !canPay) {
    return <NoPermission moduleName="Supplier" />
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
      <SupplierDetailView supplierId={id} />
    </AppProvider>
  )
}
