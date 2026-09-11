import type { Metadata } from 'next'
import { PageHeader } from '@/components/shared/page-header'
import { ModuleComingSoon } from '@/components/shared/module-coming-soon'

export const metadata: Metadata = { title: 'Customers' }

export default function CustomersPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Customers" description="Foundation ready — module ships in a later phase." />
      <ModuleComingSoon moduleName="Customers" description="Customer directory with phone-first search, purchase history, credit limits, outstanding balances, and loyalty." />
    </div>
  )
}
