import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requirePermission, readJson, str } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'
import { logError, toUserMessage } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/suppliers — create a supplier (GST details, contact info).
 * PATCH /api/suppliers — update / deactivate / reactivate.
 * Permission: manage_suppliers (Admin, Manager, Purchase Manager by default).
 */
const FIELDS = [
  'contact_person', 'phone', 'email', 'address', 'city', 'state', 'pincode', 'gstin',
  'notes',
] as const

export async function POST(request: NextRequest) {
  const guard = await requirePermission('manage_suppliers')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const name = str(body, 'name')
  if (!name || name.length > 160) {
    return jsonError('A supplier name is required (up to 160 characters).', 400)
  }

  const record: Record<string, unknown> = { name }
  for (const field of FIELDS) {
    const value = str(body, field)
    if (value !== undefined) record[field] = value
  }

  const session = await createClient()
  const { data, error: insertError } = await session
    .from('suppliers')
    .insert(record as never)
    .select('id, name')
    .single()

  if (insertError) {
    logError('suppliers:create', insertError)
    return jsonError(toUserMessage(insertError, 'Could not create the supplier.'), 400)
  }
  return NextResponse.json(data, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const guard = await requirePermission('manage_suppliers')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const id = str(body, 'id')
  if (!id) return jsonError('A supplier id is required.', 400)

  const record: Record<string, unknown> = {}
  const name = str(body, 'name')
  if (name !== undefined) {
    if (name.length > 160) return jsonError('Name is too long.', 400)
    record.name = name
  }
  for (const field of FIELDS) {
    if (body[field] !== undefined) {
      const value = str(body, field)
      record[field] = value ?? null
    }
  }
  if (body.is_active === true) record.is_active = true
  if (body.is_active === false) record.is_active = false

  if (Object.keys(record).length === 0) {
    return jsonError('Nothing to update.', 400)
  }

  const session = await createClient()
  const { data, error: updateError } = await session
    .from('suppliers')
    .update(record as never)
    .eq('id', id)
    .select('id, name, is_active')
    .single()

  if (updateError) {
    logError('suppliers:update', updateError)
    return jsonError(toUserMessage(updateError, 'Could not update the supplier.'), 400)
  }
  return NextResponse.json(data)
}
