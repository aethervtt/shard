import { pointAt } from './curve'
import { chunkKey, type MeshBuilder, type OpeningShape, type WallShape } from './geometry'

// Contact shade (0068): dark, noisy, blended strips where walls meet floors and each other, built
// by structure compile as geometry (fake ambient occlusion: no depth pass, no screen sampling).
//
// Each wall yields quads: floor strips along each side that faces a floor on its level, from the
// face out to `floorReach`, broken at doorways; and corner strips up the face at each end joined to
// another wall. Every vertex carries `fade`, 0 at the contact line and 1 at the reach. Quads are
// computed once per edit, then clipped into chunks like every other piece.

/** Floats per quad: its normal (x, y, z, 0), then four corners (x, y, z, fade). */
export const CONTACT_STRIDE = 20
/** Floor strips are walked in pieces of at most this (m): each decides its sides on its own. */
export const CONTACT_STEP = 1.8
/** How far strips stand off what they shade (m), above the floor or off the face. */
export const CONTACT_LIFT = 0.002
/** How far past the face a side's floor test looks (m). */
const SIDE_PROBE = 0.05
/** Corner strips stop this short of the shared height's top and bottom (m). */
const CORNER_INSET = 0.2

/** Quads, grown as needed: `count` quads of CONTACT_STRIDE floats in `data`. */
export class ContactQuads {
  data = new Float64Array(CONTACT_STRIDE * 8)
  count = 0

  reset(): void {
    this.count = 0
  }

