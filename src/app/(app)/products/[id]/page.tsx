import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ProductDetailView, type VariantWithStock } from '@/components/products/product-detail-view'
import { NoPermission } from '@/components/shared/no-permission'
import { Phase2SetupNotice } from '@/components/shared/phase2-setup-notice'
import { AppProvider } from '@/components/providers/app-provider'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import { isTableMissing } from '@/lib/errors'
import type { AppContextData } from '@/components/providers/app-provider'
import type { Brand, Category, Product, ProductVariant } from '@/types/database'

export const metadata: Metadata = { title: 'Product' }
export const dynamic = 'force-dynamic'

/**
 * Product detail: server-renders the product with its (bounded) variant list
 * and stock balances; interactivity (dialogs, reloads) runs client-side.
 */
export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const bootstrap = await loadAppBootstrap(user.id)
  if (!bootstrap.permissions.includes('view_inventory')) {
    return <NoPermission moduleName="products" />
  }

  const { data: product, error: productError } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (productError && isTableMissing(productError)) {
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

  const [categoryResult, subcategoryResult, brandResult, variantsResult] = await Promise.all([
    supabase.from('categories').select('*').eq('id', (product as Product).category_id).maybeSingle(),
    (product as Product).subcategory_id
      ? supabase.from('categories').select('*').eq('id', (product as Product).subcategory_id!).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    (product as Product).brand_id
      ? supabase.from('brands').select('*').eq('id', (product as Product).brand_id!).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from('product_variants')
      .select(
        '*, sizes(name), colors(name, hex_code), stock_balances(quantity, reserved_quantity, reorder_level, stock_locations(id, name))'
      )
      .eq('product_id', id)
      .order('created_at'),
  ])

  const variants: VariantWithStock[] = ((variantsResult.data ?? []) as Array<Record<string, unknown> & ProductVariant>).map(
    (v) => {
      const size = v.sizes as unknown as { name: string } | null
      const color = v.colors as unknown as { name: string } | null
      const balances = ((v.stock_balances ?? []) as Array<Record<string, unknown>>).map((b) => ({
        location_id: (b.stock_locations as unknown as { id: string } | null)?.id ?? '',
        location_name: (b.stock_locations as unknown as { name: string } | null)?.name ?? '—',
        quantity: Number(b.quantity ?? 0),
        reserved_quantity: Number(b.reserved_quantity ?? 0),
        reorder_level: b.reorder_level === null ? null : Number(b.reorder_level),
      }))
      const { sizes: _s, colors: _c, stock_balances: _b, ...rest } = v
      void _s
      void _c
      void _b
      return {
        ...rest,
        size_name: (size as { name: string } | null)?.name ?? null,
        color_name: (color as { name: string } | null)?.name ?? null,
        balances,
      } as VariantWithStock
    }
  )

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
      <ProductDetailView
        product={product as Product}
        initialVariants={variants}
        category={(categoryResult.data as Category | null) ?? null}
        subcategory={(subcategoryResult.data as Category | null) ?? null}
        brand={(brandResult.data as Brand | null) ?? null}
      />
    </AppProvider>
  )
}
