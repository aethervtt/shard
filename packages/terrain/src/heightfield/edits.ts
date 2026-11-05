import { ShardError } from '@aethervtt/shard-core'
import { sampleCatmullRom } from '@aethervtt/shard-mesh'
import {
  buildSpline,
  deflate,
  EDIT_KEY,
  EDIT_TILE,
  evalHeights,
  inflate,
  type NoiseAccess,
  nearestOnSpline,
  PAINT_ONE,
  type Stack,
  type StackSpline,
} from './kernel'
import type { TerrainLayout } from './source'

/** Lattice points, inclusive: [i0, j0, i1, j1] (leaf samples for sculpting, paint texels for paint). */
export type LatticeRect = [number, number, number, number]

export type SculptBrush = 'raise' | 'lower' | 'smooth' | 'flatten' | 'roughen'

/** A stroke's settings (spec 0104): a sculpt `brush`, or `paint` (a layer name, null to erase). */
export interface StrokeOptions {
  brush?: SculptBrush
  paint?: string | null
  /** Metres. */
  radius: number
  /** Metres per dab (raise, lower, roughen), or 0–1 per dab (smooth, flatten, paint). */
  strength: number
  /** The soft part of the radius, 0–1 (default 0.5). */
  falloff?: number
  /** Metres between dabs along the stroke (default radius / 4). */
  spacing?: number
  /** Dabs per second at least, so holding still keeps working (default 0). */
  rate?: number
  /** Flatten's target at the edit layer (default: under the stroke's first dab). */
  height?: number
  /** Roughen's noise period in metres (default radius / 4). */
  scale?: number
}

export type EditShape =
  | { circle: { at: [number, number]; radius: number } }
  | { rect: { at: [number, number]; size: [number, number]; rotation?: number } }
  | { polygon: [number, number][] }
  | { spline: { points: [number, number][]; width: number } }

/** A shape edit (spec 0104): one sculpt op (set, raise, lower, slope) or paint, and its edge. */
export interface ShapeEdit {
  shape: EditShape
  set?: number
  raise?: number
  lower?: number
  /** Heights at the start and end: along a spline, else from `from` to `to`. */
  slope?: [number, number]
  from?: [number, number]
  to?: [number, number]
  /** A material layer to paint, or null to erase paint. */
  paint?: string | null
  /** Paint's weight (default 1). */
  strength?: number
  /** Hard by default; a wall `angle` (degrees, sculpting) or a `falloff` (metres). */
  edge?: { angle?: number; falloff?: number }
}

export type EditCause = 'stroke' | 'shape' | 'undo' | 'redo' | 'load'

/** What an edit changed: the sculpt samples and paint texels (null where nothing did). */
export interface EditChange {
  sculpt: LatticeRect | null
  paint: LatticeRect | null
  /** Heights it would have pushed past heightRange were held there. */
  clamped: boolean
}

/** Edits as a save game stores them (spec 0104). */
export interface TerrainEditsData {
  format: 1
  grid: { size: [number, number]; spacing: number; paintSpacing: number }
  /** Material layer names: paint records name layers by their index here. */
  layers: string[]
  /** Nonzero tiles: base64 of the deflated byte planes of their values. */
  sculpt: { tile: [number, number]; data: string }[]
  paint: { tile: [number, number]; data: string }[]
}

/** What edits read of their terrain. */
export interface EditContext {
  layout: TerrainLayout
  /** The compiled stack now (its `edits` point at these layers' tiles). */
  stack(): Stack
  noise(): NoiseAccess
  /** Material layer names, in order. */
  layers(): readonly string[]
  /** The ground's height range over a rectangle of metres (soft wall extents); default heightRange. */
  bounds?: (x0: number, z0: number, x1: number, z1: number) => [number, number]
}

const TILE_SAMPLES = EDIT_TILE * EDIT_TILE
/** Undo history: steps and bytes kept, at most. */
export const HISTORY_STEPS = 64
export const HISTORY_BYTES = 64 * 1024 * 1024
/** Farthest a soft wall reaches past its shape (m). */
const MAX_MARGIN = 256

export const editTileKey = (tx: number, tz: number) => tz * EDIT_KEY + tx

const bad = (message: string, path: string, hint?: string) =>
  new ShardError('terrain/bad-edit', message, { path, ...(hint ? { hint } : {}) })

function smooth01(u: number): number {
  const t = u <= 0 ? 0 : u >= 1 ? 1 : u
  return t * t * (3 - 2 * t)
}

/** A dab's weight at `t` = distance / radius: 1 inside the hard part, easing to 0 at the edge. */
export function brushWeight(t: number, falloff: number): number {
  if (t >= 1) return 0
  const inner = 1 - falloff
  if (t <= inner) return 1
  return 1 - smooth01((t - inner) / falloff)
}

/** 1 at distance 0, easing to 0 at `falloff` (0071's fade). */
function fade(d: number, falloff: number): number {
  if (d <= 0) return 1
  if (!(falloff > 0)) return 0
  return 1 - smooth01(d / falloff)
}

function hash2(x: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ 0x9e3779b9
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967295) * 2 - 1
}

function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const u = smooth01(x - xi)
  const v = smooth01(z - zi)
  const a = hash2(xi, zi)
  const b = hash2(xi + 1, zi)
  const c = hash2(xi, zi + 1)
  const d = hash2(xi + 1, zi + 1)
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
}

/** Roughen's noise: two octaves of value noise, about −1 to 1. */
export function roughNoise(x: number, z: number): number {
  return 0.65 * valueNoise(x, z) + 0.35 * valueNoise(x * 2 + 17.3, z * 2 - 5.1)
}

function grow(r: LatticeRect | null, i0: number, j0: number, i1: number, j1: number): LatticeRect {
  if (!r) return [i0, j0, i1, j1]
  r[0] = Math.min(r[0], i0)
  r[1] = Math.min(r[1], j0)
  r[2] = Math.max(r[2], i1)
  r[3] = Math.max(r[3], j1)
  return r
}

