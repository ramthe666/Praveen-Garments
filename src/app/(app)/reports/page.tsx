import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import { NoPermission } from '@/components/shared/no-permission'
import { PageHeader } from '@/components/shared/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { REPORTS, REPORT_GROUPS } from '@/lib/reports/registry'

export const metadata: Metadata = { title: 'Reports' }
export const dynamic = 'force-dynamic'

export default async function ReportsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const bootstrap = await loadAppBootstrap(user!.id)

  if (!bootstrap.dbReady || !bootstrap.permissions.includes('view_reports')) {
    return <NoPermission moduleName="Reports" />
  }

  const available = REPORTS.filter((r) => bootstrap.permissions.includes(r.permission))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Real, database-side reporting on your live data — filter, print and export."
      />

      {REPORT_GROUPS.map((group) => {
        const items = available.filter((r) => r.group === group)
        if (items.length === 0) return null
        return (
          <section key={group} aria-label={group} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{group}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((report) => (
                <Card key={report.slug} className="transition-shadow hover:shadow-md">
                  <Link href={`/reports/${report.slug}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
                    <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-3">
                      <div className="mt-0.5 rounded-md bg-muted p-2">
                        <report.icon className="size-4 text-muted-foreground" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <CardTitle className="text-base">{report.title}</CardTitle>
                        <CardDescription className="leading-snug">{report.description}</CardDescription>
                      </div>
                      <ArrowRight className="ml-auto size-4 shrink-0 self-center text-muted-foreground/50" aria-hidden="true" />
                    </CardHeader>
                  </Link>
                </Card>
              ))}
            </div>
          </section>
        )
      })}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">About these reports</CardTitle>
          <CardDescription>
            Every figure is computed in the database from your live records (no spreadsheets, no stale snapshots).
            Filters apply server-side; exports are bounded to keep large stores fast. Reports that estimate
            (like profit and COGS) say so on the report itself.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Requires the <span className="font-mono text-xs">0012_phase5_reporting</span> migration. If a report shows
            a setup notice, apply the migration in the Supabase SQL editor and reload.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
