import { createAttributePatchHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/admin/locations/[id] — edit / (de)activate a stock location.
 */
export const PATCH = createAttributePatchHandler({
  table: 'stock_locations',
  permission: 'manage_inventory',
  updateFields: ['name', 'code', 'location_type', 'branch_id', 'address', 'is_active'],
})
