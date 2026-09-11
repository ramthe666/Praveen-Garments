'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { AppProvider, type AppContextData } from '@/components/providers/app-provider'
import { SidebarNav } from '@/components/layout/sidebar-nav'
import { UserMenu } from '@/components/layout/user-menu'
import { AppLogo } from '@/components/shared/app-logo'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { navItemForPath } from '@/lib/auth/navigation'
import { cn } from '@/lib/utils'

const SIDEBAR_COLLAPSED_KEY = 'pg.sidebar.collapsed'

/**
 * Authenticated application shell.
 * Desktop: fixed collapsible sidebar (60 ↔ 16 rem-ish icon rail) + sticky topbar.
 * Tablet/mobile: same navigation inside a Sheet drawer, touch-friendly targets.
 */
export function AppShell({
  contextData,
  children,
}: {
  contextData: AppContextData
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = React.useState(false)
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1')
    setMounted(true)
  }, [])

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      return next
    })
  }, [])

  // Close the drawer whenever the route changes
  React.useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const activeItem = navItemForPath(pathname)
  const pageTitle = activeItem?.label ?? 'Dashboard'

  return (
    <AppProvider data={contextData}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <div className="min-h-screen bg-background">
        {/* ---------- Desktop sidebar ---------- */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-sidebar transition-[width] duration-200 lg:flex',
            collapsed ? 'w-[4.25rem]' : 'w-60'
          )}
        >
          <div
            className={cn(
              'flex h-14 items-center border-b',
              collapsed ? 'justify-center px-2' : 'gap-2.5 px-4'
            )}
          >
            <AppLogo
              logoUrl={contextData.logoUrl}
              companyName={contextData.companyName}
              size={collapsed ? 30 : 32}
            />
            {!collapsed ? (
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                {contextData.companyName}
              </span>
            ) : null}
          </div>

          <SidebarNav collapsed={collapsed} />

          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleCollapsed}
              className="w-full justify-start gap-2 text-muted-foreground"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" aria-hidden="true" />
              ) : (
                <PanelLeftClose className="size-4" aria-hidden="true" />
              )}
              {mounted && !collapsed ? <span className="text-xs">Collapse</span> : null}
            </Button>
          </div>
        </aside>

        {/* ---------- Mobile drawer ---------- */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-[17.5rem] max-w-[85vw] p-0">
            <SheetHeader className="border-b py-3 pr-10 pl-4">
              <div className="flex items-center gap-2.5">
                <AppLogo
                  logoUrl={contextData.logoUrl}
                  companyName={contextData.companyName}
                  size={32}
                />
                <SheetTitle className="truncate text-sm font-semibold">
                  {contextData.companyName}
                </SheetTitle>
              </div>
              <SheetDescription className="sr-only">Main navigation</SheetDescription>
            </SheetHeader>
            <div className="thin-scrollbar h-[calc(100%-3.5rem)] overflow-y-auto">
              <SidebarNav collapsed={false} onNavigate={() => setMobileOpen(false)} />
            </div>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close navigation"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </SheetContent>
        </Sheet>

        {/* ---------- Main column ---------- */}
        <div className={cn('flex min-h-screen flex-col transition-[padding] duration-200', collapsed ? 'lg:pl-[4.25rem]' : 'lg:pl-60')}>
          <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur sm:px-4 lg:px-6">
            {/* hamburger (below lg) */}
            <Button
              variant="ghost"
              size="icon"
              className="size-9 lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <span className="flex flex-col gap-[3px]" aria-hidden="true">
                <span className="block h-0.5 w-4.5 rounded bg-current" />
                <span className="block h-0.5 w-4.5 rounded bg-current" />
                <span className="block h-0.5 w-4.5 rounded bg-current" />
              </span>
            </Button>

            <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-foreground">
              {pageTitle}
            </h2>

            <UserMenu />
          </header>

          <main id="main-content" className="flex-1 p-3 pb-8 sm:p-4 lg:p-6 lg:pb-10">
            <div className="mx-auto w-full max-w-[100rem]">{children}</div>
          </main>
        </div>
      </div>
    </AppProvider>
  )
}
