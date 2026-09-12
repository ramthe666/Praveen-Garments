import type { AppPermission, UserRole } from '@/types/database'

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  inventory_manager: 'Inventory Manager',
  purchase_manager: 'Purchase Manager',
  accountant: 'Accountant',
}

export const ROLE_ORDER: UserRole[] = [
  'admin',
  'manager',
  'cashier',
  'inventory_manager',
  'purchase_manager',
  'accountant',
]

export const PERMISSION_LABELS: Record<AppPermission, string> = {
  view_dashboard: 'View Dashboard',
  manage_products: 'Manage Products',
  view_inventory: 'View Inventory',
  manage_inventory: 'Manage Inventory',
  create_sale: 'Create Sale',
  cancel_sale: 'Cancel Sale',
  process_return: 'Process Return',
  manage_purchases: 'Manage Purchases',
  manage_customers: 'Manage Customers',
  manage_suppliers: 'Manage Suppliers',
  manage_expenses: 'Manage Expenses',
  view_reports: 'View Reports',
  manage_users: 'Manage Users',
  manage_settings: 'Manage Settings',
  view_audit_logs: 'View Audit Logs',
  view_sales: 'View Sales',
  override_sale_price: 'Override Sale Price',
  apply_discount: 'Apply Discount',
}

export const ALL_PERMISSIONS: AppPermission[] = [
  'view_dashboard',
  'manage_products',
  'view_inventory',
  'manage_inventory',
  'create_sale',
  'cancel_sale',
  'process_return',
  'manage_purchases',
  'manage_customers',
  'manage_suppliers',
  'manage_expenses',
  'view_reports',
  'manage_users',
  'manage_settings',
  'view_audit_logs',
  'view_sales',
  'override_sale_price',
  'apply_discount',
]

/** Fallback when company settings are unreachable (e.g. pre-migration). */
export const DEFAULT_COMPANY_NAME = 'Praveen Garments'

export const CURRENCIES = [
  { code: 'INR', label: 'INR — Indian Rupee (₹)' },
  { code: 'USD', label: 'USD — US Dollar ($)' },
  { code: 'EUR', label: 'EUR — Euro (€)' },
  { code: 'GBP', label: 'GBP — Pound Sterling (£)' },
  { code: 'AED', label: 'AED — UAE Dirham (د.إ)' },
] as const

export const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Karachi',
  'Asia/Dhaka',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
] as const
