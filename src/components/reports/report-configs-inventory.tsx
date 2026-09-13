'use client'

/** Inventory report configs (valuation, fast/slow/dead, current stock, movement). */
import * as React from 'react'
import { toast } from 'sonner'
import { TableReportView, type TableReportConfig, type SummaryItem } from '@/components/reports/table-report-view'
import { BrandFilter, CategoryFilter, LocationFilter } from '@/components/reports/catalog-pickers'
import { FilterSearch, FilterSelect, ReportError, ReportSetupNotice, ReportShell, SummaryStrip } from '@/components/reports/report-shell'
import { ReportTable } from '@/components/reports/report-table'
import { useReportQuery } from '@/components/reports/use-report'
import { downloadCsv, resolvePeriod } from '@/lib/reports/shared'
import { istDayStart, istNextDayStart } from '@/lib/reports/period'
import { money, num, timeCell, MOVEMENT_TYPE_OPTIONS, STOCK_CLASS_OPTIONS, STOCK_STATUS_OPTIONS } from '@/components/reports/config-helpers'

type Row = Record<string, unknown>

// ---------------------------------------------------------------------------
// 1. Stock valuation
// ---------------------------------------------------------------------------

const valuationReport: TableReportConfig<Row> = {
  rpc: 'stock_valuation_report',
  title: 'Stock valuation',
  subtitle: 'Cost, selling and MRP value of stock on hand (point in time)',
  filename: 'stock-valuation',
  emptyTitle: 'No stock on hand',
  hideDateRange: true,
  exportNote: 'Cost basis: weighted average of received purchase lines (net of tax and purchase returns); variants without purchase history use the current cost price.',
  columns: [
    { key: 'product_name', header: 'Product' },
    { key: 'sku', header: 'SKU', render: (r) => <span className="font-mono text-xs">{String(r.sku)}</span> },
    { key: 'size_name', header: 'Size', hide: 'sm', render: (r) => String(r.size_name ?? '—') },
    { key: 'color_name', header: 'Colour', hide: 'md', render: (r) => String(r.color_name ?? '—') },
    { key: 'quantity', header: 'Qty', align: 'right', sortable: true },
    { key: 'cost_value', header: 'Cost value', align: 'right', render: (r) => money(r.cost_value), sortable: true },
    { key: 'selling_value', header: 'Selling value', align: 'right', hide: 'md', render: (r) => money(r.selling_value) },
    { key: 'mrp_value', header: 'MRP value', align: 'right', hide: 'lg', render: (r) => money(r.mrp_value) },
    { key: 'cost_basis', header: 'Cost basis', hide: 'xl', render: (r) => String(r.cost_basis) === 'purchase_average' ? 'Purchase avg' : 'Current cost' },
  ],
  rowKey: (r) => String(r.variant_id),
  pageResult: (data) => data as { rows: Row[]; total: number; summary?: Record<string, number> },
  summary: (s) => [
    { label: 'Variants in stock', value: num(s?.variants) },
    { label: 'Units', value: num(s?.quantity) },
    { label: 'Cost value', value: money(s?.cost_value) },
    { label: 'Selling value', value: money(s?.selling_value) },
    { label: 'MRP value', value: money(s?.mrp_value) },
    { label: 'On purchase-avg cost', value: money(s?.on_purchase_avg_cost) },
  ],
  filterControls: (draft, patch) => (
    <>
      <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="Product or SKU" id="val-search" />
      <CategoryFilter value={draft.category ?? ''} onChange={(v) => patch({ category: v })} />
      <BrandFilter value={draft.brand ?? ''} onChange={(v) => patch({ brand: v })} />
      <LocationFilter value={draft.location ?? ''} onChange={(v) => patch({ location: v })} />
    </>
  ),
  argsFromFilters: (_from, _to, f, page, sort) => ({
    p_location_id: f.location || null,
    p_category_id: f.category || null,
    p_brand_id: f.brand || null,
    p_search: f.search?.trim() || null,
    p_sort: sort || 'cost_desc',
    p_limit: 25,
    p_offset: page * 25,
  }),
  sortOptions: [
    { value: 'cost_desc', label: 'Highest cost value' },
    { value: 'cost_asc', label: 'Lowest cost value' },
    { value: 'selling_desc', label: 'Highest selling value' },
    { value: 'mrp_desc', label: 'Highest MRP value' },
    { value: 'qty_desc', label: 'Most units' },
    { value: 'sku_asc', label: 'SKU A–Z' },
  ],
  defaultSort: 'cost_desc',
}

