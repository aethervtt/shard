import { polygon } from '@aethervtt/shard-core'

// Structure geometry (0055), as pure functions over plain numbers: walls split around their
// openings, door and window frames, floors, and every piece clipped to the chunk squares it lies
// in. A chunk owns exactly the part of each piece inside its square; cut faces get no caps, so
// the parts meet as one surface. UVs are world-space, so textures don't seam at cuts.

/** A wall in world units: a centreline from a to b in the XZ plane, extruded up from `elevation`. */
export interface WallShape {
  ax: number
  az: number
  bx: number
  bz: number
  height: number
  thickness: number
  elevation: number
}

/** An opening along its host wall, in world units from the wall's start. */
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
 * A box along a wall: `[s0, s1]` along it, `[y0, y1]` up, `half` either side of the centreline.
 * Caps are the faces at s0 and s1; a piece that continues into another has none there.
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

/** Length of a wall's centreline. */
export function wallLength(w: WallShape): number {
  const dx = w.bx - w.ax
  const dz = w.bz - w.az
  return Math.sqrt(dx * dx + dz * dz)
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
const CUT = 4

/** Scratch for clipping: footprints are quads, clipped to at most 8 points. */
export class ClipScratch {
  readonly a = new Float64Array(24)
  readonly b = new Float64Array(24)
  readonly la = new Int8Array(12)
  readonly lb = new Int8Array(12)
  readonly tri = new Float64Array(6)
}

/** The footprint quad of a piece, counter-clockwise in (x, z), edge labels alongside. */
function footprint(
  w: WallShape,
  p: Piece,
  len: number,
  out: Float64Array,
  labels: Int8Array,
): void {
  const dx = (w.bx - w.ax) / len
  const dz = (w.bz - w.az) / len
  const nx = -dz * p.half
  const nz = dx * p.half
  const x0 = w.ax + dx * p.s0
  const z0 = w.az + dz * p.s0
  const x1 = w.ax + dx * p.s1
  const z1 = w.az + dz * p.s1
  // c0 (start, +n) → c1 (end, +n): side +n; c1 → c2 (end, −n): end cap; c2 → c3: side −n; c3 → c0.
  out[0] = x0 + nx
  out[1] = z0 + nz
  out[2] = x1 + nx
  out[3] = z1 + nz
  out[4] = x1 - nx
  out[5] = z1 - nz
  out[6] = x0 - nx
  out[7] = z0 - nz
  labels[0] = SIDE_POS
  labels[1] = CAP_END
  labels[2] = SIDE_NEG
  labels[3] = CAP_START
}

/**
 * Sutherland–Hodgman against one axis-aligned edge, keeping each output edge's label: the label of
 * the input edge it lies on, or CUT for an edge along the clip line.
 */
function clipLabeled(
  src: Float64Array,
  srcLabels: Int8Array,
  n: number,
  dst: Float64Array,
  dstLabels: Int8Array,
  axis: number,
  at: number,
  sign: number,
): number {
  if (n === 0) return 0
  let count = 0
  let pi = n - 1
  let px = src[pi * 2]!
  let pz = src[pi * 2 + 1]!
  let pd = sign * ((axis === 0 ? px : pz) - at)
  for (let i = 0; i < n; i++) {
    const x = src[i * 2]!
    const z = src[i * 2 + 1]!
    const d = sign * ((axis === 0 ? x : z) - at)
    if (d >= 0) {
      if (pd < 0) {
        const t = pd / (pd - d)
        dst[count * 2] = px + (x - px) * t
        dst[count * 2 + 1] = pz + (z - pz) * t
        dstLabels[count] = srcLabels[pi]!
        count++
      }
      dst[count * 2] = x
      dst[count * 2 + 1] = z
      dstLabels[count] = srcLabels[i]!
      count++
    } else if (pd >= 0) {
      const t = pd / (pd - d)
      dst[count * 2] = px + (x - px) * t
      dst[count * 2 + 1] = pz + (z - pz) * t
      dstLabels[count] = CUT
      count++
    }
    pi = i
    px = x
    pz = z
    pd = d
  }
  return count
}

/** Clips a piece's footprint to a chunk square. The result is in `s.a` / `s.la`; returns its count. */
function clipPiece(
  w: WallShape,
  p: Piece,
  len: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  s: ClipScratch,
): number {
  footprint(w, p, len, s.a, s.la)
  let n = clipLabeled(s.a, s.la, 4, s.b, s.lb, 0, minX, 1)
  n = clipLabeled(s.b, s.lb, n, s.a, s.la, 0, maxX, -1)
  n = clipLabeled(s.a, s.la, n, s.b, s.lb, 1, minZ, 1)
  n = clipLabeled(s.b, s.lb, n, s.a, s.la, 1, maxZ, -1)
  if (n < 3 || Math.abs(polygon.signedArea(s.a, 0, n)) <= 1e-9) return 0
  return n
}

/**
 * Adds the keys of every chunk a wall's pieces overlap to `out` (a piece touching a chunk's edge
 * without area in it doesn't count). The same test decides what each chunk draws.
 */
export function wallChunks(
  w: WallShape,
  pieces: readonly Piece[],
  count: number,
  size: number,
  out: Set<number>,
  s: ClipScratch,
): void {
  const len = wallLength(w)
  for (let i = 0; i < count; i++) {
    const p = pieces[i]!
    footprint(w, p, len, s.a, s.la)
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
    const cx0 = Math.floor(x0 / size)
    const cx1 = Math.floor(x1 / size)
    const cz0 = Math.floor(z0 / size)
    const cz1 = Math.floor(z1 / size)
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = chunkKey(cx, cz)
        if (out.has(key)) continue
        if (clipPiece(w, p, len, cx * size, cz * size, (cx + 1) * size, (cz + 1) * size, s) > 0)
          out.add(key)
      }
    }
  }
}

