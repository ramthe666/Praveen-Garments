'use client'

import * as React from 'react'
import { MailCheck, Send } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { logError, toUserMessage } from '@/lib/errors'

export function ForgotPasswordForm() {
  const [email, setEmail] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [sent, setSent] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!email.trim()) {
      setError('Enter your work email.')
      return
    }

    setSubmitting(true)
    try {
      const supabase = createClient()
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      })

      if (resetError) {
        logError('forgot-password', resetError)
        setError(toUserMessage(resetError, 'Could not send the reset email. Please try again.'))
        return
      }
      setSent(true)
    } catch (err) {
      logError('forgot-password:unexpected', err)
      setError('Could not send the reset email. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (sent) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm" role="status">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-success/10 text-success" aria-hidden="true">
            <MailCheck className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">Check your inbox</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              If <span className="font-medium text-foreground">{email}</span> belongs to a staff
              account, a password reset link is on its way. The link expires shortly — check spam
              if you can&apos;t find it.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {error ? (
        <div className="mb-4">
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            placeholder="you@praveengarments.com"
          />
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? (
            'Sending…'
          ) : (
            <>
              <Send className="size-4" aria-hidden="true" />
              Send reset link
            </>
          )}
        </Button>
      </form>
    </div>
  )
}
