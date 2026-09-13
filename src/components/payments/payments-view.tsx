'use client'

import * as React from 'react'
import { Search, Wallet, ArrowDownLeft, ArrowUpRight, Ban } from 'lucide-react'
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
import { useDebounced, formatDateTime, formatMoney, PAGE_SIZE } from '@/lib/catalog/constants'
import { logError, isTableMissing } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { PageResult, PaymentLedgerRow } from '@/types/database'

const SOURCE_OPTIONS = [
  { value: 'ALL', label: 'All money movement' },
  { value: 'customer_payment', label: 'Customer receipts' },
  { value: 'supplier_payment', label: 'Supplier payments' },
  { value: 'sale_payment', label: 'Bill payments (POS)' },
  { value: 'refund', label: 'Refunds' },
  { value: 'expense', label: 'Expenses' },
]

const SOURCE_LABELS: Record<string, string> = {
  customer_payment: 'Customer receipt',
  supplier_payment: 'Supplier payment',
  sale_payment: 'Bill payment',
  refund: 'Refund',
  expense: 'Expense',
}

/**
 * Unified payment history: every money movement in one database-side
 * filtered, paginated ledger (payments_page) — customer receipts, supplier
 * payments, POS bill payments, refunds and expenses. Business records stay
 * linked to their source document (no orphan money rows).
 */
export function PaymentsView() {
  const supabase = React.useMemo(() => createClient(), [])

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search, 350)
  const [source, setSource] = React.useState('ALL')
  const [page, setPage] = React.useState(0)

  const [rows, setRows] = React.useState<PaymentLedgerRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [setupNeeded, setSetupNeeded] = React.useState(false)
  /** Bill numbers whose sale was later CANCELLED — the money row stays in
   *  history (it really moved) but is shown struck-through with a badge so
   *  nobody mistakes it for live income. Money reports already exclude it. */
  const [cancelledBills, setCancelledBills] = React.useState<Set<string>>(new Set())

  const load = React.useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('payments_page', {
      p_search: debouncedSearch.trim() || null,
      p_source: source === 'ALL' ? null : source,
      p_method: null,
      p_date_from: null,
      p_date_to: null,
      p_min: null,
      p_max: null,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    })
    if (error) {
      logError('payments:page', error)
      if (isTableMissing(error)) setSetupNeeded(true)
      setRows([])
    } else {
      const result = data as unknown as PageResult<PaymentLedgerRow>
      setRows(result.rows ?? [])
      setTotal(Number(result.total ?? 0))
      // Mark bill payments whose sale was cancelled afterwards. Batch lookup
      // by sale_number (RLS: view_sales / create_sale holders can read sales —
      // the same people who can see sale_payment rows in the ledger).
      const billNumbers = (result.rows ?? [])
        .filter((r) => r.source === 'sale_payment' && r.doc_number)
        .map((r) => r.doc_number)
      if (billNumbers.length > 0) {
        const { data: saleRows, error: saleErr } = await supabase
          .from('sales')
          .select('sale_number,status')
          .in('sale_number', billNumbers)
        if (saleErr) {
          logError('payments:cancelled-lookup', saleErr)
          setCancelledBills(new Set())
        } else {
          setCancelledBills(
            new Set(
              (saleRows ?? [])
                .filter((s) => s.status === 'CANCELLED')
                .map((s) => s.sale_number),
            ),
          )
        }
      } else {
        setCancelledBills(new Set())
      }
    }
    setLoading(false)
  }, [supabase, debouncedSearch, source, page])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    setPage(0)
  }, [debouncedSearch, source])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Payment history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every money movement — receipts, payments, refunds and expenses — linked to its document.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Payments on cancelled bills keep their place in history but are marked and struck-through — they are already excluded from the money and cash reports.
        </p>
      </div>

      {setupNeeded ? (
        <div className="rounded-lg border bg-card p-6 text-center shadow-xs">
          <h2 className="text-lg font-semibold">Payments database not ready</h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Apply migration 0009 in the Supabase SQL Editor.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border bg-card p-3 shadow-xs sm:grid-cols-3">
            <div className="relative sm:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Document number, party, person…"
                className="pl-9"
                type="search"
                aria-label="Search payments"
              />
            </div>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger aria-label="Filter by payment source" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border bg-card shadow-xs">
            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState icon={<Wallet />} title="No payments found" description="Money movements appear here as you record them." />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2.5 font-medium">Document</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Party</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Type</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">Method</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">When</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">Amount</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium xl:table-cell">By</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => {
                      const incoming = row.source === 'customer_payment' || row.source === 'sale_payment'
                      const billCancelled = row.source === 'sale_payment' && cancelledBills.has(row.doc_number)
                      return (
                        <tr key={`${row.source}-${row.source_id}`} className={billCancelled ? 'opacity-70' : undefined}>
                          <td className="px-3 py-2.5 font-mono text-xs font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              {incoming ? (
                                <ArrowDownLeft className="size-3.5 text-success" aria-hidden="true" />
                              ) : (
                                <ArrowUpRight className="size-3.5 text-destructive" aria-hidden="true" />
                              )}
                              {row.doc_number}
                              {billCancelled ? (
                                <span
                                  className="inline-flex items-center whitespace-nowrap rounded-md border border-destructive/25 bg-destructive/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-destructive"
                                  title="This bill was cancelled — the money was returned and is not counted in reports"
                                >
                                  <Ban className="mr-0.5 inline size-3" aria-hidden="true" />
                                  Bill cancelled
                                </span>
                              ) : null}
                            </span>
                          </td>
                          <td className="max-w-[160px] truncate px-3 py-2.5">{row.party_name ?? '—'}</td>
                          <td className="hidden px-3 py-2.5 md:table-cell">
                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {SOURCE_LABELS[row.source] ?? row.source}
                            </span>
                          </td>
                          <td className="hidden px-3 py-2.5 sm:table-cell">
                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{row.method}</span>
                          </td>
                          <td className="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">{formatDateTime(row.entry_at)}</td>
                          <td className={cn('px-3 py-2.5 text-right font-medium tabular-nums', billCancelled ? 'text-muted-foreground line-through' : incoming ? 'text-success' : 'text-destructive')}>
                            {incoming ? '+' : '−'}{formatMoney(Number(row.amount))}
                          </td>
                          <td className="hidden max-w-[120px] truncate px-3 py-2.5 text-xs text-muted-foreground xl:table-cell">
                            {row.user_name ?? '—'}
                          </td>
                        </tr>
                      )
                    })}
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
    </div>
  )
}
