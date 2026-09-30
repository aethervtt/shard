import type { AssetRef } from '@aethervtt/shard-core'
import { World } from '@aethervtt/shard-core'
import { MaterialAsset, Materials } from '@aethervtt/shard-render'
import { type Image, Textures } from '@aethervtt/shard-texture'
import { describe, expect, it } from 'vitest'
import { hostScene, PX_TO_WORLD, sceneMaterialValue } from './fixtures'

const HASH = (c: string) => `asset:${c.repeat(64)}`

interface Slot {
  texture: AssetRef<'Texture'>
  scale: [number, number]
  rotation: number
  wrap: string
}

/** The fields of a mapped material the tests read. */
interface Mapped {
  baseColor: number[]
  roughness: number
  metallic: number
  baseColorTexture: Slot
  normalTexture: Slot
  normalScale: number
  occlusionTexture: Slot
  occlusionStrength: number
  metallicRoughnessTexture: Slot
}

/** Aether's scene material test fixture, with every textured field. */
const stone = {
  id: 'stone',
  rev: 0,
  name: 'Cut stone',
  tint: '#ffffff',
  roughness: 0.82,
  metalness: 0.1,
  baseColorTexture: HASH('a'),
  repeat: { x: 70, y: 35 },
  rotation: 90,
  wrap: 'mirrored-repeat' as const,
  normal: { texture: HASH('e'), convention: 'opengl' as const, strength: 0.6 },
  roughnessTexture: HASH('b'),
  metalnessTexture: HASH('d'),
  ambientOcclusion: { texture: HASH('c'), strength: 1 },
}

function image(value: number): Image {
  const data = new Uint8Array(4 * 4 * 4)
  for (let i = 0; i < 16; i++) data.set([value, value, value, 255], i * 4)
  return { width: 4, height: 4, kind: 'u8', data }
}

describe("Aether's scene materials", () => {
  it('map onto StandardMaterial: tint, textures, repeat, rotation, wrap, strengths', () => {
    const made: string[] = []
    const texture = (ref: string, usage: string) => {
      made.push(`${usage}:${ref.slice(6, 7)}`)
      return { type: 'Texture', guid: ref, path: undefined } as AssetRef<'Texture'>
    }
    const packed = { type: 'Texture', guid: 'packed', path: undefined } as AssetRef<'Texture'>
    const v = sceneMaterialValue(stone, PX_TO_WORLD, texture, packed) as unknown as Mapped
    expect(v.baseColor).toEqual([1, 1, 1, 1])
    expect(v.roughness).toBe(0.82)
    expect(v.metallic).toBe(0.1)
    // One tile covers `repeat` pixels of the scene: scale × repeat × pxToWorld is one tile.
    expect(v.baseColorTexture.scale[0] * 70 * PX_TO_WORLD).toBeCloseTo(1, 12)
    expect(v.baseColorTexture.scale[1] * 35 * PX_TO_WORLD).toBeCloseTo(1, 12)
    expect(v.baseColorTexture.rotation).toBeCloseTo(Math.PI / 2, 12)
    expect(v.baseColorTexture.wrap).toBe('mirror')
    expect(v.normalTexture.texture.guid).toBe(HASH('e'))
    expect(v.normalScale).toBe(0.6)
    expect(v.occlusionTexture.texture.guid).toBe(HASH('c'))
    expect(v.occlusionStrength).toBe(1)
    expect(v.metallicRoughnessTexture.texture).toBe(packed)
    expect(made.sort()).toEqual(['color:a', 'data:c', 'normal:e'])
    // It's a valid standard material value.
    expect(() => new MaterialAsset(v as unknown as Record<string, unknown>)).not.toThrow()
  })

  it('resolve through a host adapter: images become textures, roughness and metalness pack', () => {
    const world = new World()
    world.initResource(Materials)
    world.initResource(Textures)
    const images: Record<string, Image> = {
      [HASH('a')]: image(200),
      [HASH('b')]: image(128),
      [HASH('c')]: image(255),
      [HASH('d')]: image(64),
      [HASH('e')]: image(128),
    }
    const host = hostScene(world, PX_TO_WORLD, (ref) => images[ref])
    host.materials.sync([stone])
    const textures = world.resource(Textures)
    const material = [...world.resource(Materials).values()].find(
      (m) => (m.value as Record<string, unknown>).normalScale === 0.6,
    )!
    const value = material.value as unknown as Mapped
    const mr = textures.get(value.metallicRoughnessTexture.texture)!
    // G roughness, B metalness, from each map's red channel.
    expect([...mr.levels![0]!.slice(0, 4)]).toEqual([0, 128, 64, 255])
    expect(textures.get(value.baseColorTexture.texture)!.usage).toBe('color')
    expect(textures.get(value.normalTexture.texture)!.usage).toBe('normal')
  })
})
