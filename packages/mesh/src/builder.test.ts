import { beforeAll, describe, expect, it } from 'vitest'
import { MeshBuilder } from './builder'
import { encodeMesh } from './codec'
import { Mesh, type MeshData } from './mesh'
import { loadMeshSimplifier, simplifyLods, simplifyMesh } from './simplify'
import { leafCards, treeSkeleton, tubeAlong } from './tree'
import { dcos, dsin } from './trig'

beforeAll(async () => {
  await loadMeshSimplifier()
})

const tris = (m: MeshData) => (m.indices?.length ?? 0) / 3

/** Every triangle's face normal agrees with its vertices' normals (CCW, outward). */
function facesAgree(m: MeshData): number {
  const p = m.positions
  const n = m.normals!
  const t = m.indices!
  let bad = 0
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k]!, t[k + 1]!, t[k + 2]!]
    const e1 = [0, 1, 2].map((i) => p[b * 3 + i]! - p[a * 3 + i]!)
    const e2 = [0, 1, 2].map((i) => p[c * 3 + i]! - p[a * 3 + i]!)
    const f = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ]
    if (Math.hypot(f[0]!, f[1]!, f[2]!) < 1e-12) continue
    const avg = [0, 1, 2].map((i) => n[a * 3 + i]! + n[b * 3 + i]! + n[c * 3 + i]!)
    if (f[0]! * avg[0]! + f[1]! * avg[1]! + f[2]! * avg[2]! <= 0) bad++
  }
  return bad
}

describe('deterministic trig', () => {
  it('matches Math.sin and Math.cos to 1e-13 over many turns', () => {
    for (let i = -2000; i <= 2000; i++) {
      const t = i * 0.0137
      expect(Math.abs(dsin(t) - Math.sin(t))).toBeLessThan(1e-13)
      expect(Math.abs(dcos(t) - Math.cos(t))).toBeLessThan(1e-13)
    }
  })
})

describe('MeshBuilder', () => {
  it('builds valid meshes from every shape, with outward faces', () => {
    const shapes: [string, MeshBuilder][] = [
      ['icosphere', MeshBuilder.create().icosphere(2, 1.5)],
      ['box', MeshBuilder.create().box({ x: 2, y: 1, z: 3 })],
      ['cylinder', MeshBuilder.create().cylinder({ radius: 0.5, height: 2, sides: 9 })],
      ['cone', MeshBuilder.create().cylinder({ radius: 0.5, radiusTop: 0, sides: 7 })],
      ['lathe', MeshBuilder.create().lathe([0.2, 0, 0.6, 0.5, 0.4, 1, 0, 1.2], { sides: 10 })],
      [
        'tube',
        MeshBuilder.create().tube([0, 0, 0, 0, 1, 0.2, 0.3, 2, 0.5, 1, 2.5, 0.5], 0.2, {
          sides: 6,
          caps: true,
        }),
      ],
    ]
    for (const [name, b] of shapes) {
      const data = b.finish()
      const mesh = Mesh.create(data)
      expect(mesh.vertexCount, name).toBeGreaterThan(3)
      expect(facesAgree(data), name).toBe(0)
    }
  })

  it('is deterministic: the same calls give the same bytes', () => {
    const make = () =>
      MeshBuilder.create()
        .icosphere(2)
        .displace((p) => 0.1 * dsin(p[0]! * 7) * dcos(p[1]! * 5))
        .merge(
          MeshBuilder.create().cylinder({ sides: 11 }),
          [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1],
        )
        .weld(1e-5)
        .normals({ angle: 40 })
        .uvsTriplanar(0.5)
        .tangents()
        .finish()
    expect(encodeMesh(make())).toEqual(encodeMesh(make()))
  })

  it('displaceNoise batches every vertex through the sampler', () => {
    const b = MeshBuilder.create().icosphere(1)
    let calls = 0
    b.displaceNoise((points, out) => {
      calls++
      for (let i = 0; i < out.length; i++) out[i] = 1
      expect(points.length).toBe(out.length * 3)
    }, 0.5)
    expect(calls).toBe(1)
    const p = b.finish().positions
    for (let i = 0; i < p.length; i += 3)
      expect(Math.hypot(p[i]!, p[i + 1]!, p[i + 2]!)).toBeCloseTo(1.5, 5)
  })

  it('extrudes a face set outward with side walls', () => {
    // A unit quad in XZ facing +Y.
    const b = MeshBuilder.create()
    const a = b.vertex(0, 0, 0, 0, 1, 0)
    const c = b.vertex(1, 0, 0, 0, 1, 0)
    const d = b.vertex(1, 0, -1, 0, 1, 0)
    const e = b.vertex(0, 0, -1, 0, 1, 0)
    b.quad(a, c, d, e)
    b.extrude([0, 1], 0.5)
    const m = b.finish()
    // Top moved up, four walls added.
    expect(tris(m)).toBe(2 + 8)
    let maxY = 0
    for (let i = 1; i < m.positions.length; i += 3) maxY = Math.max(maxY, m.positions[i]!)
    expect(maxY).toBeCloseTo(0.5)
    expect(facesAgree(m)).toBe(0)
    // Walls face away from the quad's center.
    const t = m.indices!
    for (let k = 6; k < t.length; k += 3) {
      const ids = [t[k]!, t[k + 1]!, t[k + 2]!]
      const cx = ids.reduce((s, v) => s + m.positions[v * 3]!, 0) / 3 - 0.5
      const cz = ids.reduce((s, v) => s + m.positions[v * 3 + 2]!, 0) / 3 + 0.5
      const nx = ids.reduce((s, v) => s + m.normals![v * 3]!, 0)
      const nz = ids.reduce((s, v) => s + m.normals![v * 3 + 2]!, 0)
      expect(cx * nx + cz * nz).toBeGreaterThan(0)
    }
  })

  it('welds duplicates and keeps hard edges past the normal angle', () => {
    const b = MeshBuilder.create().box()
    expect(b.vertexCount).toBe(24)
    b.weld(1e-6)
    expect(b.vertexCount).toBe(8)
    // Box edges are 90°: a 40° limit splits them back into flat faces.
    b.normals({ angle: 40 })
    const m = b.finish()
    expect(m.positions.length / 3).toBe(24)
    for (let i = 0; i < m.normals!.length; i += 3) {
      const axis = [0, 1, 2].filter((k) => Math.abs(m.normals![i + k]!) > 0.999)
      expect(axis.length).toBe(1)
    }
    // A 180° limit smooths every corner instead.
    const smooth = MeshBuilder.create().box().weld().normals({ angle: 180 }).finish()
    expect(smooth.positions.length / 3).toBe(8)
  })
})

