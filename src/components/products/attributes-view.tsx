'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { MoreHorizontal, Pencil, Plus, Power } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useApp } from '@/components/providers/app-provider'
import { isTableMissing, logError } from '@/lib/errors'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { Phase2SetupNotice } from '@/components/shared/phase2-setup-notice'
import { ActiveBadge } from '@/components/shared/status-badge'
import { Combobox } from '@/components/shared/combobox'
import { useDebounced } from '@/lib/catalog/constants'
import type { Brand, Category, Color, Size } from '@/types/database'

type Entity = 'categories' | 'brands' | 'sizes' | 'colors'

interface EditState {
  entity: Entity
  id: string
  name: string
  description: string
  parent_id: string
  hex_code: string
  sort_order: string
  is_active: boolean
}

async function mutate(path: string, method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await res.json()) as { error?: string }
  return { ok: res.ok, error: payload.error }
}

export function AttributesView() {
  const supabase = React.useMemo(() => createClient(), [])
  const { hasPermission } = useApp()
  const canManage = hasPermission('manage_products')

  const [categories, setCategories] = React.useState<Category[]>([])
  const [brands, setBrands] = React.useState<Brand[]>([])
  const [sizes, setSizes] = React.useState<Size[]>([])
  const [colors, setColors] = React.useState<Color[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebounced(search)

  const [createOpen, setCreateOpen] = React.useState(false)
  const [createEntity, setCreateEntity] = React.useState<Entity>('categories')
  const [editState, setEditState] = React.useState<EditState | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const results = await Promise.all([
        supabase.from('categories').select('*').order('name'),
        supabase.from('brands').select('*').order('name'),
        supabase.from('sizes').select('*').order('sort_order'),
        supabase.from('colors').select('*').order('name'),
      ])
      let missing = false
      for (const r of results) {
        if (r.error) {
          if (isTableMissing(r.error)) missing = true
          else logError('attributes:load', r.error)
        }
      }
      if (missing) {
        setSetupNeeded(true)
        return
      }
      setCategories((results[0].data as Category[]) ?? [])
      setBrands((results[1].data as Brand[]) ?? [])
      setSizes((results[2].data as Size[]) ?? [])
      setColors((results[3].data as Color[]) ?? [])
    } catch (err) {
      logError('attributes:load:unexpected', err)
      setError('Could not load attributes. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [supabase])

  React.useEffect(() => {
    void load()
  }, [load])

  const q = debouncedSearch.trim().toLowerCase()
  const filter = <T extends { name: string }>(rows: T[]): T[] =>
    q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows

  const visibleCategories = filter(categories)
  const visibleBrands = filter(brands)
  const visibleSizes = filter(sizes)
  const visibleColors = filter(colors)

  const topCategories = categories.filter((c) => !c.parent_id)
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !createOpen) return
    const name = (document.getElementById('attr-create-name') as HTMLInputElement)?.value?.trim()
    if (!name) {
      toast.error('Enter a name.')
      return
    }
    setBusy(true)
    try {
      const body: Record<string, unknown> = { name }
      if (createEntity === 'categories') {
        const parentId = (document.getElementById('attr-create-parent') as HTMLInputElement)?.value
        body.parent_id = parentId || null
        const desc = (document.getElementById('attr-create-desc') as HTMLInputElement)?.value?.trim()
        body.description = desc || null
      } else if (createEntity === 'brands') {
        const desc = (document.getElementById('attr-create-desc') as HTMLInputElement)?.value?.trim()
        body.description = desc || null
      } else if (createEntity === 'sizes') {
        const sort = Number((document.getElementById('attr-create-sort') as HTMLInputElement)?.value)
        body.sort_order = Number.isInteger(sort) && sort >= 0 ? sort : 100
      } else if (createEntity === 'colors') {
        const hex = (document.getElementById('attr-create-hex') as HTMLInputElement)?.value?.trim()
        body.hex_code = hex || null
      }
      const result = await mutate(`/api/admin/${createEntity}`, 'POST', body)
      if (!result.ok) {
        toast.error('Could not create', { description: result.error ?? 'Please try again.' })
        return
      }
      toast.success('Created', { description: `${name} was added.` })
      setCreateOpen(false)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveEdit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !editState) return
    if (!editState.name.trim()) {
      toast.error('Enter a name.')
      return
    }
    setBusy(true)
    try {
      const body: Record<string, unknown> = { name: editState.name.trim() }
      if (editState.entity === 'categories') {
        body.parent_id = editState.parent_id || null
        body.description = editState.description.trim() || null
      } else if (editState.entity === 'brands') {
        body.description = editState.description.trim() || null
      } else if (editState.entity === 'sizes') {
        const sort = Number(editState.sort_order)
        body.sort_order = Number.isInteger(sort) && sort >= 0 ? sort : 0
      } else if (editState.entity === 'colors') {
        body.hex_code = editState.hex_code.trim() || null
      }
      const result = await mutate(`/api/admin/${editState.entity}/${editState.id}`, 'PATCH', body)
      if (!result.ok) {
        toast.error('Could not save', { description: result.error ?? 'Please try again.' })
        return
      }
      toast.success('Saved', { description: `${editState.name.trim()} was updated.` })
      setEditState(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(entity: Entity, id: string, currentlyActive: boolean, name: string) {
    const result = await mutate(`/api/admin/${entity}/${id}`, 'PATCH', { is_active: !currentlyActive })
    if (!result.ok) {
      toast.error('Could not update', { description: result.error ?? 'Please try again.' })
      return
    }
    toast.success(currentlyActive ? 'Deactivated' : 'Reactivated', {
      description: `${name} is ${currentlyActive ? 'hidden from new selections' : 'available again'}. Existing records stay valid.`,
    })
    await load()
  }

  const rowActions = (entity: Entity, row: { id: string; name: string; is_active: boolean }) =>
    canManage ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Actions for ${row.name}`}>
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() =>
              setEditState({
                entity,
                id: row.id,
                name: row.name,
                description: (row as { description?: string }).description ?? '',
                parent_id: (row as { parent_id?: string }).parent_id ?? '',
                hex_code: (row as { hex_code?: string }).hex_code ?? '',
                sort_order: String((row as { sort_order?: number }).sort_order ?? 0),
                is_active: row.is_active,
              })
            }
          >
            <Pencil className="size-4" aria-hidden="true" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void toggleActive(entity, row.id, row.is_active, row.name)}>
            <Power className="size-4" aria-hidden="true" />
            {row.is_active ? 'Deactivate' : 'Reactivate'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catalog attributes"
        description="Categories with subcategories, brands, sizes and colors — configurable, never hardcoded."
        actions={
          canManage ? (
            <Button
              size="sm"
              onClick={() => {
                setCreateEntity('categories')
                setCreateOpen(true)
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add attribute
            </Button>
          ) : null
        }
      />

      {setupNeeded ? <Phase2SetupNotice /> : null}

      <div className="relative max-w-sm">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name…"
          type="search"
          aria-label="Filter attributes"
        />
      </div>

      <Tabs defaultValue="categories">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="categories">Categories ({visibleCategories.length})</TabsTrigger>
          <TabsTrigger value="brands">Brands ({visibleBrands.length})</TabsTrigger>
          <TabsTrigger value="sizes">Sizes ({visibleSizes.length})</TabsTrigger>
          <TabsTrigger value="colors">Colors ({visibleColors.length})</TabsTrigger>
        </TabsList>

        {error ? (
          <div className="mt-4 rounded-lg border bg-card p-6">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        ) : null}

        {loading ? (
          <div className="mt-4 rounded-lg border bg-card">
            <TableSkeleton rows={6} cols={3} />
          </div>
        ) : (
          <>
            {/* CATEGORIES */}
            <TabsContent value="categories" className="mt-4">
              <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
                {visibleCategories.length === 0 ? (
                  <div className="p-6">
                    <EmptyState
                      title={q ? 'No matching categories' : 'No categories yet'}
                      description={q ? 'Try a different search.' : 'Create your first category, e.g. Shirts.'}
                    />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Level</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-12 text-right">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleCategories.map((c) => (
                        <TableRow key={c.id} className={c.is_active ? undefined : 'opacity-60'}>
                          <TableCell className="font-medium">
                            {c.parent_id ? (
                              <span className="text-muted-foreground">
                                {categoryName(c.parent_id)} ›{' '}
                              </span>
                            ) : null}
                            {c.name}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{c.parent_id ? 'Subcategory' : 'Category'}</Badge>
                          </TableCell>
                          <TableCell className="max-w-[18rem] truncate text-sm text-muted-foreground">
                            {c.description ?? '—'}
                          </TableCell>
                          <TableCell>
                            <ActiveBadge active={c.is_active} />
                          </TableCell>
                          <TableCell className="text-right">{rowActions('categories', c)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </TabsContent>

            {/* BRANDS */}
            <TabsContent value="brands" className="mt-4">
              <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
                {visibleBrands.length === 0 ? (
                  <div className="p-6">
                    <EmptyState title={q ? 'No matching brands' : 'No brands yet'} description={q ? 'Try a different search.' : 'Create your first brand.'} />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Brand</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-12 text-right">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleBrands.map((b) => (
                        <TableRow key={b.id} className={b.is_active ? undefined : 'opacity-60'}>
                          <TableCell className="font-medium">{b.name}</TableCell>
                          <TableCell className="max-w-[18rem] truncate text-sm text-muted-foreground">{b.description ?? '—'}</TableCell>
                          <TableCell>
                            <ActiveBadge active={b.is_active} />
                          </TableCell>
                          <TableCell className="text-right">{rowActions('brands', b)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </TabsContent>

            {/* SIZES */}
            <TabsContent value="sizes" className="mt-4">
              <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
                {visibleSizes.length === 0 ? (
                  <div className="p-6">
                    <EmptyState title={q ? 'No matching sizes' : 'No sizes yet'} description={q ? 'Try a different search.' : 'Create your first size, e.g. XL.'} />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Size</TableHead>
                        <TableHead>Sort order</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-12 text-right">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleSizes.map((s) => (
                        <TableRow key={s.id} className={s.is_active ? undefined : 'opacity-60'}>
                          <TableCell className="font-medium">{s.name}</TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">{s.sort_order}</TableCell>
                          <TableCell>
                            <ActiveBadge active={s.is_active} />
                          </TableCell>
                          <TableCell className="text-right">{rowActions('sizes', s)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </TabsContent>

            {/* COLORS */}
            <TabsContent value="colors" className="mt-4">
              <div className="overflow-hidden rounded-lg border bg-card shadow-xs">
                {visibleColors.length === 0 ? (
                  <div className="p-6">
                    <EmptyState title={q ? 'No matching colors' : 'No colors yet'} description={q ? 'Try a different search.' : 'Create your first color.'} />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Color</TableHead>
                        <TableHead>Swatch</TableHead>
                        <TableHead>Hex code</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-12 text-right">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleColors.map((c) => (
                        <TableRow key={c.id} className={c.is_active ? undefined : 'opacity-60'}>
                          <TableCell className="font-medium">{c.name}</TableCell>
                          <TableCell>
                            {c.hex_code ? (
                              <span
                                className="inline-block size-5 rounded-full border"
                                style={{ backgroundColor: c.hex_code.startsWith('#') ? c.hex_code : `#${c.hex_code}` }}
                                aria-hidden="true"
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{c.hex_code ?? '—'}</TableCell>
                          <TableCell>
                            <ActiveBadge active={c.is_active} />
                          </TableCell>
                          <TableCell className="text-right">{rowActions('colors', c)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </TabsContent>
          </>
        )}
      </Tabs>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add {createEntity.slice(0, -1)}</DialogTitle>
            <DialogDescription>Attributes are configurable — they drive variants and filters.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Attribute type</Label>
              <Select value={createEntity} onValueChange={(v) => setCreateEntity(v as Entity)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="categories">Category</SelectItem>
                  <SelectItem value="brands">Brand</SelectItem>
                  <SelectItem value="sizes">Size</SelectItem>
                  <SelectItem value="colors">Color</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="attr-create-name">Name</Label>
              <Input id="attr-create-name" required maxLength={120} placeholder="e.g. Shirts / Arrow / XL / Black" />
            </div>
            {createEntity === 'categories' ? (
              <>
                <div className="space-y-2">
                  <Label>Parent category (optional — makes it a subcategory)</Label>
                  <Combobox
                    id="attr-create-parent"
                    options={[{ value: '', label: 'Top-level category' }, ...topCategories.map((c) => ({ value: c.id, label: c.name }))]}
                    value={undefined}
                    onValueChange={() => {}}
                    placeholder="Top-level category"
                    aria-label="Parent category"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="attr-create-desc">Description (optional)</Label>
                  <Input id="attr-create-desc" maxLength={300} placeholder="e.g. All formal and casual shirts" />
                </div>
              </>
            ) : null}
            {createEntity === 'brands' ? (
              <div className="space-y-2">
                <Label htmlFor="attr-create-desc">Description (optional)</Label>
                <Input id="attr-create-desc" maxLength={300} placeholder="e.g. Premium menswear label" />
              </div>
            ) : null}
            {createEntity === 'sizes' ? (
              <div className="space-y-2">
                <Label htmlFor="attr-create-sort">Sort order</Label>
                <Input id="attr-create-sort" inputMode="numeric" placeholder="e.g. 9 (lower shows first)" />
              </div>
            ) : null}
            {createEntity === 'colors' ? (
              <div className="space-y-2">
                <Label htmlFor="attr-create-hex">Hex code (optional)</Label>
                <Input id="attr-create-hex" placeholder="e.g. #1D4ED8" maxLength={7} />
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editState !== null} onOpenChange={(o) => !o && setEditState(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {editState?.entity.slice(0, -1)}</DialogTitle>
            <DialogDescription>Existing records keep working — deactivating hides it from new picks.</DialogDescription>
          </DialogHeader>
          {editState ? (
            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="attr-edit-name">Name</Label>
                <Input
                  id="attr-edit-name"
                  value={editState.name}
                  onChange={(e) => setEditState({ ...editState, name: e.target.value })}
                  required
                  maxLength={120}
                />
              </div>
              {editState.entity === 'categories' ? (
                <>
                  <div className="space-y-2">
                    <Label>Parent category</Label>
                    <Combobox
                      options={[{ value: '', label: 'Top-level category' }, ...topCategories.filter((c) => c.id !== editState.id).map((c) => ({ value: c.id, label: c.name }))]}
                      value={editState.parent_id || undefined}
                      onValueChange={(v) => setEditState({ ...editState, parent_id: v })}
                      placeholder="Top-level category"
                      aria-label="Parent category"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="attr-edit-desc">Description</Label>
                    <Input
                      id="attr-edit-desc"
                      value={editState.description}
                      onChange={(e) => setEditState({ ...editState, description: e.target.value })}
                      maxLength={300}
                    />
                  </div>
                </>
              ) : null}
              {editState.entity === 'brands' ? (
                <div className="space-y-2">
                  <Label htmlFor="attr-edit-desc">Description</Label>
                  <Input
                    id="attr-edit-desc"
                    value={editState.description}
                    onChange={(e) => setEditState({ ...editState, description: e.target.value })}
                    maxLength={300}
                  />
                </div>
              ) : null}
              {editState.entity === 'sizes' ? (
                <div className="space-y-2">
                  <Label htmlFor="attr-edit-sort">Sort order</Label>
                  <Input
                    id="attr-edit-sort"
                    inputMode="numeric"
                    value={editState.sort_order}
                    onChange={(e) => setEditState({ ...editState, sort_order: e.target.value })}
                  />
                </div>
              ) : null}
              {editState.entity === 'colors' ? (
                <div className="space-y-2">
                  <Label htmlFor="attr-edit-hex">Hex code</Label>
                  <Input
                    id="attr-edit-hex"
                    value={editState.hex_code}
                    onChange={(e) => setEditState({ ...editState, hex_code: e.target.value })}
                    maxLength={7}
                    placeholder="#1D4ED8"
                  />
                </div>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditState(null)}>
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
