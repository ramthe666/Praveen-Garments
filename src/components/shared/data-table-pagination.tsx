'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Server-side pagination control for data tables.
 * Range-based (offset) pagination via PostgREST `.range()` — index-friendly
 * for the page sizes used in admin lists. (Cursor pagination is introduced
 * for high-volume history tables in later phases.)
 */
export function DataTablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  className,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  className?: string
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)

  return (
    <nav
      aria-label="Table pagination"
      className={cn('flex flex-col items-center justify-between gap-3 px-1 sm:flex-row', className)}
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {total === 0 ? 'No records' : `Showing ${from}–${to} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Previous</span>
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  )
}
