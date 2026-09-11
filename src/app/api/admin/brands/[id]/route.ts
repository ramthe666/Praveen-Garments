import { createAttributePatchHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/brands/[id] — edit / (de)activate a brand.
 */
export const PATCH = createAttributePatchHandler({
  table: 'brands',
  permission: 'manage_products',
  updateFields: ['name', 'description', 'is_active'],
})
