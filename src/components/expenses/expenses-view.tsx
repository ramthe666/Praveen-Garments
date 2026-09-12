'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Ban, CheckCircle2, Paperclip, Plus, Search, Tags, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { useDebounced, formatDate, formatMoney, PAGE_SIZE } from '@/lib/catalog/constants'
import { logError, isTableMissing } from '@/lib/errors'
import { useApp } from '@/components/providers/app-provider'
import { cn } from '@/lib/utils'
import type { ExpenseCategory, PageResult } from '@/types/database'
import { ExpenseFormDialog } from './expense-form-dialog'
import { ExpenseCategoriesDialog } from './expense-categories-dialog'

interface ExpenseRow {
  id: string
  expense_number: string
  category_name: string
  description: string
  amount: number
  method: string
  location_name: string | null
  expense_date: string
  status: string
  attachment_name: string | null
  attachment_path: string | null
  created_by_name: string | null
  approved_by_name: string | null
  cancel_reason: string | null
}

const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All states' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'CANCELLED', label: 'Cancelled' },
]

/**
 * Expense register: search + category + status + method + date filters,
 * database-side pagination (expenses_page). Approval is permission-gated
 * (cashiers can record nothing here — nav hides the page entirely).
 */
export function ExpensesView() {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()
  const canApprove = hasPermission('approve_expense')
  const canManageSettings = hasPermission('manage_settings')

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search, 350)
  const [category, setCategory] = React.useState('ALL')
  const [status, setStatus] = React.useState('ALL')
  const [page, setPage] = React.useState(0)

  const [rows, setRows] = React.useState<ExpenseRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [categories, setCategories] = React.useState<ExpenseCategory[]>([])
  const [formOpen, setFormOpen] = React.useState(false)
  const [catsOpen, setCatsOpen] = React.useState(false)
  const [cancelId, setCancelId] = React.useState<string | null>(null)
  const [cancelReason, setCancelReason] = React.useState('')

  const loadCategories = React.useCallback(async () => {
    const { data, error } = await supabase
      .from('expense_categories')
      .select('id, name, is_active, created_at, updated_at')
      .order('name')
    if (error) {
      logError('expenses:categories', error)
    } else {
      setCategories((data ?? []) as ExpenseCategory[])
    }
  }, [supabase])

  const load = React.useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('expenses_page', {
      p_search: debouncedSearch.trim() || null,
      p_category: category === 'ALL' ? null : category,
      p_status: status === 'ALL' ? null : status,
      p_method: null,
      p_date_from: null,
      p_date_to: null,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    })
    if (error) {
      logError('expenses:page', error)
      if (isTableMissing(error)) setSetupNeeded(true)
      setRows([])
    } else {
      const result = data as unknown as PageResult<ExpenseRow>
      setRows(result.rows ?? [])
      setTotal(Number(result.total ?? 0))
    }
    setLoading(false)
  }, [supabase, debouncedSearch, category, status, page])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    void loadCategories()
  }, [loadCategories])

  React.useEffect(() => {
    setPage(0)
  }, [debouncedSearch, category, status])

  async function approve(row: ExpenseRow) {
    try {
      const response = await fetch('/api/expenses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, action: 'approve' }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not approve the expense.')
        return
      }
      toast.success(`${row.expense_number} approved.`)
      void load()
    } catch (e) {
      logError('expenses:approve', e)
      toast.error('Could not approve the expense.')
    }
  }

  async function cancel() {
    if (!cancelId) return
    if (!cancelReason.trim()) {
      toast.error('A cancellation reason is required.')
      return
    }
    try {
      const response = await fetch('/api/expenses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cancelId, action: 'cancel', reason: cancelReason.trim() }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not cancel the expense.')
        return
      }
      toast.success('Expense cancelled.')
      setCancelId(null)
      setCancelReason('')
      void load()
    } catch (e) {
      logError('expenses:cancel', e)
      toast.error('Could not cancel the expense.')
    }
  }

  async function openAttachment(row: ExpenseRow) {
    if (!row.attachment_path) return
    const { data, error } = await supabase.storage
      .from('expense-attachments')
      .createSignedUrl(row.attachment_path, 300)
    if (error || !data?.signedUrl) {
      logError('expenses:attachment-url', error)
      toast.error('Could not open the attachment.')
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Expenses</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Business spending with categories, receipts and approval flow.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageSettings ? (
            <Button size="sm" variant="outline" onClick={() => setCatsOpen(true)}>
              <Tags className="size-4" aria-hidden="true" />
              Categories
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setFormOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Record expense
          </Button>
        </div>
      </div>

      {setupNeeded ? (
        <div className="rounded-lg border bg-card p-6 text-center shadow-xs">
          <h2 className="text-lg font-semibold">Expenses database not ready</h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Apply migration 0009 in the Supabase SQL Editor.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border bg-card p-3 shadow-xs sm:grid-cols-3">
            <div className="relative sm:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Number, description, category…"
                className="pl-9"
                type="search"
                aria-label="Search expenses"
              />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger aria-label="Filter by category" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger aria-label="Filter by status" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
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
              <EmptyState icon={<Wallet />} title="No expenses found" description="Adjust the filters, or record the first expense." />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2.5 font-medium">Number</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Description</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Category</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">Date</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Method</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">Amount</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                      <th scope="col" className="px-3 py-2.5 font-medium sr-only">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => (
                      <tr key={row.id} className={row.status === 'CANCELLED' ? 'opacity-60' : undefined}>
                        <td className="px-3 py-2.5 font-mono text-xs font-medium">
                          {row.expense_number}
                          {row.attachment_path ? (
                            <button className="ml-1 align-middle text-muted-foreground hover:text-foreground" onClick={() => void openAttachment(row)} aria-label={`Open attachment for ${row.expense_number}`}>
                              <Paperclip className="inline size-3.5" aria-hidden="true" />
                            </button>
                          ) : null}
                        </td>
                        <td className="max-w-[220px] px-3 py-2.5">
                          <span className="block truncate">{row.description}</span>
                          {row.cancel_reason ? (
                            <span className="block truncate text-xs text-muted-foreground">cancelled: {row.cancel_reason}</span>
                          ) : null}
                        </td>
                        <td className="hidden px-3 py-2.5 md:table-cell">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{row.category_name}</span>
                        </td>
                        <td className="hidden px-3 py-2.5 text-xs text-muted-foreground sm:table-cell">{formatDate(row.expense_date)}</td>
                        <td className="hidden px-3 py-2.5 lg:table-cell">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{row.method}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatMoney(Number(row.amount))}</td>
                        <td className="px-3 py-2.5">
                          <span className={cn(
                            'whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
                            row.status === 'APPROVED' ? 'bg-success/10 text-success border-success/25'
                              : row.status === 'CANCELLED' ? 'bg-destructive/10 text-destructive border-destructive/25'
                              : 'bg-warning/15 text-warning-foreground border-warning/30'
                          )}>
                            {row.status.toLowerCase()}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right">
                          {row.status === 'PENDING' && canApprove ? (
                            <Button variant="ghost" size="sm" onClick={() => approve(row)}>
                              <CheckCircle2 className="size-4" aria-hidden="true" />
                              <span className="sr-only">Approve {row.expense_number}</span>
                            </Button>
                          ) : null}
                          {row.status !== 'CANCELLED' ? (
                            <Button variant="ghost" size="sm" onClick={() => { setCancelId(row.id); setCancelReason('') }}>
                              <Ban className="size-4" aria-hidden="true" />
                              <span className="sr-only">Cancel {row.expense_number}</span>
                            </Button>
                          ) : null}
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

      <ExpenseFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        categories={categories}
        onSaved={() => void load()}
      />
      <ExpenseCategoriesDialog
        open={catsOpen}
        onOpenChange={setCatsOpen}
        categories={categories}
        onChanged={() => void loadCategories()}
      />

      <Dialog open={!!cancelId} onOpenChange={(v) => { if (!v) { setCancelId(null); setCancelReason('') } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancel expense</DialogTitle>
            <DialogDescription>
              Cancelled expenses stay in the register for audit — they never disappear.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label htmlFor="exp-cancel-reason" className="text-sm font-medium">Reason *</label>
            <Input id="exp-cancel-reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={200} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCancelId(null); setCancelReason('') }}>Keep expense</Button>
            <Button variant="destructive" onClick={cancel}>Cancel expense</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
