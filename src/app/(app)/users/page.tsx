import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { loadAppBootstrap } from '@/lib/data/app-data'
import { NoPermission } from '@/components/shared/no-permission'
import { SetupNotice } from '@/components/shared/setup-notice'
import { UsersView } from '@/components/users/users-view'

export const metadata: Metadata = { title: 'Users' }

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const bootstrap = await loadAppBootstrap(user!.id)

  if (!bootstrap.dbReady) {
    return (
      <div className="space-y-4">
        <NoPermission moduleName="Users" />
        <SetupNotice />
      </div>
    )
  }
  if (!bootstrap.permissions.includes('manage_users')) {
    return <NoPermission moduleName="Users" />
  }

  return <UsersView currentUserId={user!.id} />
}
