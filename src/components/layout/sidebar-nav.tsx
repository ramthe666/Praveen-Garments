'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_GROUPS } from '@/lib/auth/navigation'
import { useApp } from '@/components/providers/app-provider'
import { cn } from '@/lib/utils'

/**
 * Permission-aware navigation list. Items whose required permission is not
 * granted to the current role are not rendered at all.
 */
export function SidebarNav({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const { hasPermission, permissions } = useApp()

  // While the profile layer is unavailable (pre-migration), show the
  // navigation so the shell stays usable; DB-backed actions still fail safe.
  const permissionsKnown = permissions.length > 0

  return (
    <nav aria-label="Main navigation" className="thin-scrollbar flex-1 overflow-y-auto px-2 py-3">
      {NAV_GROUPS.map((group) => {
        const visibleItems = group.items.filter(
          (item) => !item.permission || !permissionsKnown || hasPermission(item.permission)
        )
        if (visibleItems.length === 0) return null

        return (
          <div key={group.label} className="mb-4 last:mb-1">
            {collapsed ? (
              <div className="mx-auto my-2 h-px w-6 bg-border" aria-hidden="true" />
            ) : (
              <p className="px-2.5 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {visibleItems.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
                const Icon = item.icon
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium outline-none transition-colors',
                        'focus-visible:ring-2 focus-visible:ring-ring/60',
                        collapsed && 'justify-center px-0',
                        active
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground hover:bg-accent/60 hover:text-foreground'
                      )}
                    >
                      {active ? (
                        <span
                          aria-hidden="true"
                          className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary"
                        />
                      ) : null}
                      <Icon className="size-[17px] shrink-0" aria-hidden="true" />
                      {!collapsed ? <span className="min-w-0 truncate">{item.label}</span> : null}
                      {collapsed ? (
                        <span className="sr-only">{item.label}</span>
                      ) : null}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
