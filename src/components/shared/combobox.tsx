'use client'

import * as React from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ComboboxOption {
  value: string
  label: string
  description?: string
}

/**
 * Accessible combobox (searchable select) built on cmdk + Radix Popover.
 * Keyboard: opens on click/Enter, filters by typing, Enter selects, Esc closes.
 */
export function Combobox({
  options,
  value,
  onValueChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No match found.',
  disabled,
  name,
  className,
  triggerClassName,
  'aria-label': ariaLabel,
  id,
}: {
  options: ComboboxOption[]
  value: string | undefined | null
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  name?: string
  className?: string
  triggerClassName?: string
  'aria-label'?: string
  id?: string
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((o) => o.value === value)

  return (
    <div className={className}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            name={name}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={ariaLabel ?? placeholder}
            disabled={disabled}
            className={cn(
              'h-9 w-full justify-between font-normal',
              !selected && 'text-muted-foreground',
              triggerClassName
            )}
          >
            <span className="min-w-0 truncate">{selected ? selected.label : placeholder}</span>
            <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList className="thin-scrollbar">
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.value}`}
                    onSelect={() => {
                      onValueChange(option.value)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn('size-4', selected?.value === option.value ? 'opacity-100' : 'opacity-0')}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.description ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{option.description}</span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {/* Hidden input so combobox participates in native form semantics */}
      <input type="hidden" name={name} value={value ?? ''} />
    </div>
  )
}
