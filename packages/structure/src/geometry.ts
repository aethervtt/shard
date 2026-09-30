import { polygon } from '@aethervtt/shard-core'
import { type Centerline, pointAt } from './curve'

// Structure geometry (0055, 0066), as pure functions over plain numbers: walls split around their
// openings, door and window frames, floors, and every piece clipped to the chunk squares it lies
// in. A chunk owns exactly the part of each piece inside its square; cut faces get no caps, so
// the parts meet as one surface.
//
// A wall runs along a sampled centreline (straight, arc or Bézier, see curve.ts). Each piece's
// footprint is the strip of quads between consecutive samples, offset half its thickness to each
// side; joints between quads, like chunk cuts, get no faces. Every footprint vertex carries its arc
// length, so UVs follow the curve and side normals are smooth along it.
//
// UVs are in metres. Wall faces: u runs to the right as seen from the face, v down (so an image
// reads upright), tops and floors: u, v = x, z. Every vertex has a tangent along u, so normal maps
// apply.

/** A wall in world units: a centreline in the XZ plane, extruded up from `elevation`. */
export interface WallShape {
  ax: number
  az: number
  bx: number
  bz: number
  height: number
  thickness: number
  elevation: number
  /** The sampled centreline (two samples for a straight wall). */
  line: Centerline
}

/** An opening along its host wall, in world units of arc length from the wall's start. */
export interface OpeningShape {
  kind: 'door' | 'window'
  offset: number
  width: number
  height: number
  sill: number
  frameWidth: number
  frameDepth: number
}

/**
 * A box along a wall: `[s0, s1]` of arc length along it, `[y0, y1]` up, `half` either side of the
 * centreline. Caps are the faces at s0 and s1; a piece that continues into another has none there.
 */
export interface Piece {
  s0: number
  s1: number
  y0: number
  y1: number
  half: number
  capStart: boolean
  capEnd: boolean
  /** Whether the underside shows (a lintel over a door; not a wall standing on the floor). */
  bottom: boolean
  /** A door or window frame, drawn with the opening's frame material. */
  frame: boolean
  /** Index of the opening (in the list passed to `wallPieces`) this piece frames; -1 for wall. */
  source: number
}

/** Length of a wall's centreline (its arc length when curved). */
export function wallLength(w: WallShape): number {
  return w.line.length
}

function piece(
  out: Piece[],
  n: number,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  half: number,
  bottom: boolean,
  frame: boolean,
  source = -1,
): number {
  if (s1 - s0 <= 1e-9 || y1 - y0 <= 1e-9) return n
  let p = out[n]
  if (!p) {
    p = { s0, s1, y0, y1, half, capStart: true, capEnd: true, bottom, frame, source }
    out[n] = p
  } else {
    p.source = source
    p.s0 = s0
    p.s1 = s1
    p.y0 = y0
    p.y1 = y1
    p.half = half
    p.capStart = true
    p.capEnd = true
    p.bottom = bottom
    p.frame = frame
  }
  return n + 1
}

/**
 * Splits a wall around its openings (sorted by offset) into pieces: solid spans at full height,
 * the wall below a window's sill and above an opening's head, and frame boxes. Returns the count
 * written to `out` (entries are reused).
 */
