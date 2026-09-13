import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError, toUserMessage, isServiceKeyRejected, SERVICE_KEY_INVALID_MESSAGE } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const schema = z.object({
  mode: z.enum(['email', 'password']),
  password: z.string().min(8).max(64).optional(),
})

/**
 * POST /api/admin/users/[id]/password — credential recovery helpers.
 *  mode=email    → send a password-reset email (requires SMTP on Supabase)
 *  mode=password → admin directly sets a new password
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input.', 422)
  }
  if (parsed.data.mode === 'password' && !parsed.data.password) {
    return jsonError('Provide the new password.', 422)
  }

  const admin = createAdminClient()
  const { data: existing, error: lookupError } = await admin.from('profiles').select('email').eq('id', id).maybeSingle()
  if (lookupError) {
    logError('api/users/[id]/password:lookup', lookupError)
    if (isServiceKeyRejected(lookupError)) {
      return jsonError(SERVICE_KEY_INVALID_MESSAGE, 503)
    }
    return jsonError('Could not read the user account. Please try again.', 500)
  }
  if (!existing?.email) return jsonError('User not found.', 404)

  if (parsed.data.mode === 'email') {
    const { error: linkError } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: existing.email,
    })
    if (linkError) {
      logError('api/users/[id]/password:email', linkError)
      if (isServiceKeyRejected(linkError)) {
        return jsonError(SERVICE_KEY_INVALID_MESSAGE, 503)
      }
      return jsonError(
        'Could not send the reset email. SMTP may not be configured on Supabase — use "Set new password" instead.',
        502
      )
    }
    return NextResponse.json({ ok: true, sent: true })
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(id, {
    password: parsed.data.password,
  })
  if (updateError) {
    logError('api/users/[id]/password:set', updateError)
    if (isServiceKeyRejected(updateError)) {
      return jsonError(SERVICE_KEY_INVALID_MESSAGE, 503)
    }
    return jsonError(toUserMessage(updateError, 'Could not set the new password.'), 400)
  }

  try {
    await admin.from('audit_logs').insert({
      user_id: guard.userId,
      user_email: guard.email,
      action: 'user_updated',
      entity_type: 'auth.users',
      entity_id: id,
      metadata: { via: 'admin_api', reason: 'password_reset_by_admin', target_email: existing.email },
    })
  } catch (auditError) {
    logError('api/users/[id]/password:audit', auditError) // non-fatal
  }

  return NextResponse.json({ ok: true, sent: false })
}
