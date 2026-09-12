'use client'

/** Sales & revenue report configs (sales, product sales, category/brand, payments, GST, profit). */
import { TableReportView, type TableReportConfig } from '@/components/reports/table-report-view'
import { SectionReportView, type SectionReportConfig } from '@/components/reports/section-report-view'
import { FilterSearch, FilterSelect } from '@/components/reports/report-shell'
import { BrandFilter, CategoryFilter, EmployeeFilter } from '@/components/reports/catalog-pickers'
import {
  PAYMENT_METHOD_OPTIONS,
  PAYMENT_STATUS_OPTIONS,
  SALES_STATUS_OPTIONS,
  dateCell,
  money,
  num,
  pct,
  saleLink,
  timeCell,
} from '@/components/reports/config-helpers'
import { formatMoney } from '@/lib/catalog/constants'

type Row = Record<string, unknown>

// ---------------------------------------------------------------------------
// 1. Sales report (invoice level)
// ---------------------------------------------------------------------------

const salesReport: TableReportConfig<Row> = {
  rpc: 'sales_report',
  title: 'Sales report',
  subtitle: 'Invoice-level sales with filters and period aggregates',
  filename: 'sales-report',
  emptyTitle: 'No bills in this period',
  columns: [
    { key: 'sale_number', header: 'Invoice', render: saleLink },
    { key: 'sale_date', header: 'Date', render: (r) => timeCell(r.sale_date), csv: (r) => String(r.sale_date ?? '') },
    { key: 'customer_name', header: 'Customer', render: (r) => String(r.customer_name ?? 'Walk-in') },
    { key: 'cashier_name', header: 'Cashier', hide: 'md' },
    { key: 'location_name', header: 'Location', hide: 'lg' },
    { key: 'items', header: 'Items', align: 'right', hide: 'sm' },
    { key: 'quantity', header: 'Qty', align: 'right' },
    { key: 'tax_total', header: 'Tax', align: 'right', hide: 'md', render: (r) => money(r.tax_total) },
    { key: 'grand_total', header: 'Bill value', align: 'right', render: (r) => money(r.grand_total), sortable: true },
    { key: 'paid_amount', header: 'Paid', align: 'right', hide: 'md', render: (r) => money(r.paid_amount) },
    { key: 'due_amount', header: 'Due', align: 'right', render: (r) => money(r.due_amount), sortable: true },
  ],
  rowKey: (r) => String(r.id),
  pageResult: (data) => data as { rows: Row[]; total: number; summary?: Record<string, number> },
  summary: (s) => [
    { label: 'Bills', value: num(s?.bills) },
    { label: 'Gross sales', value: money(s?.gross_sales) },
    { label: 'Discounts', value: money(Number(s?.item_discounts ?? 0) + Number(s?.bill_discounts ?? 0)) },
    { label: 'Tax', value: money(s?.tax) },
    { label: 'Returns', value: money(s?.returns_value) },
    { label: 'Net sales', value: money(s?.net_sales), tone: 'positive' },
  ],
  filterControls: (draft, patch) => (
    <>
      <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="Invoice, customer, phone" id="sales-search" />
      <FilterSelect id="sales-status" label="Status" value={draft.status ?? 'COMPLETED'} onChange={(v) => patch({ status: v === '__all__' ? 'ALL' : v })} options={SALES_STATUS_OPTIONS} />
      <FilterSelect id="sales-method" label="Payment method" value={draft.method ?? ''} onChange={(v) => patch({ method: v === '__all__' ? '' : v })} options={PAYMENT_METHOD_OPTIONS} />
      <FilterSelect id="sales-pstatus" label="Payment status" value={draft.pstatus ?? ''} onChange={(v) => patch({ pstatus: v === '__all__' ? '' : v })} options={PAYMENT_STATUS_OPTIONS} />
      <EmployeeFilter value={draft.cashier ?? ''} onChange={(v) => patch({ cashier: v })} />
      <CategoryFilter value={draft.category ?? ''} onChange={(v) => patch({ category: v })} />
      <BrandFilter value={draft.brand ?? ''} onChange={(v) => patch({ brand: v })} />
    </>
  ),
  argsFromFilters: (from, to, f, page, sort) => {
    const args: Record<string, unknown> = {
      p_date_from: from || null,
      p_date_to: to || null,
      p_search: f.search?.trim() || null,
      p_cashier_id: f.cashier || null,
      p_category_id: f.category || null,
      p_brand_id: f.brand || null,
      p_payment_method: f.method || null,
      p_status: f.status || 'COMPLETED',
      p_sort: sort || 'date_desc',
      p_limit: 25,
      p_offset: page * 25,
    }
    // p_payment_status only exists on sales_report once 0013 is applied —
    // omit it while unfiltered so the page also loads on a 0012-only
    // database (PostgREST rejects unknown named args with PGRST202).
    if (f.pstatus) args.p_payment_status = f.pstatus
    return args
  },
  sortOptions: [
    { value: 'date_desc', label: 'Newest first' },
    { value: 'date_asc', label: 'Oldest first' },
    { value: 'grand_desc', label: 'Highest bill value' },
    { value: 'grand_asc', label: 'Lowest bill value' },
    { value: 'due_desc', label: 'Highest due' },
  ],
  defaultSort: 'date_desc',
}

