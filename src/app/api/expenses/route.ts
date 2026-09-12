import { type NextRequest } from 'next/server'
import { requirePermission, readJson, rpcAsSession, str, num, validAmount } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'

export const dynamic = 'force-dynamic'

/**
 * POST  /api/expenses — record a business expense (PENDING; cashiers are
 *       denied by permission). Amount is recomputed server-side.
 * PATCH /api/expenses — { id, action } where action is:
 *   'approve' — requires approve_expense (Admin / Manager / Accountant)
 *   'cancel'  — with a reason; approved expenses can be cancelled too
 */
export async function POST(request: NextRequest) {
  const guard = await requirePermission('manage_expenses')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const categoryId = str(body, 'category_id')
  if (!categoryId) return jsonError('Choose an expense category.', 400)

  const description = str(body, 'description')
  if (!description || description.length > 200) {
    return jsonError('A description is required (up to 200 characters).', 400)
  }

  const amount = num(body, 'amount')
  if (amount === undefined || !validAmount(amount)) {
    return jsonError('Enter a valid amount (positive, up to 2 decimals).', 400)
  }

  const method = str(body, 'method')
  if (!method) return jsonError('Choose a payment method.', 400)

  const expenseDate = str(body, 'expense_date')
  if (expenseDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
    return jsonError('Expense date must be a valid date.', 400)
  }

  const payload: Record<string, unknown> = {
    category_id: categoryId,
    description,
    amount: Math.round(amount * 100) / 100,
    method,
    expense_date: expenseDate ?? '',
    notes: str(body, 'notes') ?? '',
  }
  const locationId = str(body, 'location_id')
  if (locationId) payload.location_id = locationId

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'create_expense',
    { p_payload: payload },
    'expenses:create',
    'Could not record the expense.'
  )
  if (rpcError) return rpcError
  return Response.json(data, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const { body, error } = await readJson(request)
  if (error) return error

  const id = str(body, 'id')
  const action = str(body, 'action')
  if (!id || !action) return jsonError('An expense id and action are required.', 400)

  if (action === 'approve') {
    const guard = await requirePermission('approve_expense')
    if (!guard.ok) return guard.response
    const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
      'approve_expense', { p_expense_id: id },
      'expenses:approve', 'Could not approve the expense.'
    )
    if (rpcError) return rpcError
    return Response.json(data)
  }

  if (action === 'cancel') {
    const guard = await requirePermission('manage_expenses')
    if (!guard.ok) return guard.response
    const reason = str(body, 'reason')
    if (!reason) return jsonError('A cancellation reason is required.', 400)
    const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
      'cancel_expense', { p_expense_id: id, p_reason: reason },
      'expenses:cancel', 'Could not cancel the expense.'
    )
    if (rpcError) return rpcError
    return Response.json(data)
  }

  return jsonError('Unknown action.', 400)
}
