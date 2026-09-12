import { type NextRequest } from 'next/server'
import { requirePermission, readJson, rpcAsSession, str, num } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'

export const dynamic = 'force-dynamic'

/**
 * POST  /api/purchase-invoices — create a supplier bill. status 'DRAFT'
 *       (nothing happens) or 'RECEIVED' (stock + payable + PO progress,
 *       all atomic). Receiving never exceeds the ordered quantity when the
 *       invoice is linked to a PO.
 * PATCH /api/purchase-invoices — { id, action } where action is:
 *   'confirm' — receive a DRAFT invoice now (stock + payable)
 *   'cancel'  — cancel with a reason (only unreceived drafts)
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
    const record: Record<string, unknown> = {
      variant_id: str(line, 'variant_id') ?? '',
      quantity,
      unit_cost: Math.round(unitCost * 100) / 100,
      discount_amount: Math.round(discount * 100) / 100,
    }
    const poItemId = str(line, 'po_item_id')
    if (poItemId) record.po_item_id = poItemId
    parsed.push(record)
  }
  return parsed
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission('manage_purchases')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const supplierId = str(body, 'supplier_id')
  const locationId = str(body, 'location_id')
  if (!supplierId || !locationId) {
    return jsonError('Choose a supplier and a stock location.', 400)
  }

  const status = str(body, 'status') ?? 'DRAFT'
  if (status !== 'DRAFT' && status !== 'RECEIVED') {
    return jsonError('Status must be DRAFT or RECEIVED.', 400)
  }

  const items = parseItems(body)
  if (!items) {
    return jsonError('Add at least one item with a valid quantity and cost.', 400)
  }

  const supplierInvoiceNo = str(body, 'supplier_invoice_no')
  const supplierInvoiceDate = str(body, 'supplier_invoice_date')
  if (supplierInvoiceDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(supplierInvoiceDate)) {
    return jsonError('Supplier invoice date must be a valid date.', 400)
  }

  const taxMode = str(body, 'tax_mode')
  if (taxMode !== undefined && taxMode !== 'inclusive' && taxMode !== 'exclusive') {
    return jsonError('Tax mode must be inclusive or exclusive.', 400)
  }

  const payload: Record<string, unknown> = {
    supplier_id: supplierId,
    location_id: locationId,
    status,
    supplier_invoice_no: supplierInvoiceNo ?? '',
    supplier_invoice_date: supplierInvoiceDate ?? '',
    notes: str(body, 'notes') ?? '',
    items,
  }
  const poId = str(body, 'po_id')
  if (poId) payload.po_id = poId
  if (taxMode) payload.tax_mode = taxMode

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'create_purchase_invoice',
    { p_payload: payload },
    'purchase-invoices:create',
    'Could not create the purchase invoice.'
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
  if (!id || !action) return jsonError('An invoice id and action are required.', 400)

  if (action === 'confirm') {
    const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
      'confirm_purchase_invoice', { p_invoice_id: id },
      'purchase-invoices:confirm', 'Could not receive the invoice.'
    )
    if (rpcError) return rpcError
    return Response.json(data)
  }

  if (action === 'cancel') {
    const reason = str(body, 'reason')
    if (!reason) return jsonError('A cancellation reason is required.', 400)
    const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
      'cancel_purchase_invoice', { p_invoice_id: id, p_reason: reason },
      'purchase-invoices:cancel', 'Could not cancel the purchase invoice.'
    )
    if (rpcError) return rpcError
    return Response.json(data)
  }

  return jsonError('Unknown action.', 400)
}
