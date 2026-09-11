'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { GitBranch, GitBranchPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { Branch } from '@/types/database'
import { createClient } from '@/lib/supabase/client'
import { logError, toUserMessage } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/shared/empty-state'
import { ErrorState } from '@/components/shared/error-state'
import { TableSkeleton } from '@/components/shared/loading'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

interface BranchForm {
  name: string
  code: string
  address: string
  city: string
  state: string
  pincode: string
  phone: string
  email: string
  is_active: boolean
}

const EMPTY_FORM: BranchForm = {
  name: '',
  code: '',
  address: '',
  city: '',
  state: '',
  pincode: '',
  phone: '',
  email: '',
  is_active: true,
}

function formFromBranch(b: Branch): BranchForm {
  return {
    name: b.name,
    code: b.code,
    address: b.address ?? '',
    city: b.city ?? '',
    state: b.state ?? '',
    pincode: b.pincode ?? '',
    phone: b.phone ?? '',
    email: b.email ?? '',
    is_active: b.is_active,
  }
}

/**
 * Branch management — foundation for future multi-store operations.
 * Writes go directly through the browser client; RLS restricts them to
 * manage_settings (Admin) and DB triggers record the audit trail.
 */
export function BranchesTab() {
  const supabase = React.useMemo(() => createClient(), [])
  const [branches, setBranches] = React.useState<Branch[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<BranchForm>(EMPTY_FORM)
  const [busy, setBusy] = React.useState(false)

  const [deleteTarget, setDeleteTarget] = React.useState<Branch | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: queryError } = await supabase
        .from('branches')
        .select('*')
        .order('created_at', { ascending: true })
      if (queryError) {
        logError('branches:load', queryError)
        setError(toUserMessage(queryError))
        return
      }
      setBranches((data as Branch[]) ?? [])
    } catch (err) {
      logError('branches:load:unexpected', err)
      setError('Could not load branches. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [supabase])

  React.useEffect(() => {
    void load()
  }, [load])

  const set = <K extends keyof BranchForm>(key: K, value: BranchForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  function openEdit(b: Branch) {
    setEditingId(b.id)
    setForm(formFromBranch(b))
    setDialogOpen(true)
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!form.name.trim() || !form.code.trim()) {
      toast.error('Branch name and code are required.')
      return
    }
    if (form.pincode && !/^[1-9][0-9]{5}$/.test(form.pincode)) {
      toast.error('Invalid pincode', { description: 'Indian pincodes are 6 digits.' })
      return
    }

    setBusy(true)
    try {
      const payload = {
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        pincode: form.pincode.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        is_active: form.is_active,
      }

      const { error: writeError } = editingId
        ? await supabase.from('branches').update(payload).eq('id', editingId)
        : await supabase.from('branches').insert(payload)

      if (writeError) {
        logError('branches:save', writeError)
        toast.error('Could not save branch', { description: toUserMessage(writeError) })
        return
      }
      toast.success(editingId ? 'Branch updated' : 'Branch created', {
        description: `${payload.name} (${payload.code}).`,
      })
      setDialogOpen(false)
      await load()
    } catch (err) {
      logError('branches:save:unexpected', err)
      toast.error('Could not save branch', { description: 'Please try again.' })
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleteBusy) return
    setDeleteBusy(true)
    try {
      const { error: deleteError } = await supabase
        .from('branches')
        .delete()
        .eq('id', deleteTarget.id)
      if (deleteError) {
        logError('branches:delete', deleteError)
        toast.error('Could not delete branch', { description: toUserMessage(deleteError) })
        return
      }
      toast.success('Branch deleted', { description: `${deleteTarget.name} was removed.` })
      setDeleteTarget(null)
      await load()
    } catch (err) {
      logError('branches:delete:unexpected', err)
      toast.error('Could not delete branch', { description: 'Please try again.' })
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleToggleActive(b: Branch) {
    try {
      const { error } = await supabase
        .from('branches')
        .update({ is_active: !b.is_active })
        .eq('id', b.id)
      if (error) {
        logError('branches:toggle', error)
        toast.error('Could not update branch', { description: toUserMessage(error) })
        return
      }
      toast.success(!b.is_active ? 'Branch activated' : 'Branch deactivated')
      await load()
    } catch (err) {
      logError('branches:toggle:unexpected', err)
      toast.error('Could not update branch', { description: 'Please try again.' })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="size-4.5 text-primary" aria-hidden="true" />
          Branches
        </CardTitle>
        <CardDescription>
          Stores/locations for this business. One store works fine today — add more when you expand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-end">
          <Button size="sm" onClick={openCreate}>
            <GitBranchPlus className="size-4" aria-hidden="true" />
            Add branch
          </Button>
        </div>

        {loading ? (
          <TableSkeleton rows={3} cols={4} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : branches.length === 0 ? (
          <EmptyState
            icon={<GitBranchPlus />}
            title="No branches yet"
            description="Add your main store so sales, stock and reports can be tracked per location later."
          />
        ) : (
          <div className="thin-scrollbar overflow-x-auto rounded-md border">
            <Table className="min-w-[40rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {branches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <p className="font-medium text-foreground">{b.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{b.code}</p>
                    </TableCell>
                    <TableCell className="max-w-[16rem] text-[13px] text-muted-foreground">
                      {[b.city, b.state, b.pincode].filter(Boolean).join(', ') || '—'}
                    </TableCell>
                    <TableCell className="max-w-[14rem] text-[13px] text-muted-foreground">
                      <p>{b.phone || '—'}</p>
                      <p className="truncate">{b.email || ''}</p>
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => void handleToggleActive(b)}
                        className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-md"
                        aria-label={b.is_active ? `Deactivate ${b.name}` : `Activate ${b.name}`}
                      >
                        {b.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                      </button>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${b.name}`}>
                            <MoreHorizontal className="size-4" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onSelect={() => openEdit(b)} className="cursor-pointer">
                            <Pencil className="size-4" aria-hidden="true" />
                            Edit branch
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeleteTarget(b)}
                            className="cursor-pointer"
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* ---- Create / edit dialog ---- */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !busy && setDialogOpen(open)}>
        <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit branch' : 'Add a branch'}</DialogTitle>
            <DialogDescription>
              Short codes appear on invoices and stock labels (e.g. MYS for Mysuru store).
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="b-name">Branch name</Label>
                <Input
                  id="b-name"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="e.g. Main Store — Mysuru"
                  required
                  maxLength={120}
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="b-code">Branch code</Label>
                <Input
                  id="b-code"
                  value={form.code}
                  onChange={(e) => set('code', e.target.value.toUpperCase())}
                  placeholder="MYS"
                  required
                  maxLength={10}
                  className="font-mono"
                  disabled={busy || Boolean(editingId)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="b-phone">Phone</Label>
                <Input
                  id="b-phone"
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set('phone', e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="b-address">Address</Label>
                <Input
                  id="b-address"
                  value={form.address}
                  onChange={(e) => set('address', e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="b-city">City</Label>
                <Input id="b-city" value={form.city} onChange={(e) => set('city', e.target.value)} disabled={busy} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="b-state">State</Label>
                <Input id="b-state" value={form.state} onChange={(e) => set('state', e.target.value)} disabled={busy} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="b-pincode">Pincode</Label>
                <Input
                  id="b-pincode"
                  inputMode="numeric"
                  maxLength={6}
                  value={form.pincode}
                  onChange={(e) => set('pincode', e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="b-email">Email</Label>
                <Input
                  id="b-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md border p-3.5 sm:col-span-2">
                <Label htmlFor="b-active" className="text-[13.5px] font-medium">
                  Active
                </Label>
                <Switch
                  id="b-active"
                  checked={form.is_active}
                  onCheckedChange={(v) => set('is_active', v)}
                  disabled={busy}
                />
              </div>
            </div>
            <DialogFooter className="gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : editingId ? 'Save changes' : 'Create branch'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !deleteBusy && !open && setDeleteTarget(null)}
        title="Delete this branch?"
        description={`${deleteTarget?.name} will be removed. Users assigned to it become unassigned. Stock and sales history are preserved (future modules keep their records).`}
        confirmLabel="Delete branch"
        destructive
        requirePhrase="DELETE"
        onConfirm={handleDelete}
      />
    </Card>
  )
}
