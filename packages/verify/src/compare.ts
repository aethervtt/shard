import { ShardError } from '@aethervtt/shard-core'

/** 8-bit RGBA with straight (not premultiplied) alpha, rows top to bottom: a decoded PNG. */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

/** How different a capture may be from its approved image (per shot, in the plan). */
export interface Tolerance {
  /** ΔE2000 over which a pixel counts as changed. Default 2.3, about one just-noticeable difference. */
  deltaE?: number
  /** Share of pixels (0 to 1) allowed to change. Default 0.001. */
  maxShare?: number
  /** Lowest structural similarity allowed. Default 0.98. */
  minSsim?: number
}

export const DEFAULT_TOLERANCE: Required<Tolerance> = {
  deltaE: 2.3,
  maxShare: 0.001,
  minSsim: 0.98,
}

export interface ImageDiff {
  pass: boolean
  /** Why it failed, in a sentence; undefined when it passed. */
  reason: string | undefined
  /** Pixels over the ΔE threshold. */
  changed: number
  /** `changed` over all pixels. */
  share: number
  maxDeltaE: number
  /** Mean SSIM over 8×8 windows of luminance. */
  ssim: number
  /** ΔE2000 of every pixel, row by row (for the heatmap). */
  deltaE: Float32Array
  tolerance: Required<Tolerance>
}

/**
 * A perceptual diff (0062): each pixel's ΔE2000 in Lab, and SSIM over luminance. Dithering and
 * driver noise stay under a just-noticeable difference, so they don't count; a shifted grid line
 * or a lost shadow does. Alpha counts too: pixels are compared composited over black and over
 * white, and the larger difference wins, so a transparent surface that turns opaque is a change.
 */
export function compareImages(
  approved: RgbaImage,
  capture: RgbaImage,
  tolerance: Tolerance = {},
): ImageDiff {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance }
  if (approved.width !== capture.width || approved.height !== capture.height) {
    throw new ShardError(
      'verify/size-mismatch',
      `The capture is ${capture.width}×${capture.height}, the approved image ${approved.width}×${approved.height}`,
      { hint: 'Check the viewport and DPR in the plan, or approve the new size with a reason.' },
    )
  }
  const n = approved.width * approved.height
  const deltaE = new Float32Array(n)
  const a = approved.data
  const b = capture.data
  const labA = new Float64Array(6)
  const labB = new Float64Array(6)
  let changed = 0
  let maxDeltaE = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2] && a[o + 3] === b[o + 3]) {
      continue
    }
    composites(a, o, labA)
    composites(b, o, labB)
    const onBlack = deltaE2000(labA[0]!, labA[1]!, labA[2]!, labB[0]!, labB[1]!, labB[2]!)
    const onWhite = deltaE2000(labA[3]!, labA[4]!, labA[5]!, labB[3]!, labB[4]!, labB[5]!)
    const d = onBlack > onWhite ? onBlack : onWhite
    deltaE[i] = d
    if (d > tol.deltaE) changed++
    if (d > maxDeltaE) maxDeltaE = d
  }
  const share = n === 0 ? 0 : changed / n
  const ssim = meanSsim(approved, capture)
  let reason: string | undefined
  if (share > tol.maxShare) {
    reason = `${(share * 100).toFixed(2)}% of pixels changed (ΔE2000 > ${tol.deltaE}); ${(tol.maxShare * 100).toFixed(2)}% allowed`
  } else if (ssim < tol.minSsim) {
    reason = `SSIM ${ssim.toFixed(4)} is under ${tol.minSsim}`
  }
  return { pass: !reason, reason, changed, share, maxDeltaE, ssim, deltaE, tolerance: tol }
}

/**
 * A heatmap of a diff as RGBA: unchanged pixels are a dim gray copy of the approved image's
 * luminance, changes go from yellow (just over the threshold) to red (ΔE 20 and up).
 */
export function diffHeatmap(approved: RgbaImage, diff: ImageDiff): Uint8Array {
  const n = approved.width * approved.height
  const out = new Uint8Array(n * 4)
  const src = approved.data
  const threshold = diff.tolerance.deltaE
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const d = diff.deltaE[i]!
    if (d > threshold) {
      const t = Math.min(1, (d - threshold) / (20 - threshold))
      out[o] = 255
      out[o + 1] = Math.round(220 * (1 - t))
      out[o + 2] = 0
    } else {
      const y =
        (0.2126 * src[o]! + 0.7152 * src[o + 1]! + 0.0722 * src[o + 2]!) * (src[o + 3]! / 255)
      const gray = Math.round(40 + y * 0.25)
      out[o] = gray
      out[o + 1] = gray
      out[o + 2] = gray
    }
    out[o + 3] = 255
  }
  return out
}

// --- color ---------------------------------------------------------------------------------------

/** sRGB (8-bit) to linear, once. */
const LINEAR = new Float64Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * The pixel at `o`, composited over black then over white (in linear light, as a browser does),
 * as Lab: out[0..2] over black, out[3..5] over white.
 */
