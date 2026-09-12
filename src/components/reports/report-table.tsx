'use client'

/**
 * Generic report table: raw <table> in the app's established style with
 * responsive column hiding, client-side sort of the loaded page, optional
 * footer totals row and offset pagination.
 */
import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/shared/empty-state'
import { DataTablePagination } from '@/components/shared/data-table-pagination'
import { colHidden, type ReportColumn } from '@/lib/reports/shared'
import { cn } from '@/lib/utils'

export function ReportTable<T extends Record<string, unknown>>({
  columns,
  rows,
  loading,
  emptyTitle = 'No records found',
  emptyDescription,
  sortKey,
  sortDir,
  onSortChange,
  footer,
  page,
  pageSize,
  total,
  onPageChange,
  rowKey,
}: {
  columns: ReportColumn<T>[]
  rows: T[]
  loading?: boolean
  emptyTitle?: string
  emptyDescription?: string
  sortKey?: string
  sortDir?: 'asc' | 'desc'
  onSortChange?: (key: string) => void
  footer?: React.ReactNode
  page?: number
  pageSize?: number
  total?: number
  onPageChange?: (page: number) => void
  rowKey: (row: T, index: number) => string
}) {
  const [localSort, setLocalSort] = React.useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)

  const effectiveSort = sortKey ? { key: sortKey, dir: sortDir ?? 'desc' } : localSort

  const visibleRows = React.useMemo(() => {
    if (!effectiveSort || !columns.some((c) => c.key === effectiveSort.key && c.sortable)) return rows
    const col = columns.find((c) => c.key === effectiveSort.key)
    const dir = effectiveSort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[effectiveSort.key]
      const bv = b[effectiveSort.key]
      const an = typeof av === 'number' ? av : Number(av)
      const bn = typeof bv === 'number' ? bv : Number(bv)
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir
    })
  }, [rows, effectiveSort, columns])

  function toggleSort(key: string) {
    if (onSortChange) {
      onSortChange(key)
      return
    }
    const col = columns.find((c) => c.key === key)
    if (!col?.sortable) return
    setLocalSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: col.align === 'right' ? 'desc' : 'asc' },
    )
  }

  return (
    <div className="rounded-lg border bg-card shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    'px-3 py-2.5 font-medium',
                    c.align === 'right' && 'text-right',
                    colHidden(c.hide),
                    (c.sortable || onSortChange) && 'cursor-pointer select-none hover:text-foreground',
                  )}
                  onClick={(c.sortable || onSortChange) ? () => toggleSort(c.key) : undefined}
                  aria-sort={
                    effectiveSort?.key === c.key
                      ? effectiveSort.dir === 'asc' ? 'ascending' : 'descending'
                      : c.sortable ? 'none' : undefined
                  }
                >
                  <span className={cn('inline-flex items-center gap-1', c.align === 'right' && 'justify-end')}>
                    {c.header}
                    {(c.sortable || onSortChange) ? (
                      effectiveSort?.key === c.key ? (
                        effectiveSort.dir === 'asc'
                          ? <ArrowUp className="size-3" aria-hidden="true" />
                          : <ArrowDown className="size-3" aria-hidden="true" />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
                      )
                    ) : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-3 py-3', colHidden(c.hide))}>
                      <Skeleton className={cn('h-4', c.align === 'right' ? 'ml-auto w-16' : 'w-full max-w-32')} />
                    </td>
                  ))}
                </tr>
              ))
            ) : visibleRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-2">
                  <EmptyState
                    title={emptyTitle}
                    description={emptyDescription ?? 'Try widening the date range or clearing filters.'}
                    compact
                  />
                </td>
              </tr>
            ) : (
              visibleRows.map((row, i) => (
                <tr key={rowKey(row, i)} className="hover:bg-muted/40">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn('px-3 py-2.5 align-middle', c.align === 'right' && 'text-right tabular-nums', colHidden(c.hide))}
                    >
                      {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {footer && visibleRows.length > 0 ? (
            <tfoot className="border-t bg-muted/30 font-medium">
              {footer}
            </tfoot>
          ) : null}
        </table>
      </div>
      {page !== undefined && pageSize !== undefined && total !== undefined && onPageChange ? (
        <div className="border-t px-3 py-2">
          <DataTablePagination page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} />
        </div>
      ) : null}
    </div>
  )
}
