import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import { mutationErrorMessage, readJson } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

const schema = z.object({
  variant_id: z.string().uuid(),
  from_location_id: z.string().uuid(),
  to_location_id: z.string().uuid(),
  quantity: z.number().int().positive('Quantity must be a positive number.'),
  reason: z.string().trim().min(1, 'A reason is required for transfers.').max(300),
})

/**
 * POST /api/admin/stock/transfer — move stock between locations. The
 * transfer_stock RPC writes TRANSFER_OUT + TRANSFER_IN ledger rows in ONE
 * transaction (either both happen or neither does).
 */
export async function POST(request: NextRequest) {
  const guard = await requireSessionPermission('manage_inventory')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input.', 422)
  }

  const supabase = await createClient()
  const { data, error: rpcError } = await supabase.rpc('transfer_stock', {
    p_variant_id: parsed.data.variant_id,
    p_from_location_id: parsed.data.from_location_id,
    p_to_location_id: parsed.data.to_location_id,
    p_quantity: parsed.data.quantity,
    p_reason: parsed.data.reason,
  })

  if (rpcError) {
    logError('api/stock/transfer', rpcError)
    return jsonError(mutationErrorMessage(rpcError, 'Could not transfer the stock.'), 400)
  }

  return NextResponse.json(data, { status: 201 })
}
