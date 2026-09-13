/**
 * Phase 8 · Part 19 (UI layer) + Parts 5/6/47 (device status truthfulness) —
 * jsdom UI-logic verification.
 *
 * A. Date helpers: Indian display format, exact IST day instants, presets.
 * B. ReportFilterBar preset wiring: choosing a preset keeps the Select on the
 *    preset (dates + period land atomically; the pre-fix bug flipped the
 *    Select to "Custom" the moment a preset was chosen because the date
 *    handlers forced period='custom' after the preset handler ran).
 * C. Editing a date by hand switches the period to Custom (unchanged rule).
 * D. Inclusive-To-date hint is visible.
 * E. ScannerStatusBox: never claims hardware links; shows real last scan,
 *    honest HID wording, camera capability wording.
 * F. probeCameraCapabilities without mediaDevices: honest "cannot open".
 *
 * Usage: bun scripts/p8-ui-logic-test.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
})

const w = dom.window as unknown as Record<string, unknown>
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node',
  'DocumentFragment', 'SVGElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent',
  'InputEvent', 'DOMRect', 'Range', 'NodeFilter', 'Document', 'HTMLDivElement', 'HTMLFormElement', 'Text', 'Comment',
]) {
  if (w[key] !== undefined) (globalThis as Record<string, unknown>)[key] = w[key]
}

class FakePointerEvent extends dom.window.MouseEvent {
  public pointerType: string
  public pointerId: number
  constructor(type: string, init: MouseEventInit & { pointerType?: string; pointerId?: number } = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? 'mouse'
    this.pointerId = init.pointerId ?? 1
  }
}
;(globalThis as Record<string, unknown>).PointerEvent = FakePointerEvent
w.PointerEvent = FakePointerEvent

if (!(dom.window as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
  class ResizeObserverStub { observe(): void {} unobserve(): void {} disconnect(): void {} }
  ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
  w.ResizeObserver = ResizeObserverStub
}
const ElementProto = dom.window.Element.prototype as unknown as Record<string, unknown>
ElementProto.scrollIntoView ??= () => {}
ElementProto.hasPointerCapture ??= () => false
ElementProto.releasePointerCapture ??= () => {}
ElementProto.setPointerCapture ??= () => {}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`) }
}

async function main() {
  console.log('main started')
  // ALL dynamic imports FIRST — bun hangs on dynamic imports issued after
  // React rendering/dispatch work in this jsdom harness, so everything is
  // resolved up front.
  const { periodLabel, inDate, istDayStart, istNextDayStart, storeToday, resolvePeriod } = await import('../src/lib/reports/period')
  const { ScannerStatusBox, probeCameraCapabilities } = await import('../src/components/pos/scanner-status')
  const { ReportFilterBar: _RFB } = await import('../src/components/reports/report-shell')
  void ScannerStatusBox; void probeCameraCapabilities; void _RFB
  // ------------------------------------------------------------------ A ----
  console.log('A. date helpers')
  check('inDate renders dd-mm-yyyy', inDate('2026-09-11') === '11-09-2026')
  check('periodLabel renders Indian range', periodLabel('custom', '2026-09-11', '2026-09-12') === '11-09-2026 → 12-09-2026')
  check('periodLabel single day', periodLabel('custom', '2026-09-11', '2026-09-11') === '11-09-2026')
  check('istDayStart exact instant (11 Sep 00:00 IST = 10 Sep 18:30 UTC)',
    istDayStart('2026-09-11').toISOString() === '2026-09-10T18:30:00.000Z')
  check('istNextDayStart exact instant (13 Sep 00:00 IST = 12 Sep 18:30 UTC)',
    istNextDayStart('2026-09-12').toISOString() === '2026-09-12T18:30:00.000Z')
  check('istNextDayStart - istDayStart = exactly 24h',
    istNextDayStart('2026-09-12').getTime() - istDayStart('2026-09-12').getTime() === 86_400_000)
  const today = storeToday()
  check('storeToday is a ymd string', /^\d{4}-\d{2}-\d{2}$/.test(today), today)
  const month = resolvePeriod('this_month')
  check('this_month preset: 1st of month → today', month?.from === `${today.slice(0, 7)}-01` && month?.to === today, month)
  const yesterday = resolvePeriod('yesterday')
  check('yesterday preset is a single past day', yesterday?.from === yesterday?.to && yesterday!.from < today, yesterday)

  // ------------------------------------------------------------------ B/C --
  console.log('B. ReportFilterBar preset wiring (the reported bug)')
  const { ReportFilterBar } = { ReportFilterBar: _RFB }
  const { PERIOD_OPTIONS } = { PERIOD_OPTIONS: (await import('../src/lib/reports/period')).PERIOD_OPTIONS }

  type Draft = Record<string, string>
  let draft: Draft = { period: 'this_month', from: month!.from, to: month!.to }
  const setDraft = (patch: Partial<Draft>) => { draft = { ...draft, ...patch } }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)

  await act(async () => {
    root.render(
      <ReportFilterBar
        period={draft.period as never}
        onPeriodChange={(p) => setDraft({ period: p })}
        from={draft.from}
        to={draft.to}
        onFromChange={(v) => setDraft({ from: v, period: 'custom' })}
        onToChange={(v) => setDraft({ to: v, period: 'custom' })}
        onApply={() => {}}
        onReset={() => {}}
        dirty
      />,
    )
  })

  // drive the Radix Select with keyboard events. SYNC act only: async act
  // drains the timer queue and Radix popper positioning schedules recurring
  // timers under jsdom which hangs the flush (harness limitation, not an app
  // bug) — sync dispatch processes the events synchronously.
  const trigger = container.querySelector<HTMLButtonElement>('#report-period')
  check('period select trigger rendered', !!trigger)
  act(() => {
    trigger!.focus()
    trigger!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
  const todayOption = options.find((o) => o.textContent === (PERIOD_OPTIONS.find((p) => p.value === 'today')?.label ?? 'Today'))
  check('preset options visible after open', options.length >= 5, options.map((o) => o.textContent).slice(0, 6))
  check('"Today" option found', !!todayOption)
  if (todayOption) {
    // pointerup + click on the option commits the selection (verified
    // interaction path in this harness)
    act(() => {
      todayOption.dispatchEvent(new FakePointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }))
      todayOption.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }
  check('PRE-FIX REGRESSION FIXED: period stays "today" after choosing the preset', draft.period === 'today', draft)
  check('preset set from = today (IST)', draft.from === today, draft)
  check('preset set to = today (IST)', draft.to === today, draft)

  // C. manual date edit still switches to custom
  console.log('C. manual date edit switches period to Custom')
  const fromInput = container.querySelector<HTMLInputElement>('#report-from')
  check('from date input rendered', !!fromInput)
  // React 19 in this bun+jsdom harness does not route synthetic 'input'
  // events to onChange (pointer/keyboard events DO route — used above), so
  // the REAL component's REAL onChange is invoked through its fiber props.
  // This still tests the shipped handler, not a replica.
  const fiberKey = Object.keys(fromInput!).find((k) => k.startsWith('__reactFiber$'))
  const fiber = fiberKey ? (fromInput as unknown as Record<string, unknown>)[fiberKey] as { memoizedProps?: { onChange?: (e: { target: { value: string } }) => void } } : null
  const realOnChange = fiber?.memoizedProps?.onChange
  check('input onChange handler wired', typeof realOnChange === 'function')
  act(() => {
    realOnChange?.({ target: { value: '2026-09-11' } })
  })
  check('date edit flips period to custom', draft.period === 'custom', draft)
  check('date edit set from value', draft.from === '2026-09-11', draft)

  // D. inclusive hint
  console.log('D. inclusive To-date hint')
  check('hint text visible',
    container.textContent?.includes('The To date is inclusive') === true)

  root.unmount()
  container.remove()

  // ------------------------------------------------------------------ E ----
  console.log('E. ScannerStatusBox truthfulness')
  const boxContainer = document.createElement('div')
  document.body.appendChild(boxContainer)
  const boxRoot = createRoot(boxContainer)
  console.log('E.2 root created')
  act(() => {
    boxRoot.render(
      <ScannerStatusBox
        lastScan={{ at: new Date('2026-09-11T05:12:15Z').getTime(), code: 'PGQR-A1B2C3D4E5F6G7H8' }}
        scannerFocused
        cameraStatus="not_opened"
        cameraDecoder="software"
      />,
    )
  })
  const text = boxContainer.textContent ?? ''
  check('shows honest HID wording', text.includes('Keyboard/HID'))
  check('USB & Bluetooth treated the same (no fake link detection)', text.includes('USB & Bluetooth scanners work the same way'))
  check('explicitly states hardware link NOT detectable', text.includes('Hardware connection status is not detectable by the browser'))
  check('scanner input Ready when focused', text.includes('Scanner input — Ready'))
  check('last scan code is masked', text.includes('PGQR-A…G7H8') && !text.includes('PGQR-A1B2C3D4E5F6G7H8'), text)
  check('camera row present with not-opened state', text.includes('Camera — Not opened this session'))
  check('decoder labelled software', text.includes('software (works in all browsers)'))

  // unfocused + no scan + denied camera
  act(() => {
    boxRoot.render(
      <ScannerStatusBox lastScan={null} scannerFocused={false} cameraStatus="denied" cameraDecoder="native" />,
    )
  })
  const text2 = boxContainer.textContent ?? ''
  check('waiting state when unfocused', text2.includes('Scanner input — Waiting for input'))
  check('no last-scan line when none', text2.includes('Last scan: —'))
  check('camera denied state surfaced', text2.includes('Camera — Permission required (was denied)'))
  boxRoot.unmount()
  boxContainer.remove()

  // ------------------------------------------------------------------ F ----
  console.log('F. camera capability probe (jsdom: no mediaDevices)')
  const caps = probeCameraCapabilities()
  check('probe reports cannot open without mediaDevices', caps.canOpen === false)
  check('probe flags insecure context', caps.insecureContext === true)
  check('probe falls back to software decoder', caps.decoder === 'software')

  console.log(`\nUI logic suite: ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log('FAILED:', failures.join(' | ')) }
  // the Radix Select portal leaves a recurring timer keeping the loop alive —
  // results are complete here, so exit deterministically
  process.exit(failed > 0 ? 1 : 0)
}

await main().catch((e) => { console.error(e); process.exit(1) })
