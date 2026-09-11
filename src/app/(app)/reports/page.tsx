import type { Metadata } from 'next'
import { PageHeader } from '@/components/shared/page-header'
import { ModuleComingSoon } from '@/components/shared/module-coming-soon'

export const metadata: Metadata = { title: 'Reports' }

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description="Foundation ready — module ships in a later phase." />
      <ModuleComingSoon moduleName="Reports" description="Sales, stock, GST, profit and staff performance reports with date-range filters and exports." />
    </div>
  )
}
