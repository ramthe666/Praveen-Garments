'use client'

import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ErrorStateProps {
  title?: string
  message: string
  onRetry?: () => void
  className?: string
  /** compact renders as an inline alert instead of a tall block */
  compact?: boolean
}

/**
 * Visible error state — failures are surfaced, never swallowed.
 * `message` must already be user-safe (see lib/errors.toUserMessage).
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  className,
  compact,
}: ErrorStateProps) {
  if (compact) {
    return (
      <Alert variant="destructive" className={className} role="alert">
        <AlertTriangle className="size-4" aria-hidden="true" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-6 py-12 text-center',
        className
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive" aria-hidden="true">
        <AlertTriangle className="size-6" />
      </div>
      <div>
        <p className="text-[15px] font-medium text-foreground">{title}</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="size-4" aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  )
}
