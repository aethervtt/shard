import { describe, expect, it } from 'vitest'
import { catmullRom, sampleCatmullRom } from './spline'

describe('sampleCatmullRom', () => {
  it('passes through every point, open from the first to the last', () => {
    const points = [0, 1, 0, 10, 2, 0, 10, 3, 10, 0, 4, 10]
    const out = sampleCatmullRom(points, false, 1)
    expect(out.slice(0, 3)).toEqual([0, 1, 0])
    expect(out.slice(-3)).toEqual([0, 4, 10])
    // 10 pieces a segment, the shared ends once.
    expect(out.length / 3).toBe(31)
    expect(out.slice(30, 33)).toEqual([10, 2, 0])
  })

  it('wraps a closed spline without repeating its first point', () => {
    const square = [0, 0, 0, 8, 0, 0, 8, 0, 8, 0, 0, 8]
    const out = sampleCatmullRom(square, true, 2)
    expect(out.length / 3).toBe(16)
    expect(out.slice(0, 3)).toEqual([0, 0, 0])
    expect(out.slice(-3)).not.toEqual([0, 0, 0])
    // Symmetric: the midpoint of the first edge bulges outward (z < 0) as much as the third's (z > 8).
    expect(out[3 * 2 + 2]!).toBeCloseTo(8 - out[3 * 10 + 2]!, 12)
    expect(out[3 * 2 + 2]!).toBeLessThan(0)
  })

  it('is the uniform Catmull-Rom basis', () => {
    expect(catmullRom(0, 1, 2, 3, 0.5)).toBe(1.5)
    expect(catmullRom(5, 1, 7, 2, 0)).toBe(1)
    expect(catmullRom(5, 1, 7, 2, 1)).toBe(7)
  })
})
