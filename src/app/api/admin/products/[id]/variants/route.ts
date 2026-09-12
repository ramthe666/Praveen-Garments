import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import { mutationErrorMessage, readJson } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

const priceSchema = z
  .union([z.number().min(0), z.string().regex(/^\d+(\.\d{1,2})?$/), z.literal(''), z.null()])
  .transform((v) => (v === '' || v === null ? null : typeof v === 'string' ? Number(v) : v))

const variantSchema = z.object({
  // The variant dialogs serialise empty optional fields as JSON null —
  // accepted here and normalised to '' (identical downstream semantics:
  // the create_product_variants RPC applies nullif(trim(...))).
  sku: z.string().trim().max(60).optional().or(z.literal('')).or(z.null()).transform((v) => v ?? ''),
  size_id: z.string().uuid().optional().or(z.literal('')).or(z.null()).transform((v) => v || null),
  color_id: z.string().uuid().optional().or(z.literal('')).or(z.null()).transform((v) => v || null),
  barcode: z
    .string()
    .trim()
    .regex(/^\d{8,14}$/, 'Barcode must be 8-14 digits.')
    .optional()
    .or(z.literal(''))
    .or(z.null())
    .transform((v) => v ?? ''),
  qr_identifier: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{4,64}$/, 'QR identifier must be 4-64 letters, digits, dashes or underscores.')
    .optional()
    .or(z.literal(''))
    .or(z.null())
    .transform((v) => v ?? ''),
  generate_barcode: z.boolean().optional(),
  generate_qr: z.boolean().optional(),
  cost_price: priceSchema.optional(),
  mrp: priceSchema.optional(),
  selling_price: priceSchema.optional(),
  wholesale_price: priceSchema.optional(),
})

/**
 * POST /api/admin/products/[id]/variants — add a batch of variants to an
 * existing product. Runs entirely inside the create_product_variants RPC
 * (user session) so SKU/barcode/QR uniqueness and permissions are enforced
 * by the database in one transaction.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSessionPermission('manage_products')
  if (!guard.ok) return guard.response

  const { id } = await params
  const { body, error } = await readJson(request)
  if (error) return error

  const parsed = z.object({ variants: z.array(variantSchema).min(1, 'Add at least one variant.').max(200) }).safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input.', 422)
  }

  const supabase = await createClient()
  const { data, error: rpcError } = await supabase.rpc('create_product_variants', {
    p_product_id: id,
    p_variants: parsed.data.variants,
  })

  if (rpcError) {
    logError('api/products/variants:create', rpcError)
    return jsonError(mutationErrorMessage(rpcError, 'Could not create the variants.'), 400)
  }

  return NextResponse.json(data, { status: 201 })
}
