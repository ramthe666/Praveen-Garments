import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import { NoPermission } from '@/components/shared/no-permission'
import { reportBySlug } from '@/lib/reports/registry'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ report: string }> }): Promise<Metadata> {
  const { report } = await params
  const def = reportBySlug(report)
  return { title: def ? `${def.title} — Reports` : 'Reports' }
}

export default async function ReportDetailPage({ params }: { params: Promise<{ report: string }> }) {
  const { report } = await params
  const def = reportBySlug(report)
  if (!def) notFound()

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const bootstrap = await loadAppBootstrap(user!.id)

  if (!bootstrap.dbReady || !bootstrap.permissions.includes(def.permission)) {
    return <NoPermission moduleName={def.title} />
  }

  const { View } = def
  return <View />
}
