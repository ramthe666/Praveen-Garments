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
  quantity: z
    .number()
    .int('Quantity must be a whole number.')
    .refine((v) => v !== 0, 'Quantity must be a non-zero number (use + to add, − to remove).'),
  movement_type: z.enum(['ADJUSTMENT', 'DAMAGE', 'LOSS', 'OTHER']).default('ADJUSTMENT'),
  reason: z.string().trim().min(1, 'A reason is required for stock adjustments.').max(300),
})

/**
 * POST /api/admin/stock/adjust — controlled stock adjustment (positive or
 * negative). The adjust_stock RPC enforces the reason requirement, the
 * allow_negative_stock rule from Settings > Inventory, concurrency safety and
 * writes the ledger + audit rows atomically.
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
  const { data, error: rpcError } = await supabase.rpc('adjust_stock', {
    p_variant_id: parsed.data.variant_id,
    p_location_id: parsed.data.location_id,
    p_quantity: parsed.data.quantity,
    p_movement_type: parsed.data.movement_type,
    p_reason: parsed.data.reason,
    p_reference_type: 'manual',
  })

  if (rpcError) {
    logError('api/stock/adjust', rpcError)
    return jsonError(mutationErrorMessage(rpcError, 'Could not adjust the stock.'), 400)
  }

  return NextResponse.json(data, { status: 201 })
}
