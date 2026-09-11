import type { Metadata } from 'next'
import { PageHeader } from '@/components/shared/page-header'
import { ModuleComingSoon } from '@/components/shared/module-coming-soon'

export const metadata: Metadata = { title: 'Purchases' }

export default function PurchasesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Purchases" description="Foundation ready — module ships in a later phase." />
      <ModuleComingSoon moduleName="Purchases" description="Supplier purchase orders, goods receipt with quality check, purchase returns, and automatic stock additions." />
    </div>
  )
}