  /** Room for one more quad; returns its offset. */
  next(): number {
    const o = this.count * CONTACT_STRIDE
    if (o + CONTACT_STRIDE > this.data.length) {
      const grown = new Float64Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    this.count++
    return o
  }

  /** Whether `other` holds the same quads (an edit that changed nothing here). */
  equals(other: ContactQuads): boolean {
    if (other.count !== this.count) return false
    for (let i = 0; i < this.count * CONTACT_STRIDE; i++)
      if (this.data[i] !== other.data[i]) return false
    return true
  }

  copy(other: ContactQuads): void {
    if (this.data.length < other.data.length) this.data = new Float64Array(other.data.length)
    this.data.set(other.data.subarray(0, other.count * CONTACT_STRIDE))
    this.count = other.count
  }
}

export interface ContactReach {
  /** Floor strips: from the face out to here (m). */
  floorReach: number
  /** Corner strips: from the joint along the face to here (m). */
  cornerReach: number
}

/** What a wall's contact geometry needs to know about its surroundings. */
export interface ContactEnv {
  /**
   * The top (y) of the floor on the wall's level containing (x, z), the one closest to `base` if
   * several do; NaN if none does.
   */
  floorTop(x: number, z: number, base: number): number
  /**
   * The joint at an end (0: the start, 1: the end), into `out`: the height the walls there share
   * (y0, y1, before insets), and how far along the face the joined walls cover. False if no other
   * wall meets that end.
   */
  joint(end: 0 | 1, out: Float64Array): boolean
}

const at = new Float64Array(4)
const jointOut = new Float64Array(3)

/** Whether side `sgn` of the wall at arc length `s` faces a floor; its top (y) or NaN. */
function sideFloor(w: WallShape, s: number, sgn: number, env: ContactEnv): number {
  pointAt(w.line, s, at)
  const off = (w.thickness / 2 + SIDE_PROBE) * sgn
  return env.floorTop(at[0]! + at[2]! * off, at[1]! + at[3]! * off, w.elevation)
}

/** One quad: normal, then corners (x, y, z, fade). */
function quad(out: ContactQuads, nx: number, ny: number, nz: number, c: readonly number[]): void {
  const o = out.next()
  const d = out.data
  d[o] = nx
  d[o + 1] = ny
  d[o + 2] = nz
  d[o + 3] = 0
  for (let i = 0; i < 16; i++) d[o + 4 + i] = c[i]!
}

const corners: number[] = new Array(16).fill(0)

/** Floor strip quads on side `sgn` over [s0, s1], at height y, one per centreline interval. */
function floorStrip(
  w: WallShape,
  s0: number,
  s1: number,
  sgn: number,
  y: number,
  reach: number,
  out: ContactQuads,
): void {
  const line = w.line
  const half = w.thickness / 2
  let a = s0
  let k = 1
  while (a < s1 - 1e-9) {
    while (k < line.count - 1 && line.s[k]! <= a + 1e-9) k++
    const b = k < line.count - 1 ? Math.min(s1, line.s[k]!) : s1
    pointAt(line, a, at)
    const ax = at[0]!
    const az = at[1]!
    const anx = at[2]! * sgn
    const anz = at[3]! * sgn
    pointAt(line, b, at)
    const bx = at[0]!
    const bz = at[1]!
    const bnx = at[2]! * sgn
    const bnz = at[3]! * sgn
    const c = corners
    c[0] = ax + anx * half
    c[1] = y
    c[2] = az + anz * half
    c[3] = 0
    c[4] = bx + bnx * half
    c[5] = y
    c[6] = bz + bnz * half
    c[7] = 0
    c[8] = bx + bnx * (half + reach)
    c[9] = y
    c[10] = bz + bnz * (half + reach)
    c[11] = 1
    c[12] = ax + anx * (half + reach)
    c[13] = y
    c[14] = az + anz * (half + reach)
    c[15] = 1
    quad(out, 0, 1, 0, c)
    a = b
  }
}

/**
 * Corner strip quads on side `sgn`, up the face from the end at `from` toward `to` (arc lengths),
 * over [y0, y1]: fade is the distance from `from` less `covered`, over `reach`.
 */
function cornerStrip(
  w: WallShape,
  from: number,
  to: number,
  covered: number,
  sgn: number,
  y0: number,
  y1: number,
  reach: number,
  out: ContactQuads,
): void {
  const line = w.line
  const off = w.thickness / 2 + CONTACT_LIFT
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  let a = lo
  let k = 1
  while (a < hi - 1e-9) {
    while (k < line.count - 1 && line.s[k]! <= a + 1e-9) k++
    const b = k < line.count - 1 ? Math.min(hi, line.s[k]!) : hi
    pointAt(line, a, at)
    const ax = at[0]! + at[2]! * off * sgn
    const az = at[1]! + at[3]! * off * sgn
    const nx = at[2]! * sgn
    const nz = at[3]! * sgn
    pointAt(line, b, at)
    const bx = at[0]! + at[2]! * off * sgn
    const bz = at[1]! + at[3]! * off * sgn
    const fa = (Math.abs(a - from) - covered) / reach
    const fb = (Math.abs(b - from) - covered) / reach
    const c = corners
    c[0] = ax
    c[1] = y0
    c[2] = az
    c[3] = fa
    c[4] = bx
    c[5] = y0
    c[6] = bz
    c[7] = fb
    c[8] = bx
    c[9] = y1
    c[10] = bz
    c[11] = fb
    c[12] = ax
    c[13] = y1
    c[14] = az
    c[15] = fa
    quad(out, (nx + at[2]! * sgn) / 2, 0, (nz + at[3]! * sgn) / 2, c)
    a = b
  }
}

/**
 * A wall's contact quads into `out` (reset first): floor strips on each side that faces a floor,
 * skipping door openings (`openings` sorted by offset), and corner strips at joined ends.
 */
export function contactQuads(
  w: WallShape,
  openings: readonly OpeningShape[],
  reach: ContactReach,
  env: ContactEnv,
  out: ContactQuads,
): void {
  out.reset()
  const length = w.line.length
  if (length < 1e-6 || w.height <= 0) return
  // Floor strips: the spans between doors, each walked in pieces of at most CONTACT_STEP.
  if (reach.floorReach > 1e-6) {
    let cursor = 0
    for (let i = 0; i <= openings.length; i++) {
      const o = openings[i]
      if (o && o.kind !== 'door') continue
      const end = o ? Math.max(cursor, Math.min(length, o.offset)) : length
      const span = end - cursor
      if (span > 1e-6) {
        const n = Math.max(1, Math.ceil(span / CONTACT_STEP))
        for (let p = 0; p < n; p++) {
          const s0 = cursor + (span * p) / n
          const s1 = cursor + (span * (p + 1)) / n
          for (let sgn = 1; sgn >= -1; sgn -= 2) {
            const top = sideFloor(w, (s0 + s1) / 2, sgn, env)
            if (Number.isNaN(top)) continue
            floorStrip(w, s0, s1, sgn, top + CONTACT_LIFT, reach.floorReach, out)
          }
        }
      }
      if (o) cursor = Math.max(cursor, Math.min(length, o.offset + o.width))
    }
  }
  // Corner strips at joined ends, on each side that faces a floor near that end.
  if (reach.cornerReach > 1e-6) {
    for (let end = 0; end < 2; end++) {
      if (!env.joint(end as 0 | 1, jointOut)) continue
      const y0 = jointOut[0]! + CORNER_INSET
      const y1 = jointOut[1]! - CORNER_INSET
      const covered = Math.max(0, jointOut[2]!)
      if (y1 <= y0) continue
      const from = end === 0 ? 0 : length
      const run = Math.min(length, covered + reach.cornerReach)
      const to = end === 0 ? run : length - run
      const probe = Math.min(length / 2, covered + reach.cornerReach / 2)
      for (let sgn = 1; sgn >= -1; sgn -= 2) {
        const top = sideFloor(w, end === 0 ? probe : length - probe, sgn, env)
        if (Number.isNaN(top)) continue
        cornerStrip(w, from, to, covered, sgn, y0, y1, reach.cornerReach, out)
      }
    }
  }
}

// --- chunks --------------------------------------------------------------------------------------

const polyA = new Float64Array(36)
const polyB = new Float64Array(36)

/** Sutherland–Hodgman of (x, z, fade) points against one axis-aligned edge. Returns the count. */
function clipEdge(
  src: Float64Array,
  n: number,
  dst: Float64Array,
  axis: number,
  edge: number,
  sign: number,
): number {
  if (n === 0) return 0
  let count = 0
  let p = (n - 1) * 3
  let pd = sign * (src[p + (axis === 0 ? 0 : 1)]! - edge)
  for (let i = 0; i < n; i++) {
    const c = i * 3
    const d = sign * (src[c + (axis === 0 ? 0 : 1)]! - edge)
    if (d >= 0 !== pd >= 0) {
      const t = pd / (pd - d)
      dst[count * 3] = src[p]! + (src[c]! - src[p]!) * t
      dst[count * 3 + 1] = src[p + 1]! + (src[c + 1]! - src[p + 1]!) * t
      dst[count * 3 + 2] = src[p + 2]! + (src[c + 2]! - src[p + 2]!) * t
      count++
    }
    if (d >= 0) {
      dst[count * 3] = src[c]!
      dst[count * 3 + 1] = src[c + 1]!
      dst[count * 3 + 2] = src[c + 2]!
      count++
    }
    p = c
    pd = d
  }
  return count
}

/** Clips floor quad `o` to a chunk square into polyA as (x, z, fade). Returns the point count. */
function clipFloorQuad(
  d: Float64Array,
  o: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): number {
  for (let k = 0; k < 4; k++) {
    polyA[k * 3] = d[o + 4 + k * 4]!
    polyA[k * 3 + 1] = d[o + 6 + k * 4]!
    polyA[k * 3 + 2] = d[o + 7 + k * 4]!
  }
  let n = clipEdge(polyA, 4, polyB, 0, minX, 1)
  n = clipEdge(polyB, n, polyA, 0, maxX, -1)
  n = clipEdge(polyA, n, polyB, 1, minZ, 1)
  n = clipEdge(polyB, n, polyA, 1, maxZ, -1)
  if (n < 3) return 0
  let area = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += polyA[i * 3]! * polyA[j * 3 + 1]! - polyA[j * 3]! * polyA[i * 3 + 1]!
  }
  return Math.abs(area) > 1e-9 ? n : 0
}

