import { ShardError } from '@aethervtt/shard-core'
import type * as RecastModule from 'recast-navigation'
import { buildTile as build, type TileGate } from './tile-build.js'

export type Recast = typeof RecastModule

let module: Promise<Recast> | undefined

/** Loads and initializes Recast and Detour (WASM) once per process. */
export function loadRecast(): Promise<Recast> {
  module ??= (async () => {
    const R = (await import('recast-navigation')) as Recast
    await R.init()
    return R
  })()
  return module
}

/** What a NavMesh bakes with, as its component fields. */
export interface BakeSettings {
  agentRadius: number
  agentHeight: number
  maxClimb: number
  maxSlope: number
  cellSize: number
  cellHeight: number
  tileSize: number
}

export interface OffMeshLinkParams {
  start: [number, number, number]
  end: [number, number, number]
  radius: number
  bidirectional: boolean
  area: number
}

export type GateState = 'closed' | 'locked' | 'custom'

export {
  areaFlags,
  EXACT_AREAS,
  GATE_BITS,
  GATE_CLOSED,
  GATE_CUSTOM,
  GATE_LOCKED,
  type TileGate,
  voxelSettings,
} from './tile-build.js'

/**
 * Builds one navmesh tile with Recast on this thread (tile-build.js, the code workers run too).
 * Throws `nav/bake-failed` when a Recast step fails.
 */
export function buildTile(
  R: Recast,
  s: BakeSettings,
  tx: number,
  ty: number,
  yMin: number,
  yMax: number,
  soup: { positions: Float32Array; areas: Uint8Array },
  triangles: Int32Array,
  count: number,
  links: readonly OffMeshLinkParams[],
  gates: readonly TileGate[] = [],
): Uint8Array | null {
  try {
    return build(R, s, tx, ty, yMin, yMax, soup, triangles, count, links, gates)
  } catch (err) {
    throw toShardError(err)
  }
}

/** A tile build's error (a plain Error with a code, from either thread) as a ShardError. */
export function toShardError(err: unknown): unknown {
  const e = err as { code?: string; message?: string; hint?: string }
  if (e && typeof e.code === 'string' && !(err instanceof ShardError))
    return new ShardError(e.code as 'nav/bake-failed', e.message ?? 'Recast failed', {
      hint: e.hint,
    })
  return err
}
