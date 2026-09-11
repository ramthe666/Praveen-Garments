'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  ArrowDownToLine,
  ArrowLeftRight,
  Boxes,
  MoreHorizontal,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useApp } from '@/components/providers/app-provider'
import { isTableMissing, logError, toUserMessage } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/shared/empty-state'
import { ErrorState } from '@/components/shared/error-state'
import { TableSkeleton } from '@/components/shared/loading'
import { DataTablePagination } from '@/components/shared/data-table-pagination'
import { StockStatusBadge } from '@/components/shared/status-badge'
import { Combobox } from '@/components/shared/combobox'
import {
  AdjustStockDialog,
  OpeningStockDialog,
  ReorderLevelDialog,
  TransferStockDialog,
} from '@/components/products/variant-dialogs'
import { PAGE_SIZE, formatMoney, useDebounced } from '@/lib/catalog/constants'
import type {
  Brand,
  Category,
  Color,
  Size,
  StockLocation,
  StockPageResult,
  StockPageRow,
} from '@/types/database'

type StatusFilter = 'all' | 'in_stock' | 'low_stock' | 'out_of_stock'

/** One selected balance row passed to the stock dialogs. */
export interface StockRowTarget {
  id: string
  variant_id: string
  sku: string
  label: string
  reorder_level: number | null
}

