import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError, isTableMissing } from '@/lib/errors'
import { mutationErrorMessage, readJson } from '@/lib/catalog/api'
import type { Database, Product } from '@/types/database'

export const dynamic = 'force-dynamic'

const priceSchema = z
  .union([z.number().min(0), z.string().regex(/^\d+(\.\d{1,2})?$/, 'Use a number like 499 or 499.50.'), z.literal(''), z.null()])
  .transform((v) => (v === '' || v === null ? null : typeof v === 'string' ? Number(v) : v))

const variantSchema = z.object({
  sku: z.string().trim().max(60).optional().or(z.literal('')),
  size_id: z.string().uuid().optional().or(z.literal('')).transform((v) => v || null),
  color_id: z.string().uuid().optional().or(z.literal('')).transform((v) => v || null),
  barcode: z.string().trim().regex(/^\d{8,14}$/, 'Barcode must be 8-14 digits.').optional().or(z.literal('')),
  qr_identifier: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{4,64}$/, 'QR identifier must be 4-64 letters, digits, dashes or underscores.')
    .optional()
    .or(z.literal('')),
  generate_barcode: z.boolean().optional(),
  generate_qr: z.boolean().optional(),
  cost_price: priceSchema.optional(),
  mrp: priceSchema.optional(),
  selling_price: priceSchema.optional(),
  wholesale_price: priceSchema.optional(),
})

const createSchema = z.object({
  name: z.string().trim().min(1, 'Enter the product name.').max(200),
  product_code: z.string().trim().max(40).optional().or(z.literal('')).transform((v) => v || null),
  category_id: z.string().uuid('Select a category.'),
  subcategory_id: z.string().uuid().optional().or(z.literal('')).transform((v) => v || null),
  brand_id: z.string().uuid().optional().or(z.literal('')).transform((v) => v || null),
  collection: z.string().trim().max(80).optional().or(z.literal('')).transform((v) => v || null),
  gender: z.enum(['men', 'women', 'unisex', 'boys', 'girls', 'kids']).optional().or(z.literal('')).transform((v) => v || null),
  fabric: z.string().trim().max(80).optional().or(z.literal('')).transform((v) => v || null),
  pattern: z.string().trim().max(80).optional().or(z.literal('')).transform((v) => v || null),
  description: z.string().max(2000).optional().or(z.literal('')).transform((v) => v || null),
  hsn_code: z.string().trim().regex(/^\d{4,8}$/, 'HSN/SAC must be 4-8 digits.').optional().or(z.literal('')).transform((v) => v || null),
  gst_rate: z.union([z.number().min(0).max(100), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v === null || v === undefined ? null : Number(v))),
  mrp: priceSchema.optional(),
  cost_price: priceSchema.optional(),
  selling_price: priceSchema.optional(),
  wholesale_price: priceSchema.optional(),
  image_path: z.string().max(300).optional().or(z.literal('')).transform((v) => v || null),
  variants: z.array(variantSchema).max(200, 'A product can have at most 200 variants at once.').default([]),
})

/**
 * POST /api/admin/products — create a product (optionally with its first
 * variant batch in the same request).
 *
 * The product row is inserted with the service role; variants go through the
 * create_product_variants RPC called WITH THE USER'S session so the database
 * authorizes manage_products itself. If the variant step fails, the freshly
 * created product row is removed again (compensation) and the DB's clear
 * duplicate/validation message is returned.
 */
export async function POST(request: NextRequest) {
  const guard = await requireSessionPermission('manage_products')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input.', 422)
  }
  const input = parsed.data

  const admin = createAdminClient()
  // The product row is inserted WITH THE USER's session client so RLS
  // re-checks manage_products inside the database and the audit trigger can
  // attribute auth.uid() (service-role writes would leave user_id null).
  const userClient = await createClient()

  // Validate category / subcategory / brand references server-side
  const { data: category } = await admin.from('categories').select('id, parent_id').eq('id', input.category_id).maybeSingle()
  if (!category) return jsonError('Selected category was not found.', 422)
  if (input.subcategory_id) {
    const { data: sub } = await admin.from('categories').select('id, parent_id').eq('id', input.subcategory_id).maybeSingle()
    if (!sub || sub.parent_id !== input.category_id) {
      return jsonError('The selected subcategory does not belong to the selected category.', 422)
    }
  }
  if (input.brand_id) {
    const { data: brand } = await admin.from('brands').select('id').eq('id', input.brand_id).maybeSingle()
    if (!brand) return jsonError('Selected brand was not found.', 422)
  }

  const { data: product, error: productError } = await userClient
    .from('products')
    .insert({
      name: input.name,
      product_code: input.product_code,
      category_id: input.category_id,
      subcategory_id: input.subcategory_id,
      brand_id: input.brand_id,
      collection: input.collection,
      gender: input.gender,
      fabric: input.fabric,
      pattern: input.pattern,
      description: input.description,
      hsn_code: input.hsn_code,
      gst_rate: input.gst_rate,
      mrp: input.mrp ?? null,
      cost_price: input.cost_price ?? null,
      selling_price: input.selling_price ?? null,
      wholesale_price: input.wholesale_price ?? null,
      image_path: input.image_path,
    } as unknown as Database['public']['Tables']['products']['Insert'])
    .select()
    .single()

  if (productError || !product) {
    logError('api/products:create', productError)
    return jsonError(mutationErrorMessage(productError, 'Could not create the product.'), 400)
  }

  // Variant batch (if provided) via the RPC with the CALLER's session — the
  // database re-checks manage_products and all uniqueness constraints.
  if (input.variants.length > 0) {
    const { data: variantResult, error: variantError } = await userClient.rpc('create_product_variants', {
      p_product_id: product.id,
      p_variants: input.variants,
    })

    if (variantError) {
      logError('api/products:create-variants', variantError)
      // compensate: remove the just-created product (it has no references yet)
      await admin.from('products').delete().eq('id', product.id)
      return jsonError(mutationErrorMessage(variantError, 'Could not create the product variants.'), 400)
    }
    return NextResponse.json({ product, variants: (variantResult as { variants?: unknown[] })?.variants ?? [] }, { status: 201 })
  }

  return NextResponse.json({ product: product as Product, variants: [] }, { status: 201 })
}
