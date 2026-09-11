'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Building2, ImagePlus, Save, Trash2, UploadCloud } from 'lucide-react'
import type { CompanySettings } from '@/types/database'
import { createClient } from '@/lib/supabase/client'
import { CURRENCIES, TIMEZONES } from '@/lib/auth/constants'
import { logError, toUserMessage } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AppLogo } from '@/components/shared/app-logo'
import { ErrorState } from '@/components/shared/error-state'
import { Spinner } from '@/components/shared/loading'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

const LOGO_MAX_BYTES = 2 * 1024 * 1024
const LOGO_MIME = ['image/png', 'image/jpeg', 'image/webp']

interface CompanyForm {
  company_name: string
  phone: string
  email: string
  address: string
  city: string
  state: string
  pincode: string
  gstin: string
  invoice_prefix: string
  currency: string
  timezone: string
}

function toForm(c: CompanySettings | null): CompanyForm {
  return {
    company_name: c?.company_name ?? '',
    phone: c?.phone ?? '',
    email: c?.email ?? '',
    address: c?.address ?? '',
    city: c?.city ?? '',
    state: c?.state ?? '',
    pincode: c?.pincode ?? '',
    gstin: c?.gstin ?? '',
    invoice_prefix: c?.invoice_prefix ?? 'INV',
    currency: c?.currency ?? 'INR',
    timezone: c?.timezone ?? 'Asia/Kolkata',
  }
}

