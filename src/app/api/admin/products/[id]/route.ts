import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import { mutationErrorMessage, readJson } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

const priceSchema = z
  .union([z.number().min(0), z.string().regex(/^\d+(\.\d{1,2})?$/), z.literal(''), z.null()])
  .transform((v) => (v === '' || v === null ? (v === '' ? null : null) : typeof v === 'string' ? Number(v) : v))

const updateSchema = z.object({
  name: z.string().trim().min(1, 'Enter the product name.').max(200).optional(),
  product_code: z.string().trim().max(40).nullable().optional(),
  category_id: z.string().uuid().optional(),
  subcategory_id: z.string().uuid().nullable().optional(),
  brand_id: z.string().uuid().nullable().optional(),
  collection: z.string().trim().max(80).nullable().optional(),
  gender: z.enum(['men', 'women', 'unisex', 'boys', 'girls', 'kids']).nullable().optional(),
  fabric: z.string().trim().max(80).nullable().optional(),
  pattern: z.string().trim().max(80).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  hsn_code: z.string().trim().regex(/^\d{4,8}$/, 'HSN/SAC must be 4-8 digits.').nullable().optional(),
  gst_rate: z.union([z.number().min(0).max(100), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v === null ? null : Number(v))),
  mrp: priceSchema.optional(),
  cost_price: priceSchema.optional(),
  selling_price: priceSchema.optional(),
  wholesale_price: priceSchema.optional(),
  image_path: z.string().max(300).nullable().optional(),
  is_active: z.boolean().optional(),
})

/**
 * PATCH /api/admin/products/[id] — edit product fields, archive
 * (is_active=false) or reactivate. Referenced products are never deleted;
 * history stays valid.
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
  if (Object.keys(input).length === 0) {
    return jsonError('Nothing to update.', 400)
  }

  const admin = createAdminClient()

  // validate references when they change
  if (input.category_id) {
    const { data: cat } = await admin.from('categories').select('id').eq('id', input.category_id).maybeSingle()
    if (!cat) return jsonError('Selected category was not found.', 422)
  }
  if (input.subcategory_id) {
    const { data: sub } = await admin.from('categories').select('id, parent_id').eq('id', input.subcategory_id).maybeSingle()
    const parentId = input.category_id ?? undefined
    if (!sub) return jsonError('Selected subcategory was not found.', 422)
    if (parentId !== undefined && sub.parent_id !== parentId) {
      return jsonError('The selected subcategory does not belong to the selected category.', 422)
    }
  }
  if (input.brand_id) {
    const { data: brand } = await admin.from('brands').select('id').eq('id', input.brand_id).maybeSingle()
    if (!brand) return jsonError('Selected brand was not found.', 422)
  }

  const { data, error: updateError } = await admin
    .from('products')
    .update(input)
    .eq('id', id)
    .select()
    .single()

  if (updateError || !data) {
    logError('api/products:update', updateError)
    return jsonError(mutationErrorMessage(updateError, 'Could not update the product.'), 400)
  }

  return NextResponse.json(data)
}
