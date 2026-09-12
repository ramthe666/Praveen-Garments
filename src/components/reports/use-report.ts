'use client'

/**
 * Report data hook: calls a JSONB-returning report RPC with the browser
 * (anon) client — RLS + the RPC's own permission gate apply. Handles
 * loading / error / migration-pending states and a manual retry.
 */
import * as React from 'react'
import { createClient } from '@/lib/supabase/client'
import { isTableMissing, isPermissionDenied, logError } from '@/lib/errors'

interface DbErrorLike {
  code?: string
  message?: string
}

export interface ReportQueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
  setupNeeded: boolean
  retry: () => void
}

export function useReportQuery<T>(
  fnName: string,
  args: Record<string, unknown>,
): ReportQueryState<T> {
  const supabase = React.useMemo(() => createClient(), [])
  const [data, setData] = React.useState<T | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [setupNeeded, setSetupNeeded] = React.useState(false)
  const [nonce, setNonce] = React.useState(0)
  const argKey = JSON.stringify(args)

  React.useEffect(() => {
    let cancelled = false
    const scope = `reports:${fnName}`
    setLoading(true)
    setError(null)
    void (async () => {
      // Keep the method bound to the client (supabase.rpc reads `this.rest`).
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        a: Record<string, unknown>,
      ) => PromiseLike<{ data: unknown; error: DbErrorLike | null }>
      const { data: d, error: e } = await rpc(fnName, JSON.parse(argKey) as Record<string, unknown>)
      if (cancelled) return
      if (e) {
        logError(scope, e)
        setSetupNeeded(isTableMissing(e))
        setError(
          isPermissionDenied(e)
            ? 'You do not have permission to view this report.'
            : 'The report could not be loaded. Please try again.',
        )
        setData(null)
      } else {
        setSetupNeeded(false)
        setError(null)
        setData(d as T)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [supabase, fnName, argKey, nonce])

  return {
    data,
    loading,
    error,
    setupNeeded,
    retry: React.useCallback(() => setNonce((n) => n + 1), []),
  }
}

/** Re-fetch a report with a big (but bounded) page for CSV export. */
export async function fetchReportExport<T>(
  fnName: string,
  args: Record<string, unknown>,
  limit = 5000,
): Promise<{ rows: T[]; total: number } | { error: string }> {
  const supabase = createClient()
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    a: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: DbErrorLike | null }>
  const { data, error } = await rpc(fnName, { ...args, p_limit: limit, p_offset: 0 })
  if (error) {
    logError(`reports-export:${fnName}`, error)
    return { error: 'The export could not be generated. Please try again.' }
  }
  const result = data as { rows?: T[]; total?: number } | T[] | null
  if (Array.isArray(result)) return { rows: result, total: result.length }
  return {
    rows: ((result as { rows?: T[] } | null)?.rows ?? []) as T[],
    total: Number((result as { total?: number } | null)?.total ?? 0),
  }
}
