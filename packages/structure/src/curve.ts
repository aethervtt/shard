// Wall centrelines (0066): straight lines, circular arcs and cubic Béziers, sampled to a chord
// tolerance as points with their arc lengths and left normals. Compile draws these samples and
// `planarBarriers` blocks along them, so what a server blocks is what the engine draws.

export type WallCurve = 'straight' | 'arc' | 'bezier'

/** What a centreline is made from, in world (x, z). */
export interface CurveInput {
  a: ArrayLike<number>
  b: ArrayLike<number>
  shape?: WallCurve
  /** Arc: how far the midpoint bows off the line a → b; positive bows to the left of a → b. */
  bow?: number
  /** Bézier: the cubic's control points. */
  c0?: ArrayLike<number>
  c1?: ArrayLike<number>
}

/**
 * A sampled centreline: points, the arc length at each, and the unit normal to the left of the
 * direction of travel. `radius` is the smallest radius of curvature (Infinity when straight).
 */
export interface Centerline {
  count: number
  x: Float64Array
  z: Float64Array
  s: Float64Array
  nx: Float64Array
  nz: Float64Array
  length: number
  radius: number
}

/** Default chord tolerance, metres (`StructureSettings.curveTolerance`). */
export const CURVE_TOLERANCE = 0.01

function alloc(n: number): Centerline {
  return {
    count: 0,
    x: new Float64Array(n),
    z: new Float64Array(n),
    s: new Float64Array(n),
    nx: new Float64Array(n),
    nz: new Float64Array(n),
    length: 0,
    radius: Infinity,
  }
}

function push(c: Centerline, x: number, z: number, tx: number, tz: number): void {
  if (c.count === c.x.length) {
    const grow = (a: Float64Array) => {
      const next = new Float64Array(a.length * 2)
      next.set(a)
      return next
    }
    c.x = grow(c.x)
    c.z = grow(c.z)
    c.s = grow(c.s)
    c.nx = grow(c.nx)
    c.nz = grow(c.nz)
  }
  const i = c.count++
  c.x[i] = x
  c.z[i] = z
  c.s[i] = i === 0 ? 0 : c.s[i - 1]! + Math.hypot(x - c.x[i - 1]!, z - c.z[i - 1]!)
  const l = Math.sqrt(tx * tx + tz * tz) || 1
  // Left of travel: the tangent turned a quarter anticlockwise in (x, z).
  c.nx[i] = -tz / l
  c.nz[i] = tx / l
}

/** A circular arc's centre, radius and sweep (signed radians, from a), or undefined if straight. */
export function arcOf(
  input: CurveInput,
): { cx: number; cz: number; r: number; from: number; sweep: number } | undefined {
  const bow = input.bow ?? 0
  const ax = input.a[0]!
  const az = input.a[1]!
  const bx = input.b[0]!
  const bz = input.b[1]!
  const dx = bx - ax
  const dz = bz - az
  const chord = Math.sqrt(dx * dx + dz * dz)
  if (chord < 1e-9 || Math.abs(bow) < 1e-9) return undefined
  const nx = -dz / chord
  const nz = dx / chord
  const r = (chord * chord) / 4 / (2 * Math.abs(bow)) + Math.abs(bow) / 2
  // The arc's midpoint bows `bow` along the left normal; the centre is r back from it.
  const mx = (ax + bx) / 2 + nx * bow
  const mz = (az + bz) / 2 + nz * bow
  const sign = Math.sign(bow)
  const cx = mx - nx * sign * r
  const cz = mz - nz * sign * r
  const from = Math.atan2(az - cz, ax - cx)
  const to = Math.atan2(bz - cz, bx - cx)
  const mid = Math.atan2(mz - cz, mx - cx)
  // Anticlockwise from `from` to `to`, unless the midpoint lies the other way round.
  let ccw = to - from
  while (ccw <= 0) ccw += Math.PI * 2
  let m = mid - from
  while (m < 0) m += Math.PI * 2
  const sweep = m <= ccw ? ccw : ccw - Math.PI * 2
  return { cx, cz, r, from, sweep }
}

