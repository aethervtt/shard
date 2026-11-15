import { describe, expect, it } from 'vitest'
import { MeshBuilder, sweepFrames } from './builder'
import { sampleCatmullRom } from './spline'

/** A 90° bend over about 50 m, rising 5 m. */
const BEND = [0, 0, 0, 0, 1, 20, 10, 3, 38, 30, 5, 42]

function edges(indices: ArrayLike<number>): Map<string, number> {
  const count = new Map<string, number>()
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!
      const b = indices[t + ((e + 1) % 3)]!
      const key = a < b ? `${a},${b}` : `${b},${a}`
      count.set(key, (count.get(key) ?? 0) + 1)
    }
  }
  return count
}

/** Indices of a mesh with vertices at the same position merged (caps and seams split them). */
function welded(positions: Float32Array, indices: ArrayLike<number>): number[] {
  const id = new Map<string, number>()
  const map: number[] = []
  for (let v = 0; v < positions.length / 3; v++) {
    const key = `${positions[v * 3]!.toFixed(4)},${positions[v * 3 + 1]!.toFixed(4)},${positions[v * 3 + 2]!.toFixed(4)}`
    if (!id.has(key)) id.set(key, id.size)
    map.push(id.get(key)!)
  }
  return Array.from(indices, (i) => map[i]!)
}

describe('MeshBuilder.sweep (0122)', () => {
  it('sweeps a flat 8 m profile along a straight 100 m curve into an upward strip', () => {
    const m = MeshBuilder.create()
      .sweep([-4, 0, 4, 0], [0, 0, 0, 0, 0, 100], { step: 10, vScale: 0.5 })
      .finish()
    const n = m.positions.length / 3
    expect(n).toBe(11 * 2)
    for (let v = 0; v < n; v++) {
      expect(Math.abs(m.positions[v * 3]!)).toBeCloseTo(4, 9)
      expect(m.positions[v * 3 + 1]).toBe(0)
      expect(m.normals![v * 3 + 1]).toBeCloseTo(1, 9)
    }
    // Facing up: every triangle's normal is +Y.
    const idx = m.indices!
    for (let t = 0; t < idx.length; t += 3) {
      const p = (k: number) => [m.positions[idx[t + k]! * 3]!, m.positions[idx[t + k]! * 3 + 2]!]
      const [ax, az] = p(0)
      const [bx, bz] = p(1)
      const [cx, cz] = p(2)
      // y of (b − a) × (c − a)
      expect((bz! - az!) * (cx! - ax!) - (bx! - ax!) * (cz! - az!)).toBeGreaterThan(0)
    }
    expect(m.uvs![1]).toBe(0)
    expect(m.uvs![(n - 1) * 2 + 1]).toBeCloseTo(50, 9)
    expect([m.uvs![0], m.uvs![2]]).toEqual([0, 1])
  })

  it('keeps every ring level and on its centre line along a climbing bend', () => {
    const f = sweepFrames(BEND, { step: 0.5 })
    const samples = sampleCatmullRom(BEND, false, 0.5)
    expect(f.count).toBe(samples.length / 3)
    for (let i = 0; i < f.count; i++) {
      const k = i * 3
      // The centre line is the sampler's.
      expect([f.centres[k], f.centres[k + 1], f.centres[k + 2]]).toEqual(samples.slice(k, k + 3))
      // Right is horizontal and perpendicular to the curve.
      expect(Math.abs(f.rights[k + 1]!)).toBeLessThan(1e-9)
      const dot =
        f.rights[k]! * f.tangents[k]! +
        f.rights[k + 1]! * f.tangents[k + 1]! +
        f.rights[k + 2]! * f.tangents[k + 2]!
      expect(Math.abs(dot)).toBeLessThan(1e-9)
      expect(f.normals[k + 1]!).toBeGreaterThan(0.99)
    }
    const profile = [-3.5, 0, -3.4, 0.1, 0, 0.15, 3.4, 0.1, 3.5, 0]
    const m = MeshBuilder.create().sweep(profile, BEND, { step: 0.5, smoothAngle: 89 }).finish()
    const cols = 5
    for (let i = 0; i < f.count; i++) {
      for (let c = 0; c < cols; c++) {
        const v = (i * cols + c) * 3
        const x = profile[c * 2]!
        const y = profile[c * 2 + 1]!
        for (let a = 0; a < 3; a++) {
          const want = f.centres[i * 3 + a]! + f.rights[i * 3 + a]! * x + f.normals[i * 3 + a]! * y
          expect(Math.abs(m.positions[v + a]! - want)).toBeLessThan(1e-3)
        }
      }
    }
    // v is the arc length.
    expect(m.uvs![(f.count - 1) * cols * 2 + 1]).toBeCloseTo(f.lengths[f.count - 1]!, 4)
    expect(f.lengths[f.count - 1]!).toBeGreaterThan(50)
  })

  it('splits normals at a kerb’s corners and keeps them smooth across a crown', () => {
    // Road, the kerb's face up, its top, then a sidewalk with a 3° crown: two 90° corners.
    const kerb = [-0.5, 0, 0, 0, 0, 0.15, 0.3, 0.15, 1.3, 0.2, 2.3, 0.15]
    const m = MeshBuilder.create().sweep(kerb, [0, 0, 0, 0, 0, 10], { step: 10 }).finish()
    // Points 1 and 2 split (two columns each), 3 and 4 are smooth: 6 + 2 columns per ring.
    expect(m.positions.length / 3).toBe(2 * 8)
    const n = (v: number) => [m.normals![v * 3]!, m.normals![v * 3 + 1]!, m.normals![v * 3 + 2]!]
    // Columns 2 and 3 are the vertical face (normals across), 1 the road's and 4 the top's (up).
    expect(n(1)[1]).toBeCloseTo(1, 9)
    expect(Math.abs(n(2)[1]!)).toBeLessThan(1e-9)
    expect(Math.abs(n(3)[1]!)).toBeLessThan(1e-9)
    expect(n(4)[1]).toBeCloseTo(1, 9)
    // Across the crown, one column whose normal is between its two segments'.
    expect(n(6)[1]).toBeGreaterThan(0.999)
    expect(Math.abs(n(6)[0]!)).toBeLessThan(1e-9)
  })

  it('is watertight with caps, open or looped, and the same bytes twice', () => {
    // A rail: clockwise square, 0.2 m.
    const rail = [-0.1, 0.1, 0.1, 0.1, 0.1, -0.1, -0.1, -0.1]
    for (const [curve, loop] of [
      [BEND, false],
      [[0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 2, 20], true],
    ] as const) {
      const m = MeshBuilder.create()
        .sweep(rail, curve, { closed: true, caps: true, loop, step: 1 })
        .finish()
      for (const [, uses] of edges(welded(m.positions, m.indices!))) expect(uses).toBe(2)
      // Faces outward: the top face's normals point up.
      expect(Math.max(...Array.from(m.normals!.filter((_, i) => i % 3 === 1)))).toBeGreaterThan(
        0.99,
      )
      const again = MeshBuilder.create()
        .sweep(rail, curve, { closed: true, caps: true, loop, step: 1 })
        .finish()
      expect(again.positions).toEqual(m.positions)
      expect(again.normals).toEqual(m.normals)
    }
  })

  it('banks by roll about the curve', () => {
    const f = sweepFrames([0, 0, 0, 0, 0, 10], { roll: [0.2, 0.2], step: 5 })
    for (let i = 0; i < f.count; i++) expect(f.rights[i * 3 + 1]!).toBeCloseTo(Math.sin(0.2), 6)
  })
})
