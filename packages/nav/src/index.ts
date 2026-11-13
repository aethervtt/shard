import type { World } from '@aethervtt/shard-core'
import { NavAreas, type NavAreasValue } from './components'

export { navAgents } from './agents'
export {
  bakeNavigation,
  liveTileKeys,
  navBake,
  navReady,
  navReadyIn,
  type TileJob,
  updateNavigation,
  whenNavReady,
} from './bake'
export {
  BLOCKED,
  buildSlots,
  NO_ROW,
  navAgentAt,
  navAgentRecord,
  SlotSet,
  setNavMover,
} from './breach'
export { loadNavCache, NAV_CACHE_PATH, NavCache, NavCacheStore, saveNavCache } from './cache'
export {
  AGENT_STATUSES,
  type AgentStatus,
  DRIVES,
  type Drive,
  GRID_SOURCES,
  type GridSource,
  MAX_NAV_FILTERS,
  NAV_TIERS,
  NavAgent,
  type NavAgentEventData,
  NavAgentState,
  NavAreas,
  type NavAreasValue,
  NavArrived,
  NavBreach,
  type NavBreachValue,
  NavBudget,
  type NavBudgetValue,
  NavFilters,
  type NavFiltersValue,
  type NavFilterValue,
  NavFlowField,
  NavGateAhead,
  type NavGateAheadData,
  NavGateBlocked,
  type NavGateBlockedData,
  NavGrid,
  NavGridDataAssetType,
  NavGridDataImporter,
  NavGridDataSchema,
  NavGridDataStore,
  NavGridDatas,
  NavMesh,
  NavSource,
  NavTier,
  type NavTierName,
  NavUnreachable,
  NavWorkers,
  navGridFromJson,
  navGridToJson,
  OffMeshLink,
} from './components'
export {
  FlowData,
  FlowField,
  flowAim,
  NavFlowState,
  NavGraph,
  navFlow,
  planFilter,
} from './flow'
export { flowGoal, flowOf, NavFlows } from './flow-state'
export {
  DIAGONAL_MODES,
  type DiagonalMode,
  type GridHit,
  GridSearch,
  gridTrace,
  NavGridData,
  nearestWalkable,
  smoothGridPath,
  traceSegment,
} from './grid'
export { describeNav, navMethods } from './methods'
export {
  type BakeStats,
  breachCostOf,
  configureFilter,
  DEFAULT_BREACH_COST,
  filterProblem,
  NavMeshRuntime,
  type TileEntry,
} from './navmesh'
export { navGridPlugin, navPlugin } from './plugin'
export {
  createNavPath,
  createNavRayHit,
  type FindPathOptions,
  findPath,
  type NavPath,
  type NavRayHit,
  type NavTarget,
  navAt,
  navRaycast,
  nearestPoint,
  PATH_STATUSES,
  type PathStatus,
} from './query'
export {
  areaFlags,
  type BakeSettings,
  EXACT_AREAS,
  GATE_BITS,
  GATE_CLOSED,
  GATE_CUSTOM,
  GATE_LOCKED,
  GATE_SOLID,
  GATE_STATES,
  type GateState,
  gatePolyArea,
  gatePolyFlags,
  loadRecast,
  MAX_GATE_AREA,
  SHUT_AREA,
} from './recast'
export {
  insideConvex,
  type NavContribution,
  type NavGate,
  type NavGateSpec,
  NavGates,
  NavShapes,
} from './sources'
export { type AgentRecord, type GridRecord, LINKS, Nav, NavState, navState } from './state'
export { Mover, NavMoverState, navSteer, navTiers } from './steer'
export { NavMovers, navMoverTier } from './steer-state'
export { navTiersPlugin } from './tiers-plugin'

/** Replaces the navmesh area costs; agents and queries use them from the next frame. */
export function setNavAreas(world: World, areas: NavAreasValue): void {
  world.insertResource(NavAreas, { ...areas })
}
