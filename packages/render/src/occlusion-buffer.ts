// A camera's occlusion buffer (0116): occlusionPlugin rasterizes occluders into it, and the culls
// test against it through OcclusionTest.

import type { OcclusionTest } from './occlusion'

/**
 * A camera's occlusion buffer: per pixel, the farthest view depth of the occluders that fully
 * cover it (infinity where none does), and a pyramid of 2x2 maxima. Something is hidden when every
 * texel its screen bounds touch holds a depth nearer than its own nearest point. Level sizes halve
 * rounding down, as GPU mip chains do; a texel on an odd edge also covers the leftover row or column.
 */
export class OcclusionBuffer implements OcclusionTest {
  width = 0
  height = 0
  levels = 0
  /** Where each level starts in `data`, and its size. */
  readonly offsets = new Int32Array(16)
  readonly widths = new Int32Array(16)
  readonly heights = new Int32Array(16)
  data = new Float32Array(0)
  /** World to view (column-major), and the projection: scales, near plane, orthographic. */
  readonly view = new Float32Array(16)
  sx = 1
  sy = 1
  near = 0.1
  orthographic = false
  /** Whether it holds this frame's raster. */
  valid = false
  /** OcclusionCulling.shadows: the camera's cascades drop shadows that fall where it hides. */
  shadows = true
  /** Its layer in the GPU's occlusion texture (0..3), or -1. */
  layer = -1
  /** Last raster: occluders and triangles drawn, and its CPU time. */
  occluders = 0
  triangles = 0
  ms = 0
  /** Batches and instances culled this frame by it (describe). */
  culledBatches = 0
  culledInstances = 0
  /** Rasters so far, and the one the GPU copy holds. */
  rasters = 0
  uploaded = -1

  /** Sizes the buffer (and its pyramid). Allocates only when the size changes. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    let w = width
    let h = height
    let total = 0
    let level = 0
    while (true) {
      this.offsets[level] = total
      this.widths[level] = w
      this.heights[level] = h
      total += w * h
      level++
      if ((w === 1 && h === 1) || level === 16) break
      w = Math.max(1, w >> 1)
      h = Math.max(1, h >> 1)
    }
    this.levels = level
    this.data = new Float32Array(total)
  }

  /** Builds levels 1.. from level 0: each texel the farthest of what it covers. */
  buildPyramid(): void {
    const d = this.data
    for (let l = 1; l < this.levels; l++) {
      const pw = this.widths[l - 1]!
      const ph = this.heights[l - 1]!
      const po = this.offsets[l - 1]!
      const w = this.widths[l]!
      const h = this.heights[l]!
      const o = this.offsets[l]!
      for (let y = 0; y < h; y++) {
        const y0 = y * 2
        // The last row also takes the leftover one of an odd parent.
        const y1 = y === h - 1 ? ph - 1 : Math.min(ph - 1, y0 + 1)
        for (let x = 0; x < w; x++) {
          const x0 = x * 2
          const x1 = x === w - 1 ? pw - 1 : Math.min(pw - 1, x0 + 1)
          let m = 0
          for (let yy = y0; yy <= y1; yy++) {
            const row = po + yy * pw
            for (let xx = x0; xx <= x1; xx++) {
              const v = d[row + xx]!
              if (v > m) m = v
            }
          }
          d[o + y * w + x] = m
        }
      }
    }
  }

