import { describe, expect, it } from 'vitest'
import { compareImages, deltaE2000, type RgbaImage } from './compare'

/** A 256×160 table: felt, grid lines every 16 px starting at `gridOffset`, and a token's shadow. */
function table(options: { gridOffset?: number; shadow?: boolean; alpha?: number } = {}): RgbaImage {
  const width = 256
  const height = 160
  const data = new Uint8Array(width * height * 4)
  const offset = options.gridOffset ?? 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      let r = 58
      let g = 92
      let b = 64
      if ((x - offset) % 16 === 0 || (y - offset) % 16 === 0) {
        r = 30
        g = 46
        b = 34
      }
      const dx = (x - 150) / 26
      const dy = (y - 90) / 12
      if (options.shadow !== false && dx * dx + dy * dy < 1) {
        r *= 0.55
        g *= 0.55
        b *= 0.55
      }
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = options.alpha ?? 255
    }
  }
  return { width, height, data }
}

/** The same image with each channel nudged by up to ±`amount` levels: another dither pattern. */
function redither(image: RgbaImage, amount = 1, seed = 7): RgbaImage {
  let state = seed
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const data = new Uint8Array(image.data)
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue
    const nudge = Math.round((random() * 2 - 1) * amount)
    data[i] = Math.max(0, Math.min(255, data[i]! + nudge))
  }
  return { ...image, data }
}

describe('deltaE2000', () => {
  // Pairs from Sharma, Wu and Dalal's CIEDE2000 test data.
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ])('%j vs %j is %f', (a, b, expected) => {
    expect(deltaE2000(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!)).toBeCloseTo(expected as number, 4)
  })
})

describe('compareImages (0062)', () => {
  it('passes an identical frame dithered differently', () => {
    const diff = compareImages(table(), redither(table()))
    expect(diff.pass).toBe(true)
    expect(diff.changed).toBe(0)
    expect(diff.maxDeltaE).toBeLessThan(2.3)
    expect(diff.ssim).toBeGreaterThan(0.99)
  })

  it('flags a grid shifted by one pixel', () => {
    const diff = compareImages(table(), table({ gridOffset: 1 }))
    expect(diff.pass).toBe(false)
    expect(diff.share).toBeGreaterThan(0.05)
    expect(diff.reason).toMatch(/of pixels changed/)
  })

  it('flags a missing shadow', () => {
    const diff = compareImages(table(), redither(table({ shadow: false })))
    expect(diff.pass).toBe(false)
    expect(diff.changed).toBeGreaterThan(500)
    expect(diff.maxDeltaE).toBeGreaterThan(10)
  })

  it('counts alpha: a transparent surface turning more opaque is a change', () => {
    const diff = compareImages(table({ alpha: 0 }), table({ alpha: 200 }))
    expect(diff.pass).toBe(false)
    expect(diff.share).toBe(1)
  })

  it('takes tolerance from the plan', () => {
    const shifted = table({ gridOffset: 1 })
    expect(compareImages(table(), shifted, { maxShare: 0.5, minSsim: 0 }).pass).toBe(true)
  })

  it('refuses images of different sizes', () => {
    const small = { width: 2, height: 2, data: new Uint8Array(16) }
    expect(() => compareImages(table(), small)).toThrow(
      expect.objectContaining({ code: 'verify/size-mismatch' }),
    )
  })
})
