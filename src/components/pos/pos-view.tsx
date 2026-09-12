'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  Keyboard,
  Layers,
  Loader2,
  Minus,
  Pause,
  Plus,
  QrCode,
  ScanBarcode,
  Search,
  ShoppingCart,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useApp } from '@/components/providers/app-provider'
import { createClient } from '@/lib/supabase/client'
import { useDebounced } from '@/lib/catalog/constants'
import { logError, isTableMissing } from '@/lib/errors'
import { computeBill, computeLine, effectiveDiscountCap, round2 } from '@/lib/pos/calc'
import type { CartItem } from '@/lib/pos/calc'
import type { HeldCart, PaymentDraft, PosConfig, PosCustomer, PosVariantRow, SaleResult } from '@/components/pos/pos-types'
import { CustomerDialog } from '@/components/pos/customer-dialog'
import { CheckoutDialog } from '@/components/pos/checkout-dialog'
import { HeldBillsDialog } from '@/components/pos/held-bills-dialog'
import { QrScanDialog } from '@/components/pos/qr-scan-dialog'
import { SaleSuccess } from '@/components/pos/sale-success'
import { formatMoney } from '@/lib/catalog/constants'

const CART_STORAGE_KEY = 'pg_pos_cart_v1'

interface StoredCart {
  items: CartItem[]
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
  customerState: string | null
  billDiscountType: 'pct' | 'fixed'
  billDiscountValue: number
  notes: string
}

