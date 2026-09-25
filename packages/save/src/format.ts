import type { JsonSchema, JsonValue } from '@shard/core'
import type { Overrides } from '@shard/scene'

/** A saved game (`saves/<slot>.json` in platform storage). */
export interface SaveFile {
  $schema?: string
  version: number
  /** The engine version range that wrote it (the manifest's `engine`). */
  engine: string
  /** The game's own data about the slot (a label, the level, play time). */
  meta?: JsonValue
  /**
   * Schema versions of the components and resources below, by name. Data older than the running
   * code's version goes through its migrations on load.
   */
  schemas: Record<string, number>
  time: { elapsed: number; frame: number; fixedElapsed?: number }
  /** Per loaded scene (by id, its path): what changed since it was loaded. */
  scenes: Record<string, SavedScene>
  /** Entities spawned at runtime: prefab instances by reference, others in full. */
  spawned: SavedEntity[]
  /** Resources defined with `persist`, by name. */
  resources: Record<string, JsonValue>
  /** Named RNG streams' state words (`core/GlobalRng` for the root stream). */
  rng: Record<string, number[]>
}

export interface SavedScene {
  /**
   * Scene path → component name → the fields that differ from the scene file (the whole component
   * if it was added at runtime, `null` if it was removed). `core/ChildOf` records a new parent.
   */
  changed: Record<string, Record<string, Record<string, JsonValue> | null>>
  /** Paths of scene entities despawned at runtime (a subtree is listed by its root). */
  removed: string[]
}

export interface SavedEntity {
  /** Save-local id (`@3`): entity fields elsewhere in the save point at it. */
  id: string
  /** For prefab instances: the prefab. The instance's generated children aren't saved. */
  prefab?: { guid?: string; path?: string }
  /** Its parent: a scene path, a save id, or a save id plus a path inside an instance (`@3/Hull`). */
  parent?: string
  /**
   * Components, entity fields as references: in full for plain entities; for a prefab instance,
   * the fields that differ from the prefab's root (`null`: removed since it spawned).
   */
  components: Record<string, Record<string, JsonValue> | null>
  /** Prefab instances: changes to the generated entities, as in `scene/PrefabInstance`. */
  overrides?: Overrides
}

export const SAVE_VERSION = 1

const entityRef: JsonSchema = {
  type: 'string',
  description:
    'An entity: a scene path ("ship/camera", or "scene-id:path" with several scenes), a save id ("@3"), or a path inside a saved instance ("@3/Hull").',
}

/**
 * JSON Schema for save files: agents can read a save and edit it into a test fixture ("load a save
 * where the player has 10 fuel"). Component values are checked against their own schemas on load.
 */
export function saveJsonSchema(): JsonSchema {
  const components: JsonSchema = {
    type: 'object',
    description:
      'Component name → fields (entity fields as references). Prefab instances: the fields that differ from the prefab root, null for a removed component.',
    additionalProperties: { anyOf: [{ type: 'object' }, { type: 'null' }] },
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Shard saved game',
    type: 'object',
    required: ['version', 'scenes', 'spawned'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      version: { const: SAVE_VERSION },
      engine: { type: 'string' },
      meta: { description: "The game's own data about the slot." },
      schemas: {
        type: 'object',
        description: 'Schema version of each component and resource, by name.',
        additionalProperties: { type: 'integer', minimum: 1 },
      },
      time: {
        type: 'object',
        properties: {
          elapsed: { type: 'number', minimum: 0 },
          frame: { type: 'integer', minimum: 0 },
          fixedElapsed: { type: 'number', minimum: 0 },
        },
      },
      scenes: {
        type: 'object',
        description: 'Scene id (its path) → what changed since the scene loaded.',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          properties: {
            changed: {
              type: 'object',
              description:
                'Scene path → component → changed fields (the whole component if added, null if removed).',
              additionalProperties: {
                type: 'object',
                additionalProperties: { anyOf: [{ type: 'object' }, { type: 'null' }] },
              },
            },
            removed: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      spawned: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'components'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', pattern: '^@\\d+$' },
            prefab: {
              type: 'object',
              properties: { guid: { type: 'string' }, path: { type: 'string' } },
              additionalProperties: false,
            },
            parent: entityRef,
            components,
            overrides: { type: 'object' },
          },
        },
      },
      resources: {
        type: 'object',
        description: 'Persisted resources by name.',
        additionalProperties: { type: 'object' },
      },
      rng: {
        type: 'object',
        description: 'Named RNG streams: four 32-bit state words each.',
        additionalProperties: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 4294967295 },
          minItems: 4,
          maxItems: 4,
        },
      },
    },
  }
}
