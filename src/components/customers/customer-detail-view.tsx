'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, FileText, ReceiptText, RotateCcw, Wallet } from 'lucide-react'
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
import { CustomerPaymentDialog } from './customer-payment-dialog'
import { CustomerStatementDialog } from './customer-statement-dialog'

interface CustomerDetail {
  customer: {
    id: string
    name: string
    phone: string | null
    alt_phone: string | null
    email: string | null
    address: string | null
    city: string | null
    state: string | null
    pincode: string | null
    gstin: string | null
    customer_type: string
    credit_limit: number
    notes: string | null
    is_active: boolean
    created_at: string
  }
  stats: {
    total_billed: number
    bills: number
    total_paid: number
    outstanding: number
    advance: number
    returns_total: number
  }
  sales: Array<{
    id: string
    sale_number: string
    sale_date: string
    status: string
    payment_status: string
    grand_total: number
    paid_amount: number
    due_amount: number
  }>
  payments: Array<{
    id: string
    receipt_number: string
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
    refund_amount: number
    applied_to_due: number
    refund_method: string | null
    reason: string
  }>
}

/**
 * Customer profile: live dues / advance / purchase history, payment history
 * with FIFO allocation, and return credits — one database-side RPC
 * (customer_detail), bounded to 50 recent rows per list.
 */
