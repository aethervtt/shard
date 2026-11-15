import { type Entity, ShardError } from '@aethervtt/shard-core'
import { sampleCatmullRom } from '@aethervtt/shard-mesh'

/** Most samples a river's centre line is tessellated into (the step grows past this). */
export const MAX_RIVER_SAMPLES = 4096
/** Metres per cell of a river's point-query grid. */
const CELL = 8

/** Per sample: world x, z, surface height, half width, depth, flow speed, tangent x, z. */
export const RIVER_STRIDE = 8

/** A river's centre line in the world (spec 0123), with what draws and queries it. */
export interface RiverShape {
  readonly samples: Float64Array
  readonly count: number
  /** Surface heights before the mouths' blend (the blend writes `samples`). */
  readonly heights: Float64Array
  readonly flows: Float64Array
  /** minX, minZ, maxX, maxZ (banks included). */
  readonly bounds: Float64Array
  /** Pieces by grid cell: cell c's pieces are `cellPieces[cellStart[c] .. cellStart[c + 1])`. */
  readonly cellStart: Int32Array
  readonly cellPieces: Int32Array
  readonly cols: number
  readonly rows: number
  /** The longest half width: a point farther than this from every piece is dry. */
  readonly reach: number
  /** Total length along the centre line (m). */
  readonly length: number
}

function bad(entity: Entity, message: string, hint: string): ShardError {
  return new ShardError('water/bad-spline', `Water body ${entity}: ${message}`, {
    hint,
    path: `${entity}/water/WaterSpline`,
  })
}

/**
 * A river from its open spline's points (entity frame): the centre line as uniform Catmull-Rom
 * (shard-mesh, as lakes and 0071's terrain splines are), with surface height, width, depth and flow
 * interpolated the same way, into world XZ through `m` (GlobalTransform rows, the entity's y added
 * to heights). Throws `water/bad-spline` for fewer than 2 points or a width that isn't positive.
 */