// ---------------------------------------------------------------------------
// 2. Product sales report (variant level)
// ---------------------------------------------------------------------------

const productSalesReport: TableReportConfig<Row> = {
  rpc: 'product_sales_report',
  title: 'Product sales',
  subtitle: 'Units and revenue per product variant',
  filename: 'product-sales',
  emptyTitle: 'No products sold in this period',
  columns: [
    { key: 'product_name', header: 'Product' },
    { key: 'sku', header: 'SKU', render: (r) => <span className="font-mono text-xs">{String(r.sku)}</span> },
    { key: 'size_name', header: 'Size', hide: 'sm', render: (r) => String(r.size_name ?? '—') },
    { key: 'color_name', header: 'Colour', hide: 'md', render: (r) => String(r.color_name ?? '—') },
    { key: 'quantity', header: 'Qty sold', align: 'right', sortable: true },
    { key: 'gross', header: 'Gross', align: 'right', hide: 'md', render: (r) => money(r.gross) },
    { key: 'discount', header: 'Discount', align: 'right', hide: 'lg', render: (r) => money(r.discount) },
    { key: 'tax', header: 'Tax', align: 'right', hide: 'xl', render: (r) => money(r.tax) },
    { key: 'revenue', header: 'Net sales', align: 'right', render: (r) => money(r.revenue), sortable: true },
    { key: 'bills', header: 'Bills', align: 'right', hide: 'lg' },
  ],
  rowKey: (r) => String(r.variant_id),
  pageResult: (data) => data as { rows: Row[]; total: number; summary?: Record<string, number> },
  summary: (s) => [
    { label: 'Variants sold', value: num(s?.variants) },
    { label: 'Quantity', value: num(s?.quantity) },
    { label: 'Gross', value: money(s?.gross) },
    { label: 'Discounts', value: money(s?.discount) },
    { label: 'Tax', value: money(s?.tax) },
    { label: 'Net sales', value: money(s?.revenue), tone: 'positive' },
  ],
  filterControls: (draft, patch) => (
    <>
      <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="Product or SKU" id="ps-search" />
      <CategoryFilter value={draft.category ?? ''} onChange={(v) => patch({ category: v })} />
      <BrandFilter value={draft.brand ?? ''} onChange={(v) => patch({ brand: v })} />
    </>
  ),
  argsFromFilters: (from, to, f, page, sort) => ({
    p_date_from: from || null,
    p_date_to: to || null,
    p_search: f.search?.trim() || null,
    p_category_id: f.category || null,
    p_brand_id: f.brand || null,
    p_sort: sort || 'revenue_desc',
    p_limit: 25,
    p_offset: page * 25,
  }),
  sortOptions: [
    { value: 'revenue_desc', label: 'Highest net sales' },
    { value: 'qty_desc', label: 'Most units sold' },
    { value: 'qty_asc', label: 'Fewest units sold' },
    { value: 'name_asc', label: 'SKU A–Z' },
  ],
  defaultSort: 'revenue_desc',
}

// ---------------------------------------------------------------------------
// 3. Category / brand performance
// ---------------------------------------------------------------------------

