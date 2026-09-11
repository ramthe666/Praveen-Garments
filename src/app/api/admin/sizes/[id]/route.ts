import { createAttributePatchHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/sizes/[id] — edit / (de)activate a size.
 */
export const PATCH = createAttributePatchHandler({
  table: 'sizes',
  permission: 'manage_products',
  updateFields: ['name', 'sort_order', 'is_active'],
})
