import { polygon, ShardError } from '@aethervtt/shard-core'

// Vector shapes (0057) tessellated to meshes in the local XZ plane (y = 0), facing up: fills by
// ear clipping with holes bridged, strokes as a joined strip (mitred, or round joins and caps
// for pen). CSS-pixel strokes keep their centreline and carry their widening in the tangents
// (xyz: the offset direction, w: half the width in CSS pixels); the material widens them per
// view, so zooming never rebuilds. uv.x is 0 on fills and 1 on strokes. Fog (0058) reuses this.

export type VectorGeometry =
  | { kind: 'pen'; points: [number, number][] }
  | { kind: 'line'; from: [number, number]; to: [number, number] }
  | { kind: 'rect'; width: number; height: number }
  | { kind: 'ellipse'; rx: number; ry: number }
  | { kind: 'cone'; length: number; angle: number }
  | { kind: 'polygon'; outer: [number, number][]; holes?: [number, number][][] }

export type StrokeUnits = 'world' | 'css-px'

export interface VectorStyle {
  /** Stroke width: world units, or CSS pixels. 0: no stroke. */
  strokeWidth: number
  strokeUnits: StrokeUnits
  /** Whether to fill (closed shapes only). */
  fill: boolean
}

export interface TessellateOptions {
  /**
   * The densest zoom, in CSS pixels per world unit: curves are subdivided to a chord error of
   * 0.5 CSS px there. Default 256.
   */
  pixelsPerUnit?: number
}

/** Tessellated vertex and index data (a `MeshData` for `@aethervtt/shard-mesh`). */
export interface VectorMesh {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  tangents: Float32Array
  indices: Uint32Array
}

/** Grows as it's filled; one per call. */
class Builder {
  positions: Float32Array
  uvs: Float32Array
  tangents: Float32Array
  indices: Uint32Array
  vertices = 0
  count = 0

  constructor(vertices: number, indices: number) {
    this.positions = new Float32Array(Math.max(4, vertices) * 3)
    this.uvs = new Float32Array(Math.max(4, vertices) * 2)
    this.tangents = new Float32Array(Math.max(4, vertices) * 4)
    this.indices = new Uint32Array(Math.max(6, indices))
  }

  vertex(x: number, z: number, u: number, tx: number, tz: number, tw: number): number {
    const i = this.vertices
    if ((i + 1) * 3 > this.positions.length) this.grow()
    this.positions[i * 3] = x
    this.positions[i * 3 + 2] = z
    this.uvs[i * 2] = u
    this.tangents[i * 4] = tx
    this.tangents[i * 4 + 2] = tz
    this.tangents[i * 4 + 3] = tw
    this.vertices = i + 1
    return i
  }

  /** Where a vertex ends up: CSS-pixel strokes widen along their tangent (any scale will do). */
  private x(i: number): number {
    return this.positions[i * 3]! + this.tangents[i * 4]! * this.tangents[i * 4 + 3]!
  }

  private z(i: number): number {
    return this.positions[i * 3 + 2]! + this.tangents[i * 4 + 2]! * this.tangents[i * 4 + 3]!
  }

  /**
   * A triangle facing up (+y): CCW seen from above is clockwise in (x, z). CSS-pixel strokes are
   * wound by where their vertices end up once widened, not their shared centreline.
   */
  triangle(a: number, b: number, c: number): void {
    if (this.count + 3 > this.indices.length) {
      const next = new Uint32Array(this.indices.length * 2)
      next.set(this.indices)
      this.indices = next
    }
    const ax = this.x(a)
    const az = this.z(a)
    const cross = (this.x(b) - ax) * (this.z(c) - az) - (this.x(c) - ax) * (this.z(b) - az)
    this.indices[this.count++] = a
    if (cross > 0) {
      this.indices[this.count++] = c
      this.indices[this.count++] = b
    } else {
      this.indices[this.count++] = b
      this.indices[this.count++] = c
    }
  }

  private grow(): void {
    const n = this.positions.length / 3
    const p = new Float32Array(n * 6)
    p.set(this.positions)
    this.positions = p
    const u = new Float32Array(n * 4)
    u.set(this.uvs)
    this.uvs = u
    const t = new Float32Array(n * 8)
    t.set(this.tangents)
    this.tangents = t
  }

