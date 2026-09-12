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
  /**
   * 'hero' renders a vibrant gradient showcase card (dashboard top row);
   * 'plain' (default) renders the classic white info card.
   */
  variant?: 'plain' | 'hero'
  /** Gradient class for hero cards, e.g. 'bg-gradient-to-br from-emerald-500 to-teal-600'. */
  gradient?: string
  className?: string
}

/**
 * Dashboard statistic card. Follows the "no fake data" rule:
 * a `null` value renders an em dash with an explanatory hint, never a
 * fabricated number.
 */
export function StatCard({
  label,
  icon,
  value,
  hint,
  tone = 'default',
  variant = 'plain',
  gradient,
  className,
}: StatCardProps) {
  const toneClasses: Record<NonNullable<StatCardProps['tone']>, { icon: string; value: string }> = {
    default: { icon: 'bg-accent text-accent-foreground', value: 'text-foreground' },
    success: { icon: 'bg-success/10 text-success', value: 'text-foreground' },
    warning: { icon: 'bg-warning/15 text-warning-foreground', value: 'text-foreground' },
    destructive: { icon: 'bg-destructive/10 text-destructive', value: 'text-foreground' },
  }
  const t = toneClasses[tone]
  const hasValue = value !== null && value !== undefined && value !== ''

  if (variant === 'hero') {
    return (
      <div
        className={cn(
          'relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-2xl p-4 text-white shadow-soft',
          gradient ?? 'bg-gradient-to-br from-emerald-500 to-teal-600',
          'has-[>svg]:translate-z-0',
          className
        )}
      >
        {/* soft decorative blob — the signature look of the retail theme */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-10 -right-10 size-28 rounded-full bg-white/15 blur-2xl"
        />
        <div className="relative flex items-center justify-between gap-2">
          <p className="truncate text-[13px] font-medium text-white/85">{label}</p>
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-white/20 text-white backdrop-blur-sm [&>svg]:size-4"
            aria-hidden="true"
          >
            {icon}
          </span>
        </div>
        <div className="relative flex items-baseline gap-1.5">
          {hasValue ? (
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-white">{value}</p>
          ) : (
            <p className="flex items-center gap-1 text-2xl font-semibold text-white/60">
              <Minus className="size-5" aria-hidden="true" />
              <span className="sr-only">No data yet</span>
            </p>
          )}
        </div>
        <p className="relative truncate text-xs font-medium text-white/75" title={hint}>
          {hint ?? ''}
        </p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'shadow-soft relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-2xl border border-border/60 bg-card p-4',
        className
      )}
    >
      {/* soft mint blob, top-right — subtle brand personality */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-8 -right-8 size-24 rounded-full bg-accent/70 blur-2xl"
      />
      <div className="relative flex items-center justify-between gap-2">
        <p className="truncate text-[13px] font-medium text-muted-foreground">{label}</p>
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-xl [&>svg]:size-4',
            t.icon
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
      </div>
      <div className="relative flex items-baseline gap-1.5">
        {hasValue ? (
          <p className={cn('text-2xl font-semibold tabular-nums tracking-tight', t.value)}>{value}</p>
        ) : (
          <p className="flex items-center gap-1 text-2xl font-semibold text-muted-foreground/50">
            <Minus className="size-5" aria-hidden="true" />
            <span className="sr-only">No data yet</span>
          </p>
        )}
      </div>
      <p className="relative truncate text-xs text-muted-foreground" title={hint}>
        {hint ?? ''}
      </p>
    </div>
  )
}