export function CompanyTab({
  company,
  onSaved,
}: {
  company: CompanySettings | null
  onSaved: () => Promise<void>
}) {
  const supabase = React.useMemo(() => createClient(), [])
  const [form, setForm] = React.useState<CompanyForm>(() => toForm(company))
  const [saving, setSaving] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const [logoUrl, setLogoUrl] = React.useState<string | null>(company?.logo_url ?? null)
  const [logoVersion, setLogoVersion] = React.useState(0) // cache-bust previews
  const [removeLogoOpen, setRemoveLogoOpen] = React.useState(false)
  const [fatal, setFatal] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const set = <K extends keyof CompanyForm>(key: K, value: CompanyForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (saving) return

    if (!form.company_name.trim()) {
      toast.error('Company name is required.')
      return
    }
    if (form.pincode && !/^[1-9][0-9]{5}$/.test(form.pincode)) {
      toast.error('Invalid pincode', { description: 'Indian pincodes are 6 digits.' })
      return
    }
    if (form.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(form.gstin)) {
      toast.error('Invalid GSTIN', { description: 'Expected format: 22AAAAA0000A1Z5' })
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase
        .from('company_settings')
        .update({
          company_name: form.company_name.trim(),
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          address: form.address.trim() || null,
          city: form.city.trim() || null,
          state: form.state.trim() || null,
          pincode: form.pincode.trim() || null,
          gstin: form.gstin.trim().toUpperCase() || null,
          invoice_prefix: form.invoice_prefix.trim() || 'INV',
          currency: form.currency,
          timezone: form.timezone,
        })
        .eq('id', company?.id ?? 1)

      if (error) {
        logError('company:save', error)
        toast.error('Could not save company settings', { description: toUserMessage(error) })
        return
      }
      toast.success('Company settings saved', {
        description: 'Branding and invoice defaults now use these values.',
      })
      await onSaved()
    } catch (err) {
      logError('company:save:unexpected', err)
      setFatal('An unexpected error occurred while saving.')
    } finally {
      setSaving(false)
    }
  }

  async function persistLogoUrl(url: string | null, oldUrl: string | null) {
    const { error } = await supabase
      .from('company_settings')
      .update({ logo_url: url })
      .eq('id', company?.id ?? 1)
    if (error) {
      logError('company:logo-url', error)
      toast.error('Could not update the logo reference', { description: toUserMessage(error) })
      return false
    }
    // Clean up the previous file (best effort; failures are logged, not fatal)
    if (oldUrl) {
      const match = oldUrl.match(/\/object\/public\/company-assets\/(.+)$/)
      if (match) {
        const { error: removeError } = await supabase.storage.from('company-assets').remove([match[1]])
        if (removeError) logError('company:logo-cleanup', removeError)
      }
    }
    return true
  }

  async function handleLogoUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = '' // allow re-selecting the same file
    if (!file) return

    if (!LOGO_MIME.includes(file.type)) {
      toast.error('Unsupported file type', { description: 'Use PNG, JPEG or WebP.' })
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast.error('File too large', { description: 'Maximum logo size is 2 MB.' })
      return
    }

    setUploading(true)
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60)
      const path = `logos/${Date.now()}-${safeName}`
      const { error: uploadError } = await supabase.storage
        .from('company-assets')
        .upload(path, file, { contentType: file.type, upsert: false })
      if (uploadError) {
        logError('company:logo-upload', uploadError)
        toast.error('Upload failed', { description: toUserMessage(uploadError) })
        return
      }

      const { data } = supabase.storage.from('company-assets').getPublicUrl(path)
      const oldUrl = logoUrl
      const ok = await persistLogoUrl(data.publicUrl, oldUrl)
      if (!ok) {
        // roll back the uploaded object so storage stays tidy
        const { error: removeError } = await supabase.storage.from('company-assets').remove([path])
        if (removeError) logError('company:logo-rollback', removeError)
        return
      }
      setLogoUrl(data.publicUrl)
      setLogoVersion((v) => v + 1)
      toast.success('Logo updated', { description: 'It now appears across the application.' })
      await onSaved()
    } catch (err) {
      logError('company:logo-upload:unexpected', err)
      toast.error('Upload failed', { description: 'Please try again.' })
    } finally {
      setUploading(false)
    }
  }

  async function handleLogoRemove() {
    const oldUrl = logoUrl
    const ok = await persistLogoUrl(null, oldUrl)
    if (!ok) return
    setLogoUrl(null)
    setLogoVersion((v) => v + 1)
    toast.success('Logo removed', { description: 'The default monogram is now used.' })
    await onSaved()
  }

  if (fatal) {
    return <ErrorState message={fatal} onRetry={() => setFatal(null)} />
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="size-4.5 text-primary" aria-hidden="true" />
          Company profile
        </CardTitle>
        <CardDescription>
          Used for branding, invoices and receipts across the application.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        {/* ---- Logo ---- */}
        <section aria-label="Company logo" className="space-y-3">
          <div className="flex flex-wrap items-center gap-4">
            <span
              className="flex size-16 items-center justify-center rounded-lg border bg-muted/40"
              aria-hidden="true"
            >
              <AppLogo logoUrl={logoUrl ? `${logoUrl}${logoUrl.includes('?') ? '&' : '?'}v=${logoVersion}` : null} companyName={form.company_name || 'PG'} size={52} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Company logo</p>
              <p className="text-xs text-muted-foreground">PNG, JPEG or WebP · up to 2 MB</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || saving}
                >
                  {uploading ? (
                    <Spinner />
                  ) : (
                    <ImagePlus className="size-4" aria-hidden="true" />
                  )}
                  {logoUrl ? 'Replace logo' : 'Upload logo'}
                </Button>
                {logoUrl ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRemoveLogoOpen(true)}
                    disabled={uploading || saving}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    Remove
                  </Button>
                ) : null}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => void handleLogoUpload(e)}
                className="sr-only"
                aria-label="Upload company logo"
              />
            </div>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <UploadCloud className="size-3.5 shrink-0" aria-hidden="true" />
            Stored securely in Supabase Storage (admin-only uploads).
          </p>
        </section>

        {/* ---- Details ---- */}
        <form onSubmit={handleSave} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="c-name">Company name</Label>
              <Input
                id="c-name"
                value={form.company_name}
                onChange={(e) => set('company_name', e.target.value)}
                required
                maxLength={160}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-phone">Phone</Label>
              <Input
                id="c-phone"
                type="tel"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="+91 98xxxxxx21"
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-email">Email</Label>
              <Input
                id="c-email"
                type="email"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                placeholder="hello@praveengarments.com"
                disabled={saving}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="c-address">Address</Label>
              <Textarea
                id="c-address"
                rows={2}
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                placeholder="Shop no. & street, landmark"
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-city">City</Label>
              <Input id="c-city" value={form.city} onChange={(e) => set('city', e.target.value)} disabled={saving} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-state">State</Label>
              <Input id="c-state" value={form.state} onChange={(e) => set('state', e.target.value)} disabled={saving} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-pincode">Pincode</Label>
              <Input
                id="c-pincode"
                inputMode="numeric"
                value={form.pincode}
                onChange={(e) => set('pincode', e.target.value)}
                placeholder="560001"
                maxLength={6}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-gstin">GSTIN</Label>
              <Input
                id="c-gstin"
                value={form.gstin}
                onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                placeholder="22AAAAA0000A1Z5"
                maxLength={15}
                className="font-mono text-[13px]"
                disabled={saving}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 border-t pt-5 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="c-prefix">Invoice prefix</Label>
              <Input
                id="c-prefix"
                value={form.invoice_prefix}
                onChange={(e) => set('invoice_prefix', e.target.value.toUpperCase())}
                maxLength={12}
                className="font-mono text-[13px]"
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-currency">Currency</Label>
              <Select value={form.currency} onValueChange={(v) => set('currency', v)} disabled={saving}>
                <SelectTrigger id="c-currency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-timezone">Timezone</Label>
              <Select value={form.timezone} onValueChange={(v) => set('timezone', v)} disabled={saving}>
                <SelectTrigger id="c-timezone" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex justify-end border-t pt-5">
            <Button type="submit" disabled={saving}>
              {saving ? (
                'Saving…'
              ) : (
                <>
                  <Save className="size-4" aria-hidden="true" />
                  Save company settings
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>

      <ConfirmDialog
        open={removeLogoOpen}
        onOpenChange={setRemoveLogoOpen}
        title="Remove the company logo?"
        description="The uploaded file is deleted from storage and the default monogram is used instead."
        confirmLabel="Remove logo"
        destructive
        onConfirm={handleLogoRemove}
      />
    </Card>
  )
}
