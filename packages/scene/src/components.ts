import { AssetStore, defineAssetType } from '@shard/assets'
import { defineComponent, defineResource, type Entity, type JsonValue, t } from '@shard/core'
import type { PrefabFile, SceneEntity, SceneFile } from './format'

/** Marks entities that came from a scene file. */
export const SceneMember = defineComponent(
  'scene/SceneMember',
  {
    scene: t.string({ description: 'Id of the scene this entity was loaded from.' }),
    path: t.string({ description: 'Path within the scene, e.g. "ship/camera".' }),
  },
  { description: 'Set by the scene loader.', serialize: false },
)

export interface LoadedScene {
  id: string
  file: SceneFile
  /** Paths in file order (depth-first), and their entities. */
  order: string[]
  entities: Map<string, Entity>
  authored: Map<Entity, SceneEntity>
  /** Serialized component values right after load, to tell which fields changed since. */
  loaded: Map<Entity, Map<string, Record<string, JsonValue>>>
  loadedResources: Map<string, JsonValue>
  /** Guids of every asset the scene referenced, requested at load. */
  assets: Set<string>
}

export const SceneIndex = defineResource<Map<string, LoadedScene>>('scene/Index', {
  description: 'Loaded scenes: paths, entities, and what was authored.',
  init: () => new Map(),
})

// --- scene assets --------------------------------------------------------------------------------

/** Scene files loaded as assets (a glTF's node tree), by guid. */
export const SceneAssets = defineResource<AssetStore<SceneFile, 'Scene'>>('scene/SceneAssets', {
  description: 'Scene assets (node trees) by guid.',
  init: () => new AssetStore('Scene'),
})

/**
 * Scene assets. References inside them written as `#Label` point at sibling sub-assets of the same
 * source; they're resolved against the source's current path at load, so moving the file is safe.
 */
export const SceneAssetType = defineAssetType<SceneFile>('Scene', {
  store: SceneAssets,
  load: (artifact, ctx) => {
    const base = ctx.path.split('#')[0]!
    const resolve = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolve)
      if (!value || typeof value !== 'object') return value
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        out[k] =
          k === 'path' && typeof v === 'string' && v.startsWith('#') ? `${base}${v}` : resolve(v)
      }
      return out
    }
    return resolve(artifact.json) as SceneFile
  },
})

/** Prefabs by guid: the resolved tree (variants already flattened onto their base). */
export const PrefabAssets = defineResource<AssetStore<PrefabFile, 'Prefab'>>('scene/PrefabAssets', {
  description: 'Prefab assets (resolved entity trees) by guid.',
  init: () => new AssetStore('Prefab'),
})

export const PrefabAssetType = defineAssetType<PrefabFile>('Prefab', {
  store: PrefabAssets,
  load: (artifact) => artifact.json as unknown as PrefabFile,
})

// --- instances -----------------------------------------------------------------------------------

const overridesField = () =>
  t.json({
    default: {},
    description:
      'Changes to generated entities by path relative to this entity: { "Exhaust": { "particles/ParticleSystem": { "timeScale": 2 } } } sets fields, { "Hull/Antenna": null } removes an entity, { "Exhaust/particles/ParticleEmitterOverrides": null } removes a component. Paths reach into nested instances.',
  })

/** Places a scene asset (e.g. `assets/ship.glb#Scene`) as generated children of this entity. */
export const SceneInstance = defineComponent(
  'scene/SceneInstance',
  {
    scene: t.handle('Scene', {
      description: 'The scene to place, e.g. { "path": "assets/ship.glb#Scene" }.',
    }),
    overrides: overridesField(),
  },
  {
    description:
      "Spawns a scene asset (a model's node tree) as children, addressable by path (ship/Hull). The children are generated: saving writes only this entity and its overrides, and they respawn when the asset changes.",
  },
)

/** Makes this entity an instance of a prefab: the prefab root's components and children. */
export const PrefabInstance = defineComponent(
  'scene/PrefabInstance',
  {
    prefab: t.handle('Prefab', {
      description: 'The prefab to place, e.g. { "path": "prefabs/ship.prefab.json" }.',
    }),
    overrides: overridesField(),
  },
  {
    description:
      "Makes this entity an instance of a prefab. The prefab root's components merge into it (fields the entity sets win) and the root's children spawn under it, addressable by path (player-ship/Exhaust). Changes to the children are saved as overrides.",
  },
)

/** Marks entities an instance generated (they're rebuilt from the prefab or model, never saved). */
export const InstancePart = defineComponent(
  'scene/InstancePart',
  {
    instance: t.entity({ description: 'The instance entity that generated this one.' }),
    path: t.string({ description: 'Path relative to the instance, e.g. "Hull/Cockpit".' }),
  },
  { description: 'Set on entities a SceneInstance or PrefabInstance spawned.', serialize: false },
)
