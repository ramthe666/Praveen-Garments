import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { readJson, requirePermission } from '@/lib/pos/api'
import { jsonError } from '@/lib/api/guard'
import { logError, toUserMessage } from '@/lib/errors'
import type { Customer } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/pos/customers?search= — search the customer directory
 *       (name / phone, ilike, bounded to 20 rows).
 * POST /api/pos/customers — quick-create a customer at the counter.
 * Both permission-gated with manage_customers (held by Admin, Manager and
 * Cashier roles by default) and re-checked by RLS.
 */
export async function GET(request: NextRequest) {
  const guard = await requirePermission('manage_customers')
  if (!guard.ok) return guard.response

  const search = request.nextUrl.searchParams.get('search')?.trim() ?? ''
  const session = await createClient()

  let query = session
    .from('customers')
    .select('id, name, phone, email, city, state, gstin, is_active')
    .eq('is_active', true)
    .order('name')
    .limit(20)

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`)
  }

  const { data, error } = await query
  if (error) {
    logError('pos:customers:search', error)
    return jsonError(toUserMessage(error, 'Could not search customers.'), 400)
  }
  return NextResponse.json({ rows: data ?? [] })
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission('manage_customers')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length < 1 || name.length > 120) {
    return jsonError('A customer name is required.', 400)
  }
  const record: Record<string, unknown> = { name }
  for (const field of ['phone', 'email', 'address', 'city', 'state', 'gstin', 'notes']) {
    if (typeof body[field] === 'string' && (body[field] as string).trim() !== '') {
      record[field] = (body[field] as string).trim()
    }
  }

  const session = await createClient()
  const { data, error: insertError } = await session
    .from('customers')
    .insert(record as never)
    .select('id, name, phone, email, city, state, gstin, is_active')
    .single()

  if (insertError) {
    logError('pos:customers:create', insertError)
    return jsonError(toUserMessage(insertError, 'Could not create the customer.'), 400)
  }
  return NextResponse.json(data as Customer, { status: 201 })
}
