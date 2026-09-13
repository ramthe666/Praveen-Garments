/**
 * Centralised, safe error handling. Never swallow failures silently:
 * every helper here logs and either rethrows or converts to a
 * user-presentable message.
 */

/** PostgREST/Postgres error shape (subset we rely on). */
export interface DbErrorLike {
  code?: string
  message?: string
  details?: string | null
  hint?: string | null
  error?: unknown
}

/** true when a query failed because the table/schema is missing (pre-migration). */
export function isTableMissing(error: unknown): boolean {
  const e = error as DbErrorLike
  return (
    e?.code === 'PGRST205' || // table not found in schema cache
    e?.code === 'PGRST202' || // function not found in schema cache
    (typeof e?.message === 'string' && /relation .* does not exist/i.test(e.message)) ||
    (typeof e?.message === 'string' && /Could not find the (table|function)/i.test(e.message))
  )
}

/** true when a query failed due to RLS denial (row not visible / not permitted). */
export function isPermissionDenied(error: unknown): boolean {
  const e = error as DbErrorLike
  return (
    e?.code === '42501' ||
    (typeof e?.message === 'string' &&
      /row-level security policy|permission denied for/i.test(e.message))
  )
}

/**
 * true when a service-role (admin client) call was rejected because
 * SUPABASE_SERVICE_ROLE_KEY on the server is stale/invalid (Supabase returns
 * 401 "Invalid API key"). This is a SERVER CONFIGURATION problem, never a
 * user-input problem — callers must surface it as such instead of pretending
 * a row "was not found".
 */
export function isServiceKeyRejected(error: unknown): boolean {
  const e = error as DbErrorLike
  const message = typeof e?.message === 'string' ? e.message.toLowerCase() : ''
  return (
    e?.code === '401' ||
    message.includes('invalid api key') ||
    // PostgREST wraps auth rejections differently in some versions
    (message.includes('401') && message.includes('unauthorized'))
  )
}

/** Honest, actionable message for stale service-key failures (admin-only features). */
export const SERVICE_KEY_INVALID_MESSAGE =
  'This feature needs the server service key, which appears to be outdated. ' +
  'Ask the owner to paste the current SUPABASE_SERVICE_ROLE_KEY from Supabase → Settings → API ' +
  'into the server .env.local and restart the app.'

/** Log the full error server-side (never swallow), keeping PII out of it. */
export function logError(scope: string, error: unknown): void {
  const e = error as DbErrorLike
  const code = e?.code ?? 'UNKNOWN'
  const message = e?.message ?? String(error)
  if (process.env.NODE_ENV !== 'production') {
    console.error(`[${scope}] (${code}) ${message}`)
  } else {
    console.error(`[${scope}] (${code})`)
  }
}

/**
 * Convert an unknown error to a safe, user-presentable message.
 * Never leaks SQL details, schema names or stack traces.
 */
export function toUserMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = error as DbErrorLike

  if (isTableMissing(error)) {
    return 'Database setup is not complete yet. Please apply the pending migrations.'
  }
  if (isPermissionDenied(error)) {
    return 'You do not have permission to perform this action.'
  }

  switch (e?.code) {
    case '23505':
    case '23505 ':
      return 'This record already exists. Please use a different value.'
    case '23514':
      return 'One of the values is invalid. Please check the form and try again.'
    case '23503':
      return 'This record is referenced elsewhere and cannot be changed this way.'
    case '22P02':
      return 'Invalid identifier supplied.'
    case 'PGRST116':
      return 'Record not found.'
    default:
      break
  }

  if (typeof e?.message === 'string') {
    if (/failed to fetch/i.test(e.message)) return 'Network error. Check your connection and try again.'
  }

  return fallback
}

/** Extract a message from Supabase Auth errors (safe for display). */
export function authErrorMessage(error: unknown): string {
  const e = error as DbErrorLike
  const message = typeof e?.message === 'string' ? e.message.toLowerCase() : ''

  if (message.includes('invalid login credentials')) {
    return 'Incorrect email or password.'
  }
  if (message.includes('email not confirmed')) {
    return 'This account has not been confirmed yet. Contact your administrator.'
  }
  if (message.includes('user is banned') || message.includes('user disabled')) {
    return 'This account has been disabled. Contact your administrator.'
  }
  if (message.includes('password should be at least')) {
    return 'Password must be at least 8 characters.'
  }
  if (message.includes('invalid email')) {
    return 'Please enter a valid email address.'
  }
  if (message.includes('rate limit') || message.includes('too many')) {
    return 'Too many attempts. Please wait a moment and try again.'
  }
  if (message.includes('email address') && message.includes('authorized')) {
    return 'This email is not authorized to sign in.'
  }
  return 'Sign-in failed. Please try again.'
}
