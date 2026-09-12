'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  Ban,
  CheckCircle2,
  KeyRound,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { AppPermission, Branch, Profile, UserRole } from '@/types/database'
import { ROLE_LABELS, ROLE_ORDER } from '@/lib/auth/constants'
import { isTableMissing, logError, toUserMessage } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { ErrorState } from '@/components/shared/error-state'
import { TableSkeleton } from '@/components/shared/loading'
import { DataTablePagination } from '@/components/shared/data-table-pagination'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

const PAGE_SIZE = 10

const ROLE_BADGE_CLASS: Record<UserRole, string> = {
  admin: 'bg-primary/10 text-primary border-primary/20',
  manager: 'bg-chart-2/10 text-chart-2 border-chart-2/20',
  cashier: 'bg-chart-3/10 text-chart-3 border-chart-3/20',
  inventory_manager: 'bg-chart-4/15 text-chart-4 border-chart-4/20',
  purchase_manager: 'bg-chart-5/15 text-chart-5 border-chart-5/20',
  accountant: 'bg-muted text-secondary-foreground border-border',
}

function RoleBadge({ role }: { role: UserRole }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${ROLE_BADGE_CLASS[role]}`}
    >
      {ROLE_LABELS[role]}
    </span>
  )
}

function initials(name: string, email: string): string {
  const fromName = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  return fromName || email.slice(0, 2).toUpperCase()
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

type CreateForm = {
  full_name: string
  email: string
  password: string
  role: UserRole
  phone: string
}

type EditForm = {
  full_name: string
  role: UserRole
  phone: string
  branch_id: string
  pos_discount_limit_pct: string
}

export function UsersView({ currentUserId }: { currentUserId: string }) {
  const supabase = React.useMemo(() => createClient(), [])

  const [rows, setRows] = React.useState<Profile[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [search, setSearch] = React.useState('')
  const [debouncedSearch, setDebouncedSearch] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [branches, setBranches] = React.useState<Branch[]>([])

  // dialog state
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createForm, setCreateForm] = React.useState<CreateForm>({
    full_name: '',
    email: '',
    password: '',
    role: 'cashier',
    phone: '',
  })
  const [createBusy, setCreateBusy] = React.useState(false)

  const [editTarget, setEditTarget] = React.useState<Profile | null>(null)
  const [editForm, setEditForm] = React.useState<EditForm | null>(null)
  const [editBusy, setEditBusy] = React.useState(false)

  const [statusTarget, setStatusTarget] = React.useState<Profile | null>(null)
  const [statusBusy, setStatusBusy] = React.useState(false)

  const [deleteTarget, setDeleteTarget] = React.useState<Profile | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const [pwTarget, setPwTarget] = React.useState<Profile | null>(null)
  const [pwMode, setPwMode] = React.useState<'email' | 'password'>('email')
  const [pwValue, setPwValue] = React.useState('')
  const [pwBusy, setPwBusy] = React.useState(false)

  // debounce search input
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(t)
  }, [search])

  // load page of profiles (server-side filtering + pagination; RLS-scoped)
  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let query = supabase
        .from('profiles')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })

      if (debouncedSearch) {
        const sanitized = debouncedSearch.replace(/[%,]/g, '')
        if (sanitized) {
          query = query.or(`full_name.ilike.%${sanitized}%,email.ilike.%${sanitized}%`)
        }
      }

      const from = (page - 1) * PAGE_SIZE
      const { data, error: queryError, count } = await query.range(from, from + PAGE_SIZE - 1)

      if (queryError) {
        logError('users:load', queryError)
        setError(toUserMessage(queryError))
        return
      }
      setRows((data as Profile[]) ?? [])
      setTotal(count ?? 0)
    } catch (err) {
      logError('users:load:unexpected', err)
      setError('Could not load users. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [supabase, page, debouncedSearch])

  React.useEffect(() => {
    void load()
  }, [load])

  // branches for the edit dialog (all staff can read branches)
  React.useEffect(() => {
    let cancelled = false
    supabase
      .from('branches')
      .select('*')
      .eq('is_active', true)
      .order('name')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          if (!isTableMissing(error)) logError('users:branches', error)
          return
        }
        setBranches((data as Branch[]) ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [supabase])

  // ---------- handlers ----------

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    if (createBusy) return
    if (!createForm.full_name.trim() || !createForm.email.trim() || createForm.password.length < 8) {
      toast.error('Check the form', { description: 'Name, email and an 8+ character password are required.' })
      return
    }
    setCreateBusy(true)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: createForm.full_name.trim(),
          email: createForm.email.trim(),
          password: createForm.password,
          role: createForm.role,
          phone: createForm.phone.trim() || undefined,
        }),
      })
      const payload = (await res.json()) as { error?: string; warning?: string }
      if (!res.ok) {
        toast.error('Could not create user', { description: payload.error ?? 'Please try again.' })
        return
      }
      if (payload.warning) {
        toast.warning('Account created with a warning', { description: payload.warning })
      } else {
        toast.success('User created', {
          description: `${createForm.full_name.trim()} can now sign in with the password you set.`,
        })
      }
      setCreateOpen(false)
      setCreateForm({ full_name: '', email: '', password: '', role: 'cashier', phone: '' })
      await load()
    } catch (err) {
      logError('users:create', err)
      toast.error('Could not create user', { description: 'Network error. Please try again.' })
    } finally {
      setCreateBusy(false)
    }
  }

  async function handleEditSave(event: React.FormEvent) {
    event.preventDefault()
    if (!editTarget || !editForm || editBusy) return
    setEditBusy(true)
    try {
      const res = await fetch(`/api/admin/users/${editTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: editForm.full_name.trim(),
          role: editForm.role,
          phone: editForm.phone.trim() || null,
          branch_id: editForm.branch_id || null,
          pos_discount_limit_pct:
            editForm.pos_discount_limit_pct.trim() === ''
              ? null
              : Math.min(100, Math.max(0, Number(editForm.pos_discount_limit_pct))),
        }),
      })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error('Could not save changes', { description: payload.error ?? 'Please try again.' })
        return
      }
      toast.success('User updated', { description: `${editForm.full_name.trim()}'s details were saved.` })
      setEditTarget(null)
      setEditForm(null)
      await load()
    } catch (err) {
      logError('users:edit', err)
      toast.error('Could not save changes', { description: 'Network error. Please try again.' })
    } finally {
      setEditBusy(false)
    }
  }

  async function handleToggleStatus() {
    if (!statusTarget || statusBusy) return
    setStatusBusy(true)
    try {
      const nextActive = !statusTarget.is_active
      const res = await fetch(`/api/admin/users/${statusTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: nextActive }),
      })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error('Could not update status', { description: payload.error ?? 'Please try again.' })
        return
      }
      toast.success(nextActive ? 'User enabled' : 'User disabled', {
        description: nextActive
          ? `${statusTarget.full_name || statusTarget.email} can sign in again.`
          : `${statusTarget.full_name || statusTarget.email} will be signed out and blocked.`,
      })
      setStatusTarget(null)
      await load()
    } catch (err) {
      logError('users:status', err)
      toast.error('Could not update status', { description: 'Network error. Please try again.' })
    } finally {
      setStatusBusy(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleteBusy) return
    setDeleteBusy(true)
    try {
      const res = await fetch(`/api/admin/users/${deleteTarget.id}`, { method: 'DELETE' })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error('Could not delete user', { description: payload.error ?? 'Please try again.' })
        return
      }
      toast.success('User deleted', {
        description: `${deleteTarget.full_name || deleteTarget.email} was removed permanently.`,
      })
      setDeleteTarget(null)
      await load()
    } catch (err) {
      logError('users:delete', err)
      toast.error('Could not delete user', { description: 'Network error. Please try again.' })
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handlePasswordReset() {
    if (!pwTarget || pwBusy) return
    setPwBusy(true)
    try {
      if (pwMode === 'password' && pwValue.length < 8) {
        toast.error('Password too short', { description: 'Use at least 8 characters.' })
        return
      }
      const res = await fetch(`/api/admin/users/${pwTarget.id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: pwMode, password: pwMode === 'password' ? pwValue : undefined }),
      })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error('Could not reset password', { description: payload.error ?? 'Please try again.' })
        return
      }
      toast.success(pwMode === 'email' ? 'Reset email sent' : 'Password updated', {
        description:
          pwMode === 'email'
            ? `A reset link was emailed to ${pwTarget.email}.`
            : `A new password was set for ${pwTarget.email}.`,
      })
      setPwTarget(null)
      setPwValue('')
    } catch (err) {
      logError('users:password', err)
      toast.error('Could not reset password', { description: 'Network error. Please try again.' })
    } finally {
      setPwBusy(false)
    }
  }

  // ---------- render ----------

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Create staff accounts, assign roles and manage access."
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <UserPlus className="size-4" aria-hidden="true" />
            Add user
          </Button>
        }
      />

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email…"
          className="pl-9"
          aria-label="Search users"
          type="search"
        />
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
        {loading ? (
          <TableSkeleton rows={Math.min(PAGE_SIZE, Math.max(3, total || 5))} cols={6} />
        ) : error ? (
          <div className="p-6">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<UserPlus />}
              title={debouncedSearch ? 'No matching users' : 'No users yet'}
              description={
                debouncedSearch
                  ? 'Try a different name or email.'
                  : 'Create the first staff account to get started.'
              }
              action={
                debouncedSearch ? (
                  <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="size-4" aria-hidden="true" />
                    Add user
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <>
            <div className="thin-scrollbar overflow-x-auto">
              <Table className="min-w-[52rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last sign-in</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead className="w-12 text-right"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="max-w-[20rem]">
                        <div className="flex items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
                          >
                            {initials(p.full_name, p.email)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {p.full_name || '(No name)'}
                              {p.id === currentUserId ? (
                                <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                              ) : null}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{p.email}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <RoleBadge role={p.role} />
                      </TableCell>
                      <TableCell>
                        {p.is_active ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="destructive">Disabled</Badge>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-[13px] text-muted-foreground">
                        {formatDateTime(p.last_login_at)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-[13px] text-muted-foreground">
                        {formatDateTime(p.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${p.full_name || p.email}`}>
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuLabel className="text-xs text-muted-foreground">
                              {p.email}
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => {
                                setEditTarget(p)
                                setEditForm({
                                  full_name: p.full_name ?? '',
                                  role: p.role,
                                  phone: p.phone ?? '',
                                  branch_id: p.branch_id ?? '',
                                  pos_discount_limit_pct: p.pos_discount_limit_pct != null ? String(p.pos_discount_limit_pct) : '',
                                })
                              }}
                              className="cursor-pointer"
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                              Edit details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                setPwTarget(p)
                                setPwMode('email')
                                setPwValue('')
                              }}
                              className="cursor-pointer"
                            >
                              <Mail className="size-4" aria-hidden="true" />
                              Send reset email
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                setPwTarget(p)
                                setPwMode('password')
                                setPwValue('')
                              }}
                              className="cursor-pointer"
                            >
                              <KeyRound className="size-4" aria-hidden="true" />
                              Set new password
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {p.id !== currentUserId ? (
                              <>
                                <DropdownMenuItem
                                  onSelect={() => setStatusTarget(p)}
                                  className="cursor-pointer"
                                >
                                  {p.is_active ? (
                                    <>
                                      <Ban className="size-4" aria-hidden="true" />
                                      Disable user
                                    </>
                                  ) : (
                                    <>
                                      <CheckCircle2 className="size-4" aria-hidden="true" />
                                      Enable user
                                    </>
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => setDeleteTarget(p)}
                                  className="cursor-pointer"
                                >
                                  <Trash2 className="size-4" aria-hidden="true" />
                                  Delete user
                                </DropdownMenuItem>
                              </>
                            ) : (
                              <DropdownMenuItem disabled>
                                <ShieldCheck className="size-4" aria-hidden="true" />
                                Current account
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="border-t p-3">
              <DataTablePagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </div>
          </>
        )}
      </div>

      {/* ---------- Create dialog ---------- */}
      <Dialog open={createOpen} onOpenChange={(open) => !createBusy && setCreateOpen(open)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="size-4.5 text-primary" aria-hidden="true" />
              Add a staff user
            </DialogTitle>
            <DialogDescription>
              The account is created active and email-confirmed. Share the password securely — the
              staff member can change it after signing in.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cu-name">Full name</Label>
              <Input
                id="cu-name"
                value={createForm.full_name}
                onChange={(e) => setCreateForm((f) => ({ ...f, full_name: e.target.value }))}
                placeholder="e.g. Ramesh Kumar"
                required
                maxLength={120}
                disabled={createBusy}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cu-email">Email</Label>
              <Input
                id="cu-email"
                type="email"
                inputMode="email"
                spellCheck={false}
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="ramesh@praveengarments.com"
                required
                disabled={createBusy}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="cu-password">Initial password</Label>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setCreateForm((f) => ({ ...f, password: generatePassword() }))}
                  disabled={createBusy}
                >
                  Generate
                </Button>
              </div>
              <Input
                id="cu-password"
                type="text"
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Minimum 8 characters"
                required
                minLength={8}
                disabled={createBusy}
                autoComplete="off"
                className="font-mono text-[13px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cu-role">Role</Label>
              <Select
                value={createForm.role}
                onValueChange={(value) => setCreateForm((f) => ({ ...f, role: value as UserRole }))}
                disabled={createBusy}
              >
                <SelectTrigger id="cu-role" className="w-full">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_ORDER.map((role) => (
                    <SelectItem key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cu-phone">Phone (optional)</Label>
              <Input
                id="cu-phone"
                type="tel"
                value={createForm.phone}
                onChange={(e) => setCreateForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="+91 98xxxxxx21"
                disabled={createBusy}
              />
            </div>
            <DialogFooter className="gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={createBusy}>
                Cancel
              </Button>
              <Button type="submit" disabled={createBusy}>
                {createBusy ? 'Creating…' : 'Create user'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- Edit dialog ---------- */}
      <Dialog open={Boolean(editTarget && editForm)} onOpenChange={(open) => !editBusy && !open && (setEditTarget(null), setEditForm(null))}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="size-4.5 text-primary" aria-hidden="true" />
              Edit user
            </DialogTitle>
            <DialogDescription>{editTarget?.email}</DialogDescription>
          </DialogHeader>
          {editForm ? (
            <form onSubmit={handleEditSave} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ed-name">Full name</Label>
                <Input
                  id="ed-name"
                  value={editForm.full_name}
                  onChange={(e) => setEditForm((f) => (f ? { ...f, full_name: e.target.value } : f))}
                  required
                  maxLength={120}
                  disabled={editBusy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ed-role">Role</Label>
                <Select
                  value={editForm.role}
                  onValueChange={(value) => setEditForm((f) => (f ? { ...f, role: value as UserRole } : f))}
                  disabled={editBusy}
                >
                  <SelectTrigger id="ed-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_ORDER.map((role) => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ed-phone">Phone</Label>
                <Input
                  id="ed-phone"
                  type="tel"
                  value={editForm.phone}
                  onChange={(e) => setEditForm((f) => (f ? { ...f, phone: e.target.value } : f))}
                  disabled={editBusy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ed-branch">Branch</Label>
                <Select
                  value={editForm.branch_id || 'none'}
                  onValueChange={(value) => setEditForm((f) => (f ? { ...f, branch_id: value === 'none' ? '' : value } : f))}
                  disabled={editBusy || branches.length === 0}
                >
                  <SelectTrigger id="ed-branch" className="w-full">
                    <SelectValue placeholder={branches.length === 0 ? 'No branches yet' : 'Unassigned'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name} ({b.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ed-pos-limit">POS discount limit (%)</Label>
                <Input
                  id="ed-pos-limit"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  inputMode="decimal"
                  value={editForm.pos_discount_limit_pct}
                  onChange={(e) => setEditForm((f) => (f ? { ...f, pos_discount_limit_pct: e.target.value } : f))}
                  disabled={editBusy}
                  placeholder="Role default (no personal limit)"
                  aria-describedby="ed-pos-limit-help"
                />
                <p id="ed-pos-limit-help" className="text-xs text-muted-foreground">
                  Caps this employee's discounts at the POS. Leave empty to use the role/store default. Admins are unlimited.
                </p>
              </div>
              <DialogFooter className="gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => (setEditTarget(null), setEditForm(null))} disabled={editBusy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={editBusy}>
                  {editBusy ? 'Saving…' : 'Save changes'}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ---------- Password reset dialog ---------- */}
      <Dialog open={Boolean(pwTarget)} onOpenChange={(open) => !pwBusy && !open && setPwTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="size-4.5 text-primary" aria-hidden="true" />
              Reset password
            </DialogTitle>
            <DialogDescription>{pwTarget?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Reset method">
              <Button
                type="button"
                variant={pwMode === 'email' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPwMode('email')}
                disabled={pwBusy}
              >
                <Mail className="size-4" aria-hidden="true" />
                Email link
              </Button>
              <Button
                type="button"
                variant={pwMode === 'password' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPwMode('password')}
                disabled={pwBusy}
              >
                <KeyRound className="size-4" aria-hidden="true" />
                Set new
              </Button>
            </div>
            {pwMode === 'email' ? (
              <p className="text-sm text-muted-foreground">
                Sends a password-reset link to the staff member&apos;s email. Requires SMTP to be
                configured on Supabase.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="pw-new">New password</Label>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setPwValue(generatePassword())}
                    disabled={pwBusy}
                  >
                    Generate
                  </Button>
                </div>
                <Input
                  id="pw-new"
                  type="text"
                  value={pwValue}
                  onChange={(e) => setPwValue(e.target.value)}
                  minLength={8}
                  disabled={pwBusy}
                  autoComplete="off"
                  className="font-mono text-[13px]"
                />
              </div>
            )}
            <DialogFooter className="gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => setPwTarget(null)} disabled={pwBusy}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handlePasswordReset()} disabled={pwBusy}>
                {pwBusy ? 'Working…' : pwMode === 'email' ? 'Send email' : 'Set password'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* ---------- Status confirm ---------- */}
      <ConfirmDialog
        open={Boolean(statusTarget)}
        onOpenChange={(open) => !statusBusy && !open && setStatusTarget(null)}
        title={statusTarget?.is_active ? 'Disable this user?' : 'Enable this user?'}
        description={
          statusTarget?.is_active
            ? `${statusTarget?.full_name || statusTarget?.email} will be signed out immediately and will not be able to sign in until re-enabled. Their data is kept.`
            : `${statusTarget?.full_name || statusTarget?.email} will be able to sign in again with their existing password.`
        }
        confirmLabel={statusTarget?.is_active ? 'Disable user' : 'Enable user'}
        destructive={statusTarget?.is_active ?? false}
        onConfirm={handleToggleStatus}
      />

      {/* ---------- Delete confirm (typed) ---------- */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !deleteBusy && !open && setDeleteTarget(null)}
        title="Delete this user?"
        description={`${deleteTarget?.full_name || deleteTarget?.email} will be removed permanently along with their profile. Audit history mentioning them is preserved. This cannot be undone.`}
        confirmLabel="Delete permanently"
        destructive
        requirePhrase="DELETE"
        onConfirm={handleDelete}
      />
    </div>
  )
}
