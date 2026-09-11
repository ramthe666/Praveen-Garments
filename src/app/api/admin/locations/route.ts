import { createAttributePostHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/locations — create a stock location (store / warehouse).
 */
export const POST = createAttributePostHandler({
  table: 'stock_locations',
  permission: 'manage_inventory',
  createFields: ['name', 'code', 'location_type', 'branch_id', 'address', 'is_active'],
})
