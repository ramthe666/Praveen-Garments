'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { MoreHorizontal, Pencil, Plus, Power, Warehouse } from 'lucide-react'
import { useApp } from '@/components/providers/app-provider'
import { logError } from '@/lib/errors'
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
import { EmptyState } from '@/components/shared/empty-state'
import { TableSkeleton } from '@/components/shared/loading'
import { ActiveBadge } from '@/components/shared/status-badge'
import type { Branch, StockLocation } from '@/types/database'

/**
 * Radix Select forbids SelectItem value="" (it throws — empty string is reserved
 * for clearing the selection). The optional "no branch" choice uses this sentinel;
 * FormData handlers map it back to null.
 */
const NO_BRANCH_VALUE = '__none__'

/** Stock locations tab: stores + warehouses where balances are tracked. */
export function LocationsTab({
  locations,
  branches,
  loading,
  setupNeeded,
  onReload,
}: {
  locations: StockLocation[]
  branches: Branch[]
  loading: boolean
  setupNeeded: boolean
  onReload: () => void
}) {
  const { hasPermission } = useApp()
  const canManage = hasPermission('manage_inventory')
  const [createOpen, setCreateOpen] = React.useState(false)
  const [editTarget, setEditTarget] = React.useState<StockLocation | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function mutate(path: string, method: 'POST' | 'PATCH', body: Record<string, unknown>) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = (await res.json()) as { error?: string }
    return { ok: res.ok, error: payload.error }
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const code = String(form.get('code') ?? '').trim().toUpperCase()
    const type = String(form.get('location_type') ?? 'store')
    const branchId = String(form.get('branch_id') ?? '')
    const address = String(form.get('address') ?? '').trim()
    if (!name || !code) {
      toast.error('Name and code are required.')
      return
    }
    setBusy(true)
    try {
      const result = await mutate('/api/admin/locations', 'POST', {
        name,
        code,
        location_type: type,
        branch_id: branchId === NO_BRANCH_VALUE ? null : (branchId || null),
        address: address || null,
      })
      if (!result.ok) {
        toast.error('Could not create the location', { description: result.error ?? 'Please try again.' })
        return
      }
      toast.success('Location created', { description: `${name} (${code})` })
      setCreateOpen(false)
      onReload()
    } finally {
      setBusy(false)
    }
  }

  async function handleEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !editTarget) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const code = String(form.get('code') ?? '').trim().toUpperCase()
    const type = String(form.get('location_type') ?? editTarget.location_type)
    const branchId = String(form.get('branch_id') ?? '')
    const address = String(form.get('address') ?? '').trim()
    if (!name || !code) {
      toast.error('Name and code are required.')
      return
    }
    setBusy(true)
    try {
      const result = await mutate(`/api/admin/locations/${editTarget.id}`, 'PATCH', {
        name,
        code,
        location_type: type,
        branch_id: branchId === NO_BRANCH_VALUE ? null : (branchId || null),
        address: address || null,
      })
      if (!result.ok) {
        toast.error('Could not save the location', { description: result.error ?? 'Please try again.' })
        return
      }
      toast.success('Location saved')
      setEditTarget(null)
      onReload()
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(loc: StockLocation) {
    const result = await mutate(`/api/admin/locations/${loc.id}`, 'PATCH', { is_active: !loc.is_active })
    if (!result.ok) {
      toast.error('Could not update', { description: result.error ?? 'Please try again.' })
      return
    }
    toast.success(loc.is_active ? 'Location deactivated' : 'Location reactivated', {
      description: loc.is_active
        ? 'Existing balances and history are preserved; new movements must use other locations.'
        : `${loc.name} accepts stock again.`,
    })
    onReload()
  }

  const formFields = (loc?: StockLocation) => (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="loc-name">Name</Label>
          <Input id="loc-name" name="name" defaultValue={loc?.name ?? ''} required maxLength={120} placeholder="e.g. Main Store" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="loc-code">Code</Label>
          <Input id="loc-code" name="code" defaultValue={loc?.code ?? ''} required maxLength={10} placeholder="e.g. MAIN" className="uppercase" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="loc-type">Type</Label>
          <Select name="location_type" defaultValue={loc?.location_type ?? 'store'}>
            <SelectTrigger id="loc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="store">Store</SelectItem>
              <SelectItem value="warehouse">Warehouse</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="loc-branch">Linked branch (optional)</Label>
          <Select name="branch_id" defaultValue={loc?.branch_id ?? NO_BRANCH_VALUE}>
            <SelectTrigger id="loc-branch">
              <SelectValue placeholder="No branch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_BRANCH_VALUE}>No branch</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="loc-address">Address (optional)</Label>
        <Input id="loc-address" name="address" defaultValue={loc?.address ?? ''} maxLength={200} />
      </div>
    </>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Stores and warehouses where stock is tracked. Stock balances are per variant per location.
        </p>
        {canManage ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add location
          </Button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
        {loading ? (
          <TableSkeleton rows={Math.max(3, Math.min(locations.length, 8))} cols={5} />
        ) : setupNeeded ? null : locations.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={<Warehouse />} title="No locations yet" description="Create a store or warehouse to start tracking stock." />
          </div>
        ) : (
          <div className="thin-scrollbar overflow-x-auto">
            <Table className="min-w-[40rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Linked branch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((l) => (
                  <TableRow key={l.id} className={l.is_active ? undefined : 'opacity-60'}>
                    <TableCell className="font-medium">{l.name}</TableCell>
                    <TableCell className="font-mono text-xs">{l.code}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{l.location_type === 'warehouse' ? 'Warehouse' : 'Store'}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {branches.find((b) => b.id === l.branch_id)?.name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <ActiveBadge active={l.is_active} />
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" aria-label={`Actions for ${l.name}`}>
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditTarget(l)}>
                              <Pencil className="size-4" aria-hidden="true" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void toggleActive(l)}>
                              <Power className="size-4" aria-hidden="true" />
                              {l.is_active ? 'Deactivate' : 'Reactivate'}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add stock location</DialogTitle>
            <DialogDescription>A store or warehouse. The Main Store is created by the migration.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            {formFields()}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Create location
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit location</DialogTitle>
            <DialogDescription>Existing balances and history remain attached to this location.</DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <form onSubmit={handleEdit} className="space-y-4">
              {formFields(editTarget)}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
