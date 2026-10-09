// The heightfield bake's kernel (spec 0071): the layer stack evaluated at samples, quantized
// heights, paint control, normals, exact geometric errors, and page encoding. Plain JavaScript, so
// pool workers import it directly (no bundler, no TypeScript loader); the main thread runs the same
// functions for pages it needs at once. Types are in kernel.d.ts.
//
// Every sample sits on the leaf lattice: sample (gi, gj) is at x = gi × spacing, z = gj × spacing,
// computed that one way everywhere. Noise is sampled against a fixed lattice of origins (one per
// LATTICE metres), so a sample's value never depends on which job or page computed it: a block
// bake, a single page baked on demand, and a rebake all write the same bytes.

import { deflate, inflate } from './deflate.js'

/** Segments per page side: a page has PAGE + 1 samples a side. */
export const PAGE = 64
/** Samples per side of a page's vertex grid. */
export const SIDE = PAGE + 1
/** A leaf page's height samples per side: its grid plus a one-sample border, for normals. */
export const LEAF_SIDE = SIDE + 2
/** Leaf pages per block side: the unit of incremental baking. */
export const BLOCK = 16
/** Metres between noise origins: inputs stay within LATTICE / 2 of theirs (sub-mm in f32). */
export const LATTICE = 256
/** Ancestor levels a block bakes itself (its leaves' parents up to its own root): log2(BLOCK). */
export const BLOCK_LEVELS = 4
/** Bumps whenever any baked byte would change for the same inputs. Part of every block key. */
export const BAKE_VERSION = 1

export const BLEND_ADD = 0
export const BLEND_MAX = 1
export const BLEND_MIN = 2
export const BLEND_REPLACE = 3
export const MODE_FLATTEN = 0
export const MODE_RAISE = 1
export const MODE_CARVE = 2
export const LAYER_NOISE = 0
export const LAYER_IMAGE = 1
export const LAYER_SPLINE = 2

export { deflate, inflate }

// --- small helpers -----------------------------------------------------------------------------

function smoothstep(a, b, x) {
  if (!(b > a)) return x < a ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 1 inside [lo, hi], easing to 0 over `blend` centred on each end (hard edges at 0). */
export function windowWeight(x, lo, hi, blend) {
  if (blend <= 0) return x >= lo && x <= hi ? 1 : 0
  const h = blend / 2
  return smoothstep(lo - h, lo + h, x) * (1 - smoothstep(hi - h, hi + h, x))
}

/** Fades from 1 at distance 0 to 0 at `falloff` (a step at 0 falloff). */
function fade(distance, falloff) {
  if (distance <= 0) return 1
  if (!(falloff > 0)) return 0
  return 1 - smoothstep(0, falloff, distance)
}

/**
 * A rotated rectangle's local coordinates for (x, z): u and v in [0, 1] inside it (u along the
 * rectangle's width, v along its depth), and how far outside it the point is (m).
 */
function rectLocal(rect, x, z, out) {
  const dx = x - rect.cx
  const dz = z - rect.cz
  // Rotated about +Y by `rotation`: its width axis is (cos, −sin) in (x, z), its depth axis (sin, cos).
  const lu = dx * rect.cos - dz * rect.sin
  const lv = dx * rect.sin + dz * rect.cos
  out[0] = lu / (rect.hw * 2) + 0.5
  out[1] = lv / (rect.hd * 2) + 0.5
  const ou = Math.max(0, Math.abs(lu) - rect.hw)
  const ov = Math.max(0, Math.abs(lv) - rect.hd)
  out[2] = Math.sqrt(ou * ou + ov * ov)
  return out
}

/** Bilinear sample of a heightmap (values 0–1, top row first) at u, v in [0, 1], edges clamped. */
export function sampleMap(map, u, v) {
  const w = map.width
  const h = map.height
  const fx = Math.min(w - 1, Math.max(0, u * w - 0.5))
  const fy = Math.min(h - 1, Math.max(0, v * h - 0.5))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const d = map.data
  const a = d[y0 * w + x0]
  const b = d[y0 * w + x1]
  const c = d[y1 * w + x0]
  const e = d[y1 * w + x1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty
}

// --- splines -----------------------------------------------------------------------------------

/**
 * A spline ready for distance queries: its tessellated points (x, y, z) and a grid of buckets of
 * segment indices over XZ, each bucket listing (in index order) the segments within `reach` of it.
 * Built the same way everywhere, so queries are deterministic.
 */
export function buildSpline(pts, width, falloff, reach) {
  const count = pts.length / 3
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, pts[i * 3])
    maxX = Math.max(maxX, pts[i * 3])
    minZ = Math.min(minZ, pts[i * 3 + 2])
    maxZ = Math.max(maxZ, pts[i * 3 + 2])
  }
  // Buckets about half the reach: each lists the few segments that can be within reach of it.
  const cell = Math.max(4, reach / 2)
  const x0 = minX - reach
  const z0 = minZ - reach
  const cols = Math.max(1, Math.ceil((maxX + reach - x0) / cell))
  const rows = Math.max(1, Math.ceil((maxZ + reach - z0) / cell))
  const lists = Array.from({ length: cols * rows }, () => [])
  for (let s = 0; s + 1 < count; s++) {
    const ax = pts[s * 3]
    const az = pts[s * 3 + 2]
    const bx = pts[s * 3 + 3]
    const bz = pts[s * 3 + 5]
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / cell))
    const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + reach - x0) / cell))
    const r0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / cell))
    const r1 = Math.min(rows - 1, Math.floor((Math.max(az, bz) + reach - z0) / cell))
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) lists[r * cols + c].push(s)
  }
  const start = new Int32Array(cols * rows + 1)
  for (let b = 0; b < lists.length; b++) start[b + 1] = start[b] + lists[b].length
  const segs = new Int32Array(start[lists.length])
  for (let b = 0; b < lists.length; b++) segs.set(lists[b], start[b])
  return {
    pts: Float64Array.from(pts),
    count,
    width,
    falloff,
    reach,
    cell,
    x0,
    z0,
    cols,
    rows,
    start,
    segs,
    minX: minX - reach,
    minZ: minZ - reach,
    maxX: maxX + reach,
    maxZ: maxZ + reach,
  }
}

