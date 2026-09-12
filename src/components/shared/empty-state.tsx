import { cn } from '@/lib/utils'

interface EmptyStateProps {
  /** Rendered icon element (e.g. <Icon />) — elements cross RSC boundaries safely */
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
  /** Compact mode fits inside cards and table cells */
  compact?: boolean
}

/**
 * Proper empty state (per spec: never fake data). Used wherever real
 * database content does not exist yet. Accepts icon ELEMENTS (not
 * components) so it can be rendered from both server and client trees.
 */
export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex w-full flex-col items-center justify-center rounded-lg border border-dashed bg-card text-center',
        compact ? 'gap-1.5 px-4 py-6' : 'gap-2 px-6 py-12',
        className
      )}
    >
      {icon ? (
        <div
          className={cn(
            'flex items-center justify-center rounded-2xl bg-accent text-accent-foreground [&>svg]:size-5',
            compact ? 'size-9 [&>svg]:size-4' : 'size-14 [&>svg]:size-6'
          )}
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <p className={cn('font-semibold tracking-tight text-foreground', compact ? 'text-sm' : 'text-[15px]')}>{title}</p>
      {description ? (
        <p className={cn('max-w-md text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>
          {description}
        </p>
      ) : null}
      {action ? <div className={compact ? 'mt-1' : 'mt-3'}>{action}</div> : null}
    </div>
  )
}