  /**
   * Whether a world sphere is hidden. Off screen, crossing the near plane, or with no valid raster:
   * not hidden (other tests handle those). Mirrors `occluded` in the cull shader.
   */
  hides(cx: number, cy: number, cz: number, r: number): boolean {
    if (!this.valid) return false
    const v = this.view
    const vx = f32(v[0]! * cx + v[4]! * cy + v[8]! * cz + v[12]!)
    const vy = f32(v[1]! * cx + v[5]! * cy + v[9]! * cz + v[13]!)
    const d = f32(-f32(v[2]! * cx + v[6]! * cy + v[10]! * cz + v[14]!))
    const nearest = f32(d - r)
    if (nearest <= this.near) return false
    let x0: number
    let x1: number
    let y0: number
    let y1: number
    if (this.orthographic) {
      x0 = f32(f32(vx - r) * this.sx)
      x1 = f32(f32(vx + r) * this.sx)
      y0 = f32(f32(vy - r) * this.sy)
      y1 = f32(f32(vy + r) * this.sy)
    } else {
      // Bounds over the sphere's depth range: each edge at its nearest and farthest depth.
      const far = f32(d + r)
      const lx = f32(vx - r)
      const hx = f32(vx + r)
      const ly = f32(vy - r)
      const hy = f32(vy + r)
      x0 = f32(Math.min(f32(lx / nearest), f32(lx / far)) * this.sx)
      x1 = f32(Math.max(f32(hx / nearest), f32(hx / far)) * this.sx)
      y0 = f32(Math.min(f32(ly / nearest), f32(ly / far)) * this.sy)
      y1 = f32(Math.max(f32(hy / nearest), f32(hy / far)) * this.sy)
    }
    return this.hidesRect(x0, x1, y0, y1, nearest)
  }

  /**
   * Whether a world box (min x, y, z, max x, y, z at `o`) is hidden: its corners' screen bounds,
   * at its nearest corner's depth. Mirrors `hides_box` in the cull shader.
   */
  hidesBox(box: ArrayLike<number>): boolean {
    if (!this.valid) return false
    const v = this.view
    let x0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    let nearest = Number.POSITIVE_INFINITY
    for (let c = 0; c < 8; c++) {
      const cx = c & 1 ? box[3]! : box[0]!
      const cy = c & 2 ? box[4]! : box[1]!
      const cz = c & 4 ? box[5]! : box[2]!
      const vx = f32(v[0]! * cx + v[4]! * cy + v[8]! * cz + v[12]!)
      const vy = f32(v[1]! * cx + v[5]! * cy + v[9]! * cz + v[13]!)
      const d = f32(-f32(v[2]! * cx + v[6]! * cy + v[10]! * cz + v[14]!))
      if (d <= this.near) return false
      const nx = this.orthographic ? f32(vx * this.sx) : f32(f32(vx / d) * this.sx)
      const ny = this.orthographic ? f32(vy * this.sy) : f32(f32(vy / d) * this.sy)
      if (nx < x0) x0 = nx
      if (nx > x1) x1 = nx
      if (ny < y0) y0 = ny
      if (ny > y1) y1 = ny
      if (d < nearest) nearest = d
    }
    return this.hidesRect(x0, x1, y0, y1, nearest)
  }

  /**
   * Whether a mesh's box is hidden: its local bounds (min x, y, z, max x, y, z) through an instance's
   * affine rows (12 floats at `o`). Tighter than its sphere for flat and long things (a floor
   * chunk, a wall). Mirrors `hides_oriented` in the cull shader.
   */
  hidesOriented(rows: ArrayLike<number>, o: number, b: ArrayLike<number>): boolean {
    if (!this.valid) return false
    const v = this.view
    let x0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    let nearest = Number.POSITIVE_INFINITY
    for (let c = 0; c < 8; c++) {
      const lx = c & 1 ? b[3]! : b[0]!
      const ly = c & 2 ? b[4]! : b[1]!
      const lz = c & 4 ? b[5]! : b[2]!
      const cx = f32(f32(f32(rows[o]! * lx + rows[o + 1]! * ly) + rows[o + 2]! * lz) + rows[o + 3]!)
      const cy = f32(
        f32(f32(rows[o + 4]! * lx + rows[o + 5]! * ly) + rows[o + 6]! * lz) + rows[o + 7]!,
      )
      const cz = f32(
        f32(f32(rows[o + 8]! * lx + rows[o + 9]! * ly) + rows[o + 10]! * lz) + rows[o + 11]!,
      )
      const vx = f32(v[0]! * cx + v[4]! * cy + v[8]! * cz + v[12]!)
      const vy = f32(v[1]! * cx + v[5]! * cy + v[9]! * cz + v[13]!)
      const d = f32(-f32(v[2]! * cx + v[6]! * cy + v[10]! * cz + v[14]!))
      if (d <= this.near) return false
      const nx = this.orthographic ? f32(vx * this.sx) : f32(f32(vx / d) * this.sx)
      const ny = this.orthographic ? f32(vy * this.sy) : f32(f32(vy / d) * this.sy)
      if (nx < x0) x0 = nx
      if (nx > x1) x1 = nx
      if (ny < y0) y0 = ny
      if (ny > y1) y1 = ny
      if (d < nearest) nearest = d
    }
    return this.hidesRect(x0, x1, y0, y1, nearest)
  }

