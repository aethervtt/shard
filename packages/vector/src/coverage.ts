import { polygon, ShardError } from '@aethervtt/shard-core'

// Feathered coverage (0058): a region's shape as triangles in the XZ plane with a coverage value
// per vertex, 1 inside and ramping linearly to 0 across a feather ring outside the edge (around
// holes too). Fog draws regions from these; the softness is geometry, not a blur. The triangles
// of a region can overlap where a brush turns or a polygon has a sharp reflex corner, so fog draws
// each region with a stencil that lets each texel take only the region's first triangle there:
// core triangles come first, so an overlap inside the shape stays at full coverage.

export type Ring = [number, number][]

export type CoverageShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'polygon'; outer: Ring; holes?: Ring[] }
  | { kind: 'multipolygon'; polygons: { outer: Ring; holes?: Ring[] }[] }
  | { kind: 'brush'; points: Ring; radius: number }

export interface CoverageMesh {
  /** x, z per vertex. */
  positions: Float32Array
  /** 1 inside the shape, down to 0 at the feather's outer edge. */
  coverage: Float32Array
  indices: Uint32Array
  /** How many of `indices` belong to the core (coverage 1); ring triangles follow them. */
  coreIndices: number
}

export interface CoverageOptions {
  /** Width of the soft edge outside the shape, in world units. 0: a hard edge. */
  feather: number
  /** Chord error allowed on arcs (round caps, corners), in world units. Default 0.01. */
  error?: number
  /**
   * Drops input points the outline doesn't need: the simplified outline stays within this distance
   * of the given one (Douglas–Peucker). A mask of texel t loses nothing at 8 bits with t / 255.
   * Default 0: every point kept.
   */
  tolerance?: number
}

/** How far a reflex corner's miter may reach, in feathers, before it's clamped. */
const MITER_LIMIT = 4

class Builder {
  positions: number[] = []
  coverage: number[] = []
  core: number[] = []
  ring: number[] = []

  vertex(x: number, z: number, c: number): number {
    this.positions.push(x, z)
    this.coverage.push(c)
    return this.coverage.length - 1
  }

  finish(): CoverageMesh {
    const indices = new Uint32Array(this.core.length + this.ring.length)
    indices.set(this.core)
    indices.set(this.ring, this.core.length)
    return {
      positions: new Float32Array(this.positions),
      coverage: new Float32Array(this.coverage),
      indices,
      coreIndices: this.core.length,
    }
  }
}

function invalid(message: string, path: string): ShardError {
  return new ShardError('vector/invalid-geometry', message, {
    path,
    hint: "A region shape is { kind: 'rect' | 'polygon' | 'multipolygon' | 'brush', ... } in world (x, z).",
  })
}

function finite(value: unknown, path: string, min = -Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
    throw invalid(min === 0 ? 'Expected a non-negative number' : 'Expected a number', path)
  return value
}

function ring(value: unknown, path: string, min: number): Ring {
  if (!Array.isArray(value) || value.length < min)
    throw invalid(`Expected at least ${min} points`, path)
  for (let i = 0; i < value.length; i++) {
    const p = value[i]
    if (!Array.isArray(p) || p.length !== 2)
      throw invalid('Expected a point [x, z]', `${path}/${i}`)
    finite(p[0], `${path}/${i}/0`)
    finite(p[1], `${path}/${i}/1`)
  }
  return value as Ring
}

function polygonOf(value: unknown, path: string): { outer: Ring; holes: Ring[] } {
  if (!value || typeof value !== 'object') throw invalid('Expected { outer, holes }', path)
  const p = value as Record<string, unknown>
  const holes = p.holes === undefined ? [] : p.holes
  if (!Array.isArray(holes)) throw invalid('Expected a list of holes', `${path}/holes`)
  return {
    outer: ring(p.outer, `${path}/outer`, 3),
    holes: holes.map((h, i) => ring(h, `${path}/holes/${i}`, 3)),
  }
}

