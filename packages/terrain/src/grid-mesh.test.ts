import { describe, expect, it } from 'vitest'
import { chunkIndices, chunkLayout } from './grid-mesh'

/** Grid point of each surface vertex index. */
function points(n: number): [number, number][] {
  const layout = chunkLayout(n)
  const out: [number, number][] = []
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out[layout.index[i + j * n]!] = [i, j]
  return out
}

describe('heightfield index sets (0071)', () => {
  it('cover every drawn quadrant once, wind alike, and split quads as Rapier does', () => {
    for (const n of [9, 17]) {
      const layout = chunkLayout(n)
      const p = points(n)
      const side = n - 1
      const h = side / 2
      for (let mask = 1; mask < 16; mask++) {
        for (let stitch = 0; stitch < 16; stitch++) {
          const idx = chunkIndices(n, mask, stitch, false, 'anti')
          let area = 0
          type P = [number, number]
          const tris: [P, P, P][] = []
          for (let t = 0; t < idx.length; t += 3) {
            const a = p[idx[t]!]!
            const b = p[idx[t + 1]!]!
            const c = p[idx[t + 2]!]!
            const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            // Clockwise in (i, j): counter-clockwise seen from +Y with i along +X, j along +Z.
            expect(cross).toBeLessThan(0)
            area -= cross / 2
            tris.push([a, b, c])
          }
          let quadrants = 0
          for (let q = 0; q < 4; q++) if (mask & (1 << q)) quadrants++
          expect(area).toBe(quadrants * h * h)
          // Points inside drawn quadrants are in exactly one triangle (no overlap, no gap).
          for (let y = 0.3719; y < side; y += 0.9137) {
            for (let x = 0.2903; x < side; x += 0.8311) {
              const q = (x >= h ? 1 : 0) + (y >= h ? 2 : 0)
              let hits = 0
              for (const [a, b, c] of tris) {
                const d1 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
                const d2 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0])
                const d3 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0])
                if (d1 < 0 && d2 < 0 && d3 < 0) hits++
              }
              expect(
                hits,
                `n ${n} mask ${mask} stitch ${stitch} at ${x.toFixed(2)},${y.toFixed(2)}`,
              ).toBe(mask & (1 << q) ? 1 : 0)
            }
          }
          // A stitched edge uses only its even vertices.
          for (let t = 0; t < idx.length; t++) {
            const [i, j] = p[idx[t]!]!
            if (stitch & 1 && j === 0) expect(i % 2).toBe(0)
            if (stitch & 2 && i === side) expect(j % 2).toBe(0)
            if (stitch & 4 && j === side) expect(i % 2).toBe(0)
            if (stitch & 8 && i === 0) expect(j % 2).toBe(0)
          }
          if (stitch === 0) {
            // Every triangle is half a cell, cut along (i+1, j)–(i, j+1).
            for (const [a, b, c] of tris) {
              const xs = [a[0], b[0], c[0]]
              const ys = [a[1], b[1], c[1]]
              const i = Math.min(...xs)
              const j = Math.min(...ys)
              expect(Math.max(...xs) - i).toBe(1)
              expect(Math.max(...ys) - j).toBe(1)
              const has = (x: number, y: number) => [a, b, c].some((v) => v[0] === x && v[1] === y)
              expect(has(i + 1, j) && has(i, j + 1)).toBe(true)
            }
          }
        }
      }
      expect(layout.vertexCount).toBe(n * n + 4 * side)
    }
  })

  it('keeps planets’ index sets as they were', () => {
    expect(chunkIndices(33, 15, 0, true)).toEqual(chunkLayout(33).indices)
    expect(chunkIndices(33, 15, 0, true, 'anti')).not.toEqual(chunkLayout(33).indices)
  })
})
