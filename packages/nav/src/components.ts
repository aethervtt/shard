import { AssetStore, defineAssetType, defineDataAsset } from '@aethervtt/shard-assets'
import {
  defineComponent,
  defineEvent,
  defineResource,
  defineSchema,
  type Entity,
  ShardError,
  t,
} from '@aethervtt/shard-core'
import type { Workers } from '@aethervtt/shard-platform'
import { Transform } from '@aethervtt/shard-transform'
import { DIAGONAL_MODES, NavGridData } from './grid'

export const GRID_SOURCES = ['data', 'tilemap', 'colliders'] as const
export type GridSource = (typeof GRID_SOURCES)[number]

export const NavGrid = defineComponent(
  'nav/NavGrid',
  {
    source: t.enum(GRID_SOURCES, {
      description:
        'data: costs from a *.navgrid.json (data). tilemap: a tilemap layer, cell per tile (size, cell size, and origin come from the tilemap). colliders: fixed 2D colliders rasterized into width × height cells.',
    }),
    width: t.u32({ default: 32, min: 1, description: 'colliders: cells across.' }),
    height: t.u32({ default: 32, min: 1, description: 'colliders: cells up.' }),
    cellSize: t.vec2({
      default: [1, 1],
      min: 0.001,
      unit: 'm',
      description: 'data, colliders: world size of one cell.',
    }),
    origin: t.vec2({
      unit: 'm',
      description:
        "data, colliders: world XY of cell (0, 0)'s lower-left corner, relative to the entity's position.",
    }),
    diagonal: t.enum(DIAGONAL_MODES, {
      description:
        'no-corners: diagonal steps unless they cut a blocked corner. never: four directions only. always: diagonals even past corners.',
    }),
    tilemap: t.entity({
      description: 'tilemap: the Tilemap entity (default: this entity).',
    }),
    layer: t.string({ description: 'tilemap: the layer name (default: the first layer).' }),
    blockingTiles: t.list(t.u16, {
      description:
        'tilemap: only these tiles block (empty: every non-empty tile blocks). Tile numbers as in the tilemap data (region + 1).',
    }),
    data: t.handle('NavGridData', { description: 'data: the *.navgrid.json asset.' }),
    mask: t.u16({
      default: 0xffff,
      description: 'colliders: collider layers (bitmask) that block cells.',
    }),
  },
  {
    description:
      'A 2D navigation grid in the XY plane: walkable cells with costs, A* with diagonal rules, paths pulled straight. Queries and NavAgents inside it use it.',
    requires: [Transform],
  },
)

export const NavSource = defineComponent(
  'nav/NavSource',
  {
    area: t.u8({
      max: 62,
      description:
        'Area code the triangles bake as (0: ground). Costs per area are in nav/Areas; paths prefer cheap areas.',
    }),
  },
  {
    description:
      "This entity's colliders (or, without a Collider, its Mesh3d) and those of descendants without their own NavSource feed the navmesh bake. Moving or changing one rebuilds the tiles it touches.",
  },
)

