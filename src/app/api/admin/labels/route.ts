import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import { readJson } from '@/lib/catalog/api'
import type { Json } from '@/types/database'

export const dynamic = 'force-dynamic'

const schema = z.object({
  items: z
    .array(z.object({ variant_id: z.string().uuid(), quantity: z.number().int().min(1).max(500) }))
    .min(1, 'Select at least one variant.')
    .max(200),
  template: z.string().max(20).optional(),
})

/**
 * POST /api/admin/labels — record a label-print event in the audit trail.
 * The label sheet itself renders client-side (browser print); this keeps the
 * "who printed what" history for accountability.
 */
export async function POST(request: NextRequest) {
  const guard = await requireSessionPermission('manage_products')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input.', 422)
  }

  const session = await createClient()
  try {
    // Insert through the caller's session (audit_logs_insert_self, RLS-checked
    // and correctly attributed). No service-role dependency: label printing
    // keeps working even when the service key is rotated and not re-pasted.
    const { error: auditError } = await session.from('audit_logs').insert({
      user_id: guard.userId,
      user_email: guard.email,
      action: 'settings_changed',
      entity_type: 'label_print',
      entity_id: null,
      metadata: {
        items: parsed.data.items,
        template: parsed.data.template ?? null,
        total_labels: parsed.data.items.reduce((sum, i) => sum + i.quantity, 0),
      } as unknown as Json,
    })
    if (auditError) throw auditError
  } catch (auditError) {
    logError('api/labels:audit', auditError)
    // non-fatal: printing still worked, auditing failed
  }

  return NextResponse.json({ ok: true }, { status: 201 })
}
