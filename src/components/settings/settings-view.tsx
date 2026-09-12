'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  Building2,
  CreditCard,
  FileText,
  GitBranch,
  QrCode,
  ReceiptText,
  RotateCcw,
  ScanBarcode,
  Save,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  Undo2,
  Boxes,
} from 'lucide-react'
import type { AppPermission, AppSettings, AppSettingsKey, CompanySettings, RolePermission, UserRole } from '@/types/database'
import { createClient } from '@/lib/supabase/client'
import { logError, toUserMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/shared/page-header'
import { CompanyTab } from '@/components/settings/company-tab'
import { BranchesTab } from '@/components/settings/branches-tab'
import { SettingsSectionForm, type FieldDef } from '@/components/settings/settings-section-form'
import { RolesTab } from '@/components/settings/roles-tab'

type TabId =
  | 'company'
  | 'branches'
  | 'invoice'
  | 'pos'
  | 'tax'
  | 'inventory'
  | 'barcode'
  | 'qr'
  | 'payments'
  | 'returns'
  | 'numbering'
  | 'roles'

const TABS: Array<{ id: TabId; label: string; icon: typeof Building2 }> = [
  { id: 'company', label: 'Company', icon: Building2 },
  { id: 'branches', label: 'Branches', icon: GitBranch },
  { id: 'invoice', label: 'Invoice', icon: FileText },
  { id: 'pos', label: 'POS', icon: ShoppingCart },
  { id: 'tax', label: 'Tax / GST', icon: ReceiptText },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'barcode', label: 'Barcode', icon: ScanBarcode },
  { id: 'qr', label: 'QR', icon: QrCode },
  { id: 'payments', label: 'Payment Methods', icon: CreditCard },
  { id: 'returns', label: 'Returns', icon: Undo2 },
  { id: 'numbering', label: 'Document Numbers', icon: FileText },
  { id: 'roles', label: 'Roles & Permissions', icon: ShieldCheck },
]

