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

import { areaFlags, GATE_CLOSED, GATE_CUSTOM, GATE_LOCKED } from './tile-build.js'

/**
 * A gate nobody passes, whatever their filter, breaching or not (0114): an open hatch's hole. Nav
 * keeps it on the gate and never writes it to Detour: the gate's polygons get flags 0.
 */
export const GATE_SOLID = 1 << 16
/** Any of these makes a gate shut: its polygons take its shut area. */
export const GATE_STATES = GATE_CLOSED | GATE_LOCKED | GATE_CUSTOM | GATE_SOLID
/** Gates take areas 1 to 31; a shut gate's polygons take its area plus SHUT_AREA (0114). */
export const MAX_GATE_AREA = 31
export const SHUT_AREA = 31

/** A gate polygon's Detour flags: its area's bit and its state, or 0 when it's solid. */
export function gatePolyFlags(area: number, flags: number): number {
  return (flags & GATE_SOLID) !== 0 ? 0 : areaFlags(area) | (flags & 0xe000)
}

/** A gate polygon's Detour area: its own while open, its shut area while it has a state bit. */
export function gatePolyArea(area: number, flags: number): number {
  return (flags & GATE_STATES) !== 0 ? area + SHUT_AREA : area
}

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
