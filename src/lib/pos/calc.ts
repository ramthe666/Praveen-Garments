/**
 * POS / billing client-side calculation helpers.
 *
 * IMPORTANT: these functions mirror the SERVER-SIDE arithmetic inside
 * create_sale() (supabase/migrations/0008_pos_billing.sql) so the cashier
 * sees the same numbers the database will store. The server is ALWAYS the
 * authority — after checkout the stored totals replace anything computed
 * here. Rounding strategy: round half away from zero at 2 decimals (the
 * PostgreSQL `round(numeric, 2)` behaviour), round-off to the nearest rupee
 * when enabled.
 */

export interface CartItem {
  variant_id: string
  product_id?: string
  product_name: string
  product_code: string | null
  sku: string
  size_name: string | null
  color_name: string | null
  hsn_code: string | null
  gst_rate: number
  mrp: number | null
  base_price: number
  unit_price: number
  price_overridden: boolean
  quantity: number
  discount_type: 'pct' | 'fixed'
  discount_value: number
  /** live stock at the active location (for validation UI) */
  available: number
}

export interface CartLineMath {
  gross: number
  discountAmount: number
  taxable: number
  taxAmount: number
  lineTotal: number
}

export interface BillMath {
  subtotal: number
  itemDiscountTotal: number
  billDiscountAmount: number
  taxTotal: number
  roundOff: number
  grandTotal: number
}

/** round half away from zero at 2 decimals (matches PG round(numeric, 2)) */
export function round2(value: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) * 100 + Number.EPSILON * 100)) / 100
}

/** One line's amounts for a given tax mode. */
export function computeLine(item: CartItem, taxMode: 'inclusive' | 'exclusive', taxEnabled = true): CartLineMath {
  const gross = round2(item.unit_price * item.quantity)
  let discountAmount = 0
  if (item.discount_value > 0) {
    discountAmount =
      item.discount_type === 'pct'
        ? round2((gross * item.discount_value) / 100)
        : round2(Math.min(item.discount_value, gross))
  }
  const taxable = round2(gross - discountAmount)
  const rate = taxEnabled ? item.gst_rate : 0
  const taxAmount =
    taxMode === 'inclusive'
      ? round2((taxable * rate) / (100 + rate))
      : round2((taxable * rate) / 100)
  const lineTotal = taxMode === 'inclusive' ? taxable : round2(taxable + taxAmount)
  return { gross, discountAmount, taxable, taxAmount, lineTotal }
}

/** Whole-bill totals (bill discount + optional rupee round-off). */
export function computeBill(
  items: CartItem[],
  taxMode: 'inclusive' | 'exclusive',
  billDiscountType: 'pct' | 'fixed',
  billDiscountValue: number,
  roundOffEnabled: boolean,
  taxEnabled = true
): BillMath {
  const lines = items.map((i) => computeLine(i, taxMode, taxEnabled))
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0))
  const itemDiscountTotal = round2(lines.reduce((s, l) => s + l.discountAmount, 0))
  const taxTotal = round2(lines.reduce((s, l) => s + l.taxAmount, 0))
  const billDiscountAmount =
    billDiscountValue > 0
      ? billDiscountType === 'pct'
        ? round2((subtotal * billDiscountValue) / 100)
        : round2(Math.min(billDiscountValue, subtotal))
      : 0
  let grandTotal = round2(subtotal - billDiscountAmount)
  let roundOff = 0
  if (roundOffEnabled) {
    const rounded = Math.round(grandTotal)
    roundOff = round2(rounded - grandTotal)
    grandTotal = rounded
  }
  return { subtotal, itemDiscountTotal, billDiscountAmount, taxTotal, roundOff, grandTotal }
}

/** CGST / SGST split for intra-state display (cgst = round(tax/2, 2),
 *  sgst = tax - cgst — the same rule the invoice renderer uses). */
export function splitGst(taxAmount: number): { cgst: number; sgst: number } {
  const cgst = round2(taxAmount / 2)
  return { cgst, sgst: round2(taxAmount - cgst) }
}

/** Effective discount cap for the current user in percent (null = unlimited). */
export function effectiveDiscountCap(
  role: string,
  globalCap: number,
  personalLimit: number | null
): number | null {
  if (role === 'admin') return null
  return personalLimit != null ? Math.min(globalCap, personalLimit) : globalCap
}
