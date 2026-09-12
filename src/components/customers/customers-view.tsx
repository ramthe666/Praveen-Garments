'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Pencil, Plus, Search, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
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
import { useDebounced, formatMoney, formatDate, PAGE_SIZE } from '@/lib/catalog/constants'
import { logError, isTableMissing } from '@/lib/errors'
import { useApp } from '@/components/providers/app-provider'
import { cn } from '@/lib/utils'
import type { CustomerType, PageResult } from '@/types/database'

export interface CustomerListRow {
  id: string
  name: string
  phone: string | null
  alt_phone: string | null
  email: string | null
  city: string | null
  state: string | null
  gstin: string | null
  customer_type: string
  credit_limit: number
  notes: string | null
  is_active: boolean
  created_at: string
  total_billed: number
  bills: number
  outstanding: number
  total_paid: number
  advance: number
}

interface FormState {
  id?: string
  name: string
  phone: string
  alt_phone: string
  email: string
  city: string
  state: string
  pincode: string
  gstin: string
  customer_type: string
  credit_limit: string
  notes: string
  is_active?: boolean
}

const EMPTY_FORM: FormState = {
  name: '', phone: '', alt_phone: '', email: '', city: '', state: '',
  pincode: '', gstin: '', customer_type: 'retail', credit_limit: '0', notes: '',
}

/**
 * Customer directory: search, type + active filters, live dues and advance —
 * all filtered and paginated database-side (customers_page). No full-table
 * loads, no client-side array filtering of big data.
 */
