import { NextResponse, type NextRequest } from 'next/server'
import { readJson, requirePermission, rpcAsSession } from '@/lib/pos/api'

export const dynamic = 'force-dynamic'

/**
 * POST /api/pos/hold — hold the current cart as a private draft.
 * Held bills NEVER touch stock; they are cart snapshots only.
 */
export async function POST(request: NextRequest) {
  const guard = await requirePermission('create_sale')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  if (typeof body.cart !== 'object' || body.cart === null) {
    return NextResponse.json({ error: 'Invalid cart.' }, { status: 400 })
  }

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'hold_bill',
    {
      p_cart: body.cart,
      p_label: typeof body.label === 'string' ? body.label : null,
      p_customer: typeof body.customer_name === 'string' ? body.customer_name : null,
      p_item_count: Number.isFinite(body.item_count) ? body.item_count : 0,
      p_total: typeof body.total === 'number' ? body.total : null,
    },
    'pos:hold',
    'Could not hold the bill. Your cart is unchanged.'
  )
  if (rpcError) return rpcError

  return NextResponse.json(data, { status: 201 })
}
