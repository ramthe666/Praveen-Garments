import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import type { AppPermission } from '@/types/database'

/**
 * Shared helpers for Phase 2 admin API routes.
 *
 * Write path: guard permission with the CALLER's session (database-side),
 * then mutate through the caller's session client as well — RLS re-checks
 * the permission inside the database (defense in depth) and the audit
 * triggers can attribute auth.uid() correctly. The service-role client is
 * reserved for compensation/cleanup paths that have no RLS policy.
 * Reads happen client-side through RLS-scoped queries.
 */

/** Parse a JSON body, returning null (with a 400 response) on failure. */
export async function readJson(
  request: NextRequest
): Promise<{ body: Record<string, unknown>; error: null } | { body: null; error: NextResponse }> {
  try {
    const body = await request.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { body: null, error: jsonError('Invalid request body.', 400) }
    }
    return { body: body as Record<string, unknown>, error: null }
  } catch {
    return { body: null, error: jsonError('Invalid request body.', 400) }
  }
}

/** Standard duplicate-key translation for catalog tables. */
export function duplicateMessage(constraint: string | undefined): string | null {
  if (!constraint) return null
  if (constraint.includes('sku_key')) return 'This SKU is already used by another variant.'
  if (constraint.includes('barcode_key')) return 'This barcode is already used by another variant.'
  if (constraint.includes('qr_key')) return 'This QR identifier is already used by another variant.'
  if (constraint.includes('product_code_key')) return 'This product code is already used by another product.'
  if (constraint.includes('categories_parent_name_key')) return 'A category with this name already exists at this level.'
  if (constraint.includes('brands_name_key')) return 'A brand with this name already exists.'
  if (constraint.includes('sizes_name_key')) return 'A size with this name already exists.'
  if (constraint.includes('colors_name_key')) return 'A color with this name already exists.'
  if (constraint.includes('stock_locations_code_key')) return 'A location with this code already exists.'
  return null
}

/**
 * Translate a Supabase/PostgREST mutation error into a safe user message,
 * preferring the database's own deliberate messages (ours raise clear,
 * pre-written text) over internals.
 */
export function mutationErrorMessage(error: unknown, fallback: string): string {
  const e = error as { message?: string; code?: string; details?: string | null }
  const message = typeof e?.message === 'string' ? e.message : ''
  const details = typeof e?.details === 'string' ? e.details : ''

  const dup = duplicateMessage(details.match(/constraint "([^"]+)"/)?.[1] ?? undefined)
  if (e?.code === '23505' || /duplicate key value/i.test(message)) {
    return dup ?? 'This value is already in use.'
  }

  // Our RPCs raise deliberate, user-facing messages. Pass them through when
  // they match the known prefixes; otherwise fall back to a generic message
  // (never leak SQL/schema internals).
  const knownPrefixes = [
    'Duplicate SKU',
    'Duplicate barcode',
    'Duplicate QR identifier',
    'INSUFFICIENT_STOCK',
    'OPENING_EXISTS',
    'You do not have permission',
    'A reason is required',
    'Opening stock quantity',
    'Transfer quantity',
    'Source and destination',
    'Quantity must be',
    'Invalid movement type',
    'Invalid size selected',
    'Invalid color selected',
    'Variant not found',
    'Product not found',
    'Stock location not found',
    'Reorder level',
    'At least one variant',
    'SKU ',
    'Barcode must be',
    'QR identifier must be',
    'Invalid ',
    ' cannot be negative',
  ]
  if (knownPrefixes.some((p) => message.startsWith(p))) {
    return message
  }

  return fallback
}

// ---------------------------------------------------------------------------
// Generic attribute CRUD factory (categories / brands / sizes / colors /
// stock locations) — thin, per-table config, everything validated server-side.
// ---------------------------------------------------------------------------

export interface AttributeCreateConfig {
  table: 'categories' | 'brands' | 'sizes' | 'colors' | 'stock_locations'
  permission: AppPermission
  /** Field names allowed in the INSERT payload (after validation). */
  createFields: string[]
}

export interface AttributeUpdateConfig {
  table: 'categories' | 'brands' | 'sizes' | 'colors' | 'stock_locations'
  permission: AppPermission
  /** Field names allowed in the PATCH payload. */
  updateFields: string[]
}

type AdminClient = ReturnType<typeof createAdminClient>
type SessionClient = Awaited<ReturnType<typeof createClient>>

/** Minimal structural types for a single-row mutation chain (the full
 *  supabase-js generic surface fights table-union call sites; the fields
 *  themselves are allow-listed and validated before reaching here). */
interface SingleResult {
  data: unknown
  error: unknown
}
interface InsertBuilder {
  insert: (values: Record<string, unknown>) => { select: () => { single: () => Promise<SingleResult> } }
}
interface UpdateBuilder {
  update: (values: Record<string, unknown>) => { eq: (column: string, value: string) => { select: () => { single: () => Promise<SingleResult> } } }
}

/** Generic single-row insert. */
async function insertOne(
  client: AdminClient | SessionClient,
  table: string,
  record: Record<string, unknown>
): Promise<SingleResult> {
  return ((client as AdminClient).from(table) as unknown as InsertBuilder).insert(record).select().single()
}

/** Generic single-row update by id. */
async function updateOne(
  client: AdminClient | SessionClient,
  table: string,
  id: string,
  record: Record<string, unknown>
): Promise<SingleResult> {
  return ((client as AdminClient).from(table) as unknown as UpdateBuilder).update(record).eq('id', id).select().single()
}

export function createAttributePostHandler(config: AttributeCreateConfig) {
  return async function POST(request: NextRequest) {
    const guard = await requireSessionPermission(config.permission)
    if (!guard.ok) return guard.response

    const { body, error } = await readJson(request)
    if (error) return error

    const record: Record<string, unknown> = {}
    for (const field of config.createFields) {
      if (field in body) record[field] = body[field]
    }

    // Write through the CALLER's session so RLS re-checks the permission and
    // the audit triggers can attribute auth.uid().
    const session = await createClient()
    const { data, error: insertError } = await insertOne(session, config.table, record)

    if (insertError) {
      logError(`api/${config.table}:create`, insertError)
      return jsonError(mutationErrorMessage(insertError, 'Could not create the record.'), 400)
    }

    return NextResponse.json(data, { status: 201 })
  }
}

export function createAttributePatchHandler(config: AttributeUpdateConfig) {
  return async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const guard = await requireSessionPermission(config.permission)
    if (!guard.ok) return guard.response

    const { id } = await params
    const { body, error } = await readJson(request)
    if (error) return error

    const record: Record<string, unknown> = {}
    for (const field of config.updateFields) {
      if (field in body) record[field] = body[field]
    }
    if (Object.keys(record).length === 0) {
      return jsonError('Nothing to update.', 400)
    }

    // Write through the CALLER's session so RLS re-checks the permission and
    // the audit triggers can attribute auth.uid().
    const session = await createClient()
    const { data, error: updateError } = await updateOne(session, config.table, id, record)

    if (updateError) {
      logError(`api/${config.table}:update`, updateError)
      return jsonError(mutationErrorMessage(updateError, 'Could not update the record.'), 400)
    }
    if (!data) {
      return jsonError('Record not found.', 404)
    }

    return NextResponse.json(data)
  }
}
