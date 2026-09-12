'use client'

/**
 * Shared reporting kit (Phase 5).
 * - period presets in the STORE timezone (mirrors the DB-side boundaries
 *   used by the report RPCs: [from 00:00, to+1 00:00))
 * - CSV export (bounded, client-side, from already-fetched rows)
 * - column / filter / summary types used by the generic report views
 */
import type { ReactNode } from 'react'
import { useDebounced } from '@/lib/catalog/constants'
import { PERIOD_OPTIONS, periodLabel, resolvePeriod, storeToday, ymd, type PeriodPreset } from '@/lib/reports/period'

export { PERIOD_OPTIONS, periodLabel, resolvePeriod, storeToday, ymd }
export type { PeriodPreset }

export const STORE_TZ = 'Asia/Kolkata'

// ---------------------------------------------------------------------------
// RPC result shapes
// ---------------------------------------------------------------------------

export type PageResult<T> = { rows: T[]; total: number; total_is_estimate?: boolean; summary?: Record<string, number> }
export type NumberMap = Record<string, number | null>

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

export type ColumnAlignment = 'left' | 'right'

export interface ReportColumn<T> {
  key: string
  header: string
  align?: ColumnAlignment
  /** Rendered cell (defaults to raw value). */
  render?: (row: T) => ReactNode
  /** CSV cell value (defaults to raw value via String()). */
  csv?: (row: T) => string | number | null | undefined
  /** Hide below this breakpoint to keep wide tables usable on phones. */
  hide?: 'sm' | 'md' | 'lg' | 'xl'
  /** Column participates in client-side sorting of the current page. */
  sortable?: boolean
}

export function colHidden(hide: 'sm' | 'md' | 'lg' | 'xl' | undefined): string {
  switch (hide) {
    case 'sm': return 'hidden sm:table-cell'
    case 'md': return 'hidden md:table-cell'
    case 'lg': return 'hidden lg:table-cell'
    case 'xl': return 'hidden xl:table-cell'
    default: return ''
  }
}

// ---------------------------------------------------------------------------
// CSV export (bounded — always exports the currently loaded/filtered page
// set, capped by the RPC limits; never streams unbounded data)
// ---------------------------------------------------------------------------

export function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function downloadCsv(filename: string, headers: string[], cells: (string | number | null | undefined)[][]): void {
  const lines = [headers.map(csvEscape).join(','), ...cells.map((row) => row.map(csvEscape).join(','))]
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Format a number for CSV exports (no currency symbol, 2 decimals). */
export function csvMoney(v: number | string | null | undefined): string {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n.toFixed(2) : ''
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export { useDebounced }
