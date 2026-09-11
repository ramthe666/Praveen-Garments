import type { Metadata } from 'next'
import { PageHeader } from '@/components/shared/page-header'
import { ModuleComingSoon } from '@/components/shared/module-coming-soon'

export const metadata: Metadata = { title: 'Sales' }

export default function SalesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Sales" description="Foundation ready — module ships in a later phase." />
      <ModuleComingSoon moduleName="Sales" description="Complete sales history with invoices, payment status, cancellations with reasons, and customer purchase tracking." />
    </div>
  )
}