// ---------------------------------------------------------------------------
// 2. Stock performance (fast / slow / dead)
// ---------------------------------------------------------------------------

const performanceReport: TableReportConfig<Row> = {
  rpc: 'stock_performance_report',
  title: 'Fast / slow / dead movers',
  subtitle: 'Sales velocity per variant over the period',
  filename: 'stock-performance',
  emptyTitle: 'No variants match',
  columns: [
    { key: 'product_name', header: 'Product' },
    { key: 'sku', header: 'SKU', render: (r) => <span className="font-mono text-xs">{String(r.sku)}</span> },
    { key: 'size_name', header: 'Size', hide: 'sm', render: (r) => String(r.size_name ?? '—') },
    { key: 'color_name', header: 'Colour', hide: 'lg', render: (r) => String(r.color_name ?? '—') },
    { key: 'qty_sold', header: 'Qty sold', align: 'right', sortable: true },
    { key: 'revenue', header: 'Revenue', align: 'right', hide: 'md', render: (r) => money(r.revenue), sortable: true },
    { key: 'current_stock', header: 'Stock now', align: 'right', sortable: true },
    { key: 'velocity', header: 'Units/day', align: 'right', hide: 'md' },
    { key: 'class', header: 'Class', render: (r) => <span className="text-xs font-medium">{String(r.class).replaceAll('_', ' ')}</span> },
  ],
  rowKey: (r) => String(r.variant_id),
  pageResult: (data) => data as { rows: Row[]; total: number; summary?: Record<string, number> },
  summary: (s) => [
    { label: 'Fast moving', value: num(s?.fast), tone: 'positive' },
    { label: 'Slow moving', value: num(s?.slow) },
    { label: 'Dead stock', value: num(s?.dead), tone: 'warning' },
    { label: 'Out of stock', value: num(s?.out_of_stock), tone: 'destructive' },
    { label: 'Window days', value: num(s?.total) },
  ],
  filterControls: (draft, patch) => (
    <>
      <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="Product or SKU" id="perf-search" />
      <FilterSelect id="perf-class" label="Class" value={draft.class ?? ''} onChange={(v) => patch({ class: v === '__all__' ? '' : v })} options={STOCK_CLASS_OPTIONS} />
    </>
  ),
  argsFromFilters: (from, to, f, page, sort) => ({
    p_date_from: from || null,
    p_date_to: to || null,
    p_class: f.class || null,
    p_search: f.search?.trim() || null,
    p_sort: sort || 'qty_desc',
    p_limit: 25,
    p_offset: page * 25,
  }),
  sortOptions: [
    { value: 'qty_desc', label: 'Most units sold' },
    { value: 'revenue_desc', label: 'Highest revenue' },
    { value: 'stock_asc', label: 'Lowest stock now' },
    { value: 'stock_desc', label: 'Highest stock now' },
    { value: 'name_asc', label: 'SKU A–Z' },
  ],
  defaultSort: 'qty_desc',
}

// ---------------------------------------------------------------------------
// 3. Current stock status report (reuses stock_page RPC)
// ---------------------------------------------------------------------------

