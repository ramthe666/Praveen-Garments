'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Banknote, CreditCard, Loader2, Plus, Printer, ShoppingCart, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatMoney, round2 } from '@/components/pos/pos-helpers'
import type { CartItem } from '@/lib/pos/calc'
import type { PaymentDraft, PosConfig, PosCustomer, SaleResult } from '@/components/pos/pos-types'

interface CheckoutSummary {
  subtotal: number
  itemDiscountTotal: number
  billDiscountAmount: number
  taxTotal: number
  roundOff: number
  grandTotal: number
}

/**
 * Checkout: confirm summary → split payments → submit to the atomic engine.
 * The cashier can go back and modify the cart until the final submit.
 */
export function CheckoutDialog({
  open,
  onOpenChange,
  items,
  summary,
  customer,
  config,
  locationName,
  notes,
  onCompleted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: CartItem[]
  summary: CheckoutSummary
  customer: PosCustomer | null
  config: PosConfig
  locationName: string | null
  notes: string
  onCompleted: (sale: SaleResult) => void
}) {
  const methods = config.payments.methods ?? ['Cash']
  const creditEnabled = config.pos.allow_credit_sales === true
  const allMethods = creditEnabled && !methods.some((m) => m.toLowerCase().startsWith('credit'))
    ? [...methods, 'Credit']
    : methods

  const [payments, setPayments] = React.useState<PaymentDraft[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // reset the payment editor each time the dialog opens
  React.useEffect(() => {
    if (open) {
      const defaultMethod = config.pos.default_payment_method && methods.includes(config.pos.default_payment_method)
        ? config.pos.default_payment_method
        : methods[0]
      setPayments([{ method: defaultMethod, amount: summary.grandTotal, reference: '', cash_received: null }])
      setError(null)
    }
     
  }, [open])

  const paid = round2(
    payments
      .filter((p) => p.method.toLowerCase() !== 'credit' && typeof p.amount === 'number')
      .reduce((s, p) => s + (p.amount as number), 0)
  )
  const due = round2(summary.grandTotal - paid)
  const creditTotal = round2(
    payments
      .filter((p) => p.method.toLowerCase() === 'credit' && typeof p.amount === 'number')
      .reduce((s, p) => s + (p.amount as number), 0)
  )
  const totalChange = round2(
    payments
      .filter((p) => p.method.toLowerCase().startsWith('cash') && p.cash_received != null && p.amount != null)
      .reduce((s, p) => s + Math.max((p.cash_received as number) - (p.amount as number), 0), 0)
  )

  const updatePayment = React.useCallback((index: number, patch: Partial<PaymentDraft>) => {
    setPayments((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }, [])

  const submit = React.useCallback(async () => {
    setError(null)
    // client-side pre-validation (server re-validates everything)
    if (items.length === 0) {
      setError('The cart is empty.')
      return
    }
    for (const p of payments) {
      if (p.amount == null || p.amount <= 0) {
        setError('Every payment needs an amount greater than zero.')
        return
      }
      if (p.method.toLowerCase().startsWith('cash') && p.cash_received != null && p.cash_received < p.amount) {
        setError('Cash received cannot be less than the cash payment amount.')
        return
      }
    }
    if (due < 0) {
      setError('The payments add up to more than the bill total.')
      return
    }
    if (due > 0) {
      if (!creditEnabled) {
        setError('The full amount must be paid — credit sales are not enabled.')
        return
      }
      if (!customer) {
        setError('A customer is required for credit (due) sales.')
        return
      }
    }
    if (creditTotal > 0 && creditTotal !== due) {
      setError(`The Credit row (${formatMoney(creditTotal)}) must equal the remaining balance (${formatMoney(due)}).`)
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/pos/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: items.map((i) => ({
            variant_id: i.variant_id,
            quantity: i.quantity,
            unit_price: i.price_overridden ? i.unit_price : null,
            discount_type: i.discount_type,
            discount_value: i.discount_value,
          })),
          customer_id: customer?.id ?? null,
          bill_discount_type: 'pct', // the bill discount is already folded into summary by the parent
          bill_discount_value: 0,
          payments: payments.map((p) => ({
            method: p.method,
            amount: p.amount,
            reference: p.reference.trim() || null,
            cash_received: p.method.toLowerCase().startsWith('cash') ? p.cash_received : null,
          })),
          notes: notes.trim() || null,
        }),
      })
      const body = (await res.json().catch(() => null)) as SaleResult | { error?: string } | null
      if (!res.ok || !body || 'error' in body) {
        const message = (body as { error?: string })?.error ?? 'Checkout failed. Nothing was charged or deducted.'
        setError(message)
        toast.error('Sale not completed', { description: message })
        return
      }
      toast.success('Sale completed', { description: (body as SaleResult).sale_number })
      onCompleted(body as SaleResult)
      onOpenChange(false)
    } catch (err) {
      // network failure — DO NOT clear the cart, show clearly that nothing completed
      setError('Network error — the sale was NOT completed. Check the connection and try again.')
      toast.error('Sale not completed', { description: 'Network error. The cart is preserved.' })
      console.error('[pos:checkout] network error', err)
    } finally {
      setSubmitting(false)
    }
  }, [items, payments, due, creditEnabled, customer, creditTotal, notes, onCompleted, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
            Checkout
          </DialogTitle>
          <DialogDescription>
            Review the bill, record the payment{payments.length > 1 ? 's' : ''}, then complete the sale.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* summary */}
          <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
            <SummaryRow label={`Items (${items.reduce((s, i) => s + i.quantity, 0)})`} value={formatMoney(summary.subtotal + summary.itemDiscountTotal)} />
            {summary.itemDiscountTotal > 0 ? (
              <SummaryRow label="Item discounts" value={`− ${formatMoney(summary.itemDiscountTotal)}`} />
            ) : null}
            {summary.billDiscountAmount > 0 ? (
              <SummaryRow label="Bill discount" value={`− ${formatMoney(summary.billDiscountAmount)}`} />
            ) : null}
            {summary.taxTotal > 0 ? (
              <SummaryRow
                label={`GST (${config.tax.enabled === false ? 'off' : config.pos.default_tax_mode === 'exclusive' ? 'exclusive' : 'included'})`}
                value={formatMoney(summary.taxTotal)}
              />
            ) : null}
            {summary.roundOff !== 0 ? (
              <SummaryRow label="Round off" value={`${summary.roundOff > 0 ? '+' : '−'} ${formatMoney(Math.abs(summary.roundOff))}`} />
            ) : null}
            <div className="mt-1 flex items-center justify-between border-t pt-1.5 text-base font-semibold">
              <span>Total payable</span>
              <span className="tabular-nums">{formatMoney(summary.grandTotal)}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {customer ? <span>Customer: <span className="text-foreground">{customer.name}</span></span> : <span>Walk-in customer</span>}
            {locationName ? <span>Stock from: <span className="text-foreground">{locationName}</span></span> : null}
          </div>

          {/* payments */}
          <div className="space-y-2">
            {payments.map((p, index) => {
              const isCash = p.method.toLowerCase().startsWith('cash')
              const isCredit = p.method.toLowerCase().startsWith('credit')
              return (
                <div key={index} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Select value={p.method} onValueChange={(v) => updatePayment(index, { method: v })}>
                      <SelectTrigger className="w-36" aria-label={`Payment method ${index + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {allMethods.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={p.amount ?? ''}
                      onChange={(e) => updatePayment(index, { amount: e.target.value === '' ? null : Number(e.target.value) })}
                      placeholder="Amount"
                      className="flex-1 tabular-nums"
                      aria-label={`Payment amount ${index + 1}`}
                    />
                    {payments.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setPayments((prev) => prev.filter((_, i) => i !== index))}
                        aria-label={`Remove payment ${index + 1}`}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={p.reference}
                      onChange={(e) => updatePayment(index, { reference: e.target.value })}
                      placeholder={isCash ? 'Reference (optional)' : isCredit ? 'Credit note (optional)' : 'UPI / card reference (optional)'}
                      className="flex-1"
                      aria-label={`Payment reference ${index + 1}`}
                      maxLength={80}
                    />
                    {isCash ? (
                      <div className="flex items-center gap-1.5">
                        <Banknote className="size-4 text-muted-foreground" aria-hidden="true" />
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          inputMode="decimal"
                          value={p.cash_received ?? ''}
                          onChange={(e) => updatePayment(index, { cash_received: e.target.value === '' ? null : Number(e.target.value) })}
                          placeholder="Cash received"
                          className="w-32 tabular-nums"
                          aria-label={`Cash received ${index + 1}`}
                        />
                      </div>
                    ) : null}
                  </div>
                  {isCash && p.cash_received != null && p.amount != null ? (
                    <p className="text-xs text-muted-foreground">
                      Change: <span className="font-medium text-foreground tabular-nums">{formatMoney(Math.max(p.cash_received - p.amount, 0))}</span>
                    </p>
                  ) : null}
                </div>
              )
            })}

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                setPayments((prev) => [...prev, { method: methods[0], amount: due > 0 ? due : null, reference: '', cash_received: null }])
              }
            >
              <Plus className="size-4" aria-hidden="true" />
              Split payment
            </Button>
          </div>

          {/* paid / due */}
          <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
            <SummaryRow label="Paid" value={formatMoney(paid)} />
            {totalChange > 0 ? <SummaryRow label="Change to return" value={formatMoney(totalChange)} /> : null}
            <div className="flex items-center justify-between font-medium">
              <span>{due > 0 ? 'Balance due' : 'Balance'}</span>
              <span className="tabular-nums">{formatMoney(Math.max(due, 0))}</span>
            </div>
            {due > 0 && !creditEnabled ? (
              <p className="text-xs text-destructive">Full payment required — credit sales are disabled.</p>
            ) : null}
            {due > 0 && creditEnabled && !customer ? (
              <p className="text-xs text-destructive">Credit requires a customer — press F4 to attach one.</p>
            ) : null}
          </div>

          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="mt-2 gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Back to cart
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={submitting || items.length === 0}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Completing…
              </>
            ) : (
              <>
                <ShoppingCart className="size-4" aria-hidden="true" />
                Complete sale
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export { Printer }