/**
 * The nearest point of a spline's centerline to (x, z) within its reach: writes [distance, height
 * there, along (0–1 within the segment), segment] into `out` and returns the distance, or Infinity
 * when nothing is within reach. Ties go to the lower segment.
 */
export function nearestOnSpline(sp, x, z, out) {
  out[0] = Infinity
  if (x < sp.minX || x > sp.maxX || z < sp.minZ || z > sp.maxZ) return Infinity
  const c = Math.floor((x - sp.x0) / sp.cell)
  const r = Math.floor((z - sp.z0) / sp.cell)
  if (c < 0 || r < 0 || c >= sp.cols || r >= sp.rows) return Infinity
  const b = r * sp.cols + c
  const p = sp.pts
  let best = Infinity
  for (let k = sp.start[b]; k < sp.start[b + 1]; k++) {
    const s = sp.segs[k]
    const ax = p[s * 3]
    const ay = p[s * 3 + 1]
    const az = p[s * 3 + 2]
    const bx = p[s * 3 + 3]
    const by = p[s * 3 + 4]
    const bz = p[s * 3 + 5]
    const ex = bx - ax
    const ez = bz - az
    const len2 = ex * ex + ez * ez
    let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0
    t = Math.min(1, Math.max(0, t))
    const dx = x - (ax + ex * t)
    const dz = z - (az + ez * t)
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < best) {
      best = d
      out[0] = d
      out[1] = ay + (by - ay) * t
      out[2] = t
      out[3] = s
    }
  }
  if (best <= sp.reach) return best
  out[0] = Infinity
  return Infinity
}

// --- noise on the canonical lattice -----------------------------------------------------------

/** Per-thread scratch for noise batches. */
const scratch = {
  pts: new Float32Array(0),
  vals: new Float32Array(0),
  origin: new Float64Array(4),
  records: new Int32Array(0),
}

function ensure(name, n, Kind) {
  if (scratch[name].length < n) scratch[name] = new Kind(n)
  return scratch[name]
}

/**
 * A noise program at the grid's samples: column a, row b is leaf sample (gi0 + a × step, gj0 +
 * b × step). Columns and rows are cut where the lattice of origins changes, and each piece is
 * sampled from its own origin, so every sample gets the value it would get alone. Writes
 * `value × scale + offset` into `out` (f64, row by row).
 */
function noiseGrid(noise, program, seed, spacing, gi0, gj0, step, nx, nz, scale, offset, out) {
  const records = ensure('records', program.zeroOrigins.length, Int32Array)
  let a0 = 0
  while (a0 < nx) {
    const cx = Math.floor(((gi0 + a0 * step) * spacing) / LATTICE)
    let a1 = a0 + 1
    while (a1 < nx && Math.floor(((gi0 + a1 * step) * spacing) / LATTICE) === cx) a1++
    let b0 = 0
    while (b0 < nz) {
      const cz = Math.floor(((gj0 + b0 * step) * spacing) / LATTICE)
      let b1 = b0 + 1
      while (b1 < nz && Math.floor(((gj0 + b1 * step) * spacing) / LATTICE) === cz) b1++
      const ox = cx * LATTICE + LATTICE / 2
      const oz = cz * LATTICE + LATTICE / 2
      const w = a1 - a0
      const n = w * (b1 - b0)
      const pts = ensure('pts', n * 3, Float32Array)
      const vals = ensure('vals', n, Float32Array)
      let k = 0
      for (let b = b0; b < b1; b++) {
        const lz = (gj0 + b * step) * spacing - oz
        for (let a = a0; a < a1; a++) {
          pts[k * 3] = (gi0 + a * step) * spacing - ox
          pts[k * 3 + 1] = 0
          pts[k * 3 + 2] = lz
          k++
        }
      }
      const origin = scratch.origin
      origin[0] = ox
      origin[1] = 0
      origin[2] = oz
      origin[3] = 0
      noise.computeOrigins(program.terms, origin, records)
      noise.evalProgram(noise.state, program, seed, records, pts, 3, n, vals)
      k = 0
      for (let b = b0; b < b1; b++) {
        for (let a = a0; a < a1; a++) out[b * nx + a] = vals[k++] * scale + offset
      }
      b0 = b1
    }
    a0 = a1
  }
}

