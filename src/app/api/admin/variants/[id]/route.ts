import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import { mutationErrorMessage, readJson } from '@/lib/catalog/api'
import type { Database } from '@/types/database'

export const dynamic = 'force-dynamic'

const priceSchema = z
  .union([z.number().min(0), z.string().regex(/^\d+(\.\d{1,2})?$/), z.literal(''), z.null()])
  .transform((v) => (v === '' || v === null ? null : typeof v === 'string' ? Number(v) : v))

const updateSchema = z.object({
  sku: z.string().trim().min(1, 'SKU cannot be empty.').max(60).optional(),
  size_id: z.string().uuid().nullable().optional(),
  color_id: z.string().uuid().nullable().optional(),
  barcode: z.string().trim().regex(/^\d{8,14}$/, 'Barcode must be 8-14 digits.').nullable().optional(),
  qr_identifier: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{4,64}$/, 'QR identifier must be 4-64 letters, digits, dashes or underscores.')
    .nullable()
    .optional(),
  generate_barcode: z.boolean().optional(),
  generate_qr: z.boolean().optional(),
  cost_price: priceSchema.optional(),
  mrp: priceSchema.optional(),
  selling_price: priceSchema.optional(),
  wholesale_price: priceSchema.optional(),
  is_active: z.boolean().optional(),
})

/**
 * PATCH /api/admin/variants/[id] — edit a variant: manual SKU / barcode / QR
 * assignment (database-unique), prices, size/color, active state. Special
 * flags `generate_barcode` / `generate_qr` mint fresh identifiers from the
 * database sequences.
 *
 * Runs entirely through the CALLER's session client (RLS re-checks
 * manage_products; the generator functions are granted to authenticated).
 * The service-role key is intentionally NOT used, so variant edits keep
 * working even when that key is rotated and not yet re-pasted.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSessionPermission('manage_products')
  if (!guard.ok) return guard.response

  const { id } = await params
  const { body, error } = await readJson(request)
  if (error) return error

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input.', 422)
  }
  const input = parsed.data

  const session = await createClient()
  const { data: existing, error: lookupError } = await session
    .from('product_variants')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (lookupError) {
    logError('api/variants:lookup', lookupError)
    return jsonError('Could not read the variant. Please try again.', 500)
  }
  if (!existing) return jsonError('Variant not found.', 404)

  const update: Record<string, unknown> = {}
  for (const key of ['sku', 'size_id', 'color_id', 'barcode', 'qr_identifier', 'cost_price', 'mrp', 'selling_price', 'wholesale_price', 'is_active'] as const) {
    if (key in input) update[key] = (input as Record<string, unknown>)[key]
  }

  // mint identifiers from the DB sequences when requested
  if (input.generate_barcode) {
    const { data: barcode, error: genError } = await session.rpc('generate_barcode')
    if (genError || !barcode) {
      logError('api/variants:generate-barcode', genError)
      return jsonError('Could not generate a barcode. Ensure the Phase 2 migrations are applied.', 400)
    }
    update.barcode = barcode
  }
  if (input.generate_qr) {
    const { data: qr, error: genError } = await session.rpc('generate_qr_identifier')
    if (genError || !qr) {
      logError('api/variants:generate-qr', genError)
      return jsonError('Could not generate a QR identifier. Ensure the Phase 2 migrations are applied.', 400)
    }
    update.qr_identifier = qr
  }

  if (Object.keys(update).length === 0) {
    return jsonError('Nothing to update.', 400)
  }

  const { data, error: updateError } = await session
    .from('product_variants')
    .update(update as unknown as Database['public']['Tables']['product_variants']['Update'])
    .eq('id', id)
    .select()
    .single()

  if (updateError || !data) {
    logError('api/variants:update', updateError)
    return jsonError(mutationErrorMessage(updateError, 'Could not update the variant.'), 400)
  }

  return NextResponse.json(data)
}
