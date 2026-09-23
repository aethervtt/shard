import { AssetStore, defineAssetType, defineDataAsset } from '@shard/assets'
import { defineComponent, defineResource, type Infer, t } from '@shard/core'
import { decodeMesh, type Mesh } from '@shard/mesh'
import type { RenderTarget } from './target'

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

export const StandardMaterial = defineComponent(
  'render/StandardMaterial',
  {
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
    alphaMode: t.enum(['opaque', 'mask'], {
      description: 'opaque ignores alpha; mask discards pixels with alpha below alphaCutoff.',
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
  },
  { description: 'The standard PBR material (GGX). A material asset, not an entity component.' },
)

export type StandardMaterialValue = Infer<typeof StandardMaterial>

/** A material with a version, so GPU copies know when to re-upload. */
export class MaterialAsset {
  value: StandardMaterialValue
  version = 0

  constructor(value: Partial<StandardMaterialValue> = {}) {
    this.value = withSlotDefaults({ ...StandardMaterial.defaults(), ...value })
  }

  set(value: Partial<StandardMaterialValue>): void {
    this.value = withSlotDefaults({ ...this.value, ...value })
    this.version++
  }
}

/** Texture slots given partially in code (just `{ texture }`) get the rest of their defaults. */
function withSlotDefaults(value: StandardMaterialValue): StandardMaterialValue {
  const defaults = StandardMaterial.defaults() as unknown as Record<string, object>
  const out = value as unknown as Record<string, object>
  for (const slot of TEXTURE_SLOTS) out[slot] = { ...defaults[slot], ...out[slot] }
  return value
}

export const Meshes = defineResource<AssetStore<Mesh, 'Mesh'>>('render/Meshes', {
  description: 'Loaded meshes by guid.',
  init: () => new AssetStore('Mesh'),
})

export const Materials = defineResource<AssetStore<MaterialAsset, 'Material'>>('render/Materials', {
  description: 'Loaded standard materials by guid.',
  init: () => new AssetStore('Material'),
})

export const RenderTargets = defineResource<AssetStore<RenderTarget, 'RenderTarget'>>(
  'render/RenderTargets',
  {
    description: 'Offscreen render targets cameras can render into.',
    init: () => new AssetStore('RenderTarget'),
  },
)

/** Meshes load from binary artifacts (`encodeMesh`); a reload updates the mesh in place. */
export const MeshAsset = defineAssetType<Mesh>('Mesh', {
  store: Meshes,
  load: (artifact) => decodeMesh(artifact.bytes!),
  update: (existing, next) => existing.update(next.data()),
})

/** Materials load from StandardMaterial JSON; a reload bumps the material's version. */
export const MaterialAssetType = defineAssetType<MaterialAsset>('Material', {
  store: Materials,
  // Texture paths resolve to guids here, so the renderer can look them up directly.
  load: (artifact, ctx) =>
    new MaterialAsset(
      StandardMaterial.deserialize(artifact.json, {
        resolveAsset: (ref) => {
          const found = ref.path
            ? ctx.resolve(ref.path)
            : ref.guid
              ? ctx.resolve(ref.guid)
              : undefined
          return found
            ? { guid: found.guid!, path: ref.path ?? found.path!, type: found.type }
            : undefined
        },
      }),
    ),
  update: (existing, next) => existing.set(next.value),
})

/** `*.material.json` files: a StandardMaterial as a data asset. */
export const MaterialImporter = defineDataAsset('Material', StandardMaterial, {
  extension: 'material',
})

export { AssetStore }
