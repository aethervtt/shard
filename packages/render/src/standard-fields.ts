import { t } from '@aethervtt/shard-core'

// The standard material's fields, in their own module so every material type that extends
// `standard` (materials.ts) imports them directly: no registration order to get right.

/** A texture on a material slot, with the UV set, transform (KHR_texture_transform), and sampler. */
function textureSlot(description: string) {
  return t.struct(
    {
      texture: t.handle('Texture', {
        description: 'The texture, e.g. { "path": "assets/rock.png" }.',
      }),
      uv: t.u8({ max: 1, description: 'UV set: 0 or 1.' }),
      offset: t.vec2({ description: 'UV offset.' }),
      scale: t.vec2({ default: [1, 1], description: 'UV scale.' }),
      rotation: t.f32({ unit: 'rad', description: 'UV rotation.' }),
      wrap: t.enum(['repeat', 'clamp', 'mirror'], { description: 'Addressing outside [0, 1].' }),
      filter: t.enum(['linear', 'nearest'], { description: 'Texel filtering.' }),
    },
    { description },
  )
}

export const TextureSlot = textureSlot(
  'A texture slot: which texture, which UVs, and how to sample it.',
)

export const TEXTURE_SLOTS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
] as const

export const STANDARD_FIELDS = {
  baseColor: t.color({
    default: [0.8, 0.8, 0.8, 1],
    description: 'Albedo (linear), alpha in w.',
  }),
  metallic: t.f32({ min: 0, max: 1, description: '0 for dielectrics, 1 for metals.' }),
  roughness: t.f32({ default: 0.5, min: 0, max: 1, description: 'Microsurface roughness.' }),
  emissive: t.color({
    default: [1, 1, 1, 1],
    description: 'Emitted color (linear), scaled by emissiveLuminance.',
  }),
  emissiveLuminance: t.f32({
    min: 0,
    unit: 'cd/m²',
    description: 'Emitted luminance. 0 = not emissive.',
  }),
  doubleSided: t.bool({ description: 'Draw back faces too (no culling).' }),
  alphaMode: t.enum(['opaque', 'mask', 'alpha', 'additive', 'premultiplied'], {
    description:
      'opaque ignores alpha; mask discards pixels below alphaCutoff; alpha blends (transparent, drawn after opaque, sorted back to front); additive adds light (glows); premultiplied expects color already multiplied by alpha.',
  }),
  alphaCutoff: t.f32({
    default: 0.5,
    min: 0,
    max: 1,
    description: 'Alpha threshold for alphaMode "mask".',
  }),
  normalScale: t.f32({ default: 1, description: 'Strength of the normal map.' }),
  occlusionStrength: t.f32({
    default: 1,
    min: 0,
    max: 1,
    description: 'Strength of the occlusion map.',
  }),
  baseColorTexture: textureSlot('Albedo (sRGB), multiplied with baseColor.'),
  metallicRoughnessTexture: textureSlot(
    'G = roughness, B = metallic (linear), multiplied with the factors.',
  ),
  normalTexture: textureSlot('Tangent-space normal map.'),
  occlusionTexture: textureSlot('Ambient occlusion in R (linear).'),
  emissiveTexture: textureSlot('Emission color (sRGB), multiplied with emissive.'),
}
