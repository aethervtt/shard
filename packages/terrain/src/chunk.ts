import { ShardError } from '@shard/core'
import type { MeshData } from '@shard/mesh'
import type { NoiseGraph } from '@shard/noise'
import { faceToDirection, nodeExtent } from './cube'
import {
  type ChunkPoints,
  createChunkPoints,
  prepareChunkPoints,
  sampleChunkPoints,
} from './points'

/**
 * How a chunk's vertices are laid out, per resolution `n` (vertices per edge, 2^k + 1). The border
 * ring comes first (so edge locks rewrite one contiguous block), then the interior row by row, then
 * one skirt vertex under each ring vertex. Every chunk of a resolution shares one index buffer.
 */
export interface ChunkLayout {
  resolution: number
  /** Ring vertices: 4 (n − 1), counter-clockwise from (0, 0) seen from outside. */
  ring: number
  /** Surface vertices: n². */
  surface: number
  /** Surface plus skirt: n² + 4 (n − 1). */
  vertexCount: number
  /** Vertex index of grid point (i, j), at `i + j * n`. */
  index: Uint16Array
  /** Grid point of each ring vertex: i, j pairs. */
  ringPoints: Uint16Array
  /** Triangles: the surface, then the skirts (`chunkIndices` with every quadrant, no stitching). */
  indices: Uint16Array
  /** Triangles without skirts (the surface only): colliders, and planets with skirts off. */
  surfaceIndices: Uint16Array
}

const layouts = new Map<number, ChunkLayout>()
const sets = new Map<string, Uint16Array>()

/**
 * A chunk's triangles (cached per combination, so chunks share the array and its GPU index buffer).
 * `mask` picks quadrants (bit q: quadrant q, in child order (x, y), (x+1, y), (x, y+1),
 * (x+1, y+1)): a split waiting for children draws its own quadrants where they're missing and the
 * children elsewhere. `stitch` bit e marks edge e (0 bottom, 1 right, 2 top, 3 left) as meeting a
 * coarser neighbor: that edge's triangles use only its even vertices, the neighbor's, so there's no
 * T-junction (a vertex on the neighbor's edge only up to rounding shows pixel-sized holes).
 *
 * Quads fill the interior; each edge's strip (between the border and the first inner row) is
 * zipped per half, so no triangle crosses a quadrant boundary. Skirts follow the drawn border.
 */
export function chunkIndices(
  n: number,
  mask: number,
  stitch: number,
  skirts: boolean,
): Uint16Array {
  const key = `${n}:${mask}:${stitch}:${skirts}`
  let out = sets.get(key)
  if (out) return out
  const layout = chunkLayout(n)
  const index = layout.index
  const side = n - 1
  const h = side / 2
  const parts: number[] = []
  const quadrant = (i: number, j: number) => (i >= h ? 1 : 0) + (j >= h ? 2 : 0)
  // Interior quads, split along (i, j)–(i+1, j+1): a parent's odd-odd child vertex is on it.
  for (let j = 1; j < side - 1; j++) {
    for (let i = 1; i < side - 1; i++) {
      if (!(mask & (1 << quadrant(i, j)))) continue
      const a = index[i + j * n]!
      const b = index[i + 1 + j * n]!
      const c = index[i + 1 + (j + 1) * n]!
      const d = index[i + (j + 1) * n]!
      parts.push(a, b, c, a, c, d)
    }
  }
  // Edge e at position s (0 to side, counter-clockwise), on the border (depth 0) or the first
  // inner row (depth 1).
  const at = (e: number, s: number, depth: number) => {
    const i = e === 0 ? s : e === 1 ? side - depth : e === 2 ? side - s : depth
    const j = e === 0 ? depth : e === 1 ? s : e === 2 ? side - depth : side - s
    return index[i + j * n]!
  }
  const skirt: number[] = []
  const outer: number[] = []
  const inner: number[] = []
  for (let e = 0; e < 4; e++) {
    const step = stitch & (1 << e) ? 2 : 1
    for (let half = 0; half < 2; half++) {
      const s0 = half * h
      const s1 = s0 + h
      // The half's quadrant: the one containing the border's midpoint there.
      const m = s0 + h / 2
      const q =
        e === 0
          ? quadrant(m, 0)
          : e === 1
            ? quadrant(side, m)
            : e === 2
              ? quadrant(side - m, side)
              : quadrant(0, side - m)
      if (!(mask & (1 << q))) continue
      outer.length = 0
      inner.length = 0
      for (let s = s0; s <= s1; s += step) outer.push(s)
      for (let s = Math.max(1, s0); s <= Math.min(side - 1, s1); s++) inner.push(s)
      let a = 0
      let b = 0
      while (a < outer.length - 1 || b < inner.length - 1) {
        const advanceOuter =
          b === inner.length - 1 || (a < outer.length - 1 && outer[a + 1]! <= inner[b + 1]!)
        if (advanceOuter) {
          parts.push(at(e, outer[a]!, 0), at(e, outer[a + 1]!, 0), at(e, inner[b]!, 1))
          a++
        } else {
          parts.push(at(e, outer[a]!, 0), at(e, inner[b + 1]!, 1), at(e, inner[b]!, 1))
          b++
        }
      }
      if (!skirts) continue
      // Skirt walls under the drawn border, both faces: a crack is covered seen from either side,
      // including a finer neighbor's side of a partial parent's quadrant (no skirt of its own).
      for (let k = 0; k + 1 < outer.length; k++) {
        const va = at(e, outer[k]!, 0)
        const vb = at(e, outer[k + 1]!, 0)
        const sa = layout.surface + va
        const sb = layout.surface + vb
        skirt.push(va, sa, vb, vb, sa, sb, va, vb, sa, vb, sb, sa)
      }
    }
  }
  for (const v of skirt) parts.push(v)
  out = Uint16Array.from(parts)
  sets.set(key, out)
  return out
}

