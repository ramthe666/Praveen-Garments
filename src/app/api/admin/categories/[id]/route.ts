import { createAttributePatchHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/categories/[id] — edit / (de)activate a category.
 */
export const PATCH = createAttributePatchHandler({
  table: 'categories',
  permission: 'manage_products',
  updateFields: ['name', 'description', 'parent_id', 'is_active'],
})
