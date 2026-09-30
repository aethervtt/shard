import { describe, expect, it } from 'vitest'
import {
  cellAt,
  cellCenter,
  cellPolygon,
  distance,
  type GridGeometry,
  hexDistance,
  neighbors,
  pathDistance,
  pointToAxial,
  roundAxial,
} from './math'

// Aether's grid fixtures (packages/core/test/grid.test.ts), in its pixel units.

const grid = (overrides: Partial<GridGeometry> = {}): GridGeometry => ({
  kind: 'square',
  orientation: 'pointy',
  size: 70,
  offset: [11, 17],
  ...overrides,
})

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('cells', () => {
  it('snaps square points to cell centres respecting the origin', () => {
    const g = grid()
    expect(cellCenter(g, cellAt(g, 90, 100))).toEqual([116, 122])
  })

  for (const orientation of ['pointy', 'flat'] as const) {
    it(`round-trips ${orientation} hex axial coordinates and snaps`, () => {
      const g = grid({ kind: 'hex', orientation, size: 60, offset: [13, 19] })
      const cell: [number, number] = [-3, 5]
      const point = cellCenter(g, cell)
      const [q, r] = pointToAxial(g, point[0], point[1])
      expect(q).toBeCloseTo(cell[0], 8)
      expect(r).toBeCloseTo(cell[1], 8)
      expect(roundAxial(q + 0.1, r - 0.08)).toEqual(cell)
      const snapped = cellCenter(g, cellAt(g, point[0] + 2, point[1] - 3))
      expect(snapped[0]).toBeCloseTo(point[0], 8)
      expect(snapped[1]).toBeCloseTo(point[1], 8)
    })
  }

  for (const g of [
    grid({ offset: [0.37, -2.1], size: 1.5 }),
    grid({ kind: 'hex', orientation: 'pointy', offset: [4, 1], size: 1.5 }),
    grid({ kind: 'hex', orientation: 'flat', offset: [-3, 7], size: 2.25 }),
  ]) {
    it(`cellAt ∘ cellCenter is the identity over 10k random cells (${g.kind} ${g.kind === 'hex' ? g.orientation : ''})`, () => {
      const random = rng(99)
      for (let i = 0; i < 10_000; i++) {
        const cell: [number, number] = [
          Math.floor((random() - 0.5) * 2000),
          Math.floor((random() - 0.5) * 2000),
        ]
        const [x, z] = cellCenter(g, cell)
        expect(cellAt(g, x, z)).toEqual(cell)
      }
    })
  }

  it('outlines and neighbours', () => {
    const square = grid({ offset: [0, 0], size: 2 })
    expect(cellPolygon(square, [0, 0])).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ])
    expect(neighbors(square, [0, 0])).toHaveLength(8)
    const hex = grid({ kind: 'hex', offset: [0, 0], size: 1 })
    const corners = cellPolygon(hex, [0, 0])
    expect(corners).toHaveLength(6)
    // Pointy-top hexes: corners at ±30°, 90°..., circumradius size / √3.
    for (const [x, z] of corners) expect(Math.hypot(x, z)).toBeCloseTo(1 / Math.sqrt(3), 9)
    for (const n of neighbors(hex, [2, -1])) expect(hexDistance(n, [2, -1])).toBe(1)
  })
})

describe('distance', () => {
  it('counts hex steps whatever the orientation', () => {
    expect(hexDistance([0, 0], [3, -1])).toBe(3)
    expect(hexDistance([-2, 4], [1, 0])).toBe(4)
  })

  it("matches Aether's three diagonal rules, with the alternating phase across waypoints", () => {
    const points: [number, number][] = [
      [0, 0],
      [70, 70],
      [140, 140],
      [210, 210],
    ]
    const g = grid({ offset: [0, 0] })
    expect(pathDistance(g, points, 'euclidean').total).toBeCloseTo(3 * Math.SQRT2, 9)
    expect(pathDistance(g, points, 'equal').total).toBe(3)
    expect(pathDistance(g, points, 'alternating')).toEqual({ legs: [1, 2, 1], total: 4 })
    // One leg: 5 diagonals (1+2+1+2+1 = 7) and 2 straight cells.
    expect(distance(g, [0, 0], [490, 350], 'alternating')).toBe(9)
    expect(distance(g, [0, 0], [490, 350], 'equal')).toBe(7)
  })
})
