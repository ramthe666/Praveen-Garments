'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Camera, QrCode, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Camera QR scanning using the BarcodeDetector API where the browser
 * supports it. The POS is NEVER dependent on this: USB scanners and manual
 * entry remain fully functional without camera support.
 */
export function QrScanDialog({
  open,
  onOpenChange,
  onIdentifier,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onIdentifier: (value: string) => void
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const detectorRef = React.useRef<{ detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'starting' | 'scanning' | 'unsupported' | 'denied'>('idle')

  const stop = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    detectorRef.current = null
  }, [])

  React.useEffect(() => {
    if (!open) {
      stop()
      setStatus('idle')
      return
    }
    let cancelled = false
    let raf = 0

    const start = async () => {
      const Ctor = (window as unknown as { BarcodeDetector?: new (opts?: { formats?: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } }).BarcodeDetector
      if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
        setStatus('unsupported')
        return
      }
      setStatus('starting')
      try {
        detectorRef.current = new Ctor({ formats: ['qr_code'] })
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => undefined)
        }
        setStatus('scanning')
        const tick = async () => {
          if (cancelled || !detectorRef.current || !videoRef.current) return
          try {
            const codes = await detectorRef.current.detect(videoRef.current)
            const value = codes[0]?.rawValue
            if (value) {
              onIdentifier(value.trim())
              return
            }
          } catch {
            // transient detect failures are retried silently
          }
          raf = requestAnimationFrame(() => void tick())
        }
        void tick()
      } catch (err) {
        if (cancelled) return
        const name = (err as { name?: string })?.name ?? ''
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setStatus('denied')
        } else {
          setStatus('unsupported')
        }
      }
    }
    void start()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stop()
    }
  }, [open, onIdentifier, stop])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { stop() } onOpenChange(next) }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="size-4 text-muted-foreground" aria-hidden="true" />
            Scan QR code
          </DialogTitle>
          <DialogDescription>Point the camera at the product QR label.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative aspect-square w-full overflow-hidden rounded-md border bg-black">
            <video
              ref={videoRef}
              className="size-full object-cover"
              muted
              playsInline
              aria-label="Camera QR scanner preview"
            />
            {status !== 'scanning' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center">
                <Camera className="size-8 text-white/70" aria-hidden="true" />
                <p className="text-sm text-white/80">
                  {status === 'starting'
                    ? 'Starting camera…'
                    : status === 'denied'
                      ? 'Camera permission was denied. Use the scanner input or search instead.'
                      : status === 'unsupported'
                        ? 'Camera QR scanning is not supported in this browser. Use the barcode scanner input or search instead.'
                        : 'Camera preview'}
                </p>
              </div>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            USB scanners and manual entry work without the camera (F2 focuses search).
          </p>
          <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
            <X className="size-4" aria-hidden="true" />
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** No-op used to keep toast import meaningful for future use. */
export function unusedToastGuard() {
  return toast
}
