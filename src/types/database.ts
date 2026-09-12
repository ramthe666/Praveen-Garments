/**
 * Database type definitions matching supabase/migrations/0001_core_schema.sql.
 * Typed Supabase clients use these for compile-time safety.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined }
export type ArrayOfJson = Json[]

export type UserRole =
  | 'admin'
  | 'manager'
  | 'cashier'
  | 'inventory_manager'
  | 'purchase_manager'
  | 'accountant'

export type AppPermission =
  | 'view_dashboard'
  | 'manage_products'
  | 'view_inventory'
  | 'manage_inventory'
  | 'create_sale'
  | 'cancel_sale'
  | 'process_return'
  | 'manage_purchases'
  | 'view_purchases'
  | 'record_customer_payment'
  | 'record_supplier_payment'
  | 'approve_expense'
  | 'approve_return'
  | 'manage_customers'
  | 'manage_suppliers'
  | 'manage_expenses'
  | 'view_reports'
  | 'manage_users'
  | 'manage_settings'
  | 'view_audit_logs'
  | 'view_sales'
  | 'override_sale_price'
  | 'apply_discount'

export type AuditAction =
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'user_created'
  | 'user_updated'
  | 'user_deleted'
  | 'user_disabled'
  | 'user_enabled'
  | 'role_changed'
  | 'permission_changed'
  | 'settings_changed'
  | 'branch_created'
  | 'branch_updated'
  | 'branch_deleted'
  | 'product_created'
  | 'product_updated'
  | 'product_deleted'
  | 'price_changed'
  | 'stock_changed'
  | 'sale_created'
  | 'sale_cancelled'
  | 'return_processed'
  | 'refund_issued'
  | 'purchase_created'
  | 'purchase_updated'
  | 'price_override_applied'
  | 'discount_applied'
  | 'bill_held'
  | 'bill_resumed'
  | 'bill_discarded'
  | 'customer_created'
  | 'customer_updated'
  | 'supplier_created'
  | 'supplier_updated'
  | 'customer_payment_recorded'
  | 'customer_advance_applied'
  | 'supplier_payment_recorded'
  | 'purchase_order_created'
  | 'purchase_order_updated'
  | 'purchase_order_cancelled'
  | 'purchase_received'
  | 'purchase_return_processed'
  | 'sales_return_processed'
  | 'exchange_processed'
  | 'expense_created'
  | 'expense_updated'
  | 'expense_approved'
  | 'expense_cancelled'
  | 'category_created'
  | 'category_updated'

export type Branch = {
  id: string
  name: string
  code: string
  address: string | null
  city: string | null
  state: string | null
  pincode: string | null
  phone: string | null
  email: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Profile = {
  id: string
  email: string
  full_name: string
  phone: string | null
  role: UserRole
  branch_id: string | null
  is_active: boolean
  last_login_at: string | null
  pos_discount_limit_pct: number | null
  created_at: string
  updated_at: string
}

export type RolePermission = {
  role: UserRole
  permission: AppPermission
  created_at: string
}

export type CompanySettings = {
  id: number
  company_name: string
  logo_url: string | null
  phone: string | null
  email: string | null
  address: string | null
  city: string | null
  state: string | null
  pincode: string | null
  gstin: string | null
  invoice_prefix: string
  currency: string
  timezone: string
  created_at: string
  updated_at: string
  updated_by: string | null
}

export type AppSettingsRow = {
  key: string
  value: Record<string, Json>
  updated_at: string
  updated_by: string | null
}

export type AuditLog = {
  id: number
  user_id: string | null
  user_email: string | null
  action: AuditAction
  entity_type: string | null
  entity_id: string | null
  old_values: Json | null
  new_values: Json | null
  metadata: Json | null
  created_at: string
}

/** Payload returned by the get_public_branding() RPC */
export type PublicBranding = {
  company_name: string | null
  logo_url: string | null
}

// ---------------------------------------------------------------------------
// Phase 2 — Product catalog & inventory types (migration 0004 / 0005)
// ---------------------------------------------------------------------------

export type ProductGender = 'men' | 'women' | 'unisex' | 'boys' | 'girls' | 'kids'