/** Point and derivative of a cubic Bézier at t. */
function bezier(p: Float64Array, t: number, out: Float64Array): void {
  const u = 1 - t
  const b0 = u * u * u
  const b1 = 3 * u * u * t
  const b2 = 3 * u * t * t
  const b3 = t * t * t
  out[0] = b0 * p[0]! + b1 * p[2]! + b2 * p[4]! + b3 * p[6]!
  out[1] = b0 * p[1]! + b1 * p[3]! + b2 * p[5]! + b3 * p[7]!
  const d0 = 3 * u * u
  const d1 = 6 * u * t
  const d2 = 3 * t * t
  out[2] = d0 * (p[2]! - p[0]!) + d1 * (p[4]! - p[2]!) + d2 * (p[6]! - p[4]!)
  out[3] = d0 * (p[3]! - p[1]!) + d1 * (p[5]! - p[3]!) + d2 * (p[7]! - p[5]!)
}

/** The largest distance of the inner control points from the chord: a bound on the curve's. */
function flatness(p: Float64Array, t0: number, t1: number, scratch: Float64Array): number {
  // The sub-curve's control points, by de Casteljau at t0 and t1.
  const q = scratch
  const sub = (t: number, i: number) => {
    bezier(p, t, q)
    q[8 + i * 2] = q[0]!
    q[9 + i * 2] = q[1]!
  }
  sub(t0, 0)
  sub(t1, 3)
  bezier(p, t0, q)
  const d0x = q[2]! * ((t1 - t0) / 3)
  const d0z = q[3]! * ((t1 - t0) / 3)
  bezier(p, t1, q)
  const d1x = q[2]! * ((t1 - t0) / 3)
  const d1z = q[3]! * ((t1 - t0) / 3)
  const ax = q[8]!
  const az = q[9]!
  const bx = q[14]!
  const bz = q[15]!
  const c0x = ax + d0x
  const c0z = az + d0z
  const c1x = bx - d1x
  const c1z = bz - d1z
  const dx = bx - ax
  const dz = bz - az
  const len = Math.sqrt(dx * dx + dz * dz)
  const dist = (x: number, z: number) =>
    len < 1e-12 ? Math.hypot(x - ax, z - az) : Math.abs((x - ax) * dz - (z - az) * dx) / len
  return Math.max(dist(c0x, c0z), dist(c1x, c1z))
}

/** Curvature radius of a cubic at t. */
function bezierRadius(p: Float64Array, t: number): number {
  const u = 1 - t
  const dx = 3 * u * u * (p[2]! - p[0]!) + 6 * u * t * (p[4]! - p[2]!) + 3 * t * t * (p[6]! - p[4]!)
  const dz = 3 * u * u * (p[3]! - p[1]!) + 6 * u * t * (p[5]! - p[3]!) + 3 * t * t * (p[7]! - p[5]!)
  const ddx = 6 * u * (p[4]! - 2 * p[2]! + p[0]!) + 6 * t * (p[6]! - 2 * p[4]! + p[2]!)
  const ddz = 6 * u * (p[5]! - 2 * p[3]! + p[1]!) + 6 * t * (p[7]! - 2 * p[5]! + p[3]!)
  const cross = Math.abs(dx * ddz - dz * ddx)
  const speed = Math.sqrt(dx * dx + dz * dz)
  return cross < 1e-12 ? Infinity : (speed * speed * speed) / cross
}

/**
 * Samples a wall's centreline so no chord strays more than `tolerance` from the curve. Straight
 * walls give their two ends; arcs even angles; Béziers adaptive subdivision. Reuses `out`.
 */
