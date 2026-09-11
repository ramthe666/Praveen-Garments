import { Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StatCardProps {
  label: string
  /** Rendered icon element (e.g. <Icon />) — safe across RSC boundaries */
  icon: React.ReactNode
  /** Value rendered when real data exists; when absent show an em dash. */
  value?: string | number | null
  /** Human explanation shown under the value (empty-state hint or delta). */
  hint?: string
  tone?: 'default' | 'success' | 'warning' | 'destructive'
  className?: string
}

/**
 * Dashboard statistic card. Follows the "no fake data" rule:
 * a `null` value renders an em dash with an explanatory hint, never a
 * fabricated number.
 */
export function StatCard({ label, icon, value, hint, tone = 'default', className }: StatCardProps) {
  const toneClasses: Record<NonNullable<StatCardProps['tone']>, { icon: string; value: string }> = {
    default: { icon: 'bg-accent text-accent-foreground', value: 'text-foreground' },
    success: { icon: 'bg-success/10 text-success', value: 'text-success' },
    warning: { icon: 'bg-warning/15 text-warning-foreground', value: 'text-warning-foreground' },
    destructive: { icon: 'bg-destructive/10 text-destructive', value: 'text-destructive' },
  }
  const t = toneClasses[tone]
  const hasValue = value !== null && value !== undefined && value !== ''

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4 shadow-xs',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[13px] font-medium text-muted-foreground">{label}</p>
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md [&>svg]:size-4',
            t.icon
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        {hasValue ? (
          <p className={cn('text-2xl font-semibold tabular-nums tracking-tight', t.value)}>{value}</p>
        ) : (
          <p className="flex items-center gap-1 text-2xl font-semibold text-muted-foreground/50">
            <Minus className="size-5" aria-hidden="true" />
            <span className="sr-only">No data yet</span>
          </p>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground" title={hint}>
        {hint ?? ''}
      </p>
    </div>
  )
}
