'use client'

/** Operations report configs (purchases, suppliers, customers, expenses, returns, cash, audit log). */
import { TableReportView, type TableReportConfig } from '@/components/reports/table-report-view'
import { SectionReportView, type SectionReportConfig } from '@/components/reports/section-report-view'
import { FilterSearch, FilterSelect } from '@/components/reports/report-shell'
import {
  AUDIT_ACTION_OPTIONS,
  CUSTOMER_TYPE_OPTIONS,
  PAYMENT_STATUS_OPTIONS,
  PURCHASE_STATUS_OPTIONS,
  dateCell,
  money,
  num,
  timeCell,
} from '@/components/reports/config-helpers'

type Row = Record<string, unknown>

// ---------------------------------------------------------------------------
// 1. Purchase report (invoice level)
// ---------------------------------------------------------------------------

const purchaseReport: TableReportConfig<Row> = {
  rpc: 'purchase_report',
  title: 'Purchase report',
  subtitle: 'Received purchase invoices, value and payables',
  filename: 'purchase-report',
  emptyTitle: 'No purchase invoices in this period',
  columns: [
    { key: 'invoice_number', header: 'Invoice', render: (r) => <span className="font-mono text-xs">{String(r.invoice_number)}</span> },
    { key: 'supplier_name', header: 'Supplier' },
    { key: 'supplier_invoice_no', header: 'Supplier inv.', hide: 'lg', render: (r) => String(r.supplier_invoice_no ?? '—') },
    { key: 'invoice_date', header: 'Date', hide: 'sm', render: (r) => dateCell(r.invoice_date) },
    { key: 'items', header: 'Items', align: 'right', hide: 'md' },
    { key: 'quantity', header: 'Qty', align: 'right', hide: 'lg' },
    { key: 'tax_total', header: 'Tax', align: 'right', hide: 'md', render: (r) => money(r.tax_total) },
    { key: 'grand_total', header: 'Value', align: 'right', render: (r) => money(r.grand_total), sortable: true },
    { key: 'paid_amount', header: 'Paid', align: 'right', hide: 'md', render: (r) => money(r.paid_amount) },
    { key: 'due_amount', header: 'Due', align: 'right', render: (r) => money(r.due_amount), sortable: true },
  ],
  rowKey: (r) => String(r.id),
  pageResult: (data) => data as { rows: Row[]; total: number; summary?: Record<string, number> },
  summary: (s) => [
    { label: 'Invoices', value: num(s?.invoices) },
    { label: 'Purchase value', value: money(s?.value) },
    { label: 'Tax', value: money(s?.tax) },
    { label: 'Discounts', value: money(s?.discounts) },
    { label: 'Paid', value: money(s?.paid) },
    { label: 'Due', value: money(s?.due), tone: 'warning' },
  ],
  filterControls: (draft, patch) => (
    <>
      <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="Invoice, supplier, PO" id="pr-search" />
      <FilterSelect id="pr-status" label="Status" value={draft.status ?? 'RECEIVED'} onChange={(v) => patch({ status: v === '__all__' ? 'ALL' : v })} options={PURCHASE_STATUS_OPTIONS} />
      <FilterSelect id="pr-pstatus" label="Payment status" value={draft.pstatus ?? ''} onChange={(v) => patch({ pstatus: v === '__all__' ? '' : v })} options={PAYMENT_STATUS_OPTIONS} />
    </>
  ),
  argsFromFilters: (from, to, f, page, sort) => ({
    p_date_from: from || null,
    p_date_to: to || null,
    p_search: f.search?.trim() || null,
    p_status: f.status || 'RECEIVED',
    p_payment_status: f.pstatus || null,
    p_sort: sort || 'date_desc',
    p_limit: 25,
    p_offset: page * 25,
  }),
  sortOptions: [
    { value: 'date_desc', label: 'Newest first' },
    { value: 'date_asc', label: 'Oldest first' },
    { value: 'value_desc', label: 'Highest value' },
    { value: 'due_desc', label: 'Highest due' },
  ],
  defaultSort: 'date_desc',
}

// ---------------------------------------------------------------------------
// 2. Supplier report
// ---------------------------------------------------------------------------

