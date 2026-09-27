import { ShardError } from '@aethervtt/shard-core'
import {
  box,
  capsule,
  cone,
  cube,
  cylinder,
  type Mesh,
  type MeshData,
  plane,
  sphere,
  torus,
} from '@aethervtt/shard-mesh'
import type { MeshResult } from './generator'

/**
 * Mesh building inside a generator. Deterministic across hosts: only +, *, and sqrt (no trig),
 * so the same inputs give the same bytes in Node, Chrome, and WebKit.
 */
export interface MeshBuilderApi {
  /**
   * A unit icosphere (radius 1) subdivided `detail` times: 12 · 4^detail vertices (well, 10 · 4^d
   * + 2), shared between faces, with normals.
   */
  icosphere(detail: number): MeshData
  /** One of the built-in primitives (the `procedural:` meshes) as data you can change. */
  primitive(
    name: 'box' | 'cube' | 'sphere' | 'plane' | 'cylinder' | 'cone' | 'capsule' | 'torus',
    params?: Record<string, number>,
  ): MeshData
  /** Recomputes smooth normals from the triangles (area-weighted). */
  computeNormals(mesh: MeshData): MeshData
  /**
   * Finishes a mesh: optional normals and tangents, and levels of detail as fractions of the
   * triangle count (`lods: [0.5, 0.2]`), made by vertex clustering.
   */
  finish(
    mesh: MeshData,
    options?: { normals?: boolean; tangents?: boolean; lods?: readonly number[] },
  ): MeshResult
}

// --- icosphere ---------------------------------------------------------------------------------

function icosphere(detail: number): MeshData {
  if (!Number.isInteger(detail) || detail < 0 || detail > 8) {
    throw new ShardError('procgen/bad-mesh', `icosphere detail must be 0 to 8, got ${detail}`, {
      hint: 'Detail 6 is already 40 962 vertices.',
    })
  }
  const phi = (1 + Math.sqrt(5)) / 2
  const base = [
    -1,
    phi,
    0,
    1,
    phi,
    0,
    -1,
    -phi,
    0,
    1,
    -phi,
    0,
    0,
    -1,
    phi,
    0,
    1,
    phi,
    0,
    -1,
    -phi,
    0,
    1,
    -phi,
    phi,
    0,
    -1,
    phi,
    0,
    1,
    -phi,
    0,
    -1,
    -phi,
    0,
    1,
  ]
  let faces = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
    8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ]
  const vertexCount = 10 * 4 ** detail + 2
  const pos = new Float64Array(vertexCount * 3)
  let count = 0
  const add = (x: number, y: number, z: number) => {
    const inv = 1 / Math.sqrt(x * x + y * y + z * z)
    pos[count * 3] = x * inv
    pos[count * 3 + 1] = y * inv
    pos[count * 3 + 2] = z * inv
    return count++
  }
  for (let i = 0; i < 12; i++) add(base[i * 3]!, base[i * 3 + 1]!, base[i * 3 + 2]!)
  for (let level = 0; level < detail; level++) {
    const midpoints = new Map<number, number>()
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * vertexCount + b : b * vertexCount + a
      let m = midpoints.get(key)
      if (m === undefined) {
        m = add(
          pos[a * 3]! + pos[b * 3]!,
          pos[a * 3 + 1]! + pos[b * 3 + 1]!,
          pos[a * 3 + 2]! + pos[b * 3 + 2]!,
        )
        midpoints.set(key, m)
      }
      return m
    }
    const next: number[] = []
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f]!
      const b = faces[f + 1]!
      const c = faces[f + 2]!
      const ab = mid(a, b)
      const bc = mid(b, c)
      const ca = mid(c, a)
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca)
    }
    faces = next
  }
  const positions = new Float32Array(pos)
  const indices = count > 65535 ? new Uint32Array(faces) : new Uint16Array(faces)
  return { positions, normals: positions.slice(), indices }
}

const PRIMITIVES: Record<string, (p: Record<string, number>) => Mesh> = {
  box: (p) => box(p),
  cube: (p) => cube(p),
  sphere: (p) => sphere(p),
  plane: (p) => plane(p),
  cylinder: (p) => cylinder(p),
  cone: (p) => cone(p),
  capsule: (p) => capsule(p),
  torus: (p) => torus(p),
}

// --- normals and tangents ------------------------------------------------------------------------

function triangles(mesh: MeshData): Uint16Array | Uint32Array {
  if (mesh.indices) return mesh.indices
  const n = mesh.positions.length / 3
  const out = n > 65535 ? new Uint32Array(n) : new Uint16Array(n)
  for (let i = 0; i < n; i++) out[i] = i
  return out
}

