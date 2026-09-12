'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, ArrowLeftRight, Ban, Printer, Undo2 } from 'lucide-react'
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
import { createClient } from '@/lib/supabase/client'
import { formatMoney, formatDateTime } from '@/lib/catalog/constants'
import { round2 } from '@/lib/pos/calc'
import { logError } from '@/lib/errors'
import { useApp } from '@/components/providers/app-provider'
import { cn } from '@/lib/utils'
import type { Sale, SaleItem, SalePayment, StockMovement } from '@/types/database'
import { SalesReturnDialog } from './sales-return-dialog'
import { ExchangeDialog } from './exchange-dialog'

export interface SaleMovementLite {
  id: number
  variant_id: string | null
  movement_type: string
  quantity: number
  balance_after: number
  reference_type: string | null
  reference_id: string | null
  reason: string | null
  user_email: string | null
  created_at: string
  sku: string | null
}

export interface SaleDetailData {
  sale: Sale
  items: SaleItem[]
  payments: SalePayment[]
  movements: SaleMovementLite[]
}

/**
 * Sale detail: the complete financial record — items with their sale-time
 * snapshots, payments, and the stock movements this sale produced.
 * Cancellation is permission-gated and always requires a reason.
 */
export function SaleDetailView({ initial }: { initial: SaleDetailData }) {
  const { hasPermission } = useApp()
  const router = useRouter()
  const supabase = React.useMemo(() => createClient(), [])
  const [sale, setSale] = React.useState<Sale>(initial.sale)
  const [cancelOpen, setCancelOpen] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [returnOpen, setReturnOpen] = React.useState(false)
  const [exchangeOpen, setExchangeOpen] = React.useState(false)

  const canCancel = hasPermission('cancel_sale') && sale.status === 'COMPLETED'
  const canReturn = hasPermission('process_return') && sale.status === 'COMPLETED'

  const cancel = React.useCallback(async () => {
    const trimmed = reason.trim()
    if (!trimmed) {
      toast.error('A reason is required to cancel a sale.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/sales/${sale.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: trimmed }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string; restocked_items?: number } | null
      if (!res.ok) {
        toast.error('Could not cancel the sale', { description: body?.error ?? 'Nothing was changed.' })
        return
      }
      toast.success('Sale cancelled', {
        description: `${body?.restocked_items ?? 0} item line(s) returned to stock. The invoice record is preserved.`,
      })
      // refresh the sale row
      const { data, error } = await supabase.from('sales').select('*').eq('id', sale.id).single()
      if (!error && data) setSale(data as Sale)
      setCancelOpen(false)
      setReason('')
    } catch (err) {
      logError('sale:cancel', err)
      toast.error('Network error — the sale was not cancelled.')
    } finally {
      setSubmitting(false)
    }
  }, [reason, sale.id, supabase])

  // GST display split (deterministic, matches the engine)
  const intraState = !sale.inter_state
  const splitTotals = React.useMemo(() => {
    const tax = Number(sale.tax_total)
    if (intraState) {
      const cgst = round2(tax / 2)
      return { cgst, sgst: round2(tax - cgst), igst: 0 }
    }
    return { cgst: 0, sgst: 0, igst: tax }
  }, [sale.tax_total, intraState])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" aria-label="Back to sales">
            <Link href="/sales">
              <ArrowLeft className="size-4" aria-hidden="true" />
            </Link>
          </Button>
          <div>
            <h1 className="font-mono text-xl font-semibold tracking-tight">{sale.sale_number}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {formatDateTime(sale.sale_date)}
              {sale.location_name ? ` · ${sale.location_name}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
              sale.status === 'CANCELLED'
                ? 'bg-destructive/10 text-destructive border-destructive/25'
                : Number(sale.due_amount) > 0
                  ? 'bg-warning/15 text-warning-foreground border-warning/30'
                  : 'bg-success/10 text-success border-success/25'
            )}
          >
            {sale.status === 'CANCELLED' ? 'Cancelled' : sale.payment_status.replace('_', ' ')}
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/sales/${sale.id}/invoice`} target="_blank" rel="noopener">
              <Printer className="size-4" aria-hidden="true" />
              Print invoice
            </Link>
          </Button>
          {canReturn ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setReturnOpen(true)}>
                <Undo2 className="size-4" aria-hidden="true" />
                Return
              </Button>
              <Button variant="outline" size="sm" onClick={() => setExchangeOpen(true)}>
                <ArrowLeftRight className="size-4" aria-hidden="true" />
                Exchange
              </Button>
            </>
          ) : null}
          {canCancel ? (
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setCancelOpen(true)}>
              <Ban className="size-4" aria-hidden="true" />
              Cancel sale
            </Button>
          ) : null}
        </div>
      </div>

      {sale.status === 'CANCELLED' ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p className="font-medium text-destructive">This sale was cancelled</p>
          <p className="mt-1 text-muted-foreground">
            Reason: {sale.cancel_reason ?? '—'} · {sale.cancelled_at ? formatDateTime(sale.cancelled_at) : ''}
            {' '}· Stock was restored via SALES_RETURN movements. The invoice record is preserved for audit.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* items */}
        <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2.5 font-medium">Item</th>
                <th scope="col" className="px-2 py-2.5 font-medium">Qty</th>
                <th scope="col" className="px-2 py-2.5 font-medium">Price</th>
                <th scope="col" className="px-2 py-2.5 font-medium">Discount</th>
                <th scope="col" className="px-2 py-2.5 font-medium">GST</th>
                <th scope="col" className="px-2 py-2.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {initial.items.map((item) => (
                <tr key={item.id}>
                  <td className="px-3 py-2.5">
                    <p className="max-w-[240px] truncate font-medium">{item.product_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[item.color_name, item.size_name].filter(Boolean).join(' / ') || 'Default'} · {item.sku}
                      {item.hsn_code ? ` · HSN ${item.hsn_code}` : ''}
                      {item.price_overridden ? ' · price overridden' : ''}
                    </p>
                  </td>
                  <td className="px-2 py-2.5 tabular-nums">{item.quantity}</td>
                  <td className="px-2 py-2.5 tabular-nums">{formatMoney(Number(item.unit_price))}</td>
                  <td className="px-2 py-2.5 tabular-nums">
                    {Number(item.discount_amount) > 0 ? (
                      <span>
                        − {formatMoney(Number(item.discount_amount))}
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({item.discount_type === 'pct' ? `${Number(item.discount_value)}%` : 'fixed'})
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-2.5 tabular-nums">
                    {Number(item.tax_amount) > 0 ? (
                      <span>
                        {formatMoney(Number(item.tax_amount))}
                        <span className="ml-1 text-xs text-muted-foreground">{Number(item.gst_rate)}%</span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-right font-medium tabular-nums">
                    {formatMoney(Number(item.line_total))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* summary + payments + movements */}
        <div className="space-y-4">
          <div className="space-y-1.5 rounded-lg border bg-card p-4 text-sm shadow-xs">
            <h2 className="mb-1 text-sm font-medium">Bill</h2>
            <Row label="Subtotal" value={formatMoney(Number(sale.subtotal) + Number(sale.item_discount_total))} />
            {Number(sale.item_discount_total) > 0 ? (
              <Row label="Item discounts" value={`− ${formatMoney(Number(sale.item_discount_total))}`} />
            ) : null}
            {Number(sale.bill_discount) > 0 ? (
              <Row label="Bill discount" value={`− ${formatMoney(Number(sale.bill_discount))}`} />
            ) : null}
            {Number(sale.tax_total) > 0 ? (
              intraState ? (
                <>
                  <Row label="CGST" value={formatMoney(splitTotals.cgst)} />
                  <Row label="SGST" value={formatMoney(splitTotals.sgst)} />
                </>
              ) : (
                <Row label="IGST (inter-state)" value={formatMoney(splitTotals.igst)} />
              )
            ) : null}
            {Number(sale.round_off) !== 0 ? (
              <Row label="Round off" value={`${Number(sale.round_off) > 0 ? '+' : '−'} ${formatMoney(Math.abs(Number(sale.round_off)))}`} />
            ) : null}
            <div className="flex items-center justify-between border-t pt-1.5 text-base font-semibold">
              <span>Grand total</span>
              <span className="tabular-nums">{formatMoney(Number(sale.grand_total))}</span>
            </div>
            <Row label="Paid" value={formatMoney(Number(sale.paid_amount))} />
            {Number(sale.due_amount) > 0 ? (
              <Row label="Balance due" value={formatMoney(Number(sale.due_amount))} strong />
            ) : null}
            <p className="pt-1 text-xs text-muted-foreground">Tax mode: {sale.tax_mode} (values stored at sale time)</p>
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h2 className="text-sm font-medium">Payments</h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {initial.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium">{p.method}</span>
                    {p.reference ? <span className="ml-1 text-xs text-muted-foreground">#{p.reference}</span> : null}
                    {p.is_credit ? <span className="ml-1 text-xs text-warning-foreground">(credit)</span> : null}
                    {p.cash_received != null && Number(p.cash_change) > 0 ? (
                      <span className="block text-xs text-muted-foreground">
                        received {formatMoney(Number(p.cash_received))} · change {formatMoney(Number(p.cash_change))}
                      </span>
                    ) : null}
                  </span>
                  <span className="tabular-nums">{formatMoney(Number(p.amount))}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h2 className="text-sm font-medium">Parties</h2>
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Customer</dt>
                <dd className="max-w-[60%] truncate text-right">{sale.customer_name ?? 'Walk-in'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Cashier</dt>
                <dd className="max-w-[60%] truncate text-right">{sale.cashier_name ?? '—'}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h2 className="text-sm font-medium">Stock movements</h2>
            <ul className="mt-2 space-y-1.5 text-xs">
              {initial.movements.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className={m.movement_type === 'SALE' ? 'text-foreground' : 'text-destructive'}>
                      {m.movement_type === 'SALE' ? 'Sale' : 'Return'}
                    </span>{' '}
                    <span className="text-muted-foreground">{m.sku ?? ''}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {m.quantity > 0 ? '+' : ''}{m.quantity} → {m.balance_after}
                  </span>
                </li>
              ))}
              {initial.movements.length === 0 ? (
                <li className="text-muted-foreground">No movements recorded.</li>
              ) : null}
            </ul>
          </div>
        </div>
      </div>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel {sale.sale_number}?</DialogTitle>
            <DialogDescription>
              The items will be returned to stock (SALES_RETURN movements) and the invoice record is preserved
              for audit. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
              <Row label="Grand total" value={formatMoney(Number(sale.grand_total))} />
              <Row label="Already paid" value={formatMoney(Number(sale.paid_amount))} />
              <Row label="Refund due" value={formatMoney(Number(sale.paid_amount))} />
            </div>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for cancellation (required) *"
              aria-label="Cancellation reason"
              maxLength={300}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={submitting}>
              Keep the sale
            </Button>
            <Button variant="destructive" onClick={() => void cancel()} disabled={submitting}>
              <Ban className="size-4" aria-hidden="true" />
              Cancel sale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SalesReturnDialog
        sale={sale}
        items={initial.items}
        open={returnOpen}
        onOpenChange={setReturnOpen}
        onDone={() => router.refresh()}
      />
      <ExchangeDialog
        sale={sale}
        items={initial.items}
        open={exchangeOpen}
        onOpenChange={setExchangeOpen}
        onDone={() => router.refresh()}
      />
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('tabular-nums', strong && 'font-medium text-destructive')}>{value}</span>
    </div>
  )
}

export type { StockMovement }
