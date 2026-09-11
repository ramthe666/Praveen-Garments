import { createAttributePostHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/colors — create a color (name + optional hex).
 */
export const POST = createAttributePostHandler({
  table: 'colors',
  permission: 'manage_products',
  createFields: ['name', 'hex_code', 'is_active'],
})