  hidesInstance(
    rows: ArrayLike<number>,
    o: number,
    bounds: ArrayLike<number>,
    sphere: ArrayLike<number>,
    skinned: boolean,
  ): boolean {
    return skinned
      ? this.hides(sphere[0]!, sphere[1]!, sphere[2]!, sphere[3]!)
      : this.hidesOriented(rows, o, bounds)
  }

  hidesShadow(
    rows: ArrayLike<number>,
    o: number,
    bounds: ArrayLike<number>,
    sphere: ArrayLike<number>,
    skinned: boolean,
    sweep: ArrayLike<number>,
    margin: number,
    floor: number,
  ): boolean {
    const box = shadowBox
    if (skinned) {
      for (let k = 0; k < 3; k++) {
        box[k] = sphere[k]! - sphere[3]!
        box[k + 3] = sphere[k]! + sphere[3]!
      }
    } else orientedBox(box, rows, o, bounds)
    return this.hidesBox(receiverBox(box, sweep, margin, floor))
  }

  /** Whether NDC bounds [x0, x1] × [y0, y1] at view depth `nearest` and beyond are hidden. */
  hidesRect(x0: number, x1: number, y0: number, y1: number, nearest: number): boolean {
    const W = this.width
    const H = this.height
    const px0 = Math.floor(f32(f32(x0 * 0.5 + 0.5) * W))
    const px1 = Math.floor(f32(f32(x1 * 0.5 + 0.5) * W))
    const py0 = Math.floor(f32(f32(0.5 - y1 * 0.5) * H))
    const py1 = Math.floor(f32(f32(0.5 - y0 * 0.5) * H))
    if (px1 < 0 || px0 >= W || py1 < 0 || py0 >= H) return false
    const ax = px0 < 0 ? 0 : px0
    const bx = px1 >= W ? W - 1 : px1
    const ay = py0 < 0 ? 0 : py0
    const by = py1 >= H ? H - 1 : py1
    // Start at the finest level where the bounds span at most 4x4 texels, and descend only into
    // texels that don't hide it whole: near an occluder's edge a coarse texel also covers what's
    // past the edge.
    let l = 0
    while (l < this.levels - 1 && ((bx >> l) - (ax >> l) > 3 || (by >> l) - (ay >> l) > 3)) l++
    const stack = descent
    let top = 0
    const w = this.widths[l]!
    const h = this.heights[l]!
    for (let y = Math.min(ay >> l, h - 1); y <= Math.min(by >> l, h - 1); y++)
      for (let x = Math.min(ax >> l, w - 1); x <= Math.min(bx >> l, w - 1); x++)
        stack[top++] = x | (y << 12) | (l << 24)
    while (top > 0) {
      const e = stack[--top]!
      const x = e & 0xfff
      const y = (e >> 12) & 0xfff
      const k = e >> 24
      const wk = this.widths[k]!
      if (this.data[this.offsets[k]! + y * wk + x]! < nearest) continue
      if (k === 0) return false
      // Its children inside the bounds (a last texel also covers the odd leftover).
      const c = k - 1
      const wc = this.widths[c]!
      const hc = this.heights[c]!
      const cx0 = Math.max(x * 2, ax >> c)
      const cx1 = Math.min(x === wk - 1 ? wc - 1 : x * 2 + 1, Math.min(bx >> c, wc - 1))
      const cy0 = Math.max(y * 2, ay >> c)
      const cy1 = Math.min(
        y === this.heights[k]! - 1 ? hc - 1 : y * 2 + 1,
        Math.min(by >> c, hc - 1),
      )
      for (let yy = cy0; yy <= cy1; yy++)
        for (let xx = cx0; xx <= cx1; xx++) {
          if (top === DESCENT) return false
          stack[top++] = xx | (yy << 12) | (c << 24)
        }
    }
    return true
  }
}

