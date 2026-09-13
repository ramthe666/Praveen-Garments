'use client'

/**
 * POS scanning-device status box (Phase 8 Parts 5/6/47).
 *
 * TRUTHFULNESS CONTRACT — this component deliberately never claims a hardware
 * link it cannot know:
 * - USB / Bluetooth barcode scanners present themselves to the browser as
 *   keyboards (HID). A web page CANNOT tell a scanner from typed keys, and
 *   cannot see USB/Bluetooth link state. So the box says exactly that.
 * - "Ready" means: the scanner input field exists and is focused — the
 *   software is ready to receive scans, which is what the cashier needs.
 * - Camera states come from the camera's own runtime outcomes (permission,
 *   device availability), never from a fake probe.
 * - The last-scan line is filled ONLY by real scan events.
 */
import * as React from 'react'
import { ScanBarcode, Video, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type CameraScanStatus =
  | 'not_opened' // camera dialog not used this session
  | 'starting'
  | 'scanning'
  | 'denied' // permission refused
  | 'no_camera' // no camera device found
  | 'insecure' // page not in a secure context (needs HTTPS)
  | 'unsupported' // no decode path available (should not happen with jsQR)

export interface LastScan {
  at: number
  code: string
}

function maskCode(code: string): string {
  const trimmed = code.trim()
  if (trimmed.length <= 10) return trimmed
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

const CAMERA_LABELS: Record<CameraScanStatus, string> = {
  not_opened: 'Not opened this session',
  starting: 'Starting…',
  scanning: 'Scanning',
  denied: 'Permission required (was denied)',
  no_camera: 'No camera found on this device',
  insecure: 'Needs HTTPS (insecure page)',
  unsupported: 'Not supported in this browser',
}

export function ScannerStatusBox({
  lastScan,
  scannerFocused,
  cameraStatus,
  cameraDecoder,
}: {
  lastScan: LastScan | null
  scannerFocused: boolean
  cameraStatus: CameraScanStatus
  cameraDecoder: 'native' | 'software' | 'unknown'
}) {
  const scannerReady = scannerFocused
  return (
    <section
      aria-label="Scanning devices status"
      className="rounded-xl border border-border/70 bg-card p-3 text-xs shadow-xs"
    >
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <ScanBarcode className="size-3.5" aria-hidden="true" />
        Scanning devices
      </h3>

      <div className="mt-2 space-y-2">
        {/* --- PC / wired-or-wireless HID scanner input ----------------- */}
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={cn('mt-1 size-2 shrink-0 rounded-full', scannerReady ? 'bg-success' : 'bg-muted-foreground/50')}
          />
          <div className="min-w-0">
            <p className="font-medium">
              Scanner input{scannerReady ? ' — Ready' : ' — Waiting for input'}
            </p>
            <p className="text-muted-foreground">
              Input: Keyboard/HID · USB &amp; Bluetooth scanners work the same way
            </p>
            {lastScan ? (
              <p className="tabular-nums text-muted-foreground">
                Last scan: {timeLabel(lastScan.at)} · {maskCode(lastScan.code)}
              </p>
            ) : (
              <p className="text-muted-foreground">Last scan: —</p>
            )}
            <p className="flex items-center gap-1 text-muted-foreground/80">
              <HelpCircle className="size-3 shrink-0" aria-hidden="true" />
              Hardware connection status is not detectable by the browser
            </p>
          </div>
        </div>

        {/* --- Phone / webcam camera ------------------------------------ */}
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={cn(
              'mt-1 size-2 shrink-0 rounded-full',
              cameraStatus === 'scanning' && 'bg-success animate-pulse',
              cameraStatus === 'starting' && 'bg-warning animate-pulse',
              cameraStatus === 'not_opened' && 'bg-muted-foreground/50',
              (cameraStatus === 'denied' || cameraStatus === 'no_camera' || cameraStatus === 'insecure' || cameraStatus === 'unsupported') && 'bg-destructive',
            )}
          />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-medium">
              <Video className="size-3.5 shrink-0" aria-hidden="true" />
              Camera — {CAMERA_LABELS[cameraStatus]}
            </p>
            <p className="text-muted-foreground">
              Decoder:{' '}
              {cameraDecoder === 'native'
                ? 'BarcodeDetector (built-in)'
                : cameraDecoder === 'software'
                  ? 'software (works in all browsers)'
                  : cameraStatus === 'not_opened'
                    ? 'checked when the camera opens'
                    : '—'}
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * Capability probe for the camera row — NO permission is requested. Only
 * answers "could this browser open a camera here at all?" and "which decoder
 * would it use?" — both truthfully determinable without any hardware access.
 */
export function probeCameraCapabilities(): {
  canOpen: boolean
  insecureContext: boolean
  decoder: 'native' | 'software'
} {
  if (typeof window === 'undefined') return { canOpen: false, insecureContext: false, decoder: 'software' }
  const insecureContext = !window.isSecureContext
  const hasMedia = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  const native = 'BarcodeDetector' in window
  return { canOpen: hasMedia, insecureContext: insecureContext || !hasMedia, decoder: native ? 'native' : 'software' }
}
