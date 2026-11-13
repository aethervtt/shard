/**
 * Sine and cosine from + and * only, so mesh code gets the same bits in V8, JavaScriptCore, and
 * SpiderMonkey (their `Math.sin` differ in the last place). Accurate to about 1e-15 over any
 * argument a mesh uses. `datan2`, `dexp`, `dlog`, and `dpow` (below) do the same for the rest of
 * what generators need, so a cell generated in Node is the same bits as in any browser (0113).
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

// --- atan2, exp, log, pow ---------------------------------------------------------------------------
//
// The same reason as sine: engines compute these differently (V8 ports fdlibm, JavaScriptCore and
// SpiderMonkey call the platform's libm, which differs between macOS, glibc, and Windows), so a
// generator that must give the same bits everywhere can't call `Math.exp` and friends. These are
// fdlibm's algorithms (error under one ulp) written with + - * / and exact bit access through a
// DataView, which every engine does the same way.

// Big-endian, so word 0 is the high word (sign, exponent, top of the mantissa) and word 4 the low.
const bits = new DataView(new ArrayBuffer(8))

function hiWord(x: number): number {
  bits.setFloat64(0, x)
  return bits.getInt32(0)
}

function loWord(x: number): number {
  bits.setFloat64(0, x)
  return bits.getInt32(4)
}

/** `x` with its low word cleared (the top 21 mantissa bits: products with it are exact). */
function clearLow(x: number): number {
  bits.setFloat64(0, x)
  bits.setInt32(4, 0)
  return bits.getFloat64(0)
}

function withHigh(x: number, hi: number): number {
  bits.setFloat64(0, x)
  bits.setInt32(0, hi)
  return bits.getFloat64(0)
}

function fromWords(hi: number, lo: number): number {
  bits.setInt32(0, hi)
  bits.setInt32(4, lo)
  return bits.getFloat64(0)
}

/** 2^k for -1022 ≤ k ≤ 1023, exact. */
function pow2(k: number): number {
  return fromWords((k + 1023) << 20, 0)
}

/** x · 2^n with one rounding, for any n (subnormal and overflowing results included). */
function scale(x: number, n: number): number {
  if (n > 1023) {
    x *= pow2(1023)
    n -= 1023
    if (n > 1023) return x * pow2(1023)
  } else if (n < -1022) {
    // Two steps, the first exact: only the last can round, so subnormals round once.
    x *= pow2(-1022 + 53)
    n += 1022 - 53
    if (n < -1022) {
      x *= pow2(-1022 + 53)
      n += 1022 - 53
      if (n < -1022) n = -1022
    }
  }
  return x * pow2(n)
}

const LN2_HI = 0.6931471803691238
const LN2_LO = 1.9082149292705877e-10
const INV_LN2 = Math.LOG2E
const P1 = 0.16666666666666602
const P2 = -0.0027777777777015593
const P3 = 0.00006613756321437934
const P4 = -0.0000016533902205465252
const P5 = 4.1381367970572385e-8
const EXP_OVERFLOW = 709.782712893384
const EXP_UNDERFLOW = -745.1332191019411

/**
 * Deterministic `Math.exp` (fdlibm's: under one ulp). Overflows to Infinity above 709.78 and
 * underflows to 0 below -745.13.
 */
export function dexp(x: number): number {
  if (Number.isNaN(x)) return x
  if (x > EXP_OVERFLOW) return Number.POSITIVE_INFINITY
  if (x < EXP_UNDERFLOW) return 0
  const hx = hiWord(x) & 0x7fffffff
  if (hx < 0x3e300000) return 1 + x // |x| < 2^-28
  let k = 0
  let hi = x
  let lo = 0
  if (hx > 0x3fd62e42) {
    // |x| > ln2/2: x = k·ln2 + r with |r| ≤ ln2/2 (k rounded half away from zero, as fdlibm does).
    // k·LN2_HI is exact.
    k = Math.trunc(x * INV_LN2 + (x < 0 ? -0.5 : 0.5))
    hi = x - k * LN2_HI
    lo = k * LN2_LO
  }
  const r = hi - lo
  const t = r * r
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  if (k === 0) return 1 - ((r * c) / (c - 2) - r)
  return scale(1 - (lo - (r * c) / (2 - c) - hi), k)
}

const LG1 = 0.6666666666666735
const LG2 = 0.3999999999940942
const LG3 = 0.2857142874366239
const LG4 = 0.22222198432149784
const LG5 = 0.1818357216161805
const LG6 = 0.15313837699209373
const LG7 = 0.14798198605116586
const TWO54 = 18014398509481984

