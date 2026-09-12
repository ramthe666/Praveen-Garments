'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Ban, Truck, TruckIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { formatDate, formatMoney } from '@/lib/catalog/constants'
import { logError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { POForReceive } from './invoice-form-dialog'

interface PODetailData {
  purchase_order: {
    id: string
    po_number: string
    supplier_id: string
    supplier_name: string
    location_id: string
    location_name: string
    order_date: string
    expected_date: string | null
    status: string
    subtotal: number
    discount_total: number
    tax_total: number
    grand_total: number
    notes: string | null
    created_by_name: string | null
  }
  items: Array<{
    id: string
    line_no: number
    variant_id: string | null
    product_name: string
    sku: string
    size_name: string | null
    color_name: string | null
    quantity: number
    unit_cost: number
    discount_amount: number
    gst_rate: number
    tax_amount: number
    line_total: number
    received_quantity: number
    pending_quantity: number
  }>
  invoices: Array<{ id: string; invoice_number: string; invoice_date: string; status: string; grand_total: number }>
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'text-warning-foreground',
  ORDERED: 'text-foreground',
  PARTIALLY_RECEIVED: 'text-foreground',
  RECEIVED: 'text-success',
  CANCELLED: 'text-destructive',
}

/**
 * Purchase order detail: line snapshots with received / pending quantities,
 * order / cancel actions, and the receive-goods gateway (opens the invoice
 * form pre-filled with pending lines).
 */
export function PODetailDialog({
  poId,
  open,
  onOpenChange,
  onChanged,
  onReceive,
}: {
  poId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: () => void
  onReceive?: (po: POForReceive) => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [detail, setDetail] = React.useState<PODetailData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open || !poId) return
    setLoading(true)
    setReason('')
    void (async () => {
      const { data, error } = await supabase.rpc('purchase_order_detail', { p_po_id: poId })
      if (error) {
        logError('po-detail:load', error)
        setDetail(null)
      } else {
        setDetail(data as unknown as PODetailData)
      }
      setLoading(false)
    })()
  }, [open, poId, supabase])

  async function action(kind: 'order' | 'cancel') {
    if (!poId) return
    if (kind === 'cancel' && !reason.trim()) {
      toast.error('A cancellation reason is required.')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/purchase-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: poId, action: kind, reason: reason.trim() || undefined }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not update the order.')
        return
      }
      toast.success(kind === 'order' ? 'Order marked as placed.' : 'Order cancelled.')
      onOpenChange(false)
      onChanged?.()
    } catch (e) {
      logError('po-detail:action', e)
      toast.error('Could not update the order.')
    } finally {
      setBusy(false)
    }
  }

  const po = detail?.purchase_order

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{po?.po_number ?? 'Purchase order'}</DialogTitle>
          <DialogDescription>
            {po ? `${po.supplier_name} · into ${po.location_name} · ordered ${formatDate(po.order_date)}` : 'Loading…'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading order…</p>
        ) : !detail || !po ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Order not found.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p className="text-muted-foreground">
                Status:{' '}
                <span className={cn('font-medium', STATUS_TONE[po.status] ?? 'text-foreground')}>{po.status.replace(/_/g, ' ')}</span>
                {po.expected_date ? ` · expected ${formatDate(po.expected_date)}` : ''}
              </p>
              <p className="text-muted-foreground">
                Grand total: <span className="font-medium text-foreground">{formatMoney(Number(po.grand_total))}</span>
              </p>
            </div>

            <div className="relative overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Item</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Ordered</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Received</th>
                    <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">Pending</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Line</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {detail.items.map((item) => (
                    <tr key={item.id}>
                      <td className="max-w-[220px] px-3 py-2">
                        <span className="block truncate font-medium">{item.product_name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.sku}
                          {item.size_name ? ` · ${item.size_name}` : ''}
                          {item.color_name ? ` · ${item.color_name}` : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{item.quantity}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{item.received_quantity}</td>
                      <td className={cn('hidden px-3 py-2 text-right tabular-nums sm:table-cell', item.pending_quantity > 0 && 'font-medium text-warning-foreground')}>
                        {item.pending_quantity}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(Number(item.line_total))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {detail.invoices.length > 0 ? (
              <div className="grid gap-1 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Receipts against this order</p>
                {detail.invoices.map((inv) => (
                  <p key={inv.id} className="font-mono">
                    {inv.invoice_number} · {formatDate(inv.invoice_date)} · {formatMoney(Number(inv.grand_total))} · {inv.status}
                  </p>
                ))}
              </div>
            ) : null}

            {po.notes ? <p className="text-xs text-muted-foreground">{po.notes}</p> : null}

            {po.status === 'DRAFT' || po.status === 'ORDERED' ? (
              <div className="grid gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                <Label htmlFor="po-cancel-reason">Cancel reason (only needed to cancel)</Label>
                <Input id="po-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <div className="mr-auto flex flex-wrap gap-2">
            {po?.status === 'DRAFT' ? (
              <>
                <Button size="sm" onClick={() => action('order')} disabled={busy}>
                  <Truck className="size-4" aria-hidden="true" />
                  Mark as placed
                </Button>
                <Button size="sm" variant="outline" onClick={() => action('cancel')} disabled={busy}>
                  <Ban className="size-4" aria-hidden="true" />
                  Cancel order
                </Button>
              </>
            ) : null}
            {po && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status) && detail.items.some((i) => i.pending_quantity > 0) && onReceive ? (
              <Button size="sm" onClick={() => onReceive({
                id: po.id,
                po_number: po.po_number,
                supplier_id: po.supplier_id,
                supplier_name: po.supplier_name,
                location_id: po.location_id,
                location_name: po.location_name,
                items: detail.items
                  .filter((i) => i.variant_id && i.pending_quantity > 0)
                  .map((i) => ({
                    id: i.id,
                    variant_id: i.variant_id,
                    product_name: i.product_name,
                    sku: i.sku,
                    size_name: i.size_name,
                    color_name: i.color_name,
                    unit_cost: Number(i.unit_cost),
                    pending_quantity: i.pending_quantity,
                  })),
              })} disabled={busy}>
                <TruckIcon className="size-4" aria-hidden="true" />
                Receive goods
              </Button>
            ) : null}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
