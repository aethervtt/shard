import type { ShardError } from '@shard/core'
import { describe, expect, it } from 'vitest'
import {
  circlePolygon,
  convexHull,
  occluderSegments,
  polygonProblem,
  spriteOutline,
  tileChunkEdges,
  transformSegments,
} from './occluders'
import { alphaOutline, distanceToLoop } from './outline'
import { TileLayer } from './tilemap'

const value = (shape: 'box' | 'circle' | 'polygon' | 'sprite' | 'collider', extra = {}) => ({
  shape,
  size: [2, 1],
  points: [] as number[][],
  ...extra,
})

function invalid(fn: () => unknown): ShardError {
  try {
    fn()
  } catch (err) {
    return err as ShardError
  }
  throw new Error('expected a throw')
}

describe('occluder segments', () => {
  it('reduces boxes, circles, polygons, outlines, and colliders to closed loops of segments', () => {
    const box = occluderSegments(value('box'))
    expect(box.length / 4).toBe(4)
    // Closed: each segment starts where the previous ends.
    for (let s = 0; s < 4; s++) {
      const prev = (s + 3) % 4
      expect([box[s * 4], box[s * 4 + 1]]).toEqual([box[prev * 4 + 2], box[prev * 4 + 3]])
    }
    expect(Math.max(...box.filter((_, i) => i % 2 === 0))).toBe(1)
    expect(Math.max(...box.filter((_, i) => i % 2 === 1))).toBe(0.5)
    const circle = occluderSegments(value('circle', { size: [3, 0] }))
    for (let k = 0; k < circle.length; k += 2) {
      expect(Math.hypot(circle[k]!, circle[k + 1]!)).toBeCloseTo(3, 5)
    }
    // A concave L.
    const l = occluderSegments(
      value('polygon', {
        points: [
          [0, 0],
          [2, 0],
          [2, 1],
          [1, 1],
          [1, 2],
          [0, 2],
        ],
      }),
    )
    expect(l.length / 4).toBe(6)
    const sprite = occluderSegments(value('sprite'), {
      outline: spriteOutline(undefined, 2, 4, 0.5, 1, false, false),
    })
    // A 2 × 4 rectangle anchored at its bottom center.
    expect(Math.min(...sprite.filter((_, i) => i % 2 === 1))).toBe(0)
    expect(Math.max(...sprite.filter((_, i) => i % 2 === 1))).toBe(4)
    const collider = (shape: string, extra = {}) =>
      occluderSegments(value('collider'), {
        collider: {
          shape,
          radius: 0.5,
          halfExtents: [1, 2, 0],
          halfHeight: 1,
          points: [],
          ...extra,
        },
      })
    expect(collider('cuboid').length / 4).toBe(4)
    expect(Math.max(...collider('cuboid').filter((_, i) => i % 2 === 1))).toBe(2)
    expect(collider('ball').length / 4).toBe(24)
    const capsule = collider('capsule')
    expect(Math.max(...capsule.filter((_, i) => i % 2 === 1))).toBeCloseTo(1.5, 5)
    // Convex colliders take the hull of their points (the interior point drops out).
    const convex = collider('convex', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [0.3, 0.2, 0],
        [0, 1, 0],
      ],
    })
    expect(convex.length / 4).toBe(3)
  })

  it('rejects bad shapes with sprite/invalid-occluder', () => {
    expect(invalid(() => occluderSegments(value('box', { size: [0, 1] }))).code).toBe(
      'sprite/invalid-occluder',
    )
    const few = invalid(() =>
      occluderSegments(
        value('polygon', {
          points: [
            [0, 0],
            [1, 0],
          ],
        }),
      ),
    )
    expect(few.code).toBe('sprite/invalid-occluder')
    expect(few.path).toBe('/points')
    // A bowtie crosses itself.
    const bowtie = invalid(() =>
      occluderSegments(
        value('polygon', {
          points: [
            [0, 0],
            [1, 1],
            [1, 0],
            [0, 1],
          ],
        }),
      ),
    )
    expect(bowtie.message).toMatch(/self-intersecting/)
    expect(invalid(() => occluderSegments(value('collider'))).code).toBe('sprite/invalid-occluder')
    const trimesh = invalid(() =>
      occluderSegments(value('collider'), {
        collider: {
          shape: 'trimesh',
          radius: 0,
          halfExtents: [0, 0, 0],
          halfHeight: 0,
          points: [],
        },
      }),
    )
    expect(trimesh.message).toMatch(/trimesh/)
    expect(polygonProblem(circlePolygon(1))).toBeUndefined()
    expect(convexHull([0, 0, 2, 0, 1, 1, 1, 0.2, 2, 2, 0, 2]).length / 2).toBe(4)
  })

  it('places sprite outlines by size, anchor, and flips', () => {
    // A right triangle filling the left half of its region.
    const tri = [0, 0, 0.5, 1, 0, 1]
    const plain = spriteOutline(tri, 2, 2, 0.5, 0.5, false, false)
    expect(plain).toEqual([-1, 1, 0, -1, -1, -1])
    const flipped = spriteOutline(tri, 2, 2, 0.5, 0.5, true, false)
    expect(flipped).toEqual([1, 1, 0, -1, 1, -1])
  })

  it('transforms segments to world space with bounds', () => {
    // Rotated 90° about Z, moved to (5, 0), scaled 2 on local x by the caller.
    const g = [0, -1, 0, 5, 1, 0, 0, 0, 0, 0, 1, 0]
    const out = new Float32Array(4)
    const bounds = new Float32Array(4)
    transformSegments([0, 0, 1, 0], g, 0, 2, 1, out, 0, bounds)
    expect([...out]).toEqual([5, 0, 5, 2])
    expect([...bounds]).toEqual([5, 0, 5, 2])
  })
})

