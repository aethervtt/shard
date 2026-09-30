import { featheredCoverage } from '@aethervtt/shard-vector'
import type { FogRegion } from './components'

// A CPU raster of a fog layer's mask (0058), made the way the GPU makes it: the same tessellation,
// vertices snapped to 1/256 of a texel, texel centers tested with the top-left rule, each region
// applied once per texel (its first triangle there), its value rounded to 8 bits before blending and
// the result after, as an r8unorm target does. Tests hold
// the GPU's masks to it.

export interface ReferenceLayer {
  base: 'hidden' | 'revealed'
  /** min x, min z, max x, max z. */
  extent: readonly [number, number, number, number]
  width: number
  height: number
  /** World units per texel: sets the tessellation's arc error as the GPU path does. */
  texelSize: number
}

const SUB = 256

export function referenceMask(regions: readonly FogRegion[], layer: ReferenceLayer): Uint8Array {
  const { width, height } = layer
  const mask = new Uint8Array(width * height).fill(layer.base === 'hidden' ? 255 : 0)
  const stamp = new Int32Array(width * height)
  const [minX, minZ, maxX, maxZ] = layer.extent
  const f = Math.fround
  const ox = f(minX)
  const oz = f(minZ)
  const sx = f(1 / (maxX - minX))
  const sz = f(1 / (maxZ - minZ))
  const error = Math.max(0.001, layer.texelSize * 0.25)
  // Vertex → snapped texel coordinates (y down), in 1/256 units, as the shader and rasterizer do.
  const toX = (x: number) => Math.round(f(f(f(x) - ox) * sx) * width * SUB)
  const toY = (z: number) => Math.round(f(f(f(z) - oz) * sz) * height * SUB)
  for (let r = 0; r < regions.length; r++) {
    const region = regions[r]!
    const hide = region.op === 'hide'
    const strength = region.strength ?? 1
    const mesh = featheredCoverage(region.shape, { feather: region.feather ?? 0, error })
    const n = mesh.coverage.length
    const px = new Float64Array(n)
    const py = new Float64Array(n)
    const cv = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      px[i] = toX(mesh.positions[i * 2]!)
      py[i] = toY(mesh.positions[i * 2 + 1]!)
      cv[i] = f(mesh.coverage[i]! * strength)
    }
    const id = r + 1
    const idx = mesh.indices
    for (let t = 0; t < idx.length; t += 3) {
      let a = idx[t]!
      let b = idx[t + 1]!
      const c = idx[t + 2]!
      let area = (px[b]! - px[a]!) * (py[c]! - py[a]!) - (py[b]! - py[a]!) * (px[c]! - px[a]!)
      if (area === 0) continue
      if (area < 0) {
        const s = a
        a = b
        b = s
        area = -area
      }
      const x0 = Math.max(0, Math.floor(Math.min(px[a]!, px[b]!, px[c]!) / SUB))
      const x1 = Math.min(width - 1, Math.ceil(Math.max(px[a]!, px[b]!, px[c]!) / SUB))
      const y0 = Math.max(0, Math.floor(Math.min(py[a]!, py[b]!, py[c]!) / SUB))
      const y1 = Math.min(height - 1, Math.ceil(Math.max(py[a]!, py[b]!, py[c]!) / SUB))
      for (let y = y0; y <= y1; y++) {
        const cy = y * SUB + SUB / 2
        for (let x = x0; x <= x1; x++) {
          const cx = x * SUB + SUB / 2
          const w0 = edge(px[b]!, py[b]!, px[c]!, py[c]!, cx, cy)
          const w1 = edge(px[c]!, py[c]!, px[a]!, py[a]!, cx, cy)
          const w2 = edge(px[a]!, py[a]!, px[b]!, py[b]!, cx, cy)
          if (!inside(w0, px[b]!, py[b]!, px[c]!, py[c]!)) continue
          if (!inside(w1, px[c]!, py[c]!, px[a]!, py[a]!)) continue
          if (!inside(w2, px[a]!, py[a]!, px[b]!, py[b]!)) continue
          const k = y * width + x
          if (stamp[k] === id) continue
          stamp[k] = id
          const value = f((w0 * cv[a]! + w1 * cv[b]! + w2 * cv[c]!) / area)
          // A UNORM target rounds the fragment's value to its precision before blending.
          const src = Math.round(value * 255) / 255
          const d = mask[k]! / 255
          const out = hide ? d + src * (1 - d) : d * (1 - src)
          mask[k] = Math.round(Math.min(1, Math.max(0, out)) * 255)
        }
      }
    }
  }
  return mask
}

/** Twice the signed area of (a, b, p): positive with p on the triangle's inner side of a→b. */
function edge(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

/** Inside an edge, or on it when it's a top or left edge (y down, positive inside). */
function inside(w: number, ax: number, ay: number, bx: number, by: number): boolean {
  if (w > 0) return true
  if (w < 0) return false
  const dx = bx - ax
  const dy = by - ay
  return (dy === 0 && dx > 0) || dy < 0
}
