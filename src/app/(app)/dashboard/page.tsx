import type { Metadata } from 'next'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Circle,
  Coins,
  IndianRupee,
  PackageX,
  Percent,
  Receipt,
  RotateCcw,
  Shirt,
  ShoppingCart,
  TrendingUp,
  Truck,
  Users,
  Wallet,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import { isTableMissing, logError } from '@/lib/errors'
import { formatMoney } from '@/lib/catalog/constants'
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DashboardPeriodSelect } from '@/components/dashboard/period-select'
import { resolvePeriod, type PeriodPreset } from '@/lib/reports/period'

export const metadata: Metadata = { title: 'Dashboard' }

export const dynamic = 'force-dynamic'

interface ChecklistItem {
  label: string
  done: boolean
  href?: string
  cta?: string
}

interface RecentSale {
  id: string
  sale_number: string
  customer_name: string | null
  grand_total: number
  status: string
  payment_status: string
  sale_date: string
}

interface DashSummary {
  sales: null | {
    bills: number
    items_sold: number
    gross_sales: number
    item_discounts: number
    bill_discounts: number
    tax_collected: number
    round_off: number
    paid_amount: number
    due_amount: number
    returns_value: number
    refunds: number
    exchanges: number
    net_sales: number
    avg_bill_value: number
  }
  purchases: null | { invoices: number; purchase_value: number; purchase_tax: number; returns_value: number }
  expenses: null | { count: number; total: number; pending_total: number; approved_total: number }
  customers: null | { active: number; outstanding: number; advance: number }
  suppliers: null | { active: number; payable: number; advance: number }
  inventory: null | { total_qty: number; cost_value: number; selling_value: number; low_stock?: number; out_of_stock?: number }
  profit: null | { net_sales: number; cogs: number; cost_coverage_pct: number; gross_profit: number; expenses: number; net_profit: number }
}

/**
 * UTC instant of local midnight in the given IANA timezone — keeps
 * "today" correct for any configured timezone.
 */
function zonedStartOfDay(timeZone: string): Date {
  const now = new Date()
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now)
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
    const offset = asUTC - now.getTime()
    return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), 0, 0, 0) - offset)
  } catch {
    return new Date(new Date().toDateString())
  }
}

