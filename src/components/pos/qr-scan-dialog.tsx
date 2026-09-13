'use client'

import * as React from 'react'
import jsQR from 'jsqr'
import { Camera, QrCode, Vibrate, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CameraScanStatus } from '@/components/pos/scanner-status'

/**
 * Camera QR scanning (Phase 8 Parts 9/10).
 *
 * Decode chain:
 *   1. BarcodeDetector API where the browser ships it (Chrome/Edge/Android).
 *   2. SOFTWARE fallback: frames are drawn to a canvas and decoded with jsQR —
 *      this is what makes the camera work in Firefox, Safari and iOS Safari,
 *      which do not implement BarcodeDetector.
 *
 * The POS is NEVER dependent on the camera: USB/Bluetooth scanners and manual
 * entry remain fully functional without it.
 *
 * Status taxonomy (all states are reported to the parent for the device box):
 *   starting → scanning | denied | no_camera | insecure | unsupported
 */
export function QrScanDialog({
  open,
  onOpenChange,
  onIdentifier,
  onStatusChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onIdentifier: (value: string) => void
  onStatusChange?: (status: CameraScanStatus) => void
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const detectorRef = React.useRef<{ detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } | null>(null)
  const deliveredRef = React.useRef(false) // one code per dialog-open (duplicate guard)
  const timerRef = React.useRef<number | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'starting' | 'scanning' | 'denied' | 'no_camera' | 'insecure' | 'unsupported'>('idle')
  const [flash, setFlash] = React.useState(false)

  const reportStatus = React.useCallback(
    (next: typeof status) => {
      setStatus(next)
      onStatusChange?.(next === 'idle' ? 'not_opened' : (next as CameraScanStatus))
    },
    [onStatusChange],
  )

  const stop = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    detectorRef.current = null
  }, [])

  React.useEffect(() => {
    if (!open) {
      stop()
      reportStatus('idle')
      return
    }
    let cancelled = false
    deliveredRef.current = false

    const deliver = (value: string) => {
      if (deliveredRef.current) return // duplicate-frame guard
      if (!value.trim()) return
      deliveredRef.current = true
      setFlash(true)
      window.setTimeout(() => setFlash(false), 250)
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(80)
        } catch {
          // haptics are best-effort only
        }
      }
      onIdentifier(value.trim())
    }

    const start = async () => {
      // Secure-context / API availability first — honest root causes, never
      // a blanket "not supported" when the real issue is HTTP vs HTTPS.
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        reportStatus(typeof window !== 'undefined' && !window.isSecureContext ? 'insecure' : 'unsupported')
        return
      }
      reportStatus('starting')
      try {
        const Ctor = (window as unknown as { BarcodeDetector?: new (opts?: { formats?: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } }).BarcodeDetector
        if (Ctor) {
          detectorRef.current = new Ctor({ formats: ['qr_code'] })
        }
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
        reportStatus('scanning')

        if (detectorRef.current) {
          const nativeTick = async () => {
            if (cancelled || !detectorRef.current || !videoRef.current) return
            try {
              const codes = await detectorRef.current.detect(videoRef.current)
              const value = codes[0]?.rawValue
              if (value) {
                deliver(value)
                return
              }
            } catch {
              // transient detect failures are retried
            }
            if (!cancelled) timerRef.current = window.setTimeout(() => void nativeTick(), 120)
          }
          void nativeTick()
        } else {
          // SOFTWARE decode path — works in Firefox / Safari / iOS Safari.
          // Downscaled canvas + throttled ~200ms loop keeps CPU usage low.
          const canvas = document.createElement('canvas')
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          const softwareTick = () => {
            const video = videoRef.current
            if (cancelled || !ctx || !video || video.videoWidth === 0) {
              if (!cancelled) timerRef.current = window.setTimeout(softwareTick, 200)
              return
            }
            try {
              const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight))
              canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
              canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
              const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
              const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' })
              if (found?.data) {
                deliver(found.data)
                return
              }
            } catch {
              // transient decode failures are retried
            }
            if (!cancelled) timerRef.current = window.setTimeout(softwareTick, 200)
          }
          softwareTick()
        }
      } catch (err) {
        if (cancelled) return
        const name = (err as { name?: string })?.name ?? ''
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
          reportStatus('denied')
        } else if (
          name === 'NotFoundError' ||
          name === 'DevicesNotFoundError' ||
          name === 'OverconstrainedError' ||
          name === 'NotReadableError'
        ) {
          reportStatus('no_camera')
        } else {
          reportStatus('unsupported')
        }
      }
    }
    void start()
    return () => {
      cancelled = true
      stop()
    }
  }, [open]) // deliver/start close over the latest props per open-cycle

  const message =
    status === 'starting'
      ? 'Starting camera…'
      : status === 'denied'
        ? 'Camera permission was denied. Allow camera access in your browser settings, or use the scanner input / search instead.'
        : status === 'no_camera'
          ? 'No camera was found on this device. Use the scanner input or search instead.'
          : status === 'insecure'
            ? 'The camera needs a secure connection. Open this app over HTTPS (or localhost) — plain HTTP blocks camera access.'
            : status === 'unsupported'
              ? 'Camera scanning is not available in this browser. Use the scanner input or search instead.'
              : 'Camera preview'

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
            {flash ? <div className="absolute inset-0 animate-pulse bg-success/30" aria-hidden="true" /> : null}
            {status !== 'scanning' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center">
                <Camera className="size-8 text-white/70" aria-hidden="true" />
                <p className="text-sm text-white/80">{message}</p>
                {status === 'denied' || status === 'no_camera' || status === 'insecure' || status === 'unsupported' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1"
                    onClick={() => {
                      // Retry re-runs the whole open-cycle (permission prompts
                      // again after the user re-enables them in the browser).
                      stop()
                      onOpenChange(false)
                      window.setTimeout(() => onOpenChange(true), 150)
                    }}
                  >
                    <Vibrate className="size-4" aria-hidden="true" />
                    Retry camera
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            USB/Bluetooth scanners and manual entry work without the camera (F2 focuses search).
            {'BarcodeDetector' in (typeof window !== 'undefined' ? window : {})
              ? ' Decoding with this browser\u2019s built-in barcode detector.'
              : ' Decoding in software — works in every modern browser.'}
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
