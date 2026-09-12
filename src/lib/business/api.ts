import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import { readJson } from '@/lib/pos/api'
import type { AppPermission } from '@/types/database'

/**
 * Shared helpers for Phase 4 business API routes (customers, suppliers,
 * purchases, returns, exchanges, expenses).
 *
 * Same write-path pattern as the Phase 3 POS routes: guard the permission
 * with the CALLER's session, then execute the RPC through the caller's
 * session client — the database re-checks authorisation inside every
 * SECURITY DEFINER function (defense in depth) and audit rows are
 * attributed to auth.uid() correctly.
 */

export { readJson }

export async function requirePermission(permission: AppPermission) {
  return requireSessionPermission(permission)
}

/** Run an RPC through the caller's session client and normalise errors. */
export async function rpcAsSession<T>(
  fn: string,
  args: Record<string, unknown>,
  scope: string,
  fallback: string
): Promise<{ data: T | null; error: NextResponse | null }> {
  const session = await createClient()
  const { data, error } = await session.rpc(fn as never, args as never)
  if (error) {
    logError(`${scope}:${fn}`, error)
    return { data: null, error: jsonError(rpcErrorMessage(error, fallback), 400) }
  }
  return { data: (data ?? null) as T | null, error: null }
}

/**
 * Translate a business RPC error into a friendly message. The RPCs raise
 * deliberate, user-facing text with a stable ALL_CAPS code prefix
 * ("PAYMENT_EXCEEDS_DUE: …") — the code is for logs/support, the human
 * sentence after it is what the user sees. Unknown errors fall back to a
 * generic message (never leak SQL internals).
 */
export function rpcErrorMessage(error: unknown, fallback: string): string {
  const e = error as { message?: string }
  const message = typeof e?.message === 'string' ? e.message.trim() : ''
  if (!message) return fallback
  const coded = message.match(/^([A-Z][A-Z0-9_]+):\s+(.+)$/)
  const sentence = coded ? coded[2] : message
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** Read a trimmed string field from a JSON body ('' → undefined). */
export function str(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read a positive number field from a JSON body. */
export function num(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field]
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Validate money: positive, at most 2 decimals. */
export function validAmount(value: number | undefined): boolean {
  return value !== undefined && value > 0 && Math.round(value * 100) === value * 100
}

/** Standard pagination bounds (database clamps again). */
export function pageParams(request: NextRequest): { limit: number; offset: number } {
  const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? 25)
  const offsetRaw = Number(request.nextUrl.searchParams.get('offset') ?? 0)
  return {
    limit: Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 25, 1), 100),
    offset: Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0),
  }
}
