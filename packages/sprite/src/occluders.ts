import { ShardError } from '@aethervtt/shard-core'
import type { TileLayer } from './tilemap'

/**
 * Occluder geometry. Every shape reduces to segments (ax, ay, bx, by), first in the occluder's
 * local space, then in world space for the shadow pass. Pure functions: tested headless.
 */

/** Segments of a closed polygon (x, y pairs), appended to `out`. */
export function polygonSegments(points: ArrayLike<number>, out: number[]): void {
  const n = points.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    out.push(points[j * 2]!, points[j * 2 + 1]!, points[i * 2]!, points[i * 2 + 1]!)
  }
}

/** A w × h box centered on the origin, as a polygon. */
export function boxPolygon(w: number, h: number, cx = 0, cy = 0): number[] {
  const x = w / 2
  const y = h / 2
  return [cx - x, cy - y, cx + x, cy - y, cx + x, cy + y, cx - x, cy + y]
}

/** Sides of a circle's polygon: its chord error is under 1% of the radius. */
export const CIRCLE_SIDES = 24

export function circlePolygon(r: number, sides = CIRCLE_SIDES): number[] {
  const out: number[] = []
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2
    out.push(Math.cos(a) * r, Math.sin(a) * r)
  }
  return out
}

/** A capsule along Y: two half circles `halfHeight` from the center, joined by straight sides. */
export function capsulePolygon(r: number, halfHeight: number, sides = CIRCLE_SIDES): number[] {
  const out: number[] = []
  const half = sides / 2
  for (let k = 0; k <= half; k++) {
    const a = (k / half) * Math.PI
    out.push(Math.cos(a) * r, halfHeight + Math.sin(a) * r)
  }
  for (let k = 0; k <= half; k++) {
    const a = Math.PI + (k / half) * Math.PI
    out.push(Math.cos(a) * r, -halfHeight + Math.sin(a) * r)
  }
  return out
}

/** The convex hull of points (x, y pairs), counter-clockwise (monotone chain). */
export function convexHull(points: ArrayLike<number>): number[] {
  const idx = Array.from({ length: points.length / 2 }, (_, i) => i).sort(
    (a, b) => points[a * 2]! - points[b * 2]! || points[a * 2 + 1]! - points[b * 2 + 1]!,
  )
  const cross = (o: number, a: number, b: number) =>
    (points[a * 2]! - points[o * 2]!) * (points[b * 2 + 1]! - points[o * 2 + 1]!) -
    (points[a * 2 + 1]! - points[o * 2 + 1]!) * (points[b * 2]! - points[o * 2]!)
  const lower: number[] = []
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, i) <= 0) lower.pop()
    lower.push(i)
  }
  const upper: number[] = []
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k]!
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, i) <= 0) upper.pop()
    upper.push(i)
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1))
  const out: number[] = []
  for (const i of hull) out.push(points[i * 2]!, points[i * 2 + 1]!)
  return out
}

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/**
 * Why a polygon can't occlude, or undefined when it can: fewer than 3 points, no area, or two
 * edges that cross.
 */
export function polygonProblem(points: ArrayLike<number>): string | undefined {
  const n = points.length / 2
  if (n < 3) return `a polygon needs at least 3 points, not ${n}`
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n
      if (j2 === i) continue
      if (
        segmentsCross(
          points[i * 2]!,
          points[i * 2 + 1]!,
          points[i2 * 2]!,
          points[i2 * 2 + 1]!,
          points[j * 2]!,
          points[j * 2 + 1]!,
          points[j2 * 2]!,
          points[j2 * 2 + 1]!,
        )
      ) {
        return `edges ${i} and ${j} cross (self-intersecting)`
      }
    }
  }
  let area = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += points[j * 2]! * points[i * 2 + 1]! - points[i * 2]! * points[j * 2 + 1]!
  }
  if (Math.abs(area) < 1e-9) return 'the polygon has no area'
  return undefined
}

export function invalidOccluder(message: string, path?: string): ShardError {
  return new ShardError('sprite/invalid-occluder', `Invalid LightOccluder2d: ${message}`, {
    hint: 'Give polygons 3+ points without crossing edges, boxes a nonzero size, and collider occluders a cuboid, ball, capsule, or convex Collider.',
    path,
  })
}

/** The fields of LightOccluder2d a shape needs. */
export interface OccluderShapeValue {
  shape: 'box' | 'circle' | 'polygon' | 'sprite' | 'collider'
  size: ArrayLike<number>
  points: ArrayLike<number>[]
}

/** The fields of physics/Collider an occluder reads (2D reads x and y). */
export interface ColliderValue {
  shape: string
  radius: number
  halfExtents: ArrayLike<number>
  halfHeight: number
  points: ArrayLike<number>[]
}

/**
 * Local-space segments of an occluder. `sprite` takes the outline polygon the caller resolved
 * from the sprite; `collider` the entity's Collider. Throws `sprite/invalid-occluder`.
 */
