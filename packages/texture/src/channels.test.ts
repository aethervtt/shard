import { describe, expect, it } from 'vitest'
import { packMetallicRoughness } from './channels'
import type { Image } from './image'

function gray(width: number, height: number, value: number): Image {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set([value, value, value, 255], i * 4)
  return { width, height, kind: 'u8', data }
}

describe('packMetallicRoughness', () => {
  it('puts roughness in G and metalness in B', () => {
    const t = packMetallicRoughness(gray(4, 4, 200), gray(4, 4, 30))
    expect(t.usage).toBe('data')
    expect([...t.levels![0]!.slice(0, 4)]).toEqual([0, 200, 30, 255])
    // Mipmapped: a sampler at a distance reads the same averages.
    expect(t.levels!.length).toBeGreaterThan(1)
  })

  it('packs a missing map as 1, so the scalar factor applies unchanged', () => {
    expect([...packMetallicRoughness(gray(2, 2, 90)).levels![0]!.slice(0, 4)]).toEqual([
      0, 90, 255, 255,
    ])
    expect([...packMetallicRoughness(undefined, gray(2, 2, 17)).levels![0]!.slice(0, 4)]).toEqual([
      0, 255, 17, 255,
    ])
  })

  it('resizes maps of different sizes to the larger, and needs at least one map', () => {
    const t = packMetallicRoughness(gray(8, 8, 100), gray(2, 2, 50))
    expect([t.width, t.height]).toEqual([8, 8])
    expect(t.levels![0]![6]).toBe(50)
    expect(() => packMetallicRoughness()).toThrow(
      expect.objectContaining({ code: 'texture/nothing-to-pack' }),
    )
  })
})