/** Deterministic `Math.log` (fdlibm's: under one ulp). Negative → NaN, ±0 → -Infinity. */
export function dlog(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN
  if (x === 0) return Number.NEGATIVE_INFINITY
  if (x === Number.POSITIVE_INFINITY) return x
  let k = 0
  let hx = hiWord(x)
  if (hx < 0x00100000) {
    // Subnormal: scale up.
    k -= 54
    x *= TWO54
    hx = hiWord(x)
  }
  k += (hx >> 20) - 1023
  hx &= 0x000fffff
  // Normalize x into [√2/2, √2).
  const i = (hx + 0x95f64) & 0x100000
  x = withHigh(x, hx | (i ^ 0x3ff00000))
  k += i >> 20
  const f = x - 1
  const dk = k
  if ((0x000fffff & (2 + hx)) < 3) {
    // |f| < 2^-20
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO
    const R = f * f * (0.5 - 0.3333333333333333 * f)
    return k === 0 ? f - R : dk * LN2_HI - (R - dk * LN2_LO - f)
  }
  const s = f / (2 + f)
  const z = s * s
  const w = z * z
  const t1 = w * (LG2 + w * (LG4 + w * LG6))
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  const R = t2 + t1
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f
    return k === 0
      ? f - (hfsq - s * (hfsq + R))
      : dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f)
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f)
}

const ATAN_HI = [0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966]
const ATAN_LO = [
  2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17,
]
const AT0 = 0.3333333333333293
const AT1 = -0.19999999999876483
const AT2 = 0.14285714272503466
const AT3 = -0.11111110405462356
const AT4 = 0.09090887133436507
const AT5 = -0.0769187620504483
const AT6 = 0.06661073137387531
const AT7 = -0.058335701337905735
const AT8 = 0.049768779946159324
const AT9 = -0.036531572744216916
const AT10 = 0.016285820115365782

/** atan of a finite x ≥ 0 (fdlibm's). */
function atanPositive(x: number): number {
  const ix = hiWord(x)
  if (ix >= 0x44100000) return ATAN_HI[3]! + ATAN_LO[3]! // x ≥ 2^66
  let id = -1
  if (ix < 0x3fdc0000) {
    // x < 0.4375
    if (ix < 0x3e200000) return x // x < 2^-29
  } else if (ix < 0x3ff30000) {
    if (ix < 0x3fe60000) {
      id = 0
      x = (2 * x - 1) / (2 + x)
    } else {
      id = 1
      x = (x - 1) / (x + 1)
    }
  } else if (ix < 0x40038000) {
    id = 2
    x = (x - 1.5) / (1 + 1.5 * x)
  } else {
    id = 3
    x = -1 / x
  }
  const z = x * x
  const w = z * z
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))))
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))))
  if (id < 0) return x - x * (s1 + s2)
  return ATAN_HI[id]! - (x * (s1 + s2) - ATAN_LO[id]! - x)
}

const PI = Math.PI
const PI_LO = 1.2246467991473532e-16
const PI_2 = 1.5707963267948966
const PI_4 = 0.7853981633974483

/**
 * Deterministic `Math.atan2` (fdlibm's: about one ulp), with the same quadrants, signed zeros,
 * and infinities.
 */
export function datan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN
  const hx = hiWord(x)
  const hy = hiWord(y)
  // Bit 0: y is negative (-0 too); bit 1: x is.
  const m = (hy < 0 ? 1 : 0) | (hx < 0 ? 2 : 0)
  if (y === 0) return m === 0 || m === 1 ? y : m === 2 ? PI : -PI
  if (x === 0) return y < 0 ? -PI_2 : PI_2
  const xInf = x === Number.POSITIVE_INFINITY || x === Number.NEGATIVE_INFINITY
  const yInf = y === Number.POSITIVE_INFINITY || y === Number.NEGATIVE_INFINITY
  if (xInf) {
    if (yInf) return m === 0 ? PI_4 : m === 1 ? -PI_4 : m === 2 ? 3 * PI_4 : -3 * PI_4
    return m === 0 ? 0 : m === 1 ? -0 : m === 2 ? PI : -PI
  }
  if (yInf) return y < 0 ? -PI_2 : PI_2
  if (x === 1) return y < 0 ? -atanPositive(-y) : atanPositive(y)
  const k = ((hy & 0x7fffffff) - (hx & 0x7fffffff)) >> 20
  let z: number
  // |y/x| > 2^60
  if (k > 60) return y < 0 ? -PI_2 - 0.5 * PI_LO : PI_2 + 0.5 * PI_LO
  // |y|/x < -2^60
  if (hx < 0 && k < -60) z = 0
  else z = atanPositive(Math.abs(y / x))
  if (m === 0) return z
  if (m === 1) return -z
  if (m === 2) return PI - (z - PI_LO)
  return z - PI_LO - PI
}

