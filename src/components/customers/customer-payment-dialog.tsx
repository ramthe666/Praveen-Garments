'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { IndianRupee } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createClient } from '@/lib/supabase/client'
import { logError } from '@/lib/errors'
import { formatMoney } from '@/lib/catalog/constants'

/**
 * Record a customer payment (against outstanding dues, FIFO oldest-first;
 * advances only when enabled in Settings → Payments).
 * Server recomputes the outstanding balance — the amount shown here is a
 * live hint, never the source of truth.
 */
export function CustomerPaymentDialog({
  customerId,
  customerName,
  outstanding,
  advance,
  open,
  onOpenChange,
  onRecorded,
}: {
  customerId: string
  customerName: string
  outstanding: number
  advance: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onRecorded?: (result: Record<string, unknown>) => void
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [methods, setMethods] = React.useState<string[]>([])
  const [amount, setAmount] = React.useState('')
  const [method, setMethod] = React.useState('')
  const [reference, setReference] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    void (async () => {
      const { data, error } = await supabase.rpc('get_pos_config')
      if (error) {
        logError('customer-payment:config', error)
        setMethods(['Cash'])
      } else {
        const cfg = data as unknown as { payments?: { methods?: string[] } }
        setMethods(cfg?.payments?.methods?.length ? cfg.payments.methods : ['Cash'])
      }
    })()
    setAmount('')
    setMethod('')
    setReference('')
    setNotes('')
  }, [open, supabase])

  const suggestion = Math.max(0, Number(outstanding) - Number(advance))

  async function submit() {
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter a valid payment amount.')
      return
    }
    if (!method) {
      toast.error('Choose a payment method.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch(`/api/customers/${customerId}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Math.round(value * 100) / 100,
          method,
          reference: reference.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'Could not record the payment.')
        return
      }
      toast.success(`Receipt ${String(body.receipt_number)} recorded.`)
      onOpenChange(false)
      onRecorded?.(body)
    } catch (e) {
      logError('customer-payment:submit', e)
      toast.error('Could not record the payment.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            {customerName} · outstanding {formatMoney(outstanding)}
            {Number(advance) > 0 ? ` · advance held ${formatMoney(Number(advance))}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="cp-amount">Amount received (₹)</Label>
            <div className="relative">
              <IndianRupee className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="cp-amount"
                className="pl-9"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            {suggestion > 0 ? (
              <button
                type="button"
                className="justify-self-start text-xs text-primary underline-offset-2 hover:underline"
                onClick={() => setAmount(String(suggestion))}
              >
                Full outstanding: {formatMoney(suggestion)}
              </button>
            ) : null}
          </div>
          <div className="grid gap-2">
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger aria-label="Payment method" className="w-full min-w-0">
                <SelectValue placeholder="Choose method" />
              </SelectTrigger>
              <SelectContent>
                {methods.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cp-ref">Reference (UPI / cheque no…)</Label>
            <Input id="cp-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cp-notes">Notes</Label>
            <Textarea id="cp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={300} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Recording…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
