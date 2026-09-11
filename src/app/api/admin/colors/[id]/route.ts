import { createAttributePatchHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/colors/[id] — edit / (de)activate a color.
 */
export const PATCH = createAttributePatchHandler({
  table: 'colors',
  permission: 'manage_products',
  updateFields: ['name', 'hex_code', 'is_active'],
})
