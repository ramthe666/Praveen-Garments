import type { Metadata } from 'next'
import Link from 'next/link'
import { NoPermission } from '@/components/shared/no-permission'
import { SaleDetailView, type SaleDetailData } from '@/components/sales/sale-detail-view'
import { createClient } from '@/lib/supabase/server'
import { isTableMissing } from '@/lib/errors'

export const metadata: Metadata = { title: 'Sale detail' }
export const dynamic = 'force-dynamic'

export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  // permission: anyone who can view sales (the RPC re-checks database-side)
  const { data: allowed, error: permError } = await supabase.rpc('has_app_permission', { p: 'view_sales' })
  if (permError || !allowed) {
    return <NoPermission moduleName="Sales" />
  }

  const { data, error } = await supabase.rpc('sale_detail', { p_sale_id: id })
  if (error || !data) {
    return (
      <div className="space-y-4 rounded-lg border bg-card p-8 text-center shadow-xs">
        <h2 className="text-lg font-semibold">Sale not found</h2>
        <p className="text-sm text-muted-foreground">
          {isTableMissing(error)
            ? 'The sales database is not set up yet — apply migration 0008 first.'
            : 'This invoice does not exist or you do not have access to it.'}
        </p>
        <p className="text-sm">
          <Link href="/sales" className="text-primary underline-offset-4 hover:underline">
            Back to sales
          </Link>
        </p>
      </div>
    )
  }

  const detail = data as unknown as SaleDetailData
  return <SaleDetailView initial={detail} />
}
