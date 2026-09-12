'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Trash2, TruckIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
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
import { VariantPicker, type VariantOption } from './variant-picker'
import type { LocationOption, SupplierOption } from './po-form-dialog'

interface InvoiceItemDraft {
  variant_id: string
  po_item_id?: string
  sku: string
  product_name: string
  size_name: string | null
  color_name: string | null
  quantity: string
  unit_cost: string
  discount_amount: string
}

export interface POForReceive {
  id: string
  po_number: string
  supplier_id: string
  supplier_name: string
  location_id: string
  location_name: string
  items: Array<{
    id: string
    variant_id: string | null
    product_name: string
    sku: string
    size_name: string | null
    color_name: string | null
    unit_cost: number
    pending_quantity: number
  }>
}

function lineTotal(item: InvoiceItemDraft): number {
  const qty = Number(item.quantity) || 0
  const cost = Number(item.unit_cost) || 0
  const disc = Number(item.discount_amount) || 0
  return Math.max(0, qty * cost - disc)
}

/**
 * Create a purchase invoice (the supplier bill + goods receipt). Receiving
 * now books stock in, creates the payable, and advances the linked PO —
 * all in one atomic server transaction. Linked POs cap the received
 * quantity at what was ordered.
 */
export function InvoiceFormDialog({
  open,
  onOpenChange,
  suppliers,
  locations,
  orders,
  preselectedPO,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suppliers: SupplierOption[]
  locations: LocationOption[]
  orders: POForReceive[]
  preselectedPO?: POForReceive | null
  onSaved?: () => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [supplierId, setSupplierId] = React.useState('')
  const [locationId, setLocationId] = React.useState('')
  const [poId, setPoId] = React.useState('')
  const [supplierInvoiceNo, setSupplierInvoiceNo] = React.useState('')
  const [supplierInvoiceDate, setSupplierInvoiceDate] = React.useState('')
  const [receiveNow, setReceiveNow] = React.useState(true)
  const [items, setItems] = React.useState<InvoiceItemDraft[]>([])
  const [notes, setNotes] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const availableOrders = React.useMemo(
    () => orders.filter((o) => !supplierId || o.supplier_id === supplierId),
    [orders, supplierId]
  )

  React.useEffect(() => {
    if (!open) return
    if (preselectedPO) {
      setSupplierId(preselectedPO.supplier_id)
      setLocationId(preselectedPO.location_id)
      setPoId(preselectedPO.id)
      setItems(
        preselectedPO.items
          .filter((i) => i.variant_id && i.pending_quantity > 0)
          .map((i) => ({
            variant_id: i.variant_id as string,
            po_item_id: i.id,
            sku: i.sku,
            product_name: i.product_name,
            size_name: i.size_name,
            color_name: i.color_name,
            quantity: String(i.pending_quantity),
            unit_cost: String(i.unit_cost),
            discount_amount: '0',
          }))
      )
    } else {
      setSupplierId('')
      setLocationId(locations[0]?.id ?? '')
      setPoId('')
      setItems([])
    }
    setSupplierInvoiceNo('')
    setSupplierInvoiceDate('')
    setReceiveNow(true)
    setNotes('')
  }, [open, preselectedPO, locations])

  async function loadPOItems(nextPoId: string) {
    setPoId(nextPoId)
    if (!nextPoId) {
      setItems([])
      return
    }
    const { data, error } = await supabase.rpc('purchase_order_detail', { p_po_id: nextPoId })
    if (error) {
      logError('invoice-form:po-detail', error)
      toast.error('Could not load the order lines.')
      return
    }
    const detail = data as unknown as {
      purchase_order: { supplier_id: string; location_id: string }
      items: Array<{
        id: string
        variant_id: string | null
        product_name: string
        sku: string
        size_name: string | null
        color_name: string | null
        unit_cost: number
        pending_quantity: number
      }>
    }
    if (detail.purchase_order) {
      setSupplierId(detail.purchase_order.supplier_id)
      setLocationId(detail.purchase_order.location_id)
    }
    setItems(
      (detail.items ?? [])
        .filter((i) => i.variant_id && Number(i.pending_quantity) > 0)
        .map((i) => ({
          variant_id: i.variant_id as string,
          po_item_id: i.id,
          sku: i.sku,
          product_name: i.product_name,
          size_name: i.size_name,
          color_name: i.color_name,
          quantity: String(i.pending_quantity),
          unit_cost: String(i.unit_cost),
          discount_amount: '0',
        }))
    )
  }

  function addVariant(variant: VariantOption) {
    if (poId) {
      toast.info('Items come from the purchase order while it is linked. Unlink the order to add extras.')
      return
    }
    setItems((list) => {
      if (list.some((i) => i.variant_id === variant.id)) {
        toast.info('That item is already on the invoice — increase its quantity instead.')
        return list
      }
      return [
        ...list,
        {
          variant_id: variant.id,
          sku: variant.sku,
          product_name: variant.product_name,
          size_name: variant.size_name,
          color_name: variant.color_name,
          quantity: '',
          unit_cost: variant.selling_price !== null ? String(variant.selling_price) : '',
          discount_amount: '0',
        },
      ]
    })
  }

  const update = (index: number, field: keyof InvoiceItemDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setItems((list) => list.map((item, i) => (i === index ? { ...item, [field]: e.target.value } : item)))

  const total = items.reduce((sum, item) => sum + lineTotal(item), 0)

  async function submit() {
    if (!supplierId) {
      toast.error('Choose a supplier.')
      return
    }
    if (!locationId) {
      toast.error('Choose a stock location.')
      return
    }
    const cleaned = items.filter((i) => Number(i.quantity) > 0 && i.unit_cost !== '' && Number(i.unit_cost) >= 0)
    if (cleaned.length === 0) {
      toast.error('Add at least one item with quantity and cost.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/purchase-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: supplierId,
          location_id: locationId,
          po_id: poId || undefined,
          supplier_invoice_no: supplierInvoiceNo.trim() || undefined,
          supplier_invoice_date: supplierInvoiceDate || undefined,
          status: receiveNow ? 'RECEIVED' : 'DRAFT',
          notes: notes.trim() || undefined,
          items: cleaned.map((i) => ({
            variant_id: i.variant_id,
            po_item_id: i.po_item_id,
            quantity: Math.round(Number(i.quantity)),
            unit_cost: Math.round(Number(i.unit_cost) * 100) / 100,
            discount_amount: Math.round((Number(i.discount_amount) || 0) * 100) / 100,
          })),
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not save the purchase invoice.')
        return
      }
      toast.success(receiveNow ? 'Goods received — stock and payable updated.' : 'Draft invoice saved.')
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      logError('invoice-form:submit', e)
      toast.error('Could not save the purchase invoice.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Receive goods / purchase invoice</DialogTitle>
          <DialogDescription>
            The supplier bill that books stock in. Linked order lines cap quantities at what was ordered.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label>Supplier *</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger aria-label="Supplier" className="w-full min-w-0">
                  <SelectValue placeholder="Choose supplier" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Link purchase order</Label>
              <Select value={poId} onValueChange={loadPOItems}>
                <SelectTrigger aria-label="Purchase order" className="w-full min-w-0">
                  <SelectValue placeholder="No order (direct)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No order (direct)</SelectItem>
                  {availableOrders.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.po_number} · {o.supplier_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Into location *</Label>
              <Select value={locationId} onValueChange={setLocationId} disabled={!!poId}>
                <SelectTrigger aria-label="Stock location" className="w-full min-w-0">
                  <SelectValue placeholder="Choose location" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="inv-sup-no">Supplier invoice no.</Label>
              <Input id="inv-sup-no" value={supplierInvoiceNo} onChange={(e) => setSupplierInvoiceNo(e.target.value)} maxLength={60} placeholder="As printed on their bill" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="inv-sup-date">Supplier invoice date</Label>
              <Input id="inv-sup-date" type="date" value={supplierInvoiceDate} onChange={(e) => setSupplierInvoiceDate(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Add items</Label>
            {poId ? (
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                Lines are pre-filled from the order with pending quantities — adjust the received quantity if this delivery is partial.
              </p>
            ) : (
              <VariantPicker onPick={addVariant} placeholder="Search product name or SKU to add…" />
            )}
          </div>

          {items.length > 0 ? (
            <div className="relative overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-2 py-2 font-medium">Item</th>
                    <th scope="col" className="px-2 py-2 font-medium">Qty</th>
                    <th scope="col" className="px-2 py-2 font-medium">Unit cost (₹)</th>
                    <th scope="col" className="px-2 py-2 font-medium">Discount (₹)</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Line</th>
                    <th scope="col" className="px-2 py-2 font-medium sr-only">Remove</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item, index) => (
                    <tr key={item.variant_id}>
                      <td className="max-w-[220px] px-2 py-1.5">
                        <span className="block truncate font-medium">{item.product_name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.sku}
                          {item.size_name ? ` · ${item.size_name}` : ''}
                          {item.color_name ? ` · ${item.color_name}` : ''}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          className="h-8 w-20 min-w-0 tabular-nums"
                          inputMode="numeric"
                          value={item.quantity}
                          onChange={update(index, 'quantity')}
                          aria-label={`Quantity for ${item.sku}`}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          className="h-8 w-24 min-w-0 tabular-nums"
                          inputMode="decimal"
                          value={item.unit_cost}
                          onChange={update(index, 'unit_cost')}
                          aria-label={`Unit cost for ${item.sku}`}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          className="h-8 w-20 min-w-0 tabular-nums"
                          inputMode="decimal"
                          value={item.discount_amount}
                          onChange={update(index, 'discount_amount')}
                          aria-label={`Discount for ${item.sku}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(lineTotal(item))}</td>
                      <td className="px-2 py-1.5 text-right">
                        {!item.po_item_id ? (
                          <Button variant="ghost" size="sm" onClick={() => setItems((list) => list.filter((_, i) => i !== index))}>
                            <Trash2 className="size-4" aria-hidden="true" />
                            <span className="sr-only">Remove {item.sku}</span>
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              {poId ? 'This order has nothing left to receive.' : 'Search and add items, or link an order to pre-fill its lines.'}
            </p>
          )}

          <div className="grid gap-2">
            <Label htmlFor="inv-notes">Notes</Label>
            <Textarea id="inv-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={400} />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={receiveNow} onCheckedChange={(v) => setReceiveNow(v === true)} id="receive-now" />
            <span className="grid gap-0.5">
              <span className="font-medium">Receive goods now</span>
              <span className="text-xs text-muted-foreground">
                Uncheck to save a draft — nothing touches stock until it is confirmed.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <span className="mr-auto text-sm text-muted-foreground">Preview total (tax added by the server): <strong className="text-foreground">{formatMoney(total)}</strong></span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            <TruckIcon className="size-4" aria-hidden="true" />
            {saving ? 'Saving…' : receiveNow ? 'Receive goods' : 'Save draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