export const NavMesh = defineComponent(
  'nav/NavMesh',
  {
    agentRadius: t.f32({
      default: 0.4,
      min: 0,
      unit: 'm',
      description: 'Walls are this far from the walkable area.',
    }),
    agentHeight: t.f32({
      default: 1.8,
      min: 0.01,
      unit: 'm',
      description: 'Minimum clearance under ceilings.',
    }),
    maxClimb: t.f32({
      default: 0.3,
      min: 0,
      unit: 'm',
      description: 'Tallest step or ledge an agent walks up.',
    }),
    maxSlope: t.f32({
      default: 45,
      min: 0,
      max: 89.9,
      unit: 'deg',
      description: 'Steepest walkable slope.',
    }),
    cellSize: t.f32({
      default: 0.2,
      min: 0.01,
      unit: 'm',
      description: 'Voxel size across: smaller follows edges closer and bakes slower.',
    }),
    cellHeight: t.f32({ default: 0.1, min: 0.01, unit: 'm', description: 'Voxel height.' }),
    tileSize: t.u16({
      default: 64,
      min: 8,
      max: 1024,
      description: 'Cells per tile side: the unit that rebuilds when a source changes.',
    }),
    maxTiles: t.u32({
      default: 256,
      min: 1,
      max: 16384,
      description:
        'Tiles the navmesh holds before it has to grow. Growing re-adds every tile and resets the crowd, so a streamed world (0113) sizes it for its rings up front.',
    }),
    boundsMin: t.vec3({
      unit: 'm',
      description:
        'World-space bake bounds, min corner. Equal to boundsMax (the default): bounds of every source.',
    }),
    boundsMax: t.vec3({ unit: 'm', description: 'World-space bake bounds, max corner.' }),
    frame: t.entity({
      description:
        "Bake and query in this entity's local space instead of the world's: its +Y is up. Positions and paths stay world-space in the API. Lets a navmesh ride a moving or rotating frame (a planet's surface) and keeps its tiles when the floating origin moves. Bounds are in this space.",
    }),
  },
  {
    description:
      'A navmesh baked with Recast from every NavSource, with OffMeshLinks. Tiles are cached by the geometry that made them. Queries and NavAgents inside it use it.',
  },
)

export const OffMeshLink = defineComponent(
  'nav/OffMeshLink',
  {
    to: t.entity({ description: 'The link ends at this entity’s position.' }),
    bidirectional: t.bool({ default: true, description: 'Agents cross it both ways.' }),
    radius: t.f32({
      default: 0.5,
      min: 0.01,
      unit: 'm',
      description: 'How close to either end counts as on it.',
    }),
    area: t.u8({ max: 62, description: 'Area code (costs in nav/Areas).' }),
  },
  {
    description:
      'A jump, drop, ladder, or door between two navmesh points: from this entity’s position to `to`. Agents cross it in a straight line.',
    requires: [Transform],
  },
)

