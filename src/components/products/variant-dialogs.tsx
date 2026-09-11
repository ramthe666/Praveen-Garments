'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Barcode, Loader2, QrCode, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Combobox } from '@/components/shared/combobox'
import { BarcodeSvg } from '@/components/shared/barcode-svg'
import { QrCodeSvg } from '@/components/shared/qr-code'
import { ADJUSTMENT_TYPES } from '@/lib/catalog/constants'
import type {
  Color,
  ProductVariant,
  Size,
  StockLocation,
} from '@/types/database'

async function patchVariant(id: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/admin/variants/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await res.json()) as { error?: string }
  if (!res.ok) return { ok: false, error: payload.error ?? 'Please try again.' }
  return { ok: true }
}

/** Edit a variant: SKU, size, color, prices, identifiers, active state. */
export function VariantEditDialog({
  variant,
  sizes,
  colors,
  open,
  onOpenChange,
  onSaved,
}: {
  variant: ProductVariant | null
  sizes: Size[]
  colors: Color[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [sku, setSku] = React.useState('')
  const [sizeId, setSizeId] = React.useState('')
  const [colorId, setColorId] = React.useState('')
  const [barcode, setBarcode] = React.useState('')
  const [qr, setQr] = React.useState('')
  const [costPrice, setCostPrice] = React.useState('')
  const [mrp, setMrp] = React.useState('')
  const [sellingPrice, setSellingPrice] = React.useState('')
  const [wholesalePrice, setWholesalePrice] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (variant) {
      setSku(variant.sku)
      setSizeId(variant.size_id ?? '')
      setColorId(variant.color_id ?? '')
      setBarcode(variant.barcode ?? '')
      setQr(variant.qr_identifier ?? '')
      setCostPrice(variant.cost_price !== null ? String(variant.cost_price) : '')
      setMrp(variant.mrp !== null ? String(variant.mrp) : '')
      setSellingPrice(variant.selling_price !== null ? String(variant.selling_price) : '')
      setWholesalePrice(variant.wholesale_price !== null ? String(variant.wholesale_price) : '')
    }
  }, [variant])

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (!variant || busy) return
    if (!sku.trim()) {
      toast.error('SKU cannot be empty')
      return
    }
    setBusy(true)
    try {
      const result = await patchVariant(variant.id, {
        sku: sku.trim(),
        size_id: sizeId || null,
        color_id: colorId || null,
        barcode: barcode.trim() || null,
        qr_identifier: qr.trim() || null,
        cost_price: costPrice ? Number(costPrice) : null,
        mrp: mrp ? Number(mrp) : null,
        selling_price: sellingPrice ? Number(sellingPrice) : null,
        wholesale_price: wholesalePrice ? Number(wholesalePrice) : null,
      })
      if (!result.ok) {
        toast.error('Could not save the variant', { description: result.error })
        return
      }
      toast.success('Variant updated', { description: `${sku.trim()} was saved.` })
      onOpenChange(false)
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  async function regenerate(kind: 'barcode' | 'qr') {
    if (!variant || busy) return
    setBusy(true)
    try {
      const result = await patchVariant(variant.id, kind === 'barcode' ? { generate_barcode: true } : { generate_qr: true })
      if (!result.ok) {
        toast.error('Could not generate a new identifier', { description: result.error })
        return
      }
      toast.success(kind === 'barcode' ? 'New barcode generated' : 'New QR identifier generated')
      onOpenChange(false)
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit variant</DialogTitle>
          <DialogDescription>
            SKUs, barcodes and QR identifiers are unique across the whole catalog — the database
            rejects duplicates.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="v-sku">SKU</Label>
              <Input id="v-sku" value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} maxLength={60} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-size">Size</Label>
              <Combobox
                options={[{ value: '', label: 'No size' }, ...sizes.filter((s) => s.is_active).map((s) => ({ value: s.id, label: s.name }))]}
                value={sizeId || undefined}
                onValueChange={(v) => setSizeId(v)}
                placeholder="No size"
                aria-label="Variant size"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-color">Color</Label>
              <Combobox
                options={[{ value: '', label: 'No color' }, ...colors.filter((c) => c.is_active).map((c) => ({ value: c.id, label: c.name }))]}
                value={colorId || undefined}
                onValueChange={(v) => setColorId(v)}
                placeholder="No color"
                aria-label="Variant color"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-barcode">Barcode</Label>
              <div className="flex gap-2">
                <Input
                  id="v-barcode"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="8-14 digits"
                  inputMode="numeric"
                  maxLength={14}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => void regenerate('barcode')} disabled={busy}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">Generate</span>
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-qr">QR identifier</Label>
              <div className="flex gap-2">
                <Input id="v-qr" value={qr} onChange={(e) => setQr(e.target.value)} placeholder="4-64 chars" maxLength={64} />
                <Button type="button" variant="outline" size="sm" onClick={() => void regenerate('qr')} disabled={busy}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">Generate</span>
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            {(
              [
                ['Cost', costPrice, setCostPrice],
                ['MRP', mrp, setMrp],
                ['Selling', sellingPrice, setSellingPrice],
                ['Wholesale', wholesalePrice, setWholesalePrice],
              ] as const
            ).map(([label, value, setter]) => (
              <div key={label} className="space-y-2">
                <Label htmlFor={`v-${label}`}>{label} price</Label>
                <Input
                  id={`v-${label}`}
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  placeholder="inherit"
                />
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
              Save variant
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** View a variant's barcode + QR with print-ready rendering. */
export function VariantIdsDialog({
  variant,
  productName,
  companyName,
  open,
  onOpenChange,
}: {
  variant: ProductVariant | null
  productName: string
  companyName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!variant) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Barcode &amp; QR</DialogTitle>
          <DialogDescription>
            {productName} — SKU {variant.sku}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-2">
          <div className="rounded-lg border p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Barcode className="size-4" aria-hidden="true" />
              {variant.barcode ? 'EAN-13 barcode' : 'Barcode (SKU as CODE128)'}
            </div>
            <div className="flex justify-center overflow-hidden rounded bg-white p-3">
              <BarcodeSvg value={variant.barcode} sku={variant.sku} height={56} width={1.6} displayValue />
            </div>
            <p className="mt-2 break-all text-center text-xs tabular-nums text-muted-foreground">
              {variant.barcode ?? variant.sku}
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <QrCode className="size-4" aria-hidden="true" />
              QR identifier
            </div>
            <div className="flex justify-center rounded bg-white p-3">
              <QrCodeSvg value={variant.qr_identifier} size={140} />
            </div>
            <p className="mt-2 break-all text-center text-xs text-muted-foreground">
              {variant.qr_identifier ?? 'No QR identifier assigned'}
            </p>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            {companyName} — scanning the barcode or QR in the future POS resolves this exact variant.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Toggle variant active/inactive with confirmation. */
export function VariantToggleDialog({
  variant,
  open,
  onOpenChange,
  onSaved,
}: {
  variant: ProductVariant | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  if (!variant) return null

  const nextActive = !variant.is_active

  async function handleToggle() {
    if (!variant) return
    setBusy(true)
    try {
      const result = await patchVariant(variant.id, { is_active: nextActive })
      if (!result.ok) {
        toast.error('Could not update the variant', { description: result.error })
        return
      }
      toast.success(nextActive ? 'Variant activated' : 'Variant deactivated', {
        description: `${variant.sku} is ${nextActive ? 'sellable again' : 'no longer sellable'} (history is preserved).`,
      })
      onOpenChange(false)
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{nextActive ? 'Activate variant' : 'Deactivate variant'}</DialogTitle>
          <DialogDescription>
            {nextActive
              ? `${variant.sku} will become sellable again.`
              : `${variant.sku} will stop being sellable. Existing stock, history and past invoices stay valid.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={nextActive ? 'default' : 'destructive'} onClick={() => void handleToggle()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {nextActive ? 'Activate' : 'Deactivate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Stock action dialogs (opening / adjust / transfer / reorder)
// ---------------------------------------------------------------------------

interface StockDialogBaseProps {
  variant: { id: string; sku: string; label: string }
  locations: StockLocation[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

async function callStockApi(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/admin/stock/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await res.json()) as { error?: string }
  if (!res.ok) return { ok: false, error: payload.error ?? 'Please try again.' }
  return { ok: true }
}

export function OpeningStockDialog({ variant, locations, open, onOpenChange, onSaved }: StockDialogBaseProps) {
  const [locationId, setLocationId] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const activeLocations = locations.filter((l) => l.is_active)

  React.useEffect(() => {
    if (open && !locationId && activeLocations[0]) setLocationId(activeLocations[0].id)
  }, [open, locationId, activeLocations])

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty < 0) {
      toast.error('Enter a whole quantity of zero or more.')
      return
    }
    setBusy(true)
    try {
      const result = await callStockApi('opening', {
        variant_id: variant.id,
        location_id: locationId,
        quantity: qty,
        reason: reason.trim() || undefined,
      })
      if (!result.ok) {
        toast.error('Could not record opening stock', { description: result.error })
        return
      }
      toast.success('Opening stock recorded', {
        description: `${qty} × ${variant.sku} at ${activeLocations.find((l) => l.id === locationId)?.name ?? 'the location'}.`,
      })
      onOpenChange(false)
      setQuantity('')
      setReason('')
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Opening stock</DialogTitle>
          <DialogDescription>
            Baseline quantity for {variant.label}. Allowed once per variant and location — use
            adjustments afterwards.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="os-location">Location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger id="os-location">
                <SelectValue placeholder="Select location…" />
              </SelectTrigger>
              <SelectContent>
                {activeLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name} ({l.location_type === 'warehouse' ? 'Warehouse' : 'Store'})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="os-quantity">Quantity</Label>
            <Input
              id="os-quantity"
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 25"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="os-reason">Note (optional)</Label>
            <Input id="os-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Initial count" maxLength={300} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !locationId}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Record opening stock
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AdjustStockDialog({ variant, locations, open, onOpenChange, onSaved }: StockDialogBaseProps) {
  const [locationId, setLocationId] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [direction, setDirection] = React.useState<'in' | 'out'>('in')
  const [movementType, setMovementType] = React.useState('ADJUSTMENT')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const activeLocations = locations.filter((l) => l.is_active)

  React.useEffect(() => {
    if (open && !locationId && activeLocations[0]) setLocationId(activeLocations[0].id)
  }, [open, locationId, activeLocations])

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const magnitude = Number(quantity)
    if (!Number.isInteger(magnitude) || magnitude <= 0) {
      toast.error('Enter a whole quantity greater than zero.')
      return
    }
    if (!reason.trim()) {
      toast.error('A reason is required', { description: 'Adjustments must be traceable.' })
      return
    }
    setBusy(true)
    try {
      const result = await callStockApi('adjust', {
        variant_id: variant.id,
        location_id: locationId,
        quantity: direction === 'in' ? magnitude : -magnitude,
        movement_type: movementType,
        reason: reason.trim(),
      })
      if (!result.ok) {
        toast.error('Could not adjust stock', { description: result.error })
        return
      }
      toast.success('Stock adjusted', {
        description: `${direction === 'in' ? '+' : '−'}${magnitude} × ${variant.sku}.`,
      })
      onOpenChange(false)
      setQuantity('')
      setReason('')
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Stock adjustment</DialogTitle>
          <DialogDescription>
            {variant.label}. Negative results are blocked unless allowed in Settings → Inventory.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="as-location">Location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger id="as-location">
                <SelectValue placeholder="Select location…" />
              </SelectTrigger>
              <SelectContent>
                {activeLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Direction</Label>
              <div className="grid grid-cols-2 gap-1 rounded-lg border p-1">
                <button
                  type="button"
                  className={`rounded-md px-2 py-1.5 text-sm font-medium ${direction === 'in' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  onClick={() => setDirection('in')}
                >
                  + Add
                </button>
                <button
                  type="button"
                  className={`rounded-md px-2 py-1.5 text-sm font-medium ${direction === 'out' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  onClick={() => setDirection('out')}
                >
                  − Remove
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="as-quantity">Quantity</Label>
              <Input
                id="as-quantity"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="e.g. 5"
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="as-type">Movement type</Label>
            <Select value={movementType} onValueChange={setMovementType}>
              <SelectTrigger id="as-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADJUSTMENT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="as-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Input
              id="as-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. recount found 3 extra"
              maxLength={300}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !locationId}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Apply adjustment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function TransferStockDialog({ variant, locations, open, onOpenChange, onSaved }: StockDialogBaseProps) {
  const [fromId, setFromId] = React.useState('')
  const [toId, setToId] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const activeLocations = locations.filter((l) => l.is_active)

  React.useEffect(() => {
    if (open && activeLocations.length > 0) {
      if (!fromId) setFromId(activeLocations[0].id)
      if (!toId) setToId(activeLocations[1]?.id ?? activeLocations[0].id)
    }
  }, [open, fromId, toId, activeLocations])

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty <= 0) {
      toast.error('Enter a whole quantity greater than zero.')
      return
    }
    if (fromId === toId) {
      toast.error('Source and destination must differ.')
      return
    }
    setBusy(true)
    try {
      const result = await callStockApi('transfer', {
        variant_id: variant.id,
        from_location_id: fromId,
        to_location_id: toId,
        quantity: qty,
        reason: reason.trim() || 'stock transfer',
      })
      if (!result.ok) {
        toast.error('Could not transfer stock', { description: result.error })
        return
      }
      toast.success('Stock transferred', {
        description: `${qty} × ${variant.sku} moved.`,
      })
      onOpenChange(false)
      setQuantity('')
      setReason('')
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  const locationLabel = (id: string) => activeLocations.find((l) => l.id === id)?.name ?? '—'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer stock</DialogTitle>
          <DialogDescription>
            {variant.label}. Writes TRANSFER OUT + TRANSFER IN ledger rows in one transaction.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ts-from">From</Label>
              <Select value={fromId} onValueChange={setFromId}>
                <SelectTrigger id="ts-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {activeLocations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ts-to">To</Label>
              <Select value={toId} onValueChange={setToId}>
                <SelectTrigger id="ts-to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {activeLocations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ts-quantity">Quantity</Label>
            <Input
              id="ts-quantity"
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 10"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ts-reason">Reason</Label>
            <Input
              id="ts-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={`e.g. restock ${locationLabel(toId).toLowerCase()}`}
              maxLength={300}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !fromId || !toId}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Transfer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ReorderLevelDialog({
  variant,
  locations,
  currentReorder,
  globalThreshold,
  open,
  onOpenChange,
  onSaved,
}: StockDialogBaseProps & { currentReorder: number | null; globalThreshold: number | null }) {
  const [locationId, setLocationId] = React.useState('')
  const [value, setValue] = React.useState('')
  const [useGlobal, setUseGlobal] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const activeLocations = locations.filter((l) => l.is_active)

  React.useEffect(() => {
    if (open) {
      setValue(currentReorder !== null ? String(currentReorder) : '')
      setUseGlobal(currentReorder === null)
      if (!locationId && activeLocations[0]) setLocationId(activeLocations[0].id)
    }
  }, [open, currentReorder, locationId, activeLocations])

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    let reorder: number | null = null
    if (!useGlobal) {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 0) {
        toast.error('Reorder level must be a whole number of zero or more.')
        return
      }
      reorder = parsed
    }
    setBusy(true)
    try {
      const result = await callStockApi('reorder', {
        variant_id: variant.id,
        location_id: locationId,
        reorder_level: reorder,
      })
      if (!result.ok) {
        toast.error('Could not set the reorder level', { description: result.error })
        return
      }
      toast.success('Reorder level saved', {
        description: useGlobal
          ? `Falls back to the global threshold (${globalThreshold ?? 10}).`
          : `Low-stock warning at ${reorder} units.`,
      })
      onOpenChange(false)
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reorder level</DialogTitle>
          <DialogDescription>
            {variant.label}. When available stock falls to or below this level the variant is flagged
            LOW STOCK.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rl-location">Location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger id="rl-location">
                <SelectValue placeholder="Select location…" />
              </SelectTrigger>
              <SelectContent>
                {activeLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={useGlobal} onCheckedChange={(v) => setUseGlobal(Boolean(v))} id="rl-global" />
            <span>
              Use the global threshold ({globalThreshold ?? 10} — Settings → Inventory)
            </span>
          </label>
          {!useGlobal ? (
            <div className="space-y-2">
              <Label htmlFor="rl-value">Reorder level</Label>
              <Input
                id="rl-value"
                inputMode="numeric"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="e.g. 10"
                required={!useGlobal}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !locationId}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
