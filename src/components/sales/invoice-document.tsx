'use client'

import * as React from 'react'
import { Printer, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney, formatDateTime } from '@/lib/catalog/constants'
import { round2 } from '@/lib/pos/calc'
import { cn } from '@/lib/utils'
import type { CompanySettings, Sale, SaleItem, SalePayment } from '@/types/database'
import type { SaleDetailData } from '@/components/sales/sale-detail-view'

export interface InvoiceSettings {
  show_logo?: boolean
  default_terms?: string
  footer_note?: string
}

type PaperMode = 'a4' | 'thermal'

/** GST display split (deterministic; mirrors the engine rule). */
function lineSplit(taxAmount: number, intraState: boolean) {
  if (intraState) {
    const cgst = round2(taxAmount / 2)
    return { cgst, sgst: round2(taxAmount - cgst), igst: 0 }
  }
  return { cgst: 0, sgst: 0, igst: taxAmount }
}

/**
 * The printable invoice. Rendered separately from the POS / dashboard —
 * the browser print dialog outputs ONLY this document (clean print CSS).
 * Two formats: A4 sheet (full tax invoice) and 80 mm thermal receipt.
 * Everything comes from the database (company settings, invoice settings,
 * sale snapshots) — nothing about the business is hardcoded here.
 */