/** A noise program at arbitrary points (x, z pairs), each from its own lattice origin. */
function noisePoints(noise, program, seed, xz, count, scale, offset, out) {
  const records = ensure('records', program.zeroOrigins.length, Int32Array)
  const pts = ensure('pts', 3, Float32Array)
  const vals = ensure('vals', 1, Float32Array)
  const origin = scratch.origin
  for (let i = 0; i < count; i++) {
    const x = xz[i * 2]
    const z = xz[i * 2 + 1]
    const ox = Math.floor(x / LATTICE) * LATTICE + LATTICE / 2
    const oz = Math.floor(z / LATTICE) * LATTICE + LATTICE / 2
    origin[0] = ox
    origin[1] = 0
    origin[2] = oz
    origin[3] = 0
    pts[0] = x - ox
    pts[1] = 0
    pts[2] = z - oz
    noise.computeOrigins(program.terms, origin, records)
    noise.evalProgram(noise.state, program, seed, records, pts, 3, 1, vals)
    out[i] = vals[0] * scale + offset
  }
}

// --- the height stack --------------------------------------------------------------------------

function blend(h, v, m, op) {
  if (m <= 0) return h
  switch (op) {
    case BLEND_ADD:
      return h + m * v
    case BLEND_MAX:
      return h + m * (Math.max(h, v) - h)
    case BLEND_MIN:
      return h + m * (Math.min(h, v) - h)
    default:
      return h + m * (v - h)
  }
}

const local = new Float64Array(3)
const near = new Float64Array(4)
let values = new Float64Array(0)

/**
 * Applies height layers [0, `upTo`) to a grid of samples (see noiseGrid for the layout): `out`
 * gets metres, f64, row by row. The stack is the compiled source (heightfield/stack.ts).
 */
export function evalHeights(noise, stack, gi0, gj0, step, nx, nz, upTo, out) {
  const n = nx * nz
  const sp = stack.spacing
  out.fill(0, 0, n)
  if (values.length < n) values = new Float64Array(n)
  const layers = stack.height
  const count = Math.min(upTo, layers.length)
  for (let l = 0; l < count; l++) {
    const layer = layers[l]
    if (layer.kind === LAYER_NOISE) {
      noiseGrid(
        noise,
        layer.program,
        stack.seed,
        sp,
        gi0,
        gj0,
        step,
        nx,
        nz,
        layer.scale,
        layer.offset,
        values,
      )
      for (let b = 0; b < nz; b++) {
        const z = (gj0 + b * step) * sp
        for (let a = 0; a < nx; a++) {
          const k = b * nx + a
          let m = 1
          if (layer.rect) {
            rectLocal(layer.rect, (gi0 + a * step) * sp, z, local)
            m = fade(local[2], layer.falloff)
          }
          out[k] = blend(out[k], values[k], m, layer.blend)
        }
      }
    } else if (layer.kind === LAYER_IMAGE) {
      const lo = layer.lo
      const span = layer.hi - layer.lo
      for (let b = 0; b < nz; b++) {
        const z = (gj0 + b * step) * sp
        for (let a = 0; a < nx; a++) {
          rectLocal(layer.rect, (gi0 + a * step) * sp, z, local)
          const m = fade(local[2], layer.falloff)
          if (m <= 0) continue
          const k = b * nx + a
          const v = lo + span * sampleMap(layer.map, local[0], local[1])
          out[k] = blend(out[k], v, m, layer.blend)
        }
      }
    } else {
      const spline = layer.spline
      const half = spline.width / 2
      for (let b = 0; b < nz; b++) {
        const z = (gj0 + b * step) * sp
        for (let a = 0; a < nx; a++) {
          const d = nearestOnSpline(spline, (gi0 + a * step) * sp, z, near)
          if (d === Infinity) continue
          const m = fade(d - half, layer.falloff)
          if (m <= 0) continue
          const k = b * nx + a
          const h = out[k]
          const target = near[1] + layer.offset
          const v =
            layer.mode === MODE_RAISE
              ? Math.max(h, target)
              : layer.mode === MODE_CARVE
                ? Math.min(h, target)
                : target
          out[k] = h + m * (v - h)
        }
      }
    }
  }
}

/**
 * Heights of layers [0, `upTo`) at arbitrary points (x, z pairs): what a spline's "ground" point
 * takes. The same per-sample rules as evalHeights, so a point on the leaf lattice gets the same
 * value either way.
 */
