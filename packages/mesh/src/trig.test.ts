import { describe, expect, it } from 'vitest'
import { datan2, dcos, dexp, dlog, dpow, dsin } from './trig'

/** A seeded uniform [0, 1) stream (LCG), so failures reproduce. */
function stream(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Relative error against `Math`, with an absolute floor for results near 0. */
function within(actual: number, expected: number, rel = 1e-14): boolean {
  if (Object.is(actual, expected)) return true
  return Math.abs(actual - expected) <= rel * Math.max(Math.abs(expected), 1e-300)
}

function sample(n: number, seed: number, check: (rnd: () => number) => [number, number, string]) {
  const rnd = stream(seed)
  const bad: string[] = []
  for (let i = 0; i < n; i++) {
    const [actual, expected, input] = check(rnd)
    if (!within(actual, expected)) bad.push(`${input}: ${actual} vs ${expected}`)
  }
  expect(bad.slice(0, 5)).toEqual([])
}

// What's being compared against (Biome would rewrite `Math.pow` calls as `**`).
const mathPow = Math.pow

const bits = new DataView(new ArrayBuffer(8))
function hex(x: number): string {
  bits.setFloat64(0, x)
  return bits.getBigUint64(0).toString(16).padStart(16, '0')
}

describe('accuracy against Math', () => {
  it('dexp', () => {
    sample(20000, 1, (r) => {
      const x = (r() * 2 - 1) * 740
      return [dexp(x), Math.exp(x), `exp(${x})`]
    })
    sample(20000, 2, (r) => {
      const x = (r() * 2 - 1) * 2
      return [dexp(x), Math.exp(x), `exp(${x})`]
    })
  })

  it('dlog', () => {
    sample(20000, 3, (r) => {
      const x = Math.exp((r() * 2 - 1) * 700)
      return [dlog(x), Math.log(x), `log(${x})`]
    })
    sample(20000, 4, (r) => {
      const x = 1 + (r() * 2 - 1) * 1e-3
      return [dlog(x), Math.log(x), `log(${x})`]
    })
    sample(2000, 5, (r) => {
      const x = r() * 2e-308 // subnormals
      return [dlog(x), Math.log(x), `log(${x})`]
    })
  })

  it('datan2, in every quadrant', () => {
    sample(40000, 6, (r) => {
      const y = (r() * 2 - 1) * 10 ** (r() * 12 - 6)
      const x = (r() * 2 - 1) * 10 ** (r() * 12 - 6)
      return [datan2(y, x), Math.atan2(y, x), `atan2(${y}, ${x})`]
    })
  })

  it('dpow', () => {
    sample(20000, 7, (r) => {
      const x = r() * 100
      const y = (r() * 2 - 1) * 100
      return [dpow(x, y), mathPow(x, y), `pow(${x}, ${y})`]
    })
    sample(20000, 8, (r) => {
      const x = (r() * 2 - 1) * 10
      const y = Math.floor((r() * 2 - 1) * 60)
      return [dpow(x, y), mathPow(x, y), `pow(${x}, ${y})`]
    })
    sample(5000, 9, (r) => {
      // |y| > 2^31 with x close to 1.
      const x = 1 + (r() * 2 - 1) * 1e-10
      const y = (r() * 2 - 1) * 1e11
      return [dpow(x, y), mathPow(x, y), `pow(${x}, ${y})`]
    })
  })
})

describe('special cases', () => {
  it('dexp', () => {
    expect(dexp(Number.NaN)).toBeNaN()
    expect(dexp(0)).toBe(1)
    expect(dexp(-0)).toBe(1)
    expect(dexp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(dexp(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(dexp(710)).toBe(Number.POSITIVE_INFINITY)
    expect(dexp(-746)).toBe(0)
    expect(dexp(709.78)).toBeLessThan(Number.MAX_VALUE)
    expect(dexp(-745)).toBe(5e-324)
  })

  it('dlog', () => {
    expect(dlog(Number.NaN)).toBeNaN()
    expect(dlog(-1)).toBeNaN()
    expect(dlog(Number.NEGATIVE_INFINITY)).toBeNaN()
    expect(dlog(0)).toBe(Number.NEGATIVE_INFINITY)
    expect(dlog(-0)).toBe(Number.NEGATIVE_INFINITY)
    expect(dlog(1)).toBe(0)
    expect(dlog(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(dlog(5e-324)).toBe(Math.log(5e-324))
  })

  it('datan2: zeros, infinities, and NaN as Math.atan2 has them', () => {
    const values = [Number.NaN, 0, -0, 1, -1, 2.5, -2.5, 1e-310, -1e-310, 1e300, -1e300]
    values.push(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)
    for (const y of values) {
      for (const x of values) {
        const want = Math.atan2(y, x)
        const got = datan2(y, x)
        if (!within(got, want, 3e-16)) throw new Error(`atan2(${y}, ${x}): ${got} vs ${want}`)
        // Signed zeros keep their sign.
        if (want === 0) expect(Object.is(got, want), `atan2(${y}, ${x})`).toBe(true)
      }
    }
    expect(datan2(0, -1)).toBe(Math.PI)
    expect(datan2(-0, -1)).toBe(-Math.PI)
    expect(datan2(1, 0)).toBe(Math.PI / 2)
  })

  it('dpow: JavaScript special cases', () => {
    const values = [Number.NaN, 0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3, 1e-310, 1e308]
    values.push(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)
    for (const x of values) {
      for (const y of values) {
        const want = mathPow(x, y)
        const got = dpow(x, y)
        if (!(Object.is(got, want) || within(got, want))) {
          throw new Error(`pow(${x}, ${y}): ${got} vs ${want}`)
        }
      }
    }
    expect(dpow(Number.NaN, 0)).toBe(1)
    expect(dpow(1, Number.POSITIVE_INFINITY)).toBeNaN()
    expect(dpow(-8, 1 / 3)).toBeNaN()
    expect(Object.is(dpow(-0, 3), -0)).toBe(true)
    expect(dpow(-0, -3)).toBe(Number.NEGATIVE_INFINITY)
  })

  it('dpow: exact integer powers, x^0, and square roots', () => {
    expect(dpow(2, 10)).toBe(1024)
    expect(dpow(2, -1074)).toBe(5e-324)
    expect(dpow(2, 1023)).toBe(2 ** 1023)
    expect(dpow(2, 1024)).toBe(Number.POSITIVE_INFINITY)
    expect(dpow(-2, 3)).toBe(-8)
    expect(dpow(10, 22)).toBe(1e22)
    expect(dpow(3, 33)).toBe(5559060566555523)
    expect(dpow(1.5, 4)).toBe(5.0625)
    expect(dpow(10, -3)).toBe(0.001)
    expect(dpow(7, -2)).toBe(1 / 49)
    const rnd = stream(10)
    for (let i = 0; i < 1000; i++) {
      const v = rnd() * 1e6
      expect(dpow(v, 0)).toBe(1)
      expect(dpow(v, 0.5)).toBe(Math.sqrt(v))
      expect(dpow(v, 1)).toBe(v)
      expect(dpow(v, 2)).toBe(v * v)
      const n = Math.floor(rnd() * 64)
      // Small integers to small powers are exact, so any correct pow agrees.
      if (n ** 3 < 2 ** 53) expect(dpow(n, 3)).toBe(n * n * n)
    }
  })
})

describe('pinned bits', () => {
  // Recorded outputs: a refactor that changes any bit changes every world generated from them.
  const one = (f: (x: number) => number) => (x: number) => f(x)
  const cases: [string, (a: number, b: number) => number, number, number, string][] = [
    ['dexp', one(dexp), 1, 0, '4005bf0a8b14576a'],
    ['dexp', one(dexp), -2.5, 0, '3fb50385c094f425'],
    ['dexp', one(dexp), 0.1, 0, '3ff1aec7b35a00d4'],
    ['dexp', one(dexp), 300.25, 0, '5b01fda3eaeb3d0e'],
    ['dexp', one(dexp), -740, 0, '0000000000000055'],
    ['dlog', one(dlog), 2, 0, '3fe62e42fefa39ef'],
    ['dlog', one(dlog), 0.3, 0, 'bff34378fcbda721'],
    ['dlog', one(dlog), 1e-310, 0, 'c0864e69394d9508'],
    ['dlog', one(dlog), 123456.789, 0, '40277281cad8a844'],
    ['datan2', datan2, 1, 2, '3fddac670561bb4f'],
    ['datan2', datan2, -3, -0.5, 'bffbc66e44cbc074'],
    ['datan2', datan2, 0.7, -0.001, '3ff927d54b3a71e4'],
    ['dpow', dpow, 1.7, 2.3, '400b1c0c46dcb4ea'],
    ['dpow', dpow, 0.3, -7.5, '40c04e140cf4ea7e'],
    ['dpow', dpow, 1.0000001, 1e7, '4005bf0a790ce6f2'],
    ['dpow', dpow, 10, -3, '3f50624dd2f1a9fc'],
    ['dsin', one(dsin), 1, 0, '3feaed548f090cee'],
    ['dcos', one(dcos), 100.5, 0, '3feffc12adaecec2'],
  ]
  for (const [name, f, a, b, want] of cases) {
    it(`${name}(${a}${name === 'datan2' || name === 'dpow' ? `, ${b}` : ''})`, () => {
      expect(hex(f(a, b))).toBe(want)
    })
  }
})
