import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError, toUserMessage } from '@/lib/errors'
import type { AuditAction, Profile, UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const patchSchema = z
  .object({
    role: z
      .enum(['admin', 'manager', 'cashier', 'inventory_manager', 'purchase_manager', 'accountant'])
      .optional(),
    is_active: z.boolean().optional(),
    full_name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    branch_id: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' })

/** Long ban duration used for "disabled" accounts (100 years in hours). */
const BAN_DURATION = '876000h'

async function audit(
  admin: ReturnType<typeof createAdminClient>,
  caller: { userId: string; email: string },
  action: AuditAction,
  targetId: string,
  targetEmail: string | null,
  payload: { oldValues?: Record<string, unknown>; newValues?: Record<string, unknown> }
) {
  try {
    await admin.from('audit_logs').insert({
      user_id: caller.userId,
      user_email: caller.email,
      action,
      entity_type: 'profiles',
      entity_id: targetId,
      old_values: (payload.oldValues ?? null) as never,
      new_values: (payload.newValues ?? null) as never,
      metadata: { target_email: targetEmail, via: 'admin_api' },
    })
  } catch (auditError) {
    logError(`api/users/[id]:audit:${action}`, auditError) // non-fatal
  }
}

/**
 * PATCH /api/admin/users/[id] — update role / status / details (Admin only).
 * Disabling also bans the auth user so active sessions cannot refresh.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSessionPermission('manage_users')
  if (!guard.ok) return guard.response

  const { id } = await params
  if (!UUID_RE.test(id)) return jsonError('Invalid user id.', 400)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid request body.', 400)
  }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input.', 422)
  }
  const changes = parsed.data

  const admin = createAdminClient()

  // Current state (for audit + safety checks)
  const { data: existing, error: fetchError } = await admin
    .from('profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (fetchError) {
    logError('api/users/[id]:fetch', fetchError)
    return jsonError(toUserMessage(fetchError), 500)
  }
  if (!existing) return jsonError('User not found.', 404)

  const updates: Partial<Omit<Profile, 'id' | 'created_at' | 'updated_at'>> = {}
  if (changes.role !== undefined) updates.role = changes.role
  if (changes.full_name !== undefined) updates.full_name = changes.full_name
  if (changes.phone !== undefined) updates.phone = changes.phone ?? null
  if (changes.branch_id !== undefined) updates.branch_id = changes.branch_id ?? null
  if (changes.is_active !== undefined) updates.is_active = changes.is_active

  // Auth-level ban/unban must accompany the profile status change.
  if (changes.is_active !== undefined) {
    const { error: banError } = await admin.auth.admin.updateUserById(id, {
      ban_duration: changes.is_active ? 'none' : BAN_DURATION,
    })
    if (banError) {
      logError('api/users/[id]:ban', banError)
      return jsonError(toUserMessage(banError, 'Could not update the account status.'), 400)
    }
  }

  const { data: updated, error: updateError } = await admin
    .from('profiles')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (updateError) {
    logError('api/users/[id]:update', updateError)
    return jsonError(toUserMessage(updateError), 400)
  }

  // Explicit audit rows (actor-attributed; the DB trigger adds row-level logs)
  if (changes.role !== undefined && changes.role !== existing.role) {
    await audit(admin, guard, 'role_changed', id, existing.email, {
      oldValues: { role: existing.role },
      newValues: { role: changes.role },
    })
  }
  if (changes.is_active !== undefined && changes.is_active !== existing.is_active) {
    await audit(admin, guard, changes.is_active ? 'user_enabled' : 'user_disabled', id, existing.email, {
      oldValues: { is_active: existing.is_active },
      newValues: { is_active: changes.is_active },
    })
  }
  if (Object.keys(updates).length > 0) {
    await audit(admin, guard, 'user_updated', id, existing.email, {
      oldValues: { full_name: existing.full_name, phone: existing.phone, branch_id: existing.branch_id },
      newValues: { full_name: updated.full_name, phone: updated.phone, branch_id: updated.branch_id },
    })
  }

  return NextResponse.json({ profile: updated })
}

/**
 * DELETE /api/admin/users/[id] — remove a staff account (Admin only).
 * Deleting the auth user cascades to the profile. Self-deletion is blocked.
 */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSessionPermission('manage_users')
  if (!guard.ok) return guard.response

  const { id } = await params
  if (!UUID_RE.test(id)) return jsonError('Invalid user id.', 400)

  if (id === guard.userId) {
    return jsonError('You cannot delete your own account.', 400)
  }

  const admin = createAdminClient()

  const { data: existing } = await admin.from('profiles').select('*').eq('id', id).maybeSingle()
  if (!existing) return jsonError('User not found.', 404)

  const { error: deleteError } = await admin.auth.admin.deleteUser(id)
  if (deleteError) {
    logError('api/users/[id]:delete', deleteError)
    return jsonError(toUserMessage(deleteError, 'Could not delete the account.'), 400)
  }

  // Fallback cleanup in case the auth user was already gone (profile orphaned)
  await admin.from('profiles').delete().eq('id', id)

  await audit(admin, guard, 'user_deleted', id, existing.email, {
    oldValues: { email: existing.email, full_name: existing.full_name, role: existing.role },
  })

  return NextResponse.json({ ok: true })
}
