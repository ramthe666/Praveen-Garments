'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Plus, Search, Truck, FileText, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/shared/empty-state'
import { DataTablePagination } from '@/components/shared/data-table-pagination'
import { createClient } from '@/lib/supabase/client'
import { useDebounced, formatDate, formatMoney, PAGE_SIZE } from '@/lib/catalog/constants'
import { logError, isTableMissing } from '@/lib/errors'
import { useApp } from '@/components/providers/app-provider'
import { cn } from '@/lib/utils'
import type { PageResult } from '@/types/database'
import { POFormDialog, type SupplierOption, type LocationOption } from './po-form-dialog'
import { InvoiceFormDialog, type POForReceive } from './invoice-form-dialog'
import { PODetailDialog } from './po-detail-dialog'
import { InvoiceDetailDialog } from './invoice-detail-dialog'
import { PurchaseReturnDialog } from './purchase-return-dialog'

interface OrderRow {
  id: string
  po_number: string
  supplier_name: string
  location_name: string
  order_date: string
  expected_date: string | null
  status: string
  grand_total: number
  item_count: number
  unit_count: number
}

interface InvoiceRow {
  id: string
  invoice_number: string
  supplier_name: string
  po_number: string | null
  supplier_invoice_no: string | null
  location_name: string
  invoice_date: string
  status: string
  payment_status: string
  grand_total: number
  due_amount: number
  item_count: number
  unit_count: number
}

interface ReturnRow {
  id: string
  return_number: string
  invoice_number: string
  supplier_name: string
  return_date: string
  reason: string
  grand_total: number
  applied_to_due: number
  item_count: number
  units: number
}

