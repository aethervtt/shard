// Types for tile-build.js (plain JavaScript so worker threads can import it without a loader).

import type { BakeSettings, OffMeshLinkParams, Recast } from './recast'

/** Bits 0–11 are areas 0–11, one each; bit 12 is shared by areas 12–62 (0112). */
export declare const EXACT_AREAS: 12
export declare const GATE_CLOSED: 8192
export declare const GATE_LOCKED: 16384
export declare const GATE_CUSTOM: 32768
/** Gate state bits by name, as filters exclude them. */
export declare const GATE_BITS: { closed: 8192; locked: 16384; custom: 32768 }

/** Poly flags for an area: its own bit for areas 0–11, the shared bit 12 for the rest. */
export declare function areaFlags(area: number): number

/** Voxel counts Recast wants, from world-unit settings. */
export declare function voxelSettings(s: BakeSettings): {
  walkableRadius: number
  walkableHeight: number
  walkableClimb: number
  borderSize: number
  tileWorld: number
}

/** An area gate as a tile build marks it. */
export interface TileGate {
  points: Float64Array | null
  yMin: number
  yMax: number
  area: number
}

/**
 * Builds one tile with Recast: the triangles of `soup` listed in `triangles`, rasterized with
 * their area codes, area gates marked after erosion, and turned into Detour tile data. Null when
 * nothing is walkable. Throws an Error with `code: 'nav/bake-failed'` when a Recast step fails.
 */
export declare function buildTile(
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
  gates?: readonly TileGate[],
): Uint8Array | null
