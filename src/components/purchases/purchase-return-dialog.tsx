'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createClient } from '@/lib/supabase/client'
import { formatMoney } from '@/lib/catalog/constants'
import { logError } from '@/lib/errors'

interface ReturnableItem {
  id: string
  line_no: number
  product_name: string
  sku: string
  quantity: number
  unit_cost: number
  gst_rate: number
  line_total: number
  returned_quantity: number
  eligible: number
  returnQty: string
}

interface InvoiceInfo {
  id: string
  invoice_number: string
  supplier_name: string
  status: string
  due_amount: number
}

/**
 * Return goods to the supplier against a RECEIVED purchase invoice.
 * Eligible quantity = received − already returned (enforced again by the
 * database). Requires a reason; adjusts the payable as a credit note.
 */
export function PurchaseReturnDialog({
  invoice,
  open,
  onOpenChange,
  onSaved,
}: {
  invoice: InvoiceInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [items, setItems] = React.useState<ReturnableItem[]>([])
  const [reason, setReason] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open || !invoice) return
    setLoading(true)
    setReason('')
    setNotes('')
    void (async () => {
      const { data, error } = await supabase
        .from('purchase_invoice_items')
        .select('id, line_no, product_name, sku, quantity, unit_cost, gst_rate, line_total, returned_quantity')
        .eq('invoice_id', invoice.id)
        .order('line_no')
      if (error) {
        logError('purchase-return:items', error)
        setItems([])
      } else {
        const rows = (data ?? []) as Array<Omit<ReturnableItem, 'eligible' | 'returnQty'>>
        setItems(
          rows.map((r) => ({
            ...r,
            quantity: Number(r.quantity),
            unit_cost: Number(r.unit_cost),
            gst_rate: Number(r.gst_rate),
            line_total: Number(r.line_total),
            returned_quantity: Number(r.returned_quantity),
            eligible: Number(r.quantity) - Number(r.returned_quantity),
            returnQty: '',
          }))
        )
      }
      setLoading(false)
    })()
  }, [open, invoice, supabase])

  const update = (index: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setItems((list) => list.map((item, i) => (i === index ? { ...item, returnQty: e.target.value } : item)))

  const chosen = items.filter((i) => Number(i.returnQty) > 0)
  const returnValue = chosen.reduce((sum, i) => sum + (Number(i.line_total) / i.quantity) * Number(i.returnQty), 0)

  async function submit() {
    if (!invoice) return
    if (!reason.trim()) {
      toast.error('A reason is required for a purchase return.')
      return
    }
    if (chosen.length === 0) {
      toast.error('Enter a return quantity for at least one item.')
      return
    }
    for (const i of chosen) {
      if (Number(i.returnQty) > i.eligible) {
        toast.error(`Only ${i.eligible} left to return for ${i.sku}.`)
        return
      }
    }
    setSaving(true)
    try {
      const response = await fetch('/api/purchase-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purchase_invoice_id: invoice.id,
          reason: reason.trim(),
          notes: notes.trim() || undefined,
          items: chosen.map((i) => ({ invoice_item_id: i.id, quantity: Math.round(Number(i.returnQty)) })),
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not create the return.')
        return
      }
      toast.success('Purchase return processed — stock and payable adjusted.')
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      logError('purchase-return:submit', e)
      toast.error('Could not create the return.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Return to supplier</DialogTitle>
          <DialogDescription>
            {invoice ? `${invoice.invoice_number} · ${invoice.supplier_name}` : ''}
            {invoice && Number(invoice.due_amount) > 0 ? ` · current due ${formatMoney(Number(invoice.due_amount))}` : ''}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading invoice lines…</p>
        ) : items.length === 0 || items.every((i) => i.eligible <= 0) ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing left to return on this invoice.</p>
        ) : (
          <div className="space-y-4">
            <div className="relative overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Item</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Received</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Returned</th>
                    <th scope="col" className="px-3 py-2 font-medium">Return qty</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item, index) => (
                    <tr key={item.id} className={item.eligible <= 0 ? 'opacity-50' : undefined}>
                      <td className="max-w-[220px] px-3 py-1.5">
                        <span className="block truncate font-medium">{item.product_name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{item.sku}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{item.quantity}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{item.returned_quantity}</td>
                      <td className="px-3 py-1.5">
                        <Input
                          className="h-8 w-20 min-w-0 tabular-nums"
                          inputMode="numeric"
                          value={item.eligible > 0 ? item.returnQty : ''}
                          onChange={update(index)}
                          disabled={item.eligible <= 0}
                          placeholder={`≤ ${item.eligible}`}
                          aria-label={`Return quantity for ${item.sku}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="pr-reason">Reason *</Label>
              <Input id="pr-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Colour defect on three pieces" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pr-notes">Notes</Label>
              <Textarea id="pr-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <span className="mr-auto text-sm text-muted-foreground">Credit note value (server-computed): <strong className="text-foreground">{formatMoney(Math.round(returnValue * 100) / 100)}</strong></span>
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
