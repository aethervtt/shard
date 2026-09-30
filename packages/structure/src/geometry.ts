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
// Slabs: floors and roofs (0055, 0067)
//
// A slab is an outline with holes (cutouts), a surface that is flat or rises along one slope, and
// an optional thickness below it. The surface is triangulated once per edit; a thick slab adds its
// underside, its outline's edges and its holes' rims. A hole can have a frame: a band around it on
// the surface, standing `depth` above it.

/** A hole's frame (0067): a band `width` wide around ring `ring`, standing `depth` above the surface. */
export interface SlabFrame {
  ring: number
  width: number
  depth: number
}

export interface SlabOptions {
  /** Holes, each a simple polygon inside the outline, either winding. */
  holes?: readonly ArrayLike<ArrayLike<number>>[]
  /** Frames around holes (`ring` 1 is the first hole). */
  frames?: readonly SlabFrame[]
  thickness?: number
  /** Degrees: 0 is flat; more is one slope rising along `ridge` from the outline's lowest point. */
  pitch?: number
  /** The direction the slope rises, (x, z). */
  ridge?: ArrayLike<number>
}

/** A floor or roof ready to clip: its rings, triangles and frames, computed once per edit. */
export interface FloorShape {
  /** Flat (x, z) pairs: the outline, then each hole. */
  points: Float64Array
  /** Where each ring starts, in points, then the total: ring r is `rings[r]` to `rings[r + 1]`. */
  rings: Uint32Array
  /** Per ring, the sign that turns an edge's left normal into the one pointing out of the slab. */
  sides: Int8Array
  /** Three vertex indices per triangle. */
  triangles: Uint32Array
  /** The surface's height at its lowest point: y = elevation + slope × (x·rx + z·rz − d0). */
  elevation: number
  slope: number
  rx: number
  rz: number
  d0: number
  thickness: number
  frames: readonly SlabFrame[]
  /** Each framed ring's points offset onto the slab by its frame's width (indexed as points). */
  frameOuter: Float64Array
  /** Bounds of everything it draws (the outline and frames). */
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/** The surface height of a slab at (x, z). */
export function slabY(f: FloorShape, x: number, z: number): number {
  return f.elevation + f.slope * (x * f.rx + z * f.rz - f.d0)
}

/**
 * Triangulates a slab: an outline (a simple polygon, either winding) with holes, and the frames
 * around them.
 */
export function floorShape(
  points: ArrayLike<ArrayLike<number>>,
  elevation: number,
  options: SlabOptions = {},
): FloorShape {
  const holes = options.holes ?? []
  let count = points.length
  for (const h of holes) count += h.length
  const flat = new Float64Array(count * 2)
  const rings = new Uint32Array(holes.length + 2)
  let n = 0
  const add = (ring: ArrayLike<ArrayLike<number>>) => {
    for (let i = 0; i < ring.length; i++) {
      flat[n * 2] = ring[i]![0]!
      flat[n * 2 + 1] = ring[i]![1]!
      n++
    }
  }
  add(points)
  for (let h = 0; h < holes.length; h++) {
    rings[h + 1] = n
    add(holes[h]!)
  }
  rings[holes.length + 1] = n
  const sides = new Int8Array(holes.length + 1)
  for (let r = 0; r <= holes.length; r++) {
    const area = polygon.signedArea(flat, rings[r]!, rings[r + 1]!)
    // The outline's inside is its left when counter-clockwise; a hole's inside isn't the slab.
    sides[r] = area > 0 === (r === 0) ? -1 : 1
  }
  const triangles = Uint32Array.from(polygon.triangulate(flat, rings.subarray(1, holes.length + 1)))
  const pitch = ((options.pitch ?? 0) * Math.PI) / 180
  let rx = options.ridge?.[0] ?? 0
  let rz = options.ridge?.[1] ?? 1
  const rl = Math.sqrt(rx * rx + rz * rz)
  if (rl < 1e-9) {
    rx = 0
    rz = 1
  } else {
    rx /= rl
    rz /= rl
  }
  let d0 = Infinity
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < points.length; i++) {
    const x = flat[i * 2]!
    const z = flat[i * 2 + 1]!
    d0 = Math.min(d0, x * rx + z * rz)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const f: FloorShape = {
    points: flat,
    rings,
    sides,
    triangles,
    elevation,
    slope: pitch > 1e-9 ? Math.tan(pitch) : 0,
    rx,
    rz,
    d0: Number.isFinite(d0) ? d0 : 0,
    thickness: Math.max(0, options.thickness ?? 0),
    frames: (options.frames ?? []).filter(
      (fr) => fr.width > 1e-9 && fr.ring > 0 && fr.ring <= holes.length,
    ),
    frameOuter: new Float64Array(flat.length),
    minX,
    minZ,
    maxX,
    maxZ,
  }
  for (const frame of f.frames) {
    offsetRing(f, frame.ring, frame.width, f.frameOuter)
    for (let i = f.rings[frame.ring]!; i < f.rings[frame.ring + 1]!; i++) {
      const x = f.frameOuter[i * 2]!
      const z = f.frameOuter[i * 2 + 1]!
      if (x < f.minX) f.minX = x
      if (x > f.maxX) f.maxX = x
      if (z < f.minZ) f.minZ = z
      if (z > f.maxZ) f.maxZ = z
    }
  }
  return f
}

/** One ring of a slab as a slab of its own on the same surface, `drop` below it (a hatch, a pane). */
export function ringShape(f: FloorShape, ring: number, thickness: number, drop = 0): FloorShape {
  const start = f.rings[ring]!
  const end = f.rings[ring + 1]!
  const points = f.points.slice(start * 2, end * 2)
  const count = end - start
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < count; i++) {
    const x = points[i * 2]!
    const z = points[i * 2 + 1]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return {
    points,
    rings: Uint32Array.of(0, count),
    sides: Int8Array.of(polygon.signedArea(points, 0, count) > 0 ? -1 : 1),
    triangles: Uint32Array.from(polygon.triangulate(points)),
    elevation: f.elevation - drop,
    slope: f.slope,
    rx: f.rx,
    rz: f.rz,
    d0: f.d0,
    thickness,
    frames: [],
    frameOuter: new Float64Array(0),
    minX,
    minZ,
    maxX,
    maxZ,
  }
}

/** Unit normal of ring edge i → j pointing out of the slab (away from its material), into `out`. */
function edgeNormal(f: FloorShape, ring: number, i: number, j: number, out: Float64Array): void {
  const p = f.points
  const dx = p[j * 2]! - p[i * 2]!
  const dz = p[j * 2 + 1]! - p[i * 2 + 1]!
  const l = Math.sqrt(dx * dx + dz * dz) || 1
  const sgn = f.sides[ring]!
  out[0] = (-dz / l) * sgn
  out[1] = (dx / l) * sgn
}

/** A ring's points moved `width` onto the slab (away from the hole), mitred at each corner. */
function offsetRing(f: FloorShape, ring: number, width: number, out: Float64Array): void {
  const start = f.rings[ring]!
  const end = f.rings[ring + 1]!
  const count = end - start
  const a = new Float64Array(2)
  const b = new Float64Array(2)
  for (let k = 0; k < count; k++) {
    const i = start + k
    const prev = start + ((k + count - 1) % count)
    const next = start + ((k + 1) % count)
    edgeNormal(f, ring, prev, i, a)
    edgeNormal(f, ring, i, next, b)
    // Onto the slab is the opposite of out of it. The offset lines meet at
    // (n1 + n2) / (1 + n1·n2), capped where a corner is sharp.
    const d = Math.max(0.25, 1 + a[0]! * b[0]! + a[1]! * b[1]!)
    out[i * 2] = f.points[i * 2]! - ((a[0]! + b[0]!) / d) * width
    out[i * 2 + 1] = f.points[i * 2 + 1]! - ((a[1]! + b[1]!) / d) * width
  }
}

/** Clips triangle (a, b, c) to a chunk square into `s.a`. Returns its point count (0: nothing). */
function clipTri(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  s: ClipScratch,
): number {
  const tri = s.tri
  tri[0] = ax
  tri[1] = az
  tri[2] = bx
  tri[3] = bz
  tri[4] = cx
  tri[5] = cz
  const n = polygon.clipToRect(tri, 3, minX, minZ, maxX, maxZ, s.a, s.b)
  if (n < 3 || Math.abs(polygon.signedArea(s.a, 0, n)) <= 1e-9) return 0
  return n
}

/** Clips segment a → b to a chunk square (Liang–Barsky) into `out`. Returns whether any is left. */
function clipSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: Float64Array,
): boolean {
  const dx = bx - ax
  const dz = bz - az
  let t0 = 0
  let t1 = 1
  for (let k = 0; k < 4; k++) {
    const p = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dz : dz
    const q = k === 0 ? ax - minX : k === 1 ? maxX - ax : k === 2 ? az - minZ : maxZ - az
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  if ((t1 - t0) * Math.sqrt(dx * dx + dz * dz) <= 1e-9) return false
  out[0] = ax + dx * t0
  out[1] = az + dz * t0
  out[2] = ax + dx * t1
  out[3] = az + dz * t1
  return true
}

function addTriangleChunks(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  size: number,
  out: Set<number>,
  s: ClipScratch,
): void {
  const x0 = Math.floor(Math.min(ax, bx, cx) / size)
  const x1 = Math.floor(Math.max(ax, bx, cx) / size)
  const z0 = Math.floor(Math.min(az, bz, cz) / size)
  const z1 = Math.floor(Math.max(az, bz, cz) / size)
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) {
      const key = chunkKey(x, z)
      if (out.has(key)) continue
      const n = clipTri(
        ax,
        az,
        bx,
        bz,
        cx,
        cz,
        x * size,
        z * size,
        (x + 1) * size,
        (z + 1) * size,
        s,
      )
      if (n > 0) out.add(key)
    }
}