/** Checks a region shape (from a host or a file) and returns it typed. */
export function parseCoverageShape(value: unknown, path = '/shape'): CoverageShape {
  if (!value || typeof value !== 'object') throw invalid('Expected a shape object', path)
  const s = value as Record<string, unknown>
  switch (s.kind) {
    case 'rect':
      return {
        kind: 'rect',
        x: finite(s.x, `${path}/x`),
        y: finite(s.y, `${path}/y`),
        w: finite(s.w, `${path}/w`, 0),
        h: finite(s.h, `${path}/h`, 0),
      }
    case 'polygon':
      return { kind: 'polygon', ...polygonOf(s, path) }
    case 'multipolygon': {
      if (!Array.isArray(s.polygons))
        throw invalid('Expected a list of polygons', `${path}/polygons`)
      return {
        kind: 'multipolygon',
        polygons: s.polygons.map((p, i) => polygonOf(p, `${path}/polygons/${i}`)),
      }
    }
    case 'brush':
      return {
        kind: 'brush',
        points: ring(s.points, `${path}/points`, 1),
        radius: finite(s.radius, `${path}/radius`, 0),
      }
    default:
      throw invalid(`Unknown shape kind ${JSON.stringify(s.kind)}`, `${path}/kind`)
  }
}

/** Segments for an arc of `angle` radians at radius `r`, to a chord error of `error`. */
function arcSteps(r: number, angle: number, error: number): number {
  if (angle <= 1e-9) return 0
  if (r <= error) return Math.max(1, Math.ceil(angle / (Math.PI / 2)))
  const step = 2 * Math.acos(Math.max(-1, 1 - error / r))
  return Math.max(1, Math.min(512, Math.ceil(angle / step)))
}

/** Signed area of a ring in (x, z), positive counter-clockwise with z as y. */
function area(r: Ring): number {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1]
  return a / 2
}

/** Drops repeated points (and a closing point equal to the first), then simplifies to `tolerance`. */
function clean(r: Ring, closed: boolean, tolerance: number): Ring {
  const out: Ring = []
  for (const p of r) {
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  if (closed && out.length > 1) {
    const a = out[0]!
    const z = out[out.length - 1]!
    if (a[0] === z[0] && a[1] === z[1]) out.pop()
  }
  return tolerance > 0 ? simplify(out, closed, tolerance) : out
}

/**
 * Douglas–Peucker: keeps the points needed for the outline to stay within `tolerance` of the
 * given one. A closed ring is split at its first point and the point farthest from it.
 * Iterative, so a ring of 100k points doesn't recurse 100k deep.
 */
function simplify(r: Ring, closed: boolean, tolerance: number): Ring {
  const n = r.length
  if (n <= (closed ? 4 : 2)) return r
  const keep = new Uint8Array(n)
  const t2 = tolerance * tolerance
  const spans: number[] = []
  keep[0] = 1
  if (closed) {
    let far = 1
    let best = -1
    for (let i = 1; i < n; i++) {
      const dx = r[i]![0] - r[0]![0]
      const dz = r[i]![1] - r[0]![1]
      const d = dx * dx + dz * dz
      if (d > best) {
        best = d
        far = i
      }
    }
    keep[far] = 1
    spans.push(0, far, far, n)
  } else {
    keep[n - 1] = 1
    spans.push(0, n - 1)
  }
  while (spans.length > 0) {
    const end = spans.pop()!
    const start = spans.pop()!
    if (end - start < 2) continue
    // The chord from start to end (index n wraps to the first point of a closed ring).
    const a = r[start]!
    const b = r[end % n]!
    const cx = b[0] - a[0]
    const cz = b[1] - a[1]
    const len2 = cx * cx + cz * cz
    let worst = -1
    let at = -1
    for (let i = start + 1; i < end; i++) {
      const p = r[i]!
      let dx = p[0] - a[0]
      let dz = p[1] - a[1]
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, (dx * cx + dz * cz) / len2))
        dx -= t * cx
        dz -= t * cz
      }
      const d = dx * dx + dz * dz
      if (d > worst) {
        worst = d
        at = i
      }
    }
    if (worst > t2) {
      keep[at] = 1
      spans.push(start, at, at, end)
    }
  }
  const out: Ring = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[i]!)
  return out
}

