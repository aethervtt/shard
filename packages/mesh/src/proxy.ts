import { ShardError } from '@aethervtt/shard-core'
import type { MeshData } from './mesh'

// HLOD proxies (0073): a cell's drawn meshes merged into one mesh per bin (a material, cast or
// not), in world space, with levels of detail that drop whole parts by size. Box-built structure
// (walls, trim, frames) has a seam at every hard edge, so surface simplification keeps almost all
// of it; dropping parts smaller than a pixel never moves a vertex. Parts are sorted by size in each
// bin, largest first, so every level is a prefix of level 0's vertices and indices.
//
// Pure functions over plain arrays: hosts run `buildProxy` on the worker pool (procgen's worker
// module exports it) or inline.

/** One drawn mesh going into a proxy. */
export interface ProxyPart {
  /** The output mesh it merges into: the caller's (material, casting) bin. */
  bin: number
  /** Local-space data. Joints, weights and morph targets are ignored. */
  mesh: MeshData
  /** World matrix: the top three rows, row by row (GlobalTransform's layout). */
  matrix: ArrayLike<number>
  /** Whether its triangles go into the merged positions-only shadow mesh. */
  shadow: boolean
}

/** An occluder's triangles (0116), local space, with its world matrix. */
export interface ProxyOccluder {
  positions: Float32Array
  indices?: Uint16Array | Uint32Array
  matrix: ArrayLike<number>
}

export interface ProxyInput {
  parts: ProxyPart[]
  /** Bins the parts name, 0 to bins − 1. */
  bins: number
  /**
   * The smallest part each level keeps, as a bounds diameter in world units, most detailed first
   * (level 0's is 0: everything). A level that would drop nothing more is skipped.
   */
  levelSizes: number[]
  occluders?: ProxyOccluder[]
  /** Occluders merge per square region this many metres on a side (default 32). */
  occluderRegion?: number
  /** At most this many triangles per region's occluder, the largest kept (default 256). */
  occluderTriangles?: number
}

export interface ProxyLevel {
  /** The smallest part this level keeps (world units). */
  size: number
  /** Per bin: its merged mesh, or null when nothing of it is left at this level. */
  bins: (MeshData | null)[]
  triangles: number
}

export interface ProxyOutput {
  /** Most detailed first. Each bin's mesh is a prefix of level 0's arrays. */
  levels: ProxyLevel[]
  /** Positions-only, world space: every `shadow` part. Null when none casts. */
  shadow: MeshData | null
  /** World-space occluder triangles, one mesh per region. */
  occluders: MeshData[]
  /** World bounds of every part: [minX, minY, minZ, maxX, maxY, maxZ]. */
  bounds: Float32Array
}

type Attr = 'normals' | 'uvs' | 'tangents' | 'colors' | 'uvs1'
const ATTRS: readonly Attr[] = ['normals', 'uvs', 'tangents', 'colors', 'uvs1']
const WIDTH: Record<Attr, number> = { normals: 3, uvs: 2, tangents: 4, colors: 4, uvs1: 2 }

interface Placed {
  part: ProxyPart
  size: number
  vertices: number
  indices: number
}