describe('simplifyLods (meshoptimizer)', () => {
  it('meets each fraction within 10% and keeps the source attributes', () => {
    const mesh = MeshBuilder.create().icosphere(4).uvsTriplanar(0.5).finish()
    const lods = simplifyLods(mesh, [0.5, 0.2, 0.05])
    const full = tris(mesh)
    for (const [i, f] of [0.5, 0.2, 0.05].entries()) {
      const got = tris(lods[i]!) / full
      expect(got).toBeLessThanOrEqual(f * 1.1)
      expect(got).toBeGreaterThanOrEqual(f * 0.9)
      expect(lods[i]!.uvs!.length).toBe((lods[i]!.positions.length / 3) * 2)
      Mesh.create(lods[i]!)
    }
  })

  it('opens no cracks along UV seams: a closed mesh stays closed', () => {
    // A capped lathe: closed, with its seam column (u = 0 and 1) duplicated for UVs.
    const mesh = MeshBuilder.create()
      .lathe([0.5, 0, 0.8, 0.5, 0.6, 1, 0.3, 1.4, 0.4, 1.8], { sides: 24 })
      .finish()
    const open = (m: MeshData) => {
      // Edges by position: each must be shared by an even number of triangles.
      const key = (v: number) =>
        [0, 1, 2].map((k) => Math.round(m.positions[v * 3 + k]! * 1e5) + 0).join(',')
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
    expect(open(mesh)).toBe(0)
    const lods = simplifyLods(mesh, [0.5, 0.25])
    expect(lods.map(open)).toEqual([0, 0])
  })

  it('keeps borders in place with lockBorder', () => {
    const b = MeshBuilder.create()
    // A 16×16 grid, slightly bumpy.
    const n = 17
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) b.vertex(i, dsin(i * 0.7) * dcos(j * 0.9) * 0.2, j, 0, 1, 0)
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = i + j * n
        b.quad(a, a + n, a + n + 1, a + 1)
      }
    const mesh = b.finish()
    const { mesh: lod } = simplifyMesh(mesh, 0.1, { lockBorder: true })
    const border = (x: number, z: number) => x === 0 || z === 0 || x === n - 1 || z === n - 1
    let kept = 0
    for (let v = 0; v < lod.positions.length / 3; v++)
      if (border(lod.positions[v * 3]!, lod.positions[v * 3 + 2]!)) kept++
    expect(kept).toBe(4 * (n - 1))
  })
})

describe('trees', () => {
  it('builds the same skeleton and mesh for the same seed, and a different one per seed', () => {
    const make = (seed: number) => {
      const sk = treeSkeleton({ seed, levels: 2, branches: 4 })
      const b = MeshBuilder.create()
      tubeAlong(b, sk, { sides: 7 })
      leafCards(b, sk, { seed, density: 4 })
      return { sk, data: b.finish() }
    }
    const a = make(3)
    const again = make(3)
    expect(encodeMesh(a.data)).toEqual(encodeMesh(again.data))
    expect(a.sk.branches.length).toBe(1 + 4 + 16)
    expect(a.sk.height).toBeGreaterThan(5)
    expect(encodeMesh(make(4).data)).not.toEqual(encodeMesh(a.data))
    Mesh.create(a.data)
  })
})
