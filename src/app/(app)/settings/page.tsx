import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import { NoPermission } from '@/components/shared/no-permission'
import { SetupNotice } from '@/components/shared/setup-notice'
import { SettingsView } from '@/components/settings/settings-view'
import type { AppSettings, CompanySettings, RolePermission } from '@/types/database'

export const metadata: Metadata = { title: 'Settings' }

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const bootstrap = await loadAppBootstrap(user!.id)

  if (!bootstrap.dbReady) {
    return (
      <div className="space-y-4">
        <NoPermission moduleName="Settings" />
        <SetupNotice />
      </div>
    )
  }
  if (!bootstrap.permissions.includes('manage_settings')) {
    return <NoPermission moduleName="Settings" />
  }

  // Permission matrix (read-only foundation)
  const { data: rolePerms } = await supabase.from('role_permissions').select('role, permission')
  const rolePermissions = (rolePerms ?? []) as RolePermission[]

  return (
    <SettingsView
      initialCompany={bootstrap.company}
      initialSettings={bootstrap.settings}
      rolePermissions={rolePermissions}
    />
  )
}
