import { createAttributePostHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/brands — create a brand.
 */
export const POST = createAttributePostHandler({
  table: 'brands',
  permission: 'manage_products',
  createFields: ['name', 'description', 'is_active'],
})
