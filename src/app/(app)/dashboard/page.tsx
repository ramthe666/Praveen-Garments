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
import { PageHeader } from '@/components/shared/page-header'
import { StatCard } from '@/components/shared/stat-card'
import { EmptyState } from '@/components/shared/empty-state'
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

      {/* ---- Statistic cards (real aggregates arrive with future phases) ---- */}
      <section aria-label="Store statistics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Today's Sales"
          icon={<IndianRupee />}
          value={null}
          hint="Available when the Sales module goes live"
        />
        <StatCard
          label="Today's Bills"
          icon={<Receipt />}
          value={null}
          hint="Available when the POS module goes live"
        />
        <StatCard
          label="Items Sold"
          icon={<Shirt />}
          value={null}
          hint="Available when the Sales module goes live"
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
          label="Customers"
          icon={<Users />}
          value={null}
          hint="Available when Customer management goes live"
        />
        <StatCard
          label="Pending Payments"
          icon={<Wallet />}
          value={null}
          hint="Available when Sales &amp; payments go live"
          tone="warning"
        />
      </section>

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

      {/* ---- Recent activity placeholder ---- */}
      <section aria-label="Recent activity">
        <EmptyState
          icon={<Receipt />}
          title="No activity yet"
          description="Sales, returns and stock movements will appear here once the billing modules go live in the next phase."
        />
      </section>
    </div>
  )
}