export function CustomersView() {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()
  const canManage = hasPermission('manage_customers')

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search, 350)
  const [type, setType] = React.useState('ALL')
  const [active, setActive] = React.useState('ALL')
  const [page, setPage] = React.useState(0)

  const [rows, setRows] = React.useState<CustomerListRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [formOpen, setFormOpen] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('customers_page', {
      p_search: debouncedSearch.trim() || null,
      p_type: type === 'ALL' ? null : type,
      p_active: active === 'ALL' ? null : active,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    })
    if (error) {
      logError('customers:page', error)
      if (isTableMissing(error)) setSetupNeeded(true)
      setRows([])
    } else {
      const result = data as unknown as PageResult<CustomerListRow>
      setRows(result.rows ?? [])
      setTotal(Number(result.total ?? 0))
    }
    setLoading(false)
  }, [supabase, debouncedSearch, type, active, page])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    setPage(0)
  }, [debouncedSearch, type, active])

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  function openEdit(row: CustomerListRow) {
    setForm({
      id: row.id,
      name: row.name,
      phone: row.phone ?? '',
      alt_phone: row.alt_phone ?? '',
      email: row.email ?? '',
      city: row.city ?? '',
      state: row.state ?? '',
      pincode: '',
      gstin: row.gstin ?? '',
      customer_type: row.customer_type,
      credit_limit: String(Number(row.credit_limit ?? 0)),
      notes: row.notes ?? '',
    })
    setFormOpen(true)
  }

  async function saveForm() {
    if (!form.name.trim()) {
      toast.error('A customer name is required.')
      return
    }
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        alt_phone: form.alt_phone.trim(),
        email: form.email.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        pincode: form.pincode.trim(),
        gstin: form.gstin.trim(),
        customer_type: form.customer_type,
        credit_limit: Number(form.credit_limit || 0),
        notes: form.notes.trim(),
      }
      if (form.id) payload.id = form.id
      const response = await fetch(form.id ? '/api/customers' : '/api/customers', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not save the customer.')
        return
      }
      toast.success(form.id ? 'Customer updated.' : 'Customer created.')
      setFormOpen(false)
      void load()
    } catch (e) {
      logError('customers:save', e)
      toast.error('Could not save the customer.')
    } finally {
      setSaving(false)
    }
  }

  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }))

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Customers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Directory with purchase history, outstanding dues, advances and printable statements.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" aria-hidden="true" />
            New customer
          </Button>
        ) : null}
      </div>

      {setupNeeded ? (
        <div className="rounded-lg border bg-card p-6 text-center shadow-xs">
          <h2 className="text-lg font-semibold">Customers database not ready</h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Apply migration 0009 (supabase/migrations/0009_phase4_business_operations.sql) in the Supabase SQL Editor.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border bg-card p-3 shadow-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative sm:col-span-2 lg:col-span-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, phone, email or GSTIN…"
                className="pl-9"
                type="search"
                aria-label="Search customers"
              />
            </div>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger aria-label="Filter by customer type" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All types</SelectItem>
                <SelectItem value="retail">Retail</SelectItem>
                <SelectItem value="wholesale">Wholesale</SelectItem>
              </SelectContent>
            </Select>
            <Select value={active} onValueChange={setActive}>
              <SelectTrigger aria-label="Filter by active state" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All customers</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
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
              <EmptyState
                icon={<Users />}
                title="No customers found"
                description={canManage ? 'Adjust the filters, or add the first customer.' : 'Adjust the filters.'}
              />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2.5 font-medium">Name</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Phone</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">City</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">Type</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">Bills</th>
                      <th scope="col" className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">Billed</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">Outstanding</th>
                      <th scope="col" className="px-3 py-2.5 font-medium sr-only">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => (
                      <tr key={row.id} className={row.is_active ? undefined : 'opacity-60'}>
                        <td className="max-w-[200px] px-3 py-2.5">
                          <Link href={`/customers/${row.id}`} className="font-medium hover:underline">
                            {row.name}
                          </Link>
                          {Number(row.advance) > 0 ? (
                            <p className="text-xs text-success">advance {formatMoney(Number(row.advance))}</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">{row.phone ?? '—'}</td>
                        <td className="hidden max-w-[120px] truncate px-3 py-2.5 text-muted-foreground md:table-cell">
                          {row.city ?? '—'}
                        </td>
                        <td className="hidden px-3 py-2.5 sm:table-cell">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {row.customer_type}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.bills)}</td>
                        <td className="hidden px-3 py-2.5 text-right tabular-nums lg:table-cell">
                          {formatMoney(Number(row.total_billed))}
                        </td>
                        <td className={cn('px-3 py-2.5 text-right font-medium tabular-nums', Number(row.outstanding) > 0 && 'text-destructive')}>
                          {formatMoney(Number(row.outstanding))}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right">
                          {canManage ? (
                            <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                              <Pencil className="size-4" aria-hidden="true" />
                              <span className="sr-only">Edit {row.name}</span>
                            </Button>
                          ) : null}
                          <Button asChild variant="ghost" size="sm">
                            <Link href={`/customers/${row.id}`}>
                              <span className="sr-only">View {row.name}</span>
                              View
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

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit customer' : 'New customer'}</DialogTitle>
            <DialogDescription>
              Phone-first directory entry. Dues and statements are computed from live bills.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="cust-name">Name *</Label>
                <Input id="cust-name" value={form.name} onChange={set('name')} maxLength={120} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-phone">Phone</Label>
                <Input id="cust-phone" value={form.phone} onChange={set('phone')} inputMode="tel" maxLength={20} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-alt">Alternate phone</Label>
                <Input id="cust-alt" value={form.alt_phone} onChange={set('alt_phone')} inputMode="tel" maxLength={20} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-email">Email</Label>
                <Input id="cust-email" type="email" value={form.email} onChange={set('email')} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-city">City</Label>
                <Input id="cust-city" value={form.city} onChange={set('city')} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-state">State</Label>
                <Input id="cust-state" value={form.state} onChange={set('state')} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-pincode">Pincode</Label>
                <Input id="cust-pincode" value={form.pincode} onChange={set('pincode')} inputMode="numeric" maxLength={6} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-gstin">GSTIN</Label>
                <Input id="cust-gstin" value={form.gstin} onChange={set('gstin')} maxLength={15} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-type">Customer type</Label>
                <Select value={form.customer_type} onValueChange={(v) => setForm((f) => ({ ...f, customer_type: v }))}>
                  <SelectTrigger id="cust-type" className="w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="retail">Retail</SelectItem>
                    <SelectItem value="wholesale">Wholesale</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cust-credit">Credit limit (₹)</Label>
                <Input id="cust-credit" value={form.credit_limit} onChange={set('credit_limit')} inputMode="decimal" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cust-notes">Notes</Label>
              <Textarea id="cust-notes" value={form.notes} onChange={set('notes')} rows={2} maxLength={500} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button onClick={saveForm} disabled={saving}>
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create customer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