export function evalHeightPoints(noise, stack, xz, count, upTo, out) {
  out.fill(0, 0, count)
  const v = new Float64Array(count)
  const layers = stack.height
  for (let l = 0; l < Math.min(upTo, layers.length); l++) {
    const layer = layers[l]
    if (layer.kind === LAYER_NOISE)
      noisePoints(noise, layer.program, stack.seed, xz, count, layer.scale, layer.offset, v)
    for (let i = 0; i < count; i++) {
      const x = xz[i * 2]
      const z = xz[i * 2 + 1]
      if (layer.kind === LAYER_NOISE) {
        let m = 1
        if (layer.rect) {
          rectLocal(layer.rect, x, z, local)
          m = fade(local[2], layer.falloff)
        }
        out[i] = blend(out[i], v[i], m, layer.blend)
      } else if (layer.kind === LAYER_IMAGE) {
        rectLocal(layer.rect, x, z, local)
        const m = fade(local[2], layer.falloff)
        if (m <= 0) continue
        const value = layer.lo + (layer.hi - layer.lo) * sampleMap(layer.map, local[0], local[1])
        out[i] = blend(out[i], value, m, layer.blend)
      } else {
        const d = nearestOnSpline(layer.spline, x, z, near)
        if (d === Infinity) continue
        const m = fade(d - layer.spline.width / 2, layer.falloff)
        if (m <= 0) continue
        const h = out[i]
        const target = near[1] + layer.offset
        const value =
          layer.mode === MODE_RAISE
            ? Math.max(h, target)
            : layer.mode === MODE_CARVE
              ? Math.min(h, target)
              : target
        out[i] = h + m * (value - h)
      }
    }
  }
}

// --- quantizing, normals, slopes ---------------------------------------------------------------

/** Metres to the u16 a page stores over heightRange [lo, hi]. */
export function quantize(h, lo, hi) {
  const q = Math.round(((h - lo) / (hi - lo)) * 65535)
  return q < 0 ? 0 : q > 65535 ? 65535 : q
}

export function dequantize(q, lo, hi) {
  return lo + (q * (hi - lo)) / 65535
}

/** A unit normal component stored in a byte: [-1, 1] → 0–255. */
export function normalByte(v) {
  const b = Math.round((v + 1) * 127.5)
  return b < 0 ? 0 : b > 255 ? 255 : b
}

export function byteNormal(b) {
  return b / 127.5 - 1
}

/**
 * The normal at sample k of a grid of heights (f64 metres, `nx` wide) by central differences at
 * `step` metres, into out [x, y, z] (unit). The sample needs both neighbors on each axis.
 */
function centralNormal(h, nx, k, step, out) {
  const dx = (h[k + 1] - h[k - 1]) / (2 * step)
  const dz = (h[k + nx] - h[k - nx]) / (2 * step)
  const l = Math.sqrt(dx * dx + 1 + dz * dz)
  out[0] = -dx / l
  out[1] = 1 / l
  out[2] = -dz / l
  return out
}

const nrm = new Float64Array(3)

/**
 * A leaf page's normals as bytes (x then z planes, SIDE² each), from its LEAF_SIDE² quantized
 * heights: what the GPU upload and the CPU queries both use.
 */
export function leafNormals(heights, lo, hi, spacing, out) {
  const n = LEAF_SIDE
  const h = new Float64Array(n * n)
  for (let i = 0; i < n * n; i++) h[i] = dequantize(heights[i], lo, hi)
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) {
      centralNormal(h, n, (j + 1) * n + i + 1, spacing, nrm)
      out[j * SIDE + i] = normalByte(nrm[0])
      out[SIDE * SIDE + j * SIDE + i] = normalByte(nrm[2])
    }
  }
  return out
}

/** Slope in degrees from the heights around sample k (central differences at `step`). */
function slopeAt(h, nx, k, step) {
  const dx = (h[k + 1] - h[k - 1]) / (2 * step)
  const dz = (h[k + nx] - h[k - nx]) / (2 * step)
  return (Math.atan(Math.sqrt(dx * dx + dz * dz)) * 180) / Math.PI
}

// --- paint -------------------------------------------------------------------------------------

/**
 * Control texels for paint samples: paint sample (a, b) is leaf sample (gi0 + a × k, gj0 + b × k),
 * whose height and slope come from `hq` (dequantized leaf heights, `hx` wide, with sample (gi0,
 * gj0) at index `h0`, one sample of margin all round). Writes four bytes per texel: the heaviest
 * layer, the second, the second's share of their weight (0–255), and the hole bit (0).
 */
