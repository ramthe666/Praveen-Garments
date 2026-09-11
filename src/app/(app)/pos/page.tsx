import type { Metadata } from 'next'
import { PageHeader } from '@/components/shared/page-header'
import { ModuleComingSoon } from '@/components/shared/module-coming-soon'

export const metadata: Metadata = { title: 'POS / Billing' }

export default function PosPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="POS / Billing" description="Foundation ready — module ships in a later phase." />
      <ModuleComingSoon moduleName="POS / Billing" description="Fast item search by SKU/barcode/name, cart with sizes & colours, GST-aware billing, split payments, and instant printable receipts." />
    </div>
  )
}