/**
 * The core fill of a polygon (coverage 1) and, with a feather, a ring outside every boundary:
 * round at convex corners, mitred at reflex ones.
 */
function polygonCoverage(
  b: Builder,
  outer: Ring,
  holes: Ring[],
  feather: number,
  error: number,
  tolerance: number,
) {
  // Fill on the left of every ring: the outer counter-clockwise, holes clockwise.
  const rings = [outer, ...holes]
    .map((r, i) => {
      const c = clean(r, true, tolerance)
      const ccw = area(c) > 0
      return (i === 0) === ccw ? c : [...c].reverse()
    })
    .filter((r) => r.length >= 3)
  if (rings.length === 0 || rings[0]!.length < 3) return
  let total = 0
  for (const r of rings) total += r.length
  const flat = new Float64Array(total * 2)
  const starts: number[] = []
  let k = 0
  const firstVertex = b.coverage.length
  for (let i = 0; i < rings.length; i++) {
    if (i > 0) starts.push(k)
    for (const [x, z] of rings[i]!) {
      flat[k * 2] = x
      flat[k * 2 + 1] = z
      b.vertex(x, z, 1)
      k++
    }
  }
  const tris = polygon.triangulate(flat, starts)
  for (let i = 0; i < tris.length; i++) b.core.push(firstVertex + tris[i]!)
  if (feather <= 0) return
  let base = firstVertex
  for (const r of rings) {
    featherRing(b, r, base, feather, error)
    base += r.length
  }
}

/**
 * A feather ring outside a closed ring whose fill is on its left. `first` is the index of the
 * ring's first vertex, already emitted with coverage 1.
 */
function featherRing(b: Builder, r: Ring, first: number, feather: number, error: number): void {
  const n = r.length
  // Outward (right) normal of each edge i: from r[i] to r[i + 1].
  const nx = new Float64Array(n)
  const nz = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = r[i]!
    const c = r[(i + 1) % n]!
    const dx = c[0] - a[0]
    const dz = c[1] - a[1]
    const len = Math.sqrt(dx * dx + dz * dz) || 1
    nx[i] = dz / len
    nz[i] = -dx / len
  }
  // Per vertex: where the incoming edge's outer side ends, and the outgoing's starts.
  const endOf = new Int32Array(n)
  const startOf = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const p = r[i]!
    const e0 = (i - 1 + n) % n
    const e1 = i
    const turn = nx[e0]! * nz[e1]! - nz[e0]! * nx[e1]!
    // With the fill on the left, a left turn (the normal turning counter-clockwise) is convex: a
    // gap opens outside, filled by a round fan.
    const convex = turn > 0
    if (convex) {
      const o0 = b.vertex(p[0] + nx[e0]! * feather, p[1] + nz[e0]! * feather, 0)
      const o1 = b.vertex(p[0] + nx[e1]! * feather, p[1] + nz[e1]! * feather, 0)
      endOf[i] = o0
      startOf[i] = o1
      const a0 = Math.atan2(nz[e0]!, nx[e0]!)
      let a1 = Math.atan2(nz[e1]!, nx[e1]!)
      let da = a1 - a0
      while (da > Math.PI) da -= Math.PI * 2
      while (da < -Math.PI) da += Math.PI * 2
      a1 = a0 + da
      const steps = arcSteps(feather, Math.abs(da), error)
      let prev = o0
      for (let s = 1; s <= steps; s++) {
        const next =
          s === steps
            ? o1
            : b.vertex(
                p[0] + Math.cos(a0 + (da * s) / steps) * feather,
                p[1] + Math.sin(a0 + (da * s) / steps) * feather,
                0,
              )
        b.ring.push(first + i, prev, next)
        prev = next
      }
    } else {
      // Reflex: the two offset edges cross; they meet at the miter point (clamped).
      const mx = nx[e0]! + nx[e1]!
      const mz = nz[e0]! + nz[e1]!
      const ml = Math.sqrt(mx * mx + mz * mz)
      let ox = nx[e1]!
      let oz = nz[e1]!
      if (ml > 1e-9) {
        const ux = mx / ml
        const uz = mz / ml
        const scale = Math.min(MITER_LIMIT, 1 / Math.max(1e-6, ux * nx[e1]! + uz * nz[e1]!))
        ox = ux * scale
        oz = uz * scale
      }
      const m = b.vertex(p[0] + ox * feather, p[1] + oz * feather, 0)
      endOf[i] = m
      startOf[i] = m
    }
  }
  // One quad per edge: its two ring vertices (coverage 1) and their outer points (0).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const pi = first + i
    const pj = first + j
    b.ring.push(pi, pj, endOf[j]!, pi, endOf[j]!, startOf[i]!)
  }
}