export function evalControl(noise, stack, gi0, gj0, k, nx, nz, hq, hx, h0, out) {
  const layers = stack.layerCount
  const w = new Float64Array(layers)
  const paint = stack.paint
  const sp = stack.spacing
  // Noise masks for the whole grid first, per entry.
  const noiseValues = paint.map((entry) => {
    if (!entry.noise) return null
    const v = new Float64Array(nx * nz)
    noiseGrid(noise, entry.noise.program, stack.seed, sp, gi0, gj0, k, nx, nz, 1, 0, v)
    return v
  })
  for (let b = 0; b < nz; b++) {
    for (let a = 0; a < nx; a++) {
      const x = (gi0 + a * k) * sp
      const z = (gj0 + b * k) * sp
      const hk = h0 + b * k * hx + a * k
      const height = hq[hk]
      const slope = slopeAt(hq, hx, hk, sp)
      w.fill(0)
      for (let e = 0; e < paint.length; e++) {
        const entry = paint[e]
        let m = 1
        if (entry.height) m *= windowWeight(height, entry.height[0], entry.height[1], entry.blend)
        if (m > 0 && entry.slope)
          m *= windowWeight(slope, entry.slope[0], entry.slope[1], entry.blend)
        if (m > 0 && entry.noise) {
          const above = entry.noise.above
          m *= smoothstep(above - 0.05, above + 0.05, noiseValues[e][b * nx + a])
        }
        if (m > 0 && entry.mask) {
          rectLocal(entry.mask.rect, x, z, local)
          m *= fade(local[2], entry.blend) * sampleMap(entry.mask.map, local[0], local[1])
        }
        if (m > 0 && entry.spline) {
          const d = nearestOnSpline(entry.spline, x, z, near)
          m *= d === Infinity ? 0 : fade(d - entry.spline.width / 2, entry.blend)
        }
        if (m <= 0) continue
        if (m > 1) m = 1
        // Paints over what's below: every weight scales by (1 − m), this layer gains m.
        for (let l = 0; l < layers; l++) w[l] *= 1 - m
        w[entry.layer] += m
      }
      let a0 = 0
      let a1 = -1
      for (let l = 1; l < layers; l++) if (w[l] > w[a0]) a0 = l
      for (let l = 0; l < layers; l++) {
        if (l === a0) continue
        if (a1 < 0 || w[l] > w[a1]) a1 = l
      }
      const o = (b * nx + a) * 4
      const wa = w[a0]
      const wb = a1 >= 0 ? w[a1] : 0
      out[o] = a0
      out[o + 1] = a1 >= 0 && wb > 0 ? a1 : a0
      out[o + 2] = wa + wb > 0 ? Math.round((wb / (wa + wb)) * 255) : 0
      out[o + 3] = 0
    }
  }
  return out
}

// --- pages -------------------------------------------------------------------------------------

/** Raw bytes of a page before deflate: leaves hold heights with a border and control; parents add normals. */
export function pageBytes(leaf, cells) {
  const c = (cells + 1) * (cells + 1) * 4
  return leaf ? LEAF_SIDE * LEAF_SIDE * 2 + c : SIDE * SIDE * 4 + c
}

/**
 * A page's raw bytes: heights as row deltas split into low and high byte planes (smooth ground
 * deflates well), then parents' normals (x plane, z plane), then control (four planes).
 */
export function encodePage(page, leaf, cells) {
  const side = leaf ? LEAF_SIDE : SIDE
  const count = side * side
  const out = new Uint8Array(pageBytes(leaf, cells))
  const h = page.heights
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const k = j * side + i
      const prev = i > 0 ? h[k - 1] : j > 0 ? h[k - side] : 0
      const d = (h[k] - prev) & 0xffff
      out[k] = d & 0xff
      out[count + k] = d >> 8
    }
  }
  let o = count * 2
  if (!leaf) {
    out.set(page.normals.subarray(0, SIDE * SIDE * 2), o)
    o += SIDE * SIDE * 2
  }
  const texels = (cells + 1) * (cells + 1)
  const ctl = page.control
  for (let t = 0; t < texels; t++) {
    out[o + t] = ctl[t * 4]
    out[o + texels + t] = ctl[t * 4 + 1]
    out[o + texels * 2 + t] = ctl[t * 4 + 2]
    out[o + texels * 3 + t] = ctl[t * 4 + 3]
  }
  return out
}

/** The inverse of encodePage: { heights, normals (parents; null for leaves), control }. */
export function decodePage(raw, leaf, cells) {
  const side = leaf ? LEAF_SIDE : SIDE
  const count = side * side
  const heights = new Uint16Array(count)
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const k = j * side + i
      const prev = i > 0 ? heights[k - 1] : j > 0 ? heights[k - side] : 0
      heights[k] = (prev + (raw[k] | (raw[count + k] << 8))) & 0xffff
    }
  }
  let o = count * 2
  let normals = null
  if (!leaf) {
    normals = raw.slice(o, o + SIDE * SIDE * 2)
    o += SIDE * SIDE * 2
  }
  const texels = (cells + 1) * (cells + 1)
  const control = new Uint8Array(texels * 4)
  for (let t = 0; t < texels; t++) {
    control[t * 4] = raw[o + t]
    control[t * 4 + 1] = raw[o + texels + t]
    control[t * 4 + 2] = raw[o + texels * 2 + t]
    control[t * 4 + 3] = raw[o + texels * 3 + t]
  }
  return { heights, normals, control }
}

/** Inflates and decodes a page. */
export function readPage(packed, leaf, cells) {
  return decodePage(inflate(packed, pageBytes(leaf, cells)), leaf, cells)
}

/**
 * A page as the GPU pool holds it: LEAF_SIDE² RGBA8 texels of (height low byte, height high
 * byte, normal x, normal z), a parent's heights inset by one with its edges repeated into the
 * border. A leaf's normals come from its heights (unless `page.normals` already holds them), on the
 * pool, so both tiers upload the same bytes.
 */
