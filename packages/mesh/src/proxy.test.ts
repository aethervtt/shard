import { describe, expect, it } from 'vitest'
import { box } from './primitives'
import { buildProxy, type ProxyPart } from './proxy'

/** Affine 3×4, row by row: a uniform scale and a translation. */
const at = (x: number, y: number, z: number, s = 1) => [s, 0, 0, x, 0, s, 0, y, 0, 0, s, z]

function part(bin: number, size: number, x: number, shadow = true): ProxyPart {
  return { bin, mesh: box({ x: size, y: size, z: size }).data(), matrix: at(x, 0, 0), shadow }
}

describe('buildProxy', () => {
  it('merges parts per bin in world space, normals and windings right under a mirror', () => {
    const mirror = [-1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0]
    const out = buildProxy({
      parts: [part(0, 1, 0), { ...part(0, 1, 0), matrix: mirror }, part(1, 2, 10)],
      bins: 2,
      levelSizes: [0],
    })
    expect(out.levels).toHaveLength(1)
    const [a, b] = out.levels[0]!.bins
    const cube = box({ x: 1, y: 1, z: 1 }).data()
    expect(a!.positions.length).toBe(cube.positions.length * 2)
    expect(a!.indices!.length).toBe(cube.indices!.length * 2)
    expect(b!.positions[0]! - cube.positions[0]! * 2).toBeCloseTo(10)
    // Every triangle still faces along its vertices' normals, mirrored part included.
    const p = a!.positions
    const n = a!.normals!
    const idx = a!.indices!
    for (let t = 0; t < idx.length; t += 3) {
      const [i, j, k] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3]
      const u = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!]
      const v = [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!]
      const face = [
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ]
      expect(face[0]! * n[i]! + face[1]! * n[i + 1]! + face[2]! * n[i + 2]!).toBeGreaterThan(0)
    }
    expect([...out.bounds].map((x) => Math.round(x * 10) / 10)).toEqual([-0.5, -1, -1, 11, 1, 1])
  })

  it('makes each level a prefix of level 0 that drops the parts under its size', () => {
    const out = buildProxy({
      parts: [part(0, 0.1, 0), part(0, 4, 0), part(0, 0.5, 0), part(1, 0.1, 9)],
      bins: 2,
      levelSizes: [0, 0.3, 0.4, 2, 100],
    })
    // 0.4 drops nothing more than 0.3 did, so it's skipped; 100 keeps nothing, so levels stop.
    expect(out.levels.map((l) => l.size)).toEqual([0, 0.3, 2])
    const [l0, l1, l2] = out.levels
    const tri = box().data().indices!.length / 3
    expect(l0!.triangles).toBe(tri * 4)
    expect(l1!.bins[1], 'bin 1 has nothing left').toBeNull()
    expect(l1!.triangles).toBe(tri * 2)
    expect(l2!.triangles).toBe(tri)
    expect(l1!.bins[0]!.positions.buffer).toBe(l0!.bins[0]!.positions.buffer)
    expect([...l1!.bins[0]!.indices!]).toEqual([...l0!.bins[0]!.indices!.subarray(0, tri * 6)])
  })

  it('merges shadow parts into one positions-only mesh, and caps occluders per region', () => {
    const quad = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 4, 0, 0, 2, 2, 0])
    const out = buildProxy({
      parts: [part(0, 1, 0), part(0, 1, 3, false), part(1, 1, 6)],
      bins: 2,
      levelSizes: [0],
      occluders: [
        { positions: quad, matrix: at(0, 0, 0) },
        { positions: quad, matrix: at(40, 0, 0) },
      ],
      occluderRegion: 32,
      occluderTriangles: 1,
    })
    const cube = box().data()
    expect(out.shadow!.positions.length).toBe(cube.positions.length * 2)
    expect(out.shadow!.normals).toBeUndefined()
    expect(out.occluders).toHaveLength(2)
    // Capped at one: the larger of the two triangles stays.
    expect([...out.occluders[0]!.positions.subarray(0, 3)]).toEqual([2, 0, 0])
  })
})