  finish(): VectorMesh {
    const n = this.vertices
    const normals = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) normals[i * 3 + 1] = 1
    return {
      positions: this.positions.slice(0, n * 3),
      normals,
      uvs: this.uvs.slice(0, n * 2),
      tangents: this.tangents.slice(0, n * 4),
      indices: this.indices.slice(0, this.count),
    }
  }
}

function invalid(message: string, path: string): ShardError {
  return new ShardError('vector/invalid-geometry', message, {
    path,
    hint: "geometry is { kind: 'pen' | 'line' | 'rect' | 'ellipse' | 'cone' | 'polygon', ... } in local (x, z) units.",
  })
}

function point(value: unknown, path: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  )
    throw invalid('Expected a point [x, z]', path)
  return value as [number, number]
}

function points(value: unknown, path: string, min: number): [number, number][] {
  if (!Array.isArray(value) || value.length < min)
    throw invalid(`Expected at least ${min} points`, path)
  for (let i = 0; i < value.length; i++) point(value[i], `${path}/${i}`)
  return value as [number, number][]
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw invalid('Expected a non-negative number', path)
  return value
}

/** Checks a geometry value (from a scene file or a host) and returns it typed. */
export function parseGeometry(value: unknown, path = '/geometry'): VectorGeometry {
  if (!value || typeof value !== 'object') throw invalid('Expected a geometry object', path)
  const g = value as Record<string, unknown>
  switch (g.kind) {
    case 'pen':
      return { kind: 'pen', points: points(g.points, `${path}/points`, 1) }
    case 'line':
      return { kind: 'line', from: point(g.from, `${path}/from`), to: point(g.to, `${path}/to`) }
    case 'rect':
      return {
        kind: 'rect',
        width: num(g.width, `${path}/width`),
        height: num(g.height, `${path}/height`),
      }
    case 'ellipse':
      return { kind: 'ellipse', rx: num(g.rx, `${path}/rx`), ry: num(g.ry, `${path}/ry`) }
    case 'cone':
      return {
        kind: 'cone',
        length: num(g.length, `${path}/length`),
        angle: num(g.angle, `${path}/angle`),
      }
    case 'polygon': {
      const holes = g.holes === undefined ? [] : g.holes
      if (!Array.isArray(holes)) throw invalid('Expected a list of holes', `${path}/holes`)
      return {
        kind: 'polygon',
        outer: points(g.outer, `${path}/outer`, 3),
        holes: holes.map((h, i) => points(h, `${path}/holes/${i}`, 3)),
      }
    }
    default:
      throw invalid(`Unknown geometry kind ${JSON.stringify(g.kind)}`, `${path}/kind`)
  }
}

/** Segments for an arc of `angle` radians at radius `r`, to a chord error of `error`. */
function arcSegments(r: number, angle: number, error: number): number {
  if (r <= error) return Math.max(3, Math.ceil(angle / (Math.PI / 2)))
  const step = 2 * Math.acos(1 - error / r)
  return Math.max(3, Math.min(1024, Math.ceil(angle / step)))
}

/** A shape's outline rings: closed ones (fill and closed stroke) or one open path. */
function outline(
  g: VectorGeometry,
  error: number,
): { rings: [number, number][][]; closed: boolean } {
  switch (g.kind) {
    case 'pen':
      return { rings: [g.points], closed: false }
    case 'line':
      return { rings: [[g.from, g.to]], closed: false }
    case 'rect':
      return {
        rings: [
          [
            [0, 0],
            [g.width, 0],
            [g.width, g.height],
            [0, g.height],
          ],
        ],
        closed: true,
      }
    case 'ellipse': {
      const n = arcSegments(Math.max(g.rx, g.ry), Math.PI * 2, error)
      const ring: [number, number][] = []
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        ring.push([Math.cos(a) * g.rx, Math.sin(a) * g.ry])
      }
      return { rings: [ring], closed: true }
    }
    case 'cone': {
      // A sector from the apex along +x, `angle` degrees wide.
      const half = (Math.min(360, g.angle) * Math.PI) / 360
      const n = arcSegments(g.length, half * 2, error)
      const ring: [number, number][] = [[0, 0]]
      for (let i = 0; i <= n; i++) {
        const a = -half + (i / n) * half * 2
        ring.push([Math.cos(a) * g.length, Math.sin(a) * g.length])
      }
      return { rings: [ring], closed: true }
    }
    case 'polygon':
      return { rings: [g.outer, ...(g.holes ?? [])], closed: true }
  }
}