const currentStockReport: TableReportConfig<Row> = {
  rpc: 'stock_page',
  title: 'Current stock',
  subtitle: 'Live stock by variant and location (point in time)',
  filename: 'current-stock',
  emptyTitle: 'No stock records match',
  hideDateRange: true,
  columns: [
    { key: 'sku', header: 'SKU', render: (r) => <span className="font-mono text-xs">{String(r.sku ?? r.variant_sku ?? '')}</span> },
    { key: 'product_name', header: 'Product' },
    { key: 'size_name', header: 'Size', hide: 'sm', render: (r) => String(r.size_name ?? '—') },
    { key: 'color_name', header: 'Colour', hide: 'md', render: (r) => String(r.color_name ?? '—') },
    { key: 'location_name', header: 'Location', hide: 'lg', render: (r) => String(r.location_name ?? '—') },
    { key: 'quantity', header: 'Qty', align: 'right', sortable: true, render: (r) => num(r.quantity) },
    { key: 'status', header: 'Status', render: (r) => <span className="text-xs font-medium">{String(r.status ?? '').replaceAll('_', ' ')}</span> },
  ],
  rowKey: (r, i) => String(r.balance_id ?? r.id ?? i),
  pageResult: (data) => data as { rows: Row[]; total: number },
  filterControls: (draft, patch) => (
    <>
      <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="Product or SKU" id="cs-search" />
      <FilterSelect id="cs-status" label="Stock status" value={draft.status ?? ''} onChange={(v) => patch({ status: v === '__all__' ? '' : v })} options={STOCK_STATUS_OPTIONS} />
      <CategoryFilter value={draft.category ?? ''} onChange={(v) => patch({ category: v })} />
      <BrandFilter value={draft.brand ?? ''} onChange={(v) => patch({ brand: v })} />
      <LocationFilter value={draft.location ?? ''} onChange={(v) => patch({ location: v })} />
    </>
  ),
  argsFromFilters: (_from, _to, f, page) => ({
    p_search: f.search?.trim() || null,
    p_category_id: f.category || null,
    p_brand_id: f.brand || null,
    p_location_id: f.location || null,
    p_status: f.status || null,
    p_limit: 25,
    p_offset: page * 25,
  }),
}

// ---------------------------------------------------------------------------
// 4. Stock movement report (keyset "load more" over stock_history_page)
// ---------------------------------------------------------------------------