/** A 256×256 map of 32-cell rooms: 4-thick walls with 4-wide doorways, and a few pillars. */
function wallMap(): TileLayer {
  const layer = new TileLayer('walls', 256, 256)
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const wallY = y % 32 < 4 && !(x % 32 >= 14 && x % 32 < 18)
      const wallX = x % 32 < 4 && !(y % 32 >= 14 && y % 32 < 18)
      const pillar = x % 32 >= 22 && x % 32 < 26 && y % 32 >= 22 && y % 32 < 26
      if (wallY || wallX || pillar) layer.tiles[y * 256 + x] = 1
    }
  }
  return layer
}

describe('tile edges', () => {
  it('merges a wall layer into under 5% of the per-cell edges', () => {
    const layer = wallMap()
    let filled = 0
    for (let i = 0; i < layer.tiles.length; i++) if (layer.tiles[i]) filled++
    const edges: number[] = []
    const chunks = (256 / 32) ** 2
    for (let c = 0; c < chunks; c++) tileChunkEdges(layer, 32, c, edges)
    const naive = filled * 4
    const merged = edges.length / 4
    expect(merged / naive).toBeLessThan(0.05)
    // Every edge is axis-aligned and separates a filled cell from an empty (or out-of-chunk) one.
    for (let s = 0; s < edges.length; s += 4) {
      expect(edges[s] === edges[s + 2] || edges[s + 1] === edges[s + 3]).toBe(true)
    }
  })

  it('finds the outline of a solid block with a doorway', () => {
    const layer = new TileLayer('walls', 32, 32)
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) if (!(x >= 14 && x < 18 && y < 20)) layer.tiles[y * 32 + x] = 1
    const edges: number[] = []
    tileChunkEdges(layer, 32, 0, edges)
    // Outer square (the doorway breaks the top into two) plus the doorway's three sides.
    expect(edges.length / 4).toBe(4 + 1 + 3)
  })
})