export const AGENT_STATUSES = ['idle', 'moving', 'arrived', 'unreachable', 'blocked'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export const NavAgentState = defineComponent(
  'nav/NavAgentState',
  {
    status: t.enum(AGENT_STATUSES, {
      readonly: true,
      description:
        'idle: stopped or no navigation here. moving. arrived: within stoppingDistance. unreachable: no path; it walks to the closest point it can reach. blocked: waiting at a shut gate its filter breaches (0114), in a slot or for one.',
    }),
    remaining: t.f32({
      unit: 'm',
      readonly: true,
      description: 'Distance left along the path.',
    }),
    corners: t.u16({ readonly: true, description: 'Corners left on the path.' }),
    velocity: t.vec3({ unit: 'm/s', readonly: true, description: 'Steering velocity.' }),
    gate: t.entity({
      readonly: true,
      description: 'The gate it waits at while blocked (0114): a door, window or Breach.',
    }),
    row: t.u8({
      readonly: true,
      description:
        'While blocked: its slot row at the gate, 0 against it, more behind; 255 while it waits for a slot (0114).',
    }),
  },
  { description: 'What a NavAgent is doing. Written by navigation; read-only.' },
)

export const DRIVES = ['character', 'transform', 'velocity'] as const
export type Drive = (typeof DRIVES)[number]

export const NavAgent = defineComponent(
  'nav/NavAgent',
  {
    destination: t.vec3({
      unit: 'm',
      description: 'Where to go (world space). Writing it starts a new path.',
    }),
    target: t.entity({
      description:
        'Follow this entity instead of destination: repaths when it moves more than a cell or every repathInterval.',
    }),
    speed: t.f32({ default: 3.5, min: 0, unit: 'm/s', description: 'Top speed.' }),
    acceleration: t.f32({ default: 8, min: 0, unit: 'm/s²' }),
    radius: t.f32({
      default: 0.4,
      min: 0,
      unit: 'm',
      description: 'Personal space: agents steer to keep this far apart.',
    }),
    stoppingDistance: t.f32({
      default: 0.2,
      min: 0,
      unit: 'm',
      description: 'Arrived this close to the destination.',
    }),
    avoidance: t.bool({ default: true, description: 'Steer around other agents.' }),
    repathInterval: t.f32({
      default: 0.5,
      min: 0,
      unit: 's',
      description: 'With a moving target: path again at least this often.',
    }),
    drive: t.enum(DRIVES, {
      description:
        'character: writes CharacterIntent.move so physics walks it (slopes, steps, collisions; falls back to transform without a CharacterController). velocity: writes the rigid body’s Velocity. transform: moves the Transform directly.',
    }),
    stopped: t.bool({ description: 'Hold position (status idle) until cleared.' }),
    nav: t.entity({
      description: 'The NavGrid or NavMesh to walk on (default: the one the agent stands in).',
    }),
    filter: t.string({
      description:
        'Navmeshes: the nav/Filters entry it paths with (0112), such as "zombie"; empty is the default filter (nav/Areas costs, every gate passable).',
    }),
    flow: t.entity({
      description:
        "Follow this NavFlowField to its goal instead of destination or target (0115). Below the crowd (NavTier steer or coarse) it makes no findPath call while inside the field; in the crowd it paths to the field's goal as usual.",
    }),
  },
  {
    description:
      'Walks to a destination or follows a target along navigation paths: arrives, avoids other agents, repaths. Status in NavAgentState; NavArrived and NavUnreachable on changes.',
    requires: [Transform, NavAgentState],
  },
)

export const NAV_TIERS = ['crowd', 'steer', 'coarse'] as const
export type NavTierName = (typeof NAV_TIERS)[number]

export const NavTier = defineComponent(
  'nav/NavTier',
  {
    tier: t.enum(NAV_TIERS, {
      description:
        "crowd: Detour's crowd with avoidance (joins at most NavBudget.joins a frame, up to NavBudget.crowd agents). steer: nav's own mover at NavBudget.steerHz, seek and separation, moving the Transform. coarse: the same at NavBudget.coarseHz without separation.",
    }),
  },
  {
    description:
      'How a navmesh NavAgent is moved (0115). Absent: crowd. Below the crowd the Transform is the drive, and a CharacterController gets physics/CharacterSuspended. Characters set it from the sim tier; games without characters set it themselves.',
  },
)

export const NavFlowField = defineComponent(
  'nav/NavFlowField',
  {
    goal: t.vec3({ unit: 'm', description: 'Where the field leads (world space).' }),
    target: t.entity({
      description:
        "Lead to this entity's position instead; the field rebuilds when it moves more than 2 m.",
    }),
    filter: t.string({
      description: 'The nav/Filters entry that prices and excludes polygons (empty: the default).',
    }),
    range: t.f32({
      default: 300,
      min: 1,
      unit: 'm',
      description:
        'How far from the goal the field reaches. Agents outside it fall back to findPath.',
    }),
    nav: t.entity({ description: 'The NavMesh (default: the one containing the goal).' }),
  },
  {
    description:
      'A flow field over navmesh polygons (0115): a Dijkstra from the goal out to range, priced by the filter, built in slices of NavBudget.flowMs. Many agents with NavAgent.flow follow it to one goal without a path each.',
  },
)

export interface NavAgentEventData {
  entity: Entity
}

export const NavArrived = defineEvent<NavAgentEventData>('nav/NavArrived', {
  description: 'A NavAgent arrived at its destination or target.',
})

export const NavUnreachable = defineEvent<NavAgentEventData>('nav/NavUnreachable', {
  description: 'A NavAgent’s destination has no path; it heads for the closest reachable point.',
})

export interface NavGateAheadData {
  entity: Entity
  /** The gate's owner (a door). */
  gate: Entity
  /** Its state bits (GATE_CLOSED, GATE_LOCKED, GATE_CUSTOM). */
  flags: number
}

export const NavGateAhead = defineEvent<NavGateAheadData>('nav/NavGateAhead', {
  description:
    "A NavAgent came within its radius + 1 m of a closed gate on its path that its filter passes (0112): a survivor at a shut door. Game code opens it; until then the door's collider blocks.",
})

export interface NavGateBlockedData {
  entity: Entity
  /** The gate's owner: a door, a window, or a Breach. */
  gate: Entity
  /** Its state bits (GATE_CLOSED, GATE_LOCKED, GATE_CUSTOM). */
  flags: number
  /** Its slot row: 0 against the gate, more queued behind. */
  row: number
  /** The point on the gate's centre plane, in the gap, nearest the agent: what to face (world). */
  point: [number, number, number]
}

export const NavGateBlocked = defineEvent<NavGateBlockedData>('nav/NavGateBlocked', {
  description:
    'A NavAgent reached its slot at a shut gate its filter breaches (0114) and waits there (status blocked). Game code decides what happens: attack the gate, give up. Once the gate passes its filter (opened, broken), it walks on without a replan. Fires again when it moves up a row.',
})

/** Cost multiplier per area code: `{ 0: 1, 1: 3 }` makes area 1 three times as slow to cross. */
export type NavAreasValue = Record<number, number>

export const NavAreas = defineResource<NavAreasValue>('nav/Areas', {
  description:
    'Navmesh area costs by area code (NavSource.area, OffMeshLink.area): { "1": 3 } makes area 1 three times as costly. 0 excludes an area. Unlisted areas cost 1.',
  init: () => ({ 0: 1 }),
})

/**
 * A named query filter (0112): area costs over nav/Areas (0 excludes areas 0–11), and the gate
 * states it won't pass (`closed`, `locked`, `custom`).
 */
export interface NavFilterValue {
  areas?: Record<number, number>
  exclude?: ('closed' | 'locked' | 'custom')[]
  /** Gate states it plans through at a cost and never walks through while shut (0114). */
  breach?: ('closed' | 'locked' | 'custom')[]
  /**
   * What a breach costs, in metres of walking: one for every gate area, or by gate area (unlisted
   * ones cost the default, 20).
   */
  breachCost?: number | Record<number, number>
}

export type NavFiltersValue = Record<string, NavFilterValue>

/** At most this many named filters: Detour's crowd has 16 filter slots and the default takes one. */
export const MAX_NAV_FILTERS = 15

export const NavFilters = defineResource<NavFiltersValue>('nav/Filters', {
  description:
    'Named navmesh query filters (0112), up to 15: { "zombie": { "breach": ["closed", "locked"], "breachCost": 20 } }. NavAgent.filter, findPath and nav.path pick one by name. Each takes nav/Areas costs, overridden by its own `areas` (0 excludes an area 0–11), and passes no gate polygon flagged with a state in `exclude`. States in `breach` (0114) are planned through at `breachCost` metres a crossing (by gate area, or one for all; default 20) and never walked through: agents wait at the gate (NavGateBlocked). Write it with insertResource or patchResource.',
  init: () => ({}),
})

/**
 * How much navmesh building a frame may do (0112). With a worker pool (NavWorkers), tiles build
 * on it and the main thread's part (keying, packing, applying) stops at `ms`; without one, at most
 * `tiles` tiles build a frame, with no time check, so runs are frame-exact. A navmesh's first bake
 * ignores both. At most `replans` agents replan a frame.
 */
export interface NavBudgetValue {
  ms: number
  tiles: number
  /** false builds on the main thread even with a pool. */
  workers: boolean
  replans: number
  /** 0115: agents a navmesh's crowd holds (NavTier crowd beyond it keeps steering). 128. */
  crowd?: number
  /** 0115: agents that join a crowd a frame; the rest keep steering until admitted. 8. */
  joins?: number
  /** 0115: how often steer and coarse agents decide (Hz), staggered by entity. 10 and 2. */
  steerHz?: number
  coarseHz?: number
  /** 0115: ms of flow field building a frame. 1. */
  flowMs?: number
}

export const NavBudget = defineResource<NavBudgetValue>('nav/Budget', {
  description:
    "How much navmesh work a frame may do (0112): ms of main-thread bake work with a worker pool, tiles built a frame without one (frame-exact), and agents replanned a frame. A navmesh's first bake ignores the bake limits. Movement tiers (0115): crowd size, crowd joins a frame, steer and coarse decision rates (Hz), and ms of flow field building a frame.",
  init: () => ({
    ms: 1.5,
    tiles: 4,
    workers: true,
    replans: 6,
    crowd: 128,
    joins: 8,
    steerHz: 10,
    coarseHz: 2,
    flowMs: 1,
  }),
  hostWritable: true,
})

/**
 * How agents wait at a shut gate they breach (0114): they claim a slot within `claim` m of where
 * their path enters it, in rows along its face (row 0 spans its width plus `spread` each side),
 * up to `rows` rows.
 */
export interface NavBreachValue {
  claim: number
  spread: number
  rows: number
}

export const NavBreach = defineResource<NavBreachValue>('nav/Breach', {
  description:
    'Slots at shut gates agents breach (0114): an agent claims one within `claim` m of the gate; row 0 spans the gate plus `spread` m each side, and up to `rows` rows queue behind it.',
  init: () => ({ claim: 4, spread: 0.5, rows: 8 }),
})

/** The worker pool navmesh tiles build on (0112): the platform's, set by the host. */
export const NavWorkers = defineResource<Workers>('nav/Workers', {
  description:
    "The worker pool navmesh tiles build on (0112), the platform's. Unset: tiles build inline.",
})

// --- grid data asset ---------------------------------------------------------------

export const NavGridDataSchema = defineSchema(
  'nav/NavGridData',
  {
    width: t.u32({ min: 1, required: true, description: 'Cells across.' }),
    height: t.u32({ min: 1, required: true, description: 'Cells up.' }),
    costs: t.string({
      description:
        'Base64 of width × height bytes, row by row from the bottom (y = 0): 0 blocked, 1 ground, more costs more. Empty: all 1.',
    }),
  },
  { description: 'Walkable cells and costs for a NavGrid with source: data.' },
)

export function navGridFromJson(json: unknown): NavGridData {
  const v = NavGridDataSchema.deserialize(json) as unknown as {
    width: number
    height: number
    costs: string
  }
  if (!v.costs) return new NavGridData(v.width, v.height)
  const bin = atob(v.costs)
  if (bin.length !== v.width * v.height) {
    throw new ShardError(
      'nav/invalid-grid',
      `A ${v.width}×${v.height} navgrid needs ${v.width * v.height} cost bytes, got ${bin.length}`,
      { path: '/costs' },
    )
  }
  const costs = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) costs[i] = bin.charCodeAt(i)
  return new NavGridData(v.width, v.height, costs)
}

export function navGridToJson(grid: NavGridData): { width: number; height: number; costs: string } {
  let s = ''
  for (let i = 0; i < grid.costs.length; i += 0x8000) {
    s += String.fromCharCode(...grid.costs.subarray(i, i + 0x8000))
  }
  return { width: grid.width, height: grid.height, costs: btoa(s) }
}

export class NavGridDataStore extends AssetStore<NavGridData, 'NavGridData'> {
  constructor() {
    super('NavGridData')
  }
}

export const NavGridDatas = defineResource<NavGridDataStore>('nav/NavGridDatas', {
  description: 'Loaded navgrid data by guid.',
  init: () => new NavGridDataStore(),
})

export const NavGridDataAssetType = defineAssetType<NavGridData>('NavGridData', {
  store: NavGridDatas,
  load: (artifact) => navGridFromJson(artifact.json),
  update: (existing, next) => existing.copyFrom(next),
})

/** `*.navgrid.json`: walkable cells and costs for a NavGrid. */
export const NavGridDataImporter = defineDataAsset('NavGridData', NavGridDataSchema, {
  extension: 'navgrid',
})