/** Adds the keys of every chunk a slab's surface or frames overlap to `out`. */
export function floorChunks(f: FloorShape, size: number, out: Set<number>, s: ClipScratch): void {
  const p = f.points
  const t = f.triangles
  for (let k = 0; k < t.length; k += 3) {
    const a = t[k]! * 2
    const b = t[k + 1]! * 2
    const c = t[k + 2]! * 2
    addTriangleChunks(p[a]!, p[a + 1]!, p[b]!, p[b + 1]!, p[c]!, p[c + 1]!, size, out, s)
  }
  const o = f.frameOuter
  for (const frame of f.frames) {
    const start = f.rings[frame.ring]!
    const end = f.rings[frame.ring + 1]!
    for (let i = start; i < end; i++) {
      const pi = i * 2
      const pj = (i + 1 < end ? i + 1 : start) * 2
      addTriangleChunks(p[pi]!, p[pi + 1]!, p[pj]!, p[pj + 1]!, o[pj]!, o[pj + 1]!, size, out, s)
      addTriangleChunks(p[pi]!, p[pi + 1]!, o[pj]!, o[pj + 1]!, o[pi]!, o[pi + 1]!, size, out, s)
    }
  }
}

/** Adds every chunk segment a → b touches, edges included (a face on a chunk line draws in both). */
function addSegmentChunks(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  size: number,
  out: Set<number>,
): void {
  for (let x = Math.floor(Math.min(ax, bx) / size); x <= Math.floor(Math.max(ax, bx) / size); x++)
    for (let z = Math.floor(Math.min(az, bz) / size); z <= Math.floor(Math.max(az, bz) / size); z++)
      if (clipSegment(ax, az, bx, bz, x * size, z * size, (x + 1) * size, (z + 1) * size, seg))
        out.add(chunkKey(x, z))
}

