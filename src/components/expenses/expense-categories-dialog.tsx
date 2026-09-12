'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Check, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { logError } from '@/lib/errors'
import type { ExpenseCategory } from '@/types/database'
import { cn } from '@/lib/utils'

/**
 * Manage expense categories (data, not code — never hardcoded). Creating and
 * editing requires manage_settings, exactly like the RLS policy enforces.
 */
export function ExpenseCategoriesDialog({
  open,
  onOpenChange,
  categories,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  categories: ExpenseCategory[]
  onChanged?: () => void
}) {
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  async function create() {
    if (name.trim().length < 2) {
      toast.error('Category names are 2–60 characters.')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/expense-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not create the category.')
        return
      }
      toast.success('Category added.')
      setName('')
      onChanged?.()
    } catch (e) {
      logError('expense-categories:create', e)
      toast.error('Could not create the category.')
    } finally {
      setBusy(false)
    }
  }

  async function toggle(category: ExpenseCategory) {
    setBusy(true)
    try {
      const response = await fetch('/api/expense-categories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: category.id, is_active: !category.is_active }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not update the category.')
        return
      }
      onChanged?.()
    } catch (e) {
      logError('expense-categories:toggle', e)
      toast.error('Could not update the category.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Expense categories</DialogTitle>
          <DialogDescription>
            Categories are data, not code — deactivate instead of deleting so history stays intact.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="cat-name">New category</Label>
            <div className="flex gap-2">
              <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Electricity" />
              <Button onClick={create} disabled={busy} size="sm">
                <Plus className="size-4" aria-hidden="true" />
                Add
              </Button>
            </div>
          </div>

          <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
            {categories.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No categories yet.</p>
            ) : (
              categories.map((c) => (
                <div key={c.id} className={cn('flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm', !c.is_active && 'opacity-50')}>
                  <span className="min-w-0 truncate">{c.name}</span>
                  <Button variant="ghost" size="sm" onClick={() => toggle(c)} disabled={busy}>
                    {c.is_active ? (
                      <>
                        <X className="size-4" aria-hidden="true" />
                        <span className="sr-only">Deactivate {c.name}</span>
                      </>
                    ) : (
                      <>
                        <Check className="size-4" aria-hidden="true" />
                        <span className="sr-only">Reactivate {c.name}</span>
                      </>
                    )}
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