const catalogPerformanceReport: SectionReportConfig = {
  rpc: 'catalog_performance_report',
  title: 'Category & brand performance',
  subtitle: 'Share of sales by category or brand',
  filename: 'category-performance',
  initialFilters: { group: 'category' },
  argsFromFilters: (from, to, f) => ({
    p_date_from: from || null,
    p_date_to: to || null,
    p_group_by: f.group || 'category',
  }),
  summary: (data) => {
    const s = (data?.summary ?? {}) as Record<string, number>
    return [
      { label: 'Dimensions', value: num(s.total_dimensions ?? s.dimensions) },
      { label: 'Total value', value: money(s.total_value) },
      { label: 'Total qty', value: num(s.total_qty) },
      { label: 'Total bills', value: num(s.total_bills) },
    ]
  },
  selectFilters: [
    {
      key: 'group',
      label: 'Group by',
      options: [
        { value: 'category', label: 'Category' },
        { value: 'brand', label: 'Brand' },
      ],
    },
  ],
  sections: [
    {
      key: 'performance',
      title: 'Performance',
      description: 'Sorted by sales value; contribution is the share of total value in the period.',
      columns: [
        { key: 'name', header: 'Name' },
        { key: 'quantity', header: 'Qty sold', align: 'right' },
        { key: 'value', header: 'Sales value', align: 'right', render: (r) => money(r.value) },
        { key: 'bills', header: 'Bills', align: 'right', hide: 'sm' },
        { key: 'pct', header: 'Share', align: 'right', render: (r) => pct(r.pct) },
      ],
      rows: (data) => ((data?.rows ?? []) as Row[]),
      rowKey: (r, i) => `${r.id ?? i}`,
      footer: (rows) => (
        <tr>
          <td className="px-3 py-2">Total</td>
          <td className="px-3 py-2 text-right tabular-nums">{num(rows.reduce((s, r) => s + Number(r.quantity ?? 0), 0))}</td>
          <td className="px-3 py-2 text-right tabular-nums">{formatMoney(rows.reduce((s, r) => s + Number(r.value ?? 0), 0))}</td>
          <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{num(rows.reduce((s, r) => s + Number(r.bills ?? 0), 0))}</td>
          <td className="px-3 py-2 text-right tabular-nums">{pct(rows.reduce((s, r) => s + Number(r.pct ?? 0), 0))}</td>
        </tr>
      ),
    },
  ],
}

// ---------------------------------------------------------------------------
// 4. Payment report
// ---------------------------------------------------------------------------