/** One undo step: each tile's contents before the step first touched it (null: it didn't exist). */
interface Step {
  cause: EditCause
  sculpt: Map<number, Float32Array | null>
  paint: Map<number, Uint16Array | null>
  change: EditChange
  bytes: number
}

/** A shape compiled for distance queries. */
interface Geometry {
  /** Bounds in metres. */
  box: [number, number, number, number]
  /** Whether (x, z) is inside. */
  inside(x: number, z: number): boolean
  /** Distance outside the shape, up to `reach` (Infinity past it). */
  outside(x: number, z: number): number
  /** Arc length fraction along a spline at (x, z) (0 elsewhere). */
  along(x: number, z: number): number
}

const near = new Float64Array(4)

function rectGeometry(
  at: [number, number],
  size: [number, number],
  rotation: number,
  reach: number,
): Geometry {
  const a = (rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const hw = size[0] / 2
  const hd = size[1] / 2
  const ex = Math.abs(cos) * hw + Math.abs(sin) * hd
  const ez = Math.abs(sin) * hw + Math.abs(cos) * hd
  // 0071's rectangles: the width axis is (cos, −sin) in (x, z), the depth axis (sin, cos).
  const local = (x: number, z: number) => {
    const dx = x - at[0]
    const dz = z - at[1]
    near[0] = Math.abs(dx * cos - dz * sin) - hw
    near[1] = Math.abs(dx * sin + dz * cos) - hd
  }
  return {
    box: [at[0] - ex, at[1] - ez, at[0] + ex, at[1] + ez],
    inside: (x, z) => {
      local(x, z)
      return near[0]! <= 0 && near[1]! <= 0
    },
    outside: (x, z) => {
      local(x, z)
      const ou = Math.max(0, near[0]!)
      const ov = Math.max(0, near[1]!)
      const d = Math.sqrt(ou * ou + ov * ov)
      return d <= reach ? d : Infinity
    },
    along: () => 0,
  }
}

function polylineSpline(points: ArrayLike<number>, reach: number): StackSpline {
  return buildSpline(points, 0, 0, Math.max(reach, 1e-3))
}

function polygonGeometry(points: [number, number][], reach: number): Geometry {
  const n = points.length
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  const ring = new Float64Array((n + 1) * 3)
  for (let i = 0; i <= n; i++) {
    const p = points[i % n]!
    ring[i * 3] = p[0]
    ring[i * 3 + 2] = p[1]
    x0 = Math.min(x0, p[0])
    x1 = Math.max(x1, p[0])
    z0 = Math.min(z0, p[1])
    z1 = Math.max(z1, p[1])
  }
  const edges = polylineSpline(ring, reach)
  return {
    box: [x0, z0, x1, z1],
    inside: (x, z) => {
      // Even-odd crossings of a ray toward +x.
      let inside = false
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = points[i]!
        const b = points[j]!
        if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0])
          inside = !inside
      }
      return inside
    },
    outside: (x, z) => nearestOnSpline(edges, x, z, near),
    along: () => 0,
  }
}

function splineGeometry(points: [number, number][], width: number, reach: number): Geometry {
  const flat = new Float64Array(points.length * 3)
  points.forEach((p, i) => {
    flat[i * 3] = p[0]
    flat[i * 3 + 2] = p[1]
  })
  const pts = sampleCatmullRom(flat, false, 0.5)
  const half = width / 2
  const line = polylineSpline(pts, half + reach)
  // Arc length at each tessellated point, for slopes along the spline.
  const count = pts.length / 3
  const lengths = new Float64Array(count)
  for (let i = 1; i < count; i++) {
    const dx = pts[i * 3]! - pts[i * 3 - 3]!
    const dz = pts[i * 3 + 2]! - pts[i * 3 - 1]!
    lengths[i] = lengths[i - 1]! + Math.sqrt(dx * dx + dz * dz)
  }
  const total = lengths[count - 1]! || 1
  return {
    box: [
      line.minX + line.reach - half,
      line.minZ + line.reach - half,
      line.maxX - line.reach + half,
      line.maxZ - line.reach + half,
    ],
    inside: (x, z) => nearestOnSpline(line, x, z, near) <= half,
    outside: (x, z) => {
      const d = nearestOnSpline(line, x, z, near) - half
      return d <= reach ? Math.max(0, d) : Infinity
    },
    along: (x, z) => {
      if (nearestOnSpline(line, x, z, near) === Infinity) return 0
      const s = near[3]!
      const seg = lengths[s + 1]! - lengths[s]!
      return (lengths[s]! + seg * near[2]!) / total
    },
  }
}

function pointOf(v: unknown, path: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]))
    throw bad(`${path} must be [x, z]`, path, 'Metres from the terrain’s corner.')
  return [v[0] as number, v[1] as number]
}

function positive(v: unknown, path: string, what: string): number {
  if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v))
    throw bad(`${what} must be a positive number`, path)
  return v
}

/** Validates a shape and compiles it for queries out to `reach` metres past its edge. */
export function shapeGeometry(shape: EditShape, reach: number): Geometry {
  const s = shape as Record<string, unknown>
  const kinds = ['circle', 'rect', 'polygon', 'spline'].filter((k) => s[k] !== undefined)
  if (kinds.length !== 1) {
    throw bad(
      'A shape has exactly one of "circle", "rect", "polygon" or "spline"',
      '/shape',
      'e.g. { "circle": { "at": [512, 400], "radius": 20 } }',
    )
  }
  if ('circle' in shape) {
    const at = pointOf(shape.circle.at, '/shape/circle/at')
    const r = positive(shape.circle.radius, '/shape/circle/radius', 'radius')
    return {
      box: [at[0] - r, at[1] - r, at[0] + r, at[1] + r],
      inside: (x, z) => (x - at[0]) ** 2 + (z - at[1]) ** 2 <= r * r,
      outside: (x, z) => {
        const d = Math.sqrt((x - at[0]) ** 2 + (z - at[1]) ** 2) - r
        return d <= reach ? Math.max(0, d) : Infinity
      },
      along: () => 0,
    }
  }
  if ('rect' in shape) {
    const size = pointOf(shape.rect.size, '/shape/rect/size')
    if (!(size[0] > 0 && size[1] > 0)) throw bad('size must be positive', '/shape/rect/size')
    return rectGeometry(
      pointOf(shape.rect.at, '/shape/rect/at'),
      size,
      shape.rect.rotation ?? 0,
      reach,
    )
  }
  if ('polygon' in shape) {
    if (!Array.isArray(shape.polygon) || shape.polygon.length < 3)
      throw bad('A polygon needs at least three points', '/shape/polygon')
    return polygonGeometry(
      shape.polygon.map((p, i) => pointOf(p, `/shape/polygon/${i}`)),
      reach,
    )
  }
  const sp = shape.spline
  if (!Array.isArray(sp.points) || sp.points.length < 2)
    throw bad('A spline needs at least two points', '/shape/spline/points')
  return splineGeometry(
    sp.points.map((p, i) => pointOf(p, `/shape/spline/points/${i}`)),
    positive(sp.width, '/shape/spline/width', 'width'),
    reach,
  )
}

