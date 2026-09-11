import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LabelsView } from '@/components/labels/labels-view'
import { NoPermission } from '@/components/shared/no-permission'
import { LoadingPanel } from '@/components/shared/loading'
import { AppProvider } from '@/components/providers/app-provider'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import type { AppContextData } from '@/components/providers/app-provider'

export const metadata: Metadata = { title: 'Print labels' }
export const dynamic = 'force-dynamic'

export default async function LabelsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const bootstrap = await loadAppBootstrap(user.id)
  if (!bootstrap.permissions.includes('view_inventory')) {
    return <NoPermission moduleName="label printing" />
  }

  const contextData: AppContextData = {
    userId: user.id,
    userEmail: user.email ?? bootstrap.profile?.email ?? '',
    profile: bootstrap.profile,
    permissions: bootstrap.permissions,
    companyName: bootstrap.branding.companyName,
    logoUrl: bootstrap.branding.logoUrl,
    settings: bootstrap.settings,
    dbReady: bootstrap.dbReady,
  }

  return (
    <AppProvider data={contextData}>
      {/* LabelsView reads search params (variant preselect) — Suspense keeps
          this page renderable during streaming. */}
      <Suspense fallback={<LoadingPanel rows={4} />}>
        <LabelsView />
      </Suspense>
    </AppProvider>
  )
}
