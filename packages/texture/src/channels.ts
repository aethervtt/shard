import { ShardError } from '@aethervtt/shard-core'
import { resizeImage } from './array'
import type { Image } from './image'
import { Texture } from './texture'

/**
 * Packs separate roughness and metalness images into one `metallicRoughnessTexture` (0066): G is
 * roughness, B is metalness, as glTF has it. Each input's red channel is its value (grayscale
 * maps). A missing map packs as 1, so the material's own roughness and metallic factors apply
 * unchanged. Maps of different sizes are resized to the larger one.
 */
export function packMetallicRoughness(roughness?: Image, metalness?: Image): Texture {
  if (!roughness && !metalness) {
    throw new ShardError(
      'texture/nothing-to-pack',
      'packMetallicRoughness needs a roughness or a metalness map',
      {
        hint: 'Without either, leave metallicRoughnessTexture empty: the scalar factors apply.',
      },
    )
  }
  for (const image of [roughness, metalness]) {
    if (image && image.kind !== 'u8') {
      throw new ShardError(
        'texture/wrong-kind',
        'Roughness and metalness maps must be 8-bit images',
        {
          hint: 'Decode them as RGBA8 (kind "u8").',
        },
      )
    }
  }
  const width = Math.max(roughness?.width ?? 0, metalness?.width ?? 0)
  const height = Math.max(roughness?.height ?? 0, metalness?.height ?? 0)
  const r = roughness ? resizeImage(roughness, width, height).data : undefined
  const m = metalness ? resizeImage(metalness, width, height).data : undefined
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = 0
    out[i * 4 + 1] = r ? r[i * 4]! : 255
    out[i * 4 + 2] = m ? m[i * 4]! : 255
    out[i * 4 + 3] = 255
  }
  return Texture.create({ width, height, usage: 'data', mips: [out], mipmaps: true })
}
