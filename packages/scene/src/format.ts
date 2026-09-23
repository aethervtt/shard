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
