'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowLeftRight,
  Barcode,
  Boxes,
  ImageIcon,
  Layers,
  MoreHorizontal,
  PackageX,
  Pencil,
  Plus,
  Printer,
  QrCode,
  Repeat2,
  ShieldCheck,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useApp } from '@/components/providers/app-provider'
import { isTableMissing, logError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ErrorState } from '@/components/shared/error-state'
import { TableSkeleton } from '@/components/shared/loading'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { ActiveBadge } from '@/components/shared/status-badge'
import { Phase2SetupNotice } from '@/components/shared/phase2-setup-notice'
import {
  VariantEditDialog,
  VariantIdsDialog,
  VariantToggleDialog,
  OpeningStockDialog,
  AdjustStockDialog,
  TransferStockDialog,
  ReorderLevelDialog,
} from '@/components/products/variant-dialogs'
import { VariantMatrix, type VariantDraft } from '@/components/products/variant-matrix'
import { formatMoney, productImageUrl } from '@/lib/catalog/constants'
import type {
  Brand,
  Category,
  Color,
  Product,
  ProductVariant,
  Size,
  StockLocation,
} from '@/types/database'

/** Variant row enriched with stock balances (bounded: variants x locations). */
export interface VariantWithStock extends ProductVariant {
  size_name: string | null
  color_name: string | null
  balances: Array<{
    location_id: string
    location_name: string
    quantity: number
    reserved_quantity: number
    reorder_level: number | null
  }>
}

type StockDialogKind = 'opening' | 'adjust' | 'transfer' | 'reorder' | null

