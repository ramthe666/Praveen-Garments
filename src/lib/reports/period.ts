/**
 * Period preset helpers (pure functions — usable from both server and
 * client components). Resolves calendar dates in the STORE timezone,
 * mirroring the DB-side [from 00:00, to+1 00:00) boundaries used by the
 * report RPCs.
 */

export const STORE_TZ = 'Asia/Kolkata'

export type PeriodPreset = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'this_year' | 'custom' | 'all'

export const PERIOD_OPTIONS: { value: PeriodPreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'this_year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
  { value: 'all', label: 'All time' },
]

export function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** Current date in the store timezone as a calendar (ymd) string. */
export function storeToday(timeZone = STORE_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
}

/**
 * Resolve [from, to] ymd strings for a preset in the store timezone.
 * 'custom' returns null — the caller supplies explicit dates.
 */
export function resolvePeriod(preset: PeriodPreset, timeZone = STORE_TZ): { from: string; to: string } | null {
  if (preset === 'custom') return null
  const today = storeToday(timeZone)
  const [y, m, d] = today.split('-').map(Number)
  const now = new Date()
  const dow = (now.getDay() + 6) % 7 // Monday = start of the retail week

  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const yd = new Date(Date.UTC(y, m - 1, d - 1))
      return { from: ymd(yd), to: ymd(yd) }
    }
    case 'this_week': {
      const start = new Date(Date.UTC(y, m - 1, d - dow))
      return { from: ymd(start), to: today }
    }
    case 'this_month':
      return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: today }
    case 'this_year':
      return { from: `${y}-01-01`, to: today }
    case 'all':
    default:
      return { from: '1970-01-01', to: today }
  }
}

export function periodLabel(preset: PeriodPreset, from: string | null, to: string | null): string {
  if (preset === 'all') return 'All time'
  if (from && to) return from === to ? inDate(from) : `${inDate(from)} → ${inDate(to)}`
  return 'Custom range'
}

/** Indian display format (dd-mm-yyyy) for a ymd string — unambiguous for
 *  store staff and matches the en-IN date inputs. */
export function inDate(ymd: string): string {
  const [y, m, d] = ymd.split('-')
  if (!y || !m || !d) return ymd
  return `${d}-${m}-${y}`
}

/** UTC instant of store-local midnight for a ymd string (default IST). */
export function istDayStart(ymd: string, timeZone = STORE_TZ): Date {
  return new Date(`${ymd}T00:00:00${tzOffsetIso(timeZone)}`)
}

/** UTC instant of the midnight AFTER the given store-local day — the exact
 *  inclusive end for "whole day" semantics when compared with < or <=. */
export function istNextDayStart(ymd: string, timeZone = STORE_TZ): Date {
  return new Date(istDayStart(ymd, timeZone).getTime() + 86_400_000)
}

function tzOffsetIso(timeZone: string): string {
  // Only the two real deployment zones need exact offsets; anything else
  // falls back to IST (+05:30).
  if (timeZone === 'UTC') return 'Z'
  return '+05:30'
}
