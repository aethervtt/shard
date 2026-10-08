/**
 * Sine and cosine from + and * only, so mesh code gets the same bits in V8, JavaScriptCore, and
 * SpiderMonkey (their `Math.sin` differ in the last place). Accurate to about 1e-15 over any
 * argument a mesh uses.
 */

const TWO_OVER_PI = 0.6366197723675814
// π/2 split in two (Cody-Waite): k × HI is exact for |k| < 2^20.
const HALF_PI_HI = 1.5707963267341256
const HALF_PI_LO = 6.077100506506192e-11

function sinPoly(r: number): number {
  const r2 = r * r
  return (
    r *
    (1 +
      r2 *
        (-1 / 6 +
          r2 *
            (1 / 120 +
              r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800)))))))
  )
}

function cosPoly(r: number): number {
  const r2 = r * r
  return (
    1 +
    r2 *
      (-1 / 2 +
        r2 *
          (1 / 24 +
            r2 *
              (-1 / 720 +
                r2 * (1 / 40320 + r2 * (-1 / 3628800 + r2 * (1 / 479001600 + r2 / -87178291200))))))
  )
}

/** Writes [sin t, cos t] into `out` (from index `o`). */
export function sinCos(t: number, out: { [i: number]: number }, o = 0): void {
  const k = Math.round(t * TWO_OVER_PI)
  const r = t - k * HALF_PI_HI - k * HALF_PI_LO
  const s = sinPoly(r)
  const c = cosPoly(r)
  const q = ((k % 4) + 4) % 4
  out[o] = q === 0 ? s : q === 1 ? c : q === 2 ? -s : -c
  out[o + 1] = q === 0 ? c : q === 1 ? -s : q === 2 ? -c : s
}

const sc = new Float64Array(2)

/** Deterministic sine (see `sinCos`). */
export function dsin(t: number): number {
  sinCos(t, sc)
  return sc[0]!
}

/** Deterministic cosine (see `sinCos`). */
export function dcos(t: number): number {
  sinCos(t, sc)
  return sc[1]!
}

/** Degrees to radians. */
export const DEG = Math.PI / 180