/**
 * Adds the chunks a slab's ring covers to `out`: the hole's area, its rim and its frame. Moving a
 * cutout changes nothing drawn outside these, whatever the new triangulation (0067).
 */
export function ringChunks(
  f: FloorShape,
  ring: number,
  size: number,
  out: Set<number>,
  s: ClipScratch,
): void {
  const start = f.rings[ring]!
  const end = f.rings[ring + 1]!
  const p = f.points
  const tris = polygon.triangulate(p.subarray(start * 2, end * 2))
  for (let k = 0; k < tris.length; k += 3) {
    const a = (start + tris[k]!) * 2
    const b = (start + tris[k + 1]!) * 2
    const c = (start + tris[k + 2]!) * 2
    addTriangleChunks(p[a]!, p[a + 1]!, p[b]!, p[b + 1]!, p[c]!, p[c + 1]!, size, out, s)
  }
  const frame = f.frames.some((fr) => fr.ring === ring)
  const o = f.frameOuter
  for (let i = start; i < end; i++) {
    const pi = i * 2
    const pj = (i + 1 < end ? i + 1 : start) * 2
    addSegmentChunks(p[pi]!, p[pi + 1]!, p[pj]!, p[pj + 1]!, size, out)
    if (!frame) continue
    addTriangleChunks(p[pi]!, p[pi + 1]!, p[pj]!, p[pj + 1]!, o[pj]!, o[pj + 1]!, size, out, s)
    addTriangleChunks(p[pi]!, p[pi + 1]!, o[pj]!, o[pj + 1]!, o[pi]!, o[pi + 1]!, size, out, s)
    addSegmentChunks(o[pi]!, o[pi + 1]!, o[pj]!, o[pj + 1]!, size, out)
  }
}

