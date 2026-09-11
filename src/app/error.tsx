'use client'

import * as React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Root error boundary. Errors are surfaced to the user (never swallowed);
 * details stay in the console/server logs so nothing sensitive leaks.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  React.useEffect(() => {
    console.error('[app-error]', error.message, error.digest ?? '')
  }, [error])

  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center"
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive" aria-hidden="true">
        <AlertTriangle className="size-7" />
      </span>
      <div>
        <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          An unexpected error interrupted the application. Try again — if it keeps happening, sign
          out and sign back in.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground/70">Ref: {error.digest}</p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button onClick={reset} size="sm">
          <RotateCcw className="size-4" aria-hidden="true" />
          Try again
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href="/dashboard">Back to dashboard</a>
        </Button>
      </div>
    </div>
  )
}
