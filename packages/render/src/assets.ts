import { AssetStore, defineAssetType, defineImporter } from '@aethervtt/shard-assets'
import {
  defineComponent,
  defineResource,
  defineSchema,
  type Infer,
  type SchemaContext,
  ShardError,
  t,
} from '@aethervtt/shard-core'
import { decodeMesh, type Mesh } from '@aethervtt/shard-mesh'
import {
  allMaterialTypes,
  findMaterialType,
  type MaterialType,
  registerStandardType,
  setStandardFields,
} from './materials'
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

const STANDARD_FIELDS = {
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

export const StandardMaterial = defineComponent('render/StandardMaterial', STANDARD_FIELDS, {
  description: 'The standard PBR material (GGX). A material asset, not an entity component.',
})

setStandardFields(STANDARD_FIELDS)
/** The material type of plain StandardMaterial assets. */
export const STANDARD_TYPE = registerStandardType(StandardMaterial)

export type StandardMaterialValue = Infer<typeof StandardMaterial>

/** Any material's value: the standard fields (for standard extensions) plus the type's own. */
export type MaterialValue = StandardMaterialValue & Record<string, unknown>

/**
 * A material: its type and its values, with a version so GPU copies know when to re-upload. When the
 * type is redefined (hot reload), `sync` migrates the values: new fields get their defaults.
 */
export class MaterialAsset {
  type: MaterialType
  value: MaterialValue
  version = 0
  private typeVersion: number

  constructor(value: Record<string, unknown> = {}, type: MaterialType = STANDARD_TYPE) {
    this.type = type
    this.typeVersion = type.version
    this.value = normalize(type, { ...type.schema.defaults(), ...value })
  }

  set(value: Record<string, unknown>): void {
    this.value = normalize(this.type, { ...this.value, ...value })
    this.version++
  }

  /** Migrates to the current definition of the type. Returns true if anything changed. */
  sync(): boolean {
    if (this.typeVersion === this.type.version) return false
    this.typeVersion = this.type.version
    const defaults = this.type.schema.defaults() as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(defaults))
      next[key] = key in this.value ? this.value[key] : defaults[key]
    this.value = normalize(this.type, next)
    this.version++
    return true
  }
}

function normalize(type: MaterialType, value: Record<string, unknown>): MaterialValue {
  return (type.standard ? withSlotDefaults(value as StandardMaterialValue) : value) as MaterialValue
}

/** The type a material JSON names (`"type"`), defaulting to the standard material. */
export function materialTypeOf(json: unknown): MaterialType {
  const name =
    json && typeof json === 'object' && typeof (json as { type?: unknown }).type === 'string'
      ? (json as { type: string }).type
      : undefined
  if (!name || name === 'render/StandardMaterial') return STANDARD_TYPE
  const type = findMaterialType(name)
  if (!type) {
    throw new ShardError('render/unknown-material-type', `Unknown material type "${name}"`, {
      path: '/type',
      hint: `Material types: ${allMaterialTypes()
        .map((t) => t.name)
        .join(', ')}. Project types are defined with project.material(...).`,
    })
  }
  return type
}

/** Material JSON without its `"type"` key (what the type's schema validates). */
export function materialFields(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object') return {}
  const { type: _, $schema: __, ...rest } = json as Record<string, unknown>
  return rest
}

/** Validates material JSON against its type's schema; errors point into the JSON. */
export function validateMaterial(json: unknown, ctx?: SchemaContext): ShardError[] {
  let type: MaterialType
  try {
    type = materialTypeOf(json)
  } catch (err) {
    return [err as ShardError]
  }
  return type.schema.validate(materialFields(json), ctx)
}

/** A MaterialAsset from material JSON (files, scene inline assets, glTF). */
export function materialFromJson(json: unknown, ctx?: SchemaContext): MaterialAsset {
  const type = materialTypeOf(json)
  return new MaterialAsset(
    type.schema.deserialize(materialFields(json), ctx) as Record<string, unknown>,
    type,
  )
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

/** Materials load from material JSON (any type); a reload bumps the material's version. */
export const MaterialAssetType = defineAssetType<MaterialAsset>('Material', {
  store: Materials,
  // Texture paths resolve to guids here, so the renderer can look them up directly.
  load: (artifact, ctx) => {
    const resolveAsset = (ref: { guid?: string; path?: string }) => {
      const found = ref.path ? ctx.resolve(ref.path) : ref.guid ? ctx.resolve(ref.guid) : undefined
      return found
        ? { guid: found.guid!, path: ref.path ?? found.path!, type: found.type }
        : undefined
    }
    const errors = validateMaterial(artifact.json, { resolveAsset })
    if (errors.length > 0) {
      const first = errors[0]!
      throw new ShardError('assets/load-failed', `${ctx.path}: ${first.message}`, {
        path: first.path,
        hint: first.hint,
        details: errors,
      })
    }
    return materialFromJson(artifact.json, { resolveAsset })
  },
  update: (existing, next) => {
    existing.type = next.type
    existing.set(next.value)
  },
})

/**
 * `*.material.json` files. `"type"` names the material type (default: render/StandardMaterial);
 * the rest is validated by that type's schema, with errors pointing into the file.
 */
export const MaterialImporter = defineImporter({
  name: 'data/material',
  version: 2,
  extensions: ['.material.json'],
  settings: defineSchema('render/MaterialImportSettings', {}, { description: 'No settings.' }),
  async import(source, ctx) {
    let json: unknown
    try {
      json = JSON.parse(source.text())
    } catch (cause) {
      throw new ShardError('assets/import-failed', `${source.path} isn't valid JSON`, {
        path: source.path,
        cause,
      })
    }
    const typeName = (json as { type?: unknown })?.type
    const known = typeof typeName !== 'string' || findMaterialType(typeName) !== undefined
    let normalized: unknown = json
    if (known) {
      const errors = validateMaterial(json)
      if (errors.length > 0) {
        const first = errors[0]!
        throw new ShardError(
          'assets/import-failed',
          `${source.path}: ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`,
          { path: first.path, hint: first.hint, details: errors },
        )
      }
      const type = materialTypeOf(json)
      const fields = type.schema.serialize(type.schema.deserialize(materialFields(json)))
      normalized = type === STANDARD_TYPE ? fields : { type: type.name, ...(fields as object) }
    } else {
      // A project type the importer can't see (its code isn't loaded here): the runtime validates.
      ctx.warn(
        `Material type "${typeName}" isn't defined here; it's checked when the game loads it.`,
        '/type',
      )
      normalized = materialFields(json)
      normalized = { type: typeName, ...(normalized as object) }
    }
    const dependencies = new Set<string>()
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (k === 'path' && typeof v === 'string' && !v.startsWith('procedural:'))
            dependencies.add(v)
          else collect(v)
        }
      }
    }
    collect(normalized)
    return {
      assets: [
        {
          label: '',
          type: 'Material',
          json: normalized as never,
          ...(dependencies.size ? { dependencies: [...dependencies] } : {}),
        },
      ],
    }
  },
})

export { AssetStore }