function timeAgoLabel(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr${hours > 1 ? 's' : ''} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days > 1 ? 's' : ''} ago`
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const bootstrap = await loadAppBootstrap(user!.id)

  const timezone = bootstrap.company?.timezone || 'Asia/Kolkata'
  const periodParam = (typeof sp.period === 'string' ? sp.period : 'today') as PeriodPreset
  const period: PeriodPreset = ['today', 'yesterday', 'this_week', 'this_month', 'this_year', 'custom'].includes(periodParam)
    ? periodParam
    : 'today'
  const range =
    period === 'custom' && typeof sp.from === 'string' && typeof sp.to === 'string'
      ? { from: sp.from, to: sp.to }
      : resolvePeriod(period === 'custom' ? 'today' : period, timezone) ?? { from: '', to: '' }

  const periodText =
    period === 'today'
      ? 'Today'
      : period === 'yesterday'
        ? 'Yesterday'
        : period === 'this_week'
          ? 'This week'
          : period === 'this_month'
            ? 'This month'
            : period === 'this_year'
              ? 'This year'
              : `${range.from} → ${range.to}`

  // ---- One round trip for all stats (Phase 5) ----------------------------
  let summary: DashSummary | null = null
  let summaryPendingMigration = false
  if (bootstrap.dbReady) {
    const { data, error } = await supabase.rpc('dashboard_summary', {
      p_from: range.from || null,
      p_to: range.to || null,
    })
    if (error) {
      if (isTableMissing(error)) {
        summaryPendingMigration = true
      } else {
        logError('dashboard:summary', error)
      }
    } else if (data) {
      summary = data as unknown as DashSummary
    }
  }

  // ---- Fallback (pre-0012 database): today-only direct queries ----------
  const canViewSales =
    bootstrap.dbReady &&
    (bootstrap.permissions.includes('view_sales') ||
      bootstrap.permissions.includes('create_sale') ||
      bootstrap.permissions.includes('cancel_sale'))
  if (!summary && bootstrap.dbReady && canViewSales) {
    const dayStart = zonedStartOfDay(timezone).toISOString()
    const { data: todaySales, error: salesError } = await supabase
      .from('sales')
      .select('grand_total, item_discount_total, bill_discount, tax_total, paid_amount, due_amount, status')
      .gte('sale_date', dayStart)
      .eq('status', 'COMPLETED')
    if (salesError && !isTableMissing(salesError)) logError('dashboard:today-sales', salesError)
    if (todaySales) {
      const gross = todaySales.reduce((s, r) => s + Number(r.grand_total ?? 0), 0)
      const items = 0
      summary = {
        sales: {
          bills: todaySales.length,
          items_sold: items,
          gross_sales: gross,
          item_discounts: todaySales.reduce((s, r) => s + Number(r.item_discount_total ?? 0), 0),
          bill_discounts: todaySales.reduce((s, r) => s + Number(r.bill_discount ?? 0), 0),
          tax_collected: todaySales.reduce((s, r) => s + Number(r.tax_total ?? 0), 0),
          round_off: 0,
          paid_amount: todaySales.reduce((s, r) => s + Number(r.paid_amount ?? 0), 0),
          due_amount: todaySales.reduce((s, r) => s + Number(r.due_amount ?? 0), 0),
          returns_value: 0,
          refunds: 0,
          exchanges: 0,
          net_sales: gross,
          avg_bill_value: todaySales.length > 0 ? gross / todaySales.length : 0,
        },
        purchases: null,
        expenses: null,
        customers: null,
        suppliers: null,
        inventory: null,
        profit: null,
      }
    }
  }

  // ---- Setup checklist (unchanged behaviour) ------------------------------
  let branchCount = 0
  let staffCount: number | null = null
  if (bootstrap.dbReady) {
    const { count, error } = await supabase.from('branches').select('*', { count: 'exact', head: true })
    if (error) {
      if (!isTableMissing(error)) logError('dashboard:branches', error)
    } else {
      branchCount = count ?? 0
    }
    if (bootstrap.permissions.includes('manage_users')) {
      const { count: usersCount, error: usersError } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
      if (usersError) {
        if (!isTableMissing(usersError)) logError('dashboard:profiles', usersError)
      } else {
        staffCount = usersCount ?? 0
      }
    }
  }

  const todayLabel = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date())

  // ---- Recent sales feed ---------------------------------------------------
  let recentSales: RecentSale[] | null = null
  if (canViewSales) {
    const { data: recent, error: recentError } = await supabase
      .from('sales')
      .select('id, sale_number, customer_name, grand_total, status, payment_status, sale_date')
      .order('sale_date', { ascending: false })
      .limit(5)
    if (recentError) {
      if (!isTableMissing(recentError)) logError('dashboard:recent-sales', recentError)
    } else {
      recentSales = (recent ?? []) as RecentSale[]
    }
  }

  const checklist: ChecklistItem[] = [
    { label: 'Apply the Phase 1 database migrations', done: bootstrap.dbReady },
    {
      label: 'Configure your company profile & logo',
      done: Boolean(bootstrap.company && bootstrap.company.company_name && bootstrap.company.phone),
      href: '/settings',
      cta: 'Open settings',
    },
    {
      label: 'Add your first branch / store',
      done: branchCount > 0,
      href: '/settings?tab=branches',
      cta: 'Add branch',
    },
    ...(staffCount === null
      ? []
      : [
          {
            label: 'Create staff accounts with roles',
            done: staffCount > 1,
            href: '/users',
            cta: 'Manage users',
          },
        ]),
  ]
  const completedCount = checklist.filter((c) => c.done).length

  const sales = summary?.sales ?? null
  const salesHint = sales === null ? 'Requires sales access' : sales.bills === 0 ? 'No bills in this period' : `${sales.bills} bill${sales.bills > 1 ? 's' : ''} · avg ${formatMoney(sales.avg_bill_value)}`
  const netTone = sales && sales.net_sales < 0 ? 'destructive' : undefined

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={`${periodText} · ${todayLabel}`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <DashboardPeriodSelect />
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
              <Link href="/pos">
                Open POS
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        }
      />

      {summaryPendingMigration ? (
        <Alert className="print:hidden">
          <AlertTitle>Full dashboard statistics need one more migration</AlertTitle>
          <AlertDescription>
            Showing today's basics. Apply <span className="font-mono text-xs">0012_phase5_reporting.sql</span> in the
            Supabase SQL editor to unlock period analytics, profit and valuation cards.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ---- Live store statistics (permission-scoped sections) ---- */}
      <section aria-label="Store statistics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`${periodText} sales (net)`}
          icon={<IndianRupee />}
          value={sales === null ? null : formatMoney(sales.net_sales)}
          hint={salesHint}
          variant="hero"
          gradient="bg-gradient-to-br from-emerald-500 to-teal-600"
          tone={netTone}
        />
        <StatCard
          label="Bills"
          icon={<Receipt />}
          value={sales?.bills ?? null}
          hint={sales === null ? 'Requires sales access' : 'Completed bills in the period'}
          variant="hero"
          gradient="bg-gradient-to-br from-violet-500 to-purple-600"
        />
        <StatCard
          label="Items sold"
          icon={<Shirt />}
          value={sales?.items_sold ?? null}
          hint={sales === null ? 'Requires sales access' : 'Units sold in the period'}
          variant="hero"
          gradient="bg-gradient-to-br from-sky-500 to-blue-600"
        />
        <StatCard
          label="Gross profit (est.)"
          icon={<TrendingUp />}
          value={summary?.profit ? formatMoney(summary.profit.gross_profit) : null}
          hint={
            summary?.profit
              ? `COGS ${formatMoney(summary.profit.cogs)} · ${summary.profit.cost_coverage_pct}% purchase-cost coverage`
              : 'Requires reports access'
          }
          variant="hero"
          gradient="bg-gradient-to-br from-amber-500 to-orange-600"
        />
        <StatCard label="Gross sales" icon={<IndianRupee />} value={sales ? formatMoney(sales.gross_sales) : null} hint={sales === null ? 'Requires sales access' : 'Total of completed bills'} />
        <StatCard
          label="Discounts"
          icon={<Percent />}
          value={sales ? formatMoney(sales.item_discounts + sales.bill_discounts) : null}
          hint={sales === null ? 'Requires sales access' : 'Item + bill discounts'}
        />
        <StatCard label="Tax collected" icon={<Coins />} value={sales ? formatMoney(sales.tax_collected) : null} hint={sales === null ? 'Requires sales access' : 'Per each bill tax mode'} />
        <StatCard
          label="Returns & refunds"
          icon={<RotateCcw />}
          value={sales ? formatMoney(sales.returns_value) : null}
          hint={sales === null ? 'Requires sales access' : sales.refunds > 0 ? `Refunded ${formatMoney(sales.refunds)}` : 'No refunds'}
          tone="warning"
        />
        <StatCard
          label="Purchases"
          icon={<Truck />}
          value={summary?.purchases ? formatMoney(summary.purchases.purchase_value) : null}
          hint={summary?.purchases ? `${summary.purchases.invoices} received invoices` : 'Requires purchases access'}
        />
        <StatCard
          label="Expenses"
          icon={<Wallet />}
          value={summary?.expenses ? formatMoney(summary.expenses.total) : null}
          hint={summary?.expenses ? `${formatMoney(summary.expenses.pending_total)} pending` : 'Requires expenses access'}
          tone="warning"
        />
        <StatCard
          label="Customer dues"
          icon={<Users />}
          value={summary?.customers ? formatMoney(summary.customers.outstanding) : null}
          hint={summary?.customers ? `${summary.customers.active} active customers` : 'Requires customer access'}
          tone="warning"
        />
        <StatCard
          label="Supplier dues"
          icon={<Truck />}
          value={summary?.suppliers ? formatMoney(summary.suppliers.payable) : null}
          hint={summary?.suppliers ? `${summary.suppliers.active} active suppliers` : 'Requires purchases access'}
          tone="warning"
        />
        <StatCard
          label="Stock value (cost)"
          icon={<Boxes />}
          value={summary?.inventory ? formatMoney(summary.inventory.cost_value) : null}
          hint={summary?.inventory ? `${summary.inventory.total_qty} units on hand` : 'Requires inventory access'}
        />
        <StatCard
          label="Low stock"
          icon={<AlertTriangle />}
          value={summary?.inventory?.low_stock ?? null}
          hint={summary?.inventory === null ? 'Requires inventory access' : 'Variants at or below reorder level'}
          tone="warning"
        />
        <StatCard
          label="Out of stock"
          icon={<PackageX />}
          value={summary?.inventory?.out_of_stock ?? null}
          hint={summary?.inventory === null ? 'Requires inventory access' : 'Variants with zero available stock'}
          tone="destructive"
        />
        <StatCard
          label="Bills pending payment"
          icon={<ShoppingCart />}
          value={sales ? formatMoney(sales.due_amount) : null}
          hint={sales === null ? 'Requires sales access' : sales.due_amount > 0 ? 'Credit outstanding this period' : 'All bills settled'}
          tone={sales && sales.due_amount > 0 ? 'warning' : undefined}
        />
      </section>

      {/* ---- Recent sales (live POS activity) ---- */}
      {recentSales !== null ? (
        <section aria-label="Recent sales">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div className="space-y-1.5">
                <CardTitle className="text-base">Recent bills</CardTitle>
                <CardDescription>The latest sales recorded at your counters.</CardDescription>
              </div>
              <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
                <Link href="/sales">
                  View all
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {recentSales.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No bills yet — open the POS to record the first sale.
                </p>
              ) : (
                <ul className="divide-y">
                  {recentSales.map((sale) => (
                    <li key={sale.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                      <Link
                        href={`/sales/${sale.id}`}
                        className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline"
                      >
                        {sale.sale_number}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {sale.customer_name?.trim() || 'Walk-in'}
                        </span>
                      </Link>
                      <span
                        className={
                          sale.status === 'CANCELLED'
                            ? 'text-xs font-medium text-destructive'
                            : sale.payment_status === 'PAID'
                              ? 'text-xs font-medium text-success'
                              : 'text-xs font-medium text-warning-foreground'
                        }
                      >
                        {sale.status === 'CANCELLED'
                          ? 'Cancelled'
                          : sale.payment_status === 'PAID'
                            ? 'Paid'
                            : sale.payment_status === 'PARTIALLY_PAID'
                              ? 'Partially paid'
                              : 'Due'}
                      </span>
                      <span className="w-20 text-right text-sm tabular-nums">
                        {formatMoney(Number(sale.grand_total))}
                      </span>
                      <span className="hidden w-24 text-right text-xs text-muted-foreground sm:block">
                        {timeAgoLabel(sale.sale_date)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      ) : null}

      {/* ---- Getting started ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Getting started</CardTitle>
          <CardDescription>
            Complete these steps to prepare {bootstrap.branding.companyName} for daily operations.
            {completedCount > 0 ? ` ${completedCount} of ${checklist.length} done.` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {checklist.map((item) => (
              <li key={item.label} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {item.done ? (
                  <CheckCircle2 className="size-4.5 shrink-0 text-success" aria-hidden="true" />
                ) : (
                  <Circle className="size-4.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                )}
                <span
                  className={
                    item.done
                      ? 'min-w-0 flex-1 text-sm text-muted-foreground line-through decoration-muted-foreground/40'
                      : 'min-w-0 flex-1 text-sm text-foreground'
                  }
                >
                  {item.label}
                </span>
                {!item.done && item.href && item.cta ? (
                  <Button asChild variant="link" size="sm" className="h-auto p-0 text-[13px]">
                    <Link href={item.href}>{item.cta}</Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
