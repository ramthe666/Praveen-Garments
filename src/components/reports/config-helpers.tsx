'use client'

/** Shared cell renderers + option lists for report configs. */
import Link from 'next/link'
import { formatMoney, formatDate, formatDateTime } from '@/lib/catalog/constants'

export function money(v: unknown): string {
  return formatMoney(v === null || v === undefined ? null : Number(v))
}

export function num(v: unknown): string {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '0'
}

export function pct(v: unknown): string {
  const n = Number(v ?? 0)
  return `${n.toFixed(1)}%`
}

export function dateCell(v: unknown): string {
  return v ? formatDate(String(v)) : '—'
}

export function timeCell(v: unknown): string {
  return v ? formatDateTime(String(v)) : '—'
}

export function saleLink(row: Record<string, unknown>): React.ReactNode {
  const id = String(row.id ?? '')
  const sn = String(row.sale_number ?? '')
  return (
    <Link href={`/sales/${id}`} className="font-mono text-xs underline-offset-4 hover:underline">
      {sn}
    </Link>
  )
}

export const SALES_STATUS_OPTIONS = [
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All statuses' },
]

export const PAYMENT_STATUS_OPTIONS = [
  { value: 'PAID', label: 'Paid' },
  { value: 'PARTIALLY_PAID', label: 'Partially paid' },
  { value: 'DUE', label: 'Due' },
]

export const PAYMENT_METHOD_OPTIONS = [
  { value: 'Cash', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'Card', label: 'Card' },
  { value: 'Bank Transfer', label: 'Bank transfer' },
  { value: 'Credit', label: 'Credit (due)' },
]

export const PURCHASE_STATUS_OPTIONS = [
  { value: 'RECEIVED', label: 'Received' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All statuses' },
]

export const CUSTOMER_TYPE_OPTIONS = [
  { value: 'retail', label: 'Retail' },
  { value: 'wholesale', label: 'Wholesale' },
]

export const STOCK_CLASS_OPTIONS = [
  { value: 'fast', label: 'Fast moving' },
  { value: 'slow', label: 'Slow moving' },
  { value: 'dead', label: 'Dead (no sales)' },
  { value: 'out_of_stock', label: 'Out of stock' },
]

export const STOCK_STATUS_OPTIONS = [
  { value: 'in_stock', label: 'In stock' },
  { value: 'low_stock', label: 'Low stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
]

export const MOVEMENT_TYPE_OPTIONS = [
  { value: 'SALE', label: 'Sale' },
  { value: 'SALES_RETURN', label: 'Sales return' },
  { value: 'PURCHASE', label: 'Purchase received' },
  { value: 'PURCHASE_RETURN', label: 'Purchase return' },
  { value: 'OPENING_STOCK', label: 'Opening stock' },
  { value: 'ADJUSTMENT', label: 'Adjustment' },
  { value: 'TRANSFER_IN', label: 'Transfer in' },
  { value: 'TRANSFER_OUT', label: 'Transfer out' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'LOSS', label: 'Loss' },
  { value: 'OTHER', label: 'Other' },
]

export const AUDIT_ACTION_OPTIONS: { value: string; label: string }[] = [
  'login', 'logout', 'login_failed',
  'user_created', 'user_updated', 'user_deleted', 'user_disabled', 'user_enabled',
  'role_changed', 'permission_changed', 'settings_changed',
  'branch_created', 'branch_updated', 'branch_deleted',
  'product_created', 'product_updated', 'product_deleted', 'price_changed',
  'category_created', 'category_updated',
  'stock_changed', 'sale_created', 'sale_cancelled', 'return_processed',
  'refund_issued', 'price_override_applied', 'discount_applied',
  'bill_held', 'bill_resumed', 'bill_discarded',
  'customer_created', 'customer_updated', 'customer_payment_recorded', 'customer_advance_applied',
  'supplier_created', 'supplier_updated', 'supplier_payment_recorded',
  'purchase_order_created', 'purchase_order_updated', 'purchase_order_cancelled',
  'purchase_created', 'purchase_updated', 'purchase_received', 'purchase_cancelled',
  'purchase_return_processed', 'sales_return_processed', 'exchange_processed',
  'expense_created', 'expense_updated', 'expense_approved', 'expense_cancelled',
].map((a) => ({ value: a, label: a.replaceAll('_', ' ') }))