export function buildRiver(
  entity: Entity,
  points: readonly { position: readonly number[]; width: number; depth: number; flow: number }[],
  m: ArrayLike<number>,
): RiverShape {
  if (points.length < 2) {
    throw bad(
      entity,
      `a river needs at least 2 points, it has ${points.length}`,
      'Add points along its course to its water/WaterSpline (closed: false).',
    )
  }
  const n = points.length
  for (let i = 0; i < n; i++) {
    if (!(points[i]!.width > 0)) {
      throw bad(
        entity,
        `point ${i}'s width is ${points[i]!.width}`,
        'Every river point needs a width above 0 (m).',
      )
    }
  }
  // One copy per value, its y the value: the same x and z give the sampler the same pieces.
  const copy = (value: (i: number) => number) => {
    const c = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      c[i * 3] = points[i]!.position[0]!
      c[i * 3 + 1] = value(i)
      c[i * 3 + 2] = points[i]!.position[2]!
    }
    return c
  }
  const centre = copy((i) => points[i]!.position[1]!)
  let length = 0
  for (let i = 1; i < n; i++) {
    const dx = centre[i * 3]! - centre[i * 3 - 3]!
    const dz = centre[i * 3 + 2]! - centre[i * 3 - 1]!
    length += Math.sqrt(dx * dx + dz * dz)
  }
  const step = Math.max(1, length / MAX_RIVER_SAMPLES)
  const c = sampleCatmullRom(centre, false, step)
  const w = sampleCatmullRom(
    copy((i) => points[i]!.width),
    false,
    step,
  )
  const d = sampleCatmullRom(
    copy((i) => points[i]!.depth),
    false,
    step,
  )
  const f = sampleCatmullRom(
    copy((i) => points[i]!.flow),
    false,
    step,
  )
  const count = c.length / 3
  const samples = new Float64Array(count * RIVER_STRIDE)
  const bounds = new Float64Array([Infinity, Infinity, -Infinity, -Infinity])
  let reach = 0
  for (let i = 0; i < count; i++) {
    const x = c[i * 3]!
    const z = c[i * 3 + 2]!
    const o = i * RIVER_STRIDE
    samples[o] = m[0]! * x + m[2]! * z + m[3]!
    samples[o + 1] = m[8]! * x + m[10]! * z + m[11]!
    samples[o + 2] = c[i * 3 + 1]! + m[7]!
    samples[o + 3] = Math.max(0, w[i * 3 + 1]!) / 2
    samples[o + 4] = Math.max(0, d[i * 3 + 1]!)
    samples[o + 5] = f[i * 3 + 1]!
    reach = Math.max(reach, samples[o + 3]!)
  }
  let total = 0
  for (let i = 0; i < count; i++) {
    const o = i * RIVER_STRIDE
    const a = Math.max(0, i - 1) * RIVER_STRIDE
    const b = Math.min(count - 1, i + 1) * RIVER_STRIDE
    let tx = samples[b]! - samples[a]!
    let tz = samples[b + 1]! - samples[a + 1]!
    const l = Math.sqrt(tx * tx + tz * tz) || 1
    tx /= l
    tz /= l
    samples[o + 6] = tx
    samples[o + 7] = tz
    const r = samples[o + 3]!
    bounds[0] = Math.min(bounds[0]!, samples[o]! - r)
    bounds[1] = Math.min(bounds[1]!, samples[o + 1]! - r)
    bounds[2] = Math.max(bounds[2]!, samples[o]! + r)
    bounds[3] = Math.max(bounds[3]!, samples[o + 1]! + r)
    if (i > 0) {
      const dx = samples[o]! - samples[o - RIVER_STRIDE]!
      const dz = samples[o + 1]! - samples[o + 1 - RIVER_STRIDE]!
      total += Math.sqrt(dx * dx + dz * dz)
    }
  }
  const heights = new Float64Array(count)
  const flows = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    heights[i] = samples[i * RIVER_STRIDE + 2]!
    flows[i] = samples[i * RIVER_STRIDE + 5]!
  }
  // Pieces by the cells their banks reach.
  const cols = Math.max(1, Math.ceil((bounds[2]! - bounds[0]!) / CELL))
  const rows = Math.max(1, Math.ceil((bounds[3]! - bounds[1]!) / CELL))
  const counts = new Int32Array(cols * rows + 1)
  const visit = (k: number, fn: (cell: number) => void) => {
    const a = k * RIVER_STRIDE
    const b = a + RIVER_STRIDE
    const r = Math.max(samples[a + 3]!, samples[b + 3]!)
    const x0 = Math.min(samples[a]!, samples[b]!) - r
    const z0 = Math.min(samples[a + 1]!, samples[b + 1]!) - r
    const x1 = Math.max(samples[a]!, samples[b]!) + r
    const z1 = Math.max(samples[a + 1]!, samples[b + 1]!) + r
    const c0 = Math.max(0, Math.floor((x0 - bounds[0]!) / CELL))
    const c1 = Math.min(cols - 1, Math.floor((x1 - bounds[0]!) / CELL))
    const r0 = Math.max(0, Math.floor((z0 - bounds[1]!) / CELL))
    const r1 = Math.min(rows - 1, Math.floor((z1 - bounds[1]!) / CELL))
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) fn(row * cols + col)
  }
  for (let k = 0; k < count - 1; k++) visit(k, (cell) => counts[cell + 1]!++)
  for (let i = 0; i < cols * rows; i++) counts[i + 1]! += counts[i]!
  const cellPieces = new Int32Array(counts[cols * rows]!)
  const fill = counts.slice(0, cols * rows)
  for (let k = 0; k < count - 1; k++) visit(k, (cell) => (cellPieces[fill[cell]!++] = k))
  return {
    samples,
    count,
    heights,
    flows,
    bounds,
    cellStart: counts,
    cellPieces,
    cols,
    rows,
    reach,
    length: total,
  }
}

/** What `riverAt` found: the surface, the flow (m/s), the depth of the bed below the surface. */
export interface RiverPoint {
  surface: number
  flowX: number
  flowZ: number
  depth: number
}

/**
 * Whether world (x, z) is in a river (spec 0123): its nearest piece is within that piece's
 * interpolated half width, and it isn't past either end (they're square, as the drawn ribbon's
 * are). Writes the interpolated surface, flow and depth. No allocation.
 */
