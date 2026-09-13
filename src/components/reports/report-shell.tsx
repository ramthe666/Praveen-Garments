'use client'

/**
 * Report shell: back link, title, export/print actions, filter bar with
 * Apply/Reset semantics (heavy report queries never fire per keystroke),
 * and a print area using the global print CSS rules.
 */
import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft, Download, Printer, RotateCcw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent } from '@/components/ui/card'
import { PERIOD_OPTIONS, resolvePeriod, type PeriodPreset } from '@/lib/reports/shared'
import { cn } from '@/lib/utils'

export function ReportShell({
  title,
  subtitle,
  onExport,
  onPrint,
  children,
}: {
  title: string
  subtitle?: string
  onExport?: () => void
  onPrint?: () => void
  children: React.ReactNode
}) {
  // Printed timestamp is computed after mount — a server-rendered clock
  // would differ by seconds and trip React hydration.
  const [printedAt, setPrintedAt] = React.useState<string | null>(null)
  React.useEffect(() => {
    setPrintedAt(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="h-8 px-2">
            <Link href="/reports" aria-label="Back to reports">
              <ArrowLeft className="size-4" aria-hidden="true" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onExport ? (
            <Button variant="outline" size="sm" onClick={onExport}>
              <Download className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => (onPrint ? onPrint() : window.print())}>
            <Printer className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Print</span>
          </Button>
        </div>
      </div>
      <div className="hidden print:block print:mb-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle ? <p className="text-xs text-gray-600">{subtitle}</p> : null}
        <p className="text-xs text-gray-600">
          Praveen Garments{printedAt ? ` — generated ${printedAt}` : ''}
        </p>
      </div>
      <div className="print-area space-y-4">{children}</div>
    </div>
  )
}

/** Setup notice shown when the reporting migration (0012) is not applied yet. */
export function ReportSetupNotice() {
  return (
    <Alert className="print:hidden">
      <AlertTitle>Reporting database is not ready</AlertTitle>
      <AlertDescription>
        Apply the <span className="font-mono text-xs">0012_phase5_reporting.sql</span> migration in your Supabase SQL
        editor to enable this report. All other modules keep working.
      </AlertDescription>
    </Alert>
  )
}

export function ReportError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" className="print:hidden">
      <AlertTitle>Could not load this report</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{message}</span>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

/**
 * Filter bar with date-range presets + custom dates + arbitrary extra
 * controls. Draft state is local; queries only re-run on Apply.
 *
 * Preset selection applies period + from + to ATOMICALLY (one patch) so the
 * Select never flips to "Custom" behind the cashier's back — Phase 8 Part 19
 * fix. Editing a date by hand still switches the period to Custom.
 */
export function ReportFilterBar({
  period,
  onPeriodChange,
  from,
  to,
  onFromChange,
  onToChange,
  onApply,
  onReset,
  dirty,
  children,
  note,
  hideDates,
}: {
  period: PeriodPreset
  onPeriodChange: (p: PeriodPreset) => void
  from: string
  to: string
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
  onApply: () => void
  onReset: () => void
  dirty: boolean
  children?: React.ReactNode
  note?: string
  hideDates?: boolean
}) {
  const resolved = resolvePeriod(period)

  function handlePreset(p: PeriodPreset) {
    const r = resolvePeriod(p)
    // Dates first, period LAST — the per-field handlers force "custom" on
    // date changes, so the preset must win the final state atomically.
    if (r) {
      onFromChange(r.from)
      onToChange(r.to)
    }
    onPeriodChange(p)
  }

  return (
    <div className="rounded-lg border bg-card p-3 shadow-xs print:hidden">
      <div className={cn('grid gap-2', hideDates ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-4')}>
        {hideDates ? null : (
          <>
            <div className="space-y-1">
              <label htmlFor="report-period" className="text-xs font-medium text-muted-foreground">Period</label>
              <Select value={period} onValueChange={(v) => handlePreset(v as PeriodPreset)}>
                <SelectTrigger id="report-period" className="h-9">
                  <SelectValue placeholder="Select period" />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label htmlFor="report-from" className="text-xs font-medium text-muted-foreground">From date</label>
              <Input
                id="report-from"
                type="date"
                className="h-9"
                value={from}
                onChange={(e) => { onFromChange(e.target.value); if (period !== 'custom') onPeriodChange('custom') }}
                aria-label="Report start date"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="report-to" className="text-xs font-medium text-muted-foreground">To date</label>
              <Input
                id="report-to"
                type="date"
                className="h-9"
                value={to}
                onChange={(e) => { onToChange(e.target.value); if (period !== 'custom') onPeriodChange('custom') }}
                aria-label="Report end date"
              />
            </div>
          </>
        )}
        <div className="flex items-end gap-2">
          <Button size="sm" className="h-9 flex-1" onClick={onApply} disabled={!dirty && !resolved}>
            Apply
          </Button>
          <Button size="sm" variant="outline" className="h-9" onClick={onReset}>
            <RotateCcw className="size-4" aria-hidden="true" />
            <span className="sr-only">Reset filters</span>
          </Button>
        </div>
      </div>
      {children ? <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{children}</div> : null}
      <p className="mt-2 text-xs text-muted-foreground">
        {note ? `${note} ` : ''}
        {hideDates ? null : 'The To date is inclusive — the whole store-local day is included.'}
      </p>
    </div>
  )
}

/** Summary strip of small stat cards above a report table. */
export function SummaryStrip({
  items,
  className,
}: {
  items: { label: string; value: React.ReactNode; tone?: 'default' | 'positive' | 'warning' | 'destructive' }[]
  className?: string
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6', className)}>
      {items.map((item) => (
        <Card key={item.label} className="shadow-xs">
          <CardContent className="p-3">
            <p className="truncate text-xs text-muted-foreground">{item.label}</p>
            <p
              className={cn(
                'mt-1 truncate text-sm font-semibold tabular-nums',
                item.tone === 'positive' && 'text-success',
                item.tone === 'warning' && 'text-warning-foreground',
                item.tone === 'destructive' && 'text-destructive',
              )}
            >
              {item.value ?? '—'}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/** Small labeled search input used inside filter bars. */
export function FilterSearch({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  id?: string
}) {
  return (
    <div className="relative space-y-1">
      <label htmlFor={id ?? 'report-search'} className="text-xs font-medium text-muted-foreground">Search</label>
      <Search className="pointer-events-none absolute left-3 top-[calc(50%+2px)] size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        id={id ?? 'report-search'}
        type="search"
        className="h-9 pl-9"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

/** Small labeled select used inside filter bars. */
export function FilterSelect({
  value,
  onChange,
  options,
  label,
  id,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  label: string
  id?: string
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-9">
          <SelectValue placeholder={placeholder ?? 'All'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
