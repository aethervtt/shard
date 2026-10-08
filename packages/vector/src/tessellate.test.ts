import { budget } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { meshArea, parseGeometry, tessellate } from './tessellate'

const fillOnly = { strokeWidth: 0, strokeUnits: 'world' as const, fill: true }
const median = (t: number[]) => [...t].sort((a, b) => a - b)[t.length >> 1]!

describe('tessellate', () => {
  it('fills a polygon with two holes to its exact area', () => {
    const mesh = tessellate(
      {
        kind: 'polygon',
        outer: [
          [0, 0],
          [20, 0],
          [20, 10],
          [0, 10],
        ],
        holes: [
          [
            [2, 2],
            [2, 8],
            [8, 8],
            [8, 2],
          ],
          [
            [12, 3],
            [16, 3],
            [14, 7],
          ],
        ],
      },
      fillOnly,
    )
    const expected = 200 - 36 - 8
    expect(Math.abs(meshArea(mesh) - expected) / expected).toBeLessThan(0.001)
    // Every triangle faces up: (b − a) × (c − a) along +y.
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [mesh.indices[i]! * 3, mesh.indices[i + 1]! * 3, mesh.indices[i + 2]! * 3]
      const p = mesh.positions
      const y =
        (p[b + 2]! - p[a + 2]!) * (p[c]! - p[a]!) - (p[b]! - p[a]!) * (p[c + 2]! - p[a + 2]!)
      expect(y).toBeGreaterThanOrEqual(0)
    }
  })

  it('tessellates a 1,000-point pen stroke in under 1 ms', () => {
    const points: [number, number][] = []
    for (let i = 0; i < 1000; i++) points.push([i * 0.05, Math.sin(i * 0.1) * 2])
    const geometry = { kind: 'pen' as const, points }
    const style = { strokeWidth: 3, strokeUnits: 'css-px' as const, fill: false }
    for (let i = 0; i < 50; i++) tessellate(geometry, style)
    const times: number[] = []
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now()
      tessellate(geometry, style)
      times.push(performance.now() - t0)
    }
    const mesh = tessellate(geometry, style)
    expect(mesh.indices.length).toBeGreaterThan(999 * 6)
    // CSS-pixel strokes keep the centreline and carry the widening: half width in tangent w.
    expect(mesh.tangents[3]).toBe(1.5)
    expect(median(times)).toBeLessThan(budget('vector/tessellate', { count: 1000 }))
  })

  it('strokes a rect in world units with mitred corners: perimeter × width', () => {
    const mesh = tessellate(
      { kind: 'rect', width: 4, height: 2 },
      { strokeWidth: 0.2, strokeUnits: 'world', fill: false },
    )
    // Outer 4.2 × 2.2 minus inner 3.8 × 1.8.
    expect(meshArea(mesh)).toBeCloseTo(4.2 * 2.2 - 3.8 * 1.8, 5)
  })

  it('subdivides ellipses to half a CSS pixel at the densest zoom', () => {
    const rx = 5
    const ry = 3
    for (const pixelsPerUnit of [64, 256]) {
      const mesh = tessellate({ kind: 'ellipse', rx, ry }, fillOnly, { pixelsPerUnit })
      const area = meshArea(mesh)
      // A polygon inscribed with chord error e loses at most perimeter × e of area.
      const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)))
      expect(Math.PI * rx * ry - area).toBeLessThanOrEqual((perimeter * 0.5) / pixelsPerUnit)
      expect(area).toBeLessThan(Math.PI * rx * ry)
    }
  })

  it('draws cones as sectors and round-caps pens', () => {
    const cone = tessellate({ kind: 'cone', length: 6, angle: 90 }, fillOnly)
    expect(meshArea(cone)).toBeCloseTo((Math.PI * 36) / 4, 1)
    // A single-point pen is a dot of the stroke's width.
    const dot = tessellate(
      { kind: 'pen', points: [[1, 1]] },
      { strokeWidth: 2, strokeUnits: 'world', fill: false },
    )
    expect(meshArea(dot)).toBeCloseTo(Math.PI, 1)
  })

  it('reports bad geometry with a path', () => {
    expect(() =>
      parseGeometry({
        kind: 'polygon',
        outer: [
          [0, 0],
          [1, 0],
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'vector/invalid-geometry', path: '/geometry/outer' }))
    expect(() => parseGeometry({ kind: 'line', from: [0, 0], to: [1, 'x'] })).toThrow(
      expect.objectContaining({ path: '/geometry/to' }),
    )
    expect(() => parseGeometry({ kind: 'blob' })).toThrow(
      expect.objectContaining({ path: '/geometry/kind' }),
    )
  })
})
