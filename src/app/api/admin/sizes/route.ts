import { createAttributePostHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/sizes — create a size (configurable; never hardcoded in UI).
 */
export const POST = createAttributePostHandler({
  table: 'sizes',
  permission: 'manage_products',
  createFields: ['name', 'sort_order', 'is_active'],
})
