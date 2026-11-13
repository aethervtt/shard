/**
 * Uniform Catmull-Rom splines through points: terrain's spline layers (0071) and water's lake and
 * ocean outlines (0097) sample them the same way.
 */

/** A coordinate on the uniform Catmull-Rom segment from p1 to p2 (p0 and p3 its neighbours), t in [0, 1]. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

/**
 * Samples a uniform Catmull-Rom spline through `points` (x, y, z, flat) into `out` (x, y, z, flat):
 * each segment in pieces of at most `step` metres of horizontal (xz) length. An open spline repeats
 * its end points and runs from the first point to the last; a closed one wraps around, and doesn't
 * repeat its first point at the end.
 */
export function sampleCatmullRom(
  points: ArrayLike<number>,
  closed: boolean,
  step: number,
  out: number[] = [],
): number[] {
  const n = Math.floor(points.length / 3)
  if (n === 0) return out
  const index = (i: number) =>
    closed ? (((i % n) + n) % n) * 3 : Math.min(n - 1, Math.max(0, i)) * 3
  const segments = closed ? n : n - 1
  if (segments <= 0) {
    out.push(points[0]!, points[1]!, points[2]!)
    return out
  }
  for (let s = 0; s < segments; s++) {
    const i0 = index(s - 1)
    const i1 = index(s)
    const i2 = index(s + 1)
    const i3 = index(s + 2)
    const dx = points[i2]! - points[i1]!
    const dz = points[i2 + 2]! - points[i1 + 2]!
    // Not Math.hypot: engines differ in its last place, and deterministic generators can't call it.
    const len = Math.sqrt(dx * dx + dz * dz)
    const pieces = Math.max(1, Math.ceil(len / step))
    const last = closed && s === segments - 1 ? pieces - 1 : pieces
    for (let k = s === 0 ? 0 : 1; k <= last; k++) {
      const t = k / pieces
      for (let c = 0; c < 3; c++) {
        out.push(catmullRom(points[i0 + c]!, points[i1 + c]!, points[i2 + c]!, points[i3 + c]!, t))
      }
    }
  }
  return out
}
