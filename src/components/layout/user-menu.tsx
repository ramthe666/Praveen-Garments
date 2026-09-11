'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, KeyRound, LogOut, Settings, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useApp } from '@/components/providers/app-provider'
import { ROLE_LABELS } from '@/lib/auth/constants'
import { logError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

function initialsOf(name: string, email: string): string {
  const fromName = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  if (fromName) return fromName
  return email.slice(0, 2).toUpperCase()
}

/** Topbar user menu: identity, quick links, sign-out. */
export function UserMenu() {
  const router = useRouter()
  const { profile, userEmail, hasPermission } = useApp()
  const [signingOut, setSigningOut] = React.useState(false)

  const displayName = profile?.full_name?.trim() || userEmail.split('@')[0]
  const roleLabel = profile ? ROLE_LABELS[profile.role] : 'Account pending setup'

  async function handleSignOut() {
    setSigningOut(true)
    try {
      const supabase = createClient()
      // Audit the logout before the session goes away (best effort, logged).
      try {
        await supabase.rpc('log_auth_event', { p_action: 'logout' })
      } catch (auditError) {
        logError('signout:audit', auditError)
      }
      const { error } = await supabase.auth.signOut()
      if (error) {
        logError('signout', error)
        toast.error('Sign out failed', { description: 'Please try again.' })
        return
      }
      router.replace('/login?auth=signed-out')
      router.refresh()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-9 gap-2 px-1.5 sm:px-2"
          aria-label="Account menu"
          disabled={signingOut}
        >
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
          >
            {initialsOf(profile?.full_name ?? '', userEmail)}
          </span>
          <span className="hidden min-w-0 flex-col items-start leading-tight sm:flex">
            <span className="max-w-[9rem] truncate text-[13px] font-medium text-foreground">
              {displayName}
            </span>
            <span className="max-w-[9rem] truncate text-[11px] text-muted-foreground">
              {roleLabel}
            </span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="min-w-0">
          <p className="truncate text-sm font-medium">{displayName}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{userEmail}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/reset-password" className="cursor-pointer">
              <KeyRound className="size-4" aria-hidden="true" />
              Change password
            </Link>
          </DropdownMenuItem>
          {hasPermission('manage_settings') ? (
            <DropdownMenuItem asChild>
              <Link href="/settings" className="cursor-pointer">
                <Settings className="size-4" aria-hidden="true" />
                Settings
              </Link>
            </DropdownMenuItem>
          ) : null}
          {profile ? (
            <DropdownMenuItem disabled>
              <UserRound className="size-4" aria-hidden="true" />
              {roleLabel}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={(event) => {
            event.preventDefault()
            void handleSignOut()
          }}
          disabled={signingOut}
          className="cursor-pointer"
        >
          <LogOut className="size-4" aria-hidden="true" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
