'use client'

import * as React from 'react'
import { Grid3x3, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { Color, Size } from '@/types/database'

/** One row of the generated variant list (payload for create_product_variants). */
export interface VariantDraft {
  key: string
  size_id: string | null
  color_id: string | null
  size_name: string | null
  color_name: string | null
  sku: string
  barcode: string
  qr_identifier: string
  cost_price: string
  mrp: string
  selling_price: string
  wholesale_price: string
  generate_barcode: boolean
  generate_qr: boolean
}

interface MatrixSelection {
  sizeId: string
  colorId: string
}

function skuPreview(productCode: string, productName: string, sizeName: string | null, colorName: string | null): string {
  const base =
    productCode.trim() ||
    productName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) ||
    'PRD'
  const colorPart = colorName ? colorName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : ''
  const sizePart = sizeName ? sizeName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) : ''
  let root = base.toUpperCase()
  if (colorPart || sizePart) root += '-'
  root += colorPart
  if (colorPart && sizePart) root += '-'
  root += sizePart
  if (root === base.toUpperCase()) root += '-VAR'
  return root // placeholder preview; the DB generates/validates authoritatively
}

/**
 * Garment variant matrix: pick sizes (columns) and colors (rows), tick the
 * combinations to sell, then fine-tune SKUs / prices / identifiers per row.
 * Leaving SKU/barcode/QR empty lets the DATABASE generate them (guaranteed
 * unique); typed values are validated against uniqueness server-side.
 */
