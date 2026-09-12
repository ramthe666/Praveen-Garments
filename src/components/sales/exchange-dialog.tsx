'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { ArrowLeftRight, Trash2 } from 'lucide-react'
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
import { VariantPicker, type VariantOption } from '@/components/purchases/variant-picker'
import type { ReturnCondition, Sale, SaleItem } from '@/types/database'

interface ReturnLine {
  item: SaleItem
  eligible: number
  returnQty: string
  condition: ReturnCondition
}

interface IssueLine {
  variant: VariantOption
  quantity: string
}

/**
 * Exchange: bring items back, take replacements. If the replacements cost
 * more the customer pays the difference (method required); if less, the
 * difference is refunded. Stock in/out, the ledger and the payment are one
 * atomic server transaction.
 */
export function ExchangeDialog({
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
  const [returnLines, setReturnLines] = React.useState<ReturnLine[]>([])
  const [issueLines, setIssueLines] = React.useState<IssueLine[]>([])
  const [reason, setReason] = React.useState('')
  const [paymentMethod, setPaymentMethod] = React.useState('')
  const [paymentReference, setPaymentReference] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [methods, setMethods] = React.useState<string[]>([])
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setIssueLines([])
    setReason('')
    setPaymentMethod('')
    setPaymentReference('')
    setNotes('')
    setReturnLines(items.map((item) => ({ item, eligible: 0, returnQty: '', condition: 'GOOD' as ReturnCondition })))
    void (async () => {
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
      setReturnLines(items.map((item) => ({
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

  function addReplacement(variant: VariantOption) {
    setIssueLines((list) => {
      if (list.some((l) => l.variant.id === variant.id)) {
        toast.info('That replacement is already selected — increase its quantity instead.')
        return list
      }
      return [...list, { variant, quantity: '1' }]
    })
  }

  const chosenReturns = returnLines.filter((l) => Number(l.returnQty) > 0)
  const returnValue = chosenReturns.reduce(
    (sum, l) => sum + (Number(l.item.line_total) / l.item.quantity) * Number(l.returnQty),
    0
  )
  const issueValue = issueLines.reduce((sum, l) => sum + (Number(l.variant.selling_price) || 0) * (Number(l.quantity) || 0), 0)
  const difference = issueValue - returnValue

  async function submit() {
    if (!reason.trim()) {
      toast.error('A reason is required for an exchange.')
      return
    }
    if (chosenReturns.length === 0) {
      toast.error('Select at least one item to exchange.')
      return
    }
    if (issueLines.length === 0) {
      toast.error('Select at least one replacement item.')
      return
    }
    if (difference > 0 && !paymentMethod) {
      toast.error(`The customer must pay ${formatMoney(difference)} — choose a payment method.`)
      return
    }
    setSaving(true)
    try {
      const response = await fetch(`/api/sales/${sale.id}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: reason.trim(),
          payment_method: paymentMethod || undefined,
          payment_reference: paymentReference.trim() || undefined,
          notes: notes.trim() || undefined,
          return_items: chosenReturns.map((l) => ({
            sale_item_id: l.item.id,
            quantity: Math.round(Number(l.returnQty)),
            condition: l.condition,
          })),
          new_items: issueLines.map((l) => ({
            variant_id: l.variant.id,
            quantity: Math.round(Number(l.quantity)) || 1,
          })),
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not process the exchange.')
        return
      }
      toast.success('Exchange processed.')
      onOpenChange(false)
      onDone?.()
    } catch (e) {
      logError('exchange:submit', e)
      toast.error('Could not process the exchange.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Exchange — {sale.sale_number}</DialogTitle>
          <DialogDescription>
            {sale.customer_name ?? 'Walk-in customer'} · return items, pick replacements; price differences settle automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-sm font-medium">Items coming back</p>
            <div className="relative overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Item</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Left</th>
                    <th scope="col" className="px-3 py-2 font-medium">Qty back</th>
                    <th scope="col" className="px-3 py-2 font-medium">Condition</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {returnLines.map((line, index) => (
                    <tr key={line.item.id} className={line.eligible <= 0 ? 'opacity-50' : undefined}>
                      <td className="max-w-[200px] px-3 py-1.5">
                        <span className="block truncate font-medium">{line.item.product_name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{line.item.sku}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{line.eligible}</td>
                      <td className="px-3 py-1.5">
                        <Input
                          className="h-8 w-20 min-w-0 tabular-nums"
                          inputMode="numeric"
                          value={line.eligible > 0 ? line.returnQty : ''}
                          disabled={line.eligible <= 0}
                          placeholder={`≤ ${line.eligible}`}
                          onChange={(e) => setReturnLines((ls) => ls.map((l, i) => (i === index ? { ...l, returnQty: e.target.value } : l)))}
                          aria-label={`Quantity back for ${line.item.sku}`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <Select
                          value={line.condition}
                          onValueChange={(v) => setReturnLines((ls) => ls.map((l, i) => (i === index ? { ...l, condition: v as ReturnCondition } : l)))}
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
          </div>

          <div className="grid gap-2">
            <Label>Replacement items</Label>
            <VariantPicker onPick={addReplacement} placeholder="Search replacement by name or SKU…" />
            {issueLines.length > 0 ? (
              <div className="relative overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2 font-medium">Replacement</th>
                      <th scope="col" className="px-3 py-2 font-medium">Qty</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
                      <th scope="col" className="px-3 py-2 font-medium sr-only">Remove</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {issueLines.map((line, index) => (
                      <tr key={line.variant.id}>
                        <td className="max-w-[220px] px-3 py-1.5">
                          <span className="block truncate font-medium">{line.variant.product_name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {line.variant.sku}
                            {line.variant.size_name ? ` · ${line.variant.size_name}` : ''}
                            {line.variant.color_name ? ` · ${line.variant.color_name}` : ''}
                          </span>
                        </td>
                        <td className="px-3 py-1.5">
                          <Input
                            className="h-8 w-20 min-w-0 tabular-nums"
                            inputMode="numeric"
                            value={line.quantity}
                            onChange={(e) => setIssueLines((ls) => ls.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))}
                            aria-label={`Quantity for ${line.variant.sku}`}
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(Number(line.variant.selling_price) || 0)}</td>
                        <td className="px-3 py-1.5 text-right">
                          <Button variant="ghost" size="sm" onClick={() => setIssueLines((ls) => ls.filter((_, i) => i !== index))}>
                            <Trash2 className="size-4" aria-hidden="true" />
                            <span className="sr-only">Remove {line.variant.sku}</span>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
                Search and add what the customer takes instead.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Settle difference via</Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger aria-label="Difference settlement method" className="w-full min-w-0">
                  <SelectValue placeholder="Only if there is a difference" />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ex-ref">Reference</Label>
              <Input id="ex-ref" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} maxLength={80} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ex-reason">Reason *</Label>
            <Input id="ex-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Size swap" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ex-notes">Notes</Label>
            <Textarea id="ex-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <span className="mr-auto text-sm text-muted-foreground">
            Back {formatMoney(Math.round(returnValue * 100) / 100)} · out {formatMoney(Math.round(issueValue * 100) / 100)} ·{' '}
            <strong className="text-foreground">
              {difference === 0 ? 'even swap' : difference > 0 ? `customer pays ${formatMoney(difference)}` : `refund ${formatMoney(-difference)}`}
            </strong>
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || chosenReturns.length === 0 || issueLines.length === 0}>
            <ArrowLeftRight className="size-4" aria-hidden="true" />
            {saving ? 'Processing…' : 'Process exchange'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