/**
 * A slab surface's normal, u axis and bitangent sign (for its top face), and how much longer a
 * metre along the slope is than across it, into `out`.
 */
function surfaceBasis(f: FloorShape, out: Float64Array): void {
  const len = Math.sqrt(1 + f.slope * f.slope)
  const nx = (-f.slope * f.rx) / len
  const ny = 1 / len
  const nz = (-f.slope * f.rz) / len
  // u runs across the slope, v up it: flat, with the ridge along +z, u, v = x, z.
  const tx = f.rz
  const tz = -f.rx
  // The bitangent points where an image's top is (−v), as on walls and flat floors.
  const cx = ny * tz
  const cy = nz * tx - nx * tz
  const cz = -ny * tx
  out[0] = nx
  out[1] = ny
  out[2] = nz
  out[3] = tx
  out[4] = tz
  out[5] = -(cx * f.rx + cy * f.slope + cz * f.rz) >= 0 ? 1 : -1
  out[6] = len
}

const basis = new Float64Array(7)
const seg = new Float64Array(4)
const edge = new Float64Array(2)

/** A vertical quad over segment a → b, from `lo` to `hi` above the surface, facing (fx, fz). */
function sideFace(
  f: FloorShape,
  m: MeshBuilder,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  lo: number,
  hi: number,
  fx: number,
  fz: number,
): void {
  const ya = slabY(f, ax, az)
  const yb = slabY(f, bx, bz)
  // u runs right as seen from the face, v down, as on wall caps.
  const ua = ax * fz - az * fx
  const ub = bx * fz - bz * fx
  const first = m.vertexCount
  m.vertex(ax, ya + lo, az, fx, 0, fz, ua, -(ya + lo), fz, 0, -fx, 1)
  m.vertex(bx, yb + lo, bz, fx, 0, fz, ub, -(yb + lo), fz, 0, -fx, 1)
  m.vertex(bx, yb + hi, bz, fx, 0, fz, ub, -(yb + hi), fz, 0, -fx, 1)
  m.vertex(ax, ya + hi, az, fx, 0, fz, ua, -(ya + hi), fz, 0, -fx, 1)
  m.fan(first, 4, fx, 0, fz)
}

/** The clipped polygon in `s.a` as a face `lift` above the surface, facing up or down. */
function surfaceFace(
  f: FloorShape,
  m: MeshBuilder,
  n: number,
  lift: number,
  up: boolean,
  s: ClipScratch,
): void {
  const b = basis
  const sgn = up ? 1 : -1
  const first = m.vertexCount
  for (let k = 0; k < n; k++) {
    const x = s.a[k * 2]!
    const z = s.a[k * 2 + 1]!
    m.vertex(
      x,
      slabY(f, x, z) + lift,
      z,
      b[0]! * sgn,
      b[1]! * sgn,
      b[2]! * sgn,
      x * b[3]! + z * b[4]!,
      (x * f.rx + z * f.rz) * b[6]!,
      b[3]!,
      0,
      b[4]!,
      b[5]! * sgn,
    )
  }
  m.fan(first, n, b[0]! * sgn, b[1]! * sgn, b[2]! * sgn)
}

