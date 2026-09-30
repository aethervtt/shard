import { AssetStore, defineAssetType, defineImporter } from '@aethervtt/shard-assets'
import {
  defineComponent,
  defineResource,
  defineSchema,
  type Infer,
  type SchemaContext,
  ShardError,
} from '@aethervtt/shard-core'
import { bevelBox, decodeMesh, type Mesh } from '@aethervtt/shard-mesh'
import {
  allMaterialTypes,
  findMaterialType,
  type MaterialType,
  registerStandardType,
} from './materials'
import { STANDARD_FIELDS, TEXTURE_SLOTS, TextureSlot } from './standard-fields'
import type { RenderTarget } from './target'

export { STANDARD_FIELDS, TEXTURE_SLOTS, TextureSlot }

export const StandardMaterial = defineComponent('render/StandardMaterial', STANDARD_FIELDS, {
  description: 'The standard PBR material (GGX). A material asset, not an entity component.',
})

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
  fallback: () => missingMesh(),
  cost: (mesh) => ({ triangles: Math.floor(mesh.drawCount / 3), bytes: meshBytes(mesh) }),
})

/** What a mesh that failed to load shows (0061): a 1 m beveled box, drawn with the missing material. */
export function missingMesh(): Mesh {
  const mesh = bevelBox({ x: 1, y: 1, z: 1 })
  mesh.missing = true
  return mesh
}

/** CPU bytes of a mesh's vertex and index data: about what its GPU copy takes. */
function meshBytes(mesh: Mesh): number {
  let bytes = mesh.positions.byteLength + (mesh.indices?.byteLength ?? 0)
  for (const a of [mesh.normals, mesh.uvs, mesh.uvs1, mesh.tangents]) bytes += a?.byteLength ?? 0
  return bytes
}

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
      const color = readableBaseColor(artifact.json)
      if (color) readableColors.set(ctx.guid, color)
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
  references: (material) => handlesIn(material.value),
  // A material that failed to load draws as the standard one, in its own base color if readable.
  fallback: ({ guid }) => {
    const baseColor = readableColors.get(guid)
    readableColors.delete(guid)
    return new MaterialAsset(baseColor ? { baseColor } : {})
  },
})

/** Asset refs (`{ guid }` objects) anywhere in a material's values: its textures. */
function* handlesIn(value: unknown): Generator<{ guid?: string }> {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return
  if (Array.isArray(value)) {
    for (const v of value) yield* handlesIn(v)
    return
  }
  if (typeof (value as { guid?: unknown }).guid === 'string') yield value as { guid: string }
  for (const v of Object.values(value)) yield* handlesIn(v)
}

/** Base colors read from materials that failed to load, for their fallbacks (0061). */
const readableColors = new Map<string, number[]>()

function readableBaseColor(json: unknown): number[] | undefined {
  const raw = (json as { baseColor?: unknown } | null)?.baseColor
  if (raw === undefined) return undefined
  try {
    return [...StandardMaterial.deserialize({ baseColor: raw }).baseColor]
  } catch {
    return undefined
  }
}

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
