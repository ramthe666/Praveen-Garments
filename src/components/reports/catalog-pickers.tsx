'use client'

/**
 * Catalog option pickers for report filters (categories / brands /
 * locations). Options are fetched once on mount with the browser client;
 * roles without direct catalog read simply see no options (the report
 * RPCs still enforce permission server-side).
 */
import * as React from 'react'
import { createClient } from '@/lib/supabase/client'
import { FilterSelect } from '@/components/reports/report-shell'

interface OptionRow { id: string; name: string }

function useOptions(table: 'categories' | 'brands' | 'stock_locations'): OptionRow[] {
  const [options, setOptions] = React.useState<OptionRow[]>([])
  React.useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    void supabase
      .from(table)
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .limit(300)
      .then(({ data }) => {
        if (!cancelled && data) setOptions(data as OptionRow[])
      })
    return () => { cancelled = true }
  }, [table])
  return options
}

export function CategoryFilter({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const options = useOptions('categories')
  return (
    <FilterSelect
      id="filter-category"
      label="Category"
      value={value}
      onChange={onChange}
      options={options.map((o) => ({ value: o.id, label: o.name }))}
    />
  )
}

export function BrandFilter({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const options = useOptions('brands')
  return (
    <FilterSelect
      id="filter-brand"
      label="Brand"
      value={value}
      onChange={onChange}
      options={options.map((o) => ({ value: o.id, label: o.name }))}
    />
  )
}

export function LocationFilter({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const options = useOptions('stock_locations')
  return (
    <FilterSelect
      id="filter-location"
      label="Location"
      value={value}
      onChange={onChange}
      options={options.map((o) => ({ value: o.id, label: o.name }))}
    />
  )
}

export function EmployeeFilter({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [options, setOptions] = React.useState<OptionRow[]>([])
  React.useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    void supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('is_active', true)
      .order('full_name')
      .limit(200)
      .then(({ data }) => {
        if (!cancelled && data) {
          setOptions((data as { id: string; full_name: string | null; email: string | null }[]).map((r) => ({
            id: r.id,
            name: r.full_name?.trim() || r.email || 'User',
          })))
        }
      })
    return () => { cancelled = true }
  }, [])
  return (
    <FilterSelect
      id="filter-employee"
      label="Cashier"
      value={value}
      onChange={onChange}
      options={options.map((o) => ({ value: o.id, label: o.name }))}
    />
  )
}