/**
 * Emits a slab's part inside one chunk square: its surface (u, v in metres along it) and, when
 * thick, its underside, edges and hole rims. Frames go to `frame(k)`, for frame k of `f.frames`.
 */
export function emitFloor(
  f: FloorShape,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  m: MeshBuilder,
  s: ClipScratch,
  frame?: (k: number) => MeshBuilder,
): boolean {
  if (f.maxX <= minX || f.minX >= maxX || f.maxZ <= minZ || f.minZ >= maxZ) return false
  surfaceBasis(f, basis)
  let any = false
  const p = f.points
  const t = f.triangles
  const thick = f.thickness
  for (let k = 0; k < t.length; k += 3) {
    const a = t[k]! * 2
    const b = t[k + 1]! * 2
    const c = t[k + 2]! * 2
    const n = clipTri(
      p[a]!,
      p[a + 1]!,
      p[b]!,
      p[b + 1]!,
      p[c]!,
      p[c + 1]!,
      minX,
      minZ,
      maxX,
      maxZ,
      s,
    )
    if (n === 0) continue
    any = true
    surfaceFace(f, m, n, 0, true, s)
    if (thick > 0) surfaceFace(f, m, n, -thick, false, s)
  }
  if (thick > 0) {
    for (let r = 0; r + 1 < f.rings.length; r++) {
      const start = f.rings[r]!
      const end = f.rings[r + 1]!
      for (let i = start; i < end; i++) {
        const j = i + 1 < end ? i + 1 : start
        const ax = p[i * 2]!
        const az = p[i * 2 + 1]!
        if (!clipSegment(ax, az, p[j * 2]!, p[j * 2 + 1]!, minX, minZ, maxX, maxZ, seg)) continue
        any = true
        edgeNormal(f, r, i, j, edge)
        sideFace(f, m, seg[0]!, seg[1]!, seg[2]!, seg[3]!, -thick, 0, edge[0]!, edge[1]!)
      }
    }
  }
  if (!frame) return any
  const o = f.frameOuter
  for (let fi = 0; fi < f.frames.length; fi++) {
    const fr = f.frames[fi]!
    const fm = frame(fi)
    const start = f.rings[fr.ring]!
    const end = f.rings[fr.ring + 1]!
    for (let i = start; i < end; i++) {
      const j = i + 1 < end ? i + 1 : start
      const pi = i * 2
      const pj = j * 2
      for (let half = 0; half < 2; half++) {
        const n =
          half === 0
            ? clipTri(
                p[pi]!,
                p[pi + 1]!,
                p[pj]!,
                p[pj + 1]!,
                o[pj]!,
                o[pj + 1]!,
                minX,
                minZ,
                maxX,
                maxZ,
                s,
              )
            : clipTri(
                p[pi]!,
                p[pi + 1]!,
                o[pj]!,
                o[pj + 1]!,
                o[pi]!,
                o[pi + 1]!,
                minX,
                minZ,
                maxX,
                maxZ,
                s,
              )
        if (n === 0) continue
        any = true
        surfaceFace(f, fm, n, fr.depth, true, s)
      }
      if (fr.depth <= 1e-9) continue
      // Its inside faces the hole; its outside faces back across the slab.
      edgeNormal(f, fr.ring, i, j, edge)
      const ix = edge[0]!
      const iz = edge[1]!
      if (clipSegment(p[pi]!, p[pi + 1]!, p[pj]!, p[pj + 1]!, minX, minZ, maxX, maxZ, seg))
        sideFace(f, fm, seg[0]!, seg[1]!, seg[2]!, seg[3]!, 0, fr.depth, ix, iz)
      if (clipSegment(o[pj]!, o[pj + 1]!, o[pi]!, o[pi + 1]!, minX, minZ, maxX, maxZ, seg))
        sideFace(f, fm, seg[0]!, seg[1]!, seg[2]!, seg[3]!, 0, fr.depth, -ix, -iz)
    }
  }
  return any
}

