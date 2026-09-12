import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requirePermission, readJson, str } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'
import { logError, toUserMessage } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/customers — create a customer (Phase 4 fields: alt phone,
 * pincode, type, credit limit, notes).
 * PATCH /api/customers — update an existing customer.
 * Both permission-gated with manage_customers and re-checked by RLS.
 */
const FIELDS = [
  'phone', 'alt_phone', 'email', 'address', 'city', 'state', 'pincode', 'gstin', 'notes',
] as const

export async function POST(request: NextRequest) {
  const guard = await requirePermission('manage_customers')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const name = str(body, 'name')
  if (!name || name.length > 120) {
    return jsonError('A customer name is required (up to 120 characters).', 400)
  }

  const customerType = str(body, 'customer_type') ?? 'retail'
  if (customerType !== 'retail' && customerType !== 'wholesale') {
    return jsonError('Customer type must be retail or wholesale.', 400)
  }

  const creditLimit = Number(body.credit_limit ?? 0)
  if (!Number.isFinite(creditLimit) || creditLimit < 0 || creditLimit > 99_999_999) {
    return jsonError('Credit limit must be zero or a positive amount.', 400)
  }

  const record: Record<string, unknown> = { name, customer_type: customerType, credit_limit: Math.round(creditLimit * 100) / 100 }
  for (const field of FIELDS) {
    const value = str(body, field)
    if (value !== undefined) record[field] = value
  }

  const session = await createClient()
  const { data, error: insertError } = await session
    .from('customers')
    .insert(record as never)
    .select('id, name, phone, customer_type')
    .single()

  if (insertError) {
    logError('customers:create', insertError)
    return jsonError(toUserMessage(insertError, 'Could not create the customer.'), 400)
  }
  return NextResponse.json(data, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const guard = await requirePermission('manage_customers')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const id = str(body, 'id')
  if (!id) return jsonError('A customer id is required.', 400)

  const record: Record<string, unknown> = {}
  const name = str(body, 'name')
  if (name !== undefined) {
    if (name.length > 120) return jsonError('Name is too long.', 400)
    record.name = name
  }
  const customerType = str(body, 'customer_type')
  if (customerType !== undefined) {
    if (customerType !== 'retail' && customerType !== 'wholesale') {
      return jsonError('Customer type must be retail or wholesale.', 400)
    }
    record.customer_type = customerType
  }
  if (body.credit_limit !== undefined) {
    const creditLimit = Number(body.credit_limit)
    if (!Number.isFinite(creditLimit) || creditLimit < 0 || creditLimit > 99_999_999) {
      return jsonError('Credit limit must be zero or a positive amount.', 400)
    }
    record.credit_limit = Math.round(creditLimit * 100) / 100
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
    .from('customers')
    .update(record as never)
    .eq('id', id)
    .select('id, name, is_active')
    .single()

  if (updateError) {
    logError('customers:update', updateError)
    return jsonError(toUserMessage(updateError, 'Could not update the customer.'), 400)
  }
  return NextResponse.json(data)
}
