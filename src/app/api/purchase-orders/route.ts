import { type NextRequest } from 'next/server'
import { requirePermission, readJson, rpcAsSession, str, num } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'

export const dynamic = 'force-dynamic'

/**
 * POST  /api/purchase-orders — create a purchase order (always DRAFT:
 *       nothing touches stock until an invoice is received against it).
 * PATCH /api/purchase-orders — { id, action } where action is:
 *   'update' — edit a DRAFT order's supplier / location / date / notes / lines
 *   'order'  — mark a DRAFT order as placed with the supplier (ORDERED)
 *   'cancel' — cancel with a reason (only if nothing was received)
 * Permission: manage_purchases.
 */

function parseItems(body: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const items = body.items
  if (!Array.isArray(items) || items.length === 0) return null
  const parsed: Array<Record<string, unknown>> = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return null
    const line = item as Record<string, unknown>
    const quantity = num(line, 'quantity')
    const unitCost = num(line, 'unit_cost')
    if (!quantity || quantity <= 0 || !Number.isInteger(quantity)) return null
    if (unitCost === undefined || unitCost < 0) return null
    const discount = num(line, 'discount_amount') ?? 0
    if (discount < 0 || discount > quantity * unitCost) return null
    const variantId = str(line, 'variant_id')
    if (!variantId) return null
    parsed.push({
      variant_id: variantId,
      quantity,
      unit_cost: Math.round(unitCost * 100) / 100,
      discount_amount: Math.round(discount * 100) / 100,
    })
  }
  return parsed
}

function commonPayload(body: Record<string, unknown>): Record<string, unknown> | null {
  const supplierId = str(body, 'supplier_id')
  const locationId = str(body, 'location_id')
  if (!supplierId || !locationId) return null
  const expectedDate = str(body, 'expected_date')
  if (expectedDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) return null
  const payload: Record<string, unknown> = {
    supplier_id: supplierId,
    location_id: locationId,
    expected_date: expectedDate ?? '',
    notes: str(body, 'notes') ?? '',
  }
  const items = parseItems(body)
  if (!items) return null
  payload.items = items
  return payload
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission('manage_purchases')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const payload = commonPayload(body)
  if (!payload) {
    return jsonError(
      'Choose a supplier and stock location, then add at least one item with a valid quantity and cost.',
      400
    )
  }

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'create_purchase_order',
    { p_payload: payload },
    'purchase-orders:create',
    'Could not create the purchase order.'
  )
  if (rpcError) return rpcError
  return Response.json(data, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const guard = await requirePermission('manage_purchases')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const id = str(body, 'id')
  const action = str(body, 'action')
  if (!id || !action) return jsonError('An order id and action are required.', 400)

  if (action === 'update') {
    const payload = commonPayload(body)
    if (!payload) {
      return jsonError(
        'Choose a supplier and stock location, then add at least one item with a valid quantity and cost.',
        400
      )
    }
    const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
      'update_purchase_order',
      { p_po_id: id, p_payload: payload },
      'purchase-orders:update',
      'Could not update the purchase order.'
    )
    if (rpcError) return rpcError
    return Response.json(data)
  }

  if (action === 'order') {
    const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
      'set_purchase_order_status',
      { p_po_id: id, p_status: 'ORDERED' },
      'purchase-orders:order',
      'Could not mark the order as placed.'
    )
    if (rpcError) return rpcError
    return Response.json(data)
  }

  if (action === 'cancel') {
    const reason = str(body, 'reason')
    if (!reason) return jsonError('A cancellation reason is required.', 400)
    const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
      'cancel_purchase_order',
      { p_po_id: id, p_reason: reason },
      'purchase-orders:cancel',
      'Could not cancel the purchase order.'
    )
    if (rpcError) return rpcError
    return Response.json(data)
  }

  return jsonError('Unknown action.', 400)
}
