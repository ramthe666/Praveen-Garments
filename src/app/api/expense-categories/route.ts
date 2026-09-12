import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requirePermission, readJson, str } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'
import { logError, toUserMessage } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * POST  /api/expense-categories — create a category (data, not code).
 * PATCH /api/expense-categories — rename / deactivate / reactivate.
 * Permission: manage_settings (the same gate the RLS policy enforces).
 */
export async function POST(request: NextRequest) {
  const guard = await requirePermission('manage_settings')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const name = str(body, 'name')
  if (!name || name.length < 2 || name.length > 60) {
    return jsonError('Category names are 2–60 characters.', 400)
  }

  const session = await createClient()
  const { data, error: insertError } = await session
    .from('expense_categories')
    .insert({ name } as never)
    .select('id, name, is_active')
    .single()

  if (insertError) {
    logError('expense-categories:create', insertError)
    return jsonError(toUserMessage(insertError, 'Could not create the category.'), 400)
  }
  return NextResponse.json(data, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const guard = await requirePermission('manage_settings')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const id = str(body, 'id')
  if (!id) return jsonError('A category id is required.', 400)

  const record: Record<string, unknown> = {}
  const name = str(body, 'name')
  if (name !== undefined) {
    if (name.length < 2 || name.length > 60) {
      return jsonError('Category names are 2–60 characters.', 400)
    }
    record.name = name
  }
  if (body.is_active === true) record.is_active = true
  if (body.is_active === false) record.is_active = false
  if (Object.keys(record).length === 0) return jsonError('Nothing to update.', 400)

  const session = await createClient()
  const { data, error: updateError } = await session
    .from('expense_categories')
    .update(record as never)
    .eq('id', id)
    .select('id, name, is_active')
    .single()

  if (updateError) {
    logError('expense-categories:update', updateError)
    return jsonError(toUserMessage(updateError, 'Could not update the category.'), 400)
  }
  return NextResponse.json(data)
}
