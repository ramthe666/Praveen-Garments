'use client'

import * as React from 'react'
import { storeToday } from '@/lib/reports/period'
import { toast } from 'sonner'
import { IndianRupee, Paperclip, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createClient } from '@/lib/supabase/client'
import { logError } from '@/lib/errors'
import type { ExpenseCategory } from '@/types/database'

/**
 * Radix Select forbids SelectItem value="" (it throws — empty string is reserved
 * for clearing the selection). The "whole business" (no branch) choice uses this
 * sentinel; it maps back to '' in onValueChange.
 */
const NO_LOCATION_VALUE = '__none__'

interface ExpenseDraft {
  category_id: string
  description: string
  amount: string
  method: string
  expense_date: string
  location_id: string
  notes: string
  file: File | null
}

/**
 * Record a business expense. Cashiers are blocked by permission (they never
 * see this dialog). Attachments are validated client AND server side
 * (PNG / JPEG / WebP / PDF, max 5 MB) and stored in a private bucket.
 */
export function ExpenseFormDialog({
  open,
  onOpenChange,
  categories,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  categories: ExpenseCategory[]
  onSaved?: () => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [methods, setMethods] = React.useState<string[]>([])
  const [locations, setLocations] = React.useState<Array<{ id: string; name: string }>>([])
  const [form, setForm] = React.useState<ExpenseDraft>({
    category_id: '', description: '', amount: '', method: '', expense_date: storeToday(), location_id: '', notes: '', file: null,
  })
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setForm({
      category_id: '', description: '', amount: '', method: '', expense_date: storeToday(), location_id: '', notes: '', file: null,
    })
    void (async () => {
      const { data: cfg, error } = await supabase.rpc('get_pos_config')
      if (!error) {
        const config = cfg as unknown as {
          payments?: { methods?: string[] }
          locations?: Array<{ id: string; name: string }>
        }
        setMethods(config?.payments?.methods?.length ? config.payments.methods : ['Cash'])
        setLocations(config?.locations ?? [])
      }
    })()
  }, [open, supabase])

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    if (!file) {
      setForm((f) => ({ ...f, file: null }))
      return
    }
    const okTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
    if (!okTypes.includes(file.type)) {
      toast.error('Attachments must be PNG, JPEG, WebP or PDF.')
      e.target.value = ''
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Attachments must be 5 MB or smaller.')
      e.target.value = ''
      return
    }
    setForm((f) => ({ ...f, file }))
  }

  async function submit() {
    if (!form.category_id) {
      toast.error('Choose a category.')
      return
    }
    if (!form.description.trim()) {
      toast.error('A description is required.')
      return
    }
    const amount = Number(form.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid amount.')
      return
    }
    if (!form.method) {
      toast.error('Choose a payment method.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category_id: form.category_id,
          description: form.description.trim(),
          amount: Math.round(amount * 100) / 100,
          method: form.method,
          expense_date: form.expense_date || undefined,
          location_id: form.location_id || undefined,
          notes: form.notes.trim() || undefined,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string; expense_id?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not record the expense.')
        return
      }

      if (form.file && body.expense_id) {
        const upload = new FormData()
        upload.append('file', form.file)
        const fileRes = await fetch(`/api/expenses/${body.expense_id}/attachment`, { method: 'POST', body: upload })
        if (!fileRes.ok) {
          const fileBody = (await fileRes.json().catch(() => ({}))) as { error?: string }
          toast.warning(fileBody.error ?? 'Expense saved, but the attachment failed to upload.')
        }
      }
      toast.success('Expense recorded.')
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      logError('expense-form:submit', e)
      toast.error('Could not record the expense.')
    } finally {
      setSaving(false)
    }
  }

  const activeCategories = categories.filter((c) => c.is_active)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Record expense</DialogTitle>
          <DialogDescription>
            Day-to-day business spending. Approvers review it before it counts as final.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Category *</Label>
              <Select value={form.category_id} onValueChange={(v) => setForm((f) => ({ ...f, category_id: v }))}>
                <SelectTrigger aria-label="Expense category" className="w-full min-w-0">
                  <SelectValue placeholder="Choose category" />
                </SelectTrigger>
                <SelectContent>
                  {activeCategories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="exp-amount">Amount (₹) *</Label>
              <div className="relative">
                <IndianRupee className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="exp-amount"
                  className="pl-9"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Method *</Label>
              <Select value={form.method} onValueChange={(v) => setForm((f) => ({ ...f, method: v }))}>
                <SelectTrigger aria-label="Payment method" className="w-full min-w-0">
                  <SelectValue placeholder="Choose method" />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="exp-date">Date *</Label>
              <Input id="exp-date" type="date" value={form.expense_date} onChange={(e) => setForm((f) => ({ ...f, expense_date: e.target.value }))} />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="exp-desc">Description *</Label>
              <Input id="exp-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={200} />
            </div>
            <div className="grid gap-2">
              <Label>Branch / location</Label>
              <Select
                value={form.location_id || NO_LOCATION_VALUE}
                onValueChange={(v) => setForm((f) => ({ ...f, location_id: v === NO_LOCATION_VALUE ? '' : v }))}
              >
                <SelectTrigger aria-label="Branch" className="w-full min-w-0">
                  <SelectValue placeholder="Whole business" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LOCATION_VALUE}>Whole business</SelectItem>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="exp-file">Receipt (PNG/JPG/PDF, 5 MB)</Label>
              <div className="flex items-center gap-2">
                <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Input id="exp-file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={pickFile} className="h-9 file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs" />
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="exp-notes">Notes</Label>
            <Textarea id="exp-notes" rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} maxLength={300} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            <Plus className="size-4" aria-hidden="true" />
            {saving ? 'Recording…' : 'Record expense'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
