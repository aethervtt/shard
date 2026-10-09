import type { MeshData } from '@aethervtt/shard-mesh'
import type { NoiseGraph } from '@aethervtt/shard-noise'
import { faceToDirection, nodeExtent } from './cube'
import { chunkLayout } from './grid-mesh'
import {
  type ChunkPoints,
  createChunkPoints,
  prepareChunkPoints,
  sampleChunkPoints,
} from './points'

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
      // The grid point (packGrid; tile 0: a render slot adds its own when it shows this).
      uvs1[vi * 2] = i + j * n
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