/** A region of the lattice with the edit layer's heights: the stack below, the delta, their sum. */
interface Region {
  i0: number
  j0: number
  nx: number
  nz: number
  below: Float64Array
  delta: Float32Array
  g: Float64Array
}

/**
 * A terrain's edit layers (spec 0104): sculpt and paint tiles, the brushes and shapes that write
 * them, undo history, and the save format. Headless and world-free; the runtime (editor.ts) turns
 * its changes into rebaked pages. `onChange` hears every change as it's made.
 */
export class TerrainEdits {
  readonly ctx: EditContext
  readonly sculpt = new Map<number, Float32Array>()
  readonly paint = new Map<number, Uint16Array>()
  private history: Step[] = []
  private future: Step[] = []
  private step: Step | null = null
  private historyBytes = 0
  onChange: ((change: EditChange, cause: EditCause) => void) | undefined
  /** Bumps on every change. */
  version = 0

  constructor(ctx: EditContext) {
    this.ctx = ctx
  }

  get canUndo(): boolean {
    return this.history.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get undoDepth(): number {
    return this.history.length
  }

  get redoDepth(): number {
    return this.future.length
  }

  /** Last leaf sample index per axis (samples run 0…this). */
  private get samplesX(): number {
    return Math.round(this.ctx.layout.sizeX / this.ctx.layout.spacing)
  }

  private get samplesZ(): number {
    return Math.round(this.ctx.layout.sizeZ / this.ctx.layout.spacing)
  }

  private get texelsX(): number {
    return Math.round(this.ctx.layout.sizeX / this.ctx.layout.paintSpacing)
  }

  private get texelsZ(): number {
    return Math.round(this.ctx.layout.sizeZ / this.ctx.layout.paintSpacing)
  }

  // --- steps -----------------------------------------------------------------------------------

  /** Opens an undo step; edits until `close` land in it. */
  open(cause: EditCause): void {
    if (this.step) this.close()
    this.step = {
      cause,
      sculpt: new Map(),
      paint: new Map(),
      change: { sculpt: null, paint: null, clamped: false },
      bytes: 0,
    }
  }

  /** Closes the open step: kept for undo if it changed anything (redo is cleared). */
  close(): EditChange | null {
    const step = this.step
    this.step = null
    if (!step || (step.sculpt.size === 0 && step.paint.size === 0)) return null
    this.history.push(step)
    this.historyBytes += step.bytes
    for (const s of this.future) this.historyBytes -= s.bytes
    this.future = []
    while (
      this.history.length > HISTORY_STEPS ||
      (this.historyBytes > HISTORY_BYTES && this.history.length > 1)
    ) {
      this.historyBytes -= this.history.shift()!.bytes
    }
    return step.change
  }

  /** Reverts the open step and drops it. */
  cancel(): EditChange | null {
    const step = this.step
    this.step = null
    if (!step) return null
    const change = this.swap(step)
    this.report(change, 'undo')
    return change
  }

  /** Puts a step's saved tiles back, keeping the current ones in it (so it can swap back). */
  private swap(step: Step): EditChange {
    const change: EditChange = { sculpt: null, paint: null, clamped: false }
    const s = EDIT_TILE - 1
    for (const [key, before] of step.sculpt) {
      const now = this.sculpt.get(key) ?? null
      if (before) this.sculpt.set(key, before)
      else this.sculpt.delete(key)
      step.sculpt.set(key, now)
      const tx = key % EDIT_KEY
      const tz = Math.floor(key / EDIT_KEY)
      change.sculpt = grow(
        change.sculpt,
        tx * EDIT_TILE,
        tz * EDIT_TILE,
        tx * EDIT_TILE + s,
        tz * EDIT_TILE + s,
      )
    }
    for (const [key, before] of step.paint) {
      const now = this.paint.get(key) ?? null
      if (before) this.paint.set(key, before)
      else this.paint.delete(key)
      step.paint.set(key, now)
      const tx = key % EDIT_KEY
      const tz = Math.floor(key / EDIT_KEY)
      change.paint = grow(
        change.paint,
        tx * EDIT_TILE,
        tz * EDIT_TILE,
        tx * EDIT_TILE + s,
        tz * EDIT_TILE + s,
      )
    }
    // A swap's change is the step's own (tighter than its tiles) when it has one.
    if (step.change.sculpt) change.sculpt = [...step.change.sculpt]
    if (step.change.paint) change.paint = [...step.change.paint]
    return change
  }

  undo(): EditChange | null {
    if (this.step) this.close()
    const step = this.history.pop()
    if (!step) return null
    const change = this.swap(step)
    this.future.push(step)
    this.report(change, 'undo')
    return change
  }

  redo(): EditChange | null {
    if (this.step) this.close()
    const step = this.future.pop()
    if (!step) return null
    const change = this.swap(step)
    this.history.push(step)
    this.report(change, 'redo')
    return change
  }

  private report(change: EditChange, cause: EditCause): void {
    if (!change.sculpt && !change.paint) return
    this.version++
    this.onChange?.(change, cause)
  }

  /** A sculpt tile to write, created on first use and saved into the open step first. */
  private sculptTile(key: number): Float32Array {
    let tile = this.sculpt.get(key)
    const step = this.step
    if (step && !step.sculpt.has(key)) {
      step.sculpt.set(key, tile ? tile.slice() : null)
      step.bytes += TILE_SAMPLES * 4
    }
    if (!tile) {
      tile = new Float32Array(TILE_SAMPLES)
      this.sculpt.set(key, tile)
    }
    return tile
  }

  private paintTile(key: number): Uint16Array {
    let tile = this.paint.get(key)
    const step = this.step
    if (step && !step.paint.has(key)) {
      step.paint.set(key, tile ? tile.slice() : null)
      step.bytes += TILE_SAMPLES * 8
    }
    if (!tile) {
      tile = new Uint16Array(TILE_SAMPLES * 4)
      this.paint.set(key, tile)
    }
    return tile
  }

  // --- reading and writing the sculpt layer ---------------------------------------------------

  /** The edit layer's heights over lattice rect [i0, i1] × [j0, j1] (clipped to the terrain). */
  private region(i0: number, j0: number, i1: number, j1: number): Region | null {
    i0 = Math.max(0, i0)
    j0 = Math.max(0, j0)
    i1 = Math.min(this.samplesX, i1)
    j1 = Math.min(this.samplesZ, j1)
    if (i1 < i0 || j1 < j0) return null
    const nx = i1 - i0 + 1
    const nz = j1 - j0 + 1
    const stack = this.ctx.stack()
    const below = new Float64Array(nx * nz)
    evalHeights(this.ctx.noise(), stack, i0, j0, 1, nx, nz, stack.edits.at, below, false)
    const delta = new Float32Array(nx * nz)
    const g = new Float64Array(nx * nz)
    for (let b = 0; b < nz; b++) {
      const gj = j0 + b
      const row = Math.floor(gj / EDIT_TILE) * EDIT_KEY
      for (let a = 0; a < nx; a++) {
        const gi = i0 + a
        const tile = this.sculpt.get(row + Math.floor(gi / EDIT_TILE))
        const k = b * nx + a
        const d = tile ? tile[(gj % EDIT_TILE) * EDIT_TILE + (gi % EDIT_TILE)]! : 0
        delta[k] = d
        g[k] = below[k]! + d
      }
    }
    return { i0, j0, nx, nz, below, delta, g }
  }

  /** Writes a region's new heights back as deltas, held within heightRange; returns what changed. */
  private writeBack(r: Region, change: EditChange): void {
    const stack = this.ctx.stack()
    const lo = stack.lo
    const hi = stack.hi
    let rect = change.sculpt
    for (let b = 0; b < r.nz; b++) {
      const gj = r.j0 + b
      const row = Math.floor(gj / EDIT_TILE) * EDIT_KEY
      for (let a = 0; a < r.nx; a++) {
        const k = b * r.nx + a
        let h = r.g[k]!
        // Untouched samples stay as they are (even where the source itself is out of range).
        if (h === r.below[k]! + r.delta[k]!) continue
        if (h < lo || h > hi) {
          h = h < lo ? lo : hi
          change.clamped = true
        }
        const d = Math.fround(h - r.below[k]!)
        if (d === r.delta[k]) continue
        const gi = r.i0 + a
        this.sculptTile(row + Math.floor(gi / EDIT_TILE))[
          (gj % EDIT_TILE) * EDIT_TILE + (gi % EDIT_TILE)
        ] = d
        rect = grow(rect, gi, gj, gi, gj)
      }
    }
    change.sculpt = rect
  }

  /** The edit layer's height at (x, z), bilinear between samples. */
  editHeightAt(x: number, z: number): number {
    const sp = this.ctx.layout.spacing
    const fx = Math.min(this.samplesX, Math.max(0, x / sp))
    const fz = Math.min(this.samplesZ, Math.max(0, z / sp))
    const i = Math.min(this.samplesX - 1, Math.floor(fx))
    const j = Math.min(this.samplesZ - 1, Math.floor(fz))
    const r = this.region(i, j, i + 1, j + 1)!
    const u = fx - i
    const v = fz - j
    const g = r.g
    return (g[0]! * (1 - u) + g[1]! * u) * (1 - v) + (g[2]! * (1 - u) + g[3]! * u) * v
  }

  // --- paint -----------------------------------------------------------------------------------

  /**
   * Paints `layer` (−1 erases) into texel record `o` of a tile at weight m: every weight scales by
   * 1 − m, then the layer gains m. A third layer keeps the two heaviest and drops the lightest.
   */
  private paintTexel(tile: Uint16Array, o: number, layer: number, m: number): void {
    let a = tile[o]!
    let b = tile[o + 1]!
    let wa = (tile[o + 2]! / PAINT_ONE) * (1 - m)
    let wb = (tile[o + 3]! / PAINT_ONE) * (1 - m)
    if (layer >= 0) {
      if (wa + wb <= 0) {
        a = layer
        b = layer
        wa = m
        wb = 0
      } else if (a === layer) wa += m
      else if (b === layer && wb > 0) wb += m
      else if (wb <= 0) {
        b = layer
        wb = m
      } else if (m > Math.min(wa, wb)) {
        // Three layers: the lightest drops.
        if (wa < wb) {
          a = layer
          wa = m
        } else {
          b = layer
          wb = m
        }
      }
    }
    if (wb > wa) {
      const l = a
      a = b
      b = l
      const w = wa
      wa = wb
      wb = w
    }
    let qa = Math.round(wa * PAINT_ONE)
    let qb = Math.round(wb * PAINT_ONE)
    if (qa + qb > PAINT_ONE) qb = PAINT_ONE - qa
    if (qb <= 0) {
      qb = 0
      b = a
    }
    if (qa <= 0) {
      qa = 0
      a = 0
      b = 0
    }
    tile[o] = a
    tile[o + 1] = b
    tile[o + 2] = qa
    tile[o + 3] = qb
  }

  /** Paints texels [p0, p1] × [q0, q1] at `weight(x, z)` (0 skips). */
  private paintArea(
    layer: number,
    p0: number,
    q0: number,
    p1: number,
    q1: number,
    weight: (x: number, z: number) => number,
    change: EditChange,
  ): void {
    const ps = this.ctx.layout.paintSpacing
    p0 = Math.max(0, p0)
    q0 = Math.max(0, q0)
    p1 = Math.min(this.texelsX, p1)
    q1 = Math.min(this.texelsZ, q1)
    let rect = change.paint
    for (let q = q0; q <= q1; q++) {
      const row = Math.floor(q / EDIT_TILE) * EDIT_KEY
      for (let p = p0; p <= p1; p++) {
        const m = Math.min(1, weight(p * ps, q * ps))
        if (!(m > 0)) continue
        const key = row + Math.floor(p / EDIT_TILE)
        const existing = this.paint.get(key)
        const o = ((q % EDIT_TILE) * EDIT_TILE + (p % EDIT_TILE)) * 4
        // Erasing where nothing is painted changes nothing.
        if (layer < 0 && (!existing || existing[o + 2]! + existing[o + 3]! === 0)) continue
        const tile = this.paintTile(key)
        const before0 = tile[o]
        const before2 = tile[o + 2]
        const before3 = tile[o + 3]
        const before1 = tile[o + 1]
        this.paintTexel(tile, o, layer, m)
        if (
          tile[o] !== before0 ||
          tile[o + 1] !== before1 ||
          tile[o + 2] !== before2 ||
          tile[o + 3] !== before3
        )
          rect = grow(rect, p, q, p, q)
      }
    }
    change.paint = rect
  }

  /** A paint target's layer index (−1 for null, erasing). */
  layerIndex(name: string | null | undefined, path: string): number {
    if (name === null) return -1
    const layers = this.ctx.layers()
    const i = typeof name === 'string' ? layers.indexOf(name) : -1
    if (i < 0) {
      throw new ShardError(
        'terrain/unknown-layer',
        `No material layer named ${JSON.stringify(name)}`,
        {
          path,
          hint: `Paint names one of the source's layers: ${layers.join(', ') || '(none defined)'}.`,
        },
      )
    }
    return i
  }

  // --- brushes ---------------------------------------------------------------------------------

  /** Starts a stroke at (x, z): its first dab lands now. */
  stroke(options: StrokeOptions, x: number, z: number): EditStroke {
    return new EditStroke(this, options, x, z)
  }

  /**
   * Applies dabs at `points` (x, z pairs) of a stroke at once: one read of the region they cover,
   * the dabs in order, one write back. Reports the change.
   */
  dabs(o: ResolvedStroke, points: ArrayLike<number>, count: number): EditChange {
    const change: EditChange = { sculpt: null, paint: null, clamped: false }
    if (count === 0) return change
    let x0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let z1 = -Infinity
    for (let k = 0; k < count; k++) {
      x0 = Math.min(x0, points[k * 2]! - o.radius)
      x1 = Math.max(x1, points[k * 2]! + o.radius)
      z0 = Math.min(z0, points[k * 2 + 1]! - o.radius)
      z1 = Math.max(z1, points[k * 2 + 1]! + o.radius)
    }
    if (o.paint !== undefined) {
      const ps = this.ctx.layout.paintSpacing
      for (let k = 0; k < count; k++) {
        const cx = points[k * 2]!
        const cz = points[k * 2 + 1]!
        this.paintArea(
          o.paint,
          Math.ceil((cx - o.radius) / ps),
          Math.ceil((cz - o.radius) / ps),
          Math.floor((cx + o.radius) / ps),
          Math.floor((cz + o.radius) / ps),
          (x, z) =>
            o.strength *
            brushWeight(Math.sqrt((x - cx) ** 2 + (z - cz) ** 2) / o.radius, o.falloff),
          change,
        )
      }
      this.report(change, 'stroke')
      return change
    }
    const sp = this.ctx.layout.spacing
    const kr = o.brush === 'smooth' ? Math.max(1, Math.ceil((0.1 * o.radius) / sp)) : 0
    const r = this.region(
      Math.floor(x0 / sp) - kr,
      Math.floor(z0 / sp) - kr,
      Math.ceil(x1 / sp) + kr,
      Math.ceil(z1 / sp) + kr,
    )
    if (!r) return change
    if (o.brush === 'flatten' && o.target === undefined)
      o.target = this.editHeightAt(points[0]!, points[1]!)
    const blur = kr > 0 ? new Float64Array(r.g.length) : undefined
    const line = kr > 0 ? new Float64Array(r.g.length) : undefined
    for (let k = 0; k < count; k++) {
      const cx = points[k * 2]!
      const cz = points[k * 2 + 1]!
      const a0 = Math.max(0, Math.ceil((cx - o.radius) / sp) - r.i0)
      const a1 = Math.min(r.nx - 1, Math.floor((cx + o.radius) / sp) - r.i0)
      const b0 = Math.max(0, Math.ceil((cz - o.radius) / sp) - r.j0)
      const b1 = Math.min(r.nz - 1, Math.floor((cz + o.radius) / sp) - r.j0)
      if (a1 < a0 || b1 < b0) continue
      if (blur && line) boxBlur(r, a0, b0, a1, b1, kr, line, blur)
      for (let b = b0; b <= b1; b++) {
        const z = (r.j0 + b) * sp
        for (let a = a0; a <= a1; a++) {
          const x = (r.i0 + a) * sp
          const w = brushWeight(Math.sqrt((x - cx) ** 2 + (z - cz) ** 2) / o.radius, o.falloff)
          if (w <= 0) continue
          const i = b * r.nx + a
          const g = r.g[i]!
          switch (o.brush) {
            case 'raise':
              r.g[i] = g + w * o.strength
              break
            case 'lower':
              r.g[i] = g - w * o.strength
              break
            case 'flatten':
              r.g[i] = g + Math.min(1, w * o.strength) * (o.target! - g)
              break
            case 'roughen':
              r.g[i] = g + w * o.strength * roughNoise(x / o.scale, z / o.scale)
              break
            default:
              r.g[i] = g + Math.min(1, w * o.strength) * (blur![i]! - g)
          }
        }
      }
    }
    this.writeBack(r, change)
    this.report(change, 'stroke')
    return change
  }

  // --- shapes ----------------------------------------------------------------------------------

  /** Applies a shape edit as one undo step and reports it. */
  shape(edit: ShapeEdit): EditChange {
    const ops = (['set', 'raise', 'lower', 'slope', 'paint'] as const).filter(
      (k) => edit[k] !== undefined,
    )
    if (ops.length !== 1) {
      throw bad(
        'A shape edit has exactly one of "set", "raise", "lower", "slope" or "paint"',
        '',
        'e.g. { "shape": { "circle": { "at": [512, 400], "radius": 20 } }, "set": 4 }',
      )
    }
    const op = ops[0]!
    const edge = edit.edge ?? {}
    if (edge.angle !== undefined && edge.falloff !== undefined)
      throw bad('An edge has an angle or a falloff, not both', '/edge')
    if (edge.angle !== undefined && !(edge.angle > 0 && edge.angle <= 90))
      throw bad('edge.angle is in degrees, over 0 and up to 90', '/edge/angle')
    if (edge.falloff !== undefined && !(edge.falloff >= 0))
      throw bad('edge.falloff is metres, 0 or more', '/edge/falloff')
    if (op === 'paint' && edge.angle !== undefined)
      throw bad('Paint edges take a falloff, not an angle', '/edge/angle')
    const tan =
      edge.angle !== undefined && edge.angle < 90 ? Math.tan((edge.angle * Math.PI) / 180) : 0
    const falloff = edge.falloff ?? 0
    const change: EditChange = { sculpt: null, paint: null, clamped: false }
    this.open('shape')
    try {
      if (op === 'paint') {
        const layer = this.layerIndex(edit.paint, '/paint')
        const strength = edit.strength ?? 1
        if (!(strength >= 0 && strength <= 1)) throw bad('strength is 0–1', '/strength')
        const geo = shapeGeometry(edit.shape, falloff)
        const ps = this.ctx.layout.paintSpacing
        this.paintArea(
          layer,
          Math.floor((geo.box[0] - falloff) / ps),
          Math.floor((geo.box[1] - falloff) / ps),
          Math.ceil((geo.box[2] + falloff) / ps),
          Math.ceil((geo.box[3] + falloff) / ps),
          (x, z) => (geo.inside(x, z) ? strength : strength * fade(geo.outside(x, z), falloff)),
          change,
        )
      } else {
        this.sculptShape(edit, op, tan, falloff, change)
      }
    } catch (err) {
      this.cancel()
      throw err
    }
    this.close()
    this.report(change, 'shape')
    return change
  }

  private sculptShape(
    edit: ShapeEdit,
    op: 'set' | 'raise' | 'lower' | 'slope',
    tan: number,
    falloff: number,
    change: EditChange,
  ): void {
    const num = (v: unknown, path: string) => {
      if (typeof v !== 'number' || !Number.isFinite(v))
        throw bad(`${path.slice(1)} must be a number`, path)
      return v
    }
    let amount = 0
    let h0 = 0
    let h1 = 0
    if (op === 'set') h0 = h1 = num(edit.set, '/set')
    else if (op === 'raise') amount = num(edit.raise, '/raise')
    else if (op === 'lower') amount = -num(edit.lower, '/lower')
    else {
      const s = edit.slope
      if (!Array.isArray(s) || s.length !== 2) throw bad('slope is [start, end] heights', '/slope')
      h0 = num(s[0], '/slope/0')
      h1 = num(s[1], '/slope/1')
    }
    const relative = op === 'raise' || op === 'lower'
    const isSpline = 'spline' in edit.shape
    let from: [number, number] | undefined
    let to: [number, number] | undefined
    if (op === 'slope' && !isSpline) {
      from = pointOf(edit.from, '/from')
      to = pointOf(edit.to, '/to')
    }
    const reach = this.wallReach(edit.shape, tan, falloff, relative, amount, h0, h1)
    const geo = shapeGeometry(edit.shape, reach)
    const sp = this.ctx.layout.spacing
    const r = this.region(
      Math.floor((geo.box[0] - reach) / sp),
      Math.floor((geo.box[1] - reach) / sp),
      Math.ceil((geo.box[2] + reach) / sp),
      Math.ceil((geo.box[3] + reach) / sp),
    )
    if (!r) return
    const ramp = (x: number, z: number) => {
      if (op === 'set') return h0
      let t: number
      if (from && to) {
        const dx = to[0] - from[0]
        const dz = to[1] - from[1]
        const len2 = dx * dx + dz * dz
        t = len2 > 0 ? ((x - from[0]) * dx + (z - from[1]) * dz) / len2 : 0
      } else t = geo.along(x, z)
      return h0 + (h1 - h0) * Math.min(1, Math.max(0, t))
    }
    for (let b = 0; b < r.nz; b++) {
      const z = (r.j0 + b) * sp
      for (let a = 0; a < r.nx; a++) {
        const x = (r.i0 + a) * sp
        const i = b * r.nx + a
        const g = r.g[i]!
        if (geo.inside(x, z)) {
          r.g[i] = relative ? g + amount : ramp(x, z)
          continue
        }
        if (reach <= 0) continue
        const d = geo.outside(x, z)
        if (d === Infinity) continue
        if (tan > 0) {
          const allow = d * tan
          if (relative) r.g[i] = g + Math.sign(amount) * Math.max(0, Math.abs(amount) - allow)
          else {
            const t = ramp(x, z)
            r.g[i] = Math.min(t + allow, Math.max(t - allow, g))
          }
        } else {
          const m = fade(d, falloff)
          if (m <= 0) continue
          r.g[i] = relative ? g + m * amount : g + m * (ramp(x, z) - g)
        }
      }
    }
    this.writeBack(r, change)
  }

  /**
   * How far past a shape its edge reaches: the falloff, or where a wall at the angle meets the
   * ground (from the ground's range around it, which the wall's reach widens).
   */
  private wallReach(
    shape: EditShape,
    tan: number,
    falloff: number,
    relative: boolean,
    amount: number,
    h0: number,
    h1: number,
  ): number {
    if (!(tan > 0)) return falloff
    if (relative) return Math.abs(amount) / tan
    const box = shapeGeometry(shape, 0).box
    const tmin = Math.min(h0, h1)
    const tmax = Math.max(h0, h1)
    let reach = 0
    for (let k = 0; k < 3; k++) {
      const [glo, ghi] = this.groundBounds(box, reach)
      reach = Math.min(MAX_MARGIN, Math.max(0, ghi - tmin, tmax - glo) / tan + 1)
    }
    return reach
  }

  /** How far past its shape an edit's edge reaches (metres): what a preview's second ring shows. */
  reachOf(edit: ShapeEdit): number {
    const edge = edit.edge ?? {}
    if (edge.falloff !== undefined) return edge.falloff
    if (edge.angle === undefined || edge.angle >= 90 || edit.paint !== undefined) return 0
    const tan = Math.tan((edge.angle * Math.PI) / 180)
    const amount = edit.raise ?? (edit.lower !== undefined ? -edit.lower : undefined)
    if (amount !== undefined) return this.wallReach(edit.shape, tan, 0, true, amount, 0, 0)
    const [h0, h1] = edit.slope ?? [edit.set ?? 0, edit.set ?? 0]
    return this.wallReach(edit.shape, tan, 0, false, 0, h0, h1)
  }

  private groundBounds(box: [number, number, number, number], grow: number): [number, number] {
    const b = this.ctx.bounds
    if (!b) {
      const s = this.ctx.stack()
      return [s.lo, s.hi]
    }
    return b(box[0] - grow, box[1] - grow, box[2] + grow, box[3] + grow)
  }

  // --- saving ----------------------------------------------------------------------------------

  /** The layers as save data: nonzero tiles only. */
  save(): TerrainEditsData {
    const l = this.ctx.layout
    const sculpt: TerrainEditsData['sculpt'] = []
    for (const key of [...this.sculpt.keys()].sort((a, b) => a - b)) {
      const tile = this.sculpt.get(key)!
      if (tile.every((v) => v === 0)) continue
      sculpt.push({ tile: [key % EDIT_KEY, Math.floor(key / EDIT_KEY)], data: encodeTile(tile) })
    }
    const paint: TerrainEditsData['paint'] = []
    for (const key of [...this.paint.keys()].sort((a, b) => a - b)) {
      const tile = this.paint.get(key)!
      let any = false
      for (let t = 0; t < TILE_SAMPLES && !any; t++) any = tile[t * 4 + 2]! + tile[t * 4 + 3]! > 0
      if (!any) continue
      paint.push({ tile: [key % EDIT_KEY, Math.floor(key / EDIT_KEY)], data: encodeTile(tile) })
    }
    return {
      format: 1,
      grid: { size: [l.sizeX, l.sizeZ], spacing: l.spacing, paintSpacing: l.paintSpacing },
      layers: [...this.ctx.layers()],
      sculpt,
      paint,
    }
  }

  /** Replaces the layers with saved ones (history cleared); reports the union of old and new. */
  load(data: TerrainEditsData): EditChange {
    const l = this.ctx.layout
    if (
      data?.format !== 1 ||
      !data.grid ||
      data.grid.size?.[0] !== l.sizeX ||
      data.grid.size?.[1] !== l.sizeZ ||
      data.grid.spacing !== l.spacing ||
      data.grid.paintSpacing !== l.paintSpacing
    ) {
      throw new ShardError(
        'terrain/edits-mismatch',
        `These edits are for another grid (${JSON.stringify(data?.grid)}), not ${l.sizeX} × ${l.sizeZ} m at ${l.spacing} m (paint ${l.paintSpacing} m)`,
        {
          hint: 'Edits load into the terrain they were saved from; its size and spacings must match.',
        },
      )
    }
    const sculpt = new Map<number, Float32Array>()
    for (const t of data.sculpt ?? []) {
      sculpt.set(
        editTileKey(t.tile[0], t.tile[1]),
        new Float32Array(decodeTile(t.data, TILE_SAMPLES * 4).buffer),
      )
    }
    // Paint names layers through the data's list, so a reordered source keeps its paint.
    const names = this.ctx.layers()
    const map = (data.layers ?? []).map((n) => {
      const i = names.indexOf(n)
      return i >= 0 ? i : 0xffff
    })
    const paint = new Map<number, Uint16Array>()
    for (const t of data.paint ?? []) {
      const tile = new Uint16Array(decodeTile(t.data, TILE_SAMPLES * 8).buffer)
      for (let k = 0; k < TILE_SAMPLES; k++) {
        tile[k * 4] = map[tile[k * 4]!] ?? 0xffff
        tile[k * 4 + 1] = map[tile[k * 4 + 1]!] ?? 0xffff
      }
      paint.set(editTileKey(t.tile[0], t.tile[1]), tile)
    }
    const change: EditChange = { sculpt: null, paint: null, clamped: false }
    const s = EDIT_TILE - 1
    const cover = (keys: Iterable<number>, kind: 'sculpt' | 'paint') => {
      for (const key of keys) {
        const tx = (key % EDIT_KEY) * EDIT_TILE
        const tz = Math.floor(key / EDIT_KEY) * EDIT_TILE
        change[kind] = grow(change[kind], tx, tz, tx + s, tz + s)
      }
    }
    cover(this.sculpt.keys(), 'sculpt')
    cover(sculpt.keys(), 'sculpt')
    cover(this.paint.keys(), 'paint')
    cover(paint.keys(), 'paint')
    this.step = null
    this.history = []
    this.future = []
    this.historyBytes = 0
    this.sculpt.clear()
    for (const [k, v] of sculpt) this.sculpt.set(k, v)
    this.paint.clear()
    for (const [k, v] of paint) this.paint.set(k, v)
    this.report(change, 'load')
    return change
  }
}

/** A stroke's options with defaults filled in and its paint layer resolved. */
export interface ResolvedStroke {
  brush: SculptBrush
  /** Paint layer index (−1 erases), or undefined for a sculpt stroke. */
  paint: number | undefined
  radius: number
  strength: number
  falloff: number
  spacing: number
  rate: number
  target: number | undefined
  scale: number
}

function resolveStroke(edits: TerrainEdits, o: StrokeOptions): ResolvedStroke {
  const isPaint = o.paint !== undefined
  if (isPaint === (o.brush !== undefined))
    throw bad('A stroke has a "brush" or a "paint" layer (null erases), not both', '')
  if (
    o.brush !== undefined &&
    !['raise', 'lower', 'smooth', 'flatten', 'roughen'].includes(o.brush)
  )
    throw bad('brush is raise, lower, smooth, flatten or roughen', '/brush')
  const radius = positive(o.radius, '/radius', 'radius')
  if (typeof o.strength !== 'number' || !(o.strength >= 0))
    throw bad('strength must be ≥ 0', '/strength')
  const falloff = o.falloff ?? 0.5
  if (!(falloff >= 0 && falloff <= 1)) throw bad('falloff is 0–1 of the radius', '/falloff')
  const relative = o.brush === 'smooth' || o.brush === 'flatten' || isPaint
  if (relative && o.strength > 1) throw bad('strength is 0–1 for this brush', '/strength')
  return {
    brush: o.brush ?? 'raise',
    paint: isPaint ? edits.layerIndex(o.paint, '/paint') : undefined,
    radius,
    strength: o.strength,
    falloff,
    spacing: o.spacing !== undefined ? positive(o.spacing, '/spacing', 'spacing') : radius / 4,
    rate: o.rate ?? 0,
    target: o.height,
    scale: o.scale !== undefined ? positive(o.scale, '/scale', 'scale') : radius / 4,
  }
}

/** Box blur of a region's heights over [a0, a1] × [b0, b1], radius `kr` samples (edges clamped). */
function boxBlur(
  r: Region,
  a0: number,
  b0: number,
  a1: number,
  b1: number,
  kr: number,
  line: Float64Array,
  out: Float64Array,
): void {
  const nx = r.nx
  const g = r.g
  const n = 2 * kr + 1
  const rb0 = Math.max(0, b0 - kr)
  const rb1 = Math.min(r.nz - 1, b1 + kr)
  for (let b = rb0; b <= rb1; b++) {
    for (let a = a0; a <= a1; a++) {
      let s = 0
      for (let k = -kr; k <= kr; k++) s += g[b * nx + Math.min(nx - 1, Math.max(0, a + k))]!
      line[b * nx + a] = s / n
    }
  }
  for (let b = b0; b <= b1; b++) {
    for (let a = a0; a <= a1; a++) {
      let s = 0
      for (let k = -kr; k <= kr; k++) s += line[Math.min(rb1, Math.max(rb0, b + k)) * nx + a]!
      out[b * nx + a] = s / n
    }
  }
}

/**
 * A stroke in progress (spec 0104): dabs every `spacing` metres along the path, and at least
 * `rate` a second, all of one `to()` applied at once. One undo step from start to `end()`.
 */
export class EditStroke {
  private readonly edits: TerrainEdits
  readonly options: ResolvedStroke
  private x: number
  private z: number
  /** Metres travelled since the last dab, and fractional time dabs owed. */
  private carry = 0
  private owed = 0
  private done = false
  private readonly points: number[] = []

