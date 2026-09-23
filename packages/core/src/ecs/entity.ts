/**
 * An entity id: `index + generation * 2^22`. Plain number, safe integer, serializable.
 * The index addresses per-entity storage; the generation detects stale ids.
 */
export type Entity = number

export const MAX_ENTITIES = 4_194_304 // 2^22

export const entityIndex = (e: Entity): number => e % MAX_ENTITIES
export const entityGeneration = (e: Entity): number => Math.floor(e / MAX_ENTITIES)
export const makeEntity = (index: number, generation: number): Entity =>
  generation * MAX_ENTITIES + index

/** Human-readable form, e.g. `12v3` (index 12, generation 3). */
export const formatEntity = (e: Entity): string => `${entityIndex(e)}v${entityGeneration(e)}`
