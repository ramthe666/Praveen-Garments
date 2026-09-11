import { createClient as createPlainClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import {
  isTableMissing,
  isPermissionDenied,
  logError,
} from '@/lib/errors'
import { DEFAULT_COMPANY_NAME } from '@/lib/auth/constants'
import type {
  AppPermission,
  AppSettings,
  AppSettingsKey,
  CompanySettings,
  Database,
  Profile,
  PublicBranding,
  UserRole,
} from '@/types/database'

export interface AppBootstrap {
  dbReady: boolean
  profile: Profile | null
  company: CompanySettings | null
  settings: Partial<AppSettings>
  permissions: AppPermission[]
  branding: { companyName: string; logoUrl: string | null }
}

const FALLBACK_BRANDING = { companyName: DEFAULT_COMPANY_NAME, logoUrl: null }

/**
 * Loads everything the authenticated shell needs in one pass.
 * Never throws: pre-migration states degrade to `dbReady: false`, and each
 * failure is logged (never silently swallowed).
 */
export async function loadAppBootstrap(userId: string): Promise<AppBootstrap> {
  const supabase = await createClient()

  const bootstrap: AppBootstrap = {
    dbReady: true,
    profile: null,
    company: null,
    settings: {},
    permissions: [],
    branding: FALLBACK_BRANDING,
  }

  // 1. Profile (own row is always visible under RLS)
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) {
    if (isTableMissing(profileError)) {
      bootstrap.dbReady = false
    } else if (!isPermissionDenied(profileError)) {
      logError('loadAppBootstrap:profiles', profileError)
    }
  } else {
    bootstrap.profile = profile
  }

  // 2. Company settings (readable by all staff)
  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .limit(1)
    .maybeSingle()

  if (companyError) {
    if (isTableMissing(companyError)) {
      bootstrap.dbReady = false
    } else if (!isPermissionDenied(companyError)) {
      logError('loadAppBootstrap:company_settings', companyError)
    }
  } else {
    bootstrap.company = company
  }

  // 3. Namespaced app settings
  const { data: settingsRows, error: settingsError } = await supabase
    .from('app_settings')
    .select('key, value')

  if (settingsError) {
    if (isTableMissing(settingsError)) {
      bootstrap.dbReady = false
    } else if (!isPermissionDenied(settingsError)) {
      logError('loadAppBootstrap:app_settings', settingsError)
    }
  } else if (settingsRows) {
    for (const row of settingsRows as Array<{ key: AppSettingsKey; value: Record<string, unknown> }>) {
      // Values are validated lightly at consumption time; stored JSONB is
      // admin-controlled so we trust the shape but merge defensively.
      ;(bootstrap.settings as Record<string, unknown>)[row.key] = row.value
    }
  }

  // 4. Permission matrix for the profile's role
  if (profile) {
    const { data: perms, error: permsError } = await supabase
      .from('role_permissions')
      .select('permission')
      .eq('role', profile.role as UserRole)

    if (permsError) {
      if (isTableMissing(permsError)) {
        bootstrap.dbReady = false
      } else if (!isPermissionDenied(permsError)) {
        logError('loadAppBootstrap:role_permissions', permsError)
      }
    } else if (perms) {
      bootstrap.permissions = perms.map((p) => p.permission as AppPermission)
    }
  }

  // 5. Branding (company name/logo for sidebar & titles)
  if (company) {
    bootstrap.branding = {
      companyName: company.company_name || DEFAULT_COMPANY_NAME,
      logoUrl: company.logo_url,
    }
  }

  return bootstrap
}

/**
 * Public (pre-auth) branding for the login screen via get_public_branding().
 *
 * Deliberately uses a plain cookie-less client: the RPC is granted to the
 * anon role by migration 0001, so it works during static prerendering
 * (where `cookies()` is unavailable) — the auth screens stay cacheable
 * while still reading branding from the database (never hardcoded).
 */
let publicBrandingClient: ReturnType<typeof createPlainClient<Database>> | null = null

export async function loadPublicBranding(): Promise<PublicBranding | null> {
  try {
    if (!publicBrandingClient) {
      publicBrandingClient = createPlainClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )
    }
    const { data, error } = await publicBrandingClient.rpc('get_public_branding')
    if (error) {
      // Pre-migration: function does not exist yet — fall back to defaults.
      if (!isTableMissing(error)) logError('loadPublicBranding', error)
      return null
    }
    return (data ?? null) as PublicBranding | null
  } catch (error) {
    logError('loadPublicBranding', error)
    return null
  }
}
