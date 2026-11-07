import { beforeAll, describe, expect, it } from 'vitest'
import { MeshBuilder } from './builder'
import { Mesh, type MeshData } from './mesh'
import { generateLods, loadMeshSimplifier, simplifyMesh, weldMesh } from './simplify'

beforeAll(async () => {
  await loadMeshSimplifier()
})

const tris = (m: MeshData) => (m.indices?.length ?? m.positions.length / 3) / 3

/** A sphere with two joints (blended across the equator) and a morph target on the top half. */
function skinnedSphere(): MeshData {
  const m = MeshBuilder.create().icosphere(4).uvsTriplanar(0.5).finish()
  const n = m.positions.length / 3
  const joints = new Uint16Array(n * 4)
  const weights = new Float32Array(n * 4)
  const lift = new Float32Array(n * 3)
  for (let v = 0; v < n; v++) {
    const y = m.positions[v * 3 + 1]!
    const upper = Math.min(1, Math.max(0, (y + 0.3) / 0.6))
    joints.set([0, 1, 0, 0], v * 4)
    weights.set([1 - upper, upper, 0, 0], v * 4)
    if (y > 0) lift[v * 3 + 1] = y * 0.2
  }
  return { ...m, joints, weights, targets: [{ positions: lift, normals: new Float32Array(n * 3) }] }
}

/**
 * A cube-sphere with flat-shaded faces: each face a curved 24×24 grid with its own vertices, its
 * own UVs, and the face's normal, so the 12 cube edges are hard edges and UV seams.
 */
function facetedCubeSphere(): MeshData {
  const b = MeshBuilder.create()
  const g = 24
  const axes = [
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
  ] as const
  for (const [a, u, w] of axes) {
    for (const sign of [-1, 1]) {
      const first = b.vertexCount
      for (let j = 0; j <= g; j++) {
        for (let i = 0; i <= g; i++) {
          const p = [0, 0, 0]
          p[a] = sign
          p[u] = (i / g) * 2 - 1
          p[w] = (j / g) * 2 - 1
          const len = Math.hypot(p[0]!, p[1]!, p[2]!)
          const normal = [0, 0, 0]
          normal[a] = sign
          b.vertex(
            p[0]! / len,
            p[1]! / len,
            p[2]! / len,
            normal[0]!,
            normal[1]!,
            normal[2]!,
            i / g,
            j / g,
          )
        }
      }
      for (let j = 0; j < g; j++) {
        for (let i = 0; i < g; i++) {
          const c = first + j * (g + 1) + i
          if (sign > 0) b.quad(c, c + 1, c + g + 2, c + g + 1)
          else b.quad(c, c + g + 1, c + g + 2, c + 1)
        }
      }
    }
  }
  return b.finish()
}

/** Edges by position that an odd number of triangles use: 0 for a closed mesh. */
function openEdges(m: MeshData): number {
  const key = (v: number) =>
    [0, 1, 2].map((k) => Math.round(m.positions[v * 3 + k]! * 1e5)).join(',')
  const edges = new Map<string, number>()
  const t = m.indices!
  for (let i = 0; i < t.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(t[i + e]!)
      const b = key(t[i + ((e + 1) % 3)]!)
      if (a === b) continue
      const k = a < b ? `${a}|${b}` : `${b}|${a}`
      edges.set(k, (edges.get(k) ?? 0) + 1)
    }
  }
  return [...edges.values()].filter((n) => n % 2 === 1).length
}

/** Connected parts, by position. */
function parts(m: MeshData): number {
  const n = m.positions.length / 3
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x]!
    return x
  }
  const at = new Map<string, number>()
  for (let v = 0; v < n; v++) {
    const k = `${m.positions[v * 3]},${m.positions[v * 3 + 1]},${m.positions[v * 3 + 2]}`
    if (at.has(k)) parent[find(v)] = find(at.get(k)!)
    else at.set(k, v)
  }
  const t = m.indices!
  for (let i = 0; i < t.length; i += 3) {
    parent[find(t[i + 1]!)] = find(t[i]!)
    parent[find(t[i + 2]!)] = find(t[i]!)
  }
  const roots = new Set<number>()
  for (let i = 0; i < t.length; i++) roots.add(find(t[i]!))
  return roots.size
}

