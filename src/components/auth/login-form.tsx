'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff, LogIn, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { authErrorMessage, logError } from '@/lib/errors'

const AUTH_MESSAGES: Record<string, { title: string; description: string }> = {
  expired: {
    title: 'Session expired',
    description: 'Your session has expired. Please sign in again.',
  },
  'signin-required': {
    title: 'Sign in required',
    description: 'Please sign in to continue.',
  },
  disabled: {
    title: 'Account disabled',
    description: 'Your account has been disabled. Contact your administrator.',
  },
  'signed-out': {
    title: 'Signed out',
    description: 'You have been signed out successfully.',
  },
}

export function LoginForm({ companyName }: { companyName: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [showPassword, setShowPassword] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const authReason = searchParams.get('auth')
  const notice = authReason ? AUTH_MESSAGES[authReason] : null
  const nextPath = searchParams.get('next')

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }

    setSubmitting(true)
    try {
      const supabase = createClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

      if (signInError) {
        // Real auth failures are surfaced to the user — never swallowed.
        logError('login', signInError)
        setError(authErrorMessage(signInError))
        return
      }

      // Post-login bookkeeping (best effort; failures are logged, not fatal):
      try {
        await supabase.rpc('touch_my_last_login')
        await supabase.rpc('log_auth_event', { p_action: 'login' })
      } catch (auditError) {
        logError('login:post-login', auditError)
      }

      toast.success('Welcome back', { description: `Signed in to ${companyName}.` })

      // Only allow internal paths (no open redirects)
      const target =
        nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/dashboard'
      router.replace(target)
      router.refresh()
    } catch (err) {
      logError('login:unexpected', err)
      setError('Sign-in failed unexpectedly. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <h2 className="text-base font-semibold text-foreground">Sign in</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">Use your work email and password.</p>

      {notice ? (
        <div className="mt-4">
          <Alert variant={authReason === 'signed-out' ? 'default' : 'destructive'} role="status">
            <ShieldCheck className="size-4" aria-hidden="true" />
            <AlertDescription>
              <span className="font-medium">{notice.title}.</span> {notice.description}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4">
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
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
            aria-invalid={Boolean(error)}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="pr-10"
              aria-invalid={Boolean(error)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={0}
            >
              {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
            </button>
          </div>
        </div>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? (
            'Signing in…'
          ) : (
            <>
              <LogIn className="size-4" aria-hidden="true" />
              Sign in
            </>
          )}
        </Button>
      </form>
    </div>
  )
}
