import { NextResponse, type NextRequest } from 'next/server'
import { readJson, requirePermission, rpcAsSession } from '@/lib/pos/api'

export const dynamic = 'force-dynamic'

/** POST /api/pos/held-bills/resume — resume a held bill (owner only). */
export async function POST(request: NextRequest) {
  const guard = await requirePermission('create_sale')
  if (!guard.ok) return guard.response

  const { body, error } = await readJson(request)
  if (error) return error

  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) {
    return NextResponse.json({ error: 'A held bill id is required.' }, { status: 400 })
  }

  const { data, error: rpcError } = await rpcAsSession<Record<string, unknown>>(
    'resume_held_bill',
    { p_id: id },
    'pos:resume',
    'Could not resume the held bill.'
  )
  if (rpcError) return rpcError

  return NextResponse.json(data)
}
