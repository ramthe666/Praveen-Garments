import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ProductForm } from '@/components/products/product-form'
import { NoPermission } from '@/components/shared/no-permission'
import { Phase2SetupNotice } from '@/components/shared/phase2-setup-notice'
import { AppProvider } from '@/components/providers/app-provider'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import { isTableMissing } from '@/lib/errors'
import type { AppContextData } from '@/components/providers/app-provider'
import type { Product } from '@/types/database'

export const metadata: Metadata = { title: 'Edit product' }
export const dynamic = 'force-dynamic'

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const bootstrap = await loadAppBootstrap(user.id)
  if (!bootstrap.permissions.includes('manage_products')) {
    return <NoPermission moduleName="product editing" />
  }

  const { data: product, error } = await supabase.from('products').select('*').eq('id', id).maybeSingle()
  if (error && isTableMissing(error)) {
    const contextData: AppContextData = {
      userId: user.id,
      userEmail: user.email ?? '',
      profile: bootstrap.profile,
      permissions: bootstrap.permissions,
      companyName: bootstrap.branding.companyName,
      logoUrl: bootstrap.branding.logoUrl,
      settings: bootstrap.settings,
      dbReady: false,
    }
    return (
      <AppProvider data={contextData}>
        <Phase2SetupNotice />
      </AppProvider>
    )
  }
  if (!product) notFound()

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
      <ProductForm mode="edit" product={product as Product} />
    </AppProvider>
  )
}