/** Merges a cell's parts per bin into levels of detail, a shadow mesh and occluders. */
export function buildProxy(input: ProxyInput): ProxyOutput {
  const sizes = input.levelSizes.length > 0 ? input.levelSizes : [0]
  if (sizes[0] !== 0)
    throw new ShardError('mesh/bad-proxy', "A proxy's level 0 must keep every part (size 0)", {
      hint: 'levelSizes starts with 0 and increases.',
    })
  const bounds = new Float32Array([
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])
  const perBin: Placed[][] = Array.from({ length: input.bins }, () => [])
  const box = new Float32Array(6)
  for (const part of input.parts) {
    if (part.bin < 0 || part.bin >= input.bins)
      throw new ShardError('mesh/bad-proxy', `A proxy part names bin ${part.bin} of ${input.bins}`)
    const n = part.mesh.positions.length / 3
    if (n === 0) continue
    worldBox(part.mesh.positions, part.matrix, box)
    for (let k = 0; k < 3; k++) {
      if (box[k]! < bounds[k]!) bounds[k] = box[k]!
      if (box[k + 3]! > bounds[k + 3]!) bounds[k + 3] = box[k + 3]!
    }
    const size = Math.sqrt(
      (box[3]! - box[0]!) * (box[3]! - box[0]!) +
        (box[4]! - box[1]!) * (box[4]! - box[1]!) +
        (box[5]! - box[2]!) * (box[5]! - box[2]!),
    )
    perBin[part.bin]!.push({
      part,
      size,
      vertices: n,
      indices: part.mesh.indices ? part.mesh.indices.length : n,
    })
  }
  // Largest first, so a level is a prefix; ties keep the caller's order (stable sort).
  for (const list of perBin) list.sort((a, b) => b.size - a.size)

  // Level 0's merged arrays per bin; other levels are prefixes of them.
  const full = perBin.map((list) => (list.length > 0 ? mergeBin(list) : null))
  const levels: ProxyLevel[] = []
  let kept = -1
  for (const size of sizes) {
    let parts = 0
    for (const list of perBin) for (const p of list) if (p.size >= size) parts++
    if (parts === 0) break
    // Nothing more dropped than the level before: the same mesh, so no level.
    if (parts === kept) continue
    kept = parts
    let triangles = 0
    const bins = perBin.map((list, b) => {
      const merged = full[b]
      if (!merged) return null
      let vertices = 0
      let indices = 0
      for (const p of list) {
        if (p.size < size) break
        vertices += p.vertices
        indices += p.indices
      }
      if (indices === 0) return null
      triangles += indices / 3
      return prefix(merged, vertices, indices)
    })
    levels.push({ size, bins, triangles })
  }

  return {
    levels,
    shadow: shadowMesh(input.parts),
    occluders: mergeOccluders(
      input.occluders ?? [],
      input.occluderRegion ?? 32,
      input.occluderTriangles ?? 256,
    ),
    bounds,
  }
}

/** The world AABB of local positions under an affine 3×4 matrix (row by row). */
function worldBox(p: Float32Array, m: ArrayLike<number>, out: Float32Array): void {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let z0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  let z1 = Number.NEGATIVE_INFINITY
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!
    const y = p[i + 1]!
    const z = p[i + 2]!
    const wx = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
    const wy = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
    const wz = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
    if (wx < x0) x0 = wx
    if (wy < y0) y0 = wy
    if (wz < z0) z0 = wz
    if (wx > x1) x1 = wx
    if (wy > y1) y1 = wy
    if (wz > z1) z1 = wz
  }
  out[0] = x0
  out[1] = y0
  out[2] = z0
  out[3] = x1
  out[4] = y1
  out[5] = z1
}

