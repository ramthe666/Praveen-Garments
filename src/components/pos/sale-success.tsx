'use client'

import * as React from 'react'
import Link from 'next/link'
import { CheckCircle2, IndianRupee, Printer, ReceiptText, ShoppingBag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/components/pos/pos-helpers'
import type { SaleResult } from '@/components/pos/pos-types'

/**
 * Post-sale screen: keeps the completed invoice visible until the cashier
 * starts the next sale (nothing is lost on a refresh — the sale is in the
 * database; reprints live on the Sales page).
 */
export function SaleSuccess({ sale, onNewSale }: { sale: SaleResult; onNewSale: () => void }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 rounded-lg border bg-card p-6 text-center shadow-xs sm:p-8">
      <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <CheckCircle2 className="size-8" aria-hidden="true" />
      </span>

      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">Sale completed</h2>
        <p className="text-sm text-muted-foreground">
          Invoice <span className="font-medium text-foreground">{sale.sale_number}</span> has been saved and stock has been updated.
        </p>
      </div>

      <dl className="w-full space-y-1.5 rounded-md border bg-muted/40 p-4 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Grand total</dt>
          <dd className="font-semibold tabular-nums">{formatMoney(Number(sale.grand_total))}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Payment received</dt>
          <dd className="tabular-nums">{formatMoney(Number(sale.paid_amount))}</dd>
        </div>
        {Number(sale.cash_change) > 0 ? (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Change returned</dt>
            <dd className="tabular-nums">{formatMoney(Number(sale.cash_change))}</dd>
          </div>
        ) : null}
        {Number(sale.due_amount) > 0 ? (
          <div className="flex items-center justify-between text-destructive">
            <dt>Balance due</dt>
            <dd className="tabular-nums">{formatMoney(Number(sale.due_amount))}</dd>
          </div>
        ) : null}
        {sale.customer_name ? (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Customer</dt>
            <dd className="max-w-[60%] truncate">{sale.customer_name}</dd>
          </div>
        ) : null}
      </dl>

      <div className="flex w-full flex-col gap-2 sm:flex-row">
        <Button asChild variant="outline" className="flex-1">
          <Link href={`/sales/${sale.sale_id}/invoice`} target="_blank" rel="noopener">
            <Printer className="size-4" aria-hidden="true" />
            Print invoice
          </Link>
        </Button>
        <Button asChild variant="outline" className="flex-1">
          <Link href={`/sales/${sale.sale_id}`} target="_blank" rel="noopener">
            <ReceiptText className="size-4" aria-hidden="true" />
            View sale
          </Link>
        </Button>
        <Button className="flex-1" onClick={onNewSale}>
          <ShoppingBag className="size-4" aria-hidden="true" />
          <IndianRupee className="hidden" aria-hidden="true" />
          New sale
        </Button>
      </div>
    </div>
  )
}
