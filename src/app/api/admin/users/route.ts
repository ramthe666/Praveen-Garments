import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError, toUserMessage } from '@/lib/errors'
import type { UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    .max(64, 'Password must be at most 64 characters.'),
  full_name: z.string().trim().min(1, 'Enter the staff member\'s name.').max(120),
  role: z.enum([
    'admin',
    'manager',
    'cashier',
    'inventory_manager',
    'purchase_manager',
    'accountant',
  ]),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
})

/**
 * POST /api/admin/users — create a staff account (Admin only).
 * Auth user is created with email pre-confirmed (private app, no public
 * signup loop); the profile row is ensured both by the DB trigger and an
 * idempotent upsert so the flow survives pre-trigger users.
 */
export async function POST(request: NextRequest) {
  const guard = await requireSessionPermission('manage_users')
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid request body.', 400)
  }

  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input.', 422)
  }
  const { email, password, full_name, role, phone } = parsed.data

  const admin = createAdminClient()

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, app_role: role },
  })

  if (createError) {
    logError('api/users:create', createError)
    if (createError.message.toLowerCase().includes('already been registered')) {
      return jsonError('A user with this email already exists.', 409)
    }
    return jsonError(toUserMessage(createError, 'Could not create the account.'), 400)
  }

  if (!created.user?.id) {
    logError('api/users:create', { code: 'NO_USER_ID', message: 'createUser returned no id' })
    return jsonError('Account was created but its profile could not be read back.', 500)
  }

  // Idempotent profile upsert (the auth trigger normally does this already).
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .upsert(
      {
        id: created.user.id,
        email,
        full_name,
        role: role as UserRole,
        phone: phone || null,
        is_active: true,
      },
      { onConflict: 'id', ignoreDuplicates: false }
    )
    .select()
    .single()

  if (profileError) {
    logError('api/users:profile-upsert', profileError)
    // Account exists; profile issue is recoverable by re-running migrations.
    return NextResponse.json(
      {
        warning:
          'Account created, but the profile row could not be written. Ensure Phase 1 migrations are applied.',
        profile: null,
      },
      { status: 207 }
    )
  }

  // Explicit audit row attributing the action to the calling admin
  // (the DB trigger also records the row-level change itself).
  try {
    await admin.from('audit_logs').insert({
      user_id: guard.userId,
      user_email: guard.email,
      action: 'user_created',
      entity_type: 'profiles',
      entity_id: created.user.id,
      new_values: { email, full_name, role },
      metadata: { via: 'admin_api' },
    })
  } catch (auditError) {
    logError('api/users:audit', auditError) // non-fatal
  }

  return NextResponse.json({ profile }, { status: 201 })
}
