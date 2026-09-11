'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, ImageIcon, Loader2, Save, Upload, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { isTableMissing, logError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Combobox } from '@/components/shared/combobox'
import { Phase2SetupNotice } from '@/components/shared/phase2-setup-notice'
import { VariantMatrix, type VariantDraft } from '@/components/products/variant-matrix'
import { GENDER_OPTIONS } from '@/lib/catalog/constants'
import { useApp } from '@/components/providers/app-provider'
import type { Brand, Category, Color, Product, Size } from '@/types/database'

interface ProductFormValues {
  name: string
  product_code: string
  category_id: string
  subcategory_id: string
  brand_id: string
  collection: string
  gender: string
  fabric: string
  pattern: string
  description: string
  hsn_code: string
  gst_rate: string
  cost_price: string
  mrp: string
  selling_price: string
  wholesale_price: string
  image_path: string | null
}

const EMPTY_FORM: ProductFormValues = {
  name: '',
  product_code: '',
  category_id: '',
  subcategory_id: '',
  brand_id: '',
  collection: '',
  gender: '',
  fabric: '',
  pattern: '',
  description: '',
  hsn_code: '',
  gst_rate: '',
  cost_price: '',
  mrp: '',
  selling_price: '',
  wholesale_price: '',
  image_path: null,
}

function toFormValues(product: Product): ProductFormValues {
  return {
    name: product.name,
    product_code: product.product_code ?? '',
    category_id: product.category_id,
    subcategory_id: product.subcategory_id ?? '',
    brand_id: product.brand_id ?? '',
    collection: product.collection ?? '',
    gender: product.gender ?? '',
    fabric: product.fabric ?? '',
    pattern: product.pattern ?? '',
    description: product.description ?? '',
    hsn_code: product.hsn_code ?? '',
    gst_rate: product.gst_rate !== null ? String(product.gst_rate) : '',
    cost_price: product.cost_price !== null ? String(product.cost_price) : '',
    mrp: product.mrp !== null ? String(product.mrp) : '',
    selling_price: product.selling_price !== null ? String(product.selling_price) : '',
    wholesale_price: product.wholesale_price !== null ? String(product.wholesale_price) : '',
    image_path: product.image_path,
  }
}

/**
 * Product creation / edit form. Create mode includes the variant matrix so a
 * whole size x color family is created in one save; edit mode manages
 * variants on the product page instead.
 */