export function wallPieces(w: WallShape, openings: readonly OpeningShape[], out: Piece[]): number {
  const length = wallLength(w)
  if (length < 1e-6 || w.height <= 0) return 0
  const half = w.thickness / 2
  const base = w.elevation
  const top = base + w.height
  let n = 0
  let cursor = 0
  for (let i = 0; i < openings.length; i++) {
    const o = openings[i]!
    const o0 = Math.max(cursor, Math.min(length, o.offset))
    const o1 = Math.max(o0, Math.min(length, o.offset + o.width))
    if (o1 - o0 <= 1e-9) continue
    n = piece(out, n, cursor, o0, base, top, half, false, false)
    const sill = base + Math.max(0, o.sill)
    const head = Math.min(top, sill + o.height)
    const below = n
    n = piece(out, n, o0, o1, base, sill, half, false, false)
    if (n > below) {
      out[below]!.capStart = o0 === 0
      out[below]!.capEnd = o1 === length
    }
    const above = n
    n = piece(out, n, o0, o1, head, top, half, true, false)
    if (n > above) {
      out[above]!.capStart = o0 === 0
      out[above]!.capEnd = o1 === length
    }
    const fw = Math.min(o.frameWidth, (o1 - o0) / 2, head - sill)
    if (fw > 1e-9) {
      const fh = half + Math.max(0, o.frameDepth)
      n = piece(out, n, o0, o0 + fw, sill, head, fh, false, true, i)
      n = piece(out, n, o1 - fw, o1, sill, head, fh, false, true, i)
      n = piece(out, n, o0 + fw, o1 - fw, head - fw, head, fh, true, true, i)
      if (o.kind === 'window')
        n = piece(out, n, o0 + fw, o1 - fw, sill, sill + fw, fh, true, true, i)
    }
    cursor = o1
  }
  n = piece(out, n, cursor, length, base, top, half, false, false)
  return n
}

// ---------------------------------------------------------------------------
// Chunks

/** A chunk's key from its integer coordinates (each in ±32,767). */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 0x8000) * 0x10000 + (cz + 0x8000)
}

export function chunkX(key: number): number {
  return Math.floor(key / 0x10000) - 0x8000
}

export function chunkZ(key: number): number {
  return (key % 0x10000) - 0x8000
}

/** Edge labels while clipping a wall footprint: which face of the box an edge belongs to. */
const SIDE_POS = 0
const CAP_END = 1
const SIDE_NEG = 2
const CAP_START = 3
/** Along a chunk's edge, or between two quads of a curved piece: no face. */
const CUT = 4

/** Scratch for clipping: footprint quads, clipped to at most 8 points, with arc lengths. */
export class ClipScratch {
  readonly a = new Float64Array(24)
  readonly b = new Float64Array(24)
  readonly la = new Int8Array(12)
  readonly lb = new Int8Array(12)
  /** Arc length at each point. */
  readonly sa = new Float64Array(12)
  readonly sb = new Float64Array(12)
  readonly tri = new Float64Array(6)
  /** A centreline point and normal (pointAt). */
  readonly at = new Float64Array(4)
  /** The quad boundaries of the piece being walked: arc lengths. */
  bounds = new Float64Array(64)
}

/** The arc lengths a piece's strip breaks at: s0, the samples inside it, and s1. Returns count. */
function strip(line: Centerline, p: Piece, s: ClipScratch): number {
  let n = 0
  const push = (v: number) => {
    if (n === s.bounds.length) {
      const next = new Float64Array(n * 2)
      next.set(s.bounds)
      s.bounds = next
    }
    s.bounds[n++] = v
  }
  push(p.s0)
  for (let i = 1; i < line.count - 1; i++) {
    const v = line.s[i]!
    if (v > p.s0 + 1e-9 && v < p.s1 - 1e-9) push(v)
  }
  push(p.s1)
  return n
}

/**
 * Quad q of a piece's strip (between bounds q and q + 1), counter-clockwise from its +n side,
 * with edge labels and arc lengths, into `s.a`, `s.la` and `s.sa`.
 */
function quad(line: Centerline, p: Piece, q: number, last: number, s: ClipScratch): void {
  const sa = s.bounds[q]!
  const sb = s.bounds[q + 1]!
  const at = s.at
  pointAt(line, sa, at)
  const ax = at[0]!
  const az = at[1]!
  const anx = at[2]! * p.half
  const anz = at[3]! * p.half
  pointAt(line, sb, at)
  const bx = at[0]!
  const bz = at[1]!
  const bnx = at[2]! * p.half
  const bnz = at[3]! * p.half
  // c0 (start, +n) → c1 (end, +n): side +n; c1 → c2: end; c2 → c3: side −n; c3 → c0: start.
  const o = s.a
  o[0] = ax + anx
  o[1] = az + anz
  o[2] = bx + bnx
  o[3] = bz + bnz
  o[4] = bx - bnx
  o[5] = bz - bnz
  o[6] = ax - anx
  o[7] = az - anz
  s.la[0] = SIDE_POS
  s.la[1] = q + 1 === last ? CAP_END : CUT
  s.la[2] = SIDE_NEG
  s.la[3] = q === 0 ? CAP_START : CUT
  s.sa[0] = sa
  s.sa[1] = sb
  s.sa[2] = sb
  s.sa[3] = sa
}