const supplierReport: TableReportConfig<Row> = {
  rpc: 'supplier_report',
  title: 'Supplier report',
  subtitle: 'Purchases, payments, returns and outstanding per supplier',
  filename: 'supplier-report',
  emptyTitle: 'No suppliers match',
  columns: [
    { key: 'name', header: 'Supplier' },
    { key: 'phone', header: 'Phone', hide: 'md', render: (r) => String(r.phone ?? '—') },
    { key: 'invoices', header: 'Invoices', align: 'right', hide: 'sm' },
    { key: 'purchase_value', header: 'Purchases', align: 'right', render: (r) => money(r.purchase_value), sortable: true },
    { key: 'payments', header: 'Payments', align: 'right', hide: 'md', render: (r) => money(r.payments) },
    { key: 'returns_value', header: 'Returns', align: 'right', hide: 'lg', render: (r) => money(r.returns_value) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => money(r.outstanding), sortable: true },
  ],
  rowKey: (r) => String(r.id),
  pageResult: (data) => data as { rows: Row[]; total: number; summary?: Record<string, number> },
  summary: (s) => [
    { label: 'Suppliers', value: num(s?.suppliers) },
    { label: 'Active', value: num(s?.active) },
    { label: 'Purchases', value: money(s?.purchase_value) },
    { label: 'Payments', value: money(s?.payments) },
    { label: 'Returns', value: money(s?.returns_value) },
    { label: 'Outstanding', value: money(s?.outstanding), tone: 'warning' },
  ],
  filterControls: (draft, patch) => (
    <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="Supplier, phone, GSTIN" id="sr-search" />
  ),
  argsFromFilters: (from, to, f, page, sort) => ({
    p_date_from: from || null,
    p_date_to: to || null,
    p_search: f.search?.trim() || null,
    p_sort: sort || 'purchases_desc',
    p_limit: 25,
    p_offset: page * 25,
  }),
  sortOptions: [
    { value: 'purchases_desc', label: 'Top purchasers' },
    { value: 'outstanding_desc', label: 'Highest outstanding' },
    { value: 'payments_desc', label: 'Most paid' },
    { value: 'name_asc', label: 'Name A–Z' },
  ],
  defaultSort: 'purchases_desc',
}

// ---------------------------------------------------------------------------
// 3. Customer report
// ---------------------------------------------------------------------------

const customerReport: TableReportConfig<Row> = {
  rpc: 'customer_report',
  title: 'Customer report',
  subtitle: 'Purchases, payments and outstanding per customer',
  filename: 'customer-report',
  emptyTitle: 'No customers match',
  columns: [
    { key: 'name', header: 'Customer' },
    { key: 'phone', header: 'Phone', hide: 'md', render: (r) => String(r.phone ?? '—') },
    { key: 'customer_type', header: 'Type', hide: 'lg', render: (r) => String(r.customer_type ?? 'retail') },
    { key: 'bills', header: 'Bills', align: 'right', hide: 'sm', sortable: true },
    { key: 'purchases', header: 'Purchases', align: 'right', render: (r) => money(r.purchases), sortable: true },
    { key: 'payments', header: 'Payments', align: 'right', hide: 'md', render: (r) => money(r.payments) },
    { key: 'returns_value', header: 'Returns', align: 'right', hide: 'xl', render: (r) => money(r.returns_value) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => money(r.outstanding), sortable: true },
    { key: 'last_purchase', header: 'Last purchase', hide: 'xl', render: (r) => (r.last_purchase ? dateCell(r.last_purchase) : '—') },
  ],
  rowKey: (r) => String(r.id),
  pageResult: (data) => data as { rows: Row[]; total: number; summary?: Record<string, number> },
  summary: (s) => [
    { label: 'Customers', value: num(s?.customers) },
    { label: 'Active', value: num(s?.active) },
    { label: 'With purchases', value: num(s?.with_purchases) },
    { label: 'Purchases', value: money(s?.purchases) },
    { label: 'Payments', value: money(s?.payments) },
    { label: 'Outstanding', value: money(s?.outstanding), tone: 'warning' },
  ],
  filterControls: (draft, patch) => (
    <>
      <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="Customer, phone, email" id="cr-search" />
      <FilterSelect id="cr-type" label="Customer type" value={draft.type ?? ''} onChange={(v) => patch({ type: v === '__all__' ? '' : v })} options={CUSTOMER_TYPE_OPTIONS} />
    </>
  ),
  argsFromFilters: (from, to, f, page, sort) => ({
    p_date_from: from || null,
    p_date_to: to || null,
    p_search: f.search?.trim() || null,
    p_type: f.type || null,
    p_sort: sort || 'purchases_desc',
    p_limit: 25,
    p_offset: page * 25,
  }),
  sortOptions: [
    { value: 'purchases_desc', label: 'Top customers' },
    { value: 'outstanding_desc', label: 'Highest outstanding' },
    { value: 'payments_desc', label: 'Most payments' },
    { value: 'bills_desc', label: 'Most bills' },
    { value: 'name_asc', label: 'Name A–Z' },
  ],
  defaultSort: 'purchases_desc',
}

// ---------------------------------------------------------------------------
// 4. Expense report
// ---------------------------------------------------------------------------