  constructor(edits: TerrainEdits, options: StrokeOptions, x: number, z: number) {
    this.edits = edits
    this.options = resolveStroke(edits, options)
    this.x = x
    this.z = z
    edits.open('stroke')
    this.points.push(x, z)
    edits.dabs(this.options, this.points, 1)
  }

  get active(): boolean {
    return !this.done
  }

  /** Drags the stroke to (x, z) over `dt` seconds; returns what changed. */
  to(x: number, z: number, dt = 0): EditChange | null {
    if (this.done) return null
    const o = this.options
    const pts = this.points
    pts.length = 0
    const dx = x - this.x
    const dz = z - this.z
    const len = Math.sqrt(dx * dx + dz * dz)
    let s = o.spacing - this.carry
    while (s <= len) {
      pts.push(this.x + (dx * s) / len, this.z + (dz * s) / len)
      s += o.spacing
    }
    this.carry = len - (s - o.spacing)
    this.owed += dt * o.rate
    const timed = Math.floor(this.owed)
    this.owed -= timed
    if (timed > pts.length / 2) {
      pts.length = 0
      for (let k = 1; k <= timed; k++)
        pts.push(this.x + (dx * k) / timed, this.z + (dz * k) / timed)
      this.carry = 0
    }
    this.x = x
    this.z = z
    if (pts.length === 0) return null
    return this.edits.dabs(o, pts, pts.length / 2)
  }