export function pageTexels(page, leaf, lo, hi, spacing, texels) {
  const n = LEAF_SIDE
  const normals =
    page.normals ?? leafNormals(page.heights, lo, hi, spacing, new Uint8Array(SIDE * SIDE * 2))
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let h
      if (leaf) h = page.heights[j * n + i]
      else {
        const si = Math.min(SIDE - 1, Math.max(0, i - 1))
        const sj = Math.min(SIDE - 1, Math.max(0, j - 1))
        h = page.heights[sj * SIDE + si]
      }
      const o = (j * n + i) * 4
      texels[o] = h & 0xff
      texels[o + 1] = h >> 8
      const vi = i - 1
      const vj = j - 1
      if (vi >= 0 && vj >= 0 && vi < SIDE && vj < SIDE) {
        texels[o + 2] = normals[vj * SIDE + vi]
        texels[o + 3] = normals[SIDE * SIDE + vj * SIDE + vi]
      } else {
        texels[o + 2] = 128
        texels[o + 3] = 128
      }
    }
  }
  return texels
}

// --- errors ------------------------------------------------------------------------------------

/**
 * The largest |h − surface| over samples [i0, i1] × [j0, j1] of a grid (`hx` wide, f64 metres),
 * where `surface` is the grid at every `s`-th sample drawn as triangles split along each cell's
 * anti-diagonal (Rapier's split, and the drawn mesh's). The range's ends are multiples of `s`.
 */
function levelError(h, hx, i0, j0, i1, j1, s) {
  let worst = 0
  for (let cj = j0; cj < j1; cj += s) {
    for (let ci = i0; ci < i1; ci += s) {
      const h00 = h[cj * hx + ci]
      const h10 = h[cj * hx + ci + s]
      const h01 = h[(cj + s) * hx + ci]
      const h11 = h[(cj + s) * hx + ci + s]
      for (let b = 0; b <= s; b++) {
        const v = b / s
        const row = (cj + b) * hx + ci
        for (let a = 0; a <= s; a++) {
          const u = a / s
          const surface =
            u + v <= 1
              ? h00 + u * (h10 - h00) + v * (h01 - h00)
              : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11)
          const e = Math.abs(h[row + a] - surface)
          if (e > worst) worst = e
        }
      }
    }
  }
  return worst
}

// --- block bakes -------------------------------------------------------------------------------

/**
 * Bakes one block (spec 0071): the stack over its leaf samples (plus a margin for normals), its
 * leaf pages, and its own ancestors up to BLOCK_LEVELS (or the root) with their normals (each
 * level's normal the [1 2 1]² average of its children's), exact geometric errors, and height
 * ranges; plus its share of every higher level's error. `layout` is the terrain's grid
 * (heightfield/source.ts terrainLayout). Returns compressed pages and stats; allocates per call.
 */
