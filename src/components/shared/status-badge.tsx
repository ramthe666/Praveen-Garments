import { cn } from '@/lib/utils'
import type { StockStatus } from '@/types/database'

const STATUS_CONFIG: Record<StockStatus, { label: string; className: string }> = {
  in_stock: { label: 'In Stock', className: 'bg-success/10 text-success border-success/25' },
  low_stock: { label: 'Low Stock', className: 'bg-warning/15 text-warning-foreground border-warning/30' },
  out_of_stock: { label: 'Out of Stock', className: 'bg-destructive/10 text-destructive border-destructive/25' },
}

/** Inventory status badge (colors follow the app's semantic tokens). */
export function StockStatusBadge({ status, className }: { status: StockStatus; className?: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.in_stock
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
        cfg.className,
        className
      )}
    >
      {cfg.label}
    </span>
  )
}

/** Simple Active / Inactive badge for catalog rows. */
export function ActiveBadge({ active, className }: { active: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
        active
          ? 'bg-success/10 text-success border-success/25'
          : 'bg-muted text-muted-foreground border-border',
        className
      )}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  )
}
