import type { Metadata } from 'next'
import { PageHeader } from '@/components/shared/page-header'
import { ModuleComingSoon } from '@/components/shared/module-coming-soon'

export const metadata: Metadata = { title: 'Suppliers' }

export default function SuppliersPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Suppliers" description="Foundation ready — module ships in a later phase." />
      <ModuleComingSoon moduleName="Suppliers" description="Supplier directory with GST details, purchase history, payment terms, and outstanding payables." />
    </div>
  )
}
