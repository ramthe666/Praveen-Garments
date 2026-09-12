import { type NextRequest } from 'next/server'
import { requirePermission, readJson, rpcAsSession, str, num, validAmount } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/suppliers/[id]/payments — record a supplier payment against
 * outstanding payables (FIFO across invoices). Atomic; rejects
 * over-payment unless advances are enabled in Settings → Payments.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('record_supplier_payment')
  if (!guard.ok) return guard.response

  const { id } = await params
  if (!id) return jsonError('A supplier id is required.', 400)

  const { body, error } = await readJson(request)
  if (error) return error

  const amount = num(body, 'amount')
  if (!validAmount(amount)) {
    return jsonError('Enter a valid payment amount (positive, up to 2 decimals).', 400)
  }

  const method = str(body, 'method')
  if (!method) return jsonError('Choose a payment method.', 400)

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'record_supplier_payment',
    {
      p_supplier_id: id,
      p_amount: amount,
      p_method: method,
      p_reference: str(body, 'reference') ?? null,
      p_notes: str(body, 'notes') ?? null,
      p_payment_date: str(body, 'payment_date') ?? null,
    },
    'suppliers:payment',
    'Could not record the payment.'
  )
  if (rpcError) return rpcError
  return Response.json(data)
}
