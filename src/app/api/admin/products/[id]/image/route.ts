import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 2 * 1024 * 1024 // 2 MB (matches the bucket's file_size_limit)
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * POST /api/admin/products/[id]/image — upload/replace the product image.
 * Multipart form with a single `file` field. Validates type + size
 * server-side, stores under products/<productId>/<uuid>.<ext> in the public
 * "product-images" bucket, updates the product row, and removes the previous
 * object when replacing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSessionPermission('manage_products')
  if (!guard.ok) return guard.response

  const { id } = await params

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonError('Expected a multipart form with a "file" field.', 400)
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return jsonError('No file was uploaded.', 400)
  }

  const ext = ALLOWED_TYPES[file.type]
  if (!ext) {
    return jsonError('Unsupported image type. Use PNG, JPG or WebP.', 415)
  }
  if (file.size <= 0) {
    return jsonError('The file is empty.', 400)
  }
  if (file.size > MAX_BYTES) {
    return jsonError('The image is too large. Maximum size is 2 MB.', 413)
  }

  const admin = createAdminClient()

  const { data: product } = await admin.from('products').select('id, image_path').eq('id', id).maybeSingle()
  if (!product) return jsonError('Product not found.', 404)

  const path = `products/${id}/${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await admin.storage
    .from('product-images')
    .upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false })

  if (uploadError) {
    logError('api/products/image:upload', uploadError)
    return jsonError('Could not upload the image. Ensure migration 0006 is applied.', 400)
  }

  const { error: updateError } = await admin.from('products').update({ image_path: path }).eq('id', id)
  if (updateError) {
    logError('api/products/image:update', updateError)
    // remove the orphaned object so storage stays consistent
    await admin.storage.from('product-images').remove([path]).catch(() => {})
    return jsonError('Uploaded the image but could not attach it to the product.', 500)
  }

  // remove the previous image (replace semantics)
  if (product.image_path && product.image_path !== path) {
    await admin.storage.from('product-images').remove([product.image_path]).catch((e) => {
      logError('api/products/image:remove-old', e)
    })
  }

  const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/product-images/${path}`
  return NextResponse.json({ path, url: publicUrl }, { status: 201 })
}

/**
 * DELETE /api/admin/products/[id]/image — remove the product image (safe:
 * only the storage object + the reference are removed).
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSessionPermission('manage_products')
  if (!guard.ok) return guard.response

  const { id } = await params
  const admin = createAdminClient()

  const { data: product } = await admin.from('products').select('id, image_path').eq('id', id).maybeSingle()
  if (!product) return jsonError('Product not found.', 404)
  if (!product.image_path) return jsonError('This product has no image.', 404)

  const { error: updateError } = await admin.from('products').update({ image_path: null }).eq('id', id)
  if (updateError) {
    logError('api/products/image:clear', updateError)
    return jsonError('Could not remove the image reference.', 400)
  }

  await admin.storage.from('product-images').remove([product.image_path]).catch((e) => {
    logError('api/products/image:delete', e)
  })

  return NextResponse.json({ ok: true })
}
