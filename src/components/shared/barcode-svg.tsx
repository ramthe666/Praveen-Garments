'use client'

import * as React from 'react'
import JsBarcode from 'jsbarcode'
import { cn } from '@/lib/utils'

/**
 * Barcode renderer (client-side SVG via JsBarcode).
 *
 * Format rules:
 *   - 13 digits  -> EAN-13 (retail scanners read it natively; generated
 *                  barcodes from the DB are EAN-13 in the in-store 20-29 range)
 *   - 8 digits   -> EAN-8
 *   - anything else (e.g. a SKU) -> CODE128 (universal fallback)
 *
 * When `barcode` is empty the SKU is rendered as CODE128 so every label is
 * always scannable (common retail practice).
 */
export function BarcodeSvg({
  value,
  height = 40,
  width = 1.4,
  displayValue = false,
  fontSize = 12,
  className,
  fallbackToSku = true,
  sku,
}: {
  value: string | null | undefined
  height?: number
  width?: number
  displayValue?: boolean
  fontSize?: number
  className?: string
  fallbackToSku?: boolean
  sku?: string | null
}) {
  const ref = React.useRef<SVGSVGElement>(null)
  const effective = value ?? (fallbackToSku ? (sku ?? null) : null)

  React.useEffect(() => {
    const svg = ref.current
    if (!svg) return
    if (!effective) {
      while (svg.firstChild) svg.removeChild(svg.firstChild)
      return
    }
    try {
      JsBarcode(svg, effective, {
        format: /^\d{13}$/.test(effective) ? 'EAN13' : /^\d{8}$/.test(effective) ? 'EAN8' : 'CODE128',
        height,
        width,
        displayValue,
        fontSize,
        margin: 0,
        background: 'transparent',
        lineColor: '#000000',
        valid: (ok) => {
          if (!ok) {
            // e.g. an invalid EAN checksum typed manually — render SKU instead
            while (svg.firstChild) svg.removeChild(svg.firstChild)
            if (fallbackToSku && sku) {
              try {
                JsBarcode(svg, sku, { format: 'CODE128', height, width, displayValue, fontSize, margin: 0, background: 'transparent' })
              } catch {
                /* give up silently — the text fallback below shows the raw value */
              }
            }
          }
        },
      })
    } catch {
      // invalid input for the chosen format — clear and let the caller's text
      // fallback communicate the identifier
      while (svg.firstChild) svg.removeChild(svg.firstChild)
    }
  }, [effective, height, width, displayValue, fontSize, fallbackToSku, sku])

  if (!effective) {
    return (
      <span className={cn('text-xs text-muted-foreground', className)} aria-label="No barcode">
        —
      </span>
    )
  }

  return (
    <span className={cn('inline-flex flex-col items-center', className)}>
      <svg ref={ref} role="img" aria-label={`Barcode ${effective}`} />
      {displayValue ? null : <span className="sr-only">{effective}</span>}
    </span>
  )
}