function computeNormals(mesh: MeshData): MeshData {
  const p = mesh.positions
  const tri = triangles(mesh)
  const acc = new Float64Array(p.length)
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t]! * 3
    const b = tri[t + 1]! * 3
    const c = tri[t + 2]! * 3
    const ux = p[b]! - p[a]!
    const uy = p[b + 1]! - p[a + 1]!
    const uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!
    const vy = p[c + 1]! - p[a + 1]!
    const vz = p[c + 2]! - p[a + 2]!
    // The cross product's length is twice the area: an area-weighted sum.
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    for (const v of [a, b, c]) {
      acc[v] = acc[v]! + nx
      acc[v + 1] = acc[v + 1]! + ny
      acc[v + 2] = acc[v + 2]! + nz
    }
  }
  const normals = new Float32Array(p.length)
  for (let v = 0; v < p.length; v += 3) {
    const x = acc[v]!
    const y = acc[v + 1]!
    const z = acc[v + 2]!
    const len = Math.sqrt(x * x + y * y + z * z)
    if (len > 0) {
      normals[v] = x / len
      normals[v + 1] = y / len
      normals[v + 2] = z / len
    } else normals[v + 1] = 1
  }
  return { ...mesh, normals }
}

/**
 * Per-vertex tangents: from the UV gradient where the mesh has UVs (Lengyel's method, averaged
 * per vertex), otherwise any direction perpendicular to the normal. Not MikkTSpace, so baked
 * normal maps from other tools may not match exactly.
 */
function computeTangents(mesh: MeshData): Float32Array {
  const p = mesh.positions
  const n = mesh.normals!
  const uv = mesh.uvs
  const count = p.length / 3
  const out = new Float32Array(count * 4)
  const tan = new Float64Array(count * 3)
  const bit = new Float64Array(count * 3)
  if (uv) {
    const tri = triangles(mesh)
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t]!
      const b = tri[t + 1]!
      const c = tri[t + 2]!
      const e1x = p[b * 3]! - p[a * 3]!
      const e1y = p[b * 3 + 1]! - p[a * 3 + 1]!
      const e1z = p[b * 3 + 2]! - p[a * 3 + 2]!
      const e2x = p[c * 3]! - p[a * 3]!
      const e2y = p[c * 3 + 1]! - p[a * 3 + 1]!
      const e2z = p[c * 3 + 2]! - p[a * 3 + 2]!
      const du1 = uv[b * 2]! - uv[a * 2]!
      const dv1 = uv[b * 2 + 1]! - uv[a * 2 + 1]!
      const du2 = uv[c * 2]! - uv[a * 2]!
      const dv2 = uv[c * 2 + 1]! - uv[a * 2 + 1]!
      const det = du1 * dv2 - du2 * dv1
      if (det === 0) continue
      const r = 1 / det
      const tx = (e1x * dv2 - e2x * dv1) * r
      const ty = (e1y * dv2 - e2y * dv1) * r
      const tz = (e1z * dv2 - e2z * dv1) * r
      const bx = (e2x * du1 - e1x * du2) * r
      const by = (e2y * du1 - e1y * du2) * r
      const bz = (e2z * du1 - e1z * du2) * r
      for (const v of [a, b, c]) {
        tan[v * 3] = tan[v * 3]! + tx
        tan[v * 3 + 1] = tan[v * 3 + 1]! + ty
        tan[v * 3 + 2] = tan[v * 3 + 2]! + tz
        bit[v * 3] = bit[v * 3]! + bx
        bit[v * 3 + 1] = bit[v * 3 + 1]! + by
        bit[v * 3 + 2] = bit[v * 3 + 2]! + bz
      }
    }
  }
  for (let v = 0; v < count; v++) {
    const nx = n[v * 3]!
    const ny = n[v * 3 + 1]!
    const nz = n[v * 3 + 2]!
    let tx = tan[v * 3]!
    let ty = tan[v * 3 + 1]!
    let tz = tan[v * 3 + 2]!
    if (tx === 0 && ty === 0 && tz === 0) {
      // No UV gradient: the axis least aligned with the normal, made perpendicular.
      const ax = Math.abs(nx)
      const ay = Math.abs(ny)
      const az = Math.abs(nz)
      if (ax <= ay && ax <= az) tx = 1
      else if (ay <= az) ty = 1
      else tz = 1
    }
    // Gram-Schmidt against the normal.
    const d = nx * tx + ny * ty + nz * tz
    tx -= nx * d
    ty -= ny * d
    tz -= nz * d
    const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
    tx /= len
    ty /= len
    tz /= len
    // Handedness: whether the bitangent agrees with n × t.
    const cx = ny * tz - nz * ty
    const cy = nz * tx - nx * tz
    const cz = nx * ty - ny * tx
    const w = cx * bit[v * 3]! + cy * bit[v * 3 + 1]! + cz * bit[v * 3 + 2]! < 0 ? -1 : 1
    out[v * 4] = tx
    out[v * 4 + 1] = ty
    out[v * 4 + 2] = tz
    out[v * 4 + 3] = w
  }
  return out
}

// --- levels of detail --------------------------------------------------------------------------