const paymentReport: SectionReportConfig = {
  rpc: 'payment_report',
  title: 'Payment methods',
  subtitle: 'Money in and out by payment method',
  filename: 'payment-report',
  argsFromFilters: (from, to) => ({ p_date_from: from || null, p_date_to: to || null }),
  summary: (data) => {
    const s = (data?.summary ?? {}) as Record<string, number>
    return [
      { label: 'Total inflow', value: money(s.total_inflow), tone: 'positive' },
      { label: 'Exchanges in', value: money(s.total_exchange_in) },
      { label: 'Refunds out', value: money(s.total_refund), tone: 'destructive' },
      { label: 'Expenses', value: money(s.total_expense), tone: 'warning' },
      { label: 'Supplier payments', value: money(s.total_supplier) },
      { label: 'Store-credit refunds', value: money(s.store_credit_refunds) },
    ]
  },
  sections: [
    {
      key: 'inflows',
      title: 'Money received (till + receipts + exchanges)',
      description: 'Till payments at checkout, customer receipts and exchange differences collected, per method. Receipt mirrors are never double-counted.',
      columns: [
        { key: 'method', header: 'Method' },
        { key: 'count', header: 'Transactions', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
        { key: 'pct', header: 'Share', align: 'right', render: (r) => pct(r.pct) },
      ],
      rows: (data) => ((data?.inflows ?? []) as Row[]),
      rowKey: (r) => String(r.method),
      footer: (rows) => (
        <tr>
          <td className="px-3 py-2">Total</td>
          <td className="px-3 py-2 text-right tabular-nums">{num(rows.reduce((s, r) => s + Number(r.count ?? 0), 0))}</td>
          <td className="px-3 py-2 text-right tabular-nums">{formatMoney(rows.reduce((s, r) => s + Number(r.amount ?? 0), 0))}</td>
          <td className="px-3 py-2 text-right tabular-nums">{pct(rows.reduce((s, r) => s + Number(r.pct ?? 0), 0))}</td>
        </tr>
      ),
    },
    {
      key: 'exchange_collections',
      title: 'Exchange differences collected',
      description: 'Money customers paid on upgrade swaps (new item costlier than the returned one). Counted in the inflow above so the drawer reconciles.',
      columns: [
        { key: 'method', header: 'Method' },
        { key: 'count', header: 'Exchanges', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => ((data?.exchange_collections ?? []) as Row[]),
      rowKey: (r) => String(r.method),
    },
    {
      key: 'refunds',
      title: 'Refunds paid out',
      description: 'Cash/UPI/card refunds for sales returns and exchanges (store-credit refunds excluded — shown in the summary).',
      columns: [
        { key: 'method', header: 'Method' },
        { key: 'count', header: 'Refunds', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => ((data?.refunds ?? []) as Row[]),
      rowKey: (r) => String(r.method),
    },
    {
      key: 'expenses',
      title: 'Expenses by method',
      columns: [
        { key: 'method', header: 'Method' },
        { key: 'count', header: 'Count', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => ((data?.expenses ?? []) as Row[]),
      rowKey: (r) => String(r.method),
    },
    {
      key: 'supplier',
      title: 'Supplier payments by method',
      columns: [
        { key: 'method', header: 'Method' },
        { key: 'count', header: 'Count', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => ((data?.supplier_payments ?? []) as Row[]),
      rowKey: (r) => String(r.method),
    },
  ],
}

// ---------------------------------------------------------------------------
// 5. GST report
// ---------------------------------------------------------------------------

function gstSection(
  key: string,
  title: string,
  description: string,
  rowsKey: string,
): SectionReportConfig['sections'][number] {
  return {
    key,
    title,
    description,
    columns: [
      { key: 'hsn', header: 'HSN', render: (r) => String(r.hsn ?? '—') },
      { key: 'gst_rate', header: 'Rate %', align: 'right', render: (r) => `${num(r.gst_rate)}%` },
      { key: 'taxable', header: 'Taxable value', align: 'right', render: (r) => money(r.taxable) },
      { key: 'cgst', header: 'CGST', align: 'right', hide: 'md', render: (r) => money(r.cgst) },
      { key: 'sgst', header: 'SGST', align: 'right', hide: 'md', render: (r) => money(r.sgst) },
      { key: 'igst', header: 'IGST', align: 'right', hide: 'sm', render: (r) => money(r.igst) },
      { key: 'total_tax', header: 'Total tax', align: 'right', render: (r) => money(r.total_tax) },
    ],
    rows: (data) => ((data?.[rowsKey] ?? []) as Row[]),
    rowKey: (r, i) => `${r.hsn ?? 'x'}-${r.gst_rate ?? i}`,
    footer: (rows) => (
      <tr>
        <td className="px-3 py-2">Total</td>
        <td />
        <td className="px-3 py-2 text-right tabular-nums">{money(rows.reduce((s, r) => s + Number(r.taxable ?? 0), 0))}</td>
        <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{money(rows.reduce((s, r) => s + Number(r.cgst ?? 0), 0))}</td>
        <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">{money(rows.reduce((s, r) => s + Number(r.sgst ?? 0), 0))}</td>
        <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{money(rows.reduce((s, r) => s + Number(r.igst ?? 0), 0))}</td>
        <td className="px-3 py-2 text-right tabular-nums">{money(rows.reduce((s, r) => s + Number(r.total_tax ?? 0), 0))}</td>
      </tr>
    ),
  }
}

const gstReport: SectionReportConfig = {
  rpc: 'gst_report',
  title: 'GST / tax summary',
  subtitle: 'HSN-wise output and input tax from stored line snapshots',
  filename: 'gst-report',
  argsFromFilters: (from, to) => ({ p_date_from: from || null, p_date_to: to || null }),
  note: 'Taxable value and CGST/SGST/IGST splits are computed from the tax amounts stored on each bill and purchase line (no rates are hardcoded).',
  summary: (data) => {
    const s = (data?.summary ?? {}) as Record<string, number>
    return [
      { label: 'Taxable sales', value: money(s.taxable_sales) },
      { label: 'Output tax', value: money(s.net_output_tax) },
      { label: 'Taxable purchases', value: money(s.taxable_purchases) },
      { label: 'Input tax (ITC)', value: money(s.net_input_tax) },
      { label: 'Net GST payable', value: money(s.net_gst_payable), tone: 'warning' },
    ]
  },
  sections: [
    gstSection('sales', 'Sales (output tax)', 'HSN-wise taxable sales with intra-state CGST+SGST / inter-state IGST split.', 'sales'),
    gstSection('sales_returns', 'Sales returns (tax reversal)', 'Tax reversed by customer returns, by HSN.', 'sales_returns'),
    gstSection('purchases', 'Purchases (input tax)', 'HSN-wise taxable purchases with input tax split.', 'purchases'),
    gstSection('purchase_returns', 'Purchase returns (ITC reversal)', 'Input tax reversed by purchase returns.', 'purchase_returns'),
  ],
}

// ---------------------------------------------------------------------------
// 6. Profit report
// ---------------------------------------------------------------------------

const profitReport: SectionReportConfig = {
  rpc: 'profit_report',
  title: 'Profit (estimated)',
  subtitle: 'Net sales, estimated COGS and operating expenses',
  filename: 'profit-report',
  argsFromFilters: (from, to) => ({ p_date_from: from || null, p_date_to: to || null }),
  summary: (data) => {
    const d = (data ?? {}) as Record<string, number>
    return [
      { label: 'Net sales', value: money(d.net_sales) },
      { label: 'COGS (est.)', value: money(d.cogs), tone: 'warning' },
      { label: 'Gross profit', value: money(d.gross_profit), tone: 'positive' },
      { label: 'Expenses', value: money(d.expenses), tone: 'destructive' },
      { label: 'Net profit', value: money(d.net_profit), tone: Number(d.net_profit) >= 0 ? 'positive' : 'destructive' },
      { label: 'Cost coverage', value: pct(d.cost_coverage_pct) },
    ]
  },
  sections: [
    {
      key: 'breakdown',
      title: 'Calculation breakdown',
      description: 'Every figure and its meaning — nothing here is presented as exact historical COGS.',
      columns: [
        { key: 'measure', header: 'Measure' },
        { key: 'value', header: 'Amount', align: 'right' },
        { key: 'meaning', header: 'Meaning' },
      ],
      rows: (data) => {
        const d = (data ?? {}) as Record<string, number>
        const rows: Row[] = [
          { measure: 'Gross sales', value: money(d.gross_sales), meaning: 'Total of completed bills in the period (tax per the bill mode).' },
          { measure: 'Sales returns', value: money(d.returns_value), meaning: 'Credit notes: applied to dues plus refunded amounts.' },
          { measure: 'Net sales', value: money(d.net_sales), meaning: 'Gross sales minus sales returns.' },
          { measure: 'COGS (estimated)', value: money(d.cogs), meaning: 'Units sold (net of returns/exchange trade-ins) at weighted-average purchase cost.' },
          { measure: 'Gross profit', value: money(d.gross_profit), meaning: 'Net sales minus estimated COGS.' },
          { measure: 'Operating expenses', value: money(d.expenses), meaning: 'Pending + approved expenses in the period.' },
          { measure: 'Exchange net value', value: money(d.exchanges_net), meaning: 'Price differences collected (refund) on exchanges — informational, not in COGS.' },
          { measure: 'Net profit (estimate)', value: money(d.net_profit), meaning: 'Gross profit minus operating expenses.' },
        ]
        return rows
      },
      rowKey: (r) => String(r.measure),
      note: undefined,
    },
  ],
}

export function SalesReportView() { return <TableReportView config={salesReport} /> }
export function ProductSalesReportView() { return <TableReportView config={productSalesReport} /> }
export function CatalogPerformanceReportView() { return <SectionReportView config={catalogPerformanceReport} /> }
export function PaymentReportView() { return <SectionReportView config={paymentReport} /> }
export function GstReportView() { return <SectionReportView config={gstReport} /> }
export function ProfitReportView() { return <SectionReportView config={profitReport} /> }

export { dateCell }
