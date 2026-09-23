/** 32-bit FNV-1a, for turning fork labels into seeds. */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** splitmix32: spreads one seed into well-mixed state words. */
function splitmix32(state: { s: number }): number {
  state.s = (state.s + 0x9e3779b9) | 0
  let z = state.s
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
  return (z ^ (z >>> 16)) >>> 0
}

/**
 * Seeded random numbers (xoshiro128**: 32-bit operations only, fast in JS, good statistical
 * quality). Same seed, same sequence, on every platform.
 */
export class Rng {
  readonly seed: number
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed = 0) {
    this.seed = seed >>> 0
    const state = { s: this.seed }
    this.a = splitmix32(state)
    this.b = splitmix32(state)
    this.c = splitmix32(state)
    this.d = splitmix32(state)
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.b, 5), 7), 9) >>> 0
    const t = this.b << 9
    this.c ^= this.a
    this.d ^= this.b
    this.b ^= this.c
    this.a ^= this.d
    this.c ^= t
    this.d = rotl(this.d, 11)
    return result
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.nextU32() / 4294967296
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.float()
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1))
  }

  bool(probability = 0.5): boolean {
    return this.float() < probability
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.float() * items.length)]!
  }

  /** Standard normal sample (Box-Muller). */
  gaussian(mean = 0, stdDev = 1): number {
    const u = 1 - this.float()
    const v = this.float()
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  /**
   * An independent stream derived from this generator's seed and a label. It doesn't depend on how
   * many numbers this generator has produced, so adding draws elsewhere never changes a fork.
   */
  fork(label: string): Rng {
    return new Rng(Math.imul(this.seed ^ hashString(label), 0x9e3779b1) ^ hashString(`${label}#`))
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k))
}
