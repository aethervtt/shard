import { type NoiseGraph, sampleOffset } from '@shard/noise'
import { faceToDirection } from './cube'

/**
 * Noise origins sit on a lattice this many metres apart in the planet frame. A point samples
 * relative to its nearest lattice point, which depends only on where the point is, so every chunk
 * that has a vertex (a neighbor, a parent, a coarser neighbor at a 2:1 edge) computes the same
 * height for it, bit for bit. Offsets stay under ~55 m, which keeps fine octaves' lattice
 * coordinates in the range 0041's CPU/GPU tolerance is measured over.
 */
export const SNAP = 64

/**
 * Terrain noise is sampled at `direction × radius + NOISE_OFFSET`. Canonical points on cube edges
 * have exactly equal coordinates (x = z), which puts them exactly on a tie of OpenSimplex2's
 * rotated lattice, where the GPU's fused multiply-adds can pick the other lattice branch than the
 * CPU and differ past 0041's tolerance. An asymmetric offset of tens of metres moves the terrain's
 * points off every such plane; to the terrain it's just a shift of the noise.
 */
export const NOISE_OFFSET = [13.71, 27.13, 41.92] as const

/** Per face: normal, right, and up axes. Matches @shard/noise's cube mapping. */
const FACES = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, -1, 0, 0, 0, 1, 0],
] as const

const QUARTER_PI = Math.PI / 4
const probe = new Float64Array(3)

/**
 * The unit direction of grid point (gi, gj) of a face at a grid resolution of `size` segments per
 * face edge. Points on a face's boundary belong to two or three faces; they're computed from the
 * lowest-numbered one, so every chunk sharing the point gets the same bits. Points past the boundary
 * (a chunk's outer border ring) extrapolate the face's plane.
 */
export function gridDirection(
  face: number,
  gi: number,
  gj: number,
  size: number,
  out: Float64Array,
  o: number,
): void {
  faceToDirection(face, -1 + (2 * gi) / size, -1 + (2 * gj) / size, out, o)
  if (face === 0 || (gi !== 0 && gi !== size && gj !== 0 && gj !== size)) return
  const x = out[o]!
  const y = out[o + 1]!
  const z = out[o + 2]!
  for (let f = 0; f < face; f++) {
    const a = FACES[f]!
    const n = x * a[0] + y * a[1] + z * a[2]
    if (n <= 0.5) continue
    const u = Math.atan((x * a[3] + y * a[4] + z * a[5]) / n) / QUARTER_PI
    const v = Math.atan((x * a[6] + y * a[7] + z * a[8]) / n) / QUARTER_PI
    if (Math.abs(u) > 1 + 1e-9 || Math.abs(v) > 1 + 1e-9) continue
    const ci = Math.round(((u + 1) / 2) * size)
    const cj = Math.round(((v + 1) / 2) * size)
    faceToDirection(f, -1 + (2 * ci) / size, -1 + (2 * cj) / size, probe, 0)
    out[o] = probe[0]!
    out[o + 1] = probe[1]!
    out[o + 2] = probe[2]!
    return
  }
}

/**
 * A chunk's sample points: its (n + 2)² grid (one-vertex border for normals) as canonical unit
 * directions, grouped by noise origin (lattice point), with each point's f32 offset from its
 * origin on the noise sphere (direction × radius).
 */
export interface ChunkPoints {
  /** Points per side: n + 2. */
  side: number
  count: number
  dirs: Float64Array
  /** Group (origin) of each point. */
  group: Int32Array
  groups: number
  /** Origins (f64 xyzw, w = 0), 4 per group. */
  origins: Float64Array
  /** Offsets from the point's origin (f32 xyz), per point. */
  local: Float32Array
  /** Points sorted by group: group g is order[start[g] .. start[g + 1]). */
  order: Int32Array
  start: Int32Array
}

export function createChunkPoints(): ChunkPoints {
  return {
    side: 0,
    count: 0,
    dirs: new Float64Array(0),
    group: new Int32Array(0),
    groups: 0,
    origins: new Float64Array(0),
    local: new Float32Array(0),
    order: new Int32Array(0),
    start: new Int32Array(0),
  }
}