/**
 * Sutherland–Hodgman against one axis-aligned edge, keeping each output edge's label (the label of
 * the input edge it lies on, or CUT along the clip line) and interpolating each point's arc length.
 */
function clipLabeled(
  src: Float64Array,
  srcLabels: Int8Array,
  srcS: Float64Array,
  n: number,
  dst: Float64Array,
  dstLabels: Int8Array,
  dstS: Float64Array,
  axis: number,
  at: number,
  sign: number,
): number {
  if (n === 0) return 0
  let count = 0
  let pi = n - 1
  let px = src[pi * 2]!
  let pz = src[pi * 2 + 1]!
  let ps = srcS[pi]!
  let pd = sign * ((axis === 0 ? px : pz) - at)
  for (let i = 0; i < n; i++) {
    const x = src[i * 2]!
    const z = src[i * 2 + 1]!
    const sv = srcS[i]!
    const d = sign * ((axis === 0 ? x : z) - at)
    if (d >= 0) {
      if (pd < 0) {
        const t = pd / (pd - d)
        dst[count * 2] = px + (x - px) * t
        dst[count * 2 + 1] = pz + (z - pz) * t
        dstS[count] = ps + (sv - ps) * t
        dstLabels[count] = srcLabels[pi]!
        count++
      }
      dst[count * 2] = x
      dst[count * 2 + 1] = z
      dstS[count] = sv
      dstLabels[count] = srcLabels[i]!
      count++
    } else if (pd >= 0) {
      const t = pd / (pd - d)
      dst[count * 2] = px + (x - px) * t
      dst[count * 2 + 1] = pz + (z - pz) * t
      dstS[count] = ps + (sv - ps) * t
      dstLabels[count] = CUT
      count++
    }
    pi = i
    px = x
    pz = z
    ps = sv
    pd = d
  }
  return count
}

/** Clips the quad in `s.a` to a chunk square; the result stays in `s.a`. Returns its count. */
function clipQuad(minX: number, minZ: number, maxX: number, maxZ: number, s: ClipScratch): number {
  let n = clipLabeled(s.a, s.la, s.sa, 4, s.b, s.lb, s.sb, 0, minX, 1)
  n = clipLabeled(s.b, s.lb, s.sb, n, s.a, s.la, s.sa, 0, maxX, -1)
  n = clipLabeled(s.a, s.la, s.sa, n, s.b, s.lb, s.sb, 1, minZ, 1)
  n = clipLabeled(s.b, s.lb, s.sb, n, s.a, s.la, s.sa, 1, maxZ, -1)
  if (n < 3 || Math.abs(polygon.signedArea(s.a, 0, n)) <= 1e-9) return 0
  return n
}

/**
 * Adds the keys of every chunk a wall's pieces overlap to `out` (a piece touching a chunk's edge
 * without area in it doesn't count). The same quads and test decide what each chunk draws.
 */
export function wallChunks(
  w: WallShape,
  pieces: readonly Piece[],
  count: number,
  size: number,
  out: Set<number>,
  s: ClipScratch,
): void {
  const line = w.line
  for (let i = 0; i < count; i++) {
    const p = pieces[i]!
    const bounds = strip(line, p, s)
    for (let q = 0; q + 1 < bounds; q++) {
      quad(line, p, q, bounds - 1, s)
      let x0 = Infinity
      let z0 = Infinity
      let x1 = -Infinity
      let z1 = -Infinity
      for (let k = 0; k < 4; k++) {
        const x = s.a[k * 2]!
        const z = s.a[k * 2 + 1]!
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (z < z0) z0 = z
        if (z > z1) z1 = z
      }
      for (let cx = Math.floor(x0 / size); cx <= Math.floor(x1 / size); cx++) {
        for (let cz = Math.floor(z0 / size); cz <= Math.floor(z1 / size); cz++) {
          const key = chunkKey(cx, cz)
          if (out.has(key)) continue
          quad(line, p, q, bounds - 1, s)
          if (clipQuad(cx * size, cz * size, (cx + 1) * size, (cz + 1) * size, s) > 0) out.add(key)
        }
      }
    }
  }
}