export function VariantMatrix({
  sizes,
  colors,
  productCode,
  productName,
  autoBarcode,
  qrEnabled,
  drafts,
  onDraftsChange,
}: {
  sizes: Size[]
  colors: Color[]
  productCode: string
  productName: string
  autoBarcode: boolean
  qrEnabled: boolean
  drafts: VariantDraft[]
  onDraftsChange: (drafts: VariantDraft[]) => void
}) {
  const activeSizes = React.useMemo(() => sizes.filter((s) => s.is_active), [sizes])
  const activeColors = React.useMemo(() => colors.filter((c) => c.is_active), [colors])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  const sizeName = React.useCallback(
    (id: string | null) => activeSizes.find((s) => s.id === id)?.name ?? null,
    [activeSizes]
  )
  const colorName = React.useCallback(
    (id: string | null) => activeColors.find((c) => c.id === id)?.name ?? null,
    [activeColors]
  )

  const toggleCell = (s: MatrixSelection) => {
    const key = `${s.colorId}:${s.sizeId}`
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
        onDraftsChange(drafts.filter((d) => d.key !== key))
      } else {
        next.add(key)
        onDraftsChange([
          ...drafts,
          {
            key,
            size_id: s.sizeId,
            color_id: s.colorId,
            size_name: sizeName(s.sizeId),
            color_name: colorName(s.colorId),
            sku: '',
            barcode: '',
            qr_identifier: '',
            cost_price: '',
            mrp: '',
            selling_price: '',
            wholesale_price: '',
            generate_barcode: autoBarcode,
            generate_qr: qrEnabled,
          },
        ])
      }
      return next
    })
  }

  const toggleRow = (colorId: string) => {
    const allOn = activeSizes.every((s) => selected.has(`${colorId}:${s.id}`))
    const nextSelected = new Set(selected)
    const nextDrafts = [...drafts]
    for (const s of activeSizes) {
      const key = `${colorId}:${s.id}`
      if (allOn) {
        nextSelected.delete(key)
        const idx = nextDrafts.findIndex((d) => d.key === key)
        if (idx >= 0) nextDrafts.splice(idx, 1)
      } else if (!nextSelected.has(key)) {
        nextSelected.add(key)
        nextDrafts.push({
          key,
          size_id: s.id,
          color_id: colorId,
          size_name: s.name,
          color_name: colorName(colorId),
          sku: '',
          barcode: '',
          qr_identifier: '',
          cost_price: '',
          mrp: '',
          selling_price: '',
          wholesale_price: '',
          generate_barcode: autoBarcode,
          generate_qr: qrEnabled,
        })
      }
    }
    setSelected(nextSelected)
    onDraftsChange(nextDrafts)
  }

  const updateDraft = (key: string, patch: Partial<VariantDraft>) => {
    onDraftsChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }

  const removeDraft = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    onDraftsChange(drafts.filter((d) => d.key !== key))
  }

  const clearSkus = () => {
    onDraftsChange(drafts.map((d) => ({ ...d, sku: '' })))
  }

  if (activeSizes.length === 0 || activeColors.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        <Grid3x3 className="mx-auto mb-2 size-6 opacity-60" aria-hidden="true" />
        Sizes and colors are needed to build the variant matrix.{' '}
        {activeSizes.length === 0 && activeColors.length === 0
          ? 'Create them under Attributes first.'
          : activeSizes.length === 0
            ? 'No active sizes — create them under Attributes.'
            : 'No active colors — create them under Attributes.'}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Matrix grid */}
      <div className="thin-scrollbar overflow-x-auto rounded-lg border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="sticky left-0 z-10 min-w-[7rem] bg-muted/50 px-3 py-2 text-left font-medium text-muted-foreground">
                Color
              </th>
              {activeSizes.map((s) => (
                <th key={s.id} className="px-3 py-2 text-center font-medium text-muted-foreground">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeColors.map((c) => (
              <tr key={c.id} className="border-b last:border-b-0">
                <td className="sticky left-0 z-10 bg-card px-3 py-2">
                  <button
                    type="button"
                    className="flex items-center gap-2 text-left"
                    onClick={() => toggleRow(c.id)}
                    aria-label={`Toggle all sizes for ${c.name}`}
                  >
                    {c.hex_code ? (
                      <span
                        className="size-3.5 shrink-0 rounded-full border"
                        style={{ backgroundColor: c.hex_code.startsWith('#') ? c.hex_code : `#${c.hex_code}` }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="font-medium text-foreground">{c.name}</span>
                  </button>
                </td>
                {activeSizes.map((s) => {
                  const key = `${c.id}:${s.id}`
                  const isOn = selected.has(key)
                  return (
                    <td key={s.id} className="px-3 py-2 text-center">
                      <Checkbox
                        checked={isOn}
                        onCheckedChange={() => toggleCell({ colorId: c.id, sizeId: s.id })}
                        aria-label={`${c.name} size ${s.name}`}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Generated variants */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-foreground">
            Generated variants{' '}
            <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
              {drafts.length}
            </span>
          </h4>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearSkus}
            disabled={drafts.length === 0}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Reset manual SKUs
          </Button>
        </div>

        {drafts.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            Tick combinations above to create variants. Leave identifiers empty to auto-generate them.
          </p>
        ) : (
          <div className="thin-scrollbar overflow-x-auto rounded-lg border bg-card">
            <Table className="min-w-[64rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead className="w-40">SKU</TableHead>
                  <TableHead className="w-40">Barcode</TableHead>
                  <TableHead className="w-36">QR</TableHead>
                  <TableHead className="w-28 text-right">Cost</TableHead>
                  <TableHead className="w-28 text-right">MRP</TableHead>
                  <TableHead className="w-28 text-right">Selling</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {drafts.map((d) => (
                  <TableRow key={d.key}>
                    <TableCell className="whitespace-nowrap text-sm">
                      <span className="font-medium">{d.color_name}</span>
                      {d.size_name ? <span className="text-muted-foreground"> · {d.size_name}</span> : null}
                      <span className="mt-0.5 block text-[11px] text-muted-foreground/80">
                        auto SKU: {skuPreview(productCode, productName, d.size_name, d.color_name)}…
                      </span>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={d.sku}
                        onChange={(e) => updateDraft(d.key, { sku: e.target.value })}
                        placeholder="(auto)"
                        className="h-8 text-xs uppercase"
                        aria-label={`SKU for ${d.color_name} ${d.size_name ?? ''}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={d.barcode}
                        onChange={(e) => updateDraft(d.key, { barcode: e.target.value })}
                        placeholder={d.generate_barcode ? '(auto EAN-13)' : '(none)'}
                        className="h-8 text-xs tabular-nums"
                        inputMode="numeric"
                        aria-label={`Barcode for ${d.color_name} ${d.size_name ?? ''}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={d.qr_identifier}
                        onChange={(e) => updateDraft(d.key, { qr_identifier: e.target.value })}
                        placeholder={d.generate_qr ? '(auto)' : '(none)'}
                        className="h-8 text-xs"
                        aria-label={`QR identifier for ${d.color_name} ${d.size_name ?? ''}`}
                      />
                    </TableCell>
                    {(['cost_price', 'mrp', 'selling_price'] as const).map((field) => (
                      <TableCell key={field}>
                        <Input
                          value={d[field]}
                          onChange={(e) => updateDraft(d.key, { [field]: e.target.value })}
                          placeholder="inherit"
                          className={cn('h-8 text-right text-xs tabular-nums')}
                          inputMode="decimal"
                          aria-label={`${field.replace('_', ' ')} for ${d.color_name} ${d.size_name ?? ''}`}
                        />
                      </TableCell>
                    ))}
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeDraft(d.key)}
                        aria-label={`Remove ${d.color_name} ${d.size_name ?? ''} variant`}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Empty SKU / barcode / QR fields are generated by the database (unique, EAN-13 barcodes in the
          in-store range). Typed values are checked for duplicates when saving.
        </p>
      </div>
    </div>
  )
}
