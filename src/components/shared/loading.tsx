import { Loader2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Inline spinner with optional label — used in buttons and small areas. */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm text-muted-foreground', className)} role="status" aria-live="polite">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  )
}

/** Full-panel loading state for pages. */
export function LoadingPanel({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-4', className)} role="status" aria-label="Loading content">
      <Skeleton className="h-7 w-48" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  )
}

/** Skeleton for table rows while a list query is in flight. */
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="w-full" role="status" aria-label="Loading table">
      <div className="flex gap-4 border-b px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b px-4 py-3.5">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading table data…</span>
    </div>
  )
}
