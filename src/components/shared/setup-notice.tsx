'use client'

import { Database } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * Shown when the authenticated user's session works but the Phase 1
 * migrations have not been applied yet (tables missing). Tells the operator
 * exactly what to do — no silent failures.
 */
export function SetupNotice({ className }: { className?: string }) {
  return (
    <Alert className={className}>
      <Database className="size-4" aria-hidden="true" />
      <AlertTitle>Database setup incomplete</AlertTitle>
      <AlertDescription>
        The application could not find its database tables. Apply the Phase 1
        migrations (<code className="rounded bg-muted px-1 py-0.5 text-xs">supabase/migrations/0001…0003</code>{' '}
        via the Supabase SQL Editor), then reload this page.
      </AlertDescription>
    </Alert>
  )
}
