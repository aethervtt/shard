import { defineResource, type Entity, ShardError, type World } from '@aethervtt/shard-core'
import { LogResource } from '@aethervtt/shard-runtime'
import type { TileLayer } from '@aethervtt/shard-sprite'
import type { GridSource } from './components'
import { GridSearch, type NavGridData } from './grid'
import type { NavMeshRuntime } from './navmesh'
import type { OffMeshLinkParams, Recast } from './recast'
import { type NavContribution, type NavGate, NavGates, NavShapes } from './sources'

/** A NavGrid entity's effective grid: its cells and where they sit in the world. */
export interface GridRecord {
  entity: Entity
  source: GridSource
  /** The cells. Built from the tilemap or colliders, or the data asset itself. */
  grid: NavGridData | null
  /** World XY of cell (0, 0)'s lower-left corner, and cell size. */
  ox: number
  oy: number
  csx: number
  csy: number
  /** The entity's world z: grid corners get it. */
  z: number
  diagonal: number
  /** Why the grid is empty, if it is. */
  problem: string | null
  /** The component's fields when last built, to rebuild on edits. */
  stamp: string
  /** tilemap: the layer and how far into its edit log the grid has read. */
  layer: TileLayer | null
  editBase: number
  editCursor: number
  tilemapVersion: number
  /** tilemap: tile number → blocks (1). Empty: every non-empty tile blocks. */
  blocking: Uint8Array | null
  /** colliders: physics collider count and tick when last rasterized. */
  colliderStamp: string
  /** Bumps when cells change, so agents on the grid repath. */
  version: number
  /** The grid's `version` last seen (data grids change underneath). */
  seen: number
}

/** A NavAgent's runtime side: its path, crowd slot, and repath bookkeeping. */
export interface AgentRecord {
  entity: Entity
  /** The NavGrid or NavMesh entity it walks on, or -1. */
  nav: Entity
  kind: 'grid' | 'mesh' | 'none'
  /** Crowd agent index on a mesh, or -1. */
  crowdIndex: number
  /** Corners of the current path (xyz), and how many; grid agents walk them. */
  corners: Float32Array
  count: number
  /** Next corner to walk to (grid agents). */
  next: number
  /** Where the current path goes. */
  goal: Float64Array
  /** Navigation version the path was made on. */
  navVersion: number
  sinceRepath: number
  /** The path reaches the goal (false: partial, heading for the closest point). */
  reachable: boolean
  /** Last status sent, for events on changes. */
  status: number
  /** The NavAgent tick the path was made for: writing NavAgent repaths. */
  agentTick: number
  /** The drive actually used (character without a CharacterController drives the transform). */
  drive: number
  /** On a framed navmesh: steering happens in its space, from this position (set each step). */
  framed: boolean
  /** The nav/Filters entry it paths with (0112); '' is the default. */
  filter: string
  lpos: Float64Array
  /**
   * Crossing an off-mesh link: where it started (x, z), the link's near and far surface
   * heights and far end (x, z), how high the entity sits above the surface (a character's capsule
   * center), and the height of the jump arc.
   */
  link: {
    active: boolean
    lift: number
    x0: number
    z0: number
    y0: number
    x1: number
    z1: number
    y1: number
    arc: number
  }
}

export class NavState {
  /** Recast and Detour, once loaded (the nav plugin loads them; nav/grid doesn't). */
  R: Recast | null = null
  readonly grids = new Map<Entity, GridRecord>()
  readonly meshes = new Map<Entity, NavMeshRuntime>()
  readonly agents = new Map<Entity, AgentRecord>()
  /** `grids` and `meshes` as arrays, for per-frame loops (Map iteration allocates). */
  gridList: GridRecord[] = []
  meshList: NavMeshRuntime[] = []
  readonly search = new GridSearch()
  /** Every OffMeshLink and link gate, as link parameters. */
  links: OffMeshLinkParams[] = []
  /** Shapes and gates plugins push (0112): structure's walls, floors and doors. */
  readonly shapes = new NavShapes()
  readonly gates = new NavGates()
  /** What the bake has indexed: entity sources by root, shapes and gates by owner. */
  readonly sources = new Map<Entity, NavContribution>()
  readonly shapeSources = new Map<Entity, NavContribution>()
  readonly gateSources = new Map<Entity, NavGate>()
  /** Entities whose changes rebake: sources, their descendants, and link ends. */
  readonly watched = new Set<Entity>()
  /** `watched` as an array, for the per-frame change check. */
  watchedList: Entity[] = []
  /** Watched entity → the source root it belongs to (`LINKS` for links and their ends). */
  readonly rootOf = new Map<Entity, Entity>()
  readonly members = new Map<Entity, Entity[]>()
  /** Roots to gather again, and roots whose meshes are still loading (gathered every frame). */
  readonly dirtyRoots = new Set<Entity>()
  readonly pendingRoots = new Set<Entity>()
  /** Links to gather again. */
  linksDirty = true
  /** Gather every source again (the first bake, nav.bake). */
  dirty = true
  /** Signature of the nav/Areas costs last applied (NaN: none yet). */
  areas = Number.NaN
  /** Colliders: count and tick of the last change seen (grids rasterized from them rebuild). */
  colliderCount = -1
  colliderTick = 0
  /** Agents whose filter was reported missing (once each). */
  readonly badFilters = new Set<Entity>()
  /** Source entities skipped, with why, by root (`LINKS` for links), and all of them. */
  readonly skippedBy = new Map<Entity, { entity: Entity; reason: string }[]>()
  skipped: { entity: Entity; reason: string }[] = []

  /** Triangles across every indexed source. */
  triangles(): number {
    let n = 0
    for (const c of this.sources.values()) n += c.count
    for (const c of this.shapeSources.values()) n += c.count
    return n
  }
}

/** Logs a warning with its code and hint. */
export function navWarn(world: World, err: ShardError): void {
  world.tryResource(LogResource)?.log('warn', err.message, { code: err.code, hint: err.hint })
}

/** The `rootOf` owner of links and their end entities. */
export const LINKS = -1 as Entity

export const Nav = defineResource<NavState>('nav/State', {
  description: 'Navigation runtime: grids, navmeshes, agents.',
  init: () => new NavState(),
})

/** The navigation state, or `nav/not-ready` without a nav plugin. */
export function navState(world: World): NavState {
  const s = world.tryResource(Nav)
  if (!s) {
    throw new ShardError('nav/not-ready', 'Navigation is not set up', {
      hint: 'Add the nav plugin (or nav/grid for grids only) and await app.init().',
    })
  }
  return s
}