export type Category = {
  id: string
  name: string
  description: string | null
  parent_id: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Brand = {
  id: string
  name: string
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Size = {
  id: string
  name: string
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Color = {
  id: string
  name: string
  hex_code: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Product = {
  id: string
  name: string
  product_code: string | null
  category_id: string
  subcategory_id: string | null
  brand_id: string | null
  collection: string | null
  gender: ProductGender | null
  fabric: string | null
  pattern: string | null
  description: string | null
  hsn_code: string | null
  gst_rate: number | null
  mrp: number | null
  cost_price: number | null
  selling_price: number | null
  wholesale_price: number | null
  image_path: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type ProductVariant = {
  id: string
  product_id: string
  sku: string
  size_id: string | null
  color_id: string | null
  barcode: string | null
  qr_identifier: string | null
  cost_price: number | null
  mrp: number | null
  selling_price: number | null
  wholesale_price: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type StockLocationType = 'store' | 'warehouse'

export type StockLocation = {
  id: string
  name: string
  code: string
  location_type: StockLocationType
  branch_id: string | null
  address: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type StockBalance = {
  id: number
  variant_id: string
  location_id: string
  quantity: number
  reserved_quantity: number
  reorder_level: number | null
  updated_at: string
}

export type StockMovementType =
  | 'OPENING_STOCK'
  | 'PURCHASE'
  | 'SALE'
  | 'SALES_RETURN'
  | 'PURCHASE_RETURN'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'ADJUSTMENT'
  | 'DAMAGE'
  | 'LOSS'
  | 'OTHER'

export type StockMovement = {
  id: number
  variant_id: string
  location_id: string
  movement_type: StockMovementType
  quantity: number
  balance_after: number
  reference_type: string | null
  reference_id: string | null
  reason: string | null
  user_id: string | null
  user_email: string | null
  created_at: string
}

/** Row shape returned by products_page() RPC */
export type ProductsPageRow = {
  id: string
  name: string
  product_code: string | null
  image_path: string | null
  is_active: boolean
  created_at: string
  gender: ProductGender | null
  gst_rate: number | null
  mrp: number | null
  selling_price: number | null
  category_id: string
  subcategory_id: string | null
  brand_id: string | null
  category_name: string | null
  subcategory_name: string | null
  brand_name: string | null
  variant_count: number
  min_selling_price: number | null
  max_selling_price: number | null
  min_mrp: number | null
  max_mrp: number | null
}

export type ProductsPageResult = {
  rows: ProductsPageRow[]
  total: number
  total_is_estimate: boolean
}

// ---------------------------------------------------------------------------
// Phase 3 — POS / billing types (migration 0008)
// ---------------------------------------------------------------------------

export type Customer = {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  city: string | null
  state: string | null
  gstin: string | null
  notes: string | null
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export type SaleStatus = 'COMPLETED' | 'CANCELLED'
export type PaymentStatus = 'PAID' | 'PARTIALLY_PAID' | 'DUE'
export type TaxMode = 'inclusive' | 'exclusive'
export type DiscountType = 'pct' | 'fixed'

export type Sale = {
  id: string
  sale_number: string
  sale_date: string
  customer_id: string | null
  customer_name: string | null
  customer_phone: string | null
  cashier_id: string | null
  cashier_name: string | null
  cashier_email: string | null
  location_id: string | null
  location_name: string | null
  status: SaleStatus
  subtotal: number
  item_discount_total: number
  bill_discount: number
  tax_total: number
  round_off: number
  grand_total: number
  paid_amount: number
  due_amount: number
  payment_status: PaymentStatus
  tax_mode: TaxMode | string
  inter_state: boolean
  price_overridden: boolean
  notes: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null
  created_at: string
}

export type SaleItem = {
  id: string
  sale_id: string
  variant_id: string | null
  product_name: string
  product_code: string | null
  sku: string
  size_name: string | null
  color_name: string | null
  hsn_code: string | null
  gst_rate: number
  quantity: number
  base_price: number
  unit_price: number
  price_overridden: boolean
  mrp: number | null
  discount_type: DiscountType | string
  discount_value: number
  discount_amount: number
  tax_amount: number
  line_total: number
  created_at: string
}

export type SalePayment = {
  id: string
  sale_id: string
  method: string
  amount: number
  reference: string | null
  cash_received: number | null
  cash_change: number
  is_credit: boolean
  recorded_by: string | null
  created_at: string
}

export type HeldBillStatus = 'HELD' | 'RESUMED' | 'DISCARDED'

export type HeldBill = {
  id: string
  label: string
  cart: Record<string, unknown>
  customer_name: string | null
  item_count: number
  total: number | null
  status: HeldBillStatus
  cashier_id: string
  held_at: string
  resumed_at: string | null
  discarded_at: string | null
  created_at: string
  updated_at: string
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock'

/** Row shape returned by stock_page() RPC */
export type StockPageRow = {
  balance_id: number
  variant_id: string
  location_id: string
  quantity: number
  reserved_quantity: number
  reorder_level: number | null
  effective_reorder: number
  available: number
  status: StockStatus
  sku: string
  barcode: string | null
  qr_identifier: string | null
  variant_active: boolean
  mrp: number | null
  selling_price: number | null
  product_id: string
  product_name: string
  product_code: string | null
  image_path: string | null
  product_active: boolean
  size_name: string | null
  color_name: string | null
  color_hex: string | null
  location_name: string
  location_code: string
  location_type: StockLocationType
}

export type StockPageResult = {
  rows: StockPageRow[]
  total: number
  total_is_estimate: boolean
}

/** Row shape returned by stock_history_page() RPC */
export type StockHistoryRow = {
  id: number
  variant_id: string
  location_id: string
  movement_type: StockMovementType
  quantity: number
  balance_after: number
  reference_type: string | null
  reference_id: string | null
  reason: string | null
  user_id: string | null
  user_email: string | null
  created_at: string
  sku: string
  barcode: string | null
  qr_identifier: string | null
  size_name: string | null
  color_name: string | null
  product_id: string
  product_name: string
  location_name: string
  location_code: string
}

export type StockHistoryPageResult = {
  rows: StockHistoryRow[]
  total: number
  total_is_estimate: boolean
  has_more: boolean
  next_cursor: { created_at: string; id: number } | null
}

/** Payload returned by find_variant_by_identifier() RPC */
export type VariantLookup = {
  variant_id: string
  sku: string
  barcode: string | null
  qr_identifier: string | null
  size_name: string | null
  color_name: string | null
  mrp: number | null
  selling_price: number | null
  product_id: string
  product_name: string
  product_active: boolean
  variant_active: boolean
  stock: Array<{ location_id: string; location_name: string; quantity: number; reserved_quantity: number }>
}

/** Namespaced app_settings values (business rules — never hardcode in UI) */
export type AppSettings = {
  invoice: {
    prefix: string
    next_number: number
    show_logo: boolean
    default_terms: string
    footer_note: string
  }
  pos: {
    require_customer: boolean
    allow_price_edit: boolean
    allow_credit_sales: boolean
    default_tax_mode: 'inclusive' | 'exclusive' | string
    max_item_discount_pct: number
    max_bill_discount_pct: number
    default_payment_method: string
    round_off: boolean
    bill_footer_note: string
  }
  tax: {
    enabled: boolean
    default_rate: number
    intra_state_label: string
    inter_state_label: string
  }
  inventory: {
    low_stock_threshold: number
    allow_negative_stock: boolean
    costing_method: string
  }
  barcode: {
    format: string
    auto_generate: boolean
    print_size: string
  }
  qr: {
    enabled: boolean
    size: string
  }
  payments: {
    methods: string[]
    allow_advance_payments?: boolean
  }
  returns: {
    window_days: number
    require_invoice: boolean
    restock_items: boolean
    enabled?: boolean
    exchange_enabled?: boolean
    refund_enabled?: boolean
    damaged_to_location?: boolean
    manager_approval?: boolean
    max_return_qty_pct?: number
  }
  numbering?: {
    purchase_order_prefix?: string
    purchase_invoice_prefix?: string
    purchase_return_prefix?: string
    sales_return_prefix?: string
    exchange_prefix?: string
    expense_prefix?: string
    customer_receipt_prefix?: string
    supplier_payment_prefix?: string
  }
}

export type AppSettingsKey = keyof AppSettings

/** Minimal typed Database shape matching supabase-js GenericSchema requirements */
export type Database = {
  public: {
    Tables: {
      branches: {
        Row: Branch
        Insert: Omit<Branch, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Branch, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      profiles: {
        Row: Profile
        Insert: Partial<Profile> & { id: string; email: string }
        Update: Partial<Omit<Profile, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      role_permissions: {
        Row: RolePermission
        Insert: Omit<RolePermission, 'created_at'>
        Update: Partial<Omit<RolePermission, 'created_at'>>
        Relationships: []
      }
      company_settings: {
        Row: CompanySettings
        Insert: Partial<Omit<CompanySettings, 'id' | 'created_at' | 'updated_by'>>
        Update: Partial<Omit<CompanySettings, 'id' | 'created_at' | 'updated_at' | 'updated_by'>>
        Relationships: []
      }
      app_settings: {
        Row: AppSettingsRow
        Insert: { key: string; value: Record<string, Json> }
        Update: { value?: Record<string, Json> }
        Relationships: []
      }
      audit_logs: {
        Row: AuditLog
        Insert: Partial<AuditLog> & { action: AuditAction }
        Update: Partial<Omit<AuditLog, 'id' | 'created_at'>>
        Relationships: []
      }
      categories: {
        Row: Category
        Insert: Omit<Category, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Category, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      brands: {
        Row: Brand
        Insert: Omit<Brand, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Brand, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      sizes: {
        Row: Size
        Insert: Omit<Size, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Size, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      colors: {
        Row: Color
        Insert: Omit<Color, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Color, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      products: {
        Row: Product
        Insert: Omit<Product, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Product, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      product_variants: {
        Row: ProductVariant
        Insert: Omit<ProductVariant, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<ProductVariant, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      stock_locations: {
        Row: StockLocation
        Insert: Omit<StockLocation, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<StockLocation, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      stock_balances: {
        Row: StockBalance
        Insert: Omit<StockBalance, 'id' | 'updated_at'>
        Update: Partial<Omit<StockBalance, 'id' | 'updated_at'>>
        Relationships: []
      }
      stock_movements: {
        Row: StockMovement
        Insert: Omit<StockMovement, 'id' | 'created_at'>
        Update: never
        Relationships: []
      }
      customers: {
        Row: Customer
        Insert: Omit<Customer, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Customer, 'id' | 'created_at' | 'updated_at'>>
        Relationships: []
      }
      sales: {
        Row: Sale
        Insert: never
        Update: never
        Relationships: []
      }
      sale_items: {
        Row: SaleItem
        Insert: never
        Update: never
        Relationships: []
      }
      sale_payments: {
        Row: SalePayment
        Insert: never
        Update: never
        Relationships: []
      }
      held_bills: {
        Row: HeldBill
        Insert: never
        Update: Partial<Pick<HeldBill, 'status' | 'resumed_at' | 'discarded_at' | 'updated_at'>>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      has_app_permission: { Args: { p: AppPermission }; Returns: boolean }
      is_admin: { Args: Record<string, never>; Returns: boolean }
      get_my_role: { Args: Record<string, never>; Returns: UserRole }
      get_public_branding: { Args: Record<string, never>; Returns: PublicBranding }
      touch_my_last_login: { Args: Record<string, never>; Returns: undefined }
      log_auth_event: { Args: { p_action: AuditAction; p_meta?: Json }; Returns: undefined }
      generate_barcode: { Args: Record<string, never>; Returns: string }
      generate_qr_identifier: { Args: Record<string, never>; Returns: string }
      create_product_variants: {
        Args: { p_product_id: string; p_variants: unknown }
        Returns: Json
      }
      products_page: {
        Args: {
          p_search?: string | null
          p_category_id?: string | null
          p_subcategory_id?: string | null
          p_brand_id?: string | null
          p_status?: string | null
          p_sort?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      find_variant_by_identifier: { Args: { p_value: string }; Returns: Json }
      adjust_stock: {
        Args: {
          p_variant_id: string
          p_location_id: string
          p_quantity: number
          p_movement_type?: string | null
          p_reason?: string
          p_reference_type?: string
          p_reference_id?: string
          p_user_email?: string
        }
        Returns: Json
      }
      set_opening_stock: {
        Args: {
          p_variant_id: string
          p_location_id: string
          p_quantity: number
          p_reason?: string | null
          p_user_email?: string | null
        }
        Returns: Json
      }
      transfer_stock: {
        Args: {
          p_variant_id: string
          p_from_location_id: string
          p_to_location_id: string
          p_quantity: number
          p_reason?: string | null
          p_user_email?: string | null
        }
        Returns: Json
      }
      set_reorder_level: {
        Args: {
          p_variant_id: string
          p_location_id: string
          p_reorder_level: number | null
          p_user_email?: string | null
        }
        Returns: Json
      }
      get_inventory_stats: { Args: Record<string, never>; Returns: Json }
      stock_page: {
        Args: {
          p_search?: string | null
          p_category_id?: string | null
          p_subcategory_id?: string | null
          p_brand_id?: string | null
          p_size_id?: string | null
          p_color_id?: string | null
          p_location_id?: string | null
          p_status?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      stock_history_page: {
        Args: {
          p_after_created?: string | null
          p_after_id?: number | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_search?: string | null
          p_movement_type?: string | null
          p_location_id?: string | null
          p_variant_id?: string | null
          p_limit?: number | null
        }
        Returns: Json
      }
      pos_search: {
        Args: { p_query?: string | null; p_limit?: number | null }
        Returns: Json
      }
      get_pos_config: { Args: Record<string, never>; Returns: Json }
      create_sale: { Args: { p_payload: unknown }; Returns: Json }
      cancel_sale: { Args: { p_sale_id: string; p_reason: string }; Returns: Json }
      hold_bill: {
        Args: {
          p_cart: unknown
          p_label?: string | null
          p_customer?: string | null
          p_item_count?: number | null
          p_total?: number | null
        }
        Returns: Json
      }
      resume_held_bill: { Args: { p_id: string }; Returns: Json }
      discard_held_bill: { Args: { p_id: string }; Returns: Json }
      sales_page: {
        Args: {
          p_search?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_payment_method?: string | null
          p_cashier_id?: string | null
          p_status?: string | null
          p_payment_status?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      sale_detail: { Args: { p_sale_id: string }; Returns: Json }
      customers_page: {
        Args: {
          p_search?: string | null
          p_type?: string | null
          p_active?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      customer_detail: { Args: { p_customer_id: string }; Returns: Json }
      customer_statement: {
        Args: { p_customer_id: string; p_from?: string | null; p_to?: string | null }
        Returns: Json
      }
      record_customer_payment: {
        Args: {
          p_customer_id: string
          p_amount: number
          p_method: string
          p_reference?: string | null
          p_notes?: string | null
          p_payment_date?: string | null
        }
        Returns: Json
      }
      apply_customer_advance: { Args: { p_customer_id: string }; Returns: Json }
      suppliers_page: {
        Args: {
          p_search?: string | null
          p_active?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      supplier_detail: { Args: { p_supplier_id: string }; Returns: Json }
      record_supplier_payment: {
        Args: {
          p_supplier_id: string
          p_amount: number
          p_method: string
          p_reference?: string | null
          p_notes?: string | null
          p_payment_date?: string | null
        }
        Returns: Json
      }
      purchase_orders_page: {
        Args: {
          p_search?: string | null
          p_supplier?: string | null
          p_status?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      purchase_order_detail: { Args: { p_po_id: string }; Returns: Json }
      purchase_invoices_page: {
        Args: {
          p_search?: string | null
          p_supplier?: string | null
          p_status?: string | null
          p_payment_status?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      purchase_invoice_detail: { Args: { p_invoice_id: string }; Returns: Json }
      purchase_returns_page: {
        Args: {
          p_search?: string | null
          p_supplier?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      sales_returns_page: {
        Args: {
          p_search?: string | null
          p_customer?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      exchanges_page: {
        Args: {
          p_search?: string | null
          p_customer?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      expenses_page: {
        Args: {
          p_search?: string | null
          p_category?: string | null
          p_status?: string | null
          p_method?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      payments_page: {
        Args: {
          p_search?: string | null
          p_source?: string | null
          p_method?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_min?: number | null
          p_max?: number | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      // ---- Phase 5 reporting RPCs (0012) --------------------------------
      dashboard_summary: {
        Args: { p_from?: string | null; p_to?: string | null }
        Returns: Json
      }
      sales_report: {
        Args: {
          p_date_from?: string | null
          p_date_to?: string | null
          p_search?: string | null
          p_customer_id?: string | null
          p_cashier_id?: string | null
          p_payment_method?: string | null
          p_variant_id?: string | null
          p_category_id?: string | null
          p_brand_id?: string | null
          p_location_id?: string | null
          p_status?: string | null
          p_sort?: string | null
          p_limit?: number | null
          p_offset?: number | null
          p_payment_status?: string | null
        }
        Returns: Json
      }
      product_sales_report: {
        Args: {
          p_date_from?: string | null
          p_date_to?: string | null
          p_search?: string | null
          p_category_id?: string | null
          p_brand_id?: string | null
          p_variant_id?: string | null
          p_sort?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      catalog_performance_report: {
        Args: { p_date_from?: string | null; p_date_to?: string | null; p_group_by?: string | null }
        Returns: Json
      }
      payment_report: {
        Args: { p_date_from?: string | null; p_date_to?: string | null }
        Returns: Json
      }
      gst_report: {
        Args: { p_date_from?: string | null; p_date_to?: string | null }
        Returns: Json
      }
      profit_report: {
        Args: { p_date_from?: string | null; p_date_to?: string | null }
        Returns: Json
      }
      stock_valuation_report: {
        Args: {
          p_location_id?: string | null
          p_category_id?: string | null
          p_brand_id?: string | null
          p_search?: string | null
          p_sort?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      stock_performance_report: {
        Args: {
          p_date_from?: string | null
          p_date_to?: string | null
          p_class?: string | null
          p_search?: string | null
          p_sort?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      purchase_report: {
        Args: {
          p_date_from?: string | null
          p_date_to?: string | null
          p_search?: string | null
          p_supplier_id?: string | null
          p_status?: string | null
          p_payment_status?: string | null
          p_sort?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      supplier_report: {
        Args: {
          p_date_from?: string | null
          p_date_to?: string | null
          p_search?: string | null
          p_sort?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      customer_report: {
        Args: {
          p_date_from?: string | null
          p_date_to?: string | null
          p_search?: string | null
          p_type?: string | null
          p_sort?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
      expense_report: {
        Args: { p_date_from?: string | null; p_date_to?: string | null }
        Returns: Json
      }
      returns_report: {
        Args: { p_date_from?: string | null; p_date_to?: string | null }
        Returns: Json
      }
      cash_report: {
        Args: { p_date?: string | null }
        Returns: Json
      }
      audit_page: {
        Args: {
          p_search?: string | null
          p_action?: string | null
          p_user_id?: string | null
          p_date_from?: string | null
          p_date_to?: string | null
          p_entity_type?: string | null
          p_limit?: number | null
          p_offset?: number | null
        }
        Returns: Json
      }
    }
    Enums: {
      user_role: UserRole
      app_permission: AppPermission
      audit_action: AuditAction
    }
    CompositeTypes: Record<string, never>
  }
}

// ---------------------------------------------------------------------------
// Phase 4 domain types (customers, suppliers, purchases, returns,
// exchanges, expenses). All money fields arrive as numbers via the page RPCs
// (PostgREST jsonb); direct table reads give numeric-as-string, hence
// Number() at the call sites.
// ---------------------------------------------------------------------------

export type CustomerType = 'retail' | 'wholesale'

export type CustomerRecord = {
  id: string
  name: string
  phone: string | null
  alt_phone: string | null
  email: string | null
  address: string | null
  city: string | null
  state: string | null
  pincode: string | null
  gstin: string | null
  customer_type: CustomerType | string
  credit_limit: number
  notes: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type SupplierRecord = {
  id: string
  name: string
  contact_person: string | null
  phone: string | null
  email: string | null
  address: string | null
  city: string | null
  state: string | null
  pincode: string | null
  gstin: string | null
  payment_terms: string | null
  notes: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type POStatus = 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED'

export type PurchaseOrder = {
  id: string
  po_number: string
  supplier_id: string
  supplier_name: string
  location_id: string
  location_name: string
  order_date: string
  expected_date: string | null
  status: POStatus | string
  subtotal: number
  discount_total: number
  tax_total: number
  grand_total: number
  notes: string | null
  created_by: string | null
  created_by_name: string | null
  item_count: number
  unit_count: number
}

export type POItem = {
  id: string
  po_id: string
  variant_id: string | null
  line_no: number
  product_name: string
  sku: string
  size_name: string | null
  color_name: string | null
  quantity: number
  unit_cost: number
  discount_amount: number
  gst_rate: number
  tax_amount: number
  line_total: number
  received_quantity: number
  pending_quantity?: number
}

export type InvoiceStatus = 'DRAFT' | 'RECEIVED' | 'CANCELLED'

export type PurchaseInvoice = {
  id: string
  invoice_number: string
  supplier_id: string
  supplier_name: string
  po_id: string | null
  po_number: string | null
  supplier_invoice_no: string | null
  supplier_invoice_date: string | null
  location_id: string
  location_name: string
  invoice_date: string
  status: InvoiceStatus | string
  subtotal: number
  discount_total: number
  tax_total: number
  grand_total: number
  paid_amount: number
  due_amount: number
  payment_status: PaymentStatus | string
  tax_mode: TaxMode | string
  inter_state: boolean
  notes: string | null
  received_at: string | null
  received_by_name: string | null
  created_by_name: string | null
  item_count: number
  unit_count: number
}

export type PurchaseInvoiceItem = {
  id: string
  invoice_id: string
  po_item_id: string | null
  variant_id: string | null
  line_no: number
  product_name: string
  sku: string
  size_name: string | null
  color_name: string | null
  quantity: number
  unit_cost: number
  discount_amount: number
  gst_rate: number
  tax_amount: number
  line_total: number
  returned_quantity: number
}

export type CustomerPayment = {
  id: string
  receipt_number: string
  customer_id: string
  customer_name: string
  amount: number
  allocated_amount: number
  method: string
  reference: string | null
  notes: string | null
  recorded_by_name: string | null
  recorded_at: string
}

export type SupplierPayment = {
  id: string
  payment_number: string
  supplier_id: string
  supplier_name: string
  amount: number
  allocated_amount: number
  method: string
  reference: string | null
  notes: string | null
  recorded_by_name: string | null
  recorded_at: string
}

export type ReturnCondition = 'GOOD' | 'DAMAGED'

export type SalesReturn = {
  id: string
  return_number: string
  sale_id: string
  sale_number: string
  customer_id: string | null
  customer_name: string | null
  return_date: string
  reason: string
  refund_method: string | null
  refund_amount: number
  applied_to_due: number
  refunded_by_name: string | null
  notes: string | null
  item_count: number
  units: number
}

export type PurchaseReturn = {
  id: string
  return_number: string
  purchase_invoice_id: string
  invoice_number: string
  supplier_id: string
  supplier_name: string
  return_date: string
  reason: string
  subtotal: number
  tax_total: number
  grand_total: number
  applied_to_due: number
  created_by_name: string | null
  notes: string | null
  item_count: number
  units: number
}

export type Exchange = {
  id: string
  exchange_number: string
  sale_id: string
  sale_number: string
  customer_id: string | null
  customer_name: string | null
  exchange_date: string
  reason: string
  return_value: number
  issue_value: number
  difference_amount: number
  payment_method: string | null
  payment_amount: number
  payment_reference: string | null
  created_by_name: string | null
  item_count: number
  units_in: number
  units_out: number
}

export type ExpenseStatus = 'PENDING' | 'APPROVED' | 'CANCELLED'

export type ExpenseCategory = {
  id: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Expense = {
  id: string
  expense_number: string
  category_id: string
  category_name: string
  description: string
  amount: number
  method: string
  location_id: string | null
  location_name: string | null
  expense_date: string
  notes: string | null
  status: ExpenseStatus | string
  approved_at: string | null
  approved_by_name: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  created_by_name: string | null
  created_at: string
}

export type PaymentLedgerRow = {
  source: 'customer_payment' | 'supplier_payment' | 'sale_payment' | 'refund' | 'expense'
  source_id: string
  doc_number: string
  entry_at: string
  method: string
  amount: number
  reference: string | null
  user_name: string | null
  party_name: string | null
  notes: string | null
}

export type PageResult<T> = {
  rows: T[]
  total: number
  total_is_estimate?: boolean
}
