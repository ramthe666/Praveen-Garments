'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Undo2 } from 'lucide-react'
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
import { formatMoney } from '@/lib/catalog/constants'
import { logError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { ReturnCondition, Sale, SaleItem } from '@/types/database'

interface ReturnableLine {
  item: SaleItem
  eligible: number
  returnQty: string
  condition: ReturnCondition
}

/**
 * Customer return against a completed bill. Returnable quantity is
 * computed live (sold − returned − exchanged) and enforced again by the
 * database. Refund method can be any accepted payment method or Store
 * Credit; the refund first offsets any due balance on the bill.
 */
export function SalesReturnDialog({
  sale,
  items,
  open,
  onOpenChange,
  onDone,
}: {
  sale: Sale
  items: SaleItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [lines, setLines] = React.useState<ReturnableLine[]>([])
  const [reason, setReason] = React.useState('')
  const [refundMethod, setRefundMethod] = React.useState('')
  const [refundReference, setRefundReference] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [methods, setMethods] = React.useState<string[]>([])
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setReason('')
    setRefundMethod(Number(sale.due_amount) >= 0 ? 'Cash' : '')
    setRefundReference('')
    setNotes('')
    setLines(items.map((item) => ({ item, eligible: 0, returnQty: '', condition: 'GOOD' as ReturnCondition })))
    void (async () => {
      // live returnable = sold − returned − exchanged, per line (bounded to
      // this one bill; the database re-validates on submit)
      const itemIds = items.map((i) => i.id)
      const [rr, ex] = await Promise.all([
        supabase.from('sales_return_items').select('sale_item_id, quantity').in('sale_item_id', itemIds),
        supabase.from('exchange_items_in').select('sale_item_id, quantity').in('sale_item_id', itemIds),
      ])
      const used = new Map<string, number>()
      for (const list of [rr.data, ex.data]) {
        for (const row of (list ?? []) as Array<{ sale_item_id: string; quantity: number }>) {
          used.set(row.sale_item_id, (used.get(row.sale_item_id) ?? 0) + Number(row.quantity))
        }
      }
      setLines(items.map((item) => ({
        item,
        eligible: item.quantity - (used.get(item.id) ?? 0),
        returnQty: '',
        condition: 'GOOD' as ReturnCondition,
      })))
    })()
    void (async () => {
      const { data: cfg, error: cfgError } = await supabase.rpc('get_pos_config')
      if (!cfgError) {
        const config = cfg as unknown as { payments?: { methods?: string[] } }
        setMethods([...(config?.payments?.methods ?? ['Cash']), 'Store Credit'])
      }
    })()
  }, [open, sale, items, supabase])

  const chosen = lines.filter((l) => Number(l.returnQty) > 0)
  const refundPreview = chosen.reduce(
    (sum, l) => sum + (Number(l.item.line_total) / l.item.quantity) * Number(l.returnQty),
    0
  )

  async function submit() {
    if (!reason.trim()) {
      toast.error('A reason is required for a return.')
      return
    }
    if (chosen.length === 0) {
      toast.error('Enter a return quantity for at least one item.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch(`/api/sales/${sale.id}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: reason.trim(),
          refund_method: refundMethod || undefined,
          refund_reference: refundReference.trim() || undefined,
          notes: notes.trim() || undefined,
          items: chosen.map((l) => ({
            sale_item_id: l.item.id,
            quantity: Math.round(Number(l.returnQty)),
            condition: l.condition,
          })),
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not process the return.')
        return
      }
      toast.success('Return processed — stock and refund updated.')
      onOpenChange(false)
      onDone?.()
    } catch (e) {
      logError('sales-return:submit', e)
      toast.error('Could not process the return.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Return items — {sale.sale_number}</DialogTitle>
          <DialogDescription>
            {sale.customer_name ?? 'Walk-in customer'}
            {Number(sale.due_amount) > 0 ? ` · due ${formatMoney(Number(sale.due_amount))} (refund offsets it first)` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">Item</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Sold</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Left</th>
                  <th scope="col" className="px-3 py-2 font-medium">Return</th>
                  <th scope="col" className="px-3 py-2 font-medium">Condition</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lines.map((line, index) => (
                  <tr key={line.item.id} className={line.eligible <= 0 ? 'opacity-50' : undefined}>
                    <td className="max-w-[220px] px-3 py-1.5">
                      <span className="block truncate font-medium">{line.item.product_name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{line.item.sku}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{line.item.quantity}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{line.eligible}</td>
                    <td className="px-3 py-1.5">
                      <Input
                        className="h-8 w-20 min-w-0 tabular-nums"
                        inputMode="numeric"
                        value={line.eligible > 0 ? line.returnQty : ''}
                        disabled={line.eligible <= 0}
                        placeholder={`≤ ${line.eligible}`}
                        onChange={(e) => setLines((ls) => ls.map((l, i) => (i === index ? { ...l, returnQty: e.target.value } : l)))}
                        aria-label={`Return quantity for ${line.item.sku}`}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Select
                        value={line.condition}
                        onValueChange={(v) => setLines((ls) => ls.map((l, i) => (i === index ? { ...l, condition: v as ReturnCondition } : l)))}
                        disabled={line.eligible <= 0}
                      >
                        <SelectTrigger className="h-8 w-28 min-w-0" aria-label={`Condition for ${line.item.sku}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="GOOD">Good</SelectItem>
                          <SelectItem value="DAMAGED">Damaged</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={cn('text-xs text-muted-foreground')}>
            Damaged items go to the Damaged Goods location — they never return to sellable stock.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Refund method</Label>
              <Select value={refundMethod} onValueChange={setRefundMethod}>
                <SelectTrigger aria-label="Refund method" className="w-full min-w-0">
                  <SelectValue placeholder="Offset due only" />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sr-ref">Reference</Label>
              <Input id="sr-ref" value={refundReference} onChange={(e) => setRefundReference(e.target.value)} maxLength={80} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sr-reason">Reason *</Label>
            <Input id="sr-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Size too small" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sr-notes">Notes</Label>
            <Textarea id="sr-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <span className="mr-auto text-sm text-muted-foreground">Refund value (server-computed): <strong className="text-foreground">{formatMoney(Math.round(refundPreview * 100) / 100)}</strong></span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || chosen.length === 0}>
            <Undo2 className="size-4" aria-hidden="true" />
            {saving ? 'Processing…' : 'Process return'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