/** A disk of `radius` (coverage 1) and an annulus to `radius + feather` (1 to 0). */
function disk(b: Builder, c: [number, number], radius: number, feather: number, error: number) {
  arc(b, c, radius, feather, 0, Math.PI * 2, error)
}

/**
 * A sector of a disk around `c` from angle a0 to a1: its core fan (coverage 1 to `radius`) and its
 * annular feather (to `radius + feather`).
 */
function arc(
  b: Builder,
  c: [number, number],
  radius: number,
  feather: number,
  a0: number,
  a1: number,
  error: number,
): void {
  const span = a1 - a0
  const steps = Math.max(1, arcSteps(radius + feather, Math.abs(span), error))
  const centre = b.vertex(c[0], c[1], 1)
  let prevIn = -1
  let prevOut = -1
  for (let s = 0; s <= steps; s++) {
    const a = a0 + (span * s) / steps
    const cx = Math.cos(a)
    const cz = Math.sin(a)
    const inner = b.vertex(c[0] + cx * radius, c[1] + cz * radius, 1)
    const outer =
      feather > 0 ? b.vertex(c[0] + cx * (radius + feather), c[1] + cz * (radius + feather), 0) : -1
    if (s > 0) {
      if (radius > 0) b.core.push(centre, prevIn, inner)
      if (feather > 0) b.ring.push(prevIn, inner, outer, prevIn, outer, prevOut)
    }
    prevIn = inner
    prevOut = outer
  }
}

/**
 * A brush stroke: a chain of capsules of `radius` around the points (a quad per segment, round
 * joins, round caps), and its feather: side strips, round outer joins, round caps.
 */