/** Throws `terrain/bad-resolution` unless `n` is 2^k + 1 (5 to 129). */
export function checkResolution(n: number): void {
  const k = Math.log2(n - 1)
  if (!Number.isInteger(k) || k < 2 || k > 7) {
    throw new ShardError('terrain/bad-resolution', `Planet resolution ${n} isn't 2^n + 1`, {
      hint: 'Use 17, 33 (the default), 65, or 129 vertices per chunk edge.',
    })
  }
}

export function chunkLayout(n: number): ChunkLayout {
  let layout = layouts.get(n)
  if (layout) return layout
  checkResolution(n)
  const ring = 4 * (n - 1)
  const surface = n * n
  const index = new Uint16Array(surface)
  const ringPoints = new Uint16Array(ring * 2)
  let r = 0
  const put = (i: number, j: number) => {
    index[i + j * n] = r
    ringPoints[r * 2] = i
    ringPoints[r * 2 + 1] = j
    r++
  }
  for (let i = 0; i < n - 1; i++) put(i, 0)
  for (let j = 0; j < n - 1; j++) put(n - 1, j)
  for (let i = n - 1; i > 0; i--) put(i, n - 1)
  for (let j = n - 1; j > 0; j--) put(0, j)
  let v = ring
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) index[i + j * n] = v++
  layout = {
    resolution: n,
    ring,
    surface,
    vertexCount: surface + ring,
    index,
    ringPoints,
    indices: new Uint16Array(0),
    surfaceIndices: new Uint16Array(0),
  }
  layouts.set(n, layout)
  layout.indices = chunkIndices(n, 15, 0, true)
  layout.surfaceIndices = chunkIndices(n, 15, 0, false)
  return layout
}

/**
 * A vertex's lock code (uv1.x): its edge for ring vertices (0 bottom, 1 right, 2 top, 3 left, where
 * the instance's lock bits apply), the quadrant boundary for vertices on the center lines (4 and 5
 * the vertical line's lower and upper half, 6 and 7 the horizontal line's left and right half, 8
 * the center; locked to this level where a partial draw meets a child), else −1.
 */
export function lockCode(i: number, j: number, n: number, vi: number, ring: number): number {
  if (vi < ring) return Math.floor(vi / (n - 1))
  const h = (n - 1) / 2
  if (i === h && j === h) return 8
  if (i === h) return j < h ? 4 : 5
  if (j === h) return i < h ? 6 : 7
  return -1
}

/** What a chunk is made from: its node, the planet's numbers, and its graphs. */
export interface ChunkSpec {
  face: number
  depth: number
  x: number
  y: number
  radius: number
  shape: ArrayLike<number>
  heightScale: number
  seed: number
  resolution: number
  /** Heights; undefined for a flat surface (the ocean). */
  height: NoiseGraph | undefined
  /** Climate graph with `temperature` and `moisture` nodes, or undefined (both 0). */
  climate: NoiseGraph | undefined
  /** The depth's geometric error (m), for the vertex stage's morph band. */
  morphError: number
  /** How far skirts hang below the border (m). */
  skirtDepth: number
  /** Offset every height by this (m): the ocean surface is at seaLevel. */
  heightOffset?: number
  /** Noise origin spacing (m): only error sampling, which needs no seams, changes it. */
  snap?: number
}