/** Grows as vertices are added; `reset` keeps its memory. */
export class MeshBuilder {
  positions = new Float32Array(768)
  normals = new Float32Array(768)
  uvs = new Float32Array(512)
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

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
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
 * edges are left open. `builder(i)` is where piece i goes (by its material). Returns whether
 * anything was emitted.
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
  const len = wallLength(w)
  if (len < 1e-6) return false
  const dx = (w.bx - w.ax) / len
  const dz = (w.bz - w.az) / len
  // Outward normal of the +n side (the wall's left, looking from a to b).
  const nx = -dz
  const nz = dx
  let any = false
  for (let i = 0; i < count; i++) {
    const p = pieces[i]!
    const n = clipPiece(w, p, len, minX, minZ, maxX, maxZ, s)
    if (n === 0) continue
    any = true
    const m = builder(i)
    const pts = s.a
    const labels = s.la
    // Top and (where it shows) bottom: u, v = x, z.
    let first = m.vertexCount
    for (let k = 0; k < n; k++)
      m.vertex(pts[k * 2]!, p.y1, pts[k * 2 + 1]!, 0, 1, 0, pts[k * 2]!, pts[k * 2 + 1]!)
    m.fan(first, n, 0, 1, 0)
    if (p.bottom) {
      first = m.vertexCount
      for (let k = 0; k < n; k++)
        m.vertex(pts[k * 2]!, p.y0, pts[k * 2 + 1]!, 0, -1, 0, pts[k * 2]!, pts[k * 2 + 1]!)
      m.fan(first, n, 0, -1, 0)
    }
    // Vertical faces: one quad per edge that belongs to the box and isn't a cut.
    for (let k = 0; k < n; k++) {
      const label = labels[k]!
      if (label === CUT) continue
      if (label === CAP_START && !p.capStart) continue
      if (label === CAP_END && !p.capEnd) continue
      let fx: number
      let fz: number
      let ux: number
      let uz: number
      if (label === SIDE_POS || label === SIDE_NEG) {
        const sgn = label === SIDE_POS ? 1 : -1
        fx = nx * sgn
        fz = nz * sgn
        ux = dx
        uz = dz
      } else {
        const sgn = label === CAP_END ? 1 : -1
        fx = dx * sgn
        fz = dz * sgn
        ux = nx
        uz = nz
      }
      const k2 = (k + 1) % n
      const x0 = pts[k * 2]!
      const z0 = pts[k * 2 + 1]!
      const x1 = pts[k2 * 2]!
      const z1 = pts[k2 * 2 + 1]!
      const u0 = x0 * ux + z0 * uz
      const u1 = x1 * ux + z1 * uz
      first = m.vertexCount
      m.vertex(x0, p.y0, z0, fx, 0, fz, u0, p.y0)
      m.vertex(x1, p.y0, z1, fx, 0, fz, u1, p.y0)
      m.vertex(x1, p.y1, z1, fx, 0, fz, u1, p.y1)
      m.vertex(x0, p.y1, z0, fx, 0, fz, u0, p.y1)
      m.fan(first, 4, fx, 0, fz)
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
      m.vertex(x, y, z, 0, 1, 0, x, z)
    }
    m.fan(first, n, 0, 1, 0)
  }
  return any
}