/** Vertex clustering on a grid of `cells` per axis over the bounds: returns the simplified mesh. */
function cluster(mesh: MeshData, cells: number): MeshData {
  const p = mesh.positions
  const count = p.length / 3
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let v = 0; v < count; v++) {
    minX = Math.min(minX, p[v * 3]!)
    minY = Math.min(minY, p[v * 3 + 1]!)
    minZ = Math.min(minZ, p[v * 3 + 2]!)
    maxX = Math.max(maxX, p[v * 3]!)
    maxY = Math.max(maxY, p[v * 3 + 1]!)
    maxZ = Math.max(maxZ, p[v * 3 + 2]!)
  }
  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1
  const cell = size / cells
  const map = new Int32Array(count)
  const byKey = new Map<number, number>()
  const sums: number[] = []
  const members: number[] = []
  for (let v = 0; v < count; v++) {
    const ix = Math.min(cells - 1, Math.floor((p[v * 3]! - minX) / cell))
    const iy = Math.min(cells - 1, Math.floor((p[v * 3 + 1]! - minY) / cell))
    const iz = Math.min(cells - 1, Math.floor((p[v * 3 + 2]! - minZ) / cell))
    const key = (ix * cells + iy) * cells + iz
    let c = byKey.get(key)
    if (c === undefined) {
      c = members.length
      byKey.set(key, c)
      members.push(0)
      sums.push(0, 0, 0)
    }
    map[v] = c
    members[c] = members[c]! + 1
    sums[c * 3] = sums[c * 3]! + p[v * 3]!
    sums[c * 3 + 1] = sums[c * 3 + 1]! + p[v * 3 + 1]!
    sums[c * 3 + 2] = sums[c * 3 + 2]! + p[v * 3 + 2]!
  }
  const tri = triangles(mesh)
  const kept: number[] = []
  for (let t = 0; t < tri.length; t += 3) {
    const a = map[tri[t]!]!
    const b = map[tri[t + 1]!]!
    const c = map[tri[t + 2]!]!
    if (a !== b && b !== c && c !== a) kept.push(a, b, c)
  }
  const n = members.length
  const positions = new Float32Array(n * 3)
  for (let c = 0; c < n; c++) {
    positions[c * 3] = sums[c * 3]! / members[c]!
    positions[c * 3 + 1] = sums[c * 3 + 1]! / members[c]!
    positions[c * 3 + 2] = sums[c * 3 + 2]! / members[c]!
  }
  const out: MeshData = {
    positions,
    indices: n > 65535 ? new Uint32Array(kept) : new Uint16Array(kept),
  }
  // Colors and UVs average per cluster, like positions.
  for (const [name, width] of [
    ['uvs', 2],
    ['colors', 4],
  ] as const) {
    const src = mesh[name]
    if (!src) continue
    const acc = new Float64Array(n * width)
    for (let v = 0; v < count; v++)
      for (let k = 0; k < width; k++)
        acc[map[v]! * width + k] = acc[map[v]! * width + k]! + src[v * width + k]!
    const avg = new Float32Array(n * width)
    for (let c = 0; c < n; c++)
      for (let k = 0; k < width; k++) avg[c * width + k] = acc[c * width + k]! / members[c]!
    out[name] = avg
  }
  return out
}

/** A level of detail with about `fraction` of the triangles (a binary search over cell sizes). */
function simplify(mesh: MeshData, fraction: number): MeshData {
  const target = Math.max(4, Math.floor((triangles(mesh).length / 3) * fraction))
  let lo = 1
  let hi = 256
  let best = cluster(mesh, 2)
  for (let step = 0; step < 8 && lo <= hi; step++) {
    const cells = (lo + hi) >> 1
    const candidate = cluster(mesh, cells)
    const tris = (candidate.indices?.length ?? 0) / 3
    if (tris <= target) {
      best = candidate
      lo = cells + 1
    } else hi = cells - 1
  }
  return best
}

function finish(
  mesh: MeshData,
  options: { normals?: boolean; tangents?: boolean; lods?: readonly number[] } = {},
): MeshResult {
  const withNormals = (m: MeshData) =>
    options.normals === true || !m.normals ? computeNormals(m) : m
  const withTangents = (m: MeshData) =>
    options.tangents ? { ...m, tangents: computeTangents(m) } : m
  const base = withTangents(withNormals(mesh))
  const lods: MeshData[] = []
  for (const fraction of options.lods ?? []) {
    if (!(fraction > 0 && fraction < 1)) {
      throw new ShardError('procgen/bad-mesh', `LOD fractions are in (0, 1), got ${fraction}`, {
        hint: 'lods: [0.5, 0.2] keeps about half, then a fifth, of the triangles.',
      })
    }
    lods.push(withTangents(computeNormals(simplify(mesh, fraction))))
  }
  return { kind: 'mesh', mesh: base, lods }
}

export const meshBuilder: MeshBuilderApi = {
  icosphere,
  primitive(name, params = {}) {
    const make = PRIMITIVES[name]
    if (!make) {
      throw new ShardError('procgen/bad-mesh', `No primitive "${name}"`, {
        hint: `Primitives: ${Object.keys(PRIMITIVES).join(', ')}.`,
      })
    }
    const data = make(params).data()
    // Copies, so displacing it never touches a shared mesh.
    const out: MeshData = { positions: data.positions.slice() }
    if (data.normals) out.normals = data.normals.slice()
    if (data.uvs) out.uvs = data.uvs.slice()
    if (data.indices) out.indices = data.indices.slice()
    return out
  },
  computeNormals,
  finish,
}
