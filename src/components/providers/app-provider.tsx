'use client'

import * as React from 'react'
import type { AppPermission, AppSettings, Profile } from '@/types/database'

/**
 * Serializable context data — safe to pass from server components across the
 * RSC boundary (contains NO functions).
 */
export interface AppContextData {
  userId: string
  userEmail: string
  profile: Profile | null
  permissions: AppPermission[]
  companyName: string
  logoUrl: string | null
  settings: Partial<AppSettings>
  dbReady: boolean
}

export interface AppContextValue extends AppContextData {
  hasPermission: (permission: AppPermission) => boolean
}

const AppContext = React.createContext<AppContextValue | null>(null)

/**
 * Provides user/permission/branding data to the client tree. `hasPermission`
 * is derived here (client-side) from the permissions array so the data
 * crossing the RSC boundary stays 100% serializable.
 */
export function AppProvider({
  data,
  children,
}: {
  data: AppContextData
  children: React.ReactNode
}) {
  const value = React.useMemo<AppContextValue>(
    () => ({
      ...data,
      hasPermission: (permission: AppPermission) => data.permissions.includes(permission),
    }),
    [data]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = React.useContext(AppContext)
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider (authenticated shell)')
  }
  return ctx
}

/** Convenience hook for permission checks in client components. */
export function usePermission(permission: AppPermission): boolean {
  return useApp().hasPermission(permission)
}