/** A generated chunk: vertex data relative to its center, plus what selection needs to know. */
export interface ChunkMesh {
  /** The chunk's reference point in the planet frame (f64): center direction × radius. */
  center: Float64Array
  data: MeshData
  /** Surface heights (m above radius), row by row. */
  heights: Float32Array
  minHeight: number
  maxHeight: number
  /** Largest distance between a vertex and where its parent level puts it (m). */
  error: number
}

// Scratch reused across chunks (CPU generation runs on one thread at a time).
let values = new Float32Array(0)
let temps = new Float32Array(0)
let moist = new Float32Array(0)
let grid = new Float64Array(0)
const points = createChunkPoints()
const dir = new Float64Array(3)

/** A node's reference point in the planet frame: its center direction × radius (× shape). */
export function chunkCenter(
  face: number,
  depth: number,
  x: number,
  y: number,
  radius: number,
  shape: ArrayLike<number>,
  out: Float64Array,
): Float64Array {
  const ext = nodeExtent(depth)
  faceToDirection(face, -1 + (x + 0.5) * ext, -1 + (y + 0.5) * ext, dir)
  out[0] = dir[0]! * radius * shape[0]!
  out[1] = dir[1]! * radius * shape[1]!
  out[2] = dir[2]! * radius * shape[2]!
  return out
}

/**
 * Builds a chunk on the CPU: samples heights and climate over the node plus a one-vertex border
 * (normals at the edges match the neighbors'), then positions relative to the center in f64,
 * central-difference normals, morph deltas to the parent level, and skirts. The same numbers the
 * GPU kernel writes, from the canonical CPU noise (0041): colliders and headless runs use these.
 * Every point samples relative to its own lattice origin (`SNAP`), so a vertex another chunk shares
 * gets the same height there.
 */
export function buildChunk(spec: ChunkSpec): ChunkMesh {
  const pts = prepareChunkPoints(
    spec.face,
    spec.depth,
    spec.x,
    spec.y,
    spec.resolution,
    spec.radius,
    points,
    spec.snap,
  )
  const count = pts.count
  if (values.length < count) {
    values = new Float32Array(count)
    temps = new Float32Array(count)
    moist = new Float32Array(count)
  }
  if (spec.height) sampleChunkPoints(spec.height, spec.seed, pts, values)
  else values.fill(0, 0, count)
  if (spec.climate) {
    sampleChunkPoints(spec.climate, spec.seed, pts, temps, 'temperature')
    sampleChunkPoints(spec.climate, spec.seed, pts, moist, 'moisture')
  } else {
    temps.fill(0, 0, count)
    moist.fill(0, 0, count)
  }
  return assembleChunk(spec, pts, values, temps, moist)
}

/**
 * The mesh from a chunk's sample points and their values (graph units; heights before
 * `heightScale`): what `buildChunk` does after sampling, and what pool jobs finish with.
 */
