import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { codeLengths, deflate, inflate } from './deflate.js'

function samples(): Uint8Array[] {
  const out: Uint8Array[] = [new Uint8Array(0), new Uint8Array([7]), new Uint8Array(5000)]
  let s = 12345
  const rand = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return s >>> 16
  }
  const noise = new Uint8Array(20000)
  for (let i = 0; i < noise.length; i++) noise[i] = rand() & 0xff
  out.push(noise)
  // Smooth terrain-like rows: small deltas, long repeats.
  const smooth = new Uint8Array(67 * 67 * 2)
  let h = 30000
  for (let i = 0; i < smooth.length / 2; i++) {
    h += (rand() % 7) - 3
    smooth[i * 2] = h & 0xff
    smooth[i * 2 + 1] = h >> 8
  }
  out.push(smooth)
  const text = new TextEncoder().encode(
    'the road that flattens the ground also paints the gravel '.repeat(400),
  )
  out.push(text)
  return out
}

describe('deflate (0071 packs)', () => {
  it('round-trips, and zlib inflates what it writes', () => {
    for (const input of samples()) {
      const packed = deflate(input)
      expect(inflate(packed, input.length)).toEqual(input)
      expect(new Uint8Array(inflateRawSync(packed))).toEqual(input)
    }
  })

  it('compresses repetitive data and gives the same bytes every time', () => {
    const text = samples()[5]!
    const a = deflate(text)
    expect(a.length).toBeLessThan(text.length / 20)
    expect(deflate(text)).toEqual(a)
  })

  it('limits code lengths and keeps the Kraft sum at one', () => {
    // Fibonacci frequencies make Huffman codes as long as there are symbols.
    const f: number[] = [1, 1]
    while (f.length < 40) f.push(f[f.length - 1]! + f[f.length - 2]!)
    const lengths = codeLengths(f, 15)
    let kraft = 0
    for (const l of lengths) {
      expect(l).toBeGreaterThan(0)
      expect(l).toBeLessThanOrEqual(15)
      kraft += 2 ** -l
    }
    expect(kraft).toBe(1)
  })

  it('rejects a damaged stream with terrain/corrupt-pack', () => {
    const packed = deflate(samples()[4]!)
    expect(() => inflate(packed.subarray(0, packed.length >> 1), samples()[4]!.length)).toThrow(
      expect.objectContaining({ code: 'terrain/corrupt-pack' }),
    )
  })
})