export function riverAt(r: RiverShape, x: number, z: number, out: RiverPoint): boolean {
  const b = r.bounds
  if (x < b[0]! || z < b[1]! || x > b[2]! || z > b[3]!) return false
  const col = Math.min(r.cols - 1, Math.floor((x - b[0]!) / CELL))
  const row = Math.min(r.rows - 1, Math.floor((z - b[1]!) / CELL))
  const cell = row * r.cols + col
  const s = r.samples
  // The river ends square at its first and last samples, as its ribbon does.
  const e = (r.count - 1) * RIVER_STRIDE
  if ((x - s[0]!) * s[6]! + (z - s[1]!) * s[7]! < 0) return false
  if ((x - s[e]!) * s[e + 6]! + (z - s[e + 1]!) * s[e + 7]! > 0) return false
  let best = Infinity
  let bestK = -1
  let bestT = 0
  for (let p = r.cellStart[cell]!; p < r.cellStart[cell + 1]!; p++) {
    const k = r.cellPieces[p]!
    const a = k * RIVER_STRIDE
    const ax = s[a]!
    const az = s[a + 1]!
    const ex = s[a + RIVER_STRIDE]! - ax
    const ez = s[a + RIVER_STRIDE + 1]! - az
    const ee = ex * ex + ez * ez
    const t = ee > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / ee)) : 0
    const dx = x - (ax + ex * t)
    const dz = z - (az + ez * t)
    const d2 = dx * dx + dz * dz
    if (d2 < best) {
      best = d2
      bestK = k
      bestT = t
    }
  }
  if (bestK < 0) return false
  const a = bestK * RIVER_STRIDE
  const c = a + RIVER_STRIDE
  const t = bestT
  const half = s[a + 3]! + (s[c + 3]! - s[a + 3]!) * t
  if (best > half * half) return false
  out.surface = s[a + 2]! + (s[c + 2]! - s[a + 2]!) * t
  out.depth = s[a + 4]! + (s[c + 4]! - s[a + 4]!) * t
  const speed = s[a + 5]! + (s[c + 5]! - s[a + 5]!) * t
  let tx = s[a + 6]! + (s[c + 6]! - s[a + 6]!) * t
  let tz = s[a + 7]! + (s[c + 7]! - s[a + 7]!) * t
  const l = Math.sqrt(tx * tx + tz * tz) || 1
  tx /= l
  tz /= l
  out.flowX = tx * speed
  out.flowZ = tz * speed
  return true
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * Eases a river's end into the body it runs into (spec 0123): the samples within `max(width, 10 m)`
 * of the end take `level` (smoothstep from the reach's edge to the end) and lose their flow. Starts
 * from the unblended heights and flows each time, so it can run again when either body changes.
 */
export function blendMouth(r: RiverShape, end: 0 | 1, level: number): void {
  const s = r.samples
  const at = end === 0 ? 0 : r.count - 1
  const reach = Math.max(s[at * RIVER_STRIDE + 3]! * 2, 10)
  let along = 0
  for (let k = 0; k < r.count; k++) {
    const i = end === 0 ? k : r.count - 1 - k
    if (k > 0) {
      const j = end === 0 ? i - 1 : i + 1
      const dx = s[i * RIVER_STRIDE]! - s[j * RIVER_STRIDE]!
      const dz = s[i * RIVER_STRIDE + 1]! - s[j * RIVER_STRIDE + 1]!
      along += Math.sqrt(dx * dx + dz * dz)
    }
    if (along >= reach) break
    const m = smoothstep(1 - along / reach)
    const o = i * RIVER_STRIDE
    s[o + 2] = s[o + 2]! + (level - s[o + 2]!) * m
    s[o + 5] = s[o + 5]! * (1 - m)
  }
}

/** Puts a river's unblended heights and flows back (before its mouths blend again). */
export function resetMouths(r: RiverShape): void {
  for (let i = 0; i < r.count; i++) {
    r.samples[i * RIVER_STRIDE + 2] = r.heights[i]!
    r.samples[i * RIVER_STRIDE + 5] = r.flows[i]!
  }
}

/**
 * A river's ribbon for the info raster: two triangles per piece, six floats per corner (x, z,
 * surface height, slot, flow x, flow z), into `out` from `o`. Returns the next offset.
 */
export function riverTriangles(r: RiverShape, slot: number, out: Float32Array, o: number): number {
  const s = r.samples
  const corner = (i: number, side: number) => {
    const a = i * RIVER_STRIDE
    // Left of travel is (−tz, tx) seen from above with x right and z down the screen.
    const nx = -s[a + 7]!
    const nz = s[a + 6]!
    const h = s[a + 3]! * side
    out[o++] = s[a]! + nx * h
    out[o++] = s[a + 1]! + nz * h
    out[o++] = s[a + 2]!
    out[o++] = slot
    out[o++] = s[a + 6]! * s[a + 5]!
    out[o++] = s[a + 7]! * s[a + 5]!
  }
  for (let i = 0; i < r.count - 1; i++) {
    corner(i, 1)
    corner(i, -1)
    corner(i + 1, -1)
    corner(i, 1)
    corner(i + 1, -1)
    corner(i + 1, 1)
  }
  return o
}

/** Floats `riverTriangles` writes. */
export function riverFloats(r: RiverShape): number {
  return Math.max(0, r.count - 1) * 6 * 6
}
