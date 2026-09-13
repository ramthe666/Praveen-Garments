'use client'

/**
 * "Look a trend" — the picture version of the reports. Everything a client
 * needs to SEE what happened in a period, without reading a single table:
 * daily sales trend, bills per day, payment mix, category share, top
 * products, top customers and a plain-language highlights card.
 *
 * Pure visualization on top of the EXISTING report RPCs (sales_report,
 * payment_report, catalog_performance_report, product_sales_report) — no
 * new database objects, no migrations, no change to any existing logic.
 * Cancelled bills are excluded everywhere (the RPCs already do this); the
 * cancelled count is fetched separately and shown as its own KPI.
 */
import * as React from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts'
import { toast } from 'sonner'
import {
  Ban,
  CalendarDays,
  Package,
  PieChart as PieIcon,
  Receipt,
  TrendingUp,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import {
  ReportError,
  ReportFilterBar,
  ReportSetupNotice,
  ReportShell,
  SummaryStrip,
} from '@/components/reports/report-shell'
import { EmptyState } from '@/components/shared/empty-state'
import { money, num } from '@/components/reports/config-helpers'
import {
  STORE_TZ,
  downloadCsv,
  periodLabel,
  resolvePeriod,
  type PeriodPreset,
} from '@/lib/reports/shared'
import { createClient } from '@/lib/supabase/client'
import { formatMoney } from '@/lib/catalog/constants'
import { isPermissionDenied, isTableMissing, logError } from '@/lib/errors'

// ---------------------------------------------------------------------------
// RPC result shapes (subset of the fields actually used here)
// ---------------------------------------------------------------------------

type SaleRow = {
  id: string
  sale_number: string
  sale_date: string
  status: string
  payment_status: string
  customer_name: string | null
  grand_total: number
  paid_amount: number
  due_amount: number
}

type SalesReportResult = {
  rows?: SaleRow[]
  total?: number
  summary?: Record<string, number>
}

type MethodRow = { method: string; count: number; amount: number; pct: number }

type PaymentReportResult = {
  inflows?: MethodRow[]
  refunds?: MethodRow[]
  expenses?: MethodRow[]
  supplier_payments?: MethodRow[]
  summary?: Record<string, number>
}

type CatalogRow = {
  id: string
  name: string
  quantity: number
  value: number
  bills: number
  pct: number
}

type CatalogResult = { rows?: CatalogRow[]; summary?: Record<string, number> }

type ProductRow = {
  variant_id: string
  product_name: string
  sku: string
  size_name: string | null
  color_name: string | null
  quantity: number
  revenue: number
  bills: number
}

type ProductSalesResult = { rows?: ProductRow[]; total?: number }

interface TrendData {
  sales: SalesReportResult
  cancelledBills: number
  cancelledValue: number
  payments: PaymentReportResult
  categories: CatalogResult
  products: ProductSalesResult
}

// ---------------------------------------------------------------------------
// Pure aggregation helpers (exported for tests)
// ---------------------------------------------------------------------------

export type DailyPoint = { day: string; label: string; sales: number; bills: number }
export type CustomerAgg = { name: string; total: number; bills: number }

/** Store-local (IST) calendar day of an ISO timestamp — the same boundary
 *  the report RPCs use (0015), so the charts always agree with the tables. */
export function istDayKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

function dayLabel(dayKey: string): string {
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  })
}

/** Daily series with gap-filling: quiet days appear as 0 so the line reads
 *  as a trend instead of scattered dots. Bounded to ~26 months of days;
 *  longer ranges fall back to the days that actually have data. */
