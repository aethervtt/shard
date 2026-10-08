import type { Entity, World } from '@aethervtt/shard-core'
import type { NoiseGraph } from '@aethervtt/shard-noise'
import type { Workers } from '@aethervtt/shard-platform'
import type { CompiledRule } from './rules'

/**
 * Floats per placement in a chunk's placements: item, variant, position (xyz, relative to the
 * chunk's center, in the surface's frame, before sink), rotation (xyzw), scale, cell index (the
 * placement's stable id in the chunk), footprint radius (scaled, for `avoid`; 0 until the item's
 * bounds are known), and the shade variation in [0, 1].
 */
export const PLACEMENT_STRIDE = 13
export const P_ITEM = 0
export const P_VARIANT = 1
export const P_X = 2
export const P_QX = 5
export const P_SCALE = 9
export const P_CELL = 10
export const P_RADIUS = 11
export const P_SHADE = 12

/** A chunk of one rule's lattice: a quadtree node on a planet, a square on a mesh. */
export interface SurfaceChunk {
  /** The chunk's address as text: `face/depth/x/y` on a planet, `x/z` on a mesh. */
  key: string
  rule: number
  face: number
  depth: number
  x: number
  y: number
  /** Center at zero height, in the surface's frame. */
  center: Float64Array
  /** Half the chunk's diagonal (m): a chunk is in range when its center is within range + this. */
  extent: number
}

/** A chunk's placements, cached per (surface version, rule, chunk). */
export interface ChunkPlacements {
  chunk: SurfaceChunk
  count: number
  data: Float32Array
  /** Candidates tested (lattice cells), for scatter.describe. */
  candidates: number
}

/** Placement in progress: sampling on the pool, assembled on the main thread when due. */
export interface PlacementJob {
  chunk: SurfaceChunk
  /** Frame it must be finished by (placed inline then if the pool hasn't answered). */
  due: number
  /** The pool's samples arrived. */
  ready: boolean
  cancelled: boolean
  /** Surface-specific state (candidates, samples). */
  state: unknown
}

/**
 * What placement needs from a surface: its frame, its chunk grid per rule, and its heights, normals
 * and masks at candidate points. Planets (0043), meshes (`ScatterSurface`) and heightfield terrains
 * (0071, `Terrain.scatter`) implement it.
 */
export interface Surface {
  readonly entity: Entity
  readonly kind: 'planet' | 'mesh' | 'heightfield'
  /** Bumps when anything placements depend on changes (rules, seed, heights). */
  readonly version: number
  readonly rules: readonly CompiledRule[]
  /** Lattice cells per chunk side, per rule. */
  readonly cells: readonly number[]
  /** Each rule's noise mask graph, loaded (undefined: no mask). */
  readonly masks: readonly (NoiseGraph | undefined)[]
  /** Takes new rules (and their loaded masks); bumps `version`. */
  configure(rules: CompiledRule[], masks: (NoiseGraph | undefined)[], version: number): void
  /** Whether the surface can place (its graphs and sets are loaded). */
  readonly ready: boolean
  /** Viewer positions in the surface's frame: cameras, then (for props) anchors. Returns the count of each. */
  viewers(world: World, out: { points: Float64Array; cameras: number; anchors: number }): void
  /** Visits every chunk of `rule` whose center is within `range` (+ its extent) of a viewer. */
  chunksNear(
    rule: CompiledRule,
    viewers: Float64Array,
    first: number,
    count: number,
    range: number,
    visit: (chunk: SurfaceChunk, distance: number) => void,
  ): void
  /** The chunk of `rule` containing a surface-frame point (avoid lookups, scatter.sample). */
  chunkAt(rule: CompiledRule, x: number, y: number, z: number): SurfaceChunk
  /** Starts placing a chunk: candidates now, samples on the pool when `workers` has threads. */
  startPlacement(chunk: SurfaceChunk, due: number, workers: Workers | undefined): PlacementJob
  /**
   * Finishes a job (sampling inline if the pool hasn't answered) into placements, without
   * `avoid` (the runtime applies that once the avoided chunks are placed).
   */
  finishPlacement(job: PlacementJob): ChunkPlacements
  /** Parents a chunk's root entity: a child of the surface at the chunk's center. */
  placeChunkRoot(world: World, root: Entity, chunk: SurfaceChunk): void
  /** The surface's up (unit) at a surface-frame point: radial on a planet, +Y on a mesh. */
  upAt(x: number, y: number, z: number, out: Float64Array): Float64Array
  /**
   * Starts building a foliage chunk's ground patch: its grid of positions, normals and the rule's
   * density per vertex (masks, biome), on the pool where there is one.
   */
  startPatch(chunk: SurfaceChunk, workers: Workers | undefined): PatchJob
  /** The patch (built inline if the pool hasn't answered). */
  finishPatch(job: PatchJob): FoliagePatch
  /**
   * The chunk's frame (surface axes, metres, origin at its center) in origin-relative world space:
   * an affine's three rows (12 floats) into `out`. Changes with the floating origin.
   */
  chunkTransform(world: World, chunk: SurfaceChunk, out: Float32Array): void
}

/** A foliage chunk's ground: what the GPU places instances on (render's FoliageChunk). */
export interface FoliagePatch {
  grid: number
  positions: Float32Array
  normals: Float32Array
  density: Float32Array
  cell0: [number, number]
  domain: number
  accept: number
  jitter: number
  radial: [number, number, number] | undefined
}

/** A patch being built. */
export interface PatchJob {
  chunk: SurfaceChunk
  ready: boolean
  cancelled: boolean
  state: unknown
}
