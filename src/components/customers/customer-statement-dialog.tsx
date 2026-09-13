'use client'

import * as React from 'react'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { createClient } from '@/lib/supabase/client'
import { storeToday, ymd, istDayStart } from '@/lib/reports/period'
import { formatDate, formatMoney } from '@/lib/catalog/constants'
import { logError } from '@/lib/errors'

interface StatementLine {
  entry_date: string
  kind: 'bill' | 'payment' | 'till_payment' | 'return'
  doc_number: string
  debit: number
  credit: number
  link_id: string
}

interface Statement {
  customer: { id: string; name: string; phone: string | null; city: string | null; state: string | null; gstin: string | null }
  from_date: string
  to_date: string
  opening_balance: number
  lines: StatementLine[]
  closing_balance: number
}

const KIND_LABELS: Record<StatementLine['kind'], string> = {
  bill: 'Bill',
  payment: 'Receipt',
  till_payment: 'Till payment',
  return: 'Return credit',
}

/**
 * Customer statement: date-ranged ledger (opening balance → bills / receipts
 * / return credits → closing balance) computed entirely database-side and
 * printable.
 */
export function CustomerStatementDialog({
  customerId,
  customerName,
  open,
  onOpenChange,
}: {
  customerId: string
  customerName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  // Store-local (IST) calendar dates — UTC-derived "today" would show
  // yesterday before 05:30 IST (Phase 8 Part 19 fix).
  const today = storeToday()
  const monthAgo = ymd(new Date(istDayStart(today).getTime() - 30 * 86_400_000))
  const [from, setFrom] = React.useState(monthAgo)
  const [to, setTo] = React.useState(today)
  const [statement, setStatement] = React.useState<Statement | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    void (async () => {
      const { data, error: rpcError } = await supabase.rpc('customer_statement', {
        p_customer_id: customerId,
        p_from: from || null,
        p_to: to || null,
      })
      if (rpcError) {
        logError('customer-statement:load', rpcError)
        setError('Could not build the statement.')
        setStatement(null)
      } else {
        setStatement(data as unknown as Statement)
      }
      setLoading(false)
    })()
  }, [open, from, to, customerId, supabase])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Statement — {customerName}</DialogTitle>
          <DialogDescription>
            Opening balance, bills, till payments, receipts and return credits for the selected range.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-2 print:hidden">
          <div className="grid gap-1.5">
            <Label htmlFor="stmt-from">From</Label>
            <Input id="stmt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="stmt-to">To</Label>
            <Input id="stmt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>

        <div className="max-h-[55vh] overflow-y-auto rounded-lg border print:max-h-none print:overflow-visible">
          {loading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : statement && statement.lines.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No activity in this period.</p>
          ) : statement ? (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Date</th>
                    <th scope="col" className="px-3 py-2 font-medium">Doc</th>
                    <th scope="col" className="px-3 py-2 font-medium">Particulars</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Debit</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(statement.from_date)}</td>
                    <td className="px-3 py-2 font-mono text-xs">—</td>
                    <td className="px-3 py-2">Opening balance</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(statement.opening_balance) > 0 ? formatMoney(Number(statement.opening_balance)) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(statement.opening_balance) < 0 ? formatMoney(-Number(statement.opening_balance)) : '—'}</td>
                  </tr>
                  {statement.lines.map((line) => (
                    <tr key={`${line.kind}-${line.link_id}`}>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(line.entry_date)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{line.doc_number}</td>
                      <td className="px-3 py-2">{KIND_LABELS[line.kind]}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(line.debit) > 0 ? formatMoney(Number(line.debit)) : '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(line.credit) > 0 ? formatMoney(Number(line.credit)) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/40 font-medium">
                    <td className="px-3 py-2 text-xs text-muted-foreground" colSpan={3}>Closing balance</td>
                    <td className="px-3 py-2 text-right tabular-nums" colSpan={2}>
                      {formatMoney(Math.abs(Number(statement.closing_balance)))}
                      {Number(statement.closing_balance) < 0 ? ' (advance)' : ''}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </>
          ) : null}
        </div>

        <DialogFooter className="print:hidden">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={() => window.print()} disabled={!statement}>
            <Printer className="size-4" aria-hidden="true" />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