export function buildDailySeries(rows: SaleRow[], from: string, to: string): DailyPoint[] {
  const byDay = new Map<string, { sales: number; bills: number }>()
  for (const r of rows) {
    if (!r.sale_date) continue
    const k = istDayKey(String(r.sale_date))
    const agg = byDay.get(k) ?? { sales: 0, bills: 0 }
    agg.sales += Number(r.grand_total ?? 0)
    agg.bills += 1
    byDay.set(k, agg)
  }

  const points: DailyPoint[] = []
  const start = from ? new Date(`${from}T00:00:00Z`) : null
  const end = to ? new Date(`${to}T00:00:00Z`) : null
  const spanDays =
    start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
      ? (end.getTime() - start.getTime()) / 86_400_000
      : Number.NaN

  if (Number.isFinite(spanDays) && spanDays >= 0 && spanDays <= 800) {
    const cursor = new Date(start!.getTime())
    while (cursor.getTime() <= end!.getTime()) {
      const k = cursor.toISOString().slice(0, 10)
      const agg = byDay.get(k) ?? { sales: 0, bills: 0 }
      points.push({
        day: k,
        label: dayLabel(k),
        sales: Math.round(agg.sales * 100) / 100,
        bills: agg.bills,
      })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  } else {
    for (const k of [...byDay.keys()].sort()) {
      const agg = byDay.get(k)!
      points.push({
        day: k,
        label: dayLabel(k),
        sales: Math.round(agg.sales * 100) / 100,
        bills: agg.bills,
      })
    }
  }
  return points
}

export function buildTopCustomers(rows: SaleRow[], limit = 5): CustomerAgg[] {
  const map = new Map<string, CustomerAgg>()
  for (const r of rows) {
    const name = String(r.customer_name ?? '').trim() || 'Walk-in'
    const agg = map.get(name) ?? { name, total: 0, bills: 0 }
    agg.total += Number(r.grand_total ?? 0)
    agg.bills += 1
    map.set(name, agg)
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, limit)
}

/** Compact ₹ axis labels in Indian units: 1.2k / 4.5L / 1.3Cr. */
export function axisMoney(v: number): string {
  const n = Math.abs(Number(v) || 0)
  if (n >= 10000000) return `${(Number(v) / 10000000).toFixed(1)}Cr`
  if (n >= 100000) return `${(Number(v) / 100000).toFixed(1)}L`
  if (n >= 1000) return `${(Number(v) / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return `${Math.round(Number(v))}`
}

// ---------------------------------------------------------------------------
// Data hook — five existing RPCs in parallel, one loading state
// ---------------------------------------------------------------------------

interface DbErrorLike {
  code?: string
  message?: string
}

function useTrendData(from: string, to: string) {
  const supabase = React.useMemo(() => createClient(), [])
  const [data, setData] = React.useState<TrendData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [setupNeeded, setSetupNeeded] = React.useState(false)
  const [nonce, setNonce] = React.useState(0)
  const argKey = JSON.stringify({ from, to })

  React.useEffect(() => {
    let cancelled = false
    const scope = 'reports:trend'
    setLoading(true)
    setError(null)
    void (async () => {
      // Keep rpc bound to the client (supabase.rpc reads `this.rest`).
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        a: Record<string, unknown>,
      ) => PromiseLike<{ data: unknown; error: DbErrorLike | null }>
      const range = { p_date_from: from || null, p_date_to: to || null }
      const [salesRes, cancelledRes, payRes, catRes, prodRes] = await Promise.all([
        rpc('sales_report', { ...range, p_status: 'COMPLETED', p_sort: 'date_desc', p_limit: 10000, p_offset: 0 }),
        rpc('sales_report', { ...range, p_status: 'CANCELLED', p_sort: 'date_desc', p_limit: 1000, p_offset: 0 }),
        rpc('payment_report', range),
        rpc('catalog_performance_report', { ...range, p_group_by: 'category' }),
        rpc('product_sales_report', { ...range, p_sort: 'revenue_desc', p_limit: 10, p_offset: 0 }),
      ])
      if (cancelled) return
      const failed = [salesRes, payRes, catRes, prodRes, cancelledRes].find((r) => r.error)
      if (failed?.error) {
        logError(scope, failed.error)
        setSetupNeeded(isTableMissing(failed.error))
        setError(
          isPermissionDenied(failed.error)
            ? 'You do not have permission to view this report.'
            : 'The report could not be loaded. Please try again.',
        )
        setData(null)
      } else {
        const sales = (salesRes.data as SalesReportResult) ?? {}
        const cancelledSales = (cancelledRes.data as SalesReportResult) ?? {}
        setSetupNeeded(false)
        setError(null)
        setData({
          sales,
          cancelledBills: Number(cancelledSales.total ?? 0),
          cancelledValue: Number(cancelledSales.summary?.gross_sales ?? 0),
          payments: (payRes.data as PaymentReportResult) ?? {},
          categories: (catRes.data as CatalogResult) ?? {},
          products: (prodRes.data as ProductSalesResult) ?? {},
        })
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [supabase, argKey, nonce])

  return {
    data,
    loading,
    error,
    setupNeeded,
    retry: React.useCallback(() => setNonce((n) => n + 1), []),
  }
}

// ---------------------------------------------------------------------------
// Chart subcomponents
// ---------------------------------------------------------------------------

const PIE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

const salesTrendConfig = { sales: { label: 'Sales (₹)', color: 'var(--chart-1)' } } satisfies ChartConfig
const billsConfig = { bills: { label: 'Bills', color: 'var(--chart-2)' } } satisfies ChartConfig
const topProductsConfig = { revenue: { label: 'Net sales (₹)', color: 'var(--chart-3)' } } satisfies ChartConfig

function SalesTrendChart({ daily }: { daily: DailyPoint[] }) {
  return (
    <ChartContainer config={salesTrendConfig} className="aspect-auto h-[240px] w-full">
      <AreaChart data={daily} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="fillSales" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-sales)" stopOpacity={0.7} />
            <stop offset="95%" stopColor="var(--color-sales)" stopOpacity={0.06} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={28}
          interval="preserveStartEnd"
        />
        <YAxis tickLine={false} axisLine={false} width={46} tickFormatter={(v: number) => axisMoney(v)} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(v) => `Sales on ${v}`}
              formatter={(value) => formatMoney(Number(value))}
            />
          }
        />
        <Area
          dataKey="sales"
          type="monotone"
          stroke="var(--color-sales)"
          strokeWidth={2}
          fill="url(#fillSales)"
          dot={false}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ChartContainer>
  )
}

function BillsPerDayChart({ daily }: { daily: DailyPoint[] }) {
  return (
    <ChartContainer config={billsConfig} className="aspect-auto h-[180px] w-full">
      <BarChart data={daily} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={28}
          interval="preserveStartEnd"
        />
        <YAxis tickLine={false} axisLine={false} width={34} allowDecimals={false} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(v) => `Bills on ${v}`}
              formatter={(value) => `${Number(value)} bill${Number(value) === 1 ? '' : 's'}`}
            />
          }
        />
        <Bar dataKey="bills" fill="var(--color-bills)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  )
}

type ShareSlice = { label: string; amount: number }

function donutConfig(slices: ShareSlice[]): ChartConfig {
  const cfg: ChartConfig = {}
  slices.forEach((s, i) => {
    cfg[s.label] = { label: s.label, color: PIE_COLORS[i % PIE_COLORS.length] }
  })
  return cfg
}

function ShareDonutChart({ slices }: { slices: ShareSlice[] }) {
  const config = React.useMemo(() => donutConfig(slices), [slices])
  const total = slices.reduce((s, x) => s + x.amount, 0)
  return (
    <ChartContainer config={config} className="aspect-auto h-[230px] w-full">
      <PieChart>
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(value, name) =>
                `${String(name)}: ${formatMoney(Number(value))} (${total > 0 ? ((Number(value) / total) * 100).toFixed(1) : '0.0'}%)`
              }
            />
          }
        />
        <Pie
          data={slices}
          dataKey="amount"
          nameKey="label"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
          strokeWidth={1}
        >
          {slices.map((s, i) => (
            <Cell key={s.label} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="label" />} className="flex-wrap" />
      </PieChart>
    </ChartContainer>
  )
}

function productLabel(r: ProductRow): string {
  const bits = [r.size_name, r.color_name].filter(Boolean).join(' · ')
  const base = String(r.product_name ?? r.sku ?? '—')
  const label = bits ? `${base} (${bits})` : base
  return label.length > 24 ? `${label.slice(0, 23)}…` : label
}

function TopProductsChart({ rows }: { rows: ProductRow[] }) {
  const data = rows.slice(0, 8).map((r) => ({
    name: productLabel(r),
    revenue: Number(r.revenue ?? 0),
  }))
  return (
    <ChartContainer config={topProductsConfig} className="aspect-auto h-[240px] w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v: number) => axisMoney(v)} />
        <YAxis
          type="category"
          dataKey="name"
          width={126}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent indicator="line" formatter={(value) => formatMoney(Number(value))} />
          }
        />
        <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[0, 4, 4, 0]} barSize={16} />
      </BarChart>
    </ChartContainer>
  )
}

function TopCustomersCard({ customers }: { customers: CustomerAgg[] }) {
  const max = Math.max(...customers.map((c) => c.total), 1)
  return (
    <div className="space-y-3">
      {customers.map((c) => (
        <div key={c.name}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate font-medium">{c.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatMoney(c.total)}</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-[var(--chart-4)]"
              style={{ width: `${Math.max(4, (c.total / max) * 100)}%` }}
            />
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {c.bills} bill{c.bills === 1 ? '' : 's'}
          </p>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Plain-language highlights — the "what has been done" summary
// ---------------------------------------------------------------------------

function HighlightsCard({
  data,
  daily,
  topCustomers,
}: {
  data: TrendData
  daily: DailyPoint[]
  topCustomers: CustomerAgg[]
}) {
  const s = data.sales.summary ?? {}
  const bills = Number(s.bills ?? 0)
  const gross = Number(s.gross_sales ?? 0)
  const activeDays = daily.filter((d) => d.sales > 0).length || daily.length

  const sentences: { icon: LucideIcon; text: string }[] = []
  sentences.push({
    icon: Receipt,
    text: `You billed ${bills.toLocaleString('en-IN')} customer${bills === 1 ? '' : 's'} for ${formatMoney(gross)} across ${activeDays} day${activeDays === 1 ? '' : 's'} — an average of ${formatMoney(Number(s.avg_bill_value ?? 0))} per bill.`,
  })

  const best = daily.reduce<DailyPoint | null>((acc, d) => (!acc || d.sales > acc.sales ? d : acc), null)
  if (best && best.sales > 0) {
    sentences.push({
      icon: TrendingUp,
      text: `Your best day was ${best.label} with ${formatMoney(best.sales)} in sales.`,
    })
  }

  const topCustomer = topCustomers[0]
  if (topCustomer) {
    sentences.push({
      icon: Users,
      text: `Your top customer was ${topCustomer.name} — ${formatMoney(topCustomer.total)} across ${topCustomer.bills} bill${topCustomer.bills === 1 ? '' : 's'}.`,
    })
  }

  const topMethod = (data.payments.inflows ?? [])[0]
  if (topMethod && Number(topMethod.amount) > 0) {
    sentences.push({
      icon: Wallet,
      text: `Customers paid mostly by ${topMethod.method} — ${formatMoney(Number(topMethod.amount))} (${Number(topMethod.pct ?? 0).toFixed(1)}% of money received).`,
    })
  }

  const topCategory = (data.categories.rows ?? [])[0]
  if (topCategory && Number(topCategory.value) > 0) {
    sentences.push({
      icon: PieIcon,
      text: `${topCategory.name} led your sales — ${formatMoney(Number(topCategory.value))} (${Number(topCategory.pct ?? 0).toFixed(1)}% of sales value).`,
    })
  }

  const topProduct = (data.products.rows ?? [])[0]
  if (topProduct && Number(topProduct.revenue) > 0) {
    const bits = [topProduct.size_name, topProduct.color_name].filter(Boolean).join(' · ')
    sentences.push({
      icon: Package,
      text: `Your best-selling product was ${topProduct.product_name}${bits ? ` (${bits})` : ''} — ${Number(topProduct.quantity ?? 0)} units for ${formatMoney(Number(topProduct.revenue))}.`,
    })
  }

  if (data.cancelledBills > 0) {
    sentences.push({
      icon: Ban,
      text: `${data.cancelledBills} bill${data.cancelledBills === 1 ? '' : 's'} worth ${formatMoney(data.cancelledValue)} were cancelled — already excluded from every number above.`,
    })
  }

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="size-4 text-primary" aria-hidden="true" />
          What happened in this period
        </CardTitle>
        <CardDescription>A plain-language summary of the charts below.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2.5">
          {sentences.map((s2, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed">
              <s2.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>{s2.text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

function TrendSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
      <Skeleton className="h-56" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  )
}

export function TrendReportView() {
  const initialPeriod: PeriodPreset = 'this_month'
  const initialRange = resolvePeriod(initialPeriod) ?? { from: '', to: '' }
  const initialFilters = { from: initialRange.from, to: initialRange.to, period: initialPeriod as string }

  const [draft, setDraft] = React.useState<Record<string, string>>({ ...initialFilters })
  const [applied, setApplied] = React.useState<Record<string, string>>({ ...initialFilters })
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)

  const { data, loading, error, setupNeeded, retry } = useTrendData(applied.from, applied.to)

  const daily = React.useMemo(
    () => (data ? buildDailySeries(data.sales.rows ?? [], applied.from, applied.to) : []),
    [data, applied.from, applied.to],
  )
  const topCustomers = React.useMemo(
    () => (data ? buildTopCustomers(data.sales.rows ?? []) : []),
    [data],
  )

  function apply() {
    setApplied({ ...draft })
  }
  function reset() {
    setDraft({ ...initialFilters })
    setApplied({ ...initialFilters })
  }
  function patchDraft(patch: Partial<Record<string, string>>) {
    setDraft((prev) => ({ ...prev, ...patch } as Record<string, string>))
  }

  function exportDailyCsv() {
    if (daily.length === 0) {
      toast.info('Nothing to export for the current period.')
      return
    }
    downloadCsv(
      `trend-${applied.from || 'all'}-${applied.to || 'now'}`,
      ['Date', 'Sales (₹)', 'Bills'],
      daily.map((d) => [d.day, d.sales.toFixed(2), d.bills]),
    )
    toast.success(`Exported ${daily.length} days.`)
  }

  const s = data?.sales.summary
  const p = data?.payments.summary
  const bills = Number(s?.bills ?? 0)
  const capped = data ? Number(data.sales.total ?? 0) > (data.sales.rows ?? []).length : false

  const summaryItems = data
    ? [
        { label: 'Gross sales', value: money(s?.gross_sales), tone: 'positive' as const },
        { label: 'Bills', value: num(s?.bills) },
        { label: 'Avg bill value', value: money(s?.avg_bill_value) },
        { label: 'Money in', value: money(p?.total_inflow) },
        {
          label: 'Dues',
          value: money(s?.due),
          tone: Number(s?.due ?? 0) > 0 ? ('warning' as const) : ('default' as const),
        },
        {
          label: 'Refunds out',
          value: money(p?.total_refund),
          tone: Number(p?.total_refund ?? 0) > 0 ? ('destructive' as const) : ('default' as const),
        },
        {
          label: 'Cancelled bills',
          value: num(data.cancelledBills),
          tone: data.cancelledBills > 0 ? ('destructive' as const) : ('default' as const),
        },
      ]
    : []

  const paymentSlices = (data?.payments.inflows ?? [])
    .map((m) => ({ label: m.method, amount: Number(m.amount ?? 0) }))
    .filter((x) => x.amount > 0)
  const categorySlices = (data?.categories.rows ?? [])
    .slice(0, 6)
    .map((r) => ({ label: r.name, amount: Number(r.value ?? 0) }))
    .filter((x) => x.amount > 0)
  const productRows = data?.products.rows ?? []

  return (
    <ReportShell
      title="Look a trend"
      subtitle={periodLabel('custom', applied.from || null, applied.to || null)}
      onExport={loading ? undefined : exportDailyCsv}
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
        note="All figures exclude cancelled bills. Charts update when you press Apply."
      />

      {setupNeeded ? <ReportSetupNotice /> : null}
      {error ? <ReportError message={error} onRetry={retry} /> : null}

      {loading ? (
        <TrendSkeleton />
      ) : data ? (
        bills === 0 ? (
          <EmptyState
            icon={<TrendingUp />}
            title="No sales in this period"
            description="Pick a different period above, or make some sales — the charts will fill up automatically."
          />
        ) : (
          <div className="space-y-4">
            <SummaryStrip items={summaryItems} />

            <HighlightsCard data={data} daily={daily} topCustomers={topCustomers} />

            <Card className="shadow-xs">
              <CardHeader>
                <CardTitle className="text-base">Sales trend (₹ per day)</CardTitle>
                <CardDescription>
                  Daily sales value including tax, as billed. Quiet days show as zero.
                  {capped ? ' Very long period — the newest 10,000 bills are charted.' : ''}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SalesTrendChart daily={daily} />
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="shadow-xs">
                <CardHeader>
                  <CardTitle className="text-base">Bills per day</CardTitle>
                  <CardDescription>How many bills were raised each day.</CardDescription>
                </CardHeader>
                <CardContent>
                  <BillsPerDayChart daily={daily} />
                </CardContent>
              </Card>

              <Card className="shadow-xs">
                <CardHeader>
                  <CardTitle className="text-base">Top customers</CardTitle>
                  <CardDescription>Biggest spenders in the period (walk-ins included).</CardDescription>
                </CardHeader>
                <CardContent>
                  <TopCustomersCard customers={topCustomers} />
                </CardContent>
              </Card>

              <Card className="shadow-xs">
                <CardHeader>
                  <CardTitle className="text-base">How customers paid</CardTitle>
                  <CardDescription>Share of money received, by payment method.</CardDescription>
                </CardHeader>
                <CardContent>
                  {paymentSlices.length > 0 ? (
                    <ShareDonutChart slices={paymentSlices} />
                  ) : (
                    <EmptyState compact icon={<Wallet />} title="No payments in this period" />
                  )}
                </CardContent>
              </Card>

              <Card className="shadow-xs">
                <CardHeader>
                  <CardTitle className="text-base">Category share</CardTitle>
                  <CardDescription>Share of sales value by product category.</CardDescription>
                </CardHeader>
                <CardContent>
                  {categorySlices.length > 0 ? (
                    <ShareDonutChart slices={categorySlices} />
                  ) : (
                    <EmptyState compact icon={<PieIcon />} title="No category sales in this period" />
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="shadow-xs">
              <CardHeader>
                <CardTitle className="text-base">Top products by net sales</CardTitle>
                <CardDescription>Best-selling product variants in the period.</CardDescription>
              </CardHeader>
              <CardContent>
                {productRows.length > 0 ? (
                  <TopProductsChart rows={productRows} />
                ) : (
                  <EmptyState compact icon={<Package />} title="No product sales in this period" />
                )}
              </CardContent>
            </Card>
          </div>
        )
      ) : null}
    </ReportShell>
  )
}
