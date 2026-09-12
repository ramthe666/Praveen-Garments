import { type NextRequest } from 'next/server'
import { requirePermission, readJson, rpcAsSession, str, num } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/sales/[id]/exchange — swap items from a COMPLETED bill for
 * replacement items. If the replacement costs more, the customer pays the
 * difference (payment method required); if it costs less, the difference is
 * refunded. Stock in/out, ledger and payment are one atomic transaction.
 * Permission: process_return (+ approve_return when the store requires
 * manager approval — enforced database-side).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('process_return')
  if (!guard.ok) return guard.response

  const { id } = await params
  if (!id) return jsonError('A sale id is required.', 400)

  const { body, error } = await readJson(request)
  if (error) return error

  const reason = str(body, 'reason')
  if (!reason) return jsonError('A reason is required for an exchange.', 400)

  const returnItems = body.return_items
  if (!Array.isArray(returnItems) || returnItems.length === 0) {
    return jsonError('Select at least one item to exchange.', 400)
  }
  const parsedReturns: Array<Record<string, unknown>> = []
  for (const item of returnItems) {
    if (typeof item !== 'object' || item === null) {
      return jsonError('Invalid returned item.', 400)
    }
    const line = item as Record<string, unknown>
    const quantity = num(line, 'quantity')
    if (!quantity || quantity <= 0 || !Number.isInteger(quantity)) {
      return jsonError('Enter a valid quantity for every returned item.', 400)
    }
    const condition = str(line, 'condition') ?? 'GOOD'
    if (condition !== 'GOOD' && condition !== 'DAMAGED') {
      return jsonError('Return condition must be GOOD or DAMAGED.', 400)
    }
    parsedReturns.push({
      sale_item_id: str(line, 'sale_item_id') ?? '',
      quantity,
      condition,
    })
  }

  const newItems = body.new_items
  if (!Array.isArray(newItems) || newItems.length === 0) {
    return jsonError('Select at least one replacement item.', 400)
  }
  const parsedNew: Array<Record<string, unknown>> = []
  for (const item of newItems) {
    if (typeof item !== 'object' || item === null) {
      return jsonError('Invalid replacement item.', 400)
    }
    const line = item as Record<string, unknown>
    const quantity = num(line, 'quantity')
    if (!quantity || quantity <= 0 || !Number.isInteger(quantity)) {
      return jsonError('Enter a valid quantity for every replacement item.', 400)
    }
    parsedNew.push({
      variant_id: str(line, 'variant_id') ?? '',
      quantity,
    })
  }

  const payload: Record<string, unknown> = {
    sale_id: id,
    return_items: parsedReturns,
    new_items: parsedNew,
    reason,
    payment_method: str(body, 'payment_method') ?? '',
    payment_reference: str(body, 'payment_reference') ?? '',
    notes: str(body, 'notes') ?? '',
  }

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'create_exchange',
    { p_payload: payload },
    'sales:exchange',
    'Could not process the exchange.'
  )
  if (rpcError) return rpcError
  return Response.json(data, { status: 201 })
}