// ---------------------------------------------------------------------------
// Polygon tests (cutouts, roofAt)

/** Whether (x, z) is inside points `start` to `end` of a flat ring; on an edge counts as `edge`. */
export function insideRing(
  points: ArrayLike<number>,
  start: number,
  end: number,
  x: number,
  z: number,
  edge: boolean,
): boolean {
  let inside = false
  for (let i = start, j = end - 1; i < end; j = i++) {
    const xi = points[i * 2]!
    const zi = points[i * 2 + 1]!
    const xj = points[j * 2]!
    const zj = points[j * 2 + 1]!
    const dx = xj - xi
    const dz = zj - zi
    const l2 = dx * dx + dz * dz
    const cross = (x - xi) * dz - (z - zi) * dx
    const dot = (x - xi) * dx + (z - zi) * dz
    if (Math.abs(cross) <= 1e-9 * Math.sqrt(l2) && dot >= -1e-12 && dot <= l2 + 1e-12) return edge
    if (zi > z !== zj > z && x < (dx * (z - zi)) / dz + xi) inside = !inside
  }
  return inside
}

function orient(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const v = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
  return Math.abs(v) <= 1e-12 ? 0 : v > 0 ? 1 : -1
}

function within(ax: number, az: number, bx: number, bz: number, x: number, z: number): boolean {
  return (
    Math.min(ax, bx) - 1e-12 <= x &&
    x <= Math.max(ax, bx) + 1e-12 &&
    Math.min(az, bz) - 1e-12 <= z &&
    z <= Math.max(az, bz) + 1e-12
  )
}

/** Whether segments a–b and c–d meet (touching counts). */
function segmentsMeet(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const o1 = orient(ax, az, bx, bz, cx, cz)
  const o2 = orient(ax, az, bx, bz, dx, dz)
  const o3 = orient(cx, cz, dx, dz, ax, az)
  const o4 = orient(cx, cz, dx, dz, bx, bz)
  if (o1 !== o2 && o3 !== o4) return true
  return (
    (o1 === 0 && within(ax, az, bx, bz, cx, cz)) ||
    (o2 === 0 && within(ax, az, bx, bz, dx, dz)) ||
    (o3 === 0 && within(cx, cz, dx, dz, ax, az)) ||
    (o4 === 0 && within(cx, cz, dx, dz, bx, bz))
  )
}

function ringsTouch(a: Float64Array, b: Float64Array): boolean {
  const na = a.length / 2
  const nb = b.length / 2
  for (let i = 0; i < na; i++) {
    const i2 = ((i + 1) % na) * 2
    for (let j = 0; j < nb; j++) {
      const j2 = ((j + 1) % nb) * 2
      const meet = segmentsMeet(
        a[i * 2]!,
        a[i * 2 + 1]!,
        a[i2]!,
        a[i2 + 1]!,
        b[j * 2]!,
        b[j * 2 + 1]!,
        b[j2]!,
        b[j2 + 1]!,
      )
      if (meet) return true
    }
  }
  return false
}

/** Whether ring `inner` (flat points) lies strictly inside ring `outer`, touching nowhere. */
export function ringInside(inner: Float64Array, outer: Float64Array): boolean {
  if (ringsTouch(inner, outer)) return false
  return insideRing(outer, 0, outer.length / 2, inner[0]!, inner[1]!, false)
}

/** Whether two rings (flat points) overlap or touch. */
export function ringsOverlap(a: Float64Array, b: Float64Array): boolean {
  if (ringsTouch(a, b)) return true
  return (
    insideRing(b, 0, b.length / 2, a[0]!, a[1]!, true) ||
    insideRing(a, 0, a.length / 2, b[0]!, b[1]!, true)
  )
}