export function sampleWall(
  input: CurveInput,
  tolerance = CURVE_TOLERANCE,
  out?: Centerline,
): Centerline {
  const c = out ?? alloc(8)
  c.count = 0
  c.radius = Infinity
  const ax = input.a[0]!
  const az = input.a[1]!
  const bx = input.b[0]!
  const bz = input.b[1]!
  const shape = input.shape ?? 'straight'
  const arc = shape === 'arc' ? arcOf(input) : undefined
  if (arc) {
    const { cx, cz, r, from, sweep } = arc
    const step = 2 * Math.acos(Math.max(-1, 1 - tolerance / r))
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-6)))
    for (let k = 0; k <= n; k++) {
      const a = from + (sweep * k) / n
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      // Exact ends: the samples at a and b are the wall's own points.
      const x = k === 0 ? ax : k === n ? bx : cx + r * cos
      const z = k === 0 ? az : k === n ? bz : cz + r * sin
      push(c, x, z, -sin * Math.sign(sweep), cos * Math.sign(sweep))
    }
    // Arc lengths along the circle, not the chords.
    for (let k = 0; k <= n; k++) c.s[k] = (r * Math.abs(sweep) * k) / n
    c.radius = r
  } else if (shape === 'bezier' && input.c0 && input.c1) {
    const p = new Float64Array([
      ax,
      az,
      input.c0[0]!,
      input.c0[1]!,
      input.c1[0]!,
      input.c1[1]!,
      bx,
      bz,
    ])
    const q = new Float64Array(16)
    // Adaptive: split any interval whose sub-curve strays more than the tolerance from its chord.
    const ts: number[] = [0]
    const stack: [number, number][] = [[0, 1]]
    const done: [number, number][] = []
    while (stack.length > 0) {
      const [t0, t1] = stack.pop()!
      if (t1 - t0 > 1 / 4096 && (t1 - t0 > 0.25 || flatness(p, t0, t1, q) > tolerance)) {
        const m = (t0 + t1) / 2
        stack.push([m, t1], [t0, m])
      } else done.push([t0, t1])
    }
    for (const [, t1] of done) ts.push(t1)
    for (const t of ts) {
      bezier(p, t, q)
      const x = t === 0 ? ax : t === 1 ? bx : q[0]!
      const z = t === 0 ? az : t === 1 ? bz : q[1]!
      let tx = q[2]!
      let tz = q[3]!
      // A degenerate end tangent (a control point on its end): look a little inside.
      if (tx * tx + tz * tz < 1e-18) {
        bezier(p, t === 0 ? 1e-4 : 1 - 1e-4, q)
        tx = q[2]!
        tz = q[3]!
      }
      push(c, x, z, tx, tz)
      c.radius = Math.min(c.radius, bezierRadius(p, t))
    }
    // Midpoints of each interval count too: the tightest spot is rarely on a sample.
    for (let i = 0; i + 1 < ts.length; i++)
      c.radius = Math.min(c.radius, bezierRadius(p, (ts[i]! + ts[i + 1]!) / 2))
  } else {
    push(c, ax, az, bx - ax, bz - az)
    push(c, bx, bz, bx - ax, bz - az)
  }
  c.length = c.s[c.count - 1]!
  return c
}

/** Index of the sample interval containing arc length `s` (clamped). */
export function intervalAt(c: Centerline, s: number): number {
  let lo = 0
  let hi = c.count - 2
  if (hi <= 0) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (c.s[mid]! <= s) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The centreline point and left normal at arc length `s`, interpolated between samples. */
export function pointAt(c: Centerline, s: number, out: Float64Array): Float64Array {
  const i = intervalAt(c, s)
  const s0 = c.s[i]!
  const s1 = c.s[i + 1] ?? s0
  const t = s1 > s0 ? Math.min(1, Math.max(0, (s - s0) / (s1 - s0))) : 0
  out[0] = c.x[i]! + (c.x[i + 1]! - c.x[i]!) * t
  out[1] = c.z[i]! + (c.z[i + 1]! - c.z[i]!) * t
  const nx = c.nx[i]! + (c.nx[i + 1]! - c.nx[i]!) * t
  const nz = c.nz[i]! + (c.nz[i + 1]! - c.nz[i]!) * t
  const l = Math.sqrt(nx * nx + nz * nz) || 1
  out[2] = nx / l
  out[3] = nz / l
  return out
}

/** A quadratic Bézier (one control point q) as the same curve in cubic form, exactly. */
export function quadraticToCubic(
  a: ArrayLike<number>,
  q: ArrayLike<number>,
  b: ArrayLike<number>,
): { c0: [number, number]; c1: [number, number] } {
  return {
    c0: [a[0]! + (2 / 3) * (q[0]! - a[0]!), a[1]! + (2 / 3) * (q[1]! - a[1]!)],
    c1: [b[0]! + (2 / 3) * (q[0]! - b[0]!), b[1]! + (2 / 3) * (q[1]! - b[1]!)],
  }
}
