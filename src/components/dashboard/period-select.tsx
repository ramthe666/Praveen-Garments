'use client'

/**
 * Dashboard period selector: presets (today / yesterday / week / month /
 * year / custom) that navigate with search params so the server component
 * recomputes the window. No client-side data fetching — the dashboard stays
 * a server-rendered, permission-gated RSC.
 */
import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CalendarRange } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PERIOD_OPTIONS, resolvePeriod, storeToday, type PeriodPreset } from '@/lib/reports/period'

export function DashboardPeriodSelect() {
  const router = useRouter()
  const search = useSearchParams()
  const period = (search.get('period') as PeriodPreset | null) ?? 'today'
  const today = storeToday()

  function navigate(p: PeriodPreset, from?: string, to?: string) {
    const params = new URLSearchParams()
    params.set('period', p)
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    router.push(`/dashboard?${params.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CalendarRange className="size-4 text-muted-foreground" aria-hidden="true" />
      <Select value={period} onValueChange={(v) => {
        const p = v as PeriodPreset
        const range = resolvePeriod(p)
        navigate(p, range?.from, range?.to)
      }}>
        <SelectTrigger className="h-9 w-40" aria-label="Dashboard period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIOD_OPTIONS.filter((o) => o.value !== 'all').map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {period === 'custom' ? (
        <>
          <Input
            type="date"
            className="h-9 w-36"
            aria-label="Custom from date"
            value={search.get('from') ?? today}
            onChange={(e) => navigate('custom', e.target.value, search.get('to') ?? today)}
          />
          <Input
            type="date"
            className="h-9 w-36"
            aria-label="Custom to date"
            value={search.get('to') ?? today}
            onChange={(e) => navigate('custom', search.get('from') ?? today, e.target.value)}
          />
        </>
      ) : null}
    </div>
  )
}