const span = new Float64Array(2)

/**
 * Clips a corner quad's base (corner 0 → corner 1) to a chunk square: the kept parameter range
 * into `span`. False if no length of it is inside. Chunks share their edges, so a base lying along
 * one is drawn by the chunk on its +x / +z side only.
 */
function clipCornerQuad(
  d: Float64Array,
  o: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): boolean {
  const ax = d[o + 4]!
  const az = d[o + 6]!
  const dx = d[o + 8]! - ax
  const dz = d[o + 10]! - az
  let t0 = 0
  let t1 = 1
  for (let k = 0; k < 4; k++) {
    const p = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dz : dz
    const q = k === 0 ? ax - minX : k === 1 ? maxX - ax : k === 2 ? az - minZ : maxZ - az
    if (Math.abs(p) < 1e-12) {
      // Parallel to this edge: outside it, or along the max edge (the next chunk draws it).
      if (q < 0 || (q === 0 && (k === 1 || k === 3))) return false
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
  span[0] = t0
  span[1] = t1
  return true
}

/** Adds the keys of every chunk a wall's contact quads have area (or length) in to `out`. */
export function contactChunks(quads: ContactQuads, size: number, out: Set<number>): void {
  const d = quads.data
  for (let q = 0; q < quads.count; q++) {
    const o = q * CONTACT_STRIDE
    let x0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let z1 = -Infinity
    for (let k = 0; k < 4; k++) {
      const x = d[o + 4 + k * 4]!
      const z = d[o + 6 + k * 4]!
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
    const vertical = d[o + 1] === 0
    for (let cx = Math.floor(x0 / size); cx <= Math.floor(x1 / size); cx++)
      for (let cz = Math.floor(z0 / size); cz <= Math.floor(z1 / size); cz++) {
        const key = chunkKey(cx, cz)
        if (out.has(key)) continue
        const minX = cx * size
        const minZ = cz * size
        const hit = vertical
          ? clipCornerQuad(d, o, minX, minZ, minX + size, minZ + size)
          : clipFloorQuad(d, o, minX, minZ, minX + size, minZ + size) > 0
        if (hit) out.add(key)
      }
  }
}

/**
 * Emits the parts of contact quads inside one chunk square into `m`: positions, normals, and fade
 * in u. Returns whether anything was emitted.
 */
export function emitContact(
  quads: ContactQuads,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  m: MeshBuilder,
): boolean {
  const d = quads.data
  let any = false
  for (let q = 0; q < quads.count; q++) {
    const o = q * CONTACT_STRIDE
    const nx = d[o]!
    const ny = d[o + 1]!
    const nz = d[o + 2]!
    if (ny !== 0) {
      const n = clipFloorQuad(d, o, minX, minZ, maxX, maxZ)
      if (n === 0) continue
      any = true
      const y = d[o + 5]!
      const first = m.vertexCount
      for (let k = 0; k < n; k++)
        m.vertex(polyA[k * 3]!, y, polyA[k * 3 + 1]!, 0, 1, 0, polyA[k * 3 + 2]!, 0, 1, 0, 0, 1)
      m.fan(first, n, 0, 1, 0)
      continue
    }
    if (!clipCornerQuad(d, o, minX, minZ, maxX, maxZ)) continue
    any = true
    const first = m.vertexCount
    // Base corners 0 → 1 at y0, top corners 3 → 2 at y1, cut to the kept span.
    for (let e = 0; e < 4; e++) {
      const t = e === 0 || e === 3 ? span[0]! : span[1]!
      const y = e < 2 ? d[o + 5]! : d[o + 13]!
      const x = d[o + 4]! + (d[o + 8]! - d[o + 4]!) * t
      const z = d[o + 6]! + (d[o + 10]! - d[o + 6]!) * t
      const fade = d[o + 7]! + (d[o + 11]! - d[o + 7]!) * t
      m.vertex(x, y, z, nx, 0, nz, fade, 0, -nz, 0, nx, 1)
    }
    m.fan(first, 4, nx, 0, nz)
  }
  return any
}

// --- the fragment ------------------------------------------------------------------------------

/** What the contact fragment reads (StructureSettings.contact's appearance). */
export interface ContactLook {
  opacity: number
  maxAlpha: number
  wobble: number
}

/** The share of the reach the contact core darkens. */
export const CONTACT_CORE = 0.1
/** How much the core adds over the falloff. */
export const CONTACT_CORE_BOOST = 0.55

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * The contact strip's alpha at `fade` (0 at the contact line, 1 at the reach) for noise value `n`
 * in [0, 1]: the CPU mirror of `structure::contact`'s shade. Non-increasing in fade for any n.
 */
export function contactAlpha(fade: number, n: number, look: ContactLook): number {
  const wobble = Math.min(1, Math.max(0, look.wobble))
  const f = Math.min(1, Math.max(0, fade * (1 + wobble * (2 * n - 1))))
  const falloff = 1 - smoothstep(0, 1, f)
  const core = 1 - smoothstep(0, CONTACT_CORE, f)
  // Whatever the wobble, nothing is left at the strip's outer edge.
  const edge = 1 - smoothstep(0.8, 1, fade)
  const alpha =
    look.opacity * (falloff * (0.8 + 0.2 * falloff) + core * CONTACT_CORE_BOOST) * (0.94 + 0.12 * n)
  return Math.min(look.maxAlpha, alpha) * edge
}
