import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import { mutationErrorMessage, readJson } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

const schema = z.object({
  variant_id: z.string().uuid(),
  location_id: z.string().uuid(),
  quantity: z.number().int().min(0, 'Quantity must be zero or more.'),
  reason: z.string().trim().max(300).optional(),
})

/**
 * POST /api/admin/stock/opening — record opening stock (baseline). Runs the
 * set_opening_stock RPC with the caller's session: permission + once-only +
 * balance + movement + audit happen atomically in the database.
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
  const { data, error: rpcError } = await supabase.rpc('set_opening_stock', {
    p_variant_id: parsed.data.variant_id,
    p_location_id: parsed.data.location_id,
    p_quantity: parsed.data.quantity,
    p_reason: parsed.data.reason || null,
  })

  if (rpcError) {
    logError('api/stock/opening', rpcError)
    return jsonError(mutationErrorMessage(rpcError, 'Could not record the opening stock.'), 400)
  }

  return NextResponse.json(data, { status: 201 })
}