const expenseReport: SectionReportConfig = {
  rpc: 'expense_report',
  title: 'Expense report',
  subtitle: 'Pending + approved expenses by category, method, location and day',
  filename: 'expense-report',
  argsFromFilters: (from, to) => ({ p_date_from: from || null, p_date_to: to || null }),
  note: 'Cancelled expenses are excluded; pending and approved are counted as committed spend.',
  summary: (data) => {
    const s = (data?.summary ?? {}) as Record<string, number>
    return [
      { label: 'Total', value: money(s.total), tone: 'destructive' },
      { label: 'Count', value: num(s.count) },
      { label: 'Pending', value: money(s.pending_total), tone: 'warning' },
      { label: 'Approved', value: money(s.approved_total) },
    ]
  },
  sections: [
    {
      key: 'by_category',
      title: 'By category',
      columns: [
        { key: 'name', header: 'Category' },
        { key: 'count', header: 'Count', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => ((data?.by_category ?? []) as Row[]),
      rowKey: (r) => String(r.name),
    },
    {
      key: 'by_method',
      title: 'By payment method',
      columns: [
        { key: 'method', header: 'Method' },
        { key: 'count', header: 'Count', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => ((data?.by_method ?? []) as Row[]),
      rowKey: (r) => String(r.method),
    },
    {
      key: 'by_location',
      title: 'By location',
      columns: [
        { key: 'name', header: 'Location' },
        { key: 'count', header: 'Count', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => ((data?.by_location ?? []) as Row[]),
      rowKey: (r) => String(r.name),
    },
    {
      key: 'by_day',
      title: 'By day',
      columns: [
        { key: 'day', header: 'Date', render: (r) => dateCell(r.day) },
        { key: 'count', header: 'Count', align: 'right' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => ((data?.by_day ?? []) as Row[]),
      rowKey: (r) => String(r.day),
    },
  ],
}

// ---------------------------------------------------------------------------
// 5. Returns report
// ---------------------------------------------------------------------------

const returnsReport: SectionReportConfig = {
  rpc: 'returns_report',
  title: 'Returns & exchanges',
  subtitle: 'Sales returns, exchanges and purchase returns',
  filename: 'returns-report',
  argsFromFilters: (from, to) => ({ p_date_from: from || null, p_date_to: to || null }),
  summary: (data) => {
    const sr = (data?.sales_returns ?? {}) as Record<string, number>
    const ex = (data?.exchanges ?? {}) as Record<string, number>
    const pr = (data?.purchase_returns ?? {}) as Record<string, number>
    return [
      { label: 'Sales returns', value: num(sr.count) },
      { label: 'Refunded', value: money(sr.refund_amount), tone: 'destructive' },
      { label: 'Exchanges', value: num(ex.count) },
      { label: 'Ex. refunded', value: money(ex.refunded) },
      { label: 'Purchase returns', value: num(pr.count) },
      { label: 'PR value', value: money(pr.value) },
    ]
  },
  sections: [
    {
      key: 'sr_reasons',
      title: 'Sales returns by reason',
      columns: [
        { key: 'reason', header: 'Reason' },
        { key: 'count', header: 'Returns', align: 'right' },
        { key: 'value', header: 'Value', align: 'right', render: (r) => money(r.value) },
      ],
      rows: (data) => (((data?.sales_returns ?? {}) as Record<string, unknown>).by_reason ?? []) as Row[],
      rowKey: (r) => String(r.reason),
    },
    {
      key: 'sr_condition',
      title: 'Returned condition',
      description: 'Good returns restock to the sales floor; damaged returns go to the damaged location.',
      columns: [
        { key: 'condition', header: 'Condition' },
        { key: 'quantity', header: 'Units', align: 'right' },
        { key: 'value', header: 'Value', align: 'right', render: (r) => money(r.value) },
      ],
      rows: (data) => (((data?.sales_returns ?? {}) as Record<string, unknown>).by_condition ?? []) as Row[],
      rowKey: (r) => String(r.condition),
    },
    {
      key: 'sr_days',
      title: 'Sales returns by day',
      columns: [
        { key: 'day', header: 'Date', render: (r) => dateCell(r.day) },
        { key: 'count', header: 'Returns', align: 'right' },
        { key: 'value', header: 'Value', align: 'right', render: (r) => money(r.value) },
      ],
      rows: (data) => (((data?.sales_returns ?? {}) as Record<string, unknown>).by_day ?? []) as Row[],
      rowKey: (r) => String(r.day),
    },
    {
      key: 'pr_supplier',
      title: 'Purchase returns by supplier',
      columns: [
        { key: 'name', header: 'Supplier' },
        { key: 'count', header: 'Returns', align: 'right' },
        { key: 'value', header: 'Value', align: 'right', render: (r) => money(r.value) },
      ],
      rows: (data) => (((data?.purchase_returns ?? {}) as Record<string, unknown>).by_supplier ?? []) as Row[],
      rowKey: (r) => String(r.name),
    },
  ],
}

// ---------------------------------------------------------------------------
// 6. Cash report (single day)
// ---------------------------------------------------------------------------

const cashReport: SectionReportConfig = {
  rpc: 'cash_report',
  title: 'Daily cash position',
  subtitle: 'Expected cash for one day, derived from the payment ledger',
  filename: 'cash-report',
  note: 'Uses the From date as the day. Opening cash is the ledger balance before that day; expenses include pending + approved. A later cancellation shifts subsequent days.',
  argsFromFilters: (from) => ({ p_date: from || null }),
  summary: (data) => {
    const d = (data ?? {}) as Record<string, number>
    return [
      { label: 'Opening cash', value: money(d.opening_cash) },
      { label: 'Cash in', value: money(d.total_in), tone: 'positive' },
      { label: 'Exchange collected', value: money(d.cash_exchange_in) },
      { label: 'Cash out', value: money(d.total_out), tone: 'destructive' },
      { label: 'Expected cash', value: money(d.expected_cash), tone: Number(d.expected_cash) >= 0 ? 'positive' : 'destructive' },
    ]
  },
  sections: [
    {
      key: 'position',
      title: 'Day position',
      columns: [
        { key: 'label', header: 'Line' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
      ],
      rows: (data) => {
        const d = (data ?? {}) as Record<string, number>
        const rows: Row[] = [
          { label: 'Opening cash (ledger before the day)', amount: d.opening_cash },
          { label: 'Cash sales at the till', amount: d.cash_sales },
          { label: 'Cash customer receipts', amount: d.cash_receipts },
          { label: 'Cash collected on exchanges', amount: d.cash_exchange_in },
          { label: 'Cash refunds (returns + exchanges)', amount: -Number(d.cash_refunds ?? 0) },
          { label: 'Cash expenses', amount: -Number(d.cash_expenses ?? 0) },
          { label: 'Cash supplier payments', amount: -Number(d.cash_supplier ?? 0) },
          { label: 'Expected cash at close', amount: d.expected_cash },
        ]
        return rows
      },
      rowKey: (r) => String(r.label),
    },
  ],
}

// ---------------------------------------------------------------------------
// 7. Audit log viewer (admin only)
// ---------------------------------------------------------------------------

const auditReport: TableReportConfig<Row> = {
  rpc: 'audit_page',
  title: 'Audit log',
  subtitle: 'Append-only activity trail (admin only)',
  filename: 'audit-log',
  emptyTitle: 'No audit entries match',
  columns: [
    { key: 'created_at', header: 'Time', render: (r) => timeCell(r.created_at), csv: (r) => String(r.created_at ?? '') },
    { key: 'user_email', header: 'User', hide: 'md' },
    { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-xs">{String(r.action ?? '')}</span> },
    { key: 'entity_type', header: 'Entity', hide: 'sm' },
    { key: 'entity_id', header: 'Reference', hide: 'lg', render: (r) => <span className="font-mono text-xs">{String(r.entity_id ?? '—')}</span> },
    {
      key: 'metadata',
      header: 'Details',
      hide: 'xl',
      render: (r) => (
        <span className="block max-w-64 truncate text-xs text-muted-foreground" title={JSON.stringify(r.metadata ?? {})}>
          {JSON.stringify(r.metadata ?? {})}
        </span>
      ),
      csv: (r) => JSON.stringify(r.metadata ?? {}),
    },
  ],
  rowKey: (r) => String(r.id),
  pageResult: (data) => data as { rows: Row[]; total: number },
  filterControls: (draft, patch) => (
    <>
      <FilterSearch value={draft.search ?? ''} onChange={(v) => patch({ search: v })} placeholder="User, reference, action" id="au-search" />
      <FilterSelect id="au-action" label="Action" value={draft.action ?? ''} onChange={(v) => patch({ action: v === '__all__' ? '' : v })} options={AUDIT_ACTION_OPTIONS.slice(0, 60)} />
    </>
  ),
  argsFromFilters: (from, to, f, page) => ({
    p_search: f.search?.trim() || null,
    p_action: f.action || null,
    p_date_from: from || null,
    p_date_to: to || null,
    p_limit: 25,
    p_offset: page * 25,
  }),
  exportNote: 'Audit entries can be filtered and exported by admins; the table itself is append-only and never editable.',
}

export function PurchaseReportView() { return <TableReportView config={purchaseReport} /> }
export function SupplierReportView() { return <TableReportView config={supplierReport} /> }
export function CustomerReportView() { return <TableReportView config={customerReport} /> }
export function ExpenseReportView() { return <SectionReportView config={expenseReport} /> }
export function ReturnsReportView() { return <SectionReportView config={returnsReport} /> }
export function CashReportView() { return <SectionReportView config={cashReport} /> }
export function AuditLogReportView() { return <TableReportView config={auditReport} /> }
