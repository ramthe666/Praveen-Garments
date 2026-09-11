import type { Metadata } from 'next'
import { PageHeader } from '@/components/shared/page-header'
import { ModuleComingSoon } from '@/components/shared/module-coming-soon'

export const metadata: Metadata = { title: 'Expenses' }

export default function ExpensesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Expenses" description="Foundation ready — module ships in a later phase." />
      <ModuleComingSoon moduleName="Expenses" description="Day-to-day business expense recording with categories, attachments, and monthly summaries." />
    </div>
  )
}
