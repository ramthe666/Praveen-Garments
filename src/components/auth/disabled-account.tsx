'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ShieldOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { logError } from '@/lib/errors'

/**
 * Rendered for authenticated users whose profile has been disabled.
 * Signs the session out and returns them to login with an explanation.
 */
export function DisabledAccount() {
  const router = useRouter()
  const [state, setState] = React.useState<'signing-out' | 'failed'>('signing-out')

  React.useEffect(() => {
    let cancelled = false
    async function signOutNow() {
      try {
        const supabase = createClient()
        const { error } = await supabase.auth.signOut()
        if (error) {
          logError('disabled-account:signout', error)
          if (!cancelled) setState('failed')
          return
        }
        if (!cancelled) {
          router.replace('/login?auth=disabled')
          router.refresh()
        }
      } catch (err) {
        logError('disabled-account:unexpected', err)
        if (!cancelled) setState('failed')
      }
    }
    void signOutNow()
    return () => {
      cancelled = true
    }
  }, [router])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive" aria-hidden="true">
        <ShieldOff className="size-7" />
      </span>
      <div>
        <h1 className="text-lg font-semibold text-foreground">Account disabled</h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {state === 'failed'
            ? 'Your account is disabled and automatic sign-out failed. Please clear your cookies and try again.'
            : 'Your account has been disabled. Signing you out…'}
        </p>
      </div>
      <a href="/login" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
        Back to sign in
      </a>
    </div>
  )
}
