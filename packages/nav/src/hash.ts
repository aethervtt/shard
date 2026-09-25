/**
 * A streaming 64-bit hash (two independent 32-bit murmur3-style lanes) over 32-bit words, for
 * keying navmesh tiles by the exact geometry that built them. Not cryptographic.
 */
export class Hash64 {
  private a = 0x9747b28c
  private b = 0x85ebca6b
  private n = 0
  private readonly f32 = new Float32Array(1)
  private readonly u32 = new Uint32Array(this.f32.buffer)

  reset(seed = 0): this {
    this.a = (0x9747b28c ^ seed) >>> 0
    this.b = (0x85ebca6b ^ Math.imul(seed, 0x27d4eb2f)) >>> 0
    this.n = 0
    return this
  }

  u32word(v: number): this {
    let k = Math.imul(v >>> 0, 0xcc9e2d51)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, 0x1b873593)
    this.a ^= k
    this.a = (this.a << 13) | (this.a >>> 19)
    this.a = (Math.imul(this.a, 5) + 0xe6546b64) >>> 0
    let j = Math.imul(v >>> 0, 0x85ebca77)
    j = (j << 13) | (j >>> 19)
    j = Math.imul(j, 0xc2b2ae3d)
    this.b ^= j
    this.b = (this.b << 17) | (this.b >>> 15)
    this.b = (Math.imul(this.b, 3) + 0x52dce729) >>> 0
    this.n++
    return this
  }

  /** Hashes a float by its 32-bit representation (so 0.1 and 0.1f agree, -0 and 0 don't). */
  f32word(v: number): this {
    this.f32[0] = v
    return this.u32word(this.u32[0]!)
  }

  string(s: string): this {
    for (let i = 0; i < s.length; i++) this.u32word(s.charCodeAt(i))
    return this.u32word(s.length)
  }

  /** The finished hash as two 32-bit lanes. */
  lanes(out: Uint32Array, offset = 0): void {
    const a = fmix(this.a ^ this.n ^ (this.b >>> 7))
    out[offset] = a
    out[offset + 1] = fmix(this.b ^ this.n ^ (a >>> 11))
  }

  /** The hash as 16 hex digits. */
  hex(): string {
    this.lanes(LANES)
    return LANES[0]!.toString(16).padStart(8, '0') + LANES[1]!.toString(16).padStart(8, '0')
  }
}

const LANES = new Uint32Array(2)

function fmix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}
