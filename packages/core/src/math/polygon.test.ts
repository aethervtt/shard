import { describe, expect, it } from 'vitest'
import { clipToRect, signedArea, trianglesArea, triangulate } from './polygon'

/** A comb: a 60-wide bar with deep notches cut down from the top. */
function comb(width: number, teeth: number, depth: number): number[] {
  const out = [0, 0, width, 0, width, 10 + depth]
  const step = width / (teeth * 2)
  for (let i = teeth * 2; i > 0; i--) {
    const x = i * step
    const top = i % 2 === 0 ? 10 + depth : 10
    out.push(x, top, x - step, top)
  }
  return out
}

describe('polygon', () => {
  it('measures signed area by winding', () => {
    const square = [0, 0, 2, 0, 2, 2, 0, 2]
    expect(signedArea(square)).toBe(4)
    expect(signedArea([0, 0, 0, 2, 2, 2, 2, 0])).toBe(-4)
  })

  it('triangulates a concave polygon to its exact area, in either winding', () => {
    const points = comb(60, 6, 40)
    const area = Math.abs(signedArea(points))
    const tris = triangulate(points)
    expect(tris.length).toBeLessThanOrEqual((points.length / 2 - 2) * 3)
    expect(trianglesArea(points, tris)).toBeCloseTo(area, 6)
    const reversed: number[] = []
    for (let i = points.length - 2; i >= 0; i -= 2) reversed.push(points[i]!, points[i + 1]!)
    expect(trianglesArea(reversed, triangulate(reversed))).toBeCloseTo(area, 6)
  })

  it('bridges holes: a polygon with two holes keeps its exact area', () => {
    const outer = [0, 0, 20, 0, 20, 10, 0, 10]
    const a = [2, 2, 2, 8, 8, 8, 8, 2]
    const b = [12, 3, 16, 3, 14, 7]
    const points = [...outer, ...a, ...b]
    const tris = triangulate(points, [4, 8])
    const expected = 200 - 36 - 8
    expect(trianglesArea(points, tris)).toBeCloseTo(expected, 6)
    // Every triangle winds counter-clockwise.
    for (let i = 0; i < tris.length; i += 3) {
      const [p, q, r] = [tris[i]! * 2, tris[i + 1]! * 2, tris[i + 2]! * 2]
      const cross =
        (points[q]! - points[p]!) * (points[r + 1]! - points[p + 1]!) -
        (points[r]! - points[p]!) * (points[q + 1]! - points[p + 1]!)
      expect(cross).toBeGreaterThanOrEqual(0)
    }
  })

  it('clips a triangle to a rectangle', () => {
    const out = new Float64Array(16)
    const scratch = new Float64Array(16)
    const n = clipToRect([-1, -1, 3, -1, -1, 3], 3, 0, 0, 1, 1, out, scratch)
    expect(Math.abs(signedArea(out, 0, n))).toBeCloseTo(1, 9)
    expect(clipToRect([5, 5, 6, 5, 5, 6], 3, 0, 0, 1, 1, out, scratch)).toBe(0)
  })
})
