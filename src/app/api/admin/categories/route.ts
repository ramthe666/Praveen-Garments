import { createAttributePostHandler } from '@/lib/catalog/api'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/categories — create a category (or subcategory via parent_id).
 * Manage-products holders only (guarded server-side; RLS also applies).
 */
export const POST = createAttributePostHandler({
  table: 'categories',
  permission: 'manage_products',
  createFields: ['name', 'description', 'parent_id', 'is_active'],
})