/** Grows as vertices are added; `reset` keeps its memory. */
export class MeshBuilder {
  positions = new Float32Array(768)
  normals = new Float32Array(768)
  uvs = new Float32Array(512)
  tangents = new Float32Array(1024)
  indices = new Uint32Array(1024)
  vertexCount = 0
  indexCount = 0
  /** Local-space bounds of what was added. */
  minX = Infinity
  minY = Infinity
  minZ = Infinity
  maxX = -Infinity
  maxY = -Infinity
  maxZ = -Infinity

  reset(): void {
    this.vertexCount = 0
    this.indexCount = 0
    this.minX = this.minY = this.minZ = Infinity
    this.maxX = this.maxY = this.maxZ = -Infinity
  }

  /** A vertex: position, normal, uv, and the tangent along u with its bitangent sign. */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    tx: number,
    ty: number,
    tz: number,
    tw: number,
  ): number {
    const i = this.vertexCount
    if ((i + 1) * 3 > this.positions.length) this.growVertices()
    const p = i * 3
    this.positions[p] = x
    this.positions[p + 1] = y
    this.positions[p + 2] = z
    this.normals[p] = nx
    this.normals[p + 1] = ny
    this.normals[p + 2] = nz
    this.uvs[i * 2] = u
    this.uvs[i * 2 + 1] = v
    const t = i * 4
    this.tangents[t] = tx
    this.tangents[t + 1] = ty
    this.tangents[t + 2] = tz
    this.tangents[t + 3] = tw
    if (x < this.minX) this.minX = x
    if (y < this.minY) this.minY = y
    if (z < this.minZ) this.minZ = z
    if (x > this.maxX) this.maxX = x
    if (y > this.maxY) this.maxY = y
    if (z > this.maxZ) this.maxZ = z
    this.vertexCount = i + 1
    return i
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.indices.length) {
      const next = new Uint32Array(this.indices.length * 2)
      next.set(this.indices)
      this.indices = next
    }
    this.indices[this.indexCount++] = a
    this.indices[this.indexCount++] = b
    this.indices[this.indexCount++] = c
  }

  private growVertices(): void {
    const grow = <T extends Float32Array>(a: T): T => {
      const next = new Float32Array(a.length * 2) as T
      next.set(a)
      return next
    }
    this.positions = grow(this.positions)
    this.normals = grow(this.normals)
    this.uvs = grow(this.uvs)
    this.tangents = grow(this.tangents)
  }

  /**
   * A convex planar polygon as a fan, wound so its front faces along (nx, ny, nz). `first` is the
   * index of its first vertex; the rest follow.
   */
  fan(first: number, count: number, nx: number, ny: number, nz: number): void {
    if (count < 3) return
    const p = this.positions
    const a = first * 3
    // Which way the fan winds: the polygon's area vector against the wanted normal.
    let cx = 0
    let cy = 0
    let cz = 0
    for (let k = 1; k + 1 < count; k++) {
      const b = (first + k) * 3
      const c = (first + k + 1) * 3
      const ux = p[b]! - p[a]!
      const uy = p[b + 1]! - p[a + 1]!
      const uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!
      const vy = p[c + 1]! - p[a + 1]!
      const vz = p[c + 2]! - p[a + 2]!
      cx += uy * vz - uz * vy
      cy += uz * vx - ux * vz
      cz += ux * vy - uy * vx
    }
    const flip = cx * nx + cy * ny + cz * nz < 0
    for (let k = 1; k + 1 < count; k++) {
      if (flip) this.triangle(first, first + k + 1, first + k)
      else this.triangle(first, first + k, first + k + 1)
    }
  }
}

