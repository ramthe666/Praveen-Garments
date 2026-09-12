'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Pencil, Plus, Search, Store } from 'lucide-react'
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
import { useDebounced, formatMoney, PAGE_SIZE } from '@/lib/catalog/constants'
import { logError, isTableMissing } from '@/lib/errors'
import { useApp } from '@/components/providers/app-provider'
import { cn } from '@/lib/utils'
import type { PageResult } from '@/types/database'

interface SupplierListRow {
  id: string
  name: string
  contact_person: string | null
  phone: string | null
  email: string | null
  city: string | null
  state: string | null
  gstin: string | null
  payment_terms: string | null
  notes: string | null
  is_active: boolean
  total_purchases: number
  invoices: number
  outstanding: number
  total_paid: number
  returns_total: number
}

interface FormState {
  id?: string
  name: string
  contact_person: string
  phone: string
  email: string
  city: string
  state: string
  pincode: string
  gstin: string
  payment_terms: string
  notes: string
}

const EMPTY_FORM: FormState = {
  name: '', contact_person: '', phone: '', email: '', city: '',
  state: '', pincode: '', gstin: '', payment_terms: '', notes: '',
}

/**
 * Supplier directory: search + active filter, live payables — filtered and
 * paginated database-side (suppliers_page).
 */
export function SuppliersView() {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()
  const canManage = hasPermission('manage_suppliers')

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search, 350)
  const [active, setActive] = React.useState('ALL')
  const [page, setPage] = React.useState(0)

  const [rows, setRows] = React.useState<SupplierListRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [formOpen, setFormOpen] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('suppliers_page', {
      p_search: debouncedSearch.trim() || null,
      p_active: active === 'ALL' ? null : active,
      p_limit: PAGE_SIZE,
      p_offset: page * PAGE_SIZE,
    })
    if (error) {
      logError('suppliers:page', error)
      if (isTableMissing(error)) setSetupNeeded(true)
      setRows([])
    } else {
      const result = data as unknown as PageResult<SupplierListRow>
      setRows(result.rows ?? [])
      setTotal(Number(result.total ?? 0))
    }
    setLoading(false)
  }, [supabase, debouncedSearch, active, page])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    setPage(0)
  }, [debouncedSearch, active])

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  function openEdit(row: SupplierListRow) {
    setForm({
      id: row.id,
      name: row.name,
      contact_person: row.contact_person ?? '',
      phone: row.phone ?? '',
      email: row.email ?? '',
      city: row.city ?? '',
      state: row.state ?? '',
      pincode: '',
      gstin: row.gstin ?? '',
      payment_terms: row.payment_terms ?? '',
      notes: row.notes ?? '',
    })
    setFormOpen(true)
  }

  async function saveForm() {
    if (!form.name.trim()) {
      toast.error('A supplier name is required.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/suppliers', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(form.id ? { id: form.id } : {}),
          name: form.name.trim(),
          contact_person: form.contact_person.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          pincode: form.pincode.trim(),
          gstin: form.gstin.trim(),
          payment_terms: form.payment_terms.trim(),
          notes: form.notes.trim(),
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not save the supplier.')
        return
      }
      toast.success(form.id ? 'Supplier updated.' : 'Supplier created.')
      setFormOpen(false)
      void load()
    } catch (e) {
      logError('suppliers:save', e)
      toast.error('Could not save the supplier.')
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
          <h1 className="text-xl font-semibold tracking-tight">Suppliers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Vendor directory with GST details, purchase history and outstanding payables.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" aria-hidden="true" />
            New supplier
          </Button>
        ) : null}
      </div>

      {setupNeeded ? (
        <div className="rounded-lg border bg-card p-6 text-center shadow-xs">
          <h2 className="text-lg font-semibold">Suppliers database not ready</h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Apply migration 0009 in the Supabase SQL Editor.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border bg-card p-3 shadow-xs sm:grid-cols-2">
            <div className="relative sm:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, phone, GSTIN…"
                className="pl-9"
                type="search"
                aria-label="Search suppliers"
              />
            </div>
            <Select value={active} onValueChange={setActive}>
              <SelectTrigger aria-label="Filter by active state" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All suppliers</SelectItem>
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
                icon={<Store />}
                title="No suppliers found"
                description={canManage ? 'Adjust the filters, or add the first supplier.' : 'Adjust the filters.'}
              />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2.5 font-medium">Name</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">Contact</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">City</th>
                      <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">GSTIN</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">Invoices</th>
                      <th scope="col" className="hidden px-3 py-2.5 text-right font-medium lg:table-cell">Purchases</th>
                      <th scope="col" className="px-3 py-2.5 text-right font-medium">Payable</th>
                      <th scope="col" className="px-3 py-2.5 font-medium sr-only">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => (
                      <tr key={row.id} className={row.is_active ? undefined : 'opacity-60'}>
                        <td className="max-w-[200px] px-3 py-2.5">
                          <Link href={`/suppliers/${row.id}`} className="font-medium hover:underline">
                            {row.name}
                          </Link>
                          {row.contact_person ? (
                            <p className="text-xs text-muted-foreground">{row.contact_person}</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">{row.phone ?? '—'}</td>
                        <td className="hidden max-w-[120px] truncate px-3 py-2.5 text-muted-foreground md:table-cell">
                          {row.city ?? '—'}
                        </td>
                        <td className="hidden px-3 py-2.5 font-mono text-xs md:table-cell sm:table-cell">{row.gstin ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{Number(row.invoices)}</td>
                        <td className="hidden px-3 py-2.5 text-right tabular-nums lg:table-cell">
                          {formatMoney(Number(row.total_purchases))}
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
                            <Link href={`/suppliers/${row.id}`}>
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
            <DialogTitle>{form.id ? 'Edit supplier' : 'New supplier'}</DialogTitle>
            <DialogDescription>
              Vendor master record. Payables are computed from received purchase invoices.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="sup-name">Name *</Label>
                <Input id="sup-name" value={form.name} onChange={set('name')} maxLength={160} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sup-contact">Contact person</Label>
                <Input id="sup-contact" value={form.contact_person} onChange={set('contact_person')} maxLength={120} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sup-phone">Phone</Label>
                <Input id="sup-phone" value={form.phone} onChange={set('phone')} inputMode="tel" maxLength={20} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sup-email">Email</Label>
                <Input id="sup-email" type="email" value={form.email} onChange={set('email')} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sup-city">City</Label>
                <Input id="sup-city" value={form.city} onChange={set('city')} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sup-state">State</Label>
                <Input id="sup-state" value={form.state} onChange={set('state')} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sup-pin">Pincode</Label>
                <Input id="sup-pin" value={form.pincode} onChange={set('pincode')} inputMode="numeric" maxLength={6} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="sup-gstin">GSTIN</Label>
                <Input id="sup-gstin" value={form.gstin} onChange={set('gstin')} maxLength={15} />
              </div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="sup-terms">Payment terms</Label>
                <Input id="sup-terms" value={form.payment_terms} onChange={set('payment_terms')} maxLength={60} placeholder="e.g. 30 days credit" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sup-notes">Notes</Label>
              <Textarea id="sup-notes" value={form.notes} onChange={set('notes')} rows={2} maxLength={500} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button onClick={saveForm} disabled={saving}>
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create supplier'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
