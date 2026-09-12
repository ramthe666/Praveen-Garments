import { type NextRequest } from 'next/server'
import { requirePermission, readJson, rpcAsSession, str, num } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/sales/[id]/return — customer return against a COMPLETED bill.
 * Validates returnable quantity = sold − already returned/exchanged per
 * line, window + policy settings, and computes the refund server-side.
 * Everything is atomic: any failure rolls back stock, ledger and refund.
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
  if (!reason) return jsonError('A reason is required for a return.', 400)

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
    const condition = str(line, 'condition') ?? 'GOOD'
    if (condition !== 'GOOD' && condition !== 'DAMAGED') {
      return jsonError('Return condition must be GOOD or DAMAGED.', 400)
    }
    parsed.push({
      sale_item_id: str(line, 'sale_item_id') ?? '',
      quantity,
      condition,
    })
  }

  const payload: Record<string, unknown> = {
    sale_id: id,
    items: parsed,
    reason,
    refund_method: str(body, 'refund_method') ?? '',
    refund_reference: str(body, 'refund_reference') ?? '',
    notes: str(body, 'notes') ?? '',
  }

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'create_sales_return',
    { p_payload: payload },
    'sales:return',
    'Could not process the return.'
  )
  if (rpcError) return rpcError
  return Response.json(data, { status: 201 })
}
