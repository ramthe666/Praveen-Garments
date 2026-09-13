'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
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

export interface POItemDraft {
  variant_id: string
  sku: string
  product_name: string
  size_name: string | null
  color_name: string | null
  quantity: string
  unit_cost: string
  discount_amount: string
}

export interface SupplierOption {
  id: string
  name: string
}

export interface LocationOption {
  id: string
  name: string
}

const BLANK_ITEM: Omit<POItemDraft, 'variant_id' | 'sku' | 'product_name' | 'size_name' | 'color_name'> = {
  quantity: '', unit_cost: '', discount_amount: '',
}

function itemTotal(item: POItemDraft): number {
  const qty = Number(item.quantity) || 0
  const cost = Number(item.unit_cost) || 0
  const disc = Number(item.discount_amount) || 0
  return Math.max(0, qty * cost - disc)
}

/**
 * Create (or edit a DRAFT) purchase order. Orders never touch stock — goods
 * are booked in when an invoice is received. Totals shown are a preview;
 * the server recomputes everything from database values.
 */
export function POFormDialog({
  open,
  onOpenChange,
  suppliers,
  locations,
  editOrder,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suppliers: SupplierOption[]
  locations: LocationOption[]
  editOrder?: {
    id: string
    supplier_id: string
    location_id: string
    expected_date: string | null
    notes: string | null
    items: Array<POItemDraft & { po_item_id?: string }>
  } | null
  onSaved?: () => void
}) {
  const [supplierId, setSupplierId] = React.useState('')
  const [locationId, setLocationId] = React.useState('')
  const [expectedDate, setExpectedDate] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [items, setItems] = React.useState<POItemDraft[]>([])
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    if (editOrder) {
      setSupplierId(editOrder.supplier_id)
      setLocationId(editOrder.location_id)
      setExpectedDate(editOrder.expected_date?.slice(0, 10) ?? '')
      setNotes(editOrder.notes ?? '')
      setItems(editOrder.items.map((i) => ({ ...i, quantity: String(i.quantity), unit_cost: String(i.unit_cost), discount_amount: String(i.discount_amount ?? 0) })))
    } else {
      setSupplierId('')
      setLocationId(locations[0]?.id ?? '')
      setExpectedDate('')
      setNotes('')
      setItems([])
    }
  }, [open, editOrder, locations])

  function addVariant(variant: VariantOption) {
    setItems((list) => {
      if (list.some((i) => i.variant_id === variant.id)) {
        toast.info('That item is already on the order — increase its quantity instead.')
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
          ...BLANK_ITEM,
          unit_cost: variant.selling_price !== null ? String(variant.selling_price) : '',
        },
      ]
    })
  }

  const update = (index: number, field: keyof POItemDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setItems((list) => list.map((item, i) => (i === index ? { ...item, [field]: e.target.value } : item)))

  const total = items.reduce((sum, item) => sum + itemTotal(item), 0)

  async function submit() {
    if (!supplierId) {
      toast.error('Choose a supplier.')
      return
    }
    if (!locationId) {
      toast.error('Choose a stock location.')
      return
    }
    const cleaned = items.filter((i) => Number(i.quantity) > 0 && Number(i.unit_cost) >= 0 && i.unit_cost !== '')
    if (cleaned.length === 0) {
      toast.error('Add at least one item with quantity and cost.')
      return
    }
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        supplier_id: supplierId,
        location_id: locationId,
        expected_date: expectedDate || undefined,
        notes: notes.trim() || undefined,
        items: cleaned.map((i) => ({
          variant_id: i.variant_id,
          quantity: Math.round(Number(i.quantity)),
          unit_cost: Math.round(Number(i.unit_cost) * 100) / 100,
          discount_amount: Math.round((Number(i.discount_amount) || 0) * 100) / 100,
        })),
      }
      if (editOrder) {
        payload.id = editOrder.id
        payload.action = 'update'
      }
      const response = await fetch('/api/purchase-orders', {
        method: editOrder ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not save the purchase order.')
        return
      }
      toast.success(editOrder ? 'Purchase order updated.' : 'Purchase order created (draft).')
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      logError('po-form:submit', e)
      toast.error('Could not save the purchase order.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editOrder ? 'Edit purchase order' : 'New purchase order'}</DialogTitle>
          <DialogDescription>
            Ordering never changes stock — goods are booked in when the invoice is received.
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
              <Label>Receive into *</Label>
              <Select value={locationId} onValueChange={setLocationId}>
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
            <div className="grid gap-2">
              <Label htmlFor="po-expected">Expected date</Label>
              <Input id="po-expected" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Add items</Label>
            <VariantPicker onPick={addVariant} placeholder="Search product name or SKU to add…" />
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
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(itemTotal(item))}</td>
                      <td className="px-2 py-1.5 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setItems((list) => list.filter((_, i) => i !== index))}>
                          <Trash2 className="size-4" aria-hidden="true" />
                          <span className="sr-only">Remove {item.sku}</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              Search and add the items you are ordering.
            </p>
          )}

          <div className="grid gap-2">
            <Label htmlFor="po-notes">Notes</Label>
            <Textarea id="po-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={400} />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <span className="mr-auto text-sm text-muted-foreground">Cost total (GST added on top by the server): <strong className="text-foreground">{formatMoney(total)}</strong></span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : editOrder ? 'Save changes' : 'Create order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