export function bakeBlock(noise, stack, layout, bx, bz) {
  const t0 = performance.now()
  const D = layout.depth
  const sp = layout.spacing
  const lo = stack.lo
  const hi = stack.hi
  const k = layout.paintStep
  const cells = layout.cells
  const block = layout.block
  const lmax = Math.min(layout.blockLevels, D)
  // The block's leaves, clipped to the terrain.
  const lx0 = bx * block
  const lz0 = bz * block
  const nlx = Math.min(block, layout.leavesX - lx0)
  const nlz = Math.min(block, layout.leavesZ - lz0)
  // Leaf samples [s0, s1] per axis, plus a margin: the [1 2 1] chain to level lmax reaches 2^lmax − 1
  // samples out, and leaf normals one more.
  const margin = 2 ** lmax + 1
  const gx0 = lx0 * PAGE - margin
  const gz0 = lz0 * PAGE - margin
  const nx = nlx * PAGE + 1 + 2 * margin
  const nz = nlz * PAGE + 1 + 2 * margin
  const H = new Float64Array(nx * nz)
  evalHeights(noise, stack, gx0, gz0, 1, nx, nz, stack.height.length, H)
  // Quantize; heights clipped by heightRange inside the block are reported once.
  const Q = new Uint16Array(nx * nz)
  const Hq = new Float64Array(nx * nz)
  let clipped = 0
  let lowest = Infinity
  let highest = -Infinity
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i
      const h = H[idx]
      const q = quantize(h, lo, hi)
      Q[idx] = q
      Hq[idx] = dequantize(q, lo, hi)
      if (i >= margin && j >= margin && i < nx - margin && j < nz - margin) {
        if (h < lo || h > hi) clipped++
        if (h < lowest) lowest = h
        if (h > highest) highest = h
      }
    }
  }
  // Paint over the block's paint samples (one leaf sample of margin for slopes is inside H's).
  const pnx = (nlx * PAGE) / k + 1
  const pnz = (nlz * PAGE) / k + 1
  const C = new Uint8Array(pnx * pnz * 4)
  evalControl(noise, stack, lx0 * PAGE, lz0 * PAGE, k, pnx, pnz, Hq, nx, margin * nx + margin, C)
  // Leaf normals over the margin, then each level's [1 2 1]² average of the one below.
  const N = [new Float64Array(nx * nz * 3)]
  for (let j = 1; j < nz - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      centralNormal(Hq, nx, j * nx + i, sp, nrm)
      const o = (j * nx + i) * 3
      N[0][o] = nrm[0]
      N[0][o + 1] = nrm[1]
      N[0][o + 2] = nrm[2]
    }
  }
  // Level L's texels sit on block-relative samples that are multiples of 2^L, each the weighted
  // sum of level L − 1's at ±2^(L−1). Each level covers what the next one up reads: the block plus
  // 2^lmax − 2^L samples.
  const RX = nlx * PAGE
  const RZ = nlz * PAGE
  for (let L = 1; L <= lmax; L++) {
    const s = 2 ** L
    const r = s / 2
    const ext = 2 ** lmax - s
    const prev = N[L - 1]
    const next = new Float64Array(nx * nz * 3)
    for (let rj = -ext; rj <= RZ + ext; rj += s) {
      const j = margin + rj
      for (let ri = -ext; ri <= RX + ext; ri += s) {
        const i = margin + ri
        let sx = 0
        let sy = 0
        let sz = 0
        for (let b = -1; b <= 1; b++) {
          for (let a = -1; a <= 1; a++) {
            const wgt = (2 - Math.abs(a)) * (2 - Math.abs(b))
            const o = ((j + b * r) * nx + i + a * r) * 3
            sx += prev[o] * wgt
            sy += prev[o + 1] * wgt
            sz += prev[o + 2] * wgt
          }
        }
        const l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1
        const o = (j * nx + i) * 3
        next[o] = sx / l
        next[o + 1] = sy / l
        next[o + 2] = sz / l
      }
    }
    N.push(next)
  }
  const pages = []
  const pack = (level, X, Z, page, leaf, min, max, error) => {
    const raw = encodePage(page, leaf, cells)
    pages.push({ level, x: X, z: Z, data: deflate(raw), min, max, error })
  }
  // Leaves.
  const leafRange = new Uint16Array(nlx * nlz * 2)
  for (let lz = 0; lz < nlz; lz++) {
    for (let lx = 0; lx < nlx; lx++) {
      const heights = new Uint16Array(LEAF_SIDE * LEAF_SIDE)
      let qmin = 65535
      let qmax = 0
      for (let j = 0; j < LEAF_SIDE; j++) {
        const row = (margin + lz * PAGE - 1 + j) * nx + margin + lx * PAGE - 1
        for (let i = 0; i < LEAF_SIDE; i++) {
          const q = Q[row + i]
          heights[j * LEAF_SIDE + i] = q
          if (i > 0 && j > 0 && i < LEAF_SIDE - 1 && j < LEAF_SIDE - 1) {
            if (q < qmin) qmin = q
            if (q > qmax) qmax = q
          }
        }
      }
      leafRange[(lz * nlx + lx) * 2] = qmin
      leafRange[(lz * nlx + lx) * 2 + 1] = qmax
      const control = new Uint8Array((cells + 1) * (cells + 1) * 4)
      for (let b = 0; b <= cells; b++) {
        const src = ((lz * cells + b) * pnx + lx * cells) * 4
        control.set(C.subarray(src, src + (cells + 1) * 4), b * (cells + 1) * 4)
      }
      pack(0, lx0 + lx, lz0 + lz, { heights, normals: null, control }, true, qmin, qmax, 0)
    }
  }
  // The block's own ancestors.
  let ranges = leafRange
  let rx = nlx
  let rz = nlz
  for (let L = 1; L <= lmax; L++) {
    const s = 2 ** L
    const nnx = Math.ceil(nlx / s)
    const nnz = Math.ceil(nlz / s)
    const next = new Uint16Array(nnx * nnz * 2)
    for (let z = 0; z < nnz; z++) {
      for (let x = 0; x < nnx; x++) {
        // Height range over its children.
        let qmin = 65535
        let qmax = 0
        for (let c = 0; c < 4; c++) {
          const cx = x * 2 + (c & 1)
          const cz = z * 2 + (c >> 1)
          if (cx >= rx || cz >= rz) continue
          qmin = Math.min(qmin, ranges[(cz * rx + cx) * 2])
          qmax = Math.max(qmax, ranges[(cz * rx + cx) * 2 + 1])
        }
        next[(z * nnx + x) * 2] = qmin
        next[(z * nnx + x) * 2 + 1] = qmax
        const heights = new Uint16Array(SIDE * SIDE)
        const normals = new Uint8Array(SIDE * SIDE * 2)
        const n = N[L]
        for (let j = 0; j < SIDE; j++) {
          for (let i = 0; i < SIDE; i++) {
            const gi = margin + (x * PAGE + i) * s
            const gj = margin + (z * PAGE + j) * s
            heights[j * SIDE + i] = Q[gj * nx + gi]
            const o = (gj * nx + gi) * 3
            normals[j * SIDE + i] = normalByte(n[o])
            normals[SIDE * SIDE + j * SIDE + i] = normalByte(n[o + 2])
          }
        }
        const control = new Uint8Array((cells + 1) * (cells + 1) * 4)
        for (let b = 0; b <= cells; b++) {
          for (let a = 0; a <= cells; a++) {
            const src = ((z * cells + b) * s * pnx + (x * cells + a) * s) * 4
            control.set(C.subarray(src, src + 4), (b * (cells + 1) + a) * 4)
          }
        }
        // Exact error: every leaf sample under it against its own surface.
        const i0 = margin + x * PAGE * s
        const j0 = margin + z * PAGE * s
        const error = levelError(Hq, nx, i0, j0, i0 + PAGE * s, j0 + PAGE * s, s)
        pack(
          L,
          (lx0 >> L) + x,
          (lz0 >> L) + z,
          { heights, normals, control },
          false,
          qmin,
          qmax,
          error,
        )
      }
    }
    ranges = next
    rx = nnx
    rz = nnz
  }
  // Higher levels' errors over this block's samples (each block lies inside one node there).
  const above = []
  for (let L = lmax + 1; L <= D; L++) {
    const s = 2 ** L
    above.push(levelError(Hq, nx, margin, margin, margin + RX, margin + RZ, s))
  }
  return {
    pages,
    above,
    range: [ranges[0], ranges[1]],
    clipped,
    lowest: lowest === Infinity ? 0 : lowest,
    highest: highest === -Infinity ? 0 : highest,
    ms: performance.now() - t0,
  }
}

