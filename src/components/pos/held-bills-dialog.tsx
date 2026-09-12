'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Clock, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { createClient } from '@/lib/supabase/client'
import { formatMoney, formatDateTime } from '@/components/pos/pos-helpers'
import { logError } from '@/lib/errors'
import type { HeldBill } from '@/types/database'
import type { HeldCart } from '@/components/pos/pos-types'

/**
 * Held bills: private drafts of this cashier. Resume restores the cart,
 * discard removes it permanently. Held bills never touch stock.
 */
export function HeldBillsDialog({
  open,
  onOpenChange,
  onResume,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onResume: (cart: HeldCart) => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [rows, setRows] = React.useState<HeldBill[]>([])
  const [loading, setLoading] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('held_bills')
      .select('*')
      .eq('status', 'HELD')
      .order('held_at', { ascending: false })
      .limit(50)
    if (error) {
      logError('pos:held-bills', error)
      toast.error('Could not load held bills.')
    } else {
      setRows((data as HeldBill[]) ?? [])
    }
    setLoading(false)
  }, [supabase])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  const resume = React.useCallback(
    async (bill: HeldBill) => {
      setBusyId(bill.id)
      try {
        const res = await fetch('/api/pos/held-bills/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: bill.id }),
        })
        const body = (await res.json().catch(() => null)) as { cart?: HeldCart; error?: string } | null
        if (!res.ok || !body?.cart) {
          toast.error('Could not resume the bill', { description: body?.error ?? 'Please try again.' })
          return
        }
        onResume(body.cart)
        onOpenChange(false)
      } catch (err) {
        logError('pos:held-resume', err)
        toast.error('Network error. The bill was not resumed.')
      } finally {
        setBusyId(null)
      }
    },
    [onResume, onOpenChange]
  )

  const discard = React.useCallback(
    async (bill: HeldBill) => {
      setBusyId(bill.id)
      try {
        const res = await fetch('/api/pos/held-bills/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: bill.id }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          toast.error('Could not discard the bill', { description: body?.error })
          return
        }
        setRows((prev) => prev.filter((r) => r.id !== bill.id))
      } catch (err) {
        logError('pos:held-discard', err)
        toast.error('Network error. The bill was not discarded.')
      } finally {
        setBusyId(null)
      }
    },
    []
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
            Held bills
          </DialogTitle>
          <DialogDescription>Your parked carts. Resuming one replaces the current cart.</DialogDescription>
        </DialogHeader>

        <div className="thin-scrollbar max-h-80 overflow-y-auto rounded-md border">
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No held bills.</p>
          ) : (
            <ul className="divide-y">
              {rows.map((bill) => (
                <li key={bill.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{bill.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatDateTime(bill.held_at)}
                      {bill.customer_name ? ` · ${bill.customer_name}` : ''}
                      {bill.item_count ? ` · ${bill.item_count} line${bill.item_count === 1 ? '' : 's'}` : ''}
                      {bill.total != null ? ` · ${formatMoney(Number(bill.total))}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void resume(bill)}
                      disabled={busyId === bill.id}
                      aria-label={`Resume ${bill.label}`}
                    >
                      <Play className="size-4" aria-hidden="true" />
                      <span className="sr-only sm:not-sr-only sm:ml-1">Resume</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void discard(bill)}
                      disabled={busyId === bill.id}
                      aria-label={`Discard ${bill.label}`}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      <span className="sr-only">Discard</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
