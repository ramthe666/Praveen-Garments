'use client'

/**
 * Generic breakdown report view: one RPC returns a JSON object with several
 * keyed sections (arrays of small rows) + summary numbers. Drives the
 * payment / GST / profit / expense / returns / cash reports from config.
 */
import * as React from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/shared/empty-state'
import type { ReportColumn } from '@/lib/reports/shared'
import { downloadCsv, periodLabel, resolvePeriod, type PeriodPreset } from '@/lib/reports/shared'
import { ReportError, ReportSetupNotice, ReportShell, SummaryStrip } from '@/components/reports/report-shell'
import { FilterSearch, FilterSelect, ReportFilterBar } from '@/components/reports/report-shell'
import { useReportQuery } from '@/components/reports/use-report'
import { cn } from '@/lib/utils'
import { colHidden } from '@/lib/reports/shared'
import type { SummaryItem } from '@/components/reports/table-report-view'

export interface SectionDef<T extends Record<string, unknown>> {
  key: string
  title: string
  description?: string
  columns: ReportColumn<T>[]
  rows: (data: Record<string, unknown>) => T[]
  rowKey: (row: T, index: number) => string
  footer?: (rows: T[]) => React.ReactNode
  note?: string
}

export interface SectionReportConfig {
  rpc: string
  title: string
  subtitle: string
  filename: string
  summary?: (data: Record<string, unknown> | null) => SummaryItem[]
  sections: SectionDef<Record<string, unknown>>[]
  initialFilters?: Record<string, string>
  argsFromFilters: (from: string, to: string, filters: Record<string, string>) => Record<string, unknown>
  searchPlaceholder?: string
  selectFilters?: { key: string; label: string; options: { value: string; label: string }[] }[]
  note?: string
}

export function SectionReportView({ config }: { config: SectionReportConfig }) {
  const initialPeriod: PeriodPreset = 'this_month'
  const initialRange = resolvePeriod(initialPeriod) ?? { from: '', to: '' }
  const initialFilters = { from: initialRange.from, to: initialRange.to, ...config.initialFilters, period: initialPeriod }

  const [draft, setDraft] = React.useState<Record<string, string>>(initialFilters)
  const [applied, setApplied] = React.useState<Record<string, string>>(initialFilters)
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)

  const args = React.useMemo(
    () => config.argsFromFilters(applied.from, applied.to, applied),
    [config, applied],
  )
  const { data, loading, error, setupNeeded, retry } = useReportQuery<Record<string, unknown>>(config.rpc, args)

  function patchDraft(patch: Partial<Record<string, string>>) {
    setDraft((prev) => ({ ...prev, ...patch } as Record<string, string>))
  }
  function apply() { setApplied({ ...draft }) }
  function reset() {
    const fresh = { ...initialFilters }
    setDraft(fresh)
    setApplied(fresh)
  }

  const summaryItems = config.summary?.(data) ?? []

  function exportCsv() {
    if (!data) {
      toast.info('Nothing to export yet.')
      return
    }
    const lines: string[] = []
    for (const section of config.sections) {
      const rows = section.rows(data)
      if (rows.length === 0) continue
      lines.push(`# ${section.title}`)
      lines.push(section.columns.map((c) => escapeCol(c.header)).join(','))
      for (const row of rows) {
        lines.push(
          section.columns
            .map((c) => {
              const v = c.csv ? c.csv(row) : row[c.key]
              return escapeCol(typeof v === 'number' ? v.toFixed(2) : v)
            })
            .join(','),
        )
      }
      lines.push('')
    }
    if (lines.length === 0) {
      toast.info('Nothing to export for the current filters.')
      return
    }
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${config.filename}-${applied.from || 'all'}-${applied.to || 'now'}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast.success('Export ready.')
  }

  function escapeCol(v: unknown): string {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }

  return (
    <ReportShell
      title={config.title}
      subtitle={periodLabel('custom', applied.from || null, applied.to || null)}
      onExport={exportCsv}
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
        note={config.note}
      >
        {config.searchPlaceholder ? (
          <FilterSearch
            value={draft.search ?? ''}
            onChange={(v) => patchDraft({ search: v })}
            placeholder={config.searchPlaceholder}
          />
        ) : null}
        {config.selectFilters?.map((f) => (
          <FilterSelect
            key={f.key}
            id={`filter-${f.key}`}
            label={f.label}
            value={draft[f.key] ?? ''}
            onChange={(v) => patchDraft({ [f.key]: v === '__all__' ? '' : v })}
            options={f.options}
          />
        ))}
      </ReportFilterBar>

      {setupNeeded ? <ReportSetupNotice /> : null}
      {error ? <ReportError message={error} onRetry={retry} /> : null}

      {summaryItems.length > 0 ? (
        loading && !data ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {summaryItems.map((i) => (
              <Card key={i.label} className="shadow-xs"><CardContent className="p-3"><Skeleton className="h-10 w-full" /></CardContent></Card>
            ))}
          </div>
        ) : (
          <SummaryStrip items={summaryItems} />
        )
      ) : null}

      {config.sections.map((section) => {
        const rows = data ? section.rows(data) : []
        return (
          <Card key={section.key} className="shadow-xs">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{section.title}</CardTitle>
              {section.description ? <CardDescription>{section.description}</CardDescription> : null}
            </CardHeader>
            <CardContent className="p-0">
              {loading && !data ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
                </div>
              ) : rows.length === 0 ? (
                <EmptyState title="Nothing in this period" description="No records matched the selected range." compact />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-y text-left text-xs text-muted-foreground">
                        {section.columns.map((c) => (
                          <th
                            key={c.key}
                            scope="col"
                            className={cn('px-3 py-2.5 font-medium', c.align === 'right' && 'text-right', colHidden(c.hide))}
                          >
                            {c.header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map((row, i) => (
                        <tr key={section.rowKey(row, i)} className="hover:bg-muted/40">
                          {section.columns.map((c) => (
                            <td
                              key={c.key}
                              className={cn('px-3 py-2.5', c.align === 'right' && 'text-right tabular-nums', colHidden(c.hide))}
                            >
                              {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                    {section.footer && rows.length > 0 ? (
                      <tfoot className="border-t bg-muted/30 font-medium">{section.footer(rows)}</tfoot>
                    ) : null}
                  </table>
                </div>
              )}
              {section.note ? <p className="px-3 pb-3 pt-2 text-xs text-muted-foreground">{section.note}</p> : null}
            </CardContent>
          </Card>
        )
      })}
    </ReportShell>
  )
}

// Re-export for config files
export { downloadCsv }