export function MovementReportView() {
  const initial = resolvePeriod('this_month') ?? { from: '', to: '' }
  const [draft, setDraft] = React.useState<Record<string, string>>({ ...initial, search: '', type: '', period: 'this_month' })
  const [applied, setApplied] = React.useState<Record<string, string>>({ ...initial, search: '', type: '', period: 'this_month' })
  const [rows, setRows] = React.useState<Row[]>([])
  const [cursor, setCursor] = React.useState<{ created_at: string; id: number } | null>(null)
  const [hasMore, setHasMore] = React.useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)

  const args = React.useMemo(
    () => ({
      // Whole-store-local-day semantics: [from 00:00 IST, to+1 00:00 IST) —
      // the To date is fully INCLUDED (was midnight-exclusive before Phase 8).
      p_date_from: applied.from ? istDayStart(applied.from).toISOString() : null,
      p_date_to: applied.to ? istNextDayStart(applied.to).toISOString() : null,
      p_search: applied.search?.trim() || null,
      p_movement_type: applied.type || null,
      p_limit: 25,
      p_after_created: null,
      p_after_id: null,
    }),
    [applied],
  )
  const argKey = JSON.stringify(args)
  const { data, loading: firstLoading, error, setupNeeded, retry } = useReportQuery<unknown>('stock_history_page', args)
  void argKey

  React.useEffect(() => {
    if (data) {
      const result = data as unknown as { rows?: Row[]; has_more?: boolean; next_cursor?: { created_at: string; id: number } }
      setRows(result.rows ?? [])
      setHasMore(Boolean(result.has_more))
      setCursor(result.next_cursor ?? null)
    }
  }, [data])

  React.useEffect(() => {
    void argKey // keep the memo key explicit for future caching
  }, [argKey])

  async function loadMore() {
    if (!cursor) return
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      fn: string,
      a: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>
    const { data: more, error: e } = await rpc('stock_history_page', {
      p_date_from: args.p_date_from,
      p_date_to: args.p_date_to,
      p_search: args.p_search,
      p_movement_type: args.p_movement_type,
      p_limit: 25,
      p_after_created: cursor.created_at,
      p_after_id: cursor.id,
    })
    if (e) {
      toast.error('Could not load more movements.')
      return
    }
    const result = more as unknown as { rows?: Row[]; has_more?: boolean; next_cursor?: { created_at: string; id: number } }
    setRows((prev) => [...prev, ...(result.rows ?? [])])
    setHasMore(Boolean(result.has_more))
    setCursor(result.next_cursor ?? null)
  }

  function patchDraft(patch: Partial<Record<string, string>>) {
    setDraft((prev) => ({ ...prev, ...patch } as Record<string, string>))
  }

  const summaryItems: SummaryItem[] = [
    { label: 'Movements loaded', value: num(rows.length) },
    { label: 'Net units moved', value: num(rows.reduce((s, r) => s + Number(r.quantity ?? 0), 0)) },
  ]

  function exportCsv() {
    const headers = ['Date', 'SKU', 'Product', 'Type', 'Location', 'Qty', 'Balance after', 'Reason', 'User']
    const cells = rows.map((r) => [
      timeCell(r.created_at), String(r.sku ?? ''), String(r.product_name ?? ''), String(r.movement_type ?? ''),
      String(r.location_name ?? ''), Number(r.quantity ?? 0).toFixed(0), Number(r.balance_after ?? 0).toFixed(0),
      String(r.reason ?? ''), String(r.user_email ?? ''),
    ])
    downloadCsv(`stock-movements-${applied.from || 'all'}`, headers, cells)
    toast.success(`Exported ${rows.length} movements.`)
  }

  return (
    <ReportShell title="Stock movement" subtitle={`${applied.from || 'all'} → ${applied.to || 'now'}`} onExport={exportCsv}>
      <div className="rounded-lg border bg-card p-3 shadow-xs print:hidden">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <label htmlFor="mv-from" className="text-xs font-medium text-muted-foreground">From date</label>
            <input id="mv-from" type="date" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus:ring-1 focus:ring-ring" value={draft.from} onChange={(e) => patchDraft({ from: e.target.value, period: 'custom' })} />
          </div>
          <div className="space-y-1">
            <label htmlFor="mv-to" className="text-xs font-medium text-muted-foreground">To date</label>
            <input id="mv-to" type="date" className="h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus:ring-1 focus:ring-ring" value={draft.to} onChange={(e) => patchDraft({ to: e.target.value, period: 'custom' })} />
          </div>
          <FilterSearch value={draft.search ?? ''} onChange={(v) => patchDraft({ search: v })} placeholder="SKU or product" id="mv-search" />
          <FilterSelect id="mv-type" label="Movement type" value={draft.type ?? ''} onChange={(v) => patchDraft({ type: v === '__all__' ? '' : v })} options={MOVEMENT_TYPE_OPTIONS} />
          <div className="flex items-end gap-2">
            <button className="h-9 flex-1 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90" onClick={() => setApplied({ ...draft })} disabled={!dirty}>
              Apply
            </button>
            <button className="h-9 rounded-md border bg-background px-3 text-sm hover:bg-muted" onClick={() => { const fresh = { ...initial, search: '', type: '', period: 'this_month' }; setDraft(fresh); setApplied(fresh) }}>
              Reset
            </button>
          </div>
        </div>
      </div>

      {setupNeeded ? <ReportSetupNotice /> : null}
      {error ? <ReportError message={error} onRetry={retry} /> : null}

      <SummaryStrip items={summaryItems} />

      <ReportTable<Row>
        columns={[
          { key: 'created_at', header: 'Date', render: (r) => timeCell(r.created_at) },
          { key: 'sku', header: 'SKU', render: (r) => <span className="font-mono text-xs">{String(r.sku ?? '')}</span> },
          { key: 'product_name', header: 'Product' },
          { key: 'movement_type', header: 'Type', hide: 'sm', render: (r) => String(r.movement_type ?? '').replaceAll('_', ' ') },
          { key: 'location_name', header: 'Location', hide: 'lg', render: (r) => String(r.location_name ?? '—') },
          { key: 'quantity', header: 'Qty', align: 'right', render: (r) => num(r.quantity) },
          { key: 'balance_after', header: 'Balance', align: 'right', hide: 'md', render: (r) => num(r.balance_after) },
          { key: 'reason', header: 'Reason', hide: 'xl', render: (r) => String(r.reason ?? '—') },
          { key: 'user_email', header: 'User', hide: 'xl', render: (r) => String(r.user_email ?? '—') },
        ]}
        rows={rows}
        loading={firstLoading}
        emptyTitle="No movements in this period"
        rowKey={(r, i) => String(r.id ?? i)}
      />
      {hasMore ? (
        <div className="flex justify-center print:hidden">
          <button className="rounded-md border bg-background px-4 py-2 text-sm hover:bg-muted" onClick={() => void loadMore()} disabled={firstLoading}>
            Load more
          </button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground print:hidden">
        Keyset-paginated from the append-only stock ledger (25 rows at a time) — deep history never floods the browser.
      </p>
    </ReportShell>
  )
}

export function ValuationReportView() { return <TableReportView config={valuationReport} /> }
export function PerformanceReportView() { return <TableReportView config={performanceReport} /> }
export function CurrentStockReportView() { return <TableReportView config={currentStockReport} /> }
