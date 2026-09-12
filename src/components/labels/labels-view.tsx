'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Minus, Plus, Printer, Search, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useApp } from '@/components/providers/app-provider'
import { isTableMissing, logError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { BarcodeSvg } from '@/components/shared/barcode-svg'
import { QrCodeSvg } from '@/components/shared/qr-code'
import { Phase2SetupNotice } from '@/components/shared/phase2-setup-notice'
import { EmptyState } from '@/components/shared/empty-state'
import { LABEL_TEMPLATES, formatMoney, useDebounced } from '@/lib/catalog/constants'
import type { StockPageResult, StockPageRow } from '@/types/database'

interface Selection {
  variant_id: string
  product_name: string
  sku: string
  barcode: string | null
  qr_identifier: string | null
  size_name: string | null
  color_name: string | null
  selling_price: number | null
  mrp: number | null
  quantity: number
}

/** Shape returned by the identifier resolver / id lookup for preselection. */
interface PreselectVariant {
  variant_id: string
  product_name: string
  sku: string
  barcode: string | null
  qr_identifier: string | null
  size_name: string | null
  color_name: string | null
  selling_price: number | null
  mrp: number | null
}

/**
 * Barcode label printing. Pick variants (search the live stock database),
 * set per-variant quantities, choose a label template and print via the
 * browser — printer-model independent. Layout is sized in millimetres so any
 * retail label stock works.
 */
export function LabelsView() {
  const supabase = React.useMemo(() => createClient(), [])
  const searchParams = useSearchParams()
  const { settings, companyName, hasPermission } = useApp()
  const canPrint = hasPermission('manage_products')

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search, 300)
  const [results, setResults] = React.useState<StockPageRow[]>([])
  const [searching, setSearching] = React.useState(false)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [selections, setSelections] = React.useState<Selection[]>([])
  const [template, setTemplate] = React.useState(settings.barcode?.print_size ?? '50x25')
  const [showQr, setShowQr] = React.useState(settings.qr?.enabled ?? true)
  const [priceMode, setPriceMode] = React.useState<'mrp' | 'selling' | 'none'>('selling')
  const [showCompany, setShowCompany] = React.useState(true)
  const [showSizeColor, setShowSizeColor] = React.useState(true)
  const [printing, setPrinting] = React.useState(false)

  // preselect a variant via ?variant=<id> (deep link from product pages).
  // Deep links carry the variant UUID; the identifier resolver only matches
  // barcode/QR/SKU — try the resolver first, then fall back to a direct id
  // lookup so product-page deep links actually preselect the variant.
  const preselect = searchParams.get('variant')
  React.useEffect(() => {
    if (!preselect || selections.some((s) => s.variant_id === preselect)) return
    let cancelled = false

    const resolve = async () => {
      const { data, error } = await supabase.rpc('find_variant_by_identifier', { p_value: preselect })
      if (cancelled) return null
      if (!error && data) return data as unknown as PreselectVariant
      // not resolvable as an identifier — resolve as a variant id instead
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(preselect)) return null
      const { data: row, error: idError } = await supabase
        .from('product_variants')
        .select('id, sku, barcode, qr_identifier, selling_price, mrp, products(name, mrp), sizes(name), colors(name)')
        .eq('id', preselect)
        .maybeSingle()
      if (cancelled || idError || !row) return null
      const r = row as unknown as {
        id: string
        sku: string
        barcode: string | null
        qr_identifier: string | null
        selling_price: number | null
        mrp: number | null
        products: { name: string | null; mrp: number | null } | null
        sizes: { name: string | null } | null
        colors: { name: string | null } | null
      }
      return {
        variant_id: r.id,
        sku: r.sku,
        barcode: r.barcode,
        qr_identifier: r.qr_identifier,
        size_name: r.sizes?.name ?? null,
        color_name: r.colors?.name ?? null,
        selling_price: r.selling_price,
        mrp: r.mrp ?? r.products?.mrp ?? null,
        product_name: r.products?.name ?? '',
      } as PreselectVariant
    }

    // preselect is best-effort; manual search always works
    resolve()
      .then((v) => {
        if (cancelled || !v) return
        setSelections((prev) =>
          prev.some((s) => s.variant_id === v.variant_id)
            ? prev
            : [
                ...prev,
                {
                  variant_id: v.variant_id,
                  product_name: v.product_name,
                  sku: v.sku,
                  barcode: v.barcode,
                  qr_identifier: v.qr_identifier,
                  size_name: v.size_name,
                  color_name: v.color_name,
                  selling_price: v.selling_price,
                  mrp: v.mrp,
                  quantity: 1,
                },
              ]
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [preselect, selections, supabase])

  // variant search (database-side, bounded)
  React.useEffect(() => {
    if (!debouncedSearch.trim()) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    supabase
      .rpc('stock_page', { p_search: debouncedSearch.trim(), p_limit: 10, p_offset: 0 })
      .then(({ data, error }) => {
        if (cancelled) return
        setSearching(false)
        if (error) {
          if (isTableMissing(error)) setSetupNeeded(true)
          else logError('labels:search', error)
          return
        }
        const result = (data ?? { rows: [] }) as unknown as StockPageResult
        setResults(result.rows ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [supabase, debouncedSearch])

  const addSelection = (row: StockPageRow) => {
    setSelections((prev) => {
      if (prev.some((s) => s.variant_id === row.variant_id)) {
        return prev.map((s) => (s.variant_id === row.variant_id ? { ...s, quantity: s.quantity + 1 } : s))
      }
      return [
        ...prev,
        {
          variant_id: row.variant_id,
          product_name: row.product_name,
          sku: row.sku,
          barcode: row.barcode,
          qr_identifier: row.qr_identifier,
          size_name: row.size_name,
          color_name: row.color_name,
          selling_price: row.selling_price,
          mrp: row.mrp,
          quantity: 1,
        },
      ]
    })
  }

  const updateQuantity = (variantId: string, delta: number) => {
    setSelections((prev) =>
      prev.map((s) =>
        s.variant_id === variantId ? { ...s, quantity: Math.min(500, Math.max(1, s.quantity + delta)) } : s
      )
    )
  }

  const removeSelection = (variantId: string) => {
    setSelections((prev) => prev.filter((s) => s.variant_id !== variantId))
  }

  const totalLabels = selections.reduce((sum, s) => sum + s.quantity, 0)
  const tmpl = LABEL_TEMPLATES[template] ?? LABEL_TEMPLATES['50x25']

  async function handlePrint() {
    setPrinting(true)
    // audit trail (best effort)
    try {
      await fetch('/api/admin/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: selections.map((s) => ({ variant_id: s.variant_id, quantity: s.quantity })),
          template,
        }),
      })
    } catch (err) {
      logError('labels:audit', err)
    }
    try {
      window.print()
    } finally {
      setPrinting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Screen-only controls */}
      <div className="print:hidden space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Print labels</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Barcode + QR labels for variants — sized in millimetres for retail label stock, printed
              through the browser.
            </p>
          </div>
          <Button size="sm" onClick={() => void handlePrint()} disabled={printing || selections.length === 0 || !canPrint}>
            <Printer className="size-4" aria-hidden="true" />
            Print {totalLabels > 0 ? `${totalLabels} label${totalLabels === 1 ? '' : 's'}` : ''}
          </Button>
        </div>

        {setupNeeded ? <Phase2SetupNotice /> : null}

        {/* Variant picker */}
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-xs">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search variants by product, SKU, barcode or QR…"
              className="pl-9"
              type="search"
              aria-label="Search variants for labels"
            />
          </div>
          {searching ? (
            <p className="text-xs text-muted-foreground">Searching…</p>
          ) : results.length > 0 ? (
            <ul className="thin-scrollbar max-h-64 divide-y overflow-y-auto rounded-md border">
              {results.map((row) => (
                <li key={row.balance_id}>
                  <button
                    type="button"
                    onClick={() => addSelection(row)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{row.product_name}</span>
                      <span className="ml-2 text-muted-foreground">
                        {[row.color_name, row.size_name].filter(Boolean).join(' / ') || 'Default'}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.sku}</span>
                    <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : debouncedSearch.trim() ? (
            <p className="text-xs text-muted-foreground">No matching variants.</p>
          ) : null}
        </div>

        {/* Selections */}
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-xs">
          <h2 className="text-sm font-medium text-foreground">
            Selected variants <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{selections.length}</span>
          </h2>
          {selections.length === 0 ? (
            <EmptyState
              icon={<Printer />}
              title="Nothing selected"
              description="Search above and add variants, or use “Print labels” on a product page."
            />
          ) : (
            <ul className="divide-y">
              {selections.map((s) => (
                <li key={s.variant_id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{s.product_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[s.color_name, s.size_name].filter(Boolean).join(' / ') || 'Default'} · {s.sku}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => updateQuantity(s.variant_id, -1)} aria-label={`Fewer labels for ${s.sku}`}>
                      <Minus className="size-4" aria-hidden="true" />
                    </Button>
                    <Input
                      className="h-8 w-14 text-center tabular-nums"
                      inputMode="numeric"
                      value={s.quantity}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (Number.isInteger(v) && v >= 1 && v <= 500) {
                          setSelections((prev) => prev.map((x) => (x.variant_id === s.variant_id ? { ...x, quantity: v } : x)))
                        }
                      }}
                      aria-label={`Label quantity for ${s.sku}`}
                    />
                    <Button variant="outline" size="sm" onClick={() => updateQuantity(s.variant_id, 1)} aria-label={`More labels for ${s.sku}`}>
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => removeSelection(s.variant_id)} aria-label={`Remove ${s.sku}`}>
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Label options */}
        <div className="grid gap-4 rounded-lg border bg-card p-4 shadow-xs sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="label-template">Label size</Label>
            <Select value={template} onValueChange={setTemplate}>
              <SelectTrigger id="label-template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(LABEL_TEMPLATES).map(([key, t]) => (
                  <SelectItem key={key} value={key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">Default from Settings → Barcode.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="label-price">Price on label</Label>
            <Select value={priceMode} onValueChange={(v) => setPriceMode(v as typeof priceMode)}>
              <SelectTrigger id="label-price">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="selling">Selling price</SelectItem>
                <SelectItem value="mrp">MRP</SelectItem>
                <SelectItem value="none">No price</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3 pt-1">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={showQr} onCheckedChange={(v) => setShowQr(Boolean(v))} id="label-qr" />
              Include QR code
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={showCompany} onCheckedChange={(v) => setShowCompany(Boolean(v))} id="label-company" />
              Company name
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={showSizeColor} onCheckedChange={(v) => setShowSizeColor(Boolean(v))} id="label-size" />
              Size &amp; color
            </label>
          </div>
        </div>
      </div>

      {/* Printable sheet */}
      {selections.length > 0 ? (
        <div className="print-area rounded-lg border bg-white p-4 text-black">
          <p className="mb-3 text-xs text-neutral-500 print:hidden">
            Preview — the sheet below is what prints ({totalLabels} label{totalLabels === 1 ? '' : 's'},{' '}
            {tmpl.widthMm} × {tmpl.heightMm} mm each).
          </p>
          <div
            className="flex flex-wrap gap-1"
            style={{ ['--label-w' as string]: `${tmpl.widthMm}mm`, ['--label-h' as string]: `${tmpl.heightMm}mm` }}
          >
            {selections.flatMap((s) =>
              Array.from({ length: s.quantity }, (_, i) => (
                <LabelCard
                  key={`${s.variant_id}-${i}`}
                  selection={s}
                  showQr={showQr}
                  showCompany={showCompany}
                  showSizeColor={showSizeColor}
                  priceMode={priceMode}
                  companyName={companyName}
                  widthMm={tmpl.widthMm}
                  heightMm={tmpl.heightMm}
                />
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LabelCard({
  selection,
  showQr,
  showCompany,
  showSizeColor,
  priceMode,
  companyName,
  widthMm,
  heightMm,
}: {
  selection: Selection
  showQr: boolean
  showCompany: boolean
  showSizeColor: boolean
  priceMode: 'mrp' | 'selling' | 'none'
  companyName: string
  widthMm: number
  heightMm: number
}) {
  const price = priceMode === 'mrp' ? selection.mrp : priceMode === 'selling' ? selection.selling_price : null
  const variantLabel = [selection.color_name, selection.size_name].filter(Boolean).join(' / ')
  return (
    <div
      className="label-card flex items-center gap-[1.5mm] overflow-hidden border border-neutral-200 bg-white p-[1.5mm]"
      style={{ width: `${widthMm}mm`, height: `${heightMm}mm`, breakInside: 'avoid', pageBreakInside: 'avoid' }}
    >
      <div className="min-w-0 flex-1">
        {showCompany ? <p className="truncate text-[6pt] font-semibold leading-[1.1] text-black">{companyName}</p> : null}
        <p className="truncate text-[6.5pt] font-medium leading-[1.15] text-black">{selection.product_name}</p>
        {showSizeColor && variantLabel ? (
          <p className="truncate text-[5.5pt] leading-[1.1] text-neutral-700">{variantLabel}</p>
        ) : null}
        <div className="mt-[0.5mm]">
          <BarcodeSvg value={selection.barcode} sku={selection.sku} height={heightMm >= 50 ? 38 : 22} width={1} displayValue={false} />
        </div>
        <div className="flex items-baseline justify-between gap-1">
          <p className="truncate font-mono text-[5.5pt] text-black">{selection.sku}</p>
          {price !== null ? (
            <p className="shrink-0 text-[7pt] font-bold tabular-nums text-black">{formatMoney(price).replace('₹', 'Rs ')}</p>
          ) : null}
        </div>
      </div>
      {showQr && selection.qr_identifier ? (
        <div className="shrink-0">
          <QrCodeSvg value={selection.qr_identifier} size={Math.min(heightMm * 2.6, 34)} />
        </div>
      ) : null}
    </div>
  )
}
