'use client'

import { Database } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * Shown when Phase 2 tables/RPCs are missing (migrations 0004-0006 not
 * applied yet). Tells the operator exactly what to do — never silent.
 */
export function Phase2SetupNotice({ className }: { className?: string }) {
  return (
    <Alert className={className}>
      <Database className="size-4" aria-hidden="true" />
      <AlertTitle>Product catalog setup incomplete</AlertTitle>
      <AlertDescription>
        The Phase 2 database migrations are not applied yet. Run{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">0004</code>,{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">0005</code> and{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">0006</code> from{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">supabase/migrations/</code> in the
        Supabase SQL Editor (in order), then reload this page.
      </AlertDescription>
    </Alert>
  )
}
