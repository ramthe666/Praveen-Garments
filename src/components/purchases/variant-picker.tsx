'use client'

import * as React from 'react'
import { Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { createClient } from '@/lib/supabase/client'
import { useDebounced } from '@/lib/catalog/constants'
import { logError } from '@/lib/errors'
import { cn } from '@/lib/utils'

export interface VariantOption {
  id: string
  sku: string
  product_name: string
  size_name: string | null
  color_name: string | null
  selling_price: number | null
  product_code: string | null
}

/**
 * Searchable product-variant picker used by purchase order / invoice /
 * exchange dialogs. Database-side search over products + variants
 * (never loads the whole catalog into the browser).
 */
export function VariantPicker({ onPick, placeholder = 'Search by name or SKU…' }: { onPick: (variant: VariantOption) => void; placeholder?: string }) {
  const supabase = React.useMemo(() => createClient(), [])
  const [search, setSearch] = React.useState('')
  const debounced = useDebounced(search, 300)
  const [results, setResults] = React.useState<VariantOption[]>([])
  const [loading, setLoading] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (debounced.trim().length < 2) {
      setResults([])
      setOpen(false)
      return
    }
    setLoading(true)
    void (async () => {
      const like = `%${debounced.trim()}%`
      const { data, error } = await supabase
        .from('product_variants')
        .select('id, sku, selling_price, products(name, product_code), sizes(name), colors(name)')
        .or(`sku.ilike.${like},products.name.ilike.${like}`)
        .eq('is_active', true)
        .limit(8)
      if (error) {
        logError('variant-picker:search', error)
        setResults([])
      } else {
        const rows = (data ?? []) as unknown as Array<{
          id: string
          sku: string
          selling_price: number | null
          products: { name: string; product_code: string | null } | null
          sizes: { name: string } | null
          colors: { name: string } | null
        }>
        setResults(
          rows.map((r) => ({
            id: r.id,
            sku: r.sku,
            product_name: r.products?.name ?? '—',
            product_code: r.products?.product_code ?? null,
            size_name: r.sizes?.name ?? null,
            color_name: r.colors?.name ?? null,
            selling_price: r.selling_price ?? null,
          }))
        )
        setOpen(true)
      }
      setLoading(false)
    })()
  }, [debounced, supabase])

  React.useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function pick(variant: VariantOption) {
    onPick(variant)
    setSearch('')
    setResults([])
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          className="pl-9"
          type="search"
          aria-label="Search products"
        />
      </div>
      {open ? (
        <div className="absolute z-50 mt-1 w-full rounded-lg border bg-popover p-1 shadow-lg">
          {loading ? (
            <div className="space-y-1.5 p-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : results.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No matching products.</p>
          ) : (
            results.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => pick(v)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{v.product_name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {v.sku}
                    {v.size_name ? ` · ${v.size_name}` : ''}
                    {v.color_name ? ` · ${v.color_name}` : ''}
                  </span>
                </span>
                <Plus className={cn('size-4 shrink-0 text-muted-foreground')} aria-hidden="true" />
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
