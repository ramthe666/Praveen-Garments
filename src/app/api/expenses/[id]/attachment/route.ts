import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/business/api'
import { jsonError } from '@/lib/api/guard'
import { logError, toUserMessage } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/expenses/[id]/attachment — upload a receipt/attachment for an
 * expense. multipart/form-data with a single `file` field.
 *
 * Server-side validation (the bucket enforces the same limits again):
 *   - types: PNG / JPEG / WebP / PDF
 *   - size: 5 MB max
 * The bucket is PRIVATE — downloads go through signed URLs created with the
 * caller's session, and every object is namespaced under the expense id.
 */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
const MAX_BYTES = 5 * 1024 * 1024

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('manage_expenses')
  if (!guard.ok) return guard.response

  const { id } = await params
  if (!id) return jsonError('An expense id is required.', 400)

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonError('Expected a multipart form upload.', 400)
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return jsonError('Choose a file to upload.', 400)
  }
  if (!ALLOWED.has(file.type)) {
    return jsonError('Attachments must be PNG, JPEG, WebP or PDF files.', 415)
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return jsonError('Attachments must be between 1 byte and 5 MB.', 413)
  }

  const session = await createClient()

  // the expense must exist and belong to this caller's view (RLS scopes it)
  const { data: expense, error: fetchError } = await session
    .from('expenses')
    .select('id, expense_number, attachment_path')
    .eq('id', id)
    .maybeSingle()
  if (fetchError) {
    logError('expenses:attachment:fetch', fetchError)
    return jsonError(toUserMessage(fetchError, 'Could not find the expense.'), 400)
  }
  if (!expense) return jsonError('Expense not found.', 404)

  const ext = file.type === 'application/pdf' ? 'pdf' : (file.type.split('/')[1] ?? 'bin')
  const path = `${id}/${crypto.randomUUID()}.${ext}`

  const { error: uploadError } = await session.storage
    .from('expense-attachments')
    .upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) {
    logError('expenses:attachment:upload', uploadError)
    return jsonError(toUserMessage(uploadError, 'Could not upload the file.'), 400)
  }

  // replace any previous attachment metadata (old objects age out with the
  // storage lifecycle; keeping one file per expense keeps the UI simple)
  const { error: updateError } = await session
    .from('expenses')
    .update({
      attachment_path: path,
      attachment_name: file.name.slice(0, 120),
      attachment_size: file.size,
      attachment_mime: file.type,
    } as never)
    .eq('id', id)
  if (updateError) {
    logError('expenses:attachment:update', updateError)
    // roll the uploaded object back so no orphan file remains
    await session.storage.from('expense-attachments').remove([path])
    return jsonError(toUserMessage(updateError, 'Could not attach the file to the expense.'), 400)
  }

  return NextResponse.json({
    path,
    name: file.name,
    size: file.size,
    mime: file.type,
  })
}
