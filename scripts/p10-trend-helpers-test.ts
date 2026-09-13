/**
 * Phase 10 — unit tests for the "Look a trend" pure helpers.
 * Run: bun scripts/p10-trend-helpers-test.ts
 */
import {
  istDayKey,
  buildDailySeries,
  buildTopCustomers,
  axisMoney,
} from '../src/components/reports/trend-report-view'

let pass = 0
let fail = 0
function ok(cond: boolean, label: string) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}`)
  }
}

console.log('istDayKey (IST boundary correctness)')
// 18:30 UTC == 00:00 next day IST
ok(istDayKey('2026-09-12T18:30:00Z') === '2026-09-13', '2026-09-12T18:30:00Z -> 2026-09-13 (IST midnight)')
ok(istDayKey('2026-09-12T18:29:59Z') === '2026-09-12', '2026-09-12T18:29:59Z -> 2026-09-12 (last IST second)')
ok(istDayKey('2026-01-01T05:29:00Z') === '2026-01-01', '05:29 UTC still same IST day')
ok(istDayKey('2026-01-01T05:31:00Z') === '2026-01-01', '05:31 UTC is 11:01 IST — same day')
ok(istDayKey('2026-01-01T18:31:00Z') === '2026-01-02', '18:31 UTC rolls to next IST day')

console.log('buildDailySeries (aggregation + gap-filling)')
const rows = [
  { id: '1', sale_number: 'INV-1', sale_date: '2026-09-01T10:00:00Z', status: 'COMPLETED', payment_status: 'PAID', customer_name: null, grand_total: 500, paid_amount: 500, due_amount: 0 },
  { id: '2', sale_number: 'INV-2', sale_date: '2026-09-01T15:00:00Z', status: 'COMPLETED', payment_status: 'PAID', customer_name: 'Ravi', grand_total: 250.5, paid_amount: 250.5, due_amount: 0 },
  { id: '3', sale_number: 'INV-3', sale_date: '2026-09-03T09:00:00Z', status: 'COMPLETED', payment_status: 'DUE', customer_name: 'Ravi', grand_total: 1000, paid_amount: 0, due_amount: 1000 },
] as never[]

const series = buildDailySeries(rows as never, '2026-09-01', '2026-09-04')
ok(series.length === 4, `4 days filled (got ${series.length})`)
ok(series[0].day === '2026-09-01' && series[0].sales === 750.5 && series[0].bills === 2, 'Sep 1 aggregates both bills (750.5, 2)')
ok(series[1].day === '2026-09-02' && series[1].sales === 0 && series[1].bills === 0, 'Sep 2 gap-filled as zero')
ok(series[2].day === '2026-09-03' && series[2].sales === 1000 && series[2].bills === 1, 'Sep 3 has the 1000 bill')
ok(series[3].day === '2026-09-04' && series[3].sales === 0, 'Sep 4 (To date inclusive) zero')
ok(series.every((p) => /^\d{1,2} \w{3,4}$/.test(p.label)), 'labels are "d MMM" format (en-IN Sept is 4 letters)')

// IST-crossing timestamps land on the right chart day
const istRows = [
  { id: '4', sale_number: 'INV-4', sale_date: '2026-09-04T18:30:00Z', status: 'COMPLETED', payment_status: 'PAID', customer_name: null, grand_total: 99, paid_amount: 99, due_amount: 0 },
] as never[]
const istSeries = buildDailySeries(istRows as never, '2026-09-04', '2026-09-05')
ok(istSeries[1].day === '2026-09-05' && istSeries[1].bills === 1, '18:30Z bill lands on Sep 5 (IST next day)')

// Empty range fallback: uses only days with data
const sparse = buildDailySeries(rows as never, '', '')
ok(sparse.length === 2 && sparse[0].day === '2026-09-01', 'no-range mode returns only days with data, sorted')

// Very long range guard: falls back to sparse mode
const long = buildDailySeries(rows as never, '2020-01-01', '2026-09-04')
ok(long.length === 2, 'range > 800 days falls back to days-with-data (no 2400-point array)')

console.log('buildTopCustomers')
const custs = buildTopCustomers(rows as never)
ok(custs.length === 2, 'two distinct customers')
ok(custs[0].name === 'Ravi' && custs[0].total === 1250.5 && custs[0].bills === 2, 'Ravi sorted first (1250.5, 2 bills)')
ok(custs[1].name === 'Walk-in' && custs[1].bills === 1, 'null customer becomes Walk-in')

console.log('axisMoney (Indian units)')
ok(axisMoney(950) === '950', '950 -> 950')
ok(axisMoney(1500) === '1.5k', '1500 -> 1.5k')
ok(axisMoney(15500) === '16k', '15500 -> 16k')
ok(axisMoney(450000) === '4.5L', '450000 -> 4.5L')
ok(axisMoney(13000000) === '1.3Cr', '13000000 -> 1.3Cr')
ok(axisMoney(-2500) === '-2.5k', 'negative values keep sign')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