export function ProductForm({ mode, product }: { mode: 'create' | 'edit'; product?: Product }) {
  const router = useRouter()
  const supabase = React.useMemo(() => createClient(), [])
  const { settings } = useApp()

  const [form, setForm] = React.useState<ProductFormValues>(
    mode === 'edit' && product ? toFormValues(product) : EMPTY_FORM
  )
  const [saving, setSaving] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [setupNeeded, setSetupNeeded] = React.useState(false)

  const [categories, setCategories] = React.useState<Category[]>([])
  const [brands, setBrands] = React.useState<Brand[]>([])
  const [sizes, setSizes] = React.useState<Size[]>([])
  const [colors, setColors] = React.useState<Color[]>([])
  const [drafts, setDrafts] = React.useState<VariantDraft[]>([])

  const autoBarcode = settings.barcode?.auto_generate ?? true
  const qrEnabled = settings.qr?.enabled ?? true

  // load reference data (bounded, active-first)
  React.useEffect(() => {
    let cancelled = false
    const loads: Array<[string, React.Dispatch<React.SetStateAction<never[]>>]> = [
      ['categories', setCategories as React.Dispatch<React.SetStateAction<never[]>>],
      ['brands', setBrands as React.Dispatch<React.SetStateAction<never[]>>],
      ['sizes', setSizes as React.Dispatch<React.SetStateAction<never[]>>],
      ['colors', setColors as React.Dispatch<React.SetStateAction<never[]>>],
    ]
    for (const [table, setter] of loads) {
      supabase
        .from(table)
        .select('*')
        .order(table === 'sizes' ? 'sort_order' : 'name')
        .then(({ data, error }) => {
          if (cancelled) return
          if (error) {
            if (isTableMissing(error)) setSetupNeeded(true)
            else logError(`product-form:${table}`, error)
            return
          }
          setter((data ?? []) as never[])
        })
    }
    return () => {
      cancelled = true
    }
  }, [supabase])

  const activeCategories = React.useMemo(() => categories.filter((c) => c.is_active), [categories])
  const topCategories = React.useMemo(() => activeCategories.filter((c) => !c.parent_id), [activeCategories])
  const subcategories = React.useMemo(
    () => activeCategories.filter((c) => c.parent_id === (form.category_id || null)),
    [activeCategories, form.category_id]
  )

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (key === 'category_id') {
      // subcategory must belong to the new category
      setForm((f) => ({ ...f, category_id: value as string, subcategory_id: '' }))
    }
  }

  async function handleUpload(file: File) {
    if (mode !== 'edit' || !product) return // create mode uploads after the product exists
    setUploading(true)
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch(`/api/admin/products/${product.id}/image`, { method: 'POST', body })
      const payload = (await res.json()) as { error?: string; path?: string }
      if (!res.ok) {
        toast.error('Upload failed', { description: payload.error ?? 'Please try again.' })
        return
      }
      setForm((f) => ({ ...f, image_path: payload.path ?? null }))
      toast.success('Image updated')
    } catch (err) {
      logError('product-form:upload', err)
      toast.error('Upload failed', { description: 'Network error. Please try again.' })
    } finally {
      setUploading(false)
    }
  }

  async function handleRemoveImage() {
    if (mode !== 'edit' || !product || !form.image_path) return
    setUploading(true)
    try {
      const res = await fetch(`/api/admin/products/${product.id}/image`, { method: 'DELETE' })
      const payload = (await res.json()) as { error?: string }
      if (!res.ok) {
        toast.error('Could not remove image', { description: payload.error ?? 'Please try again.' })
        return
      }
      setForm((f) => ({ ...f, image_path: null }))
      toast.success('Image removed')
    } catch (err) {
      logError('product-form:remove-image', err)
      toast.error('Could not remove image', { description: 'Network error.' })
    } finally {
      setUploading(false)
    }
  }

  function validate(): string | null {
    if (!form.name.trim()) return 'Enter the product name.'
    if (!form.category_id) return 'Select a category.'
    if (form.product_code && !/^[A-Za-z0-9-_]+$/.test(form.product_code.trim()))
      return 'Product code may only contain letters, digits, dashes and underscores.'
    if (form.hsn_code && !/^\d{4,8}$/.test(form.hsn_code.trim())) return 'HSN/SAC must be 4-8 digits.'
    for (const key of ['gst_rate', 'cost_price', 'mrp', 'selling_price', 'wholesale_price'] as const) {
      const v = form[key]
      if (v && !/^\d+(\.\d{1,2})?$/.test(v.trim())) return 'Prices and GST rate must be numbers like 499 or 499.50.'
      if (key === 'gst_rate' && v && Number(v) > 100) return 'GST rate cannot exceed 100%.'
    }
    // in-form duplicate SKU guard (the database re-checks authoritatively)
    const skus = drafts.map((d) => d.sku.trim().toLowerCase()).filter(Boolean)
    if (new Set(skus).size !== skus.length) return 'Two variants use the same SKU — fix the duplicates.'
    for (const d of drafts) {
      if (d.barcode && !/^\d{8,14}$/.test(d.barcode)) return `Barcode "${d.barcode}" must be 8-14 digits.`
      if (d.qr_identifier && !/^[A-Za-z0-9_-]{4,64}$/.test(d.qr_identifier))
        return `QR identifier "${d.qr_identifier}" must be 4-64 letters, digits, dashes or underscores.`
      for (const key of ['cost_price', 'mrp', 'selling_price', 'wholesale_price'] as const) {
        if (d[key] && !/^\d+(\.\d{1,2})?$/.test(d[key])) return 'Variant prices must be numbers like 499 or 499.50.'
      }
    }
    return null
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (saving) return
    const validationError = validate()
    if (validationError) {
      toast.error('Check the form', { description: validationError })
      return
    }

    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        product_code: form.product_code.trim() || null,
        category_id: form.category_id,
        subcategory_id: form.subcategory_id || null,
        brand_id: form.brand_id || null,
        collection: form.collection.trim() || null,
        gender: form.gender || null,
        fabric: form.fabric.trim() || null,
        pattern: form.pattern.trim() || null,
        description: form.description.trim() || null,
        hsn_code: form.hsn_code.trim() || null,
        gst_rate: form.gst_rate ? Number(form.gst_rate) : null,
        cost_price: form.cost_price ? Number(form.cost_price) : null,
        mrp: form.mrp ? Number(form.mrp) : null,
        selling_price: form.selling_price ? Number(form.selling_price) : null,
        wholesale_price: form.wholesale_price ? Number(form.wholesale_price) : null,
      }

      let url = '/api/admin/products'
      let method = 'POST'
      if (mode === 'edit' && product) {
        url = `/api/admin/products/${product.id}`
        method = 'PATCH'
      } else {
        payload.variants = drafts.map((d) => ({
          sku: d.sku.trim() || null,
          size_id: d.size_id,
          color_id: d.color_id,
          barcode: d.barcode.trim() || null,
          qr_identifier: d.qr_identifier.trim() || null,
          generate_barcode: d.generate_barcode,
          generate_qr: d.generate_qr,
          cost_price: d.cost_price ? Number(d.cost_price) : null,
          mrp: d.mrp ? Number(d.mrp) : null,
          selling_price: d.selling_price ? Number(d.selling_price) : null,
          wholesale_price: d.wholesale_price ? Number(d.wholesale_price) : null,
        }))
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = (await res.json()) as { error?: string; product?: { id: string } }
      if (!res.ok) {
        toast.error('Could not save the product', { description: result.error ?? 'Please try again.' })
        return
      }

      toast.success(mode === 'create' ? 'Product created' : 'Product updated', {
        description:
          mode === 'create'
            ? `${drafts.length} variant${drafts.length === 1 ? '' : 's'} created with SKUs, barcodes and QR identifiers.`
            : `${form.name.trim()} was saved.`,
      })
      router.push(`/products/${result.product?.id ?? product?.id}`)
      router.refresh()
    } catch (err) {
      logError('product-form:submit', err)
      toast.error('Could not save the product', { description: 'Network error. Please try again.' })
    } finally {
      setSaving(false)
    }
  }

  const priceField = (key: keyof ProductFormValues, label: string, placeholder = 'e.g. 999') => (
    <div className="space-y-2">
      <Label htmlFor={key}>{label}</Label>
      <Input
        id={key}
        inputMode="decimal"
        value={form[key] as string}
        onChange={(e) => set(key, e.target.value as never)}
        placeholder={placeholder}
      />
    </div>
  )

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {mode === 'create' ? 'New product' : 'Edit product'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === 'create'
              ? 'Basic information, classification, pricing and variants — one save.'
              : 'Update the product details. Variants are managed on the product page.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={mode === 'create' ? '/products' : `/products/${product?.id}`}>
              <ArrowLeft className="size-4" aria-hidden="true" />
              Cancel
            </Link>
          </Button>
          <Button type="submit" size="sm" disabled={saving || uploading}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            {mode === 'create' ? 'Create product' : 'Save changes'}
          </Button>
        </div>
      </div>

      {setupNeeded ? <Phase2SetupNotice /> : null}

      {/* Section 1 — basic information */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1 · Basic information</CardTitle>
          <CardDescription>Name, code and descriptive details customers and staff will recognise.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="name">
              Product name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Classic Cotton Shirt"
              required
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="product_code">Product code</Label>
            <Input
              id="product_code"
              value={form.product_code}
              onChange={(e) => set('product_code', e.target.value.toUpperCase())}
              placeholder="e.g. CCS100 (used in SKUs)"
              maxLength={40}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="collection">Collection / season</Label>
            <Input
              id="collection"
              value={form.collection}
              onChange={(e) => set('collection', e.target.value)}
              placeholder="e.g. Summer 2026"
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fabric">Fabric / material</Label>
            <Input
              id="fabric"
              value={form.fabric}
              onChange={(e) => set('fabric', e.target.value)}
              placeholder="e.g. Cotton 60%"
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pattern">Pattern / design</Label>
            <Input
              id="pattern"
              value={form.pattern}
              onChange={(e) => set('pattern', e.target.value)}
              placeholder="e.g. Checks"
              maxLength={80}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Optional notes shown on the product page"
              rows={3}
              maxLength={2000}
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 2 — classification */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2 · Category &amp; brand</CardTitle>
          <CardDescription>Where the product sits in your catalog.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>
              Category <span className="text-destructive">*</span>
            </Label>
            <Combobox
              options={[
                { value: '', label: 'Select category…' },
                ...topCategories.map((c) => ({ value: c.id, label: c.name })),
              ]}
              value={form.category_id || undefined}
              onValueChange={(v) => set('category_id', v === '' ? '' : v)}
              placeholder="Select category…"
              aria-label="Category"
            />
          </div>
          <div className="space-y-2">
            <Label>Subcategory (optional)</Label>
            <Combobox
              options={[
                { value: '', label: 'None' },
                ...subcategories.map((c) => ({ value: c.id, label: c.name })),
              ]}
              value={form.subcategory_id || undefined}
              onValueChange={(v) => set('subcategory_id', v === '' ? '' : v)}
              placeholder={form.category_id ? 'None' : 'Select a category first'}
              disabled={!form.category_id}
              aria-label="Subcategory"
            />
          </div>
          <div className="space-y-2">
            <Label>Brand (optional)</Label>
            <Combobox
              options={[
                { value: '', label: 'No brand' },
                ...brands.filter((b) => b.is_active).map((b) => ({ value: b.id, label: b.name })),
              ]}
              value={form.brand_id || undefined}
              onValueChange={(v) => set('brand_id', v === '' ? '' : v)}
              placeholder="No brand"
              aria-label="Brand"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gender">Gender</Label>
            <div className="flex flex-wrap gap-2 pt-1">
              {GENDER_OPTIONS.map((g) => (
                <label
                  key={g.value}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm has-[[checked]]:border-primary has-[[checked]]:bg-primary/5"
                >
                  <Checkbox
                    checked={form.gender === g.value}
                    onCheckedChange={(checked) => set('gender', checked ? g.value : '')}
                    aria-label={g.label}
                  />
                  {g.label}
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 3 — pricing & tax */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">3 · Pricing &amp; tax</CardTitle>
          <CardDescription>
            Product-level defaults — variants may override. Leave blank to fill later.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {priceField('cost_price', 'Cost price', 'e.g. 650')}
          {priceField('mrp', 'MRP', 'e.g. 1299')}
          {priceField('selling_price', 'Selling price', 'e.g. 999')}
          {priceField('wholesale_price', 'Wholesale price', 'e.g. 849')}
          <div className="space-y-2">
            <Label htmlFor="gst_rate">GST rate (%)</Label>
            <Input
              id="gst_rate"
              inputMode="decimal"
              value={form.gst_rate}
              onChange={(e) => set('gst_rate', e.target.value)}
              placeholder="e.g. 5"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="hsn_code">HSN / SAC</Label>
            <Input
              id="hsn_code"
              value={form.hsn_code}
              onChange={(e) => set('hsn_code', e.target.value)}
              placeholder="e.g. 6205"
              inputMode="numeric"
              maxLength={8}
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 4 — image */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">4 · Product image</CardTitle>
          <CardDescription>PNG, JPG or WebP up to 2 MB. Shown in lists, labels and the future POS.</CardDescription>
        </CardHeader>
        <CardContent>
          {mode === 'create' ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Upload the image after creating the product (on its page).{' '}
              <ImageIcon className="inline size-4" aria-hidden="true" />
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex size-20 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                {form.image_path ? (
                   
                  <img
                    src={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/product-images/${form.image_path}`}
                    alt="Product image preview"
                    className="size-full object-cover"
                  />
                ) : (
                  <ImageIcon className="size-6 text-muted-foreground" aria-hidden="true" />
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <label>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void handleUpload(file)
                      e.currentTarget.value = ''
                    }}
                  />
                  <Button type="button" variant="outline" size="sm" disabled={uploading} asChild>
                    <span>
                      <Upload className="size-4" aria-hidden="true" />
                      {uploading ? 'Uploading…' : form.image_path ? 'Replace image' : 'Upload image'}
                    </span>
                  </Button>
                </label>
                {form.image_path ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleRemoveImage()} disabled={uploading}>
                    <X className="size-4" aria-hidden="true" />
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 5 — variants (create mode only) */}
      {mode === 'create' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">5 · Variants — size &amp; color matrix</CardTitle>
            <CardDescription>
              Tick the combinations you sell. Each becomes a variant with its own SKU, barcode and QR.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VariantMatrix
              sizes={sizes}
              colors={colors}
              productCode={form.product_code}
              productName={form.name}
              autoBarcode={autoBarcode}
              qrEnabled={qrEnabled}
              drafts={drafts}
              onDraftsChange={setDrafts}
            />
          </CardContent>
        </Card>
      ) : null}
    </form>
  )
}