export function CustomerDetailView({ customerId }: { customerId: string }) {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()
  const canRecord = hasPermission('record_customer_payment')
  const canManage = hasPermission('manage_customers')

  const [detail, setDetail] = React.useState<CustomerDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [payOpen, setPayOpen] = React.useState(false)
  const [stmtOpen, setStmtOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('customer_detail', { p_customer_id: customerId })
    if (error) {
      logError('customer:detail', error)
      if (isTableMissing(error)) setSetupNeeded(true)
      else setNotFound(true)
      setDetail(null)
    } else {
      const result = data as unknown as CustomerDetail
      if (!result?.customer?.id) setNotFound(true)
      else setDetail(result)
    }
    setLoading(false)
  }, [supabase, customerId])

  React.useEffect(() => {
    void load()
  }, [load])

  async function applyAdvance() {
    const { data, error } = await supabase.rpc('apply_customer_advance', { p_customer_id: customerId })
    if (error) {
      logError('customer:apply-advance', error)
      toast.error('Could not apply the advance.')
      return
    }
    const result = data as unknown as { applied?: number } | null
    const applied = Number(result?.applied ?? 0)
    if (applied > 0) toast.success(`Advance applied: ${formatMoney(applied)}.`)
    else toast.info('No advance left to apply, or no due bills right now.')
    void load()
  }

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
          Apply migration 0009 in the Supabase SQL Editor to enable customer accounts.
        </p>
      </div>
    )
  }

  if (notFound || !detail) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/customers">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to customers
          </Link>
        </Button>
        <ErrorState title="Customer not found" message="This customer no longer exists." />
      </div>
    )
  }

  const { customer, stats } = detail
  const outstanding = Number(stats.outstanding)
  const advance = Number(stats.advance)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="mb-1 -ml-2">
            <Link href="/customers">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Customers
            </Link>
          </Button>
          <h1 className="truncate text-xl font-semibold tracking-tight">{customer.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {customer.phone ?? 'No phone'}
            {customer.city ? ` · ${customer.city}` : ''}
            {customer.gstin ? ` · GSTIN ${customer.gstin}` : ''}
            {` · ${customer.customer_type}`}
            {customer.is_active ? '' : ' · inactive'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setStmtOpen(true)}>
            <FileText className="size-4" aria-hidden="true" />
            Statement
          </Button>
          {advance > 0 && canRecord ? (
            <Button variant="outline" size="sm" onClick={applyAdvance}>
              Apply advance
            </Button>
          ) : null}
          {canRecord ? (
            <Button size="sm" onClick={() => setPayOpen(true)}>
              <Wallet className="size-4" aria-hidden="true" />
              Record payment
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Outstanding dues" icon={<Wallet />} value={formatMoney(outstanding)} tone={outstanding > 0 ? 'destructive' : 'default'} />
        <StatCard label="Advance held" icon={<ArrowLeft />} value={formatMoney(advance)} tone={advance > 0 ? 'success' : 'default'} />
        <StatCard label="Total billed" icon={<ReceiptText />} value={formatMoney(Number(stats.total_billed))} hint={`${Number(stats.bills)} bills`} />
        <StatCard label="Total received" icon={<RotateCcw />} value={formatMoney(Number(stats.total_paid))} hint={`returns ${formatMoney(Number(stats.returns_total))}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Purchase history</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {detail.sales.length === 0 ? (
              <EmptyState icon={<ReceiptText />} title="No purchases yet" description="Bills for this customer appear here." />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Invoice</th>
                      <th scope="col" className="px-4 py-2 font-medium">Date</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Total</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.sales.map((sale) => (
                      <tr key={sale.id}>
                        <td className="px-4 py-2">
                          <Link href={`/sales/${sale.id}`} className="font-mono text-xs font-medium hover:underline">
                            {sale.sale_number}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(sale.sale_date)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatMoney(Number(sale.grand_total))}</td>
                        <td className={cn('px-4 py-2 text-right tabular-nums', Number(sale.due_amount) > 0 && 'text-destructive')}>
                          {Number(sale.due_amount) > 0 ? formatMoney(Number(sale.due_amount)) : '—'}
                        </td>
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
            <CardTitle className="text-base">Payment history</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {detail.payments.length === 0 ? (
              <EmptyState icon={<Wallet />} title="No payments yet" description="Receipts recorded for this customer appear here." />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Receipt</th>
                      <th scope="col" className="px-4 py-2 font-medium">Date</th>
                      <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">Method</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {detail.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td className="px-4 py-2 font-mono text-xs font-medium">{payment.receipt_number}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{formatDateTime(payment.recorded_at)}</td>
                        <td className="hidden px-4 py-2 sm:table-cell">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{payment.method}</span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {formatMoney(Number(payment.amount))}
                          {Number(payment.advance_part) > 0 ? (
                            <p className="text-xs text-success">advance {formatMoney(Number(payment.advance_part))}</p>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {detail.returns.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Returns & credits</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-4 py-2 font-medium">Return</th>
                    <th scope="col" className="px-4 py-2 font-medium">Date</th>
                    <th scope="col" className="hidden px-4 py-2 font-medium md:table-cell">Reason</th>
                    <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">Method</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {detail.returns.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2 font-mono text-xs font-medium">{r.return_number}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(r.return_date)}</td>
                      <td className="hidden max-w-[220px] truncate px-4 py-2 text-muted-foreground md:table-cell">{r.reason}</td>
                      <td className="hidden px-4 py-2 sm:table-cell">
                        {r.refund_method ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{r.refund_method}</span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatMoney(Number(r.refund_amount) + Number(r.applied_to_due))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {canManage && (customer.notes || customer.credit_limit > 0) ? (
        <p className="px-1 text-xs text-muted-foreground">
          <RotateCcw className="mr-1 inline size-3.5" aria-hidden="true" />
          {Number(customer.credit_limit) > 0 ? `Credit limit ${formatMoney(Number(customer.credit_limit))}. ` : ''}
          {customer.notes ?? ''}
        </p>
      ) : null}

      <CustomerPaymentDialog
        customerId={customer.id}
        customerName={customer.name}
        outstanding={outstanding}
        advance={advance}
        open={payOpen}
        onOpenChange={setPayOpen}
        onRecorded={() => void load()}
      />
      <CustomerStatementDialog
        customerId={customer.id}
        customerName={customer.name}
        open={stmtOpen}
        onOpenChange={setStmtOpen}
      />
    </div>
  )
}
