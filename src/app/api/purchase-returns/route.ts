import { type NextRequest } from 'next/server'
import { requirePermission, readJson, rpcAsSession, str, num } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/purchase-returns — return goods to a supplier against a
 * RECEIVED invoice. Validates quantity ≤ received − already returned,
 * requires a reason, reduces stock, and adjusts the supplier payable.
 * Permission: manage_purchases.
 */
export async function POST(request: NextRequest) {
  const guard = await requirePermission('manage_purchases')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const invoiceId = str(body, 'purchase_invoice_id')
  if (!invoiceId) return jsonError('Choose the purchase invoice to return against.', 400)

  const reason = str(body, 'reason')
  if (!reason) return jsonError('A reason is required for a purchase return.', 400)

  const items = body.items
  if (!Array.isArray(items) || items.length === 0) {
    return jsonError('Select at least one item to return.', 400)
  }
  const parsed: Array<Record<string, unknown>> = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      return jsonError('Invalid return item.', 400)
    }
    const line = item as Record<string, unknown>
    const quantity = num(line, 'quantity')
    if (!quantity || quantity <= 0 || !Number.isInteger(quantity)) {
      return jsonError('Enter a valid return quantity for every item.', 400)
    }
    parsed.push({
      invoice_item_id: str(line, 'invoice_item_id') ?? '',
      quantity,
    })
  }

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'create_purchase_return',
    { p_payload: { purchase_invoice_id: invoiceId, items: parsed, reason, notes: str(body, 'notes') ?? '' } },
    'purchase-returns:create',
    'Could not create the purchase return.'
  )
  if (rpcError) return rpcError
  return Response.json(data, { status: 201 })
}