describe('generateLods', () => {
  it('meets each fraction within 10%, with every vertex a source vertex in every attribute', () => {
    const source = skinnedSphere()
    const lods = generateLods(source, [0.5, 0.2, 0.05])
    expect(lods.length).toBe(3)
    const byPosition = new Map<string, number>()
    const n = source.positions.length / 3
    for (let v = 0; v < n; v++)
      byPosition.set(source.positions.subarray(v * 3, v * 3 + 3).join(), v)
    let previous = 0
    for (const [k, { mesh, error }] of lods.entries()) {
      const f = [0.5, 0.2, 0.05][k]!
      expect(tris(mesh) / tris(source)).toBeLessThanOrEqual(f * 1.1)
      expect(tris(mesh) / tris(source)).toBeGreaterThanOrEqual(f * 0.9)
      expect(error).toBeGreaterThan(previous)
      previous = error
      Mesh.create(mesh)
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        const s = byPosition.get(mesh.positions.subarray(v * 3, v * 3 + 3).join())!
        expect(s).toBeDefined()
        const same = (
          a: ArrayLike<number> | undefined,
          b: ArrayLike<number> | undefined,
          w: number,
        ) => {
          for (let c = 0; c < w; c++) if (a![v * w + c] !== b![s * w + c]) return false
          return true
        }
        expect(same(mesh.normals, source.normals, 3)).toBe(true)
        expect(same(mesh.uvs, source.uvs, 2)).toBe(true)
        expect(same(mesh.joints, source.joints, 4)).toBe(true)
        expect(same(mesh.weights, source.weights, 4)).toBe(true)
        expect(same(mesh.targets![0]!.positions, source.targets![0]!.positions, 3)).toBe(true)
        expect(same(mesh.targets![0]!.normals, source.targets![0]!.normals, 3)).toBe(true)
      }
    }
  })

  it('keeps hard edges and UV seams: closed at every level, no triangle across a face', () => {
    const source = facetedCubeSphere()
    expect(openEdges(source)).toBe(0)
    const lods = generateLods(source, [0.5, 0.2, 0.05])
    expect(lods.length).toBe(3)
    for (const { mesh } of lods) {
      expect(openEdges(mesh)).toBe(0)
      const nrm = mesh.normals!
      const t = mesh.indices!
      let across = 0
      for (let i = 0; i < t.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          if (
            nrm[t[i]! * 3 + c] !== nrm[t[i + 1]! * 3 + c] ||
            nrm[t[i]! * 3 + c] !== nrm[t[i + 2]! * 3 + c]
          )
            across++
        }
      }
      expect(across).toBe(0)
    }
  })

  it('keeps every loose part until the last level', () => {
    const b = MeshBuilder.create().icosphere(5)
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2
      b.merge(
        MeshBuilder.create()
          .icosphere(1, 0.03)
          .translate(Math.cos(a) * 1.05, 0.2, Math.sin(a) * 1.05),
      )
    }
    const source = b.finish()
    expect(parts(source)).toBe(21)
    // At 1% the simplifier alone loses some: a level that isn't the last keeps them anyway.
    expect(parts(simplifyMesh(source, 0.01, { keepSeams: true }).mesh)).toBeLessThan(21)
    const lods = generateLods(source, [0.5, 0.2, 0.01, 0.002])
    expect(lods.length).toBe(4)
    for (const { mesh } of lods.slice(0, -1)) expect(parts(mesh)).toBe(21)
    // The last level may prune them, and does.
    expect(parts(lods.at(-1)!.mesh)).toBeLessThan(21)
  })

  it('stops once a level saves under 20% of the previous one', () => {
    const lods = generateLods(MeshBuilder.create().icosphere(4).finish(), [0.5, 0.45, 0.2])
    expect(lods.length).toBe(1)
  })
})

describe('weldMesh', () => {
  it('restores the vertices a per-corner mesh split, keeping the triangles and their values', () => {
    const source = MeshBuilder.create().icosphere(3).uvsTriplanar(0.5).finish()
    const t = source.indices!
    const corner = <T extends Float32Array>(a: T, w: number) => {
      const out = new (a.constructor as new (n: number) => T)(t.length * w)
      for (let k = 0; k < t.length; k++)
        for (let c = 0; c < w; c++) out[k * w + c] = a[t[k]! * w + c]!
      return out
    }
    const split: MeshData = {
      positions: corner(source.positions, 3),
      normals: corner(source.normals!, 3),
      uvs: corner(source.uvs!, 2),
    }
    const welded = weldMesh(split)
    expect(welded.positions.length).toBe(source.positions.length)
    expect(welded.indices!.length).toBe(t.length)
    for (let k = 0; k < t.length; k++) {
      for (let c = 0; c < 3; c++) {
        expect(welded.positions[welded.indices![k]! * 3 + c]).toBe(split.positions[k * 3 + c])
      }
      for (let c = 0; c < 2; c++)
        expect(welded.uvs![welded.indices![k]! * 2 + c]).toBe(split.uvs![k * 2 + c])
    }
  })
})
