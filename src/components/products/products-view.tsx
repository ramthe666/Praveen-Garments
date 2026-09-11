'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Boxes,
  ImageOff,
  Package,
  PackagePlus,
  Pencil,
  Plus,
  Search,
  Settings2,
  Printer,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useApp } from '@/components/providers/app-provider'
import { isTableMissing, logError, toUserMessage } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ErrorState } from '@/components/shared/error-state'
import { TableSkeleton } from '@/components/shared/loading'
import { DataTablePagination } from '@/components/shared/data-table-pagination'
import { Phase2SetupNotice } from '@/components/shared/phase2-setup-notice'
import { ActiveBadge } from '@/components/shared/status-badge'
import { Combobox } from '@/components/shared/combobox'
import {
  PAGE_SIZE,
  formatMoney,
  formatDate,
  productImageUrl,
  useDebounced,
} from '@/lib/catalog/constants'
import type { Brand, Category, ProductsPageResult, ProductsPageRow } from '@/types/database'

type SortKey = 'newest' | 'oldest' | 'name_asc' | 'name_desc'

export function ProductsView() {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()
  const canManage = hasPermission('manage_products')

  const [rows, setRows] = React.useState<ProductsPageRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [totalIsEstimate, setTotalIsEstimate] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search)
  const [category, setCategory] = React.useState('all')
  const [brand, setBrand] = React.useState('all')
  const [status, setStatus] = React.useState<'all' | 'active' | 'inactive'>('all')
  const [sort, setSort] = React.useState<SortKey>('newest')

  const [categories, setCategories] = React.useState<Category[]>([])
  const [brands, setBrands] = React.useState<Brand[]>([])

  // reference data (bounded, active-only) for the filter bar
  React.useEffect(() => {
    let cancelled = false
    supabase
      .from('categories')
      .select('*')
      .eq('is_active', true)
      .order('name')
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          if (!isTableMissing(err)) logError('products:categories', err)
          return
        }
        setCategories((data as Category[]) ?? [])
      })
    supabase
      .from('brands')
      .select('*')
      .eq('is_active', true)
      .order('name')
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          if (!isTableMissing(err)) logError('products:brands', err)
          return
        }
        setBrands((data as Brand[]) ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [supabase])

  // flatten categories with parent labels for the filter
  const categoryOptions = React.useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]))
    return categories
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        value: c.id,
        label: c.parent_id && byId.get(c.parent_id) ? `${byId.get(c.parent_id)!.name} › ${c.name}` : c.name,
      }))
  }, [categories])

  React.useEffect(() => {
    setPage(1)
  }, [debouncedSearch, category, brand, status, sort])

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    setSetupNeeded(false)
    try {
      const { data, error: rpcError } = await supabase.rpc('products_page', {
        p_search: debouncedSearch || null,
        p_category_id: category === 'all' ? null : category,
        p_brand_id: brand === 'all' ? null : brand,
        p_status: status === 'all' ? null : status,
        p_sort: sort,
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE,
      })

      if (rpcError) {
        if (isTableMissing(rpcError)) {
          setSetupNeeded(true)
          setRows([])
          setTotal(0)
          return
        }
        logError('products:load', rpcError)
        setError(toUserMessage(rpcError))
        return
      }

      const result = (data ?? { rows: [], total: 0, total_is_estimate: true }) as ProductsPageResult
      setRows(result.rows ?? [])
      setTotal(result.total ?? 0)
      setTotalIsEstimate(Boolean(result.total_is_estimate))
    } catch (err) {
      logError('products:load:unexpected', err)
      setError('Could not load products. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [supabase, debouncedSearch, category, brand, status, sort, page])

  React.useEffect(() => {
    void load()
  }, [load])

  const hasFilters = debouncedSearch !== '' || category !== 'all' || brand !== 'all' || status !== 'all'

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description="Catalog of garments with size/color variants, SKUs, barcodes and QR identifiers."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/products/attributes">
                <Settings2 className="size-4" aria-hidden="true" />
                Attributes
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/labels">
                <Printer className="size-4" aria-hidden="true" />
                Print labels
              </Link>
            </Button>
            {canManage ? (
              <Button asChild size="sm">
                <Link href="/products/new">
                  <Plus className="size-4" aria-hidden="true" />
                  New product
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {setupNeeded ? <Phase2SetupNotice /> : null}

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, SKU, barcode, QR…"
            className="pl-9"
            aria-label="Search products"
            type="search"
          />
        </div>
        <div className="w-full sm:w-52">
          <Combobox
            options={[{ value: 'all', label: 'All categories' }, ...categoryOptions]}
            value={category}
            onValueChange={setCategory}
            placeholder="All categories"
            aria-label="Filter by category"
          />
        </div>
        <div className="w-full sm:w-44">
          <Combobox
            options={[
              { value: 'all', label: 'All brands' },
              ...brands.map((b) => ({ value: b.id, label: b.name })),
            ]}
            value={brand}
            onValueChange={setBrand}
            placeholder="All brands"
            aria-label="Filter by brand"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-full sm:w-36" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active only</SelectItem>
            <SelectItem value="inactive">Inactive only</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-full sm:w-40" aria-label="Sort products">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="name_asc">Name A–Z</SelectItem>
            <SelectItem value="name_desc">Name Z–A</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table / states */}
      <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
        {loading ? (
          <TableSkeleton rows={PAGE_SIZE} cols={7} />
        ) : error ? (
          <div className="p-6">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        ) : rows.length === 0 && !setupNeeded ? (
          <div className="p-6">
            <EmptyState
              icon={hasFilters ? <Search /> : <Package />}
              title={hasFilters ? 'No matching products' : 'No products yet'}
              description={
                hasFilters
                  ? 'Try a different search or clear the filters.'
                  : 'Create your first product with its size and color variants.'
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
                      setStatus('all')
                    }}
                  >
                    Clear filters
                  </Button>
                ) : canManage ? (
                  <Button asChild size="sm">
                    <Link href="/products/new">
                      <PackagePlus className="size-4" aria-hidden="true" />
                      New product
                    </Link>
                  </Button>
                ) : null
              }
            />
          </div>
        ) : rows.length === 0 ? null : (
          <>
            {/* Desktop table */}
            <div className="thin-scrollbar hidden overflow-x-auto md:block">
              <Table className="min-w-[56rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">Image</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Brand</TableHead>
                    <TableHead className="text-right">Variants</TableHead>
                    <TableHead className="text-right">Selling price</TableHead>
                    <TableHead className="text-right">MRP</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead className="w-20 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.image_path ? (
                           
                          <img
                            src={productImageUrl(row.image_path) ?? ''}
                            alt=""
                            className="size-10 rounded-md border object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span
                            className="flex size-10 items-center justify-center rounded-md border bg-muted text-muted-foreground"
                            aria-hidden="true"
                          >
                            <ImageOff className="size-4" />
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[22rem]">
                        <Link
                          href={`/products/${row.id}`}
                          className="block truncate font-medium text-foreground hover:text-primary hover:underline underline-offset-4"
                        >
                          {row.name}
                        </Link>
                        {row.product_code ? (
                          <span className="text-xs text-muted-foreground">{row.product_code}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[12rem] truncate text-sm text-muted-foreground">
                        {row.category_name ?? '—'}
                        {row.subcategory_name ? ` › ${row.subcategory_name}` : ''}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{row.brand_name ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.variant_count > 0 ? (
                          <Badge variant="secondary" className="tabular-nums">
                            {row.variant_count}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">none</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">
                        {row.min_selling_price === row.max_selling_price || row.min_selling_price === null
                          ? formatMoney(row.min_selling_price ?? row.selling_price)
                          : `${formatMoney(row.min_selling_price)}–${formatMoney(row.max_selling_price)}`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                        {formatMoney(row.max_mrp ?? row.mrp)}
                      </TableCell>
                      <TableCell>
                        <ActiveBadge active={row.is_active} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDate(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/products/${row.id}`} aria-label={`View ${row.name}`}>
                            View
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <ul className="divide-y md:hidden">
              {rows.map((row) => (
                <li key={row.id} className="p-4">
                  <Link href={`/products/${row.id}`} className="flex gap-3">
                    {row.image_path ? (
                       
                      <img
                        src={productImageUrl(row.image_path) ?? ''}
                        alt=""
                        className="size-14 shrink-0 rounded-md border object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span
                        className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"
                        aria-hidden="true"
                      >
                        <Package className="size-5" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{row.name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {[row.category_name, row.brand_name].filter(Boolean).join(' · ') || '—'}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          <Boxes className="mr-1 inline size-3.5" aria-hidden="true" />
                          {row.variant_count} variant{row.variant_count === 1 ? '' : 's'}
                        </span>
                        <span className="tabular-nums">{formatMoney(row.min_selling_price ?? row.selling_price)}</span>
                        <ActiveBadge active={row.is_active} />
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="border-t px-4 py-3">
              <DataTablePagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                onPageChange={setPage}
              />
              {totalIsEstimate ? (
                <p className="mt-1 text-center text-[11px] text-muted-foreground/70">
                  Total is a database estimate (exact counts shown while filtering).
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>

      {canManage && rows.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Tip: open a product to manage variants, SKUs, barcodes, QR and opening stock.{' '}
          <Pencil className="inline size-3" aria-hidden="true" /> Editing keeps a full audit trail.
        </p>
      ) : null}
    </div>
  )
}
