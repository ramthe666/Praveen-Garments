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
  reorder_level: z.number().int().min(0).nullable(),
})

/**
 * POST /api/admin/stock/reorder — set the per-(variant, location) reorder
 * level. `null` clears it, falling back to the global low-stock threshold in
 * Settings > Inventory.
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
  const { data, error: rpcError } = await supabase.rpc('set_reorder_level', {
    p_variant_id: parsed.data.variant_id,
    p_location_id: parsed.data.location_id,
    p_reorder_level: parsed.data.reorder_level,
  })

  if (rpcError) {
    logError('api/stock/reorder', rpcError)
    return jsonError(mutationErrorMessage(rpcError, 'Could not set the reorder level.'), 400)
  }

  return NextResponse.json(data, { status: 201 })
}
