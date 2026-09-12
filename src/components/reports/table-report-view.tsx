'use client'

/**
 * Generic paged table report view. One component drives all "table +
 * summary + filters" reports (sales, product sales, purchases, customers,
 * suppliers, valuation, stock performance, audit log) from a config object.
 * Filters are draft state — heavy queries only re-run on Apply (Part 18).
 */
import * as React from 'react'
import { toast } from 'sonner'
import type { ReportColumn } from '@/lib/reports/shared'
import {
  downloadCsv,
  periodLabel,
  resolvePeriod,
  type PageResult,
  type PeriodPreset,
} from '@/lib/reports/shared'
import { ReportFilterBar, ReportSetupNotice, ReportError, ReportShell, SummaryStrip } from '@/components/reports/report-shell'
import { ReportTable } from '@/components/reports/report-table'
import { fetchReportExport, useReportQuery } from '@/components/reports/use-report'

export interface SummaryItem {
  label: string
  value: React.ReactNode
  tone?: 'default' | 'positive' | 'warning' | 'destructive'
}

export interface TableReportConfig<T extends Record<string, unknown>> {
  rpc: string
  title: string
  subtitle: string
  filename: string
  columns: ReportColumn<T>[]
  rowKey: (row: T, index: number) => string
  pageResult: (data: unknown) => PageResult<T>
  summary?: (summary: Record<string, number> | undefined, data: PageResult<T> | null) => SummaryItem[]
  /** Extra filter controls (selects / search) rendered into the filter bar. */
  filterControls?: (draft: Record<string, string>, setDraft: (patch: Partial<Record<string, string>>) => void) => React.ReactNode
  initialFilters?: Record<string, string>
  argsFromFilters: (from: string, to: string, filters: Record<string, string>, page: number, sort: string) => Record<string, unknown>
  sortOptions?: { value: string; label: string }[]
  defaultSort?: string
  emptyTitle?: string
  emptyDescription?: string
  exportNote?: string
  /** Point-in-time reports (valuation, current stock) hide the date range. */
  hideDateRange?: boolean
}

export function TableReportView<T extends Record<string, unknown>>({ config }: { config: TableReportConfig<T> }) {
  const initialPeriod: PeriodPreset = 'this_month'
  const initialRange = resolvePeriod(initialPeriod) ?? { from: '', to: '' }
  const initialFilters = { from: initialRange.from, to: initialRange.to, ...config.initialFilters }

  const [draft, setDraft] = React.useState<Record<string, string>>({
    ...initialFilters,
    period: initialPeriod,
  })
  const [applied, setApplied] = React.useState<Record<string, string>>({
    ...initialFilters,
    period: initialPeriod,
  })
  const [page, setPage] = React.useState(0)
  const [sort, setSort] = React.useState(config.defaultSort ?? '')
  const [exporting, setExporting] = React.useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)

  const args = React.useMemo(
    () => config.argsFromFilters(applied.from, applied.to, applied, page, sort),
    [config, applied, page, sort],
  )
  const { data, loading, error, setupNeeded, retry } = useReportQuery<unknown>(config.rpc, args)
  const result = React.useMemo(() => (data ? config.pageResult(data) : null), [data, config])

  const pageSize = 25

  function apply() {
    setApplied({ ...draft })
    setPage(0)
  }
  function reset() {
    const fresh = { ...initialFilters, period: initialPeriod }
    setDraft(fresh)
    setApplied(fresh)
    setPage(0)
    setSort(config.defaultSort ?? '')
  }
  function patchDraft(patch: Partial<Record<string, string>>) {
    setDraft((prev) => ({ ...prev, ...patch } as Record<string, string>))
  }

  async function exportCsv() {
    setExporting(true)
    try {
      const out = await fetchReportExport<Record<string, unknown>>(config.rpc, args)
      if ('error' in out) {
        toast.error(out.error)
        return
      }
      if (out.total > out.rows.length) {
        toast.warning(`Export limited to the first ${out.rows.length} of ${out.total} rows.`)
      }
      if (out.rows.length === 0) {
        toast.info('Nothing to export for the current filters.')
        return
      }
      const headers = config.columns.map((c) => c.header)
      const cells = out.rows.map((row) =>
        config.columns.map((c) => {
          const v = c.csv ? c.csv(row as T) : row[c.key]
          return v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(2) : String(v)
        }),
      )
      downloadCsv(`${config.filename}-${applied.from || 'all'}-${applied.to || 'now'}`, headers, cells)
      toast.success(`Exported ${out.rows.length} rows.`)
    } finally {
      setExporting(false)
    }
  }

  const summaryItems = result ? config.summary?.(result.summary, result) ?? [] : []

  return (
    <ReportShell
      title={config.title}
      subtitle={periodLabel('custom', applied.from || null, applied.to || null)}
      onExport={exporting ? undefined : exportCsv}
    >
      <ReportFilterBar
        period={(draft.period as PeriodPreset) ?? 'this_month'}
        onPeriodChange={(p) => patchDraft({ period: p })}
        from={draft.from}
        to={draft.to}
        onFromChange={(v) => patchDraft({ from: v, period: 'custom' })}
        onToChange={(v) => patchDraft({ to: v, period: 'custom' })}
        onApply={apply}
        onReset={reset}
        dirty={dirty}
        note={config.exportNote}
        hideDates={config.hideDateRange}
      >
        {config.filterControls?.(draft, patchDraft)}
        {config.sortOptions?.length ? (
          <div className="space-y-1">
            <label htmlFor="report-sort" className="text-xs font-medium text-muted-foreground">Sort by</label>
            <select
              id="report-sort"
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus:ring-1 focus:ring-ring"
              value={sort}
              onChange={(e) => { setSort(e.target.value); setPage(0) }}
            >
              {config.sortOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        ) : null}
      </ReportFilterBar>

      {setupNeeded ? <ReportSetupNotice /> : null}
      {error ? <ReportError message={error} onRetry={retry} /> : null}

      {summaryItems.length > 0 && (result || loading) ? (
        <SummaryStrip items={loading && !result ? placeholderItems(summaryItems) : summaryItems} />
      ) : null}

      <ReportTable<T>
        columns={config.columns}
        rows={result?.rows ?? []}
        loading={loading}
        emptyTitle={config.emptyTitle ?? 'No records found'}
        emptyDescription={config.emptyDescription}
        page={page + 1}
        pageSize={pageSize}
        total={result?.total ?? 0}
        onPageChange={(p) => setPage(p - 1)}
        rowKey={config.rowKey}
      />
    </ReportShell>
  )
}

function placeholderItems(items: SummaryItem[]): SummaryItem[] {
  return items.map((i) => ({ ...i, value: '…' }))
}