function composites(data: Uint8Array | Uint8ClampedArray, o: number, out: Float64Array): void {
  const alpha = data[o + 3]! / 255
  const r = LINEAR[data[o]!]! * alpha
  const g = LINEAR[data[o + 1]!]! * alpha
  const b = LINEAR[data[o + 2]!]! * alpha
  linearToLab(r, g, b, out, 0)
  const white = 1 - alpha
  linearToLab(r + white, g + white, b + white, out, 3)
}

/** D65 white. */
const XN = 0.95047
const ZN = 1.08883

function linearToLab(r: number, g: number, b: number, out: Float64Array, at: number): void {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN
  const fx = labF(x)
  const fy = labF(y)
  const fz = labF(z)
  out[at] = 116 * fy - 16
  out[at + 1] = 500 * (fx - fy)
  out[at + 2] = 200 * (fy - fz)
}

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116
}

const DEG = Math.PI / 180
const POW25_7 = 25 ** 7

/** CIEDE2000 color difference (Sharma, Wu and Dalal's formulation), kL = kC = kH = 1. */
export function deltaE2000(
  L1: number,
  a1: number,
  b1: number,
  L2: number,
  a2: number,
  b2: number,
): number {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1)
  const C2 = Math.sqrt(a2 * a2 + b2 * b2)
  const Cm7 = ((C1 + C2) / 2) ** 7
  const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + POW25_7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.sqrt(a1p * a1p + b1 * b1)
  const C2p = Math.sqrt(a2p * a2p + b2 * b2)
  const h1p = hueDegrees(b1, a1p)
  const h2p = hueDegrees(b2, a2p)
  const dLp = L2 - L1
  const dCp = C2p - C1p
  const chroma = C1p * C2p
  let dhp = 0
  if (chroma !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(chroma) * Math.sin((dhp / 2) * DEG)
  const Lpm = (L1 + L2) / 2
  const Cpm = (C1p + C2p) / 2
  let hpm = h1p + h2p
  if (chroma !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hpm = (h1p + h2p) / 2
    else hpm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
  }
  const T =
    1 -
    0.17 * Math.cos((hpm - 30) * DEG) +
    0.24 * Math.cos(2 * hpm * DEG) +
    0.32 * Math.cos((3 * hpm + 6) * DEG) -
    0.2 * Math.cos((4 * hpm - 63) * DEG)
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2))
  const Cpm7 = Cpm ** 7
  const Rc = 2 * Math.sqrt(Cpm7 / (Cpm7 + POW25_7))
  const L50 = (Lpm - 50) ** 2
  const Sl = 1 + (0.015 * L50) / Math.sqrt(20 + L50)
  const Sc = 1 + 0.045 * Cpm
  const Sh = 1 + 0.015 * Cpm * T
  const Rt = -Math.sin(2 * dTheta * DEG) * Rc
  const l = dLp / Sl
  const c = dCp / Sc
  const h = dHp / Sh
  return Math.sqrt(l * l + c * c + h * h + Rt * c * h)
}

function hueDegrees(b: number, a: number): number {
  if (a === 0 && b === 0) return 0
  const h = Math.atan2(b, a) / DEG
  return h < 0 ? h + 360 : h
}

// --- structure -----------------------------------------------------------------------------------

const WINDOW = 8
const STRIDE = 4
const C1 = (0.01 * 255) ** 2
const C2 = (0.03 * 255) ** 2

/** Luminance (0 to 255) of each pixel composited over mid gray, where alpha differences show. */
function luminance(image: RgbaImage): Float32Array {
  const n = image.width * image.height
  const out = new Float32Array(n)
  const d = image.data
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const alpha = d[o + 3]! / 255
    const y = 0.2126 * d[o]! + 0.7152 * d[o + 1]! + 0.0722 * d[o + 2]!
    out[i] = y * alpha + 128 * (1 - alpha)
  }
  return out
}

/** Mean SSIM over 8×8 windows every 4 pixels. Images smaller than a window compare as one. */
function meanSsim(a: RgbaImage, b: RgbaImage): number {
  const width = a.width
  const height = a.height
  const x = luminance(a)
  const y = luminance(b)
  const w = Math.min(WINDOW, width)
  const h = Math.min(WINDOW, height)
  if (w === 0 || h === 0) return 1
  let total = 0
  let windows = 0
  for (let top = 0; top + h <= height; top += STRIDE) {
    for (let left = 0; left + w <= width; left += STRIDE) {
      let sx = 0
      let sy = 0
      let sxx = 0
      let syy = 0
      let sxy = 0
      for (let j = 0; j < h; j++) {
        const row = (top + j) * width + left
        for (let i = 0; i < w; i++) {
          const p = x[row + i]!
          const q = y[row + i]!
          sx += p
          sy += q
          sxx += p * p
          syy += q * q
          sxy += p * q
        }
      }
      const count = w * h
      const mx = sx / count
      const my = sy / count
      const vx = sxx / count - mx * mx
      const vy = syy / count - my * my
      const cov = sxy / count - mx * my
      total += ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2))
      windows++
    }
  }
  return windows === 0 ? 1 : total / windows
}