/** 20 test shapes as signed tests at pixel centers, in 48×48 regions. */
const SHAPES: ((x: number, y: number) => boolean)[] = [
  (x, y) => Math.hypot(x - 24, y - 24) < 20,
  (x, y) => Math.hypot(x - 24, y - 24) < 8,
  (x, y) => ((x - 24) / 22) ** 2 + ((y - 24) / 10) ** 2 < 1,
  (x, y) => ((x - 24) / 8) ** 2 + ((y - 24) / 21) ** 2 < 1,
  (x, y) => x > 6 && x < 42 && y > 10 && y < 38,
  (x, y) => Math.abs(x - 24) + Math.abs(y - 24) < 20,
  (x, y) => y > 6 && y < 42 && Math.abs(x - 24) < (y - 6) * 0.55,
  (x, y) => (x > 6 && x < 20 && y > 6 && y < 42) || (x > 6 && x < 42 && y > 28 && y < 42),
  (x, y) => (Math.abs(x - 24) < 6 && y > 4 && y < 44) || (Math.abs(y - 24) < 6 && x > 4 && x < 44),
  (x, y) => Math.hypot(x - 24, y - 24) < 20 && Math.hypot(x - 32, y - 20) > 14,
  (x, y) => {
    const a = Math.atan2(y - 24, x - 24)
    return Math.hypot(x - 24, y - 24) < 14 + 5 * Math.cos(a * 4)
  },
  (x, y) => Math.hypot(x - 16, y - 24) < 10 || Math.hypot(x - 32, y - 24) < 10,
  (x, y) => Math.abs(x - 24) < 7 && y > 4 && y < 44,
  (x, y) => Math.hypot(x - 24, Math.max(0, Math.abs(y - 24) - 10)) < 8,
  (x, y) => {
    const u = (x - 24) * Math.cos(0.4) + (y - 24) * Math.sin(0.4)
    const v = -(x - 24) * Math.sin(0.4) + (y - 24) * Math.cos(0.4)
    return Math.abs(u) < 16 && Math.abs(v) < 9
  },
  (x, y) => y > 8 && y < 40 && x > 6 && x < 42 && !(x > 18 && x < 30 && y > 8 && y < 26),
  (x, y) => x + y > 20 && x < 42 && y < 42,
  (x, y) => Math.abs(x - 24) ** 1.5 + Math.abs(y - 24) ** 1.5 < 90,
  (x, y) => Math.hypot(x - 24, y - 30) < 12 || (Math.abs(x - 24) < 3 && y > 6 && y < 30),
  (x, y) => {
    const a = Math.atan2(y - 24, x - 24)
    return Math.hypot(x - 24, y - 24) < 16 + 4 * Math.sin(a * 3)
  },
]

describe('alpha outlines', () => {
  it('trace 20 shapes within 1 texel of the alpha edge in at most 32 points', () => {
    for (const [i, inside] of SHAPES.entries()) {
      const alpha = (x: number, y: number) => (inside(x + 0.5, y + 0.5) ? 1 : 0)
      const loop = alphaOutline(48, 48, alpha)
      expect(loop.length / 2, `shape ${i}`).toBeGreaterThanOrEqual(3)
      expect(loop.length / 2, `shape ${i}`).toBeLessThanOrEqual(32)
      // The alpha edge: midpoints between each opaque pixel and a clear 4-neighbor.
      const edge: number[] = []
      for (let y = -1; y <= 48; y++) {
        for (let x = -1; x <= 48; x++) {
          const a = x >= 0 && y >= 0 && x < 48 && y < 48 && alpha(x, y) >= 0.5
          const r = x + 1 < 48 && y >= 0 && y < 48 && x + 1 >= 0 && alpha(x + 1, y) >= 0.5
          const d = y + 1 < 48 && x >= 0 && x < 48 && y + 1 >= 0 && alpha(x, y + 1) >= 0.5
          if (a !== r) edge.push(x + 1, y + 0.5)
          if (a !== d) edge.push(x + 0.5, y + 1)
        }
      }
      // Every edge point near the outline, and every outline point near the edge.
      let worst = 0
      for (let k = 0; k < edge.length; k += 2) {
        worst = Math.max(worst, distanceToLoop(edge[k]!, edge[k + 1]!, loop))
      }
      for (let k = 0; k < loop.length; k += 2) {
        let best = Number.POSITIVE_INFINITY
        for (let e = 0; e < edge.length; e += 2) {
          best = Math.min(best, Math.hypot(loop[k]! - edge[e]!, loop[k + 1]! - edge[e + 1]!))
        }
        worst = Math.max(worst, best)
      }
      // Shapes with holes or a second blob keep only their largest loop; none here have one.
      expect(worst, `shape ${i}`).toBeLessThanOrEqual(1)
    }
  })
})
