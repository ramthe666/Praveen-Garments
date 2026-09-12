import * as React from 'react'
import type { StockMovementType } from '@/types/database'

/** Page size for admin list pages (server-side pagination — never all rows). */
export const PAGE_SIZE = 25

export const GENDER_OPTIONS = [
  { value: 'men', label: 'Men' },
  { value: 'women', label: 'Women' },
  { value: 'unisex', label: 'Unisex' },
  { value: 'boys', label: 'Boys' },
  { value: 'girls', label: 'Girls' },
  { value: 'kids', label: 'Kids' },
] as const

export const MOVEMENT_TYPES: Array<{ value: StockMovementType; label: string }> = [
  { value: 'OPENING_STOCK', label: 'Opening Stock' },
  { value: 'PURCHASE', label: 'Purchase' },
  { value: 'SALE', label: 'Sale' },
  { value: 'SALES_RETURN', label: 'Sales Return' },
  { value: 'PURCHASE_RETURN', label: 'Purchase Return' },
  { value: 'TRANSFER_IN', label: 'Transfer In' },
  { value: 'TRANSFER_OUT', label: 'Transfer Out' },
  { value: 'ADJUSTMENT', label: 'Adjustment' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'LOSS', label: 'Loss' },
  { value: 'OTHER', label: 'Other' },
]

export function movementTypeLabel(type: string): string {
  return MOVEMENT_TYPES.find((m) => m.value === type)?.label ?? type
}

/** Adjustment types offered in the UI (the others arrive via purchases/sales). */
export const ADJUSTMENT_TYPES: Array<{ value: StockMovementType; label: string; hint: string }> = [
  { value: 'ADJUSTMENT', label: 'Adjustment', hint: 'Correct a counted difference (gain or loss)' },
  { value: 'DAMAGE', label: 'Damage', hint: 'Items damaged / unsellable' },
  { value: 'LOSS', label: 'Loss', hint: 'Items lost or missing' },
  { value: 'OTHER', label: 'Other', hint: 'Any other reason' },
]

/** Label print templates (mm). Default comes from app_settings.barcode.print_size. */
export const LABEL_TEMPLATES: Record<string, { label: string; widthMm: number; heightMm: number }> = {
  '50x25': { label: '50 × 25 mm (standard retail)', widthMm: 50, heightMm: 25 },
  '38x25': { label: '38 × 25 mm (compact)', widthMm: 38, heightMm: 25 },
  '100x50': { label: '100 × 50 mm (large / tags)', widthMm: 100, heightMm: 50 },
}

export const PRICE_FIELDS = ['cost_price', 'mrp', 'selling_price', 'wholesale_price'] as const
export type PriceField = (typeof PRICE_FIELDS)[number]

export const PRICE_LABELS: Record<PriceField, string> = {
  cost_price: 'Cost price',
  mrp: 'MRP',
  selling_price: 'Selling price',
  wholesale_price: 'Wholesale price',
}

/** Public URL for a product image stored in Supabase Storage. */
export function productImageUrl(path: string | null | undefined): string | null {
  if (!path) return null
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  return `${base}/storage/v1/object/public/product-images/${path}`
}

/** INR currency display (garments retail defaults to INR; setting-driven
 *  formatting arrives with the invoice module). */
export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * Store display timezone. Every date rendered during SSR must be formatted
 * with an explicit timeZone, otherwise the Node server (UTC) and the browser
 * (user-local) produce different text for the same instant and React throws
 * a hydration mismatch. The store operates in IST — same zone the dashboard
 * and audit views use for "today" boundaries.
 */
export const STORE_TIME_ZONE = 'Asia/Kolkata'

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeZone: STORE_TIME_ZONE,
  }).format(new Date(iso))
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: STORE_TIME_ZONE,
  }).format(new Date(iso))
}

/** Debounce hook used by list-page search inputs. */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}