/**
 * Emits the parts of a wall's pieces inside one chunk square: tops, undersides where they show,
 * the long sides, and caps at the wall's ends and around openings. Faces along the chunk's
 * edges, and between the quads of a curve, are left open. `builder(i)` is where piece i goes (by
 * its material). Returns whether anything was emitted.
 */
export function emitWall(
  w: WallShape,
  pieces: readonly Piece[],
  count: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  builder: (piece: number) => MeshBuilder,
  s: ClipScratch,
): boolean {
  const line = w.line
  if (line.length < 1e-6) return false
  // u on the +n side is the arc length plus where the start projects on the start's direction, so a
  // straight wall's u is the projection of the point on its direction.
  const d0x = line.nz[0]!
  const d0z = -line.nx[0]!
  const u0 = w.ax * d0x + w.az * d0z
  const at = s.at
  let any = false
  for (let i = 0; i < count; i++) {
    const p = pieces[i]!
    const m = builder(i)
    const bounds = strip(line, p, s)
    for (let q = 0; q + 1 < bounds; q++) {
      quad(line, p, q, bounds - 1, s)
      const n = clipQuad(minX, minZ, maxX, maxZ, s)
      if (n === 0) continue
      any = true
      const pts = s.a
      const labels = s.la
      const arc = s.sa
      // Top and (where it shows) bottom: u, v = x, z; the bitangent follows v (image up is −z).
      let first = m.vertexCount
      for (let k = 0; k < n; k++)
        m.vertex(
          pts[k * 2]!,
          p.y1,
          pts[k * 2 + 1]!,
          0,
          1,
          0,
          pts[k * 2]!,
          pts[k * 2 + 1]!,
          1,
          0,
          0,
          1,
        )
      m.fan(first, n, 0, 1, 0)
      if (p.bottom) {
        first = m.vertexCount
        for (let k = 0; k < n; k++)
          m.vertex(
            pts[k * 2]!,
            p.y0,
            pts[k * 2 + 1]!,
            0,
            -1,
            0,
            pts[k * 2]!,
            pts[k * 2 + 1]!,
            1,
            0,
            0,
            -1,
          )
        m.fan(first, n, 0, -1, 0)
      }
      // Vertical faces: one quad per edge that belongs to the box and isn't a cut or a joint.
      for (let k = 0; k < n; k++) {
        const label = labels[k]!
        if (label === CUT) continue
        if (label === CAP_START && !p.capStart) continue
        if (label === CAP_END && !p.capEnd) continue
        const k2 = (k + 1) % n
        const x0 = pts[k * 2]!
        const z0 = pts[k * 2 + 1]!
        const x1 = pts[k2 * 2]!
        const z1 = pts[k2 * 2 + 1]!
        first = m.vertexCount
        if (label === SIDE_POS || label === SIDE_NEG) {
          // Smooth along the curve: each end's normal is the centreline's at its arc length.
          const sgn = label === SIDE_POS ? 1 : -1
          for (let e = 0; e < 4; e++) {
            const end = e === 0 || e === 3 ? k : k2
            const x = end === k ? x0 : x1
            const z = end === k ? z0 : z1
            pointAt(line, arc[end]!, at)
            const fx = at[2]! * sgn
            const fz = at[3]! * sgn
            // u runs right as seen from the face: +s on the +n side, −s on the −n side.
            const u = sgn * (arc[end]! + u0)
            const y = e < 2 ? p.y0 : p.y1
            m.vertex(x, y, z, fx, 0, fz, u, -y, fz, 0, -fx, 1)
          }
          pointAt(line, (arc[k]! + arc[k2]!) / 2, at)
          m.fan(first, 4, at[2]! * sgn, 0, at[3]! * sgn)
        } else {
          // Caps face along the centreline at their end.
          pointAt(line, label === CAP_END ? p.s1 : p.s0, at)
          const sgn = label === CAP_END ? 1 : -1
          const fx = at[3]! * sgn
          const fz = -at[2]! * sgn
          // Right as seen from the face: (fz, −fx).
          const ux0 = x0 * fz - z0 * fx
          const ux1 = x1 * fz - z1 * fx
          m.vertex(x0, p.y0, z0, fx, 0, fz, ux0, -p.y0, fz, 0, -fx, 1)
          m.vertex(x1, p.y0, z1, fx, 0, fz, ux1, -p.y0, fz, 0, -fx, 1)
          m.vertex(x1, p.y1, z1, fx, 0, fz, ux1, -p.y1, fz, 0, -fx, 1)
          m.vertex(x0, p.y1, z0, fx, 0, fz, ux0, -p.y1, fz, 0, -fx, 1)
          m.fan(first, 4, fx, 0, fz)
        }
      }
    }
  }
  return any
}

