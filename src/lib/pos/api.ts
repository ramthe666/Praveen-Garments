import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireSessionPermission, jsonError } from '@/lib/api/guard'
import { logError } from '@/lib/errors'
import type { AppPermission } from '@/types/database'

/**
 * Shared helpers for Phase 3 POS / billing API routes.
 *
 * Same write-path pattern as the Phase 2 catalog routes: guard the
 * permission with the CALLER's session, then execute the RPC through the
 * caller's session client as well — the database re-checks authorisation
 * inside each SECURITY DEFINER function (defense in depth) and audit rows
 * are attributed to auth.uid() correctly.
 */

/** Parse a JSON body, returning a 400 response on failure. */
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

/** Wrap requireSessionPermission for a single permission. */
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
  // The rpc() generic expects the typed function-name union; the names are
  // fixed constants at every call site here.
  const { data, error } = await session.rpc(fn as never, args as never)
  if (error) {
    logError(`${scope}:${fn}`, error)
    return { data: null, error: jsonError(posErrorMessage(error, fallback), 400) }
  }
  return { data: (data ?? null) as T | null, error: null }
}

/**
 * Translate a create_sale / cancel_sale / hold-bill error into a
 * cashier-friendly message. The RPCs raise deliberate, user-facing text
 * with a stable ALL_CAPS code prefix ("CREDIT_NOT_ENABLED: …") — the code
 * is for logs/support, the human sentence after it is what the cashier
 * sees. Unknown errors fall back to a generic message (never leak SQL
 * internals).
 */
export function posErrorMessage(error: unknown, fallback: string): string {
  const e = error as { message?: string; code?: string }
  const message = typeof e?.message === 'string' ? e.message.trim() : ''

  if (!message) return fallback

  // "SOME_CODE: human sentence" → show only the human sentence, capitalised.
  const coded = message.match(/^([A-Z][A-Z0-9_]+):\s+(.+)$/)
  if (coded && RPC_CODE_PREFIXES.has(coded[1])) {
    const human = coded[2].trim()
    return human.charAt(0).toUpperCase() + human.slice(1)
  }

  if (knownPrefixes.some((p) => message.startsWith(p))) {
    return message
  }
  return fallback
}

const RPC_CODE_PREFIXES = new Set([
  'INSUFFICIENT_STOCK',
  'PRICE_OVERRIDE_NOT_ALLOWED',
  'DISCOUNT_NOT_ALLOWED',
  'DISCOUNT_LIMIT',
  'CREDIT_NOT_ENABLED',
  'CREDIT_REQUIRES_CUSTOMER',
  'CREDIT_MISMATCH',
  'CUSTOMER_REQUIRED',
  'PAYMENT_METHOD_DISABLED',
  'PAYMENT_EXCEEDS_TOTAL',
  'CASH_RECEIVED_LESS',
  'NO_SELLING_PRICE',
  'VARIANT_NOT_FOUND',
  'VARIANT_INACTIVE',
  'PRODUCT_INACTIVE',
])

const knownPrefixes = [
    'INSUFFICIENT_STOCK',
    'PRICE_OVERRIDE_NOT_ALLOWED',
    'DISCOUNT_NOT_ALLOWED',
    'DISCOUNT_LIMIT',
    'CREDIT_NOT_ENABLED',
    'CREDIT_REQUIRES_CUSTOMER',
    'CREDIT_MISMATCH',
    'CUSTOMER_REQUIRED',
    'PAYMENT_METHOD_DISABLED',
    'PAYMENT_EXCEEDS_TOTAL',
    'CASH_RECEIVED_LESS',
    'NO_SELLING_PRICE',
    'VARIANT_NOT_FOUND',
    'VARIANT_INACTIVE',
    'PRODUCT_INACTIVE',
    'You do not have permission',
    'Your account is not active',
    'Not authenticated',
    'The cart is empty',
    'Duplicate cart line',
    'Invalid quantity',
    'Invalid price',
    'Invalid discount',
    'Discount cannot',
    'Discount greater',
    'Bill discount',
    'A payment method',
    'Each payment amount',
    'Invalid payment amount',
    'A reason is required',
    'Only completed sales',
    'Sale not found',
    'Customer not found',
    'Stock location not found',
    'No active stock location',
    'Held bill not found',
    'This held bill',
    'Nothing to hold',
  ]