export function occluderSegments(
  value: OccluderShapeValue,
  extra: { outline?: ArrayLike<number>; collider?: ColliderValue } = {},
): number[] {
  const out: number[] = []
  switch (value.shape) {
    case 'box': {
      const w = value.size[0]!
      const h = value.size[1]!
      if (!(w > 0 && h > 0)) throw invalidOccluder(`a box of size ${w} × ${h}`, '/size')
      polygonSegments(boxPolygon(w, h), out)
      break
    }
    case 'circle': {
      const r = value.size[0]!
      if (!(r > 0)) throw invalidOccluder(`a circle of radius ${r}`, '/size')
      polygonSegments(circlePolygon(r), out)
      break
    }
    case 'polygon': {
      const flat: number[] = []
      for (const p of value.points) flat.push(p[0]!, p[1]!)
      const problem = polygonProblem(flat)
      if (problem) throw invalidOccluder(problem, '/points')
      polygonSegments(flat, out)
      break
    }
    case 'sprite': {
      const o = extra.outline
      if (!o || o.length < 6) throw invalidOccluder('the sprite has no outline or size')
      polygonSegments(o, out)
      break
    }
    case 'collider': {
      const c = extra.collider
      if (!c) throw invalidOccluder("shape 'collider' needs a physics/Collider on the entity")
      if (c.shape === 'cuboid') {
        const w = c.halfExtents[0]! * 2
        const h = c.halfExtents[1]! * 2
        if (!(w > 0 && h > 0)) throw invalidOccluder(`a cuboid collider of size ${w} × ${h}`)
        polygonSegments(boxPolygon(w, h), out)
      } else if (c.shape === 'ball') {
        if (!(c.radius > 0)) throw invalidOccluder(`a ball collider of radius ${c.radius}`)
        polygonSegments(circlePolygon(c.radius), out)
      } else if (c.shape === 'capsule') {
        polygonSegments(capsulePolygon(c.radius, c.halfHeight), out)
      } else if (c.shape === 'convex') {
        const flat: number[] = []
        for (const p of c.points) flat.push(p[0]!, p[1]!)
        const hull = convexHull(flat)
        if (hull.length < 6) throw invalidOccluder('a convex collider with fewer than 3 points')
        polygonSegments(hull, out)
      } else {
        throw invalidOccluder(
          `a ${c.shape} collider (occluders support cuboid, ball, capsule, and convex)`,
        )
      }
      break
    }
  }
  return out
}

/**
 * A sprite's outline in its local space: an atlas outline (normalized region coordinates, y down)
 * placed by the sprite's size, anchor, and flips; without one, the sprite's rectangle.
 */
export function spriteOutline(
  outline: ArrayLike<number> | undefined,
  w: number,
  h: number,
  ax: number,
  ay: number,
  flipX: boolean,
  flipY: boolean,
): number[] {
  const src = outline && outline.length >= 6 ? outline : [0, 0, 1, 0, 1, 1, 0, 1]
  const out: number[] = []
  for (let k = 0; k < src.length; k += 2) {
    const u = flipX ? 1 - src[k]! : src[k]!
    const v = flipY ? 1 - src[k + 1]! : src[k + 1]!
    out.push((u - ax) * w, (ay - v) * h)
  }
  return out
}

/**
 * Boundary edges of one chunk of an occluding tile layer, in tile units (tile (x, y) covers
 * [x, x + 1] × [−y − 1, −y]), appended to `out`. A side is an edge when exactly one of its two
 * cells is filled, counting cells outside the chunk as empty: edits only rebuild their chunk, and
 * the extra edges on chunk borders sit inside walls where no light reaches them first. Collinear
 * runs merge into one segment.
 */
export function tileChunkEdges(
  layer: Pick<TileLayer, 'tiles' | 'width' | 'height'>,
  chunkSize: number,
  chunk: number,
  out: number[],
): void {
  const chunksX = Math.ceil(layer.width / chunkSize)
  const x0 = (chunk % chunksX) * chunkSize
  const y0 = Math.floor(chunk / chunksX) * chunkSize
  const x1 = Math.min(layer.width, x0 + chunkSize)
  const y1 = Math.min(layer.height, y0 + chunkSize)
  const filled = (x: number, y: number) =>
    x >= x0 && x < x1 && y >= y0 && y < y1 && layer.tiles[y * layer.width + x]! !== 0
  // Horizontal lines: between rows y − 1 and y, at tile-space height −y.
  for (let y = y0; y <= y1; y++) {
    let start = -1
    for (let x = x0; x <= x1; x++) {
      const edge = x < x1 && filled(x, y) !== filled(x, y - 1)
      if (edge && start < 0) start = x
      else if (!edge && start >= 0) {
        out.push(start, -y, x, -y)
        start = -1
      }
    }
  }
  // Vertical lines: between columns x − 1 and x.
  for (let x = x0; x <= x1; x++) {
    let start = -1
    for (let y = y0; y <= y1; y++) {
      const edge = y < y1 && filled(x, y) !== filled(x - 1, y)
      if (edge && start < 0) start = y
      else if (!edge && start >= 0) {
        out.push(x, -start, x, -y)
        start = -1
      }
    }
  }
}

/**
 * Transforms local segments by an affine (3 × 4 rows, the entity's GlobalTransform) into world
 * XY, writing `count` segments from `src` to `dst` at `offset` (in segments). Returns the world
 * bounds in `bounds` (minX, minY, maxX, maxY).
 */
export function transformSegments(
  src: ArrayLike<number>,
  g: ArrayLike<number>,
  go: number,
  sx: number,
  sy: number,
  dst: Float32Array,
  offset: number,
  bounds: Float32Array,
): void {
  const n = src.length / 4
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const m0 = g[go]!
  const m1 = g[go + 1]!
  const m3 = g[go + 3]!
  const m4 = g[go + 4]!
  const m5 = g[go + 5]!
  const m7 = g[go + 7]!
  for (let s = 0; s < n; s++) {
    for (let e = 0; e < 2; e++) {
      const lx = src[s * 4 + e * 2]! * sx
      const ly = src[s * 4 + e * 2 + 1]! * sy
      const x = m0 * lx + m1 * ly + m3
      const y = m4 * lx + m5 * ly + m7
      dst[(offset + s) * 4 + e * 2] = x
      dst[(offset + s) * 4 + e * 2 + 1] = y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  bounds[0] = minX
  bounds[1] = minY
  bounds[2] = maxX
  bounds[3] = maxY
}