/**
 * One leaf page baked on its own (spec 0071): heights with their border and control, exactly the
 * bytes its block bake writes (every sample is canonical). Colliders and height queries use it
 * when a page they need hasn't arrived by the frame it's due.
 */
export function bakeLeaf(noise, stack, layout, X, Z) {
  const k = layout.paintStep
  const cells = layout.cells
  const n = LEAF_SIDE
  const H = new Float64Array(n * n)
  evalHeights(noise, stack, X * PAGE - 1, Z * PAGE - 1, 1, n, n, stack.height.length, H)
  const heights = new Uint16Array(n * n)
  const Hq = new Float64Array(n * n)
  let qmin = 65535
  let qmax = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const q = quantize(H[j * n + i], stack.lo, stack.hi)
      heights[j * n + i] = q
      Hq[j * n + i] = dequantize(q, stack.lo, stack.hi)
      if (i > 0 && j > 0 && i < n - 1 && j < n - 1) {
        if (q < qmin) qmin = q
        if (q > qmax) qmax = q
      }
    }
  }
  const control = new Uint8Array((cells + 1) * (cells + 1) * 4)
  evalControl(noise, stack, X * PAGE, Z * PAGE, k, cells + 1, cells + 1, Hq, n, n + 1, control)
  return { page: { heights, normals: null, control }, min: qmin, max: qmax }
}

/**
 * A page above the blocks from its four children (spec 0071): heights and control as their even
 * samples, normals as the [1 2 1]² average of the children's around each texel. `children` is
 * the four decoded pages in order (x, z), (x+1, z), (x, z+1), (x+1, z+1) (null past the terrain's
 * edge), and `normalAt(i, j, out)` writes the children's normal at child-grid texel (i, j), from
 * −1 to 2 × PAGE + 1 (the ring from the neighbors' pages, clamped at the terrain's edge).
 * Returns the decoded page.
 */
export function parentPage(children, cells, normalAt) {
  const heights = new Uint16Array(SIDE * SIDE)
  const normals = new Uint8Array(SIDE * SIDE * 2)
  const control = new Uint8Array((cells + 1) * (cells + 1) * 4)
  // Child-grid texel (gi, gj), 0 to 2 × PAGE: a shared edge is read from the lower child.
  const v = new Float64Array(3)
  for (let j = 0; j < SIDE; j++) {
    const gj = 2 * j
    const cz = gj > PAGE ? 1 : 0
    for (let i = 0; i < SIDE; i++) {
      const gi = 2 * i
      const cx = gi > PAGE ? 1 : 0
      const c = children[cz * 2 + cx]
      heights[j * SIDE + i] = c ? c.heights[(gj - cz * PAGE) * SIDE + gi - cx * PAGE] : 0
      let sx = 0
      let sy = 0
      let sz = 0
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          const wgt = (2 - Math.abs(a)) * (2 - Math.abs(b))
          normalAt(gi + a, gj + b, v)
          sx += v[0] * wgt
          sy += v[1] * wgt
          sz += v[2] * wgt
        }
      }
      const l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1
      normals[j * SIDE + i] = normalByte(sx / l)
      normals[SIDE * SIDE + j * SIDE + i] = normalByte(sz / l)
    }
  }
  for (let b = 0; b <= cells; b++) {
    for (let a = 0; a <= cells; a++) {
      const ca = 2 * a
      const cb = 2 * b
      const cx = ca > cells ? 1 : 0
      const cz = cb > cells ? 1 : 0
      const c = children[cz * 2 + cx]
      if (!c) continue
      const src = ((cb - cz * cells) * (cells + 1) + (ca - cx * cells)) * 4
      control.set(c.control.subarray(src, src + 4), (b * (cells + 1) + a) * 4)
    }
  }
  return { heights, normals, control }
}

/** A decoded parent page's normal at texel (i, j), unpacked to a unit vector in `out`. */
export function pageNormal(page, i, j, out) {
  const x = byteNormal(page.normals[j * SIDE + i])
  const z = byteNormal(page.normals[SIDE * SIDE + j * SIDE + i])
  out[0] = x
  out[1] = Math.sqrt(Math.max(0, 1 - x * x - z * z))
  out[2] = z
  return out
}