// ---------------------------------------------------------------------------
// Floors

/** A floor ready to clip: its outline and ear-clipped triangles, computed once per edit. */
export interface FloorShape {
  /** Flat (x, z) pairs. */
  points: Float64Array
  /** Three vertex indices per triangle. */
  triangles: Uint32Array
  elevation: number
  /** Outline bounds. */
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/** Triangulates a floor outline (a simple polygon, either winding). */
export function floorShape(points: ArrayLike<ArrayLike<number>>, elevation: number): FloorShape {
  const flat = new Float64Array(points.length * 2)
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < points.length; i++) {
    const x = points[i]![0]!
    const z = points[i]![1]!
    flat[i * 2] = x
    flat[i * 2 + 1] = z
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const triangles = Uint32Array.from(polygon.triangulate(flat))
  return { points: flat, triangles, elevation, minX, minZ, maxX, maxZ }
}

function clipTriangle(
  f: FloorShape,
  t: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  s: ClipScratch,
): number {
  const tri = s.tri
  const pts = f.points
  for (let k = 0; k < 3; k++) {
    const i = f.triangles[t + k]! * 2
    tri[k * 2] = pts[i]!
    tri[k * 2 + 1] = pts[i + 1]!
  }
  const n = polygon.clipToRect(tri, 3, minX, minZ, maxX, maxZ, s.a, s.b)
  if (n < 3 || Math.abs(polygon.signedArea(s.a, 0, n)) <= 1e-9) return 0
  return n
}

function forTriangleChunks(
  f: FloorShape,
  t: number,
  size: number,
  visit: (cx: number, cz: number) => void,
): void {
  const pts = f.points
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (let k = 0; k < 3; k++) {
    const i = f.triangles[t + k]! * 2
    const x = pts[i]!
    const z = pts[i + 1]!
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  for (let cx = Math.floor(x0 / size); cx <= Math.floor(x1 / size); cx++)
    for (let cz = Math.floor(z0 / size); cz <= Math.floor(z1 / size); cz++) visit(cx, cz)
}

/** Adds the keys of every chunk a floor's area overlaps to `out`. */
export function floorChunks(f: FloorShape, size: number, out: Set<number>, s: ClipScratch): void {
  for (let t = 0; t < f.triangles.length; t += 3) {
    forTriangleChunks(f, t, size, (cx, cz) => {
      const key = chunkKey(cx, cz)
      if (out.has(key)) return
      if (clipTriangle(f, t, cx * size, cz * size, (cx + 1) * size, (cz + 1) * size, s) > 0)
        out.add(key)
    })
  }
}

/** Emits a floor's part inside one chunk square, facing up, with u, v = x, z. */
export function emitFloor(
  f: FloorShape,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  m: MeshBuilder,
  s: ClipScratch,
): boolean {
  if (f.maxX <= minX || f.minX >= maxX || f.maxZ <= minZ || f.minZ >= maxZ) return false
  let any = false
  const y = f.elevation
  for (let t = 0; t < f.triangles.length; t += 3) {
    const n = clipTriangle(f, t, minX, minZ, maxX, maxZ, s)
    if (n === 0) continue
    any = true
    const first = m.vertexCount
    for (let k = 0; k < n; k++) {
      const x = s.a[k * 2]!
      const z = s.a[k * 2 + 1]!
      m.vertex(x, y, z, 0, 1, 0, x, z, 1, 0, 0, 1)
    }
    m.fan(first, n, 0, 1, 0)
  }
  return any
}
