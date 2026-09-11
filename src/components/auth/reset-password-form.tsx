'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { authErrorMessage, logError } from '@/lib/errors'

function scorePassword(pw: string): { ok: boolean; hint: string } {
  if (pw.length < 8) return { ok: false, hint: 'Use at least 8 characters.' }
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return { ok: false, hint: 'Mix letters and numbers.' }
  }
  return { ok: true, hint: 'Good password.' }
}

export function ResetPasswordForm() {
  const router = useRouter()
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const strength = scorePassword(password)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!strength.ok) {
      setError(strength.hint)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    try {
      const supabase = createClient()
      const { error: updateError } = await supabase.auth.updateUser({ password })

      if (updateError) {
        logError('reset-password', updateError)
        setError(authErrorMessage(updateError))
        return
      }

      toast.success('Password updated', {
        description: 'Sign in with your new password next time.',
      })
      router.replace('/dashboard')
      router.refresh()
    } catch (err) {
      logError('reset-password:unexpected', err)
      setError('Could not update the password. Please try again.')
    } finally {
      setSubmitting(false)
    }
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
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            aria-describedby="password-hint"
          />
          <p id="password-hint" className="text-xs text-muted-foreground" aria-live="polite">
            {strength.hint}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm-password">Confirm password</Label>
          <Input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={submitting}
            aria-invalid={confirm.length > 0 && confirm !== password}
          />
        </div>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? (
            'Updating…'
          ) : (
            <>
              <KeyRound className="size-4" aria-hidden="true" />
              Update password
            </>
          )}
        </Button>
      </form>
    </div>
  )
}
