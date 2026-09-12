import type { Metadata } from 'next'
import Link from 'next/link'
import { InvoiceDocument, type InvoiceSettings } from '@/components/sales/invoice-document'
import type { SaleDetailData } from '@/components/sales/sale-detail-view'
import { createClient } from '@/lib/supabase/server'
import { isTableMissing } from '@/lib/errors'
import type { CompanySettings } from '@/types/database'

export const metadata: Metadata = { title: 'Invoice' }
export const dynamic = 'force-dynamic'

/**
 * Printable invoice page — deliberately separate from the POS/dashboard so
 * the browser print dialog outputs only the document (clean A4 / 80 mm
 * layouts; the app shell is hidden by print CSS).
 */
export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ print?: string }>
}) {
  const { id } = await params
  const { print } = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: allowed, error: permError } = await supabase.rpc('has_app_permission', { p: 'view_sales' })
  if (permError || !allowed) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm text-muted-foreground">You do not have permission to view invoices.</p>
      </div>
    )
  }

  const [{ data: detailData, error }, { data: company }, { data: settingsRows }] = await Promise.all([
    supabase.rpc('sale_detail', { p_sale_id: id }),
    supabase.from('company_settings').select('*').limit(1).maybeSingle(),
    supabase.from('app_settings').select('key, value').eq('key', 'invoice').maybeSingle(),
  ])

  if (error || !detailData) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-lg font-semibold">Invoice not found</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {isTableMissing(error) ? 'Apply migration 0008 first.' : 'This invoice does not exist.'}
        </p>
        <p className="mt-3 text-sm">
          <Link href="/sales" className="text-primary underline-offset-4 hover:underline">
            Back to sales
          </Link>
        </p>
      </div>
    )
  }

  const detail = detailData as unknown as SaleDetailData
  const invoiceSettings = ((settingsRows as { value?: InvoiceSettings } | null)?.value ?? {}) as InvoiceSettings

  return (
    <div className="p-4 sm:p-6">
      <InvoiceDocument
        detail={detail}
        company={(company as CompanySettings | null) ?? null}
        invoiceSettings={invoiceSettings}
        autoPrint={print === '1'}
      />
    </div>
  )
}
