import { mix32 } from '@aethervtt/shard-core'

// A 32-bit hash over words: FNV-1a per 32-bit word, then mix32. Numbers go in by their bits, so
// equal hashes mean bit-identical inputs (up to collisions), which is what determinism checks need.

const f64 = new Float64Array(1)
const f64Words = new Uint32Array(f64.buffer)

export class Hasher {
  h = 0x811c9dc5

  u32(v: number): this {
    this.h = Math.imul(this.h ^ (v >>> 0), 0x01000193)
    return this
  }

  /** A number by its f64 bits; -0 hashes as 0. */
  f64(v: number): this {
    f64[0] = v === 0 ? 0 : v
    return this.u32(f64Words[0]!).u32(f64Words[1]!)
  }

  bool(v: boolean): this {
    return this.u32(v ? 1 : 0)
  }

  /** Its length, then its UTF-16 units. */
  str(s: string): this {
    this.u32(s.length)
    for (let i = 0; i < s.length; i++) this.u32(s.charCodeAt(i))
    return this
  }

  /** Its length, then its elements' bits: f32 as words, 16-bit ones a word each. */
  array(a: Float32Array | Int16Array | Uint16Array): this {
    this.u32(a.length)
    if (a instanceof Float32Array) {
      const words = new Uint32Array(a.buffer, a.byteOffset, a.length)
      for (let i = 0; i < words.length; i++) this.u32(words[i]!)
      return this
    }
    for (let i = 0; i < a.length; i++) this.u32(a[i]! & 0xffff)
    return this
  }

  digest(): number {
    return mix32(this.h)
  }
}
