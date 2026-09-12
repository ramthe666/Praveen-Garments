import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeftRight,
  BarChart3,
  ClipboardList,
  Coins,
  FileText,
  Landmark,
  Package,
  PieChart,
  Receipt,
  RotateCcw,
  ScrollText,
  Tags,
  TrendingUp,
  Truck,
  Users,
  Wallet,
} from 'lucide-react'
import type { AppPermission } from '@/types/database'
import {
  CatalogPerformanceReportView,
  GstReportView,
  PaymentReportView,
  ProductSalesReportView,
  ProfitReportView,
  SalesReportView,
} from '@/components/reports/report-configs-sales'
import {
  CurrentStockReportView,
  MovementReportView,
  PerformanceReportView,
  ValuationReportView,
} from '@/components/reports/report-configs-inventory'
import {
  AuditLogReportView,
  CashReportView,
  CustomerReportView,
  ExpenseReportView,
  PurchaseReportView,
  ReturnsReportView,
  SupplierReportView,
} from '@/components/reports/report-configs-ops'

export interface ReportDef {
  slug: string
  title: string
  description: string
  group: 'Sales & revenue' | 'Inventory' | 'Purchases & parties' | 'Money' | 'Administration'
  icon: LucideIcon
  permission: AppPermission
  View: ComponentType
}

export const REPORT_GROUPS: ReportDef['group'][] = [
  'Sales & revenue',
  'Inventory',
  'Purchases & parties',
  'Money',
  'Administration',
]

export const REPORTS: ReportDef[] = [
  {
    slug: 'sales',
    title: 'Sales',
    description: 'Invoice-level sales with customer, cashier, method, product and category filters.',
    group: 'Sales & revenue',
    icon: Receipt,
    permission: 'view_reports',
    View: SalesReportView,
  },
  {
    slug: 'product-sales',
    title: 'Product sales',
    description: 'Units, discounts, tax and net sales per product variant.',
    group: 'Sales & revenue',
    icon: Tags,
    permission: 'view_reports',
    View: ProductSalesReportView,
  },
  {
    slug: 'categories',
    title: 'Category & brand',
    description: 'Sales share and quantity per category or brand.',
    group: 'Sales & revenue',
    icon: PieChart,
    permission: 'view_reports',
    View: CatalogPerformanceReportView,
  },
  {
    slug: 'payments',
    title: 'Payment methods',
    description: 'Money received and paid out per payment method, with refunds.',
    group: 'Sales & revenue',
    icon: Wallet,
    permission: 'view_reports',
    View: PaymentReportView,
  },
  {
    slug: 'gst',
    title: 'GST / tax',
    description: 'HSN-wise output and input tax with CGST/SGST/IGST splits.',
    group: 'Sales & revenue',
    icon: Landmark,
    permission: 'view_reports',
    View: GstReportView,
  },
  {
    slug: 'profit',
    title: 'Profit (estimated)',
    description: 'Net sales, estimated COGS and expenses — every assumption labelled.',
    group: 'Sales & revenue',
    icon: TrendingUp,
    permission: 'view_reports',
    View: ProfitReportView,
  },
  {
    slug: 'current-stock',
    title: 'Current stock',
    description: 'Live stock by variant and location with status filters.',
    group: 'Inventory',
    icon: Package,
    permission: 'view_reports',
    View: CurrentStockReportView,
  },
  {
    slug: 'valuation',
    title: 'Stock valuation',
    description: 'Cost, selling and MRP value of stock on hand.',
    group: 'Inventory',
    icon: Coins,
    permission: 'view_reports',
    View: ValuationReportView,
  },
  {
    slug: 'movements',
    title: 'Stock movement',
    description: 'The append-only stock ledger with movement type filters.',
    group: 'Inventory',
    icon: ArrowLeftRight,
    permission: 'view_reports',
    View: MovementReportView,
  },
  {
    slug: 'movers',
    title: 'Fast / slow / dead',
    description: 'Sales velocity per variant — spot dead stock quickly.',
    group: 'Inventory',
    icon: BarChart3,
    permission: 'view_reports',
    View: PerformanceReportView,
  },
  {
    slug: 'purchases',
    title: 'Purchases',
    description: 'Received purchase invoices, value, tax and payables.',
    group: 'Purchases & parties',
    icon: Truck,
    permission: 'view_reports',
    View: PurchaseReportView,
  },
  {
    slug: 'suppliers',
    title: 'Suppliers',
    description: 'Purchases, payments, returns and outstanding per supplier.',
    group: 'Purchases & parties',
    icon: ClipboardList,
    permission: 'view_reports',
    View: SupplierReportView,
  },
  {
    slug: 'customers',
    title: 'Customers',
    description: 'Top customers, purchase frequency and outstanding dues.',
    group: 'Purchases & parties',
    icon: Users,
    permission: 'view_reports',
    View: CustomerReportView,
  },
  {
    slug: 'expenses',
    title: 'Expenses',
    description: 'Spend by category, method, location and day.',
    group: 'Money',
    icon: FileText,
    permission: 'view_reports',
    View: ExpenseReportView,
  },
  {
    slug: 'returns',
    title: 'Returns & exchanges',
    description: 'Return reasons, conditions, refunds and supplier returns.',
    group: 'Money',
    icon: RotateCcw,
    permission: 'view_reports',
    View: ReturnsReportView,
  },
  {
    slug: 'cash',
    title: 'Daily cash',
    description: 'Expected cash in the drawer, derived from the payment ledger.',
    group: 'Money',
    icon: Coins,
    permission: 'view_reports',
    View: CashReportView,
  },
  {
    slug: 'audit',
    title: 'Audit log',
    description: 'Every recorded action, filterable by user, action and reference.',
    group: 'Administration',
    icon: ScrollText,
    permission: 'view_audit_logs',
    View: AuditLogReportView,
  },
]

export function reportBySlug(slug: string): ReportDef | undefined {
  return REPORTS.find((r) => r.slug === slug)
}