// Open-addressing table from lattice cell to group (−1: empty), cleared per chunk.
let tableCell = new Int32Array(0)
let tableGroup = new Int32Array(0)

/** A face-edge's worth of metres at a depth (a quarter circle over 2^depth chunks). */
const chunkMetres = (radius: number, depth: number) => (radius * Math.PI) / 2 / 2 ** depth

/**
 * Trailing zero bits of a grid index (0 counts as `cap`): how many levels up it's still a vertex.
 */
function trailingZeros(i: number, cap: number): number {
  if (i === 0) return cap
  let v = i < 0 ? -i : i
  let z = 0
  while ((v & 1) === 0 && z < cap) {
    v >>>= 1
    z++
  }
  return z
}

const levelSnaps = new Float64Array(32)
/** The coarsest point lattice (m). */
const MAX_SNAP = 4096

/**
 * Fills `out` with a node's sample points, grouped by lattice origins `snap` metres apart. Without
 * `snap`, each point's lattice follows its level (the coarsest depth it's a vertex at, from its
 * grid index): SNAP for points only fine chunks have, up to a quarter of a chunk at that level (at
 * most 4 096 m) for coarser vertices. Every chunk sampling a point picks the same lattice, so shared vertices stay
 * bit-identical across chunks and depths, while a coarse chunk's points fall into a few groups
 * instead of one each (their per-octave origins were most of a job's upload).
 */
export function prepareChunkPoints(
  face: number,
  depth: number,
  x: number,
  y: number,
  resolution: number,
  radius: number,
  out: ChunkPoints,
  snap?: number,
): ChunkPoints {
  const side = resolution + 2
  const count = side * side
  if (out.dirs.length < count * 3) {
    out.dirs = new Float64Array(count * 3)
    out.group = new Int32Array(count)
    out.local = new Float32Array(count * 3)
    out.order = new Int32Array(count)
    out.origins = new Float64Array(count * 4)
    out.start = new Int32Array(count + 1)
  }
  out.side = side
  out.count = count
  const size = 2 ** depth * (resolution - 1)
  const gi0 = x * (resolution - 1) - 1
  const gj0 = y * (resolution - 1) - 1
  const slots = highBit(count * 4)
  if (tableGroup.length < slots) {
    tableCell = new Int32Array(slots * 4)
    tableGroup = new Int32Array(slots)
  }
  // Lattice per level: the smallest power-of-two multiple of SNAP at least a quarter chunk there,
  // at most MAX_SNAP (offsets within 2 km keep f32 inputs to a quarter millimetre).
  const levels = Math.min(depth, 31)
  for (let L = 0; L <= levels; L++) {
    let sn = SNAP
    const size = chunkMetres(radius, L)
    while (sn * 4 < size && sn < MAX_SNAP) sn *= 2
    levelSnaps[L] = snap ?? sn
  }
  // Grid indices at this depth have `resolution − 1` segments per node; level-0 vertices every
  // 2^depth of them.
  const segBits = Math.round(Math.log2(resolution - 1))
  const mask = slots - 1
  tableGroup.fill(-1, 0, slots)
  let groups = 0
  const d = out.dirs
  for (let J = 0; J < side; J++) {
    for (let I = 0; I < side; I++) {
      const k = I + J * side
      const gi = gi0 + I
      const gj = gj0 + J
      gridDirection(face, gi, gj, size, d, k * 3)
      // The point's level: a vertex at depth − (common trailing zeros past the node segments).
      const tz = Math.min(trailingZeros(gi, depth + segBits), trailingZeros(gj, depth + segBits))
      const level = Math.max(0, depth - Math.max(0, tz))
      const sn = levelSnaps[Math.min(level, levels)]!
      const px = d[k * 3]! * radius + NOISE_OFFSET[0]
      const py = d[k * 3 + 1]! * radius + NOISE_OFFSET[1]
      const pz = d[k * 3 + 2]! * radius + NOISE_OFFSET[2]
      const cx = Math.round(px / sn)
      const cy = Math.round(py / sn)
      const cz = Math.round(pz / sn)
      let h = (hashCell(cx, cy, cz) ^ Math.imul(sn, 0x27d4eb2d)) & mask
      while (
        tableGroup[h] !== -1 &&
        (tableCell[h * 4] !== cx ||
          tableCell[h * 4 + 1] !== cy ||
          tableCell[h * 4 + 2] !== cz ||
          tableCell[h * 4 + 3] !== sn)
      )
        h = (h + 1) & mask
      let g: number
      if (tableGroup[h] !== -1) g = tableGroup[h]!
      else {
        tableCell[h * 4] = cx
        tableCell[h * 4 + 1] = cy
        tableCell[h * 4 + 2] = cz
        tableCell[h * 4 + 3] = sn
        g = groups++
        tableGroup[h] = g
        out.origins[g * 4] = cx * sn
        out.origins[g * 4 + 1] = cy * sn
        out.origins[g * 4 + 2] = cz * sn
        out.origins[g * 4 + 3] = 0
      }
      out.group[k] = g
      out.local[k * 3] = px - cx * sn
      out.local[k * 3 + 1] = py - cy * sn
      out.local[k * 3 + 2] = pz - cz * sn
    }
  }
  out.groups = groups
  // Counting sort by group.
  const start = out.start
  start.fill(0, 0, groups + 1)
  for (let k = 0; k < count; k++) start[out.group[k]! + 1]!++
  for (let g = 0; g < groups; g++) start[g + 1]! += start[g]!
  for (let k = 0; k < count; k++) {
    const g = out.group[k]!
    out.order[start[g]!] = k
    start[g]!++
  }
  for (let g = groups; g > 0; g--) start[g] = start[g - 1]!
  start[0] = 0
  return out
}

