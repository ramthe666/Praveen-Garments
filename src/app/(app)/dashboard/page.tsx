import type { Metadata } from 'next'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  IndianRupee,
  PackageX,
  Receipt,
  Shirt,
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
import { Button } from '@/components/ui/button'

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

/**
 * UTC instant of local midnight in the given IANA timezone — keeps
 * "today" correct for stores west/east of UTC (no DST in India, but this
 * works for any configured timezone).
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
    return new Date(new Date().toDateString()) // fall back to server-local midnight
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

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const bootstrap = await loadAppBootstrap(user!.id)

  // Real (small) counts for the setup checklist — RLS-scoped, never fake.
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

  const timezone = bootstrap.company?.timezone || 'Asia/Kolkata'
  const todayLabel = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date())

  // ---- Permissions gate (sales tables are additionally RLS-guarded) ----
  const canViewSales =
    bootstrap.dbReady &&
    (bootstrap.permissions.includes('view_sales') ||
      bootstrap.permissions.includes('create_sale') ||
      bootstrap.permissions.includes('cancel_sale'))
  const canManageCustomers = bootstrap.dbReady && bootstrap.permissions.includes('manage_customers')

  // ---- Live POS stats (Phase 3): today's takings in the store timezone ----
  const dayStart = zonedStartOfDay(timezone).toISOString()
  let todayRevenue: number | null = null
  let todayBills: number | null = null
  let itemsSoldToday: number | null = null
  let pendingDue: number | null = null
  let pendingBills: number | null = null
  let recentSales: RecentSale[] | null = null

  if (canViewSales) {
    const { data: todaySales, error: salesError } = await supabase
      .from('sales')
      .select('id, sale_number, customer_name, grand_total, status, payment_status, sale_date')
      .gte('sale_date', dayStart)
      .neq('status', 'CANCELLED')
      .order('sale_date', { ascending: false })
      .limit(500)
    if (salesError) {
      if (!isTableMissing(salesError)) logError('dashboard:today-sales', salesError)
    } else if (todaySales) {
      todayBills = todaySales.length
      todayRevenue = todaySales.reduce((s, r) => s + Number(r.grand_total ?? 0), 0)
      if (todaySales.length > 0) {
        const ids = todaySales.map((r) => r.id)
        const { data: items, error: itemsError } = await supabase
          .from('sale_items')
          .select('quantity')
          .in('sale_id', ids)
        if (itemsError) {
          if (!isTableMissing(itemsError)) logError('dashboard:today-items', itemsError)
        } else {
          itemsSoldToday = (items ?? []).reduce((s, r) => s + Number(r.quantity ?? 0), 0)
        }
      } else {
        itemsSoldToday = 0
      }
    }

    // Outstanding credit — all non-cancelled bills with a balance (not just today).
    const { data: dueRows, error: dueError } = await supabase
      .from('sales')
      .select('due_amount')
      .neq('status', 'CANCELLED')
      .neq('payment_status', 'PAID')
      .limit(1000)
    if (dueError) {
      if (!isTableMissing(dueError)) logError('dashboard:pending-payments', dueError)
    } else if (dueRows) {
      pendingBills = dueRows.length
      pendingDue = dueRows.reduce((s, r) => s + Number(r.due_amount ?? 0), 0)
    }

    // Recent sales feed (latest five, any date).
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

  // ---- Customer count (permission-gated, RLS double-checks) ----
  let customerCount: number | null = null
  if (canManageCustomers) {
    const { count, error } = await supabase.from('customers').select('*', { count: 'exact', head: true })
    if (error) {
      if (!isTableMissing(error)) logError('dashboard:customers', error)
    } else {
      customerCount = count ?? 0
    }
  }

  // Live inventory stats (Phase 2): low-stock / out-of-stock counts via the
  // indexed get_inventory_stats RPC. Null when the user lacks
  // view_inventory or the Phase 2 migrations are pending.
  let inventoryStats: { low_stock: number | null; out_of_stock: number | null } | null = null
  if (bootstrap.dbReady && bootstrap.permissions.includes('view_inventory')) {
    const { data: statsData, error: statsError } = await supabase.rpc('get_inventory_stats')
    if (statsError) {
      if (!isTableMissing(statsError)) logError('dashboard:inventory-stats', statsError)
    } else if (statsData) {
      inventoryStats = statsData as { low_stock: number | null; out_of_stock: number | null }
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

  // Hint strings resolved before JSX — keeps null-narrowing explicit and readable.
  const salesHint =
    todayRevenue === null || todayBills === null
      ? 'Requires sales access'
      : todayBills === 0
        ? 'No bills yet today'
        : `${todayBills} bill${todayBills > 1 ? 's' : ''} today`
  const pendingHint =
    pendingDue === null || pendingBills === null
      ? 'Requires sales access'
      : pendingBills === 0
        ? 'No outstanding credit'
        : `Across ${pendingBills} bill${pendingBills > 1 ? 's' : ''}`

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={todayLabel}
        actions={
          <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
            <Link href="/pos">
              Open POS
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        }
      />

      {/* ---- Live store statistics (POS / inventory data, permission-scoped) ---- */}
      <section aria-label="Store statistics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Today's Sales"
          icon={<IndianRupee />}
          value={todayRevenue === null ? null : formatMoney(todayRevenue)}
          hint={salesHint}
          variant="hero"
          gradient="bg-gradient-to-br from-emerald-500 to-teal-600"
        />
        <StatCard
          label="Today's Bills"
          icon={<Receipt />}
          value={todayBills}
          hint={todayBills === null ? 'Requires sales access' : 'Completed bills since midnight'}
          variant="hero"
          gradient="bg-gradient-to-br from-violet-500 to-purple-600"
        />
        <StatCard
          label="Items Sold"
          icon={<Shirt />}
          value={itemsSoldToday}
          hint={itemsSoldToday === null ? 'Requires sales access' : 'Units sold today'}
          variant="hero"
          gradient="bg-gradient-to-br from-sky-500 to-blue-600"
        />
        <StatCard
          label="Customers"
          icon={<Users />}
          value={customerCount}
          hint={customerCount === null ? 'Requires customer access' : 'Saved customers'}
          variant="hero"
          gradient="bg-gradient-to-br from-pink-500 to-rose-500"
        />
        <StatCard
          label="Low Stock"
          icon={<AlertTriangle />}
          value={inventoryStats?.low_stock ?? null}
          hint={
            inventoryStats === null
              ? 'Requires inventory access'
              : inventoryStats.low_stock === null
                ? 'Requires inventory access'
                : inventoryStats.low_stock > 0
                  ? 'Variants at or below their reorder level'
                  : 'No items below reorder level'
          }
          tone="warning"
        />
        <StatCard
          label="Out of Stock"
          icon={<PackageX />}
          value={inventoryStats?.out_of_stock ?? null}
          hint={
            inventoryStats === null
              ? 'Requires inventory access'
              : inventoryStats.out_of_stock === null
                ? 'Requires inventory access'
                : inventoryStats.out_of_stock > 0
                  ? 'Variants with zero available stock'
                  : 'Everything is stocked'
          }
          tone="destructive"
        />
        <StatCard
          label="Pending Payments"
          icon={<Wallet />}
          value={pendingDue === null ? null : formatMoney(pendingDue)}
          hint={pendingHint}
          tone="warning"
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
