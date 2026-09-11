'use client'

import * as React from 'react'
import Link from 'next/link'
import { ClipboardList, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { isTableMissing, logError, toUserMessage } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Combobox } from '@/components/shared/combobox'
import { MOVEMENT_TYPES, formatDateTime, movementTypeLabel, useDebounced } from '@/lib/catalog/constants'
import type { StockHistoryPageResult, StockHistoryRow, StockLocation } from '@/types/database'

const PAGE_SIZE = 25

/**
 * Stock movement ledger with KEYSET (cursor) pagination — stable at any
 * history depth. Filters: date range, search (product/SKU/barcode/QR),
 * movement type and location — all evaluated database-side.
 */
export function StockHistory({
  locations,
  onSetupNeeded,
}: {
  locations: StockLocation[]
  onSetupNeeded: () => void
}) {
  const supabase = React.useMemo(() => createClient(), [])

  const [rows, setRows] = React.useState<StockHistoryRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [totalIsEstimate, setTotalIsEstimate] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(false)
  const [cursor, setCursor] = React.useState<{ created_at: string; id: number } | null>(null)
  const [history, setHistory] = React.useState<Array<{ created_at: string; id: number }>>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search)
  const [movementType, setMovementType] = React.useState('all')
  const [location, setLocation] = React.useState('all')
  const [dateFrom, setDateFrom] = React.useState('')
  const [dateTo, setDateTo] = React.useState('')

  const resetAndReload = React.useCallback(() => {
    setCursor(null)
    setHistory([])
  }, [])

  React.useEffect(() => {
    resetAndReload()
  }, [debouncedSearch, movementType, location, dateFrom, dateTo, resetAndReload])

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('stock_history_page', {
        p_after_created: cursor?.created_at ?? null,
        p_after_id: cursor?.id ?? null,
        p_date_from: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null,
        p_date_to: dateTo ? new Date(`${dateTo}T23:59:59`).toISOString() : null,
        p_search: debouncedSearch || null,
        p_movement_type: movementType === 'all' ? null : movementType,
        p_location_id: location === 'all' ? null : location,
        p_limit: PAGE_SIZE,
      })
      if (rpcError) {
        if (isTableMissing(rpcError)) {
          onSetupNeeded()
          setRows([])
          return
        }
        logError('history:load', rpcError)
        setError(toUserMessage(rpcError))
        return
      }
      const result = (data ?? { rows: [], total: 0, total_is_estimate: true, has_more: false, next_cursor: null }) as unknown as StockHistoryPageResult
      setRows(result.rows ?? [])
      setTotal(result.total ?? 0)
      setTotalIsEstimate(Boolean(result.total_is_estimate))
      setHasMore(Boolean(result.has_more))
    } catch (err) {
      logError('history:load:unexpected', err)
      setError('Could not load stock history. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [supabase, cursor, dateFrom, dateTo, debouncedSearch, movementType, location, onSetupNeeded])

  React.useEffect(() => {
    void load()
  }, [load])

  const goNext = () => {
    const last = rows[rows.length - 1]
    if (!last) return
    setHistory((h) => [...h, cursor ?? { created_at: '', id: 0 }])
    setCursor({ created_at: last.created_at, id: last.id })
  }

  const goBack = () => {
    const previous = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setCursor(previous && previous.id ? previous : null)
  }

  const pageNumber = history.length + 1
  const hasFilters =
    debouncedSearch !== '' || movementType !== 'all' || location !== 'all' || dateFrom !== '' || dateTo !== ''

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        <div className="relative w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product, SKU, barcode, QR…"
            className="pl-9"
            type="search"
            aria-label="Search history"
          />
        </div>
        <div className="w-full lg:w-48">
          <Label htmlFor="sh-type" className="sr-only">
            Movement type
          </Label>
          <Select value={movementType} onValueChange={setMovementType}>
            <SelectTrigger id="sh-type" aria-label="Filter by movement type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All movement types</SelectItem>
              {MOVEMENT_TYPES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full lg:w-44">
          <Combobox
            options={[
              { value: 'all', label: 'All locations' },
              ...locations.map((l) => ({ value: l.id, label: l.name })),
            ]}
            value={location}
            onValueChange={setLocation}
            placeholder="All locations"
            aria-label="Filter by location"
          />
        </div>
        <div className="w-full lg:w-40">
          <Label htmlFor="sh-from" className="sr-only">
            From date
          </Label>
          <Input id="sh-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="From date" />
        </div>
        <div className="w-full lg:w-40">
          <Label htmlFor="sh-to" className="sr-only">
            To date
          </Label>
          <Input id="sh-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="To date" />
        </div>
        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch('')
              setMovementType('all')
              setLocation('all')
              setDateFrom('')
              setDateTo('')
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {/* Ledger */}
      <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
        {loading ? (
          <TableSkeleton rows={PAGE_SIZE} cols={7} />
        ) : error ? (
          <div className="p-6">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<ClipboardList />}
              title={hasFilters ? 'No matching movements' : 'No stock movements yet'}
              description={
                hasFilters
                  ? 'Try widening the date range or clearing filters.'
                  : 'Opening stock, purchases, sales, adjustments and transfers will appear here.'
              }
            />
          </div>
        ) : (
          <>
            <div className="thin-scrollbar hidden overflow-x-auto lg:block">
              <Table className="min-w-[70rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date &amp; time</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>User</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </TableCell>
                      <TableCell className="max-w-[16rem]">
                        <Link href={`/products/${row.product_id}`} className="block truncate font-medium hover:text-primary hover:underline underline-offset-4">
                          {row.product_name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{row.location_name}</TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${
                          row.quantity > 0
                            ? 'border-success/25 bg-success/10 text-success'
                            : 'border-destructive/25 bg-destructive/10 text-destructive'
                        }`}>
                          {movementTypeLabel(row.movement_type)}
                        </span>
                      </TableCell>
                      <TableCell className={`text-right font-medium tabular-nums ${row.quantity > 0 ? 'text-success' : 'text-destructive'}`}>
                        {row.quantity > 0 ? `+${row.quantity}` : row.quantity}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{row.balance_after}</TableCell>
                      <TableCell className="max-w-[10rem] truncate text-xs text-muted-foreground">
                        {row.reference_id ? `${row.reference_type ?? ''} ${row.reference_id}`.trim() : row.reference_type ?? '—'}
                      </TableCell>
                      <TableCell className="max-w-[14rem] truncate text-sm text-muted-foreground">{row.reason ?? '—'}</TableCell>
                      <TableCell className="max-w-[12rem] truncate text-xs text-muted-foreground">{row.user_email ?? 'system'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <ul className="divide-y lg:hidden">
              {rows.map((row) => (
                <li key={row.id} className="space-y-1 p-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/products/${row.product_id}`} className="min-w-0 truncate font-medium">
                      {row.product_name}
                    </Link>
                    <span className={`shrink-0 font-medium tabular-nums ${row.quantity > 0 ? 'text-success' : 'text-destructive'}`}>
                      {row.quantity > 0 ? `+${row.quantity}` : row.quantity}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.sku} · {row.location_name}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{movementTypeLabel(row.movement_type)}</span>
                    <span>balance {row.balance_after}</span>
                    {row.reason ? <span className="truncate">{row.reason}</span> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(row.created_at)} · {row.user_email ?? 'system'}
                  </p>
                </li>
              ))}
            </ul>

            {/* Keyset pagination */}
            <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Page {pageNumber} · {hasFilters ? `${total} matching movements` : totalIsEstimate ? `~${total.toLocaleString('en-IN')} movements (estimate)` : `${total.toLocaleString('en-IN')} movements`}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={goBack} disabled={history.length === 0 || loading} aria-label="Previous page">
                  Back
                </Button>
                <Button variant="outline" size="sm" onClick={goNext} disabled={!hasMore || loading} aria-label="Next page">
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