/** One bin's parts in world space, in order: the union of their attributes, defaults filled in. */
function mergeBin(list: Placed[]): MeshData {
  let vertexCount = 0
  let indexCount = 0
  const has = new Set<Attr>()
  for (const p of list) {
    vertexCount += p.vertices
    indexCount += p.indices
    for (const a of ATTRS) if (p.part.mesh[a]) has.add(a)
  }
  const positions = new Float32Array(vertexCount * 3)
  const out: MeshData = { positions }
  for (const a of ATTRS) if (has.has(a)) out[a] = new Float32Array(vertexCount * WIDTH[a])
  const indices = new Uint32Array(indexCount)
  out.indices = indices
  let v = 0
  let i = 0
  for (const p of list) {
    const { mesh, matrix: m } = p.part
    const n = p.vertices
    const src = mesh.positions
    for (let k = 0; k < n; k++) {
      const x = src[k * 3]!
      const y = src[k * 3 + 1]!
      const z = src[k * 3 + 2]!
      const o = (v + k) * 3
      positions[o] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
      positions[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
      positions[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
    }
    // Normals by the cofactor matrix (the inverse transpose times the determinant), so scaled
    // parts stay lit right; a mirroring matrix flips windings and tangent handedness.
    const c00 = m[5]! * m[10]! - m[6]! * m[9]!
    const c01 = m[6]! * m[8]! - m[4]! * m[10]!
    const c02 = m[4]! * m[9]! - m[5]! * m[8]!
    const c10 = m[2]! * m[9]! - m[1]! * m[10]!
    const c11 = m[0]! * m[10]! - m[2]! * m[8]!
    const c12 = m[1]! * m[8]! - m[0]! * m[9]!
    const c20 = m[1]! * m[6]! - m[2]! * m[5]!
    const c21 = m[2]! * m[4]! - m[0]! * m[6]!
    const c22 = m[0]! * m[5]! - m[1]! * m[4]!
    const det = m[0]! * c00 + m[1]! * c01 + m[2]! * c02
    const sign = det < 0 ? -1 : 1
    const normals = out.normals
    if (normals) {
      const nsrc = mesh.normals
      for (let k = 0; k < n; k++) {
        const o = (v + k) * 3
        if (!nsrc) {
          normals[o + 1] = 1
          continue
        }
        const x = nsrc[k * 3]!
        const y = nsrc[k * 3 + 1]!
        const z = nsrc[k * 3 + 2]!
        const nx = (c00 * x + c10 * y + c20 * z) * sign
        const ny = (c01 * x + c11 * y + c21 * z) * sign
        const nz = (c02 * x + c12 * y + c22 * z) * sign
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
        normals[o] = nx / len
        normals[o + 1] = ny / len
        normals[o + 2] = nz / len
      }
    }
    const tangents = out.tangents
    if (tangents) {
      const tsrc = mesh.tangents
      for (let k = 0; k < n; k++) {
        const o = (v + k) * 4
        if (!tsrc) {
          tangents[o] = 1
          tangents[o + 3] = 1
          continue
        }
        const x = tsrc[k * 4]!
        const y = tsrc[k * 4 + 1]!
        const z = tsrc[k * 4 + 2]!
        const tx = m[0]! * x + m[1]! * y + m[2]! * z
        const ty = m[4]! * x + m[5]! * y + m[6]! * z
        const tz = m[8]! * x + m[9]! * y + m[10]! * z
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
        tangents[o] = tx / len
        tangents[o + 1] = ty / len
        tangents[o + 2] = tz / len
        tangents[o + 3] = tsrc[k * 4 + 3]! * sign
      }
    }
    for (const a of ['uvs', 'uvs1', 'colors'] as const) {
      const dst = out[a]
      if (!dst) continue
      const s = mesh[a]
      const w = WIDTH[a]
      if (s) dst.set(s.subarray(0, n * w), v * w)
      else if (a === 'colors') dst.fill(1, v * w, (v + n) * w)
    }
    const idx = mesh.indices
    if (idx) {
      if (sign > 0) for (let k = 0; k < idx.length; k++) indices[i + k] = idx[k]! + v
      else
        for (let k = 0; k < idx.length; k += 3) {
          indices[i + k] = idx[k]! + v
          indices[i + k + 1] = idx[k + 2]! + v
          indices[i + k + 2] = idx[k + 1]! + v
        }
    } else {
      for (let k = 0; k < n; k += 3) {
        indices[i + k] = v + k
        indices[i + k + 1] = v + k + (sign > 0 ? 1 : 2)
        indices[i + k + 2] = v + k + (sign > 0 ? 2 : 1)
      }
    }
    v += n
    i += p.indices
  }
  return out
}

/** The first `vertices` and `indices` of a merged bin, as views of its arrays. */
function prefix(full: MeshData, vertices: number, indices: number): MeshData {
  if (vertices * 3 === full.positions.length) return full
  const out: MeshData = { positions: full.positions.subarray(0, vertices * 3) }
  for (const a of ATTRS) {
    const arr = full[a]
    if (arr) out[a] = arr.subarray(0, vertices * WIDTH[a])
  }
  out.indices = full.indices!.subarray(0, indices)
  return out
}

/** Every shadow part's triangles, positions only, in world space. */
function shadowMesh(parts: ProxyPart[]): MeshData | null {
  let vertexCount = 0
  let indexCount = 0
  for (const p of parts) {
    if (!p.shadow) continue
    const n = p.mesh.positions.length / 3
    vertexCount += n
    indexCount += p.mesh.indices ? p.mesh.indices.length : n
  }
  if (indexCount === 0) return null
  const positions = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(indexCount)
  let v = 0
  let i = 0
  for (const p of parts) {
    if (!p.shadow) continue
    const m = p.matrix
    const src = p.mesh.positions
    const n = src.length / 3
    for (let k = 0; k < n; k++) {
      const x = src[k * 3]!
      const y = src[k * 3 + 1]!
      const z = src[k * 3 + 2]!
      const o = (v + k) * 3
      positions[o] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
      positions[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
      positions[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
    }
    // Depth needs no winding fix-up beyond what culling sees: keep the drawn mesh's.
    const det =
      m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
      m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) +
      m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!)
    const flip = det < 0
    const idx = p.mesh.indices
    const count = idx ? idx.length : n
    for (let k = 0; k < count; k += 3) {
      const a = idx ? idx[k]! : k
      const b = idx ? idx[k + 1]! : k + 1
      const c = idx ? idx[k + 2]! : k + 2
      indices[i + k] = a + v
      indices[i + k + 1] = (flip ? c : b) + v
      indices[i + k + 2] = (flip ? b : c) + v
    }
    v += n
    i += count
  }
  return { positions, indices }
}

/**
 * Occluder triangles in world space, bucketed by region (by centroid), each region capped at
 * `cap` triangles, largest first. Dropping an occluder only culls less, so the cap is safe.
 */
function mergeOccluders(occluders: ProxyOccluder[], region: number, cap: number): MeshData[] {
  const buckets = new Map<string, { area: number; tri: Float32Array }[]>()
  for (const o of occluders) {
    const m = o.matrix
    const p = o.positions
    const count = o.indices ? o.indices.length : p.length / 3
    for (let k = 0; k < count; k += 3) {
      const tri = new Float32Array(9)
      for (let c = 0; c < 3; c++) {
        const j = (o.indices ? o.indices[k + c]! : k + c) * 3
        const x = p[j]!
        const y = p[j + 1]!
        const z = p[j + 2]!
        tri[c * 3] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
        tri[c * 3 + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
        tri[c * 3 + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
      }
      const ux = tri[3]! - tri[0]!
      const uy = tri[4]! - tri[1]!
      const uz = tri[5]! - tri[2]!
      const vx = tri[6]! - tri[0]!
      const vy = tri[7]! - tri[1]!
      const vz = tri[8]! - tri[2]!
      const cx = uy * vz - uz * vy
      const cy = uz * vx - ux * vz
      const cz = ux * vy - uy * vx
      const area = Math.sqrt(cx * cx + cy * cy + cz * cz) / 2
      const rx = Math.floor((tri[0]! + tri[3]! + tri[6]!) / 3 / region)
      const rz = Math.floor((tri[2]! + tri[5]! + tri[8]!) / 3 / region)
      const key = `${rx},${rz}`
      let list = buckets.get(key)
      if (!list) {
        list = []
        buckets.set(key, list)
      }
      list.push({ area, tri })
    }
  }
  const out: MeshData[] = []
  for (const key of [...buckets.keys()].sort()) {
    const list = buckets.get(key)!
    list.sort((a, b) => b.area - a.area)
    const kept = list.slice(0, cap)
    const positions = new Float32Array(kept.length * 9)
    const indices = new Uint32Array(kept.length * 3)
    for (let t = 0; t < kept.length; t++) {
      positions.set(kept[t]!.tri, t * 9)
      indices[t * 3] = t * 3
      indices[t * 3 + 1] = t * 3 + 1
      indices[t * 3 + 2] = t * 3 + 2
    }
    out.push({ positions, indices })
  }
  return out
}