const BP = [1, 1.5]
const DP_H = [0, 0.5849624872207642]
const DP_L = [0, 1.350039202129749e-8]
const L1 = 0.5999999999999946
const L2 = 0.4285714285785502
const L3 = 0.33333332981837743
const L4 = 0.272728123808534
const L5 = 0.23066074577556175
const L6 = 0.20697501780033842
const LG2_FULL = Math.LN2
const LG2_H = 0.6931471824645996
const LG2_L = -1.904654299957768e-9
const OVT = 8.008566259537294e-17
const CP = 0.9617966939259756
const CP_H = 0.9617967009544373
const CP_L = -7.028461650952758e-9
const IVLN2 = Math.LOG2E
const IVLN2_H = 1.4426950216293335
const IVLN2_L = 1.9259629911266175e-8
const TWO53 = 9007199254740992
const SPLITTER = 134217729 // 2^27 + 1

/**
 * x^n for an integer |n| ≤ 2^31 by repeated squaring, when every product is exact (checked with
 * Dekker's two-product); NaN when one isn't. Exact results are then the same as anyone's.
 */
function exactIntPow(x: number, n: number): number {
  let e = n < 0 ? -n : n
  let base = x
  let acc = 1
  for (;;) {
    if (e % 2 === 1) {
      const p = acc * base
      if (!exactProduct(acc, base, p)) return Number.NaN
      acc = p
    }
    e = Math.floor(e / 2)
    if (e === 0) break
    const sq = base * base
    if (!exactProduct(base, base, sq)) return Number.NaN
    base = sq
  }
  return n < 0 ? 1 / acc : acc
}

/** Whether a · b === p exactly (Veltkamp split). Overflow, NaN, and products near the subnormal
 * range, where the split's partial products could round, count as not. */
function exactProduct(a: number, b: number, p: number): boolean {
  const ap = Math.abs(p)
  // 2^-900
  if (!(ap < Number.POSITIVE_INFINITY) || (ap < 1.1830521861667747e-271 && p !== 0)) return false
  let c = SPLITTER * a
  const ah = c - (c - a)
  const al = a - ah
  c = SPLITTER * b
  const bh = c - (c - b)
  const bl = b - bh
  return ah * bh - p + ah * bl + al * bh + al * bl === 0
}

/**
 * Deterministic `Math.pow` (fdlibm's, under one ulp), with JavaScript's special cases (`x^±0` is 1,
 * `(±1)^±Infinity` is NaN). Integer exponents whose result is exactly representable are computed
 * exactly (`dpow(2, 10) === 1024`), and `dpow(x, 0.5)` is `Math.sqrt(x)` for x ≥ 0.
 */