const f32 = Math.fround
const shadowBox = new Float32Array(6)
/** The descent's stack (texels x | y << 12 | level << 24); full, it calls the bounds visible. */
const DESCENT = 128
const descent = new Int32Array(DESCENT)

/**
 * The box bounding where a caster's shadow can fall in view (0116's receiver test): the caster's
 * world box (min x, y, z, max x, y, z in `box`, replaced) swept along the light (`sweep`: travel
 * direction, then the cascade's far side) until its top reaches the floor height `floor` (no
 * receiver is lower, so the box ends there), grown by `margin`. Mirrors `receiver_box` in the cull
 * shader.
 */
export function receiverBox(
  box: Float32Array,
  sweep: ArrayLike<number>,
  margin: number,
  floor: number,
): Float32Array {
  const fx = sweep[0]!
  const fy = sweep[1]!
  const fz = sweep[2]!
  const cx = f32((box[0]! + box[3]!) * 0.5)
  const cy = f32((box[1]! + box[4]!) * 0.5)
  const cz = f32((box[2]! + box[5]!) * 0.5)
  let len = f32(sweep[3]! - f32(f32(fx * cx + fy * cy) + fz * cz))
  if (len < 0) len = 0
  if (fy < -1e-4) {
    // Its top lands last.
    const down = f32(f32(box[4]! - floor) / -fy)
    if (down < len) len = down > 0 ? down : 0
  }
  const dx = f32(fx * len)
  const dy = f32(fy * len)
  const dz = f32(fz * len)
  box[0] = f32(f32(box[0]! + Math.min(0, dx)) - margin)
  box[1] = Math.max(floor, f32(f32(box[1]! + Math.min(0, dy)) - margin))
  box[2] = f32(f32(box[2]! + Math.min(0, dz)) - margin)
  box[3] = f32(f32(box[3]! + Math.max(0, dx)) + margin)
  box[4] = f32(f32(box[4]! + Math.max(0, dy)) + margin)
  box[5] = f32(f32(box[5]! + Math.max(0, dz)) + margin)
  return box
}

/** A slot's world box (min, max) into `out`: its mesh's local box through the instance's rows. */
export function orientedBox(
  out: Float32Array,
  rows: ArrayLike<number>,
  o: number,
  b: ArrayLike<number>,
): Float32Array {
  out[0] = out[1] = out[2] = Number.POSITIVE_INFINITY
  out[3] = out[4] = out[5] = Number.NEGATIVE_INFINITY
  for (let c = 0; c < 8; c++) {
    const lx = c & 1 ? b[3]! : b[0]!
    const ly = c & 2 ? b[4]! : b[1]!
    const lz = c & 4 ? b[5]! : b[2]!
    for (let k = 0; k < 3; k++) {
      const r = o + k * 4
      const w = f32(f32(f32(rows[r]! * lx + rows[r + 1]! * ly) + rows[r + 2]! * lz) + rows[r + 3]!)
      if (w < out[k]!) out[k] = w
      if (w > out[k + 3]!) out[k + 3] = w
    }
  }
  return out
}