const ORDER_STATUSES = [
  { value: 'ALL', label: 'All orders' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ORDERED', label: 'Placed' },
  { value: 'PARTIALLY_RECEIVED', label: 'Partly received' },
  { value: 'RECEIVED', label: 'Received' },
  { value: 'CANCELLED', label: 'Cancelled' },
]

const INVOICE_STATUSES = [
  { value: 'ALL', label: 'All invoices' },
  { value: 'DRAFT', label: 'Draft (not received)' },
  { value: 'RECEIVED', label: 'Received' },
  { value: 'CANCELLED', label: 'Cancelled' },
]

/**
 * Purchases: orders → receiving → invoices → returns, all database-side
 * filtered and paginated. Creating an order never touches stock; receiving
 * an invoice books it in atomically.
 */
export function PurchasesView() {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()
  const canManage = hasPermission('manage_purchases')

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search, 350)
  const [orderStatus, setOrderStatus] = React.useState('ALL')
  const [invoiceStatus, setInvoiceStatus] = React.useState('ALL')
  const [page, setPage] = React.useState(0)

  const [orders, setOrders] = React.useState<OrderRow[]>([])
  const [ordersTotal, setOrdersTotal] = React.useState(0)
  const [invoices, setInvoices] = React.useState<InvoiceRow[]>([])
  const [invoicesTotal, setInvoicesTotal] = React.useState(0)
  const [returns, setReturns] = React.useState<ReturnRow[]>([])
  const [returnsTotal, setReturnsTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [suppliers, setSuppliers] = React.useState<SupplierOption[]>([])
  const [locations, setLocations] = React.useState<LocationOption[]>([])
  const [receiveablePOs, setReceiveablePOs] = React.useState<POForReceive[]>([])

  const [poFormOpen, setPoFormOpen] = React.useState(false)
  const [invoiceFormOpen, setInvoiceFormOpen] = React.useState(false)
  const [poDetailId, setPoDetailId] = React.useState<string | null>(null)
  const [poDetailOpen, setPoDetailOpen] = React.useState(false)
  const [invoiceDetailId, setInvoiceDetailId] = React.useState<string | null>(null)
  const [invoiceDetailOpen, setInvoiceDetailOpen] = React.useState(false)
  const [preselectedPO, setPreselectedPO] = React.useState<POForReceive | null>(null)
  const [returnInvoice, setReturnInvoice] = React.useState<{ id: string; invoice_number: string; supplier_name: string; status: string; due_amount: number } | null>(null)

  // one-time directory loads (bounded)
  React.useEffect(() => {
    void (async () => {
      const { data: cfg, error: cfgError } = await supabase.rpc('get_pos_config')
      if (!cfgError) {
        const config = cfg as unknown as { locations?: Array<{ id: string; name: string }> }
        setLocations((config?.locations ?? []).map((l) => ({ id: l.id, name: l.name })))
      }
      const { data: sups, error: supsError } = await supabase.rpc('suppliers_page', {
        p_search: null, p_active: 'active', p_limit: 100, p_offset: 0,
      })
      if (supsError) {
        logError('purchases:suppliers', supsError)
      } else {
        const result = sups as unknown as PageResult<{ id: string; name: string }>
        setSuppliers((result.rows ?? []).map((s) => ({ id: s.id, name: s.name })))
      }
    })()
  }, [supabase])

  const load = React.useCallback(async () => {
    setLoading(true)
    const q = debouncedSearch.trim() || null
    const [ordersRes, invoicesRes, returnsRes, poListRes] = await Promise.all([
      supabase.rpc('purchase_orders_page', {
        p_search: q, p_supplier: null, p_status: orderStatus === 'ALL' ? null : orderStatus,
        p_date_from: null, p_date_to: null, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
      }),
      supabase.rpc('purchase_invoices_page', {
        p_search: q, p_supplier: null, p_status: invoiceStatus === 'ALL' ? null : invoiceStatus,
        p_payment_status: null, p_date_from: null, p_date_to: null, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
      }),
      supabase.rpc('purchase_returns_page', {
        p_search: q, p_supplier: null, p_date_from: null, p_date_to: null, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE,
      }),
      canManage
        ? supabase.rpc('purchase_orders_page', {
            p_search: null, p_supplier: null, p_status: null, p_date_from: null, p_date_to: null,
            p_limit: 100, p_offset: 0,
          })
        : Promise.resolve({ data: null, error: null } as { data: unknown; error: null }),
    ])

    if (ordersRes.error) {
      logError('purchases:orders', ordersRes.error)
      if (isTableMissing(ordersRes.error)) setSetupNeeded(true)
      setOrders([])
    } else {
      const result = ordersRes.data as unknown as PageResult<OrderRow>
      setOrders(result.rows ?? [])
      setOrdersTotal(Number(result.total ?? 0))
    }
    if (invoicesRes.error) {
      logError('purchases:invoices', invoicesRes.error)
      setInvoices([])
    } else {
      const result = invoicesRes.data as unknown as PageResult<InvoiceRow>
      setInvoices(result.rows ?? [])
      setInvoicesTotal(Number(result.total ?? 0))
    }
    if (returnsRes.error) {
      logError('purchases:returns', returnsRes.error)
      setReturns([])
    } else {
      const result = returnsRes.data as unknown as PageResult<ReturnRow>
      setReturns(result.rows ?? [])
      setReturnsTotal(Number(result.total ?? 0))
    }
    if (!poListRes.error && poListRes.data) {
      const result = poListRes.data as unknown as PageResult<OrderRow>
      setReceiveablePOs(
        (result.rows ?? [])
          .filter((o) => o.status === 'ORDERED' || o.status === 'PARTIALLY_RECEIVED')
          .map((o) => ({
            id: o.id,
            po_number: o.po_number,
            supplier_id: (o as unknown as { supplier_id: string }).supplier_id,
            supplier_name: o.supplier_name,
            location_id: (o as unknown as { location_id: string }).location_id,
            location_name: o.location_name,
            items: [],
          }))
      )
    }
    setLoading(false)
  }, [supabase, debouncedSearch, orderStatus, invoiceStatus, page, canManage])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    setPage(0)
  }, [debouncedSearch, orderStatus, invoiceStatus])

  function receiveFromPO(po: POForReceive) {
    setPoDetailOpen(false)
    setPreselectedPO(po)
    setInvoiceFormOpen(true)
  }

  function openReturnFromInvoice(inv: { id: string; invoice_number: string; supplier_name: string; status: string; due_amount: number }) {
    setInvoiceDetailOpen(false)
    setReturnInvoice(inv)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Purchases</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Orders, goods receipt, supplier invoices, payables and returns.
          </p>
        </div>
        {canManage && !setupNeeded ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => { setPreselectedPO(null); setInvoiceFormOpen(true) }}>
              <FileText className="size-4" aria-hidden="true" />
              Direct invoice
            </Button>
            <Button size="sm" onClick={() => setPoFormOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              New order
            </Button>
          </div>
        ) : null}
      </div>

      {setupNeeded ? (
        <div className="rounded-lg border bg-card p-6 text-center shadow-xs">
          <h2 className="text-lg font-semibold">Purchases database not ready</h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Apply migration 0009 in the Supabase SQL Editor.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border bg-card p-3 shadow-xs sm:grid-cols-3">
            <div className="relative sm:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Order, invoice or supplier…"
                className="pl-9"
                type="search"
                aria-label="Search purchases"
              />
            </div>
            <Select value={orderStatus} onValueChange={setOrderStatus}>
              <SelectTrigger aria-label="Filter orders by status" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORDER_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={invoiceStatus} onValueChange={setInvoiceStatus}>
              <SelectTrigger aria-label="Filter invoices by status" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVOICE_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Tabs defaultValue="orders">
            <TabsList>
              <TabsTrigger value="orders">Orders</TabsTrigger>
              <TabsTrigger value="invoices">Invoices</TabsTrigger>
              <TabsTrigger value="returns">Returns</TabsTrigger>
            </TabsList>

            <TabsContent value="orders" className="mt-3">
              <div className="rounded-lg border bg-card shadow-xs">
                {loading ? (
                  <div className="space-y-2 p-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : orders.length === 0 ? (
                  <EmptyState icon={<Truck />} title="No purchase orders" description={canManage ? 'Create the first order for your suppliers.' : 'Orders placed with suppliers appear here.'} />
                ) : (
                  <div className="relative overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th scope="col" className="px-3 py-2.5 font-medium">Order</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Supplier</th>
                          <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Date</th>
                          <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">Expected</th>
                          <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Items</th>
                          <th scope="col" className="px-3 py-2.5 text-right font-medium">Total</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {orders.map((row) => (
                          <tr key={row.id} className={row.status === 'CANCELLED' ? 'opacity-60' : undefined}>
                            <td className="px-3 py-2.5">
                              <button className="font-mono text-xs font-medium hover:underline" onClick={() => { setPoDetailId(row.id); setPoDetailOpen(true) }}>
                                {row.po_number}
                              </button>
                            </td>
                            <td className="max-w-[160px] truncate px-3 py-2.5">{row.supplier_name}</td>
                            <td className="hidden px-3 py-2.5 text-xs text-muted-foreground md:table-cell">{formatDate(row.order_date)}</td>
                            <td className="hidden px-3 py-2.5 text-xs text-muted-foreground sm:table-cell">{row.expected_date ? formatDate(row.expected_date) : '—'}</td>
                            <td className="hidden px-3 py-2.5 tabular-nums lg:table-cell">
                              {row.unit_count} <span className="text-xs text-muted-foreground">({row.item_count} lines)</span>
                            </td>
                            <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatMoney(Number(row.grand_total))}</td>
                            <td className="px-3 py-2.5">
                              <span className={cn(
                                'whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
                                row.status === 'RECEIVED' ? 'bg-success/10 text-success border-success/25'
                                  : row.status === 'CANCELLED' ? 'bg-destructive/10 text-destructive border-destructive/25'
                                  : row.status === 'DRAFT' ? 'bg-warning/15 text-warning-foreground border-warning/30'
                                  : 'bg-muted text-muted-foreground border-border'
                              )}>
                                {row.status.replace(/_/g, ' ')}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="border-t px-3 py-2">
                  <DataTablePagination page={page + 1} pageSize={PAGE_SIZE} total={ordersTotal} onPageChange={(next) => setPage(next - 1)} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="invoices" className="mt-3">
              <div className="rounded-lg border bg-card shadow-xs">
                {loading ? (
                  <div className="space-y-2 p-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : invoices.length === 0 ? (
                  <EmptyState icon={<FileText />} title="No purchase invoices" description={canManage ? 'Receive goods to create the first invoice.' : 'Received supplier bills appear here.'} />
                ) : (
                  <div className="relative overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th scope="col" className="px-3 py-2.5 font-medium">Invoice</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Supplier</th>
                          <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Supplier no.</th>
                          <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Date</th>
                          <th scope="col" className="px-3 py-2.5 text-right font-medium">Total</th>
                          <th scope="col" className="px-3 py-2.5 text-right font-medium">Due</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {invoices.map((row) => (
                          <tr key={row.id} className={row.status === 'CANCELLED' ? 'opacity-60' : undefined}>
                            <td className="px-3 py-2.5">
                              <button className="font-mono text-xs font-medium hover:underline" onClick={() => { setInvoiceDetailId(row.id); setInvoiceDetailOpen(true) }}>
                                {row.invoice_number}
                              </button>
                            </td>
                            <td className="max-w-[160px] truncate px-3 py-2.5">{row.supplier_name}</td>
                            <td className="hidden px-3 py-2.5 font-mono text-xs md:table-cell">{row.supplier_invoice_no ?? '—'}</td>
                            <td className="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">{formatDate(row.invoice_date)}</td>
                            <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatMoney(Number(row.grand_total))}</td>
                            <td className={cn('px-3 py-2.5 text-right tabular-nums', Number(row.due_amount) > 0 && row.status === 'RECEIVED' && 'text-destructive')}>
                              {row.status === 'RECEIVED' && Number(row.due_amount) > 0 ? formatMoney(Number(row.due_amount)) : '—'}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={cn(
                                'whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
                                row.status === 'RECEIVED'
                                  ? Number(row.due_amount) > 0 ? 'bg-warning/15 text-warning-foreground border-warning/30' : 'bg-success/10 text-success border-success/25'
                                  : row.status === 'CANCELLED' ? 'bg-destructive/10 text-destructive border-destructive/25'
                                  : 'bg-muted text-muted-foreground border-border'
                              )}>
                                {row.status === 'DRAFT' ? 'Draft' : row.status === 'RECEIVED' ? row.payment_status.replace('_', ' ') : row.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="border-t px-3 py-2">
                  <DataTablePagination page={page + 1} pageSize={PAGE_SIZE} total={invoicesTotal} onPageChange={(next) => setPage(next - 1)} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="returns" className="mt-3">
              <div className="rounded-lg border bg-card shadow-xs">
                {loading ? (
                  <div className="space-y-2 p-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : returns.length === 0 ? (
                  <EmptyState icon={<Undo2 />} title="No purchase returns" description="Goods returned to suppliers appear here." />
                ) : (
                  <div className="relative overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th scope="col" className="px-3 py-2.5 font-medium">Return</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Supplier</th>
                          <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">Invoice</th>
                          <th scope="col" className="hidden px-3 py-2.5 font-medium lg:table-cell">Date</th>
                          <th scope="col" className="hidden px-3 py-2.5 font-medium xl:table-cell">Reason</th>
                          <th scope="col" className="px-3 py-2.5 text-right font-medium">Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {returns.map((row) => (
                          <tr key={row.id}>
                            <td className="px-3 py-2.5 font-mono text-xs font-medium">{row.return_number}</td>
                            <td className="max-w-[160px] truncate px-3 py-2.5">{row.supplier_name}</td>
                            <td className="hidden px-3 py-2.5 font-mono text-xs md:table-cell">{row.invoice_number}</td>
                            <td className="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">{formatDate(row.return_date)}</td>
                            <td className="hidden max-w-[200px] truncate px-3 py-2.5 text-xs text-muted-foreground xl:table-cell">{row.reason}</td>
                            <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                              {formatMoney(Number(row.grand_total))}
                              {Number(row.applied_to_due) > 0 ? (
                                <p className="text-xs text-muted-foreground">payable −{formatMoney(Number(row.applied_to_due))}</p>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="border-t px-3 py-2">
                  <DataTablePagination page={page + 1} pageSize={PAGE_SIZE} total={returnsTotal} onPageChange={(next) => setPage(next - 1)} />
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}

      <POFormDialog
        open={poFormOpen}
        onOpenChange={setPoFormOpen}
        suppliers={suppliers}
        locations={locations}
        onSaved={() => void load()}
      />
      <InvoiceFormDialog
        open={invoiceFormOpen}
        onOpenChange={(v) => { setInvoiceFormOpen(v); if (!v) setPreselectedPO(null) }}
        suppliers={suppliers}
        locations={locations}
        orders={receiveablePOs}
        preselectedPO={preselectedPO}
        onSaved={() => void load()}
      />
      <PODetailDialog
        poId={poDetailId}
        open={poDetailOpen}
        onOpenChange={setPoDetailOpen}
        onChanged={() => void load()}
        onReceive={receiveFromPO}
      />
      <InvoiceDetailDialog
        invoiceId={invoiceDetailId}
        open={invoiceDetailOpen}
        onOpenChange={setInvoiceDetailOpen}
        onChanged={() => void load()}
        onReturn={(detail) => openReturnFromInvoice({
          id: detail.invoice.id,
          invoice_number: detail.invoice.invoice_number,
          supplier_name: detail.invoice.supplier_name,
          status: detail.invoice.status,
          due_amount: Number(detail.invoice.due_amount),
        })}
      />
      <PurchaseReturnDialog
        invoice={returnInvoice}
        open={!!returnInvoice}
        onOpenChange={(v) => { if (!v) setReturnInvoice(null) }}
        onSaved={() => void load()}
      />
    </div>
  )
}