export function dpow(x: number, y: number): number {
  if (y === 0) return 1
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN
  if (
    Math.floor(y) === y &&
    Math.abs(y) <= 2147483648 &&
    x !== 0 &&
    x !== Number.POSITIVE_INFINITY &&
    x !== Number.NEGATIVE_INFINITY
  ) {
    const exact = exactIntPow(x, y)
    if (!Number.isNaN(exact)) return exact
  }
  const hx = hiWord(x)
  const lx = loWord(x)
  const hy = hiWord(y)
  const ly = loWord(y)
  let ix = hx & 0x7fffffff
  const iy = hy & 0x7fffffff

  // Whether y is an integer when x < 0: 0 no, 1 odd, 2 even.
  let yisint = 0
  if (hx < 0) {
    if (iy >= 0x43400000) yisint = 2
    else if (iy >= 0x3ff00000) {
      const k = (iy >> 20) - 0x3ff
      if (k > 20) {
        const j = ly >>> (52 - k)
        if ((j << (52 - k)) >>> 0 === ly >>> 0) yisint = 2 - (j & 1)
      } else if (ly === 0) {
        const j = iy >> (20 - k)
        if (j << (20 - k) === iy) yisint = 2 - (j & 1)
      }
    }
  }

  if (ly === 0) {
    if (iy === 0x7ff00000) {
      // y = ±Infinity
      if (((ix - 0x3ff00000) | lx) === 0) return Number.NaN
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0
      return hy < 0 ? -y : 0
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1 / x : x
    if (hy === 0x40000000) return x * x
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x)
  }

  let ax = Math.abs(x)
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    // x is ±0, ±Infinity, or ±1.
    let z = ax
    if (hy < 0) z = 1 / z
    if (hx < 0) {
      if (((ix - 0x3ff00000) | yisint) === 0) z = Number.NaN
      else if (yisint === 1) z = -z
    }
    return z
  }

  let n = hx < 0 ? 0 : 1
  if ((n | yisint) === 0) return Number.NaN // negative ** non-integer
  const s = (n | (yisint - 1)) === 0 ? -1 : 1 // negative ** odd

  let t1: number
  let t2: number
  if (iy > 0x41e00000) {
    // |y| > 2^31
    if (iy > 0x43f00000) {
      if (ix <= 0x3fefffff) return hy < 0 ? Number.POSITIVE_INFINITY : 0
      if (ix >= 0x3ff00000) return hy > 0 ? Number.POSITIVE_INFINITY : 0
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * Number.POSITIVE_INFINITY : s * 0
    if (ix > 0x3ff00000) return hy > 0 ? s * Number.POSITIVE_INFINITY : s * 0
    // |1 - x| ≤ 2^-20: log(x) ≈ t - t²/2 + t³/3 - t⁴/4.
    const t = ax - 1
    const w = t * t * (0.5 - t * (0.3333333333333333 - t * 0.25))
    const u = IVLN2_H * t
    const v = t * IVLN2_L - w * IVLN2
    t1 = clearLow(u + v)
    t2 = v - (t1 - u)
  } else {
    n = 0
    if (ix < 0x00100000) {
      ax *= TWO53
      n -= 53
      ix = hiWord(ax)
    }
    n += (ix >> 20) - 0x3ff
    const j = ix & 0x000fffff
    ix = j | 0x3ff00000
    let k: number
    if (j <= 0x3988e) k = 0
    else if (j < 0xbb67a) k = 1
    else {
      k = 0
      n += 1
      ix -= 0x00100000
    }
    ax = withHigh(ax, ix)
    // ss = s_h + s_l = (x - 1)/(x + 1) or (x - 1.5)/(x + 1.5)
    let u = ax - BP[k]!
    let v = 1 / (ax + BP[k]!)
    const ss = u * v
    const sH = clearLow(ss)
    let tH = fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0)
    let tL = ax - (tH - BP[k]!)
    const sL = v * (u - sH * tH - sH * tL)
    let s2 = ss * ss
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))))
    r += sL * (sH + ss)
    s2 = sH * sH
    tH = clearLow(3 + s2 + r)
    tL = r - (tH - 3 - s2)
    u = sH * tH
    v = sL * tH + tL * ss
    const pH = clearLow(u + v)
    const pL = v - (pH - u)
    const zH = CP_H * pH
    const zL = CP_L * pH + pL * CP + DP_L[k]!
    // log2(ax) = n + dp_h + z_h + z_l
    const t = n
    t1 = clearLow(zH + zL + DP_H[k]! + t)
    t2 = zL - (t1 - t - DP_H[k]! - zH)
  }

  // (y1 + y2) · (t1 + t2), y1 the top of y.
  const y1 = clearLow(y)
  const pL = (y - y1) * t1 + y * t2
  let pH = y1 * t1
  let z = pL + pH
  let j = hiWord(z)
  let i = loWord(z)
  if (j >= 0x40900000) {
    // z ≥ 1024
    if (((j - 0x40900000) | i) !== 0) return s * Number.POSITIVE_INFINITY
    if (pL + OVT > z - pH) return s * Number.POSITIVE_INFINITY
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    // z ≤ -1075
    if (((j ^ (0xc090cc00 | 0)) | i) !== 0) return s * 0
    if (pL <= z - pH) return s * 0
  }
  // 2^(pH + pL)
  i = j & 0x7fffffff
  let k = (i >> 20) - 0x3ff
  n = 0
  if (i > 0x3fe00000) {
    // |z| > 0.5: n = [z + 0.5]
    n = j + (0x00100000 >> (k + 1))
    k = ((n & 0x7fffffff) >> 20) - 0x3ff
    const t = fromWords(n & ~(0x000fffff >> k), 0)
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k)
    if (j < 0) n = -n
    pH -= t
  }
  let t = clearLow(pL + pH)
  const u = t * LG2_H
  const v = (pL - (t - pH)) * LG2_FULL + t * LG2_L
  z = u + v
  const w = v - (z - u)
  t = z * z
  t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  const r = (z * t1) / (t1 - 2) - (w + z * w)
  z = 1 - (r - z)
  j = hiWord(z) + (n << 20)
  z = j >> 20 <= 0 ? scale(z, n) : withHigh(z, j)
  return s * z
}
