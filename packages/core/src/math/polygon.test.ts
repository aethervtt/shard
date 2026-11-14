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

  it('bridges holes that lie at different heights, or against the outline', () => {
    // A long floor with a stairwell at each end, off to opposite sides: the second hole's bridge
    // has to pass the first's (Risen's apartment floors lost two thirds of their area).
    const outer = [26.6, 38, 26.6, 9, 11.4, 9, 11.4, 38]
    const a = [12.59, 24.65, 12.59, 21.08, 11.46, 21.08, 11.46, 24.65]
    const b = [26.54, 36.75, 26.54, 33.18, 25.41, 33.18, 25.41, 36.75]
    const c = [22, 30, 23, 30, 23, 25, 22, 25]
    const area = (h: number[]) => Math.abs(signedArea(h))
    for (const holes of [
      [a, b],
      [a, c],
      [[14, 20, 15, 20, 15, 15, 14, 15], c],
    ]) {
      const points = [...outer, ...holes.flat()]
      const starts = [4, 4 + holes[0]!.length / 2]
      const expected = area(outer) - area(holes[0]!) - area(holes[1]!)
      expect(trianglesArea(points, triangulate(points, starts))).toBeCloseTo(expected, 6)
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