  /** Finishes the stroke: one undo step. */
  end(): EditChange | null {
    if (this.done) return null
    this.done = true
    return this.edits.close()
  }

  /** Reverts the stroke. */
  cancel(): EditChange | null {
    if (this.done) return null
    this.done = true
    return this.edits.cancel()
  }
}

// --- the save format ---------------------------------------------------------------------------

/** A tile's bytes as byte planes (smooth values deflate better), deflated, base64. */
function encodeTile(values: Float32Array | Uint16Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  const width = values.BYTES_PER_ELEMENT
  const count = values.length
  const planes = new Uint8Array(bytes.length)
  for (let i = 0; i < count; i++)
    for (let p = 0; p < width; p++) planes[p * count + i] = bytes[i * width + p]!
  const packed = deflate(planes)
  let s = ''
  for (let i = 0; i < packed.length; i += 0x8000)
    s += String.fromCharCode(...packed.subarray(i, i + 0x8000))
  return btoa(s)
}

function decodeTile(data: string, size: number): Uint8Array {
  const bin = atob(data)
  const packed = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i)
  const planes = inflate(packed, size)
  const width = size === TILE_SAMPLES * 4 ? 4 : 2
  const count = size / width
  const out = new Uint8Array(size)
  for (let i = 0; i < count; i++)
    for (let p = 0; p < width; p++) out[i * width + p] = planes[p * count + i]!
  return out
}
