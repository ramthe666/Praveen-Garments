'use client'

import * as React from 'react'
import { createClient } from '@/lib/supabase/client'
import { isTableMissing, logError } from '@/lib/errors'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/shared/page-header'
import { Phase2SetupNotice } from '@/components/shared/phase2-setup-notice'
import { StockList } from '@/components/inventory/stock-list'
import { StockHistory } from '@/components/inventory/stock-history'
import { LocationsTab } from '@/components/inventory/locations-tab'
import type { Brand, Branch, Category, Color, Size, StockLocation } from '@/types/database'

export function InventoryView() {
  const supabase = React.useMemo(() => createClient(), [])

  const [categories, setCategories] = React.useState<Category[]>([])
  const [brands, setBrands] = React.useState<Brand[]>([])
  const [sizes, setSizes] = React.useState<Size[]>([])
  const [colors, setColors] = React.useState<Color[]>([])
  const [locations, setLocations] = React.useState<StockLocation[]>([])
  const [branches, setBranches] = React.useState<Branch[]>([])
  const [refLoading, setRefLoading] = React.useState(true)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const loadReference = React.useCallback(async () => {
    setRefLoading(true)
    try {
      const results = await Promise.all([
        supabase.from('categories').select('*').order('name'),
        supabase.from('brands').select('*').order('name'),
        supabase.from('sizes').select('*').order('sort_order'),
        supabase.from('colors').select('*').order('name'),
        supabase.from('stock_locations').select('*').order('name'),
        supabase.from('branches').select('*').order('name'),
      ])
      let missing = false
      for (const r of results) {
        if (r.error && isTableMissing(r.error)) missing = true
      }
      if (missing) {
        setSetupNeeded(true)
        return
      }
      setCategories((results[0].data as Category[]) ?? [])
      setBrands((results[1].data as Brand[]) ?? [])
      setSizes((results[2].data as Size[]) ?? [])
      setColors((results[3].data as Color[]) ?? [])
      setLocations((results[4].data as StockLocation[]) ?? [])
      setBranches((results[5].data as Branch[]) ?? [])
    } catch (err) {
      logError('inventory:reference', err)
    } finally {
      setRefLoading(false)
    }
  }, [supabase])

  React.useEffect(() => {
    void loadReference()
  }, [loadReference])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        description="Live stock by variant and location with a complete, append-only movement ledger."
      />

      {setupNeeded ? <Phase2SetupNotice /> : null}

      <Tabs defaultValue="stock">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="stock">Current stock</TabsTrigger>
          <TabsTrigger value="history">Stock history</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="mt-4">
          <StockList
            categories={categories}
            brands={brands}
            sizes={sizes}
            colors={colors}
            locations={locations}
            onSetupNeeded={() => setSetupNeeded(true)}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <StockHistory locations={locations} onSetupNeeded={() => setSetupNeeded(true)} />
        </TabsContent>

        <TabsContent value="locations" className="mt-4">
          <LocationsTab
            locations={locations}
            branches={branches}
            loading={refLoading}
            setupNeeded={setupNeeded}
            onReload={() => void loadReference()}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
