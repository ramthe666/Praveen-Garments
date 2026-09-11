'use client'

import * as React from 'react'
import { Save } from 'lucide-react'
import type { AppSettingsKey } from '@/types/database'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export type FieldDef =
  | { kind: 'text'; key: string; label: string; placeholder?: string; maxLength?: number; required?: boolean }
  | { kind: 'number'; key: string; label: string; min?: number; max?: number }
  | { kind: 'textarea'; key: string; label: string; rows?: number; maxLength?: number }
  | {
      kind: 'select'
      key: string
      label: string
      options: Array<{ value: string; label: string }>
    }
  | { kind: 'toggle'; key: string; label: string; description?: string }
  | { kind: 'chips'; key: string; label: string; options: string[] }

/**
 * Schema-driven settings form for app_settings JSONB sections.
 * Business rules live in the database; this renders whatever the section
 * config declares. Values are merged onto the stored JSON on save.
 */
export function SettingsSectionForm({
  title,
  description,
  settingsKey,
  fields,
  value,
  onSave,
}: {
  title: string
  description: string
  settingsKey: AppSettingsKey
  fields: FieldDef[]
  value: Record<string, unknown>
  onSave: (value: Record<string, unknown>) => Promise<boolean>
}) {
  const [draft, setDraft] = React.useState<Record<string, unknown>>(() => ({ ...value }))
  const [saving, setSaving] = React.useState(false)

  const setField = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }))

  const dirty = React.useMemo(() => JSON.stringify(draft) !== JSON.stringify(value), [draft, value])

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (saving || !dirty) return
    setSaving(true)
    try {
      // merge so unknown/future keys stored in DB are preserved
      await onSave({ ...value, ...draft })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-5" data-settings-key={settingsKey}>
          <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
            {fields.map((field) => {
              const id = `sf-${settingsKey}-${field.key}`
              const raw = draft[field.key]
              switch (field.kind) {
                case 'text':
                  return (
                    <div key={field.key} className={cn('space-y-2', field.key.length > 20 && 'sm:col-span-2')}>
                      <Label htmlFor={id}>{field.label}</Label>
                      <Input
                        id={id}
                        value={typeof raw === 'string' ? raw : ''}
                        placeholder={field.placeholder}
                        maxLength={field.maxLength}
                        required={field.required}
                        disabled={saving}
                        onChange={(e) => setField(field.key, e.target.value)}
                      />
                    </div>
                  )
                case 'number':
                  return (
                    <div key={field.key} className="space-y-2">
                      <Label htmlFor={id}>{field.label}</Label>
                      <Input
                        id={id}
                        type="number"
                        inputMode="numeric"
                        value={typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? raw : ''}
                        min={field.min}
                        max={field.max}
                        disabled={saving}
                        onChange={(e) =>
                          setField(field.key, e.target.value === '' ? '' : Number(e.target.value))
                        }
                      />
                    </div>
                  )
                case 'textarea':
                  return (
                    <div key={field.key} className="space-y-2 sm:col-span-2">
                      <Label htmlFor={id}>{field.label}</Label>
                      <Textarea
                        id={id}
                        rows={field.rows ?? 3}
                        maxLength={field.maxLength}
                        value={typeof raw === 'string' ? raw : ''}
                        disabled={saving}
                        onChange={(e) => setField(field.key, e.target.value)}
                      />
                    </div>
                  )
                case 'select':
                  return (
                    <div key={field.key} className="space-y-2">
                      <Label htmlFor={id}>{field.label}</Label>
                      <Select
                        value={typeof raw === 'string' && raw !== '' ? raw : undefined}
                        onValueChange={(v) => setField(field.key, v)}
                        disabled={saving}
                      >
                        <SelectTrigger id={id} className="w-full">
                          <SelectValue placeholder="Select…" />
                        </SelectTrigger>
                        <SelectContent>
                          {field.options.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                case 'toggle':
                  return (
                    <div key={field.key} className="flex items-center justify-between gap-4 rounded-md border p-3.5 sm:col-span-2">
                      <div className="min-w-0">
                        <Label htmlFor={id} className="text-[13.5px] font-medium">
                          {field.label}
                        </Label>
                        {field.description ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">{field.description}</p>
                        ) : null}
                      </div>
                      <Switch
                        id={id}
                        checked={raw === true}
                        onCheckedChange={(v) => setField(field.key, v)}
                        disabled={saving}
                      />
                    </div>
                  )
                case 'chips':
                  return (
                    <div key={field.key} className="space-y-2.5 sm:col-span-2">
                      <Label>{field.label}</Label>
                      <div className="flex flex-wrap gap-2" role="group" aria-label={field.label}>
                        {field.options.map((option) => {
                          const list = Array.isArray(raw) ? (raw as string[]) : []
                          const on = list.includes(option)
                          return (
                            <button
                              key={option}
                              type="button"
                              aria-pressed={on}
                              disabled={saving}
                              onClick={() =>
                                setField(
                                  field.key,
                                  on ? list.filter((m) => m !== option) : [...list, option]
                                )
                              }
                              className={cn(
                                'rounded-full border px-3.5 py-1.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
                                on
                                  ? 'border-primary/30 bg-primary/10 text-primary'
                                  : 'bg-background text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                              )}
                            >
                              {option}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                default:
                  return null
              }
            })}
          </div>

          <div className="flex items-center justify-end gap-3 border-t pt-5">
            {dirty ? (
              <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
                Unsaved changes
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={saving || !dirty}
              onClick={() => setDraft({ ...value })}
            >
              Reset
            </Button>
            <Button type="submit" disabled={saving || !dirty}>
              {saving ? (
                'Saving…'
              ) : (
                <>
                  <Save className="size-4" aria-hidden="true" />
                  Save
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