export function ProductDetailView({
  product,
  initialVariants,
  category,
  subcategory,
  brand,
}: {
  product: Product
  initialVariants: VariantWithStock[]
  category: Category | null
  subcategory: Category | null
  brand: Brand | null
}) {
  const router = useRouter()
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission, settings, companyName } = useApp()
  const canManage = hasPermission('manage_products')
  const canManageStock = hasPermission('manage_inventory')
  const globalThreshold = settings.inventory?.low_stock_threshold ?? 10

  const [variants, setVariants] = React.useState<VariantWithStock[]>(initialVariants)
  const [sizes, setSizes] = React.useState<Size[]>([])
  const [colors, setColors] = React.useState<Color[]>([])
  const [locations, setLocations] = React.useState<StockLocation[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  // dialogs
  const [editTarget, setEditTarget] = React.useState<ProductVariant | null>(null)
  const [idsTarget, setIdsTarget] = React.useState<ProductVariant | null>(null)
  const [toggleTarget, setToggleTarget] = React.useState<ProductVariant | null>(null)
  const [archiveOpen, setArchiveOpen] = React.useState(false)
  const [addOpen, setAddOpen] = React.useState(false)
  const [drafts, setDrafts] = React.useState<VariantDraft[]>([])
  const [adding, setAdding] = React.useState(false)
  const [stockDialog, setStockDialog] = React.useState<StockDialogKind>(null)
  const [stockTarget, setStockTarget] = React.useState<VariantWithStock | null>(null)

  // reference data
  React.useEffect(() => {
    let cancelled = false
    supabase.from('sizes').select('*').order('sort_order').then(({ data, error }) => {
      if (!cancelled && !error) setSizes((data as Size[]) ?? [])
    })
    supabase.from('colors').select('*').order('name').then(({ data, error }) => {
      if (!cancelled && !error) setColors((data as Color[]) ?? [])
    })
    supabase.from('stock_locations').select('*').order('name').then(({ data, error }) => {
      if (!cancelled && !error) setLocations((data as StockLocation[]) ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [supabase])

  const reloadVariants = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('product_variants')
        .select(
          '*, sizes(name), colors(name, hex_code), stock_balances(quantity, reserved_quantity, reorder_level, stock_locations(id, name))'
        )
        .eq('product_id', product.id)
        .order('created_at')
      if (err) {
        if (isTableMissing(err)) setSetupNeeded(true)
        else {
          logError('product-detail:variants', err)
          setError('Could not load variants. Please retry.')
        }
        return
      }
      const rows = ((data ?? []) as Array<Record<string, unknown> & ProductVariant>).map((v) => {
        const size = v.sizes as unknown as { name: string } | null
        const color = v.colors as unknown as { name: string } | null
        const balances = ((v.stock_balances ?? []) as Array<Record<string, unknown>>).map((b) => ({
          location_id: (b.stock_locations as unknown as { id: string } | null)?.id ?? '',
          location_name: (b.stock_locations as unknown as { name: string } | null)?.name ?? '—',
          quantity: Number(b.quantity ?? 0),
          reserved_quantity: Number(b.reserved_quantity ?? 0),
          reorder_level: b.reorder_level === null ? null : Number(b.reorder_level),
        }))
        const { sizes: _s, colors: _c, stock_balances: _b, ...rest } = v
        return { ...rest, size_name: size?.name ?? null, color_name: color?.name ?? null, balances } as VariantWithStock
      })
      setVariants(rows)
    } finally {
      setLoading(false)
    }
  }, [supabase, product.id])

  React.useEffect(() => {
    if (setupNeeded) return
    void reloadVariants()
  }, [reloadVariants, setupNeeded])

  const stockSummary = React.useMemo(() => {
    const total = variants.reduce((sum, v) => sum + v.balances.reduce((s, b) => s + b.quantity, 0), 0)
    return total
  }, [variants])

  async function handleArchiveToggle() {
    const nextActive = !product.is_active
    try {
      const res = await fetch(`/api/admin/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: nextActive }),
      })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error('Could not update the product', { description: payload.error ?? 'Please try again.' })
        return
      }
      toast.success(nextActive ? 'Product activated' : 'Product deactivated', {
        description: nextActive
          ? 'The product is sellable again.'
          : 'History stays valid — the product is archived, not deleted.',
      })
      router.refresh()
    } catch (err) {
      logError('product-detail:archive', err)
      toast.error('Could not update the product', { description: 'Network error.' })
    }
  }

  async function handleAddVariants() {
    if (adding || drafts.length === 0) return
    setAdding(true)
    try {
      const res = await fetch(`/api/admin/products/${product.id}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variants: drafts.map((d) => ({
            sku: d.sku.trim() || null,
            size_id: d.size_id,
            color_id: d.color_id,
            barcode: d.barcode.trim() || null,
            qr_identifier: d.qr_identifier.trim() || null,
            generate_barcode: d.generate_barcode,
            generate_qr: d.generate_qr,
            cost_price: d.cost_price ? Number(d.cost_price) : null,
            mrp: d.mrp ? Number(d.mrp) : null,
            selling_price: d.selling_price ? Number(d.selling_price) : null,
            wholesale_price: d.wholesale_price ? Number(d.wholesale_price) : null,
          })),
        }),
      })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error('Could not add variants', { description: payload.error ?? 'Please try again.' })
        return
      }
      toast.success('Variants added', { description: `${drafts.length} new variant${drafts.length === 1 ? '' : 's'} created.` })
      setAddOpen(false)
      setDrafts([])
      await reloadVariants()
    } catch (err) {
      logError('product-detail:add-variants', err)
      toast.error('Could not add variants', { description: 'Network error.' })
    } finally {
      setAdding(false)
    }
  }

  const openStockDialog = (kind: StockDialogKind, variant: VariantWithStock) => {
    setStockTarget(variant)
    setStockDialog(kind)
  }

  const currentReorder = React.useMemo(() => {
    if (!stockTarget) return null
    return stockTarget.balances[0]?.reorder_level ?? null
  }, [stockTarget])

  return (
    <div className="space-y-6">
      <PageHeader
        title={product.name}
        description={[category?.name, subcategory?.name, brand?.name].filter(Boolean).join(' › ') || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/products">
                <ArrowLeft className="size-4" aria-hidden="true" />
                Back
              </Link>
            </Button>
            {canManage ? (
              <>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/products/${product.id}/edit`}>
                    <Pencil className="size-4" aria-hidden="true" />
                    Edit
                  </Link>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setArchiveOpen(true)}>
                  {product.is_active ? <PackageX className="size-4" aria-hidden="true" /> : <Repeat2 className="size-4" aria-hidden="true" />}
                  {product.is_active ? 'Deactivate' : 'Activate'}
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      {setupNeeded ? <Phase2SetupNotice /> : null}

      {/* Summary card */}
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <div className="flex size-28 items-center justify-center overflow-hidden rounded-lg border bg-muted lg:size-32">
          {product.image_path ? (
             
            <img
              src={productImageUrl(product.image_path) ?? ''}
              alt={`Image of ${product.name}`}
              className="size-full object-cover"
            />
          ) : (
            <ImageIcon className="size-8 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <SummaryItem label="Status">
            <ActiveBadge active={product.is_active} />
          </SummaryItem>
          <SummaryItem label="Product code">{product.product_code ?? '—'}</SummaryItem>
          <SummaryItem label="Variants">{variants.length}</SummaryItem>
          <SummaryItem label="Total stock">{stockSummary}</SummaryItem>
          <SummaryItem label="Selling price">
            <span className="tabular-nums">{formatMoney(product.selling_price)}</span>
          </SummaryItem>
          <SummaryItem label="MRP">
            <span className="tabular-nums">{formatMoney(product.mrp)}</span>
          </SummaryItem>
          <SummaryItem label="GST">{product.gst_rate !== null ? `${product.gst_rate}%` : '—'}</SummaryItem>
          <SummaryItem label="HSN/SAC">{product.hsn_code ?? '—'}</SummaryItem>
          <SummaryItem label="Gender">{product.gender ?? '—'}</SummaryItem>
          <SummaryItem label="Fabric">{product.fabric ?? '—'}</SummaryItem>
        </div>
      </div>

      {product.description ? (
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{product.description}</p>
      ) : null}

      {/* Variants */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
            Variants
            <Badge variant="secondary" className="tabular-nums">
              {variants.length}
            </Badge>
          </h2>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add variants
            </Button>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
          {loading ? (
            <TableSkeleton rows={Math.max(3, Math.min(variants.length, 10))} cols={7} />
          ) : error ? (
            <div className="p-6">
              <ErrorState message={error} onRetry={() => void reloadVariants()} />
            </div>
          ) : variants.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Layers />}
                title="No variants yet"
                description="Add size/color variants — each gets a unique SKU, barcode and QR identifier."
                action={
                  canManage ? (
                    <Button size="sm" onClick={() => setAddOpen(true)}>
                      <Plus className="size-4" aria-hidden="true" />
                      Add variants
                    </Button>
                  ) : null
                }
              />
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="thin-scrollbar hidden overflow-x-auto md:block">
                <Table className="min-w-[60rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variant</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Barcode / QR</TableHead>
                      <TableHead className="text-right">Prices</TableHead>
                      <TableHead>Stock by location</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-12 text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {variants.map((v) => {
                      const label = [v.color_name, v.size_name].filter(Boolean).join(' / ') || 'Default'
                      return (
                        <TableRow key={v.id} className={v.is_active ? undefined : 'opacity-60'}>
                          <TableCell className="font-medium">{label}</TableCell>
                          <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Barcode className="size-3.5 shrink-0" aria-hidden="true" />
                              <span className="tabular-nums">{v.barcode ?? '—'}</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <QrCode className="size-3.5 shrink-0" aria-hidden="true" />
                              <span>{v.qr_identifier ?? '—'}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            <div className="tabular-nums">Sell {formatMoney(v.selling_price ?? product.selling_price)}</div>
                            <div className="tabular-nums text-muted-foreground">MRP {formatMoney(v.mrp ?? product.mrp)}</div>
                          </TableCell>
                          <TableCell>
                            {v.balances.length === 0 ? (
                              <span className="text-xs text-muted-foreground">No stock yet</span>
                            ) : (
                              <div className="flex flex-col gap-0.5">
                                {v.balances.map((b) => (
                                  <span key={b.location_id} className="text-xs text-muted-foreground">
                                    {b.location_name}:{' '}
                                    <span className={`font-medium tabular-nums ${b.quantity - b.reserved_quantity <= 0 ? 'text-destructive' : b.quantity - b.reserved_quantity <= (b.reorder_level ?? globalThreshold) ? 'text-warning-foreground' : 'text-foreground'}`}>
                                      {b.quantity - b.reserved_quantity}
                                    </span>
                                    {b.reserved_quantity > 0 ? ` (${b.reserved_quantity} reserved)` : ''}
                                  </span>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <ActiveBadge active={v.is_active} />
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" aria-label={`Actions for ${label}`}>
                                  <MoreHorizontal className="size-4" aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-52">
                                <DropdownMenuLabel>{label}</DropdownMenuLabel>
                                <DropdownMenuItem onClick={() => setIdsTarget(v)}>
                                  <Barcode className="size-4" aria-hidden="true" />
                                  View barcode &amp; QR
                                </DropdownMenuItem>
                                {canManage ? (
                                  <>
                                    <DropdownMenuItem onClick={() => setEditTarget(v)}>
                                      <Pencil className="size-4" aria-hidden="true" />
                                      Edit variant
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                      <Link href={`/labels?variant=${v.id}`}>
                                        <Printer className="size-4" aria-hidden="true" />
                                        Print labels
                                      </Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => setToggleTarget(v)}>
                                      <PackageX className="size-4" aria-hidden="true" />
                                      {v.is_active ? 'Deactivate' : 'Activate'}
                                    </DropdownMenuItem>
                                  </>
                                ) : null}
                                {canManageStock ? (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuLabel className="text-xs text-muted-foreground">Inventory</DropdownMenuLabel>
                                    <DropdownMenuItem onClick={() => openStockDialog('opening', v)}>
                                      <Boxes className="size-4" aria-hidden="true" />
                                      Opening stock…
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => openStockDialog('adjust', v)}>
                                      <ArrowDownToLine className="size-4" aria-hidden="true" />
                                      Adjust stock…
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => openStockDialog('transfer', v)}>
                                      <ArrowLeftRight className="size-4" aria-hidden="true" />
                                      Transfer…
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => openStockDialog('reorder', v)}>
                                      <ShieldCheck className="size-4" aria-hidden="true" />
                                      Reorder level…
                                    </DropdownMenuItem>
                                  </>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <ul className="divide-y md:hidden">
                {variants.map((v) => {
                  const label = [v.color_name, v.size_name].filter(Boolean).join(' / ') || 'Default'
                  return (
                    <li key={v.id} className="space-y-2 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">{label}</p>
                          <p className="font-mono text-xs text-muted-foreground">{v.sku}</p>
                        </div>
                        <ActiveBadge active={v.is_active} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <Barcode className="mr-1 inline size-3.5" aria-hidden="true" />
                        <span className="tabular-nums">{v.barcode ?? '—'}</span>
                        <QrCode className="ml-3 mr-1 inline size-3.5" aria-hidden="true" />
                        {v.qr_identifier ?? '—'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Sell {formatMoney(v.selling_price ?? product.selling_price)} · MRP {formatMoney(v.mrp ?? product.mrp)}
                      </p>
                      {v.balances.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {v.balances.map((b) => `${b.location_name}: ${b.quantity - b.reserved_quantity}`).join(' · ')}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">No stock yet</p>
                      )}
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button variant="outline" size="sm" onClick={() => setIdsTarget(v)}>
                          <Barcode className="size-4" aria-hidden="true" />
                          IDs
                        </Button>
                        {canManage ? (
                          <>
                            <Button variant="outline" size="sm" onClick={() => setEditTarget(v)}>
                              <Pencil className="size-4" aria-hidden="true" />
                              Edit
                            </Button>
                            <Button variant="outline" size="sm" asChild>
                              <Link href={`/labels?variant=${v.id}`}>
                                <Printer className="size-4" aria-hidden="true" />
                                Labels
                              </Link>
                            </Button>
                          </>
                        ) : null}
                        {canManageStock ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="sm">
                                <Boxes className="size-4" aria-hidden="true" />
                                Stock…
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem onClick={() => openStockDialog('opening', v)}>Opening stock…</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openStockDialog('adjust', v)}>Adjust…</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openStockDialog('transfer', v)}>Transfer…</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openStockDialog('reorder', v)}>Reorder level…</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <VariantEditDialog
        variant={editTarget}
        sizes={sizes}
        colors={colors}
        open={editTarget !== null}
        onOpenChange={(o) => !o && setEditTarget(null)}
        onSaved={() => void reloadVariants()}
      />
      <VariantIdsDialog
        variant={idsTarget}
        productName={product.name}
        companyName={companyName}
        open={idsTarget !== null}
        onOpenChange={(o) => !o && setIdsTarget(null)}
      />
      <VariantToggleDialog
        variant={toggleTarget}
        open={toggleTarget !== null}
        onOpenChange={(o) => !o && setToggleTarget(null)}
        onSaved={() => void reloadVariants()}
      />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={product.is_active ? 'Deactivate product' : 'Activate product'}
        description={
          product.is_active
            ? `${product.name} and its variants stop being sellable. Stock, history and audit records are preserved.`
            : `${product.name} becomes sellable again.`
        }
        confirmLabel={product.is_active ? 'Deactivate' : 'Activate'}
        destructive={product.is_active}
        onConfirm={() => {
          setArchiveOpen(false)
          void handleArchiveToggle()
        }}
      />

      {/* Add variants dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add variants</DialogTitle>
            <DialogDescription>
              Pick size/color combinations — SKUs, barcodes and QR identifiers are generated
              automatically where left blank.
            </DialogDescription>
          </DialogHeader>
          <VariantMatrix
            sizes={sizes}
            colors={colors}
            productCode={product.product_code ?? ''}
            productName={product.name}
            autoBarcode={settings.barcode?.auto_generate ?? true}
            qrEnabled={settings.qr?.enabled ?? true}
            drafts={drafts}
            onDraftsChange={setDrafts}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleAddVariants()} disabled={adding || drafts.length === 0}>
              {adding ? 'Adding…' : `Add ${drafts.length || ''} variant${drafts.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Stock dialogs */}
      {stockTarget ? (
        <>
          <OpeningStockDialog
            variant={{ id: stockTarget.id, sku: stockTarget.sku, label: `${product.name} — ${stockTarget.sku}` }}
            locations={locations}
            open={stockDialog === 'opening'}
            onOpenChange={(o) => !o && setStockDialog(null)}
            onSaved={() => void reloadVariants()}
          />
          <AdjustStockDialog
            variant={{ id: stockTarget.id, sku: stockTarget.sku, label: `${product.name} — ${stockTarget.sku}` }}
            locations={locations}
            open={stockDialog === 'adjust'}
            onOpenChange={(o) => !o && setStockDialog(null)}
            onSaved={() => void reloadVariants()}
          />
          <TransferStockDialog
            variant={{ id: stockTarget.id, sku: stockTarget.sku, label: `${product.name} — ${stockTarget.sku}` }}
            locations={locations}
            open={stockDialog === 'transfer'}
            onOpenChange={(o) => !o && setStockDialog(null)}
            onSaved={() => void reloadVariants()}
          />
          <ReorderLevelDialog
            variant={{ id: stockTarget.id, sku: stockTarget.sku, label: `${product.name} — ${stockTarget.sku}` }}
            locations={locations}
            currentReorder={currentReorder}
            globalThreshold={globalThreshold}
            open={stockDialog === 'reorder'}
            onOpenChange={(o) => !o && setStockDialog(null)}
            onSaved={() => void reloadVariants()}
          />
        </>
      ) : null}
    </div>
  )
}

function SummaryItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-3 shadow-xs">
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 truncate text-sm font-medium text-foreground">{children}</div>
    </div>
  )
}
