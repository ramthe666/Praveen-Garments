'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Ban, Eye, ReceiptText, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/shared/empty-state'
import { DataTablePagination } from '@/components/shared/data-table-pagination'
import { createClient } from '@/lib/supabase/client'
import { useDebounced, formatMoney, formatDateTime, PAGE_SIZE } from '@/lib/catalog/constants'
import { logError, isTableMissing } from '@/lib/errors'
import { useApp } from '@/components/providers/app-provider'
import { cn } from '@/lib/utils'
import type { PaymentStatus, SaleStatus } from '@/types/database'

interface SalesRow {
  id: string
  sale_number: string
  sale_date: string
  status: SaleStatus
  payment_status: PaymentStatus
  subtotal: number
  bill_discount: number
  tax_total: number
  round_off: number
  grand_total: number
  paid_amount: number
  due_amount: number
  customer_id: string | null
  customer_name: string | null
  cashier_id: string | null
  cashier_name: string | null
  location_name: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  item_count: number
  unit_count: number
  payment_methods: string[]
  is_cancelled: boolean
}

const PAYMENT_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: 'All payment states' },
  { value: 'PAID', label: 'Paid' },
  { value: 'PARTIALLY_PAID', label: 'Partially paid' },
  { value: 'DUE', label: 'Due' },
]

const SALE_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'ALL', label: 'All sales' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
]

const METHOD_OPTIONS = ['ALL', 'Cash', 'UPI', 'Card', 'Bank Transfer', 'Credit']

/**
 * Sales history: database-side filtered + paginated. Never loads the whole
 * table — sales_page() handles search, filters, sorting and counting.
 */
export function SalesView() {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search, 350)
  const [dateFrom, setDateFrom] = React.useState('')
  const [dateTo, setDateTo] = React.useState('')
  const [method, setMethod] = React.useState('ALL')
  const [status, setStatus] = React.useState('ALL')
  const [paymentStatus, setPaymentStatus] = React.useState('ALL')
  const [page, setPage] = React.useState(0)

  const [rows, setRows] = React.useState<SalesRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [totalIsEstimate, setTotalIsEstimate] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const canCancel = hasPermission('cancel_sale')

  const load = React.useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('sales_page', {
      p_search: debouncedSearch.trim() || null,
      p_date_from: dateFrom || null,
      p_date_to: dateTo || null,
      p_payment_method: method === 'ALL' ? null : method,
      p_cashier_id: null,
      p_status: status === 'ALL' ? null : status,
      p_payment_status: paymentStatus === 'ALL' ? null : paymentStatus,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    })
    if (error) {
      logError('sales:page', error)
      if (isTableMissing(error)) setSetupNeeded(true)
      setRows([])
    } else {
      const result = data as unknown as { rows: SalesRow[]; total: number; total_is_estimate: boolean }
      setRows(result.rows ?? [])
      setTotal(Number(result.total ?? 0))
      setTotalIsEstimate(Boolean(result.total_is_estimate))
    }
    setLoading(false)
  }, [supabase, debouncedSearch, dateFrom, dateTo, method, status, paymentStatus, page])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    setPage(0)
  }, [debouncedSearch, dateFrom, dateTo, method, status, paymentStatus])

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sales</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Complete billing history — invoices, payments, dues and cancellations.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/pos">
            <ReceiptText className="size-4" aria-hidden="true" />
            New sale
          </Link>
        </Button>
      </div>

      {setupNeeded ? (
        <div className="rounded-lg border bg-card p-6 text-center shadow-xs">
          <h2 className="text-lg font-semibold">Sales database not ready</h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Apply migration 0008 (supabase/migrations/0008_pos_billing.sql) in the Supabase SQL Editor.
          </p>
        </div>
      ) : (
        <>
          {/* filters */}
          <div className="grid gap-2 rounded-lg border bg-card p-3 shadow-xs sm:grid-cols-2 lg:grid-cols-6">
            <div className="relative sm:col-span-2 lg:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Invoice no, customer, cashier…"
                className="pl-9"
                type="search"
                aria-label="Search sales"
              />
            </div>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="From date"
            />
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="To date"
            />
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger aria-label="Filter by payment method" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHOD_OPTIONS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m === 'ALL' ? 'All methods' : m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger aria-label="Filter by sale status" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
                <SelectContent>
                  {SALE_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            <Select value={paymentStatus} onValueChange={setPaymentStatus}>
              <SelectTrigger aria-label="Filter by payment status" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
                <SelectContent>
                  {PAYMENT_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
          </div>

          {/* table */}
          <div className="rounded-lg border bg-card shadow-xs">
            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<ReceiptText />}
                title="No sales found"
                description="Adjust the filters, or create the first sale from the POS."
              />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2.5 font-medium">Invoice</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Date</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Customer</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Items</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Payment</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">Total</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">Status</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Cashier</th>
                      <th scope="col" className="px-3 py-2.5 font-medium sr-only">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => (
                      <tr key={row.id} className={row.is_cancelled ? 'opacity-60' : undefined}>
                        <td className="px-3 py-2.5 font-mono text-xs font-medium">{row.sale_number}</td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground">{formatDateTime(row.sale_date)}</td>
                        <td className="max-w-[160px] truncate px-3 py-2.5">
                          {row.customer_name ?? <span className="text-muted-foreground">Walk-in</span>}
                        </td>
                        <td className="hidden px-3 py-2.5 tabular-nums md:table-cell">
                          {row.unit_count} <span className="text-xs text-muted-foreground">({row.item_count} lines)</span>
                        </td>
                        <td className="hidden px-3 py-2.5 lg:table-cell">
                          <div className="flex flex-wrap gap-1">
                            {row.payment_methods?.map((m) => (
                              <span key={m} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                {m}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                          {formatMoney(Number(row.grand_total))}
                          {Number(row.due_amount) > 0 ? (
                            <p className="text-xs text-destructive">due {formatMoney(Number(row.due_amount))}</p>
                          ) : null}
                        </td>
                        <td className="hidden px-3 py-2.5 sm:table-cell">
                          <span
                            className={cn(
                              'inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
                              row.is_cancelled
                                ? 'bg-destructive/10 text-destructive border-destructive/25'
                                : Number(row.due_amount) > 0
                                  ? 'bg-warning/15 text-warning-foreground border-warning/30'
                                  : 'bg-success/10 text-success border-success/25'
                            )}
                          >
                            {row.is_cancelled ? 'Cancelled' : row.payment_status.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="hidden max-w-[120px] truncate px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">
                          {row.cashier_name ?? '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <Button asChild variant="ghost" size="sm">
                            <Link href={`/sales/${row.id}`}>
                              <Eye className="size-4" aria-hidden="true" />
                              <span className="sr-only">View {row.sale_number}</span>
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="border-t px-3 py-2">
              <DataTablePagination
                page={page + 1}
                pageSize={PAGE_SIZE}
                total={total}
                onPageChange={(next) => setPage(next - 1)}
              />
            </div>
          </div>
        </>
      )}

      {canCancel ? (
        <p className="px-1 text-xs text-muted-foreground">
          <Ban className="mr-1 inline size-3.5" aria-hidden="true" />
          Sales are never deleted — cancellations require a reason, restore stock, and keep the invoice record for audit.
        </p>
      ) : null}
    </div>
  )
}
