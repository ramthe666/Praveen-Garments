'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft, FileText, ReceiptText, Store, Truck, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard } from '@/components/shared/stat-card'
import { EmptyState } from '@/components/shared/empty-state'
import { ErrorState } from '@/components/shared/error-state'
import { createClient } from '@/lib/supabase/client'
import { formatDate, formatDateTime, formatMoney } from '@/lib/catalog/constants'
import { logError, isTableMissing } from '@/lib/errors'
import { useApp } from '@/components/providers/app-provider'
import { cn } from '@/lib/utils'
import { SupplierPaymentDialog } from './supplier-payment-dialog'

interface SupplierDetail {
  supplier: {
    id: string
    name: string
    contact_person: string | null
    phone: string | null
    email: string | null
    address: string | null
    city: string | null
    state: string | null
    gstin: string | null
    notes: string | null
    is_active: boolean
    created_at: string
  }
  stats: {
    total_purchases: number
    invoices: number
    total_paid: number
    outstanding: number
    returns_total: number
  }
  invoices: Array<{
    id: string
    invoice_number: string
    invoice_date: string
    po_number: string | null
    supplier_invoice_no: string | null
    status: string
    payment_status: string
    grand_total: number
    paid_amount: number
    due_amount: number
  }>
  payments: Array<{
    id: string
    payment_number: string
    recorded_at: string
    method: string
    amount: number
    allocated_amount: number
    advance_part: number
    reference: string | null
    recorded_by_name: string | null
  }>
  returns: Array<{
    id: string
    return_number: string
    return_date: string
    invoice_number: string
    grand_total: number
    reason: string
  }>
}

/**
 * Supplier profile: payables / purchase history / payments / returns — one
 * database-side RPC (supplier_detail), bounded to 50 recent rows per list.
 */
export function SupplierDetailView({ supplierId }: { supplierId: string }) {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()
  const canPay = hasPermission('record_supplier_payment')

  const [detail, setDetail] = React.useState<SupplierDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)
  const [setupNeeded, setSetupNeeded] = React.useState(false)
  const [payOpen, setPayOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('supplier_detail', { p_supplier_id: supplierId })
    if (error) {
      logError('supplier:detail', error)
      if (isTableMissing(error)) setSetupNeeded(true)
      else setNotFound(true)
      setDetail(null)
    } else {
      const result = data as unknown as SupplierDetail
      if (!result?.supplier?.id) setNotFound(true)
      else setDetail(result)
    }
    setLoading(false)
  }, [supabase, supplierId])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (setupNeeded) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center shadow-xs">
        <h2 className="text-lg font-semibold">Database not ready</h2>
        <p className="mt-1 break-words text-sm text-muted-foreground">
          Apply migration 0009 in the Supabase SQL Editor to enable supplier accounts.
        </p>
      </div>
    )
  }

  if (notFound || !detail) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/suppliers">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to suppliers
          </Link>
        </Button>
        <ErrorState title="Supplier not found" message="This supplier no longer exists." />
      </div>
    )
  }

  const { supplier, stats } = detail
  const outstanding = Number(stats.outstanding)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="mb-1 -ml-2">
            <Link href="/suppliers">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Suppliers
            </Link>
          </Button>
          <h1 className="truncate text-xl font-semibold tracking-tight">{supplier.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {supplier.contact_person ?? 'No contact'}
            {supplier.phone ? ` · ${supplier.phone}` : ''}
            {supplier.gstin ? ` · GSTIN ${supplier.gstin}` : ''}
            {supplier.is_active ? '' : ' · inactive'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canPay ? (
            <Button size="sm" onClick={() => setPayOpen(true)}>
              <Truck className="size-4" aria-hidden="true" />
              Pay supplier
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Outstanding payable" icon={<Truck />} value={formatMoney(outstanding)} tone={outstanding > 0 ? 'destructive' : 'default'} />
        <StatCard label="Total purchases" icon={<ReceiptText />} value={formatMoney(Number(stats.total_purchases))} hint={`${Number(stats.invoices)} invoices`} />
        <StatCard label="Total paid" icon={<FileText />} value={formatMoney(Number(stats.total_paid))} />
        <StatCard label="Returns to supplier" icon={<Undo2 />} value={formatMoney(Number(stats.returns_total))} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Purchase invoices</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {detail.invoices.length === 0 ? (
            <EmptyState icon={<ReceiptText />} title="No purchases yet" description="Received purchase invoices for this supplier appear here." />
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-4 py-2 font-medium">Invoice</th>
                    <th scope="col" className="px-4 py-2 font-medium">Date</th>
                    <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">Supplier no.</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Total</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Due</th>
                    <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {detail.invoices.map((inv) => (
                    <tr key={inv.id} className={inv.status === 'CANCELLED' ? 'opacity-60' : undefined}>
                      <td className="px-4 py-2 font-mono text-xs font-medium">{inv.invoice_number}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(inv.invoice_date)}</td>
                      <td className="hidden px-4 py-2 font-mono text-xs md:table-cell">{inv.supplier_invoice_no ?? '—'}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatMoney(Number(inv.grand_total))}</td>
                      <td className={cn('px-4 py-2 text-right tabular-nums', Number(inv.due_amount) > 0 && inv.status !== 'DRAFT' && 'text-destructive')}>
                        {inv.status === 'DRAFT' ? '—' : Number(inv.due_amount) > 0 ? formatMoney(Number(inv.due_amount)) : '—'}
                      </td>
                      <td className="hidden px-4 py-2 sm:table-cell">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {inv.status === 'DRAFT' ? 'Draft' : inv.payment_status.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Payment history</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {detail.payments.length === 0 ? (
              <EmptyState icon={<FileText />} title="No payments yet" description="Payments recorded for this supplier appear here." />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Payment</th>
                      <th scope="col" className="px-4 py-2 font-medium">Date</th>
                      <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">Method</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td className="px-4 py-2 font-mono text-xs font-medium">{payment.payment_number}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{formatDateTime(payment.recorded_at)}</td>
                        <td className="hidden px-4 py-2 sm:table-cell">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{payment.method}</span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatMoney(Number(payment.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Returns to supplier</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {detail.returns.length === 0 ? (
              <EmptyState icon={<Undo2 />} title="No returns" description="Goods returned to this supplier appear here." />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Return</th>
                      <th scope="col" className="px-4 py-2 font-medium">Date</th>
                      <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">Reason</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.returns.map((r) => (
                      <tr key={r.id}>
                        <td className="px-4 py-2 font-mono text-xs font-medium">{r.return_number}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(r.return_date)}</td>
                        <td className="hidden max-w-[200px] truncate px-4 py-2 text-muted-foreground md:table-cell">{r.reason}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatMoney(Number(r.grand_total))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {supplier.notes ? (
        <p className="px-1 text-xs text-muted-foreground">
          <Store className="mr-1 inline size-3.5" aria-hidden="true" />
          {supplier.notes}
        </p>
      ) : null}

      <SupplierPaymentDialog
        supplierId={supplier.id}
        supplierName={supplier.name}
        payable={outstanding}
        open={payOpen}
        onOpenChange={setPayOpen}
        onRecorded={() => void load()}
      />
    </div>
  )
}
