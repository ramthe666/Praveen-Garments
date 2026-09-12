import { NextResponse, type NextRequest } from 'next/server'
import { readJson, requirePermission, rpcAsSession } from '@/lib/pos/api'

export const dynamic = 'force-dynamic'

/**
 * POST /api/pos/checkout — the atomic sale engine.
 * Body: { items, customer_id?, bill_discount_type?, bill_discount_value?,
 *         payments, notes?, location_id? }
 * All money, tax and discount validation happens database-side inside
 * create_sale(); this route only forwards the payload through the caller's
 * session (permission-guarded, RLS re-checked, audit-attributed).
 */
export async function POST(request: NextRequest) {
  const guard = await requirePermission('create_sale')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'The cart is empty — add at least one item.' }, { status: 400 })
  }
  if (!Array.isArray(body.payments)) {
    return NextResponse.json({ error: 'Invalid payments.' }, { status: 400 })
  }

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'create_sale',
    { p_payload: body },
    'pos:checkout',
    'Checkout failed. The sale was not completed — nothing was charged or deducted.'
  )
  if (rpcError) return rpcError

  return NextResponse.json(data, { status: 201 })
}