export function StockList({
  categories,
  brands,
  sizes,
  colors,
  locations,
  onSetupNeeded,
}: {
  categories: Category[]
  brands: Brand[]
  sizes: Size[]
  colors: Color[]
  locations: StockLocation[]
  onSetupNeeded: () => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission, settings } = useApp()
  const canManageStock = hasPermission('manage_inventory')
  const globalThreshold = settings.inventory?.low_stock_threshold ?? 10

  const [rows, setRows] = React.useState<StockPageRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [totalIsEstimate, setTotalIsEstimate] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search)
  const [category, setCategory] = React.useState('all')
  const [brand, setBrand] = React.useState('all')
  const [size, setSize] = React.useState('all')
  const [color, setColor] = React.useState('all')
  const [location, setLocation] = React.useState('all')
  const [status, setStatus] = React.useState<StatusFilter>('all')

  // stock dialogs
  const [dialog, setDialog] = React.useState<'opening' | 'adjust' | 'transfer' | 'reorder' | null>(null)
  const [target, setTarget] = React.useState<StockRowTarget | null>(null)

  React.useEffect(() => {
    setPage(1)
  }, [debouncedSearch, category, brand, size, color, location, status])

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('stock_page', {
        p_search: debouncedSearch || null,
        p_category_id: category === 'all' ? null : category,
        p_brand_id: brand === 'all' ? null : brand,
        p_size_id: size === 'all' ? null : size,
        p_color_id: color === 'all' ? null : color,
        p_location_id: location === 'all' ? null : location,
        p_status: status === 'all' ? null : status,
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE,
      })
      if (rpcError) {
        if (isTableMissing(rpcError)) {
          onSetupNeeded()
          setRows([])
          setTotal(0)
          return
        }
        logError('stock:load', rpcError)
        setError(toUserMessage(rpcError))
        return
      }
      const result = (data ?? { rows: [], total: 0, total_is_estimate: true }) as StockPageResult
      setRows(result.rows ?? [])
      setTotal(result.total ?? 0)
      setTotalIsEstimate(Boolean(result.total_is_estimate))
    } catch (err) {
      logError('stock:load:unexpected', err)
      setError('Could not load stock. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [supabase, debouncedSearch, category, brand, size, color, location, status, page, onSetupNeeded])

  React.useEffect(() => {
    void load()
  }, [load])

  const hasFilters =
    debouncedSearch !== '' || category !== 'all' || brand !== 'all' || size !== 'all' || color !== 'all' || location !== 'all' || status !== 'all'

  const openDialog = (kind: 'opening' | 'adjust' | 'transfer' | 'reorder', row: StockPageRow) => {
    setTarget({
      id: row.variant_id,
      variant_id: row.variant_id,
      sku: row.sku,
      label: `${row.product_name} — ${row.sku}`,
      reorder_level: row.reorder_level,
    })
    setDialog(kind)
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product, SKU, barcode, QR…"
            className="pl-9"
            type="search"
            aria-label="Search stock"
          />
        </div>
        <div className="w-full lg:w-44">
          <Combobox
            options={[{ value: 'all', label: 'All categories' }, ...categories.filter((c) => c.is_active).map((c) => ({ value: c.id, label: c.name }))]}
            value={category}
            onValueChange={setCategory}
            placeholder="All categories"
            aria-label="Filter by category"
          />
        </div>
        <div className="w-full lg:w-40">
          <Combobox
            options={[{ value: 'all', label: 'All brands' }, ...brands.filter((b) => b.is_active).map((b) => ({ value: b.id, label: b.name }))]}
            value={brand}
            onValueChange={setBrand}
            placeholder="All brands"
            aria-label="Filter by brand"
          />
        </div>
        <div className="w-full lg:w-28">
          <Combobox
            options={[{ value: 'all', label: 'All sizes' }, ...sizes.filter((s) => s.is_active).map((s) => ({ value: s.id, label: s.name }))]}
            value={size}
            onValueChange={setSize}
            placeholder="All sizes"
            aria-label="Filter by size"
          />
        </div>
        <div className="w-full lg:w-32">
          <Combobox
            options={[{ value: 'all', label: 'All colors' }, ...colors.filter((c) => c.is_active).map((c) => ({ value: c.id, label: c.name }))]}
            value={color}
            onValueChange={setColor}
            placeholder="All colors"
            aria-label="Filter by color"
          />
        </div>
        <div className="w-full lg:w-40">
          <Combobox
            options={[
              { value: 'all', label: 'All locations' },
              ...locations.filter((l) => l.is_active).map((l) => ({ value: l.id, label: l.name })),
            ]}
            value={location}
            onValueChange={setLocation}
            placeholder="All locations"
            aria-label="Filter by location"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-full lg:w-40" aria-label="Filter by stock status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="in_stock">In stock</SelectItem>
            <SelectItem value="low_stock">Low stock</SelectItem>
            <SelectItem value="out_of_stock">Out of stock</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
        {loading ? (
          <TableSkeleton rows={PAGE_SIZE} cols={8} />
        ) : error ? (
          <div className="p-6">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Boxes />}
              title={hasFilters ? 'No matching stock records' : 'No stock yet'}
              description={
                hasFilters
                  ? 'Try a different search or clear the filters.'
                  : 'Add opening stock to a product variant to see it here.'
              }
              action={
                hasFilters ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSearch('')
                      setCategory('all')
                      setBrand('all')
                      setSize('all')
                      setColor('all')
                      setLocation('all')
                      setStatus('all')
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          </div>
        ) : (
          <>
            <div className="thin-scrollbar hidden overflow-x-auto lg:block">
              <Table className="min-w-[64rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Reserved</TableHead>
                    <TableHead className="text-right">Reorder</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.balance_id}>
                      <TableCell className="max-w-[18rem]">
                        <Link href={`/products/${row.product_id}`} className="block truncate font-medium hover:text-primary hover:underline underline-offset-4">
                          {row.product_name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {[row.color_name, row.size_name].filter(Boolean).join(' / ') || 'Default'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.location_name}
                        {row.location_type === 'warehouse' ? (
                          <span className="ml-1 text-xs text-muted-foreground/70">(WH)</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{row.available}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {row.reserved_quantity > 0 ? row.reserved_quantity : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{row.reorder_level ?? 'global'}</TableCell>
                      <TableCell>
                        <StockStatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {canManageStock ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" aria-label={`Stock actions for ${row.sku}`}>
                                <MoreHorizontal className="size-4" aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              <DropdownMenuLabel>
                                {row.sku}
                              </DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => openDialog('opening', row)}>
                                <Boxes className="size-4" aria-hidden="true" />
                                Opening stock…
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openDialog('adjust', row)}>
                                <ArrowDownToLine className="size-4" aria-hidden="true" />
                                Adjust…
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openDialog('transfer', row)}>
                                <ArrowLeftRight className="size-4" aria-hidden="true" />
                                Transfer…
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => openDialog('reorder', row)}>
                                <ShieldCheck className="size-4" aria-hidden="true" />
                                Reorder level…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile / tablet cards */}
            <ul className="divide-y lg:hidden">
              {rows.map((row) => (
                <li key={row.balance_id} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/products/${row.product_id}`} className="block truncate font-medium">
                        {row.product_name}
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {[row.color_name, row.size_name].filter(Boolean).join(' / ') || 'Default'} · {row.sku}
                      </p>
                    </div>
                    <StockStatusBadge status={row.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {row.location_name}:{' '}
                      <span className="font-medium tabular-nums text-foreground">{row.available}</span>
                    </span>
                    {row.reserved_quantity > 0 ? <span className="tabular-nums">{row.reserved_quantity} reserved</span> : null}
                    <span className="tabular-nums">reorder {row.reorder_level ?? 'global'}</span>
                    <span className="tabular-nums">{formatMoney(row.selling_price)}</span>
                  </div>
                  {canManageStock ? (
                    <div className="flex gap-2 pt-1">
                      <Button variant="outline" size="sm" onClick={() => openDialog('adjust', row)}>
                        Adjust
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openDialog('transfer', row)}>
                        Transfer
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openDialog('reorder', row)}>
                        Reorder
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>

            <div className="border-t px-4 py-3">
              <DataTablePagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
              {totalIsEstimate ? (
                <p className="mt-1 text-center text-[11px] text-muted-foreground/70">
                  Total is a database estimate (exact counts shown while filtering).
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>

      {/* Stock dialogs */}
      {target ? (
        <>
          <OpeningStockDialog
            variant={target}
            locations={locations}
            open={dialog === 'opening'}
            onOpenChange={(o) => !o && setDialog(null)}
            onSaved={() => void load()}
          />
          <AdjustStockDialog
            variant={target}
            locations={locations}
            open={dialog === 'adjust'}
            onOpenChange={(o) => !o && setDialog(null)}
            onSaved={() => void load()}
          />
          <TransferStockDialog
            variant={target}
            locations={locations}
            open={dialog === 'transfer'}
            onOpenChange={(o) => !o && setDialog(null)}
            onSaved={() => void load()}
          />
          <ReorderLevelDialog
            variant={target}
            locations={locations}
            currentReorder={target.reorder_level}
            globalThreshold={globalThreshold}
            open={dialog === 'reorder'}
            onOpenChange={(o) => !o && setDialog(null)}
            onSaved={() => void load()}
          />
        </>
      ) : null}
    </div>
  )
}
