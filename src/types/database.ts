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
  | 'manage_customers'
  | 'manage_suppliers'
  | 'manage_expenses'
  | 'view_reports'
  | 'manage_users'
  | 'manage_settings'
  | 'view_audit_logs'

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
  }
  returns: {
    window_days: number
    require_invoice: boolean
    restock_items: boolean
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
    }
    Enums: {
      user_role: UserRole
      app_permission: AppPermission
      audit_action: AuditAction
    }
    CompositeTypes: Record<string, never>
  }
}
