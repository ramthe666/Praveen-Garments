'use client'

import Image from 'next/image'

/**
 * Company logo with graceful fallback to a "PG" monogram tile.
 * `logoUrl` comes from Supabase Storage (company_settings.logo_url);
 * nothing about branding is hardcoded beyond the fallback glyph.
 */
export function AppLogo({
  logoUrl,
  companyName,
  size = 36,
  className,
}: {
  logoUrl?: string | null
  companyName?: string
  size?: number
  className?: string
}) {
  const initials = (companyName ?? 'PG')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

  if (logoUrl) {
    return (
      <Image
        src={logoUrl}
        alt={`${companyName ?? 'Company'} logo`}
        width={size}
        height={size}
        className={`shrink-0 rounded-md object-contain ${className ?? ''}`}
        priority
        unoptimized
      />
    )
  }

  return (
    <span
      aria-label={`${companyName ?? 'Company'} logo`}
      role="img"
      style={{ width: size, height: size, fontSize: Math.max(11, size * 0.38) }}
      className={`flex shrink-0 select-none items-center justify-center rounded-md bg-primary font-semibold tracking-wide text-primary-foreground ${className ?? ''}`}
    >
      {initials || 'PG'}
    </span>
  )
}