/** Fills the rings (the first outer, the rest holes) by ear clipping. */
function fillRings(b: Builder, rings: [number, number][][]): void {
  let total = 0
  for (const r of rings) total += r.length
  const flat = new Float64Array(total * 2)
  const holes: number[] = []
  let k = 0
  for (let i = 0; i < rings.length; i++) {
    if (i > 0) holes.push(k)
    for (const [x, z] of rings[i]!) {
      flat[k * 2] = x
      flat[k * 2 + 1] = z
      k++
    }
  }
  const first = b.vertices
  for (let i = 0; i < total; i++) b.vertex(flat[i * 2]!, flat[i * 2 + 1]!, 0, 0, 0, 0)
  const tris = polygon.triangulate(flat, holes)
  for (let i = 0; i < tris.length; i += 3)
    b.triangle(first + tris[i]!, first + tris[i + 1]!, first + tris[i + 2]!)
}

/** How far a miter may reach, in half-widths, before it's clamped. */
const MITER_LIMIT = 4

/**
 * A joined strip along `pts`: mitred joins (clamped at the limit), or for `round`, per-segment
 * edges with round joins and caps. World strokes are offset here; CSS-pixel strokes put the
 * offset in the tangents and `half` in their w.
 */
function strokePath(
  b: Builder,
  pts: [number, number][],
  closed: boolean,
  half: number,
  css: boolean,
  round: boolean,
  error: number,
): void {
  // Drop repeated points (a pen stroke's still pointer).
  const path: [number, number][] = []
  for (const p of pts) {
    const last = path[path.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p)
  }
  if (closed && path.length > 2) {
    const a = path[0]!
    const z = path[path.length - 1]!
    if (a[0] === z[0] && a[1] === z[1]) path.pop()
  }
  const n = path.length
  const put = (x: number, z: number, ox: number, oz: number) =>
    css ? b.vertex(x, z, 1, ox, oz, half) : b.vertex(x + ox * half, z + oz * half, 1, 0, 0, 0)
  if (n === 1) {
    if (round) roundDot(b, path[0]!, half, css, error)
    return
  }
  const segments = closed ? n : n - 1
  // Segment normals (left of the direction of travel).
  const nx = new Float64Array(segments)
  const nz = new Float64Array(segments)
  for (let s = 0; s < segments; s++) {
    const a = path[s]!
    const c = path[(s + 1) % n]!
    const dx = c[0] - a[0]
    const dz = c[1] - a[1]
    const len = Math.sqrt(dx * dx + dz * dz) || 1
    nx[s] = -dz / len
    nz[s] = dx / len
  }
  if (round) {
    // Each segment its own quad; round wedges fill the joins; round caps at open ends.
    for (let s = 0; s < segments; s++) {
      const a = path[s]!
      const c = path[(s + 1) % n]!
      const l0 = put(a[0], a[1], nx[s]!, nz[s]!)
      const r0 = put(a[0], a[1], -nx[s]!, -nz[s]!)
      const l1 = put(c[0], c[1], nx[s]!, nz[s]!)
      const r1 = put(c[0], c[1], -nx[s]!, -nz[s]!)
      b.triangle(l0, r0, l1)
      b.triangle(r0, r1, l1)
    }
    const joins = closed ? n : n - 2
    for (let j = 0; j < joins; j++) {
      const v = closed ? j : j + 1
      const s0 = (v - 1 + segments) % segments
      const s1 = v % segments
      const a0 = Math.atan2(nz[s0]!, nx[s0]!)
      let a1 = Math.atan2(nz[s1]!, nx[s1]!)
      // The outer side turns the short way from one normal to the other (either side).
      let da = a1 - a0
      while (da > Math.PI) da -= Math.PI * 2
      while (da < -Math.PI) da += Math.PI * 2
      a1 = a0 + da
      const side = da > 0 ? -1 : 1
      wedge(
        b,
        path[v]!,
        half,
        css,
        a0 + (side < 0 ? Math.PI : 0),
        a1 + (side < 0 ? Math.PI : 0),
        error,
      )
    }
    if (!closed) {
      const a0 = Math.atan2(nz[0]!, nx[0]!)
      wedge(b, path[0]!, half, css, a0, a0 + Math.PI, error)
      const e = segments - 1
      const a1 = Math.atan2(nz[e]!, nx[e]!)
      wedge(b, path[n - 1]!, half, css, a1 + Math.PI, a1 + Math.PI * 2, error)
    }
    return
  }
  // Mitred: one left/right pair per point.
  let firstL = -1
  let firstR = -1
  let prevL = -1
  let prevR = -1
  for (let i = 0; i < n; i++) {
    let ox: number
    let oz: number
    const s0 = i - 1
    const s1 = i
    const has0 = closed || s0 >= 0
    const has1 = closed || s1 < segments
    if (has0 && has1) {
      const a = (s0 + segments) % segments
      const c = s1 % segments
      const mx = nx[a]! + nx[c]!
      const mz = nz[a]! + nz[c]!
      const ml = Math.sqrt(mx * mx + mz * mz)
      if (ml < 1e-9) {
        ox = nx[c]!
        oz = nz[c]!
      } else {
        const ux = mx / ml
        const uz = mz / ml
        const scale = Math.min(MITER_LIMIT, 1 / Math.max(1e-6, ux * nx[c]! + uz * nz[c]!))
        ox = ux * scale
        oz = uz * scale
      }
    } else if (has1) {
      ox = nx[s1]!
      oz = nz[s1]!
    } else {
      ox = nx[s0]!
      oz = nz[s0]!
    }
    const p = path[i]!
    const l = put(p[0], p[1], ox, oz)
    const r = put(p[0], p[1], -ox, -oz)
    if (i === 0) {
      firstL = l
      firstR = r
    } else {
      b.triangle(prevL, prevR, l)
      b.triangle(prevR, r, l)
    }
    prevL = l
    prevR = r
  }
  if (closed) {
    b.triangle(prevL, prevR, firstL)
    b.triangle(prevR, firstR, firstL)
  }
}

