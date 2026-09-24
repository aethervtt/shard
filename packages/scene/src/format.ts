import type { JsonValue } from '@shard/core'

/** A `*.scene.json` file. */
export interface SceneFile {
  $schema?: string
  version: number
  /** Scene-local assets, referenced as `{ "path": "#name" }`. */
  assets?: Record<string, SceneAsset>
  /** Resource values by registered name, merged into the world's resources on load. */
  resources?: Record<string, JsonValue>
  entities: SceneEntity[]
}

export type SceneAsset =
  | { type: 'Material'; value: Record<string, JsonValue> }
  | { type: 'Mesh'; procedural: string; params?: Record<string, number> }

export interface SceneEntity {
  /** Unique among siblings; joined with '/' into the entity's path. */
  name: string
  components?: Record<string, Record<string, JsonValue>>
  children?: SceneEntity[]
}

export const SCENE_VERSION = 1

/**
 * Changes to an instance's generated entities, keyed by path relative to the instance:
 * `{ "Exhaust": { "particles/ParticleSystem": { "timeScale": 2 } } }` sets fields (adding the
 * component if missing), `{ "Hull/Antenna": null }` removes an entity and its subtree, and
 * `{ "Exhaust/particles/ParticleEmitterOverrides": null }` removes one component.
 */
export type Overrides = Record<string, Record<string, Record<string, JsonValue> | null> | null>

/** A `*.prefab.json` file: one root entity, or a variant that extends another prefab. */
export interface PrefabFile {
  $schema?: string
  version: number
  /** Prefab-local assets, referenced as `{ "path": "#name" }`. */
  assets?: Record<string, SceneAsset>
  root?: SceneEntity
  /** Variants only: the base prefab. */
  extends?: { path?: string; guid?: string }
  /** Variants only: fields set on the base's root components (added if missing). */
  rootComponents?: Record<string, Record<string, JsonValue>>
  /** Variants only: overrides applied to the base's entities. */
  overrides?: Overrides
  /** Variants only: extra children under the root. */
  children?: SceneEntity[]
}

export const PREFAB_VERSION = 1
