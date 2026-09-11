import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { logError } from '@/lib/errors'
import type { AppPermission } from '@/types/database'

export type GuardResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; response: NextResponse }

/**
 * Route-handler guard: authenticates the caller via their session cookie and
 * authorizes the required permission through the database
 * (has_app_permission RPC + role_permissions table). Frontend checks are
 * never the only line of defense — this runs server-side on every admin API
 * call, and RLS guards direct table access on top.
 */
export async function requireSessionPermission(permission: AppPermission): Promise<GuardResult> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }),
    }
  }

  const { data: allowed, error } = await supabase.rpc('has_app_permission', { p: permission })

  if (error) {
    // Most common cause: Phase 1 migrations not applied yet.
    logError(`guard:${permission}`, error)
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Database authorization is unavailable. Apply the pending migrations first.' },
        { status: 503 }
      ),
    }
  }

  if (!allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'You do not have permission to perform this action.' }, { status: 403 }),
    }
  }

  return { ok: true, userId: user.id, email: user.email ?? '' }
}

/** Standard JSON error body for route handlers. */
export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}