function highBit(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

function hashCell(x: number, y: number, z: number): number {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b) ^ Math.imul(z, 0xc2b2ae35)
  h ^= h >>> 15
  return h >>> 0
}

let gathered = new Float32Array(0)
let sampled = new Float32Array(0)
const origin = new Float64Array(4)

/**
 * Samples a graph at every point on the CPU, one kernel batch per origin, into `out` (per point).
 * `node` samples an intermediate node (the climate graph's temperature and moisture).
 */
export function sampleChunkPoints(
  graph: NoiseGraph,
  seed: number,
  pts: ChunkPoints,
  out: Float32Array,
  node?: string,
): void {
  if (gathered.length < pts.count * 3) {
    gathered = new Float32Array(pts.count * 3)
    sampled = new Float32Array(pts.count)
  }
  for (let g = 0; g < pts.groups; g++) {
    const a = pts.start[g]!
    const b = pts.start[g + 1]!
    for (let i = a; i < b; i++) {
      const k = pts.order[i]!
      gathered[(i - a) * 3] = pts.local[k * 3]!
      gathered[(i - a) * 3 + 1] = pts.local[k * 3 + 1]!
      gathered[(i - a) * 3 + 2] = pts.local[k * 3 + 2]!
    }
    origin[0] = pts.origins[g * 4]!
    origin[1] = pts.origins[g * 4 + 1]!
    origin[2] = pts.origins[g * 4 + 2]!
    const values = sampled.subarray(0, b - a)
    sampleOffset(graph, seed, origin, gathered.subarray(0, (b - a) * 3), values, node)
    for (let i = a; i < b; i++) out[pts.order[i]!] = values[i - a]!
  }
}

/** One point's height-graph value (a gameplay query): relative to its own lattice origin. */
export function samplePoint(
  graph: NoiseGraph,
  seed: number,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
  out: Float32Array,
  node?: string,
): number {
  const px = dx * radius + NOISE_OFFSET[0]
  const py = dy * radius + NOISE_OFFSET[1]
  const pz = dz * radius + NOISE_OFFSET[2]
  origin[0] = Math.round(px / SNAP) * SNAP
  origin[1] = Math.round(py / SNAP) * SNAP
  origin[2] = Math.round(pz / SNAP) * SNAP
  pointLocal[0] = px - origin[0]
  pointLocal[1] = py - origin[1]
  pointLocal[2] = pz - origin[2]
  sampleOffset(graph, seed, origin, pointLocal, out, node)
  return out[0]!
}

const pointLocal = new Float32Array(3)