export function assembleChunk(
  spec: ChunkSpec,
  pts: ChunkPoints,
  values: Float32Array,
  temps: Float32Array,
  moist: Float32Array,
): ChunkMesh {
  const n = spec.resolution
  const layout = chunkLayout(n)
  const R = spec.radius
  const b = pts.side
  const count = pts.count
  if (grid.length < count * 3) grid = new Float64Array(count * 3)
  const sx = spec.shape[0]!
  const sy = spec.shape[1]!
  const sz = spec.shape[2]!
  const center = chunkCenter(
    spec.face,
    spec.depth,
    spec.x,
    spec.y,
    R,
    spec.shape,
    new Float64Array(3),
  )
  const cx = center[0]!
  const cy = center[1]!
  const cz = center[2]!
  const scale = spec.heightScale
  const offset = spec.heightOffset ?? 0
  const d = pts.dirs
  // Positions of the bordered grid, relative to the center, in f64.
  for (let k = 0; k < count; k++) {
    const r = R + values[k]! * scale + offset
    grid[k * 3] = d[k * 3]! * sx * r - cx
    grid[k * 3 + 1] = d[k * 3 + 1]! * sy * r - cy
    grid[k * 3 + 2] = d[k * 3 + 2]! * sz * r - cz
  }
  const nv = layout.vertexCount
  const positions = new Float32Array(nv * 3)
  const normals = new Float32Array(nv * 3)
  const uvs = new Float32Array(nv * 2)
  const uvs1 = new Float32Array(nv * 2)
  const tangents = new Float32Array(nv * 4)
  const heights = new Float32Array(n * n)
  let minH = Infinity
  let maxH = -Infinity
  let error = 0
  const index = layout.index
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = i + 1 + (j + 1) * b
      const vi = index[i + j * n]!
      const p = k * 3
      positions[vi * 3] = grid[p]!
      positions[vi * 3 + 1] = grid[p + 1]!
      positions[vi * 3 + 2] = grid[p + 2]!
      // Central differences over the bordered grid: right × up points outward.
      const ax = grid[p + 3]! - grid[p - 3]!
      const ay = grid[p + 4]! - grid[p - 2]!
      const az = grid[p + 5]! - grid[p - 1]!
      const up = p + b * 3
      const dn = p - b * 3
      const bx = grid[up]! - grid[dn]!
      const by = grid[up + 1]! - grid[dn + 1]!
      const bz = grid[up + 2]! - grid[dn + 2]!
      let nx = ay * bz - az * by
      let ny = az * bx - ax * bz
      let nz = ax * by - ay * bx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      nx /= len
      ny /= len
      nz /= len
      normals[vi * 3] = nx
      normals[vi * 3 + 1] = ny
      normals[vi * 3 + 2] = nz
      const h = values[k]! * scale + offset
      heights[i + j * n] = h
      if (h < minH) minH = h
      if (h > maxH) maxH = h
      uvs[vi * 2] = temps[k]!
      uvs[vi * 2 + 1] = moist[k]!
      uvs1[vi * 2] = lockCode(i, j, n, vi, layout.ring)
      uvs1[vi * 2 + 1] = spec.morphError
      // Where the parent level puts this vertex: the midpoint of the parent edge (or diagonal)
      // it sits on. Even-even vertices are parent vertices.
      let dx = 0
      let dy = 0
      let dz = 0
      const oddI = (i & 1) === 1
      const oddJ = (j & 1) === 1
      if (oddI || oddJ) {
        const ka = (oddI ? k - 1 : k) - (oddJ ? b : 0)
        const kb = (oddI ? k + 1 : k) + (oddJ ? b : 0)
        dx = (grid[ka * 3]! + grid[kb * 3]!) / 2 - grid[p]!
        dy = (grid[ka * 3 + 1]! + grid[kb * 3 + 1]!) / 2 - grid[p + 1]!
        dz = (grid[ka * 3 + 2]! + grid[kb * 3 + 2]!) / 2 - grid[p + 2]!
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d > error) error = d
      }
      tangents[vi * 4] = dx
      tangents[vi * 4 + 1] = dy
      tangents[vi * 4 + 2] = dz
      tangents[vi * 4 + 3] = h
    }
  }
  // Skirts: a copy of each ring vertex, pushed down along the surface normal of the ellipsoid.
  const rp = layout.ringPoints
  const depth = spec.skirtDepth
  for (let s = 0; s < layout.ring; s++) {
    const i = rp[s * 2]!
    const j = rp[s * 2 + 1]!
    const k = i + 1 + (j + 1) * b
    const px = d[k * 3]! * sx
    const py = d[k * 3 + 1]! * sy
    const pz = d[k * 3 + 2]! * sz
    const dl = Math.sqrt(px * px + py * py + pz * pz) || 1
    const src = s
    const dst = layout.surface + s
    positions[dst * 3] = positions[src * 3]! - (px / dl) * depth
    positions[dst * 3 + 1] = positions[src * 3 + 1]! - (py / dl) * depth
    positions[dst * 3 + 2] = positions[src * 3 + 2]! - (pz / dl) * depth
    normals.copyWithin(dst * 3, src * 3, src * 3 + 3)
    uvs.copyWithin(dst * 2, src * 2, src * 2 + 2)
    uvs1.copyWithin(dst * 2, src * 2, src * 2 + 2)
    tangents.copyWithin(dst * 4, src * 4, src * 4 + 4)
  }
  return {
    center,
    data: { positions, normals, uvs, uvs1, tangents, indices: layout.indices },
    heights,
    minHeight: minH,
    maxHeight: maxH,
    error,
  }
}
