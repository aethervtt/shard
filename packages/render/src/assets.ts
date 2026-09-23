import {
  type AssetRef,
  defineComponent,
  defineResource,
  type Infer,
  ShardError,
  t,
} from '@shard/core'
import type { Mesh } from '@shard/mesh'
import type { RenderTarget } from './target'

/**
 * In-memory assets addressed by `AssetRef`, until the asset database (M4) backs the same refs with
 * files. GUIDs are runtime-generated (`mem:<type>:<n>`); an optional name becomes the ref's path.
 */
export class AssetStore<T, K extends string> {
  readonly type: K
  private readonly items = new Map<string, T>()
  private next = 0

  constructor(type: K) {
    this.type = type
  }

  add(item: T, name?: string): AssetRef<K> {
    const guid = `mem:${this.type.toLowerCase()}:${this.next++}`
    this.items.set(guid, item)
    return { type: this.type, guid, path: name }
  }

  /** The asset for a ref, or undefined. Hot path: a map lookup by guid, no allocation. */
  get(ref: AssetRef<K> | null | undefined): T | undefined {
    return ref?.guid === undefined ? undefined : this.items.get(ref.guid)
  }

  require(ref: AssetRef<K> | null | undefined): T {
    const item = this.get(ref)
    if (!item) {
      throw new ShardError(
        'render/missing-asset',
        `No ${this.type} asset for ${JSON.stringify(ref)}`,
        {
          hint: `Add it with the ${this.type} store first; the ref's guid must match.`,
        },
      )
    }
    return item
  }

  get size(): number {
    return this.items.size
  }
}

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
  },
  { description: 'The standard PBR material (GGX). A material asset, not an entity component.' },
)

export type StandardMaterialValue = Infer<typeof StandardMaterial>

/** A material with a version, so GPU copies know when to re-upload. */
export class MaterialAsset {
  value: StandardMaterialValue
  version = 0

  constructor(value: Partial<StandardMaterialValue> = {}) {
    this.value = { ...StandardMaterial.defaults(), ...value }
  }

  set(value: Partial<StandardMaterialValue>): void {
    this.value = { ...this.value, ...value }
    this.version++
  }
}

export const Meshes = defineResource<AssetStore<Mesh, 'Mesh'>>('render/Meshes', {
  description: 'In-memory meshes by AssetRef.',
  init: () => new AssetStore('Mesh'),
})

export const Materials = defineResource<AssetStore<MaterialAsset, 'Material'>>('render/Materials', {
  description: 'In-memory standard materials by AssetRef.',
  init: () => new AssetStore('Material'),
})

export const RenderTargets = defineResource<AssetStore<RenderTarget, 'RenderTarget'>>(
  'render/RenderTargets',
  {
    description: 'Offscreen render targets cameras can render into.',
    init: () => new AssetStore('RenderTarget'),
  },
)
