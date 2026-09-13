/**
 * Phase 8, Parts 9/10 — SOFTWARE-LEVEL verification of the camera QR decode
 * pipeline (the jsQR fallback path used by the POS camera scanner).
 *
 * Chain proven here: payload -> QR matrix -> raw RGBA pixels -> jsQR ->
 * decoded payload. This is exactly what QrScanDialog does with camera frames
 * (drawImage -> getImageData -> jsQR), minus the physical camera.
 *
 * It does NOT claim a physical camera test — that remains NOT TESTED.
 */
import QRCode from 'qrcode'
import jsQR from 'jsqr'

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`) }
}

async function main() {
  const payloads = [
    'PGQR-A1B2C3D4E5F6G7H8',            // typical product QR identifier
    'PGQR-0000000000000001',             // minimal digits
    'SKU-SHIRT-BLUE-M',                  // SKU-style
    '8901234567895',                     // EAN-13 barcode digits
    'https://pos.praveengarments.local/x?q=PGQR-Z9Y8X7W6V5U4', // URL payload
  ]

  // module scale 8, margin 4 — a realistic phone-photo-like size
  for (const payload of payloads) {
    const matrix = QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules
    const size = matrix.size * 8 + 8 // scale 8, quiet zone 4 modules each side
    const px = new Uint8ClampedArray(size * size * 4).fill(255)
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (matrix.get(r, c)) {
          for (let dy = 0; dy < 8; dy++) {
            for (let dx = 0; dx < 8; dx++) {
              const y = (r * 8 + 4 + dy) * size
              const x = c * 8 + 4 + dx
              const i = (y + x) * 4
              px[i] = 0; px[i + 1] = 0; px[i + 2] = 0
            }
          }
        }
      }
    }
    const decoded = jsQR(px, size, size, { inversionAttempts: 'dontInvert' })
    check(`decode round-trip: ${payload.slice(0, 24)}${payload.length > 24 ? '…' : ''}`,
      decoded?.data === payload, decoded?.data)

    // downscale to ~320px long edge (the dialog caps at 640; test a harder case)
    const scale = 320 / Math.max(size, 320)
    if (scale < 1) {
      const w = Math.round(size * scale)
      const small = new Uint8ClampedArray(w * w * 4)
      for (let y = 0; y < w; y++) {
        for (let x = 0; x < w; x++) {
          const sy = Math.min(size - 1, Math.round(y / scale))
          const sx = Math.min(size - 1, Math.round(x / scale))
          const si = (sy * size + sx) * 4
          const di = (y * w + x) * 4
          small[di] = px[si]; small[di + 1] = px[si + 1]; small[di + 2] = px[si + 2]; small[di + 3] = 255
        }
      }
      const decodedSmall = jsQR(small, w, w, { inversionAttempts: 'dontInvert' })
      check(`decode at 320px downscale: ${payload.slice(0, 24)}${payload.length > 24 ? '…' : ''}`,
        decodedSmall?.data === payload, decodedSmall?.data)
    }
  }

  // negative: noise must NOT decode
  const noise = new Uint8ClampedArray(320 * 320 * 4)
  for (let i = 0; i < noise.length; i += 4) {
    const v = Math.random() > 0.5 ? 0 : 255
    noise[i] = v; noise[i + 1] = v; noise[i + 2] = v; noise[i + 3] = 255
  }
  const noiseResult = jsQR(noise, 320, 320, { inversionAttempts: 'dontInvert' })
  check('random noise does not decode (no false positives)', noiseResult == null)

  console.log(`\nQR software decode suite: ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log('FAILED:', failures.join(' | ')); process.exitCode = 1 }
}

await main().catch((e) => { console.error(e); process.exit(1) })