function brushCoverage(
  b: Builder,
  pts: Ring,
  radius: number,
  feather: number,
  error: number,
  tolerance: number,
) {
  const path = clean(pts, false, tolerance)
  if (path.length === 0) return
  if (path.length === 1) {
    disk(b, path[0]!, radius, feather, error)
    return
  }
  const n = path.length
  const segments = n - 1
  const nx = new Float64Array(segments)
  const nz = new Float64Array(segments)
  for (let s = 0; s < segments; s++) {
    const a = path[s]!
    const c = path[s + 1]!
    const dx = c[0] - a[0]
    const dz = c[1] - a[1]
    const len = Math.sqrt(dx * dx + dz * dz) || 1
    // Left normal of the direction of travel.
    nx[s] = -dz / len
    nz[s] = dx / len
  }
  const r = radius
  const f = feather
  for (let s = 0; s < segments; s++) {
    const a = path[s]!
    const c = path[s + 1]!
    const ox = nx[s]!
    const oz = nz[s]!
    // Core quad, both sides of the centreline.
    const al = b.vertex(a[0] + ox * r, a[1] + oz * r, 1)
    const ar = b.vertex(a[0] - ox * r, a[1] - oz * r, 1)
    const cl = b.vertex(c[0] + ox * r, c[1] + oz * r, 1)
    const cr = b.vertex(c[0] - ox * r, c[1] - oz * r, 1)
    b.core.push(al, ar, cl, ar, cr, cl)
    if (f > 0) {
      // Feather strips outside each side.
      const alo = b.vertex(a[0] + ox * (r + f), a[1] + oz * (r + f), 0)
      const clo = b.vertex(c[0] + ox * (r + f), c[1] + oz * (r + f), 0)
      const aro = b.vertex(a[0] - ox * (r + f), a[1] - oz * (r + f), 0)
      const cro = b.vertex(c[0] - ox * (r + f), c[1] - oz * (r + f), 0)
      b.ring.push(al, cl, clo, al, clo, alo, ar, cr, cro, ar, cro, aro)
    }
  }
  // Joins: the outer side of each turn gets a round sector (core and feather).
  for (let v = 1; v < n - 1; v++) {
    const s0 = v - 1
    const s1 = v
    const a0 = Math.atan2(nz[s0]!, nx[s0]!)
    let da = Math.atan2(nz[s1]!, nx[s1]!) - a0
    while (da > Math.PI) da -= Math.PI * 2
    while (da < -Math.PI) da += Math.PI * 2
    if (Math.abs(da) < 1e-9) continue
    // Turning left (da > 0) opens a gap on the right side, and the other way round.
    const start = da > 0 ? a0 + Math.PI : a0
    arc(b, path[v]!, r, f, start, start + da, error)
  }
  // Round caps at both ends.
  const first = Math.atan2(nz[0]!, nx[0]!)
  arc(b, path[0]!, r, f, first, first + Math.PI, error)
  const last = Math.atan2(nz[segments - 1]!, nx[segments - 1]!)
  arc(b, path[n - 1]!, r, f, last + Math.PI, last + Math.PI * 2, error)
}

/**
 * Tessellates a region shape with its feather. Core triangles (coverage 1) come first; a stencil
 * that takes each texel's first triangle per region makes overlaps harmless (see above).
 */
export function featheredCoverage(shape: CoverageShape, options: CoverageOptions): CoverageMesh {
  const feather = Math.max(0, options.feather)
  const error = options.error ?? 0.01
  const tolerance = Math.max(0, options.tolerance ?? 0)
  const b = new Builder()
  switch (shape.kind) {
    case 'rect':
      if (shape.w > 0 && shape.h > 0) {
        const { x, y, w, h } = shape
        polygonCoverage(
          b,
          [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
          ],
          [],
          feather,
          error,
          0,
        )
      }
      break
    case 'polygon':
      polygonCoverage(b, shape.outer, shape.holes ?? [], feather, error, tolerance)
      break
    case 'multipolygon':
      for (const p of shape.polygons)
        polygonCoverage(b, p.outer, p.holes ?? [], feather, error, tolerance)
      break
    case 'brush':
      brushCoverage(b, shape.points, shape.radius, feather, error, tolerance)
      break
  }
  return b.finish()
}

/** The bounds of a shape with its feather: [minX, minZ, maxX, maxZ]. */
export function coverageBounds(
  shape: CoverageShape,
  feather: number,
): [number, number, number, number] {
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  const add = (x: number, z: number, pad: number) => {
    if (x - pad < minX) minX = x - pad
    if (z - pad < minZ) minZ = z - pad
    if (x + pad > maxX) maxX = x + pad
    if (z + pad > maxZ) maxZ = z + pad
  }
  switch (shape.kind) {
    case 'rect':
      add(shape.x, shape.y, feather)
      add(shape.x + shape.w, shape.y + shape.h, feather)
      break
    case 'polygon':
      for (const p of shape.outer) add(p[0], p[1], feather * MITER_LIMIT)
      break
    case 'multipolygon':
      for (const poly of shape.polygons)
        for (const p of poly.outer) add(p[0], p[1], feather * MITER_LIMIT)
      break
    case 'brush':
      for (const p of shape.points) add(p[0], p[1], shape.radius + feather)
      break
  }
  return [minX, minZ, maxX, maxZ]
}
