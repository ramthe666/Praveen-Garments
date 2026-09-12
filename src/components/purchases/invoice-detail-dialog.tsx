'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Ban, CheckCircle2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createClient } from '@/lib/supabase/client'
import { formatDateTime, formatMoney } from '@/lib/catalog/constants'
import { logError } from '@/lib/errors'
import { cn } from '@/lib/utils'

interface InvoiceDetailData {
  invoice: {
    id: string
    invoice_number: string
    supplier_name: string
    po_number: string | null
    supplier_invoice_no: string | null
    supplier_invoice_date: string | null
    location_name: string
    invoice_date: string
    status: string
    subtotal: number
    discount_total: number
    tax_total: number
    grand_total: number
    paid_amount: number
    due_amount: number
    payment_status: string
    tax_mode: string
    inter_state: boolean
    notes: string | null
    received_at: string | null
    received_by_name: string | null
    created_by_name: string | null
  }
  items: Array<{
    id: string
    line_no: number
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
    returned_quantity: number
  }>
}

/**
 * Purchase invoice detail: line snapshots, receive/cancel actions and the
 * gateway to supplier returns. One RPC (purchase_invoice_detail).
 */
export function InvoiceDetailDialog({
  invoiceId,
  open,
  onOpenChange,
  onChanged,
  onReturn,
}: {
  invoiceId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: () => void
  onReturn?: (invoice: InvoiceDetailData) => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [detail, setDetail] = React.useState<InvoiceDetailData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open || !invoiceId) return
    setLoading(true)
    setReason('')
    void (async () => {
      const { data, error } = await supabase.rpc('purchase_invoice_detail', { p_invoice_id: invoiceId })
      if (error) {
        logError('invoice-detail:load', error)
        setDetail(null)
      } else {
        setDetail(data as unknown as InvoiceDetailData)
      }
      setLoading(false)
    })()
  }, [open, invoiceId, supabase])

  async function action(kind: 'confirm' | 'cancel') {
    if (!invoiceId) return
    if (kind === 'cancel' && !reason.trim()) {
      toast.error('A cancellation reason is required.')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/purchase-invoices', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId, action: kind, reason: reason.trim() || undefined }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not update the invoice.')
        return
      }
      toast.success(kind === 'confirm' ? 'Goods received — stock and payable updated.' : 'Invoice cancelled.')
      onOpenChange(false)
      onChanged?.()
    } catch (e) {
      logError('invoice-detail:action', e)
      toast.error('Could not update the invoice.')
    } finally {
      setBusy(false)
    }
  }

  const inv = detail?.invoice

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{inv?.invoice_number ?? 'Purchase invoice'}</DialogTitle>
          <DialogDescription>
            {inv ? `${inv.supplier_name} · ${inv.location_name} · ${formatDateTime(inv.invoice_date)}` : 'Loading…'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading invoice…</p>
        ) : !detail || !inv ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Invoice not found.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p className="text-muted-foreground">
                Supplier bill: <span className="font-mono text-foreground">{inv.supplier_invoice_no ?? '—'}</span>
                {inv.supplier_invoice_date ? ` · ${inv.supplier_invoice_date}` : ''}
              </p>
              <p className="text-muted-foreground">
                Order: <span className="font-mono text-foreground">{inv.po_number ?? 'direct'}</span>
              </p>
              <p className="text-muted-foreground">
                Status:{' '}
                <span className={cn('font-medium', inv.status === 'RECEIVED' ? 'text-success' : inv.status === 'CANCELLED' ? 'text-destructive' : 'text-warning-foreground')}>
                  {inv.status}
                </span>
                {inv.received_at ? ` · received ${formatDateTime(inv.received_at)}` : ''}
              </p>
              <p className="text-muted-foreground">
                Payment: <span className="font-medium text-foreground">{inv.payment_status.replace('_', ' ')}</span>
                {Number(inv.due_amount) > 0 && inv.status !== 'DRAFT' ? ` · due ${formatMoney(Number(inv.due_amount))}` : ''}
              </p>
            </div>

            <div className="relative overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Item</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Qty</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Cost</th>
                    <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">GST</th>
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
                          {Number(item.returned_quantity) > 0 ? ` · returned ${item.returned_quantity}` : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{item.quantity}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(Number(item.unit_cost))}</td>
                      <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{Number(item.gst_rate)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(Number(item.line_total))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/40 text-sm">
                  <tr>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground" colSpan={4}>Taxable / tax</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(Number(inv.subtotal) - Number(inv.discount_total))} / {formatMoney(Number(inv.tax_total))}</td>
                  </tr>
                  <tr className="font-medium">
                    <td className="px-3 py-1.5" colSpan={4}>Grand total</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(Number(inv.grand_total))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {inv.notes ? <p className="text-xs text-muted-foreground">{inv.notes}</p> : null}

            {inv.status === 'DRAFT' ? (
              <div className="grid gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                <Label htmlFor="inv-cancel-reason">Cancel reason (only needed to cancel)</Label>
                <Input id="inv-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <div className="mr-auto flex flex-wrap gap-2">
            {inv?.status === 'DRAFT' ? (
              <>
                <Button size="sm" onClick={() => action('confirm')} disabled={busy}>
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                  Receive goods
                </Button>
                <Button size="sm" variant="outline" onClick={() => action('cancel')} disabled={busy}>
                  <Ban className="size-4" aria-hidden="true" />
                  Cancel
                </Button>
              </>
            ) : null}
            {inv?.status === 'RECEIVED' && detail && detail.items.some((i) => i.quantity > i.returned_quantity) && onReturn ? (
              <Button size="sm" variant="outline" onClick={() => onReturn(detail)} disabled={busy}>
                <Undo2 className="size-4" aria-hidden="true" />
                Return items
              </Button>
            ) : null}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
