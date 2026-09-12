'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Check, Plus, Search, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { createClient } from '@/lib/supabase/client'
import { useDebounced } from '@/lib/catalog/constants'
import { logError, toUserMessage } from '@/lib/errors'
import type { PosCustomer } from '@/components/pos/pos-types'

/**
 * Customer picker for the POS: search the directory, quick-create a walk-in
 * customer, or continue without any customer (normal retail billing).
 */
export function CustomerDialog({
  open,
  onOpenChange,
  selected,
  onSelect,
  canCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selected: PosCustomer | null
  onSelect: (customer: PosCustomer | null) => void
  canCreate: boolean
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [search, setSearch] = React.useState('')
  const debounced = useDebounced(search, 300)
  const [rows, setRows] = React.useState<PosCustomer[]>([])
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const [newPhone, setNewPhone] = React.useState('')
  const [newState, setNewState] = React.useState('')
  const [showCreate, setShowCreate] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    const run = async () => {
      let query = supabase
        .from('customers')
        .select('id, name, phone, state, gstin')
        .eq('is_active', true)
        .order('name')
        .limit(20)
      const q = debounced.trim()
      if (q) {
        query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
      }
      const { data, error } = await query
      if (cancelled) return
      if (error) {
        logError('pos:customer-dialog', error)
        toast.error('Could not load customers', { description: toUserMessage(error) })
        setRows([])
      } else {
        setRows((data as PosCustomer[]) ?? [])
      }
      setLoading(false)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [supabase, debounced, open])

  const createCustomer = React.useCallback(async () => {
    const name = newName.trim()
    if (!name) {
      toast.error('A customer name is required.')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/pos/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          phone: newPhone.trim() || undefined,
          state: newState.trim() || undefined,
        }),
      })
      const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok || !raw || raw.error) {
        toast.error('Could not create the customer', {
          description: (typeof raw?.error === 'string' && raw.error) || 'Please try again.',
        })
        return
      }
      const created = raw as unknown as PosCustomer
      toast.success('Customer added', { description: created.name })
      onSelect(created)
      setNewName('')
      setNewPhone('')
      setNewState('')
      setShowCreate(false)
      onOpenChange(false)
    } catch (err) {
      logError('pos:customer-create', err)
      toast.error('Network error. Customer was not created.')
    } finally {
      setCreating(false)
    }
  }, [newName, newPhone, newState, onSelect, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />
            Select customer
          </DialogTitle>
          <DialogDescription>
            Optional for normal retail bills. Required for credit (due) sales.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone…"
              className="pl-9"
              type="search"
              aria-label="Search customers"
            />
          </div>

          <div className="thin-scrollbar max-h-56 overflow-y-auto rounded-md border" role="listbox" aria-label="Customer results">
            {loading ? (
              <div className="space-y-2 p-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {debounced.trim() ? 'No matching customers.' : 'No customers yet.'}
              </p>
            ) : (
              <ul className="divide-y">
                {rows.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected?.id === c.id}
                      onClick={() => {
                        onSelect(c)
                        onOpenChange(false)
                      }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{c.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.phone ?? 'No phone'}
                          {c.state ? ` · ${c.state}` : ''}
                        </span>
                      </span>
                      {selected?.id === c.id ? (
                        <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {selected ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                onSelect(null)
                onOpenChange(false)
              }}
            >
              Continue without a customer
            </Button>
          ) : null}

          {canCreate ? (
            showCreate ? (
              <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Full name *"
                  aria-label="New customer name"
                  maxLength={120}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder="Phone"
                    aria-label="New customer phone"
                    inputMode="tel"
                  />
                  <Input
                    value={newState}
                    onChange={(e) => setNewState(e.target.value)}
                    placeholder="State (for IGST)"
                    aria-label="New customer state"
                    maxLength={60}
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void createCustomer()} disabled={creating} className="flex-1">
                    <Plus className="size-4" aria-hidden="true" />
                    {creating ? 'Adding…' : 'Add customer'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="outline" size="sm" className="w-full" onClick={() => setShowCreate(true)}>
                <Plus className="size-4" aria-hidden="true" />
                New customer
              </Button>
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
