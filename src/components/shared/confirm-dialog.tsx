'use client'

import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /** when true, requires typing the given word to enable the confirm button */
  requirePhrase?: string
  onConfirm: () => void | Promise<void>
}

/**
 * Accessible confirmation dialog for destructive or consequential actions.
 * Optional typed-confirmation mode for irreversible operations (e.g. deletes).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  requirePhrase,
  onConfirm,
}: ConfirmDialogProps) {
  const [phrase, setPhrase] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setPhrase('')
      setBusy(false)
    }
  }, [open])

  const phraseOk = !requirePhrase || phrase.trim().toLowerCase() === requirePhrase.toLowerCase()

  async function handleConfirm() {
    try {
      setBusy(true)
      await onConfirm()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            {destructive ? (
              <span
                className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
                aria-hidden="true"
              >
                <AlertTriangle className="size-5" />
              </span>
            ) : null}
            <div className="min-w-0">
              <AlertDialogTitle className={cn(destructive && 'text-destructive')}>{title}</AlertDialogTitle>
              <AlertDialogDescription>{description}</AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        {requirePhrase ? (
          <div className="space-y-1.5">
            <label htmlFor="confirm-phrase" className="text-sm font-medium text-foreground">
              Type <span className="font-semibold text-destructive">{requirePhrase}</span> to confirm
            </label>
            <input
              id="confirm-phrase"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={requirePhrase}
            />
          </div>
        ) : null}

        <AlertDialogFooter className="gap-2 sm:gap-0">
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!phraseOk || busy}
            className={cn(
              buttonVariants({ variant: destructive ? 'destructive' : 'default' }),
              'font-medium'
            )}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