/** A fan around `c` from angle a0 to a1 (radians), radius `half`. */
function wedge(
  b: Builder,
  c: [number, number],
  half: number,
  css: boolean,
  a0: number,
  a1: number,
  error: number,
): void {
  const span = Math.abs(a1 - a0)
  if (span < 1e-6) return
  // CSS-pixel strokes: the radius on screen is `half` pixels, and the error half a pixel.
  const steps = arcSegments(half, span, css ? 0.5 : error)
  const centre = css ? b.vertex(c[0], c[1], 1, 0, 0, half) : b.vertex(c[0], c[1], 1, 0, 0, 0)
  let prev = -1
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps
    const ox = Math.cos(a)
    const oz = Math.sin(a)
    const v = css
      ? b.vertex(c[0], c[1], 1, ox, oz, half)
      : b.vertex(c[0] + ox * half, c[1] + oz * half, 1, 0, 0, 0)
    if (prev >= 0) b.triangle(centre, prev, v)
    prev = v
  }
}

function roundDot(
  b: Builder,
  c: [number, number],
  half: number,
  css: boolean,
  error: number,
): void {
  wedge(b, c, half, css, 0, Math.PI * 2, error)
}

/**
 * Tessellates a shape into a mesh in its local XZ plane. Fills only closed shapes; pen strokes
 * get round joins and caps, the rest mitred joins (butt caps on open lines).
 */
export function tessellate(
  geometry: VectorGeometry,
  style: VectorStyle,
  options: TessellateOptions = {},
): VectorMesh {
  const error = 0.5 / (options.pixelsPerUnit ?? 256)
  const { rings, closed } = outline(geometry, error)
  let estimate = 0
  for (const r of rings) estimate += r.length
  const b = new Builder(estimate * 6 + 16, estimate * 12 + 24)
  if (style.fill && closed) fillRings(b, rings)
  if (style.strokeWidth > 0) {
    const css = style.strokeUnits === 'css-px'
    const half = style.strokeWidth / 2
    const round = geometry.kind === 'pen'
    for (const ring of rings) strokePath(b, ring, closed, half, css, round, error)
  }
  return b.finish()
}

/** Area of the upward-facing triangles of a mesh (world units²): tests and stats. */
export function meshArea(mesh: VectorMesh, u?: number): number {
  let area = 0
  const p = mesh.positions
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]!
    const b = mesh.indices[i + 1]!
    const c = mesh.indices[i + 2]!
    if (u !== undefined && mesh.uvs[a * 2] !== u) continue
    area +=
      Math.abs(
        (p[b * 3]! - p[a * 3]!) * (p[c * 3 + 2]! - p[a * 3 + 2]!) -
          (p[c * 3]! - p[a * 3]!) * (p[b * 3 + 2]! - p[a * 3 + 2]!),
      ) / 2
  }
  return area
}
