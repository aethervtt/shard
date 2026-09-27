import type { World } from '@aethervtt/shard-core'
import { NavAreas, type NavAreasValue } from './components'

export { navAgents } from './agents'
export { liveTileKeys, navBake, updateNavigation } from './bake'
export { loadNavCache, NAV_CACHE_PATH, NavCache, NavCacheStore, saveNavCache } from './cache'
export {
  AGENT_STATUSES,
  type AgentStatus,
  DRIVES,
  type Drive,
  GRID_SOURCES,
  type GridSource,
  NavAgent,
  type NavAgentEventData,
  NavAgentState,
  NavAreas,
  type NavAreasValue,
  NavArrived,
  NavGrid,
  NavGridDataAssetType,
  NavGridDataImporter,
  NavGridDataSchema,
  NavGridDataStore,
  NavGridDatas,
  NavMesh,
  NavSource,
  NavUnreachable,
  navGridFromJson,
  navGridToJson,
  OffMeshLink,
} from './components'
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
export { type BakeStats, NavMeshRuntime, type TileEntry } from './navmesh'
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
export { type BakeSettings, loadRecast } from './recast'
export { type AgentRecord, type GridRecord, Nav, NavState, navState } from './state'

/** Replaces the navmesh area costs; agents and queries use them from the next frame. */
export function setNavAreas(world: World, areas: NavAreasValue): void {
  world.insertResource(NavAreas, { ...areas })
}
