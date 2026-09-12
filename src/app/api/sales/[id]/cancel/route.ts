import { NextResponse, type NextRequest } from 'next/server'
import { readJson, requirePermission, rpcAsSession } from '@/lib/pos/api'

export const dynamic = 'force-dynamic'

/**
 * POST /api/sales/[id]/cancel — supervised cancellation.
 * Requires the cancel_sale permission + a reason. The database restores
 * stock (SALES_RETURN movements), preserves the invoice record and writes
 * an audit row. Completed sales are never deleted.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requirePermission('cancel_sale')
  if (!guard.ok) return guard.response

  const { id } = await params
  const { body, error } = await readJson(request)
  if (error) return error

  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required to cancel a sale.' }, { status: 400 })
  }

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'cancel_sale',
    { p_sale_id: id, p_reason: reason },
    'sales:cancel',
    'Could not cancel the sale. Nothing was changed.'
  )
  if (rpcError) return rpcError

  return NextResponse.json(data)
}
