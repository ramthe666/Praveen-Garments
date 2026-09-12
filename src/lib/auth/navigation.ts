import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  Boxes,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  Store,
  Truck,
  Users,
  Wallet,
} from 'lucide-react'
import type { AppPermission } from '@/types/database'

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
  /** Required permission; item hidden when the role lacks it. */
  permission?: AppPermission
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

/**
 * Single source of truth for application navigation.
 * Phase 1 ships foundations + "coming in next phase" states for future modules.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Main',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, permission: 'view_dashboard' },
      { label: 'POS / Billing', href: '/pos', icon: ShoppingCart, permission: 'create_sale' },
      { label: 'Products', href: '/products', icon: Package, permission: 'view_inventory' },
      { label: 'Inventory', href: '/inventory', icon: Boxes, permission: 'view_inventory' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Purchases', href: '/purchases', icon: Truck, permission: 'view_purchases' },
      { label: 'Sales', href: '/sales', icon: Receipt, permission: 'view_sales' },
      { label: 'Customers', href: '/customers', icon: Users, permission: 'manage_customers' },
      { label: 'Suppliers', href: '/suppliers', icon: Store, permission: 'manage_suppliers' },
      { label: 'Expenses', href: '/expenses', icon: Wallet, permission: 'manage_expenses' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { label: 'Payments', href: '/payments', icon: CreditCard, permission: 'view_sales' },
      { label: 'Reports', href: '/reports', icon: BarChart3, permission: 'view_reports' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users', href: '/users', icon: Users, permission: 'manage_users' },
      { label: 'Settings', href: '/settings', icon: Settings, permission: 'manage_settings' },
    ],
  },
]

/** Flat lookup used to resolve the page title from the pathname. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

export function navItemForPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
}
