import type { AppPermission } from '@/types/database'
import type { CartItem } from '@/lib/pos/calc'

/** Result of the get_pos_config() RPC — everything the POS screen needs. */
export interface PosConfig {
  pos: {
    require_customer?: boolean
    allow_price_edit?: boolean
    allow_credit_sales?: boolean
    default_tax_mode?: 'inclusive' | 'exclusive' | string
    max_item_discount_pct?: number
    max_bill_discount_pct?: number
    default_payment_method?: string
    round_off?: boolean
    bill_footer_note?: string
  }
  tax: {
    enabled?: boolean
    default_rate?: number
    intra_state_label?: string
    inter_state_label?: string
  }
  payments: { methods?: string[] }
  invoice: { prefix?: string; show_logo?: boolean; default_terms?: string; footer_note?: string }
  inventory: { allow_negative_stock?: boolean; low_stock_threshold?: number }
  company: {
    company_name: string
    address: string | null
    city: string | null
    state: string | null
    pincode: string | null
    gstin: string | null
    phone: string | null
    email: string | null
    logo_url: string | null
    invoice_prefix: string
    currency: string
    timezone: string
  }
  locations: Array<{ id: string; name: string; code: string; location_type: string }>
  my_permissions: AppPermission[]
}

/** One product row returned by pos_search() / find_variant_by_identifier(). */
export interface PosVariantRow {
  variant_id: string
  product_id: string
  product_name: string
  product_code: string | null
  sku: string
  barcode: string | null
  qr_identifier: string | null
  size_name: string | null
  color_name: string | null
  brand_name: string | null
  category_name: string | null
  hsn_code: string | null
  gst_rate: number | null
  product_active: boolean
  variant_active: boolean
  mrp: number | null
  selling_price: number | null
  cost_price: number | null
  wholesale_price: number | null
  image_path: string | null
  total_available: number
  stock: Array<{ location_id: string; location_name: string; available: number }>
}

/** Cart entry as persisted in held bills (shape of the cart JSONB). */
export interface HeldCart {
  items: Array<{
    variant_id: string
    quantity: number
    discount_type: 'pct' | 'fixed'
    discount_value: number
    unit_price: number | null
  }>
  customer_id: string | null
  bill_discount_type: 'pct' | 'fixed'
  bill_discount_value: number
  notes: string | null
}

/** Result returned by create_sale() for the post-sale screen. */
export interface SaleResult {
  sale_id: string
  sale_number: string
  sale_date: string
  subtotal: number
  item_discount_total: number
  bill_discount: number
  tax_total: number
  round_off: number
  grand_total: number
  paid_amount: number
  due_amount: number
  payment_status: 'PAID' | 'PARTIALLY_PAID' | 'DUE' | string
  cash_change: number
  tax_mode: 'inclusive' | 'exclusive' | string
  inter_state: boolean
  customer_name: string | null
  location_name: string | null
}

/** One row in the payment editor inside the checkout dialog. */
export interface PaymentDraft {
  method: string
  amount: number | null
  reference: string
  cash_received: number | null
}

/** Lightweight customer reference for the POS panel. */
export interface PosCustomer {
  id: string
  name: string
  phone: string | null
  state: string | null
  gstin: string | null
}

export type { CartItem }