/** Field definitions per app_settings key — business rules stay in the DB. */
const SECTION_FIELDS: Partial<Record<TabId, { settingsKey: AppSettingsKey; title: string; description: string; fields: FieldDef[] }>> = {
  invoice: {
    settingsKey: 'invoice',
    title: 'Invoice preferences',
    description: 'Defaults applied to generated invoices and bills.',
    fields: [
      { kind: 'text', key: 'prefix', label: 'Invoice prefix', placeholder: 'INV', maxLength: 12, required: true },
      { kind: 'number', key: 'next_number', label: 'Next invoice number', min: 1, max: 9999999 },
      { kind: 'toggle', key: 'show_logo', label: 'Show company logo on invoices', description: 'Prints the uploaded logo on every invoice.' },
      { kind: 'textarea', key: 'default_terms', label: 'Default terms & conditions', rows: 4, maxLength: 1000 },
      { kind: 'textarea', key: 'footer_note', label: 'Invoice footer note', rows: 2, maxLength: 300 },
    ],
  },
  pos: {
    settingsKey: 'pos',
    title: 'Point of sale behaviour',
    description: 'How the billing screen behaves during a sale.',
    fields: [
      { kind: 'toggle', key: 'require_customer', label: 'Require a customer on every bill', description: 'Cashier must attach or create a customer before checkout.' },
      { kind: 'toggle', key: 'allow_price_edit', label: 'Allow item price editing at POS', description: 'Staff with the Override Sale Price permission can override the listed price (audited).' },
      { kind: 'toggle', key: 'allow_credit_sales', label: 'Allow credit (due) sales', description: 'Bills can be completed with a balance due; requires a customer.' },
      { kind: 'toggle', key: 'round_off', label: 'Round off bill total', description: 'Rounds the payable amount to the nearest rupee.' },
      { kind: 'select', key: 'default_tax_mode', label: 'Tax mode', options: [
        { value: 'inclusive', label: 'GST included in prices (MRP-style)' },
        { value: 'exclusive', label: 'GST added on top of prices' },
      ] },
      { kind: 'number', key: 'max_item_discount_pct', label: 'Max item discount (%)', min: 0, max: 100 },
      { kind: 'number', key: 'max_bill_discount_pct', label: 'Max bill discount (%)', min: 0, max: 100 },
      { kind: 'select', key: 'default_payment_method', label: 'Default payment method', options: [
        { value: 'Cash', label: 'Cash' },
        { value: 'UPI', label: 'UPI' },
        { value: 'Card', label: 'Card' },
        { value: 'Bank Transfer', label: 'Bank Transfer' },
      ] },
      { kind: 'textarea', key: 'bill_footer_note', label: 'Bill footer note', rows: 2, maxLength: 300 },
    ],
  },
  tax: {
    settingsKey: 'tax',
    title: 'Tax / GST',
    description: 'GST defaults used for products and invoices.',
    fields: [
      { kind: 'toggle', key: 'enabled', label: 'Enable GST on invoices' },
      { kind: 'number', key: 'default_rate', label: 'Default GST rate (%)', min: 0, max: 28 },
      { kind: 'text', key: 'intra_state_label', label: 'Intra-state label', placeholder: 'CGST + SGST', maxLength: 30 },
      { kind: 'text', key: 'inter_state_label', label: 'Inter-state label', placeholder: 'IGST', maxLength: 30 },
    ],
  },
  inventory: {
    settingsKey: 'inventory',
    title: 'Inventory rules',
    description: 'Stock thresholds and costing behaviour.',
    fields: [
      { kind: 'number', key: 'low_stock_threshold', label: 'Low-stock threshold per item', min: 0, max: 100000 },
      { kind: 'toggle', key: 'allow_negative_stock', label: 'Allow negative stock', description: 'Permits billing even when stock is insufficient (recorded as negative).' },
      { kind: 'select', key: 'costing_method', label: 'Costing method', options: [
        { value: 'average', label: 'Weighted average' },
        { value: 'fifo', label: 'FIFO' },
      ] },
    ],
  },
  barcode: {
    settingsKey: 'barcode',
    title: 'Barcode',
    description: 'Barcode generation and label printing.',
    fields: [
      { kind: 'select', key: 'format', label: 'Barcode format', options: [
        { value: 'CODE128', label: 'CODE128 (recommended)' },
        { value: 'EAN13', label: 'EAN-13' },
        { value: 'CODE39', label: 'CODE39' },
      ] },
      { kind: 'toggle', key: 'auto_generate', label: 'Auto-generate barcodes for new products' },
      { kind: 'select', key: 'print_size', label: 'Label print size (mm)', options: [
        { value: '50x25', label: '50 × 25' },
        { value: '38x25', label: '38 × 25' },
        { value: '50x30', label: '50 × 30' },
      ] },
    ],
  },
  qr: {
    settingsKey: 'qr',
    title: 'QR codes',
    description: 'Product QR identifiers for quick lookup.',
    fields: [
      { kind: 'toggle', key: 'enabled', label: 'Generate QR codes for products' },
      { kind: 'select', key: 'size', label: 'QR size', options: [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' },
      ] },
    ],
  },
  payments: {
    settingsKey: 'payments',
    title: 'Payment methods',
    description: 'Methods available at checkout. Toggle the ones your store accepts. “Credit” records the balance due of a credit sale.',
    fields: [
      { kind: 'chips', key: 'methods', label: 'Accepted methods', options: ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque', 'Store Credit', 'Credit', 'Other'] },
      { kind: 'toggle', key: 'allow_advance_payments', label: 'Allow advance payments (customer deposits)', description: 'Receipts above the outstanding balance are held as customer advance and auto-applied to future bills.' },
    ],
  },
  returns: {
    settingsKey: 'returns',
    title: 'Returns policy',
    description: 'Rules applied when processing returns and exchanges. Never hardcoded — every gate here is enforced by the database.',
    fields: [
      { kind: 'toggle', key: 'enabled', label: 'Allow returns', description: 'Master switch for customer returns.' },
      { kind: 'number', key: 'window_days', label: 'Return window (days)', min: 0, max: 365, description: '0 disables the time limit.' },
      { kind: 'toggle', key: 'require_invoice', label: 'Require the original bill for returns' },
      { kind: 'toggle', key: 'restock_items', label: 'Restock returned items automatically' },
      { kind: 'toggle', key: 'exchange_enabled', label: 'Allow exchanges', description: 'Swap items against a completed bill with automatic price-difference settlement.' },
      { kind: 'toggle', key: 'refund_enabled', label: 'Allow cash/UPI refunds', description: 'When off, return values can still offset a due balance — money never leaves silently.' },
      { kind: 'toggle', key: 'damaged_to_location', label: 'Send damaged returns to the Damaged Goods location', description: 'Damaged items never re-enter sellable stock.' },
      { kind: 'toggle', key: 'manager_approval', label: 'Require manager approval for returns & exchanges', description: 'Only roles holding the Approve Returns permission can process them.' },
      { kind: 'number', key: 'max_return_qty_pct', label: 'Max return quantity per line (%)', min: 1, max: 100, description: 'Caps how much of each sold line can ever be returned.' },
    ],
  },
  numbering: {
    settingsKey: 'numbering',
    title: 'Document numbers',
    description: 'Prefixes for every document family. Numbers are generated by the database (collision-proof under concurrency).',
    fields: [
      { kind: 'text', key: 'purchase_order_prefix', label: 'Purchase order prefix', placeholder: 'PO', maxLength: 12 },
      { kind: 'text', key: 'purchase_invoice_prefix', label: 'Purchase invoice prefix', placeholder: 'PI', maxLength: 12 },
      { kind: 'text', key: 'purchase_return_prefix', label: 'Purchase return prefix', placeholder: 'PR', maxLength: 12 },
      { kind: 'text', key: 'sales_return_prefix', label: 'Sales return prefix', placeholder: 'SR', maxLength: 12 },
      { kind: 'text', key: 'exchange_prefix', label: 'Exchange prefix', placeholder: 'EX', maxLength: 12 },
      { kind: 'text', key: 'expense_prefix', label: 'Expense prefix', placeholder: 'EXP', maxLength: 12 },
      { kind: 'text', key: 'customer_receipt_prefix', label: 'Customer receipt prefix', placeholder: 'CR', maxLength: 12 },
      { kind: 'text', key: 'supplier_payment_prefix', label: 'Supplier payment prefix', placeholder: 'SP', maxLength: 12 },
    ],
  },
}

export function SettingsView({
  initialCompany,
  initialSettings,
  rolePermissions,
}: {
  initialCompany: CompanySettings | null
  initialSettings: Partial<AppSettings>
  rolePermissions: RolePermission[]
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [activeTab, setActiveTab] = React.useState<TabId>('company')
  const [settings, setSettings] = React.useState<Partial<AppSettings>>(initialSettings)
  const [company, setCompany] = React.useState<CompanySettings | null>(initialCompany)

  const reloadSettings = React.useCallback(async () => {
    const { data, error } = await supabase.from('app_settings').select('key, value')
    if (error) {
      logError('settings:reload', error)
      return
    }
    const next: Partial<AppSettings> = {}
    for (const row of (data ?? []) as Array<{ key: AppSettingsKey; value: Record<string, unknown> }>) {
      ;(next as Record<string, unknown>)[row.key] = row.value
    }
    setSettings(next)
  }, [supabase])

  const reloadCompany = React.useCallback(async () => {
    const { data, error } = await supabase.from('company_settings').select('*').limit(1).maybeSingle()
    if (error) {
      logError('settings:reload-company', error)
      return
    }
    setCompany(data as CompanySettings | null)
  }, [supabase])

  /** Save one app_settings section (upsert) — RLS restricts to Admin. */
  const saveSection = React.useCallback(
    async (key: AppSettingsKey, value: Record<string, unknown>) => {
      const { error } = await supabase.from('app_settings').upsert(
        { key, value: value as never },
        { onConflict: 'key' }
      )
      if (error) {
        logError(`settings:save:${key}`, error)
        toast.error('Could not save', { description: toUserMessage(error) })
        return false
      }
      await reloadSettings()
      toast.success('Settings saved', { description: 'Changes take effect immediately.' })
      return true
    },
    [supabase, reloadSettings]
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Company profile, business rules and access control. Values are stored in the database — not hardcoded."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void reloadCompany()
              void reloadSettings()
            }}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Tab rail (vertical on desktop, scrollable strip on mobile) */}
        <nav
          aria-label="Settings sections"
          className="thin-scrollbar -mx-1 shrink-0 overflow-x-auto px-1 lg:w-56 lg:overflow-visible"
        >
          <ul className="flex min-w-max gap-1 lg:min-w-0 lg:flex-col">
            {TABS.map((tab) => {
              const Icon = tab.icon
              const active = activeTab === tab.id
              return (
                <li key={tab.id} className="lg:w-full">
                  <button
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="whitespace-nowrap">{tab.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* Panel */}
        <div className="min-w-0 flex-1">
          {activeTab === 'company' ? (
            <CompanyTab company={company} onSaved={reloadCompany} />
          ) : activeTab === 'branches' ? (
            <BranchesTab />
          ) : activeTab === 'roles' ? (
            <RolesTab rolePermissions={rolePermissions} />
          ) : (
            (() => {
              const section = SECTION_FIELDS[activeTab]!
              const current = (settings[section.settingsKey] ?? {}) as Record<string, unknown>
              return (
                <SettingsSectionForm
                  key={activeTab}
                  title={section.title}
                  description={section.description}
                  settingsKey={section.settingsKey}
                  fields={section.fields}
                  value={current}
                  onSave={(value) => saveSection(section.settingsKey, value)}
                />
              )
            })()
          )}
        </div>
      </div>
    </div>
  )
}