export function PosView() {
  const { hasPermission, profile } = useApp()
  const supabase = React.useMemo(() => createClient(), [])

  const [config, setConfig] = React.useState<PosConfig | null>(null)
  const [configError, setConfigError] = React.useState<string | null>(null)

  const [cart, setCart] = React.useState<CartItem[]>([])
  const [customer, setCustomer] = React.useState<PosCustomer | null>(null)
  const [billDiscountType, setBillDiscountType] = React.useState<'pct' | 'fixed'>('pct')
  const [billDiscountValue, setBillDiscountValue] = React.useState<number>(0)
  const [notes, setNotes] = React.useState('')
  const [lastSale, setLastSale] = React.useState<SaleResult | null>(null)

  const [scanValue, setScanValue] = React.useState('')
  const [scanning, setScanning] = React.useState(false)
  const [searchValue, setSearchValue] = React.useState('')
  const debouncedSearch = useDebounced(searchValue, 300)
  const [results, setResults] = React.useState<PosVariantRow[]>([])
  const [searching, setSearching] = React.useState(false)

  const [customerOpen, setCustomerOpen] = React.useState(false)
  const [checkoutOpen, setCheckoutOpen] = React.useState(false)
  const [heldOpen, setHeldOpen] = React.useState(false)
  const [qrOpen, setQrOpen] = React.useState(false)
  const [selectedRow, setSelectedRow] = React.useState<number | null>(null)

  const scanRef = React.useRef<HTMLInputElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  const [locationId, setLocationId] = React.useState<string>('')

  // ---- permissions for gated UI -------------------------------------------
  const canEditPrice = React.useMemo(
    () => (config?.pos.allow_price_edit ?? false) && hasPermission('override_sale_price'),
    [config, hasPermission]
  )
  const canDiscount = React.useMemo(
    () => hasPermission('apply_discount') || profile?.role === 'admin',
    [hasPermission, profile]
  )
  const discountCap = React.useMemo(() => {
    if (!config || !profile) return 0
    return effectiveDiscountCap(
      profile.role,
      Number(config.pos.max_item_discount_pct ?? 10),
      profile.pos_discount_limit_pct ?? null
    )
  }, [config, profile])
  const allowNegative = config?.inventory.allow_negative_stock === true

  // ---- load POS config -----------------------------------------------------
  React.useEffect(() => {
    let cancelled = false
    const run = async () => {
      const { data, error } = await supabase.rpc('get_pos_config')
      if (cancelled) return
      if (error) {
        logError('pos:config', error)
        setConfigError(
          isTableMissing(error)
            ? 'The POS database is not set up yet — apply migration 0008 first.'
            : 'Could not load the POS configuration.'
        )
        return
      }
      const cfg = data as unknown as PosConfig
      setConfig(cfg)
      if (cfg.locations?.length) {
        const store = cfg.locations.find((l) => l.location_type === 'store') ?? cfg.locations[0]
        setLocationId(store.id)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [supabase])

  // ---- cart recovery (sessionStorage: recovery only, never authoritative) --
  React.useEffect(() => {
    try {
      const raw = sessionStorage.getItem(CART_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as StoredCart
        if (Array.isArray(parsed.items)) setCart(parsed.items)
        if (parsed.customerId) {
          setCustomer({
            id: parsed.customerId,
            name: parsed.customerName ?? 'Customer',
            phone: parsed.customerPhone ?? null,
            state: parsed.customerState ?? null,
            gstin: null,
          })
        }
        setBillDiscountType(parsed.billDiscountType ?? 'pct')
        setBillDiscountValue(parsed.billDiscountValue ?? 0)
        setNotes(parsed.notes ?? '')
      }
    } catch {
      // corrupted storage is simply ignored
    }
  }, [])

  React.useEffect(() => {
    if (lastSale) return
    const stored: StoredCart = {
      items: cart,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? null,
      customerPhone: customer?.phone ?? null,
      customerState: customer?.state ?? null,
      billDiscountType,
      billDiscountValue,
      notes,
    }
    try {
      sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(stored))
    } catch {
      // storage full — cart stays in memory
    }
  }, [cart, customer, billDiscountType, billDiscountValue, notes, lastSale])

  // ---- search ---------------------------------------------------------------
  React.useEffect(() => {
    if (!config) return
    let cancelled = false
    const q = debouncedSearch.trim()
    if (!q) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const run = async () => {
      const { data, error } = await supabase.rpc('pos_search', { p_query: q, p_limit: 12 })
      if (cancelled) return
      if (error) {
        logError('pos:search', error)
        setResults([])
      } else {
        setResults(((data as unknown as { rows: PosVariantRow[] })?.rows ?? []) as PosVariantRow[])
      }
      setSearching(false)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, config, supabase])

  // ---- cart operations -------------------------------------------------------
  const addToCart = React.useCallback(
    (row: PosVariantRow, qty = 1) => {
      if (!row.variant_active || !row.product_active) {
        toast.error('Item unavailable', { description: `${row.product_name} (${row.sku}) is deactivated.` })
        return
      }
      if (row.selling_price == null) {
        toast.error('No price set', { description: `${row.product_name} (${row.sku}) has no selling price.` })
        return
      }
      setCart((prev) => {
        const existing = prev.findIndex((i) => i.variant_id === row.variant_id)
        if (existing >= 0) {
          // duplicate scan -> increment quantity
          const next = [...prev]
          const available = row.total_available
          const newQty = next[existing].quantity + qty
          if (!allowNegative && newQty > available) {
            toast.error('Not enough stock', {
              description: `Only ${available} available for ${row.product_name} (${row.sku}).`,
            })
            return prev
          }
          next[existing] = { ...next[existing], quantity: newQty, available }
          return next
        }
        const available = row.total_available
        if (!allowNegative && qty > available) {
          toast.error('Not enough stock', {
            description: `Only ${available} available for ${row.product_name} (${row.sku}).`,
          })
          return prev
        }
        return [
          ...prev,
          {
            variant_id: row.variant_id,
            product_id: row.product_id,
            product_name: row.product_name,
            product_code: row.product_code,
            sku: row.sku,
            size_name: row.size_name,
            color_name: row.color_name,
            hsn_code: row.hsn_code,
            gst_rate: Number(row.gst_rate ?? 0),
            mrp: row.mrp,
            base_price: Number(row.selling_price),
            unit_price: Number(row.selling_price),
            price_overridden: false,
            quantity: qty,
            discount_type: 'pct',
            discount_value: 0,
            available,
          },
        ]
      })
    },
    [allowNegative]
  )

  const resolveAndAdd = React.useCallback(
    async (value: string) => {
      const v = value.trim()
      if (!v) return
      setScanning(true)
      try {
        const { data, error } = await supabase.rpc('find_variant_by_identifier', { p_value: v })
        if (error) {
          logError('pos:scan', error)
          toast.error('Lookup failed', { description: 'Could not search for the scanned item.' })
          return
        }
        const found = data as unknown as PosVariantRow | null
        if (!found) {
          toast.error('Not found', { description: `No product matches "${v}".` })
          return
        }
        addToCart(found)
      } catch (err) {
        logError('pos:scan', err)
        toast.error('Network error — the item was not added.')
      } finally {
        setScanning(false)
        setScanValue('')
        scanRef.current?.focus()
      }
    },
    [supabase, addToCart]
  )

  const updateQty = React.useCallback(
    (index: number, qty: number) => {
      setCart((prev) => {
        const next = [...prev]
        const item = next[index]
        if (!item) return prev
        if (!Number.isFinite(qty) || qty < 1) return prev
        if (!allowNegative && qty > item.available) {
          toast.error('Not enough stock', {
            description: `Only ${item.available} available for ${item.product_name} (${item.sku}).`,
          })
          return prev
        }
        next[index] = { ...item, quantity: Math.floor(qty) }
        return next
      })
    },
    [allowNegative]
  )

  const updatePrice = React.useCallback((index: number, price: number) => {
    if (!Number.isFinite(price) || price < 0) return
    setCart((prev) => {
      const next = [...prev]
      const item = next[index]
      if (!item) return prev
      next[index] = {
        ...item,
        unit_price: round2(price),
        price_overridden: round2(price) !== item.base_price,
      }
      return next
    })
  }, [])

  const updateItemDiscount = React.useCallback(
    (index: number, type: 'pct' | 'fixed', value: number) => {
      if (!Number.isFinite(value) || value < 0) return
      if (type === 'pct' && discountCap != null && value > discountCap) {
        toast.error('Discount limit', {
          description: `You can apply at most ${discountCap}% discount.`,
        })
        return
      }
      setCart((prev) => {
        const next = [...prev]
        const item = next[index]
        if (!item) return prev
        next[index] = { ...item, discount_type: type, discount_value: round2(value) }
        return next
      })
    },
    [discountCap]
  )

  const removeItem = React.useCallback((index: number) => {
    setCart((prev) => prev.filter((_, i) => i !== index))
    setSelectedRow(null)
  }, [])

  const clearCart = React.useCallback(
    (confirmed = false) => {
      if (!confirmed && cart.length > 0) {
        toast('Clear the cart?', {
          description: 'All items will be removed. Press Clear again to confirm.',
          action: { label: 'Clear', onClick: () => clearCart(true) },
        })
        return
      }
      setCart([])
      setCustomer(null)
      setBillDiscountType('pct')
      setBillDiscountValue(0)
      setNotes('')
      setSelectedRow(null)
    },
    [cart.length]
  )

  // ---- held bills -------------------------------------------------------------
  const holdBill = React.useCallback(async () => {
    if (cart.length === 0) {
      toast.error('Nothing to hold — the cart is empty.')
      return
    }
    const heldCart: HeldCart = {
      items: cart.map((i) => ({
        variant_id: i.variant_id,
        quantity: i.quantity,
        discount_type: i.discount_type,
        discount_value: i.discount_value,
        unit_price: i.price_overridden ? i.unit_price : null,
      })),
      customer_id: customer?.id ?? null,
      bill_discount_type: billDiscountType,
      bill_discount_value: billDiscountValue,
      notes: notes.trim() || null,
    }
    const bill = computeBill(cart, taxMode, billDiscountType, billDiscountValue, roundOff, taxEnabled)
    try {
      const res = await fetch('/api/pos/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cart: heldCart,
          label: customer ? customer.name : `Held ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`,
          customer_name: customer?.name ?? null,
          item_count: cart.length,
          total: bill.grandTotal,
        }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        toast.error('Could not hold the bill', { description: body?.error ?? 'The cart is unchanged.' })
        return
      }
      toast.success('Bill held', { description: 'Stock is not affected. Resume it from Held bills.' })
      clearCart(true)
    } catch (err) {
      logError('pos:hold', err)
      toast.error('Network error — the bill was not held.')
    }
  }, [cart, customer, billDiscountType, billDiscountValue, notes, clearCart])

  const resumeCart = React.useCallback(
    async (held: HeldCart) => {
      // re-resolve every variant so prices/stock are fresh; drop stale lines
      const resolved: CartItem[] = []
      for (const line of held.items ?? []) {
        const { data } = await supabase.rpc('find_variant_by_identifier', { p_value: line.variant_id })
        const found = data as unknown as PosVariantRow | null
        if (!found || !found.variant_active || !found.product_active || found.selling_price == null) {
          toast.warning('One held item is no longer available', {
            description: `A line was skipped (variant removed or deactivated).`,
          })
          continue
        }
        resolved.push({
          variant_id: found.variant_id,
          product_id: found.product_id,
          product_name: found.product_name,
          product_code: found.product_code,
          sku: found.sku,
          size_name: found.size_name,
          color_name: found.color_name,
          hsn_code: found.hsn_code,
          gst_rate: Number(found.gst_rate ?? 0),
          mrp: found.mrp,
          base_price: Number(found.selling_price),
          unit_price: line.unit_price != null ? Number(line.unit_price) : Number(found.selling_price),
          price_overridden: line.unit_price != null && Number(line.unit_price) !== Number(found.selling_price),
          quantity: Math.max(1, line.quantity),
          discount_type: line.discount_type ?? 'pct',
          discount_value: line.discount_value ?? 0,
          available: found.total_available,
        })
      }
      setCart(resolved)
      setBillDiscountType(held.bill_discount_type ?? 'pct')
      setBillDiscountValue(held.bill_discount_value ?? 0)
      setNotes(held.notes ?? '')
      if (held.customer_id) {
        const { data } = await supabase
          .from('customers')
          .select('id, name, phone, state, gstin')
          .eq('id', held.customer_id)
          .maybeSingle()
        if (data) setCustomer(data as PosCustomer)
      }
      toast.success('Held bill resumed', { description: `${resolved.length} line(s) restored.` })
    },
    [supabase]
  )

  // ---- totals ------------------------------------------------------------------
  const taxMode = (config?.pos.default_tax_mode === 'exclusive' ? 'exclusive' : 'inclusive') as 'inclusive' | 'exclusive'
  const taxEnabled = config?.tax.enabled !== false
  const roundOff = config?.pos.round_off !== false
  const bill = React.useMemo(
    () => computeBill(cart, taxMode, billDiscountType, billDiscountValue, roundOff, taxEnabled),
    [cart, taxMode, billDiscountType, billDiscountValue, roundOff, taxEnabled]
  )

  const requireCustomer = config?.pos.require_customer === true

  // ---- keyboard shortcuts --------------------------------------------------------
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'F4') {
        e.preventDefault()
        setCustomerOpen(true)
      } else if (e.key === 'F8') {
        e.preventDefault()
        if (cart.length > 0) setCheckoutOpen(true)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRow != null) {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
        e.preventDefault()
        removeItem(selectedRow)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cart.length, selectedRow, removeItem])

  // ---- render -----------------------------------------------------------------
  if (configError) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 rounded-lg border bg-card p-8 text-center">
        <TriangleAlert className="size-10 text-destructive" aria-hidden="true" />
        <h2 className="text-lg font-semibold">POS unavailable</h2>
        <p className="max-w-md text-sm text-muted-foreground">{configError}</p>
      </div>
    )
  }

  if (lastSale) {
    return (
      <SaleSuccess
        sale={lastSale}
        onNewSale={() => {
          setLastSale(null)
          clearCart(true)
          sessionStorage.removeItem(CART_STORAGE_KEY)
          requestAnimationFrame(() => scanRef.current?.focus())
        }}
      />
    )
  }

  if (!config) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-72 w-full" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  const billDiscountCap = effectiveDiscountCap(
    profile?.role ?? '',
    Number(config.pos.max_bill_discount_pct ?? 10),
    profile?.pos_discount_limit_pct ?? null
  )

  return (
    <div className="space-y-4 pb-4">
      {/* header row: scanner-first */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <h1 className="text-xl font-semibold tracking-tight">Point of sale</h1>
        <div className="flex flex-1 items-center gap-2 sm:justify-end">
          <Button variant="outline" size="sm" onClick={() => setHeldOpen(true)}>
            <Pause className="size-4" aria-hidden="true" />
            Held bills
          </Button>
          <Button variant="outline" size="sm" onClick={() => setQrOpen(true)}>
            <QrCode className="size-4" aria-hidden="true" />
            Scan QR
          </Button>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* LEFT: scanner + search + cart */}
        <div className="min-w-0 space-y-4">
          {/* scanner input */}
          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <label htmlFor="pos-scanner" className="flex items-center gap-2 text-sm font-medium">
              <ScanBarcode className="size-4 text-muted-foreground" aria-hidden="true" />
              Scanner input
              {scanning ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
            </label>
            <Input
              id="pos-scanner"
              ref={scanRef}
              autoFocus
              value={scanValue}
              onChange={(e) => setScanValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void resolveAndAdd(scanValue)
                }
              }}
              placeholder="Scan a barcode or type a SKU / QR / product code and press Enter…"
              className="mt-2 h-11 font-mono text-base"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              USB/Bluetooth scanners type the code and press Enter automatically. Repeated scans increase the quantity.
            </p>
          </div>

          {/* product search */}
          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <label htmlFor="pos-search" className="flex items-center gap-2 text-sm font-medium">
              <Search className="size-4 text-muted-foreground" aria-hidden="true" />
              Product search
              <kbd className="ml-1 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">F2</kbd>
            </label>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="pos-search"
                ref={searchRef}
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && results.length > 0) {
                    e.preventDefault()
                    addToCart(results[0])
                    setSearchValue('')
                    setResults([])
                    scanRef.current?.focus()
                  }
                }}
                placeholder="Search by name, product code, SKU, barcode or QR…"
                className="h-11 pl-9"
                type="search"
                aria-label="Search products for the POS"
              />
            </div>
            {searching ? (
              <div className="mt-2 space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : results.length > 0 ? (
              <ul className="thin-scrollbar mt-2 max-h-64 divide-y overflow-y-auto rounded-md border" role="listbox" aria-label="Product search results">
                {results.map((row) => {
                  const out = row.total_available <= 0 && !allowNegative
                  return (
                    <li key={row.variant_id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        disabled={out}
                        onClick={() => {
                          addToCart(row)
                          setSearchValue('')
                          setResults([])
                          scanRef.current?.focus()
                        }}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{row.product_name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {[row.color_name, row.size_name].filter(Boolean).join(' / ') || 'Default'} · {row.sku}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block tabular-nums font-medium">{formatMoney(row.selling_price)}</span>
                          <span className={`block text-xs tabular-nums ${row.total_available <= 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {out ? 'Out of stock' : `${row.total_available} in stock`}
                          </span>
                        </span>
                        <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : debouncedSearch.trim() ? (
              <p className="mt-2 text-xs text-muted-foreground">No matching products.</p>
            ) : null}
          </div>

          {/* cart */}
          <div className="rounded-lg border bg-card shadow-xs">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                <ShoppingCart className="size-4 text-muted-foreground" aria-hidden="true" />
                Cart
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                  {cart.length} line{cart.length === 1 ? '' : 's'}
                </span>
              </h2>
              {cart.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => clearCart()} aria-label="Clear the cart">
                  <Trash2 className="size-4" aria-hidden="true" />
                  Clear
                </Button>
              ) : null}
            </div>

            {cart.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <ShoppingCart className="mx-auto size-8 text-muted-foreground/60" aria-hidden="true" />
                <p className="mt-2 text-sm text-muted-foreground">
                  Scan an item or search for products to start billing.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2 font-medium">Item</th>
                      <th scope="col" className="px-2 py-2 font-medium">Qty</th>
                      <th scope="col" className="px-2 py-2 font-medium">Price</th>
                      {canDiscount ? <th scope="col" className="px-2 py-2 font-medium">Disc</th> : null}
                      <th scope="col" className="px-2 py-2 text-right font-medium">Total</th>
                      <th scope="col" className="px-2 py-2 font-medium sr-only">Remove</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {cart.map((item, index) => {
                      const line = computeLine(item, taxMode, taxEnabled)
                      const isSelected = selectedRow === index
                      return (
                        <tr
                          key={item.variant_id}
                          className={isSelected ? 'bg-accent/60' : undefined}
                          onClick={() => setSelectedRow(index)}
                        >
                          <td className="px-3 py-2">
                            <p className="max-w-[220px] truncate font-medium sm:max-w-xs">{item.product_name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {[item.color_name, item.size_name].filter(Boolean).join(' / ') || 'Default'} · {item.sku}
                              {item.price_overridden ? ' · price edited' : ''}
                            </p>
                            {!allowNegative && item.quantity >= item.available ? (
                              <p className="text-xs text-destructive">Only {item.available} in stock</p>
                            ) : null}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="icon" className="size-7" onClick={() => updateQty(index, item.quantity - 1)} disabled={item.quantity <= 1} aria-label={`Decrease quantity of ${item.sku}`}>
                                <Minus className="size-3.5" aria-hidden="true" />
                              </Button>
                              <Input
                                type="number"
                                min={1}
                                value={item.quantity}
                                onChange={(e) => updateQty(index, Number(e.target.value))}
                                className="h-8 w-14 tabular-nums"
                                aria-label={`Quantity of ${item.sku}`}
                              />
                              <Button variant="ghost" size="icon" className="size-7" onClick={() => updateQty(index, item.quantity + 1)} aria-label={`Increase quantity of ${item.sku}`}>
                                <Plus className="size-3.5" aria-hidden="true" />
                              </Button>
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            {canEditPrice ? (
                              <Input
                                type="number"
                                min={0}
                                step="0.01"
                                value={item.unit_price}
                                onChange={(e) => updatePrice(index, Number(e.target.value))}
                                className="h-8 w-20 tabular-nums"
                                aria-label={`Unit price of ${item.sku}`}
                              />
                            ) : (
                              <span className="tabular-nums">{formatMoney(item.unit_price)}</span>
                            )}
                          </td>
                          {canDiscount ? (
                            <td className="px-2 py-2">
                              <div className="flex items-center gap-1">
                                <Input
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  value={item.discount_value || ''}
                                  placeholder="0"
                                  onChange={(e) => updateItemDiscount(index, item.discount_type, Number(e.target.value))}
                                  className="h-8 w-16 tabular-nums"
                                  aria-label={`Discount for ${item.sku}`}
                                />
                                <Select
                                  value={item.discount_type}
                                  onValueChange={(v) => {
                                    setCart((prev) => {
                                      const next = [...prev]
                                      next[index] = { ...next[index], discount_type: v as 'pct' | 'fixed' }
                                      return next
                                    })
                                  }}
                                >
                                  <SelectTrigger className="h-8 w-[64px]" aria-label={`Discount type for ${item.sku}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="pct">%</SelectItem>
                                    <SelectItem value="fixed">₹</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </td>
                          ) : null}
                          <td className="px-2 py-2 text-right tabular-nums">
                            {formatMoney(line.lineTotal)}
                            {line.discountAmount > 0 ? (
                              <p className="text-xs text-muted-foreground">− {formatMoney(line.discountAmount)}</p>
                            ) : null}
                          </td>
                          <td className="px-2 py-2">
                            <Button variant="ghost" size="icon" className="size-7" onClick={() => removeItem(index)} aria-label={`Remove ${item.sku}`}>
                              <X className="size-3.5" aria-hidden="true" />
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* shortcuts help */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Keyboard className="size-3.5" aria-hidden="true" /> Shortcuts:</span>
            <span><kbd className="rounded border bg-muted px-1 font-mono">F2</kbd> search</span>
            <span><kbd className="rounded border bg-muted px-1 font-mono">F4</kbd> customer</span>
            <span><kbd className="rounded border bg-muted px-1 font-mono">F8</kbd> checkout</span>
            <span><kbd className="rounded border bg-muted px-1 font-mono">Del</kbd> remove selected row</span>
            <span><kbd className="rounded border bg-muted px-1 font-mono">Esc</kbd> close dialogs</span>
          </div>
        </div>

        {/* RIGHT: customer, totals, actions */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <UserRound className="size-4 text-muted-foreground" aria-hidden="true" />
              Customer
              {requireCustomer ? <span className="text-xs text-destructive">required</span> : <span className="text-xs text-muted-foreground">optional</span>}
            </h2>
            {customer ? (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{customer.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{customer.phone ?? 'No phone'}</p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setCustomer(null)} aria-label="Remove customer">
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <Button variant="outline" className="mt-2 w-full" onClick={() => setCustomerOpen(true)}>
                <UserRound className="size-4" aria-hidden="true" />
                Select customer
                <kbd className="ml-1 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">F4</kbd>
              </Button>
            )}

            {config.locations.length > 1 ? (
              <div className="mt-3">
                <label htmlFor="pos-location" className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Layers className="size-3.5" aria-hidden="true" />
                  Stock location
                </label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger id="pos-location" className="mt-1" aria-label="Stock location">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {config.locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name} ({l.location_type === 'store' ? 'store' : 'warehouse'})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {canDiscount ? (
            <div className="rounded-lg border bg-card p-4 shadow-xs">
              <h2 className="text-sm font-medium">Bill discount</h2>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={billDiscountValue || ''}
                  placeholder="0"
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (billDiscountType === 'pct' && billDiscountCap != null && v > billDiscountCap) {
                      toast.error('Discount limit', { description: `You can apply at most ${billDiscountCap}% bill discount.` })
                      setBillDiscountValue(billDiscountCap)
                      return
                    }
                    setBillDiscountValue(Number.isFinite(v) && v > 0 ? round2(v) : 0)
                  }}
                  className="h-9 tabular-nums"
                  aria-label="Bill discount value"
                />
                <Select value={billDiscountType} onValueChange={(v) => setBillDiscountType(v as 'pct' | 'fixed')}>
                  <SelectTrigger className="w-[72px]" aria-label="Bill discount type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pct">%</SelectItem>
                    <SelectItem value="fixed">₹</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {billDiscountCap != null ? (
                <p className="mt-1 text-xs text-muted-foreground">Your limit: up to {billDiscountCap}%.</p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2 rounded-lg border bg-card p-4 shadow-xs">
            <h2 className="text-sm font-medium">Bill summary</h2>
            <div className="space-y-1.5 text-sm">
              <Row label="Subtotal" value={formatMoney(bill.subtotal + bill.itemDiscountTotal)} />
              {bill.itemDiscountTotal > 0 ? <Row label="Item discounts" value={`− ${formatMoney(bill.itemDiscountTotal)}`} /> : null}
              {bill.billDiscountAmount > 0 ? <Row label="Bill discount" value={`− ${formatMoney(bill.billDiscountAmount)}`} /> : null}
              {bill.taxTotal > 0 ? (
                <Row label={`GST ${taxMode === 'inclusive' ? '(included)' : '(added)'}`} value={formatMoney(bill.taxTotal)} />
              ) : null}
              {bill.roundOff !== 0 ? (
                <Row label="Round off" value={`${bill.roundOff > 0 ? '+' : '−'} ${formatMoney(Math.abs(bill.roundOff))}`} />
              ) : null}
              <div className="flex items-center justify-between border-t pt-2 text-base font-semibold">
                <span>Grand total</span>
                <span className="tabular-nums">{formatMoney(bill.grandTotal)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {cart.reduce((s, i) => s + i.quantity, 0)} item{cart.reduce((s, i) => s + i.quantity, 0) === 1 ? '' : 's'} · tax mode: {taxMode}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Button
              size="lg"
              className="h-12 w-full text-base"
              disabled={cart.length === 0 || (requireCustomer && !customer)}
              onClick={() => setCheckoutOpen(true)}
            >
              <ShoppingCart className="size-5" aria-hidden="true" />
              Checkout
              <kbd className="ml-1 rounded border bg-background/20 px-1.5 py-0.5 text-[10px] font-mono">F8</kbd>
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => void holdBill()} disabled={cart.length === 0}>
                <Pause className="size-4" aria-hidden="true" />
                Hold bill
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => clearCart()} disabled={cart.length === 0}>
                <Trash2 className="size-4" aria-hidden="true" />
                Clear
              </Button>
            </div>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Bill note (optional, printed on the invoice)"
              className="mt-1"
              maxLength={200}
              aria-label="Bill note"
            />
          </div>
        </div>
      </div>

      <CustomerDialog
        open={customerOpen}
        onOpenChange={setCustomerOpen}
        selected={customer}
        onSelect={setCustomer}
        canCreate={hasPermission('manage_customers')}
      />
      <CheckoutDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        items={cart}
        summary={bill}
        customer={customer}
        config={config}
        locationName={config.locations.find((l) => l.id === locationId)?.name ?? null}
        notes={notes}
        onCompleted={(sale) => {
          setLastSale(sale)
          sessionStorage.removeItem(CART_STORAGE_KEY)
        }}
      />
      <HeldBillsDialog open={heldOpen} onOpenChange={setHeldOpen} onResume={(cartData) => void resumeCart(cartData)} />
      <QrScanDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        onIdentifier={(value) => {
          setQrOpen(false)
          void resolveAndAdd(value)
        }}
      />
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export type { PaymentDraft }
