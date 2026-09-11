'use client'

import QRCode from 'react-qr-code'
import { cn } from '@/lib/utils'

/**
 * QR renderer for variant identifiers. The QR encodes the identifier string
 * itself — scanning it and looking the value up (find_variant_by_identifier)
 * resolves the exact variant. Works with any camera/QR scanner; no special
 * hardware needed.
 */
export function QrCodeSvg({
  value,
  size = 64,
  className,
}: {
  value: string | null | undefined
  size?: number
  className?: string
}) {
  if (!value) {
    return (
      <span className={cn('text-xs text-muted-foreground', className)} aria-label="No QR identifier">
        —
      </span>
    )
  }
  return (
    <span className={cn('inline-flex items-center justify-center', className)}>
      <QRCode value={value} size={size} bgColor="#ffffff" fgColor="#000000" level="M" />
      <span className="sr-only">QR {value}</span>
    </span>
  )
}