export function InvoiceDocument({
  detail,
  company,
  invoiceSettings,
  autoPrint,
}: {
  detail: SaleDetailData
  company: CompanySettings | null
  invoiceSettings: InvoiceSettings
  autoPrint?: boolean
}) {
  const [mode, setMode] = React.useState<PaperMode>('a4')
  const printedRef = React.useRef(false)

  const sale = detail.sale
  const items = detail.items
  const payments = detail.payments
  const cancelled = sale.status === 'CANCELLED'
  const intraState = !sale.inter_state

  const doPrint = React.useCallback(() => {
    window.print()
  }, [])

  // auto-print (opened with ?print=1, e.g. from the post-sale screen)
  React.useEffect(() => {
    if (autoPrint && !printedRef.current) {
      printedRef.current = true
      const t = setTimeout(() => window.print(), 600)
      return () => clearTimeout(t)
    }
  }, [autoPrint])

  // GST summary grouped by rate (like a real tax invoice)
  const gstGroups = React.useMemo(() => {
    const map = new Map<number, { rate: number; taxable: number; cgst: number; sgst: number; igst: number }>()
    for (const item of items) {
      const rate = Number(item.gst_rate) || 0
      const tax = Number(item.tax_amount)
      const taxable = round2(Number(item.line_total) - tax)
      const s = lineSplit(tax, intraState)
      const g = map.get(rate) ?? { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }
      g.taxable = round2(g.taxable + taxable)
      g.cgst = round2(g.cgst + s.cgst)
      g.sgst = round2(g.sgst + s.sgst)
      g.igst = round2(g.igst + s.igst)
      map.set(rate, g)
    }
    return Array.from(map.values()).sort((a, b) => a.rate - b.rate)
     
  }, [items, intraState])

  const thermal = mode === 'thermal'

  return (
    <div className={cn('mx-auto', thermal ? 'w-full max-w-[380px]' : 'w-full max-w-[820px]')}>
      {/* screen controls */}
      <div className="print:hidden mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setMode('a4')} aria-pressed={mode === 'a4'}>
            A4 sheet
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMode('thermal')} aria-pressed={mode === 'thermal'}>
            <ReceiptText className="size-4" aria-hidden="true" />
            80mm thermal
          </Button>
        </div>
        <Button size="sm" onClick={doPrint}>
          <Printer className="size-4" aria-hidden="true" />
          Print / Save as PDF
        </Button>
      </div>

      {thermal ? (
        <style>{'@media print { @page { size: 80mm auto; margin: 2mm; } }'}</style>
      ) : (
        <style>{'@media print { @page { size: A4 portrait; margin: 10mm; } }'}</style>
      )}

      {/* THE DOCUMENT */}
      <article
        className={cn(
          'invoice-print-area print-area mx-auto bg-white text-black shadow-sm',
          thermal ? 'w-[302px] px-3 py-2 font-mono text-[11px] leading-tight' : 'rounded-lg p-8 text-[13px]'
        )}
      >
        {cancelled ? (
          <div className="mb-2 border-2 border-dashed border-red-600 py-1 text-center text-base font-bold tracking-widest text-red-600">
            CANCELLED
          </div>
        ) : null}

        {/* header */}
        <header className={cn('flex', thermal ? 'flex-col items-center text-center' : 'items-start justify-between gap-4 border-b border-neutral-300 pb-4')}>
          <div className={cn(thermal && 'text-center')}>
            {invoiceSettings.show_logo !== false && company?.logo_url ? (
               
              <img
                src={company.logo_url}
                alt={`${company.company_name} logo`}
                className={cn(thermal ? 'mx-auto mb-1 h-10 w-auto object-contain' : 'mb-2 h-14 w-auto object-contain')}
              />
            ) : null}
            <h1 className={cn('font-bold uppercase', thermal ? 'text-sm' : 'text-xl')}>{company?.company_name ?? 'Invoice'}</h1>
            {company && !thermal ? (
              <p className="mt-0.5 text-[12px] leading-snug text-neutral-700">
                {[company.address, company.city, company.state, company.pincode].filter(Boolean).join(', ')}
              </p>
            ) : null}
            {company?.phone || company?.email ? (
              <p className="text-[12px] text-neutral-700">
                {company.phone ? `Ph: ${company.phone}` : ''}
                {company.phone && company.email ? ' · ' : ''}
                {company.email ?? ''}
              </p>
            ) : null}
            {company?.gstin ? (
              <p className="mt-0.5 text-[12px] font-semibold">GSTIN: {company.gstin}</p>
            ) : null}
          </div>

          <div className={cn('text-right', thermal && 'mt-1 text-center')}>
            <p className={cn('font-bold uppercase tracking-wide', thermal ? 'text-[11px]' : 'text-sm')}>
              {cancelled ? 'Cancelled Invoice' : 'Tax Invoice'}
            </p>
            <p className="mt-1">
              <span className="text-neutral-600">No: </span>
              <span className="font-semibold">{sale.sale_number}</span>
            </p>
            <p className="text-neutral-700">{formatDateTime(sale.sale_date)}</p>
            {payments.length > 0 ? (
              <p className="text-neutral-700">
                {payments.filter((p) => !p.is_credit).map((p) => p.method).join(' + ') || 'Credit'}
              </p>
            ) : null}
          </div>
        </header>

        {/* customer + cashier */}
        <section className={cn(thermal ? 'my-1 border-y border-dashed border-neutral-400 py-1' : 'my-4 grid grid-cols-2 gap-4 border-b border-neutral-200 pb-3')}>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-neutral-500">Billed to</p>
            {sale.customer_name ? (
              <>
                <p className="font-semibold">{sale.customer_name}</p>
                {sale.customer_phone ? <p className="text-neutral-700">{sale.customer_phone}</p> : null}
              </>
            ) : (
              <p className="text-neutral-700">Walk-in customer</p>
            )}
          </div>
          <div className={cn(thermal ? '' : 'text-right')}>
            <p className="text-[11px] uppercase tracking-wide text-neutral-500">Served by</p>
            <p className="text-neutral-700">{sale.cashier_name ?? '—'}</p>
          </div>
        </section>

        {/* items */}
        {thermal ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-dashed border-neutral-400 text-left">
                <th className="py-0.5 font-semibold">Item</th>
                <th className="py-0.5 text-right font-semibold">Qty</th>
                <th className="py-0.5 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: SaleItem) => (
                <tr key={item.id} className="align-top">
                  <td className="py-0.5 pr-1">
                    <span className="block">{item.product_name}</span>
                    <span className="block text-neutral-600">
                      {[item.color_name, item.size_name].filter(Boolean).join(' / ') || ''} {item.sku}
                    </span>
                  </td>
                  <td className="py-0.5 text-right tabular-nums">{item.quantity}</td>
                  <td className="py-0.5 text-right tabular-nums">{formatMoney(Number(item.line_total))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-y border-neutral-300 bg-neutral-100 text-left">
                <th className="px-2 py-1.5 font-semibold">#</th>
                <th className="px-2 py-1.5 font-semibold">Item</th>
                <th className="px-2 py-1.5 font-semibold">HSN</th>
                <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                <th className="px-2 py-1.5 text-right font-semibold">Price</th>
                <th className="px-2 py-1.5 text-right font-semibold">Discount</th>
                <th className="px-2 py-1.5 text-right font-semibold">Taxable</th>
                <th className="px-2 py-1.5 text-right font-semibold">GST</th>
                <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: SaleItem, index) => {
                const tax = Number(item.tax_amount)
                const s = lineSplit(tax, intraState)
                const taxable = round2(Number(item.line_total) - tax)
                return (
                  <tr key={item.id} className="border-b border-neutral-200 align-top">
                    <td className="px-2 py-1.5 tabular-nums">{index + 1}</td>
                    <td className="px-2 py-1.5">
                      <span className="font-medium">{item.product_name}</span>
                      <span className="block text-neutral-600">
                        {[item.color_name, item.size_name].filter(Boolean).join(' / ') || '—'} · {item.sku}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-neutral-700">{item.hsn_code ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{item.quantity}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(Number(item.unit_price))}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-neutral-700">
                      {Number(item.discount_amount) > 0 ? `− ${formatMoney(Number(item.discount_amount))}` : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(taxable)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-neutral-700">
                      {tax > 0 ? (
                        <span>
                          {Number(item.gst_rate)}% ·{' '}
                          {intraState
                            ? `${formatMoney(s.cgst)}+${formatMoney(s.sgst)}`
                            : formatMoney(s.igst)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums">{formatMoney(Number(item.line_total))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {/* totals */}
        <section className={cn(thermal ? 'mt-1' : 'mt-4 flex justify-end')}>
          <div className={cn('w-full space-y-0.5', thermal ? '' : 'w-72 text-[12px]')}>
            <Row label="Subtotal" value={formatMoney(Number(sale.subtotal) + Number(sale.item_discount_total))} />
            {Number(sale.item_discount_total) > 0 ? (
              <Row label="Item discounts" value={`− ${formatMoney(Number(sale.item_discount_total))}`} />
            ) : null}
            {Number(sale.bill_discount) > 0 ? (
              <Row label="Bill discount" value={`− ${formatMoney(Number(sale.bill_discount))}`} />
            ) : null}
            {Number(sale.tax_total) > 0 ? (
              <Row
                label={`GST ${sale.tax_mode === 'inclusive' ? '(included)' : '(added)'}`}
                value={formatMoney(Number(sale.tax_total))}
              />
            ) : null}
            {Number(sale.round_off) !== 0 ? (
              <Row label="Round off" value={`${Number(sale.round_off) > 0 ? '+' : '−'} ${formatMoney(Math.abs(Number(sale.round_off)))}`} />
            ) : null}
            <div className={cn('flex items-center justify-between border-t border-neutral-400 pt-1 font-bold', thermal ? 'text-[12px]' : 'text-sm border-neutral-300')}>
              <span>Grand Total</span>
              <span className="tabular-nums">{formatMoney(Number(sale.grand_total))}</span>
            </div>
            <Row label="Paid" value={formatMoney(Number(sale.paid_amount))} />
            {Number(sale.due_amount) > 0 ? (
              <Row label="Balance due" value={formatMoney(Number(sale.due_amount))} strong />
            ) : null}
          </div>
        </section>

        {/* payment detail (A4) */}
        {!thermal && payments.length > 0 ? (
          <section className="mt-4 border-t border-neutral-200 pt-2 text-[12px]">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">Payments</p>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5">
              {payments.map((p: SalePayment) => (
                <li key={p.id} className="flex items-center justify-between">
                  <span>
                    {p.method}
                    {p.reference ? ` #${p.reference}` : ''}
                    {p.cash_received != null && Number(p.cash_change) > 0
                      ? ` (received ${formatMoney(Number(p.cash_received))}, change ${formatMoney(Number(p.cash_change))})`
                      : ''}
                  </span>
                  <span className="tabular-nums">{formatMoney(Number(p.amount))}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* GST rate summary (A4 only, when taxed) */}
        {!thermal && gstGroups.length > 0 && Number(sale.tax_total) > 0 ? (
          <section className="mt-4 border-t border-neutral-200 pt-2 text-[12px]">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">GST summary</p>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-neutral-300 text-left">
                  <th className="py-1 font-semibold">Rate</th>
                  <th className="py-1 text-right font-semibold">Taxable</th>
                  <th className="py-1 text-right font-semibold">{intraState ? 'CGST' : 'IGST'}</th>
                  {intraState ? <th className="py-1 text-right font-semibold">SGST</th> : null}
                  <th className="py-1 text-right font-semibold">Total tax</th>
                </tr>
              </thead>
              <tbody>
                {gstGroups.map((g) => (
                  <tr key={g.rate} className="border-b border-neutral-200">
                    <td className="py-1 tabular-nums">{g.rate}%</td>
                    <td className="py-1 text-right tabular-nums">{formatMoney(g.taxable)}</td>
                    <td className="py-1 text-right tabular-nums">{formatMoney(intraState ? g.cgst : g.igst)}</td>
                    {intraState ? <td className="py-1 text-right tabular-nums">{formatMoney(g.sgst)}</td> : null}
                    <td className="py-1 text-right tabular-nums">{formatMoney(g.cgst + g.sgst + g.igst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {intraState ? (
              <p className="mt-1 text-[11px] text-neutral-600">
                Intra-state supply — CGST + SGST. Company state: {company?.state ?? '—'}
                {sale.customer_name ? ` · Customer state on file used for place-of-supply checks.` : ''}
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-neutral-600">Inter-state supply — IGST.</p>
            )}
          </section>
        ) : null}

        {/* terms + footer */}
        <footer className={cn('mt-4 border-t border-neutral-300 pt-2 text-center', thermal ? 'text-[10px]' : 'text-[11px]')}>
          {invoiceSettings.default_terms ? (
            <p className={cn('mb-1', thermal ? 'text-left leading-snug' : 'mx-auto max-w-lg leading-snug text-neutral-600')}>
              {invoiceSettings.default_terms}
            </p>
          ) : null}
          <p className="font-semibold">{sale.notes ?? invoiceSettings.footer_note ?? ''}</p>
          <p className="mt-1 text-neutral-500">Computer-generated invoice · {sale.sale_number}</p>
        </footer>
      </article>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-600">{label}</span>
      <span className={cn('tabular-nums', strong && 'font-bold text-red-700')}>{value}</span>
    </div>
  )
}
