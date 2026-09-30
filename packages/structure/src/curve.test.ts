import { describe, expect, it } from 'vitest'
import { arcOf, pointAt, quadraticToCubic, sampleWall } from './curve'

/** Distance from (x, z) to the segment (ax, az)–(bx, bz). */
function toSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t))
}

function cubic(p: number[][], t: number): [number, number] {
  const u = 1 - t
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return [0, 1].map((k) => w.reduce((acc, wi, i) => acc + wi * p[i]![k]!, 0)) as [number, number]
}

describe('wall curves', () => {
  it('samples a straight wall as its two ends', () => {
    const c = sampleWall({ a: [1, 2], b: [4, 6] })
    expect(c.count).toBe(2)
    expect(c.length).toBe(5)
    expect([c.nx[0], c.nz[0]]).toEqual([-0.8, 0.6])
  })

  for (const bow of [3, -3, 1.2, 4.5]) {
    it(`samples an arc (bow ${bow}) on its circle, within the tolerance, at its exact length`, () => {
      const input = { a: [0, 0], b: [6, 0], shape: 'arc' as const, bow }
      const arc = arcOf(input)!
      const tolerance = 0.01
      const c = sampleWall(input, tolerance)
      expect([c.x[0], c.z[0]]).toEqual([0, 0])
      expect([c.x[c.count - 1], c.z[c.count - 1]]).toEqual([6, 0])
      for (let i = 0; i < c.count; i++)
        expect(Math.hypot(c.x[i]! - arc.cx, c.z[i]! - arc.cz)).toBeCloseTo(arc.r, 9)
      // The midpoint bows `bow` to the left of a → b (+z here is left of +x).
      const mid = pointAt(c, c.length / 2, new Float64Array(4))
      expect(mid[1]).toBeCloseTo(bow, 2)
      // Every chord within the tolerance: its midpoint's distance from the circle.
      for (let i = 0; i + 1 < c.count; i++) {
        const mx = (c.x[i]! + c.x[i + 1]!) / 2
        const mz = (c.z[i]! + c.z[i + 1]!) / 2
        expect(arc.r - Math.hypot(mx - arc.cx, mz - arc.cz)).toBeLessThanOrEqual(tolerance + 1e-12)
      }
      const exact = arc.r * Math.abs(arc.sweep)
      expect(Math.abs(c.length - exact) / exact).toBeLessThan(0.001)
      expect(c.radius).toBeCloseTo(arc.r, 9)
    })
  }

  it('makes a bow of half the chord a half circle, and more a major arc', () => {
    expect(Math.abs(arcOf({ a: [0, 0], b: [6, 0], bow: 3 })!.sweep)).toBeCloseTo(Math.PI, 9)
    expect(Math.abs(arcOf({ a: [0, 0], b: [6, 0], bow: 5 })!.sweep)).toBeGreaterThan(Math.PI)
  })

  it('keeps a Bézier within the tolerance of the curve', () => {
    const p = [
      [0, 0],
      [2, 6],
      [7, -3],
      [9, 2],
    ]
    const tolerance = 0.01
    const c = sampleWall({ a: p[0]!, b: p[3]!, shape: 'bezier', c0: p[1]!, c1: p[2]! }, tolerance)
    expect(c.count).toBeGreaterThan(8)
    // Dense points of the true curve lie within the tolerance of the sampled polyline.
    for (let k = 0; k <= 2000; k++) {
      const [x, z] = cubic(p, k / 2000)
      let best = Infinity
      for (let i = 0; i + 1 < c.count; i++)
        best = Math.min(best, toSegment(x, z, c.x[i]!, c.z[i]!, c.x[i + 1]!, c.z[i + 1]!))
      expect(best).toBeLessThanOrEqual(tolerance + 1e-9)
    }
  })

  it('converts a quadratic to the same cubic', () => {
    const a = [1, 2]
    const q = [4, 9]
    const b = [8, -1]
    const { c0, c1 } = quadraticToCubic(a, q, b)
    for (let k = 0; k <= 100; k++) {
      const t = k / 100
      const u = 1 - t
      const quad = [0, 1].map((i) => u * u * a[i]! + 2 * u * t * q[i]! + t * t * b[i]!)
      const [x, z] = cubic([a, c0, c1, b], t)
      expect(x).toBeCloseTo(quad[0]!, 12)
      expect(z).toBeCloseTo(quad[1]!, 12)
    }
  })
})
