export {
  addRemoved,
  isRemoved,
  Prop,
  propIdentity,
  Removed,
  type RemovedProps,
  removedKey,
  ScatterBudget,
  type ScatterBudgetValue,
  ScatterChunk,
  ScatterSurface,
} from './components'
export {
  applyWind,
  clearFoliage,
  FoliageRule,
  updateFoliage,
  Wind,
  type WindValue,
} from './foliage'
export { GENERATOR_LOOKS, SCATTER_SHADERS, SWAY_WGSL, Vegetation } from './material'
export { HeightIndex, MeshSurface } from './mesh-surface'
export { resolveSurface, samplePlacements, scatterMethods } from './methods'
export { foliageChunksOverlay, scatterOverlay } from './overlays'
export { cellsPerChunk, nodeMetres, PlanetSurface, ruleDepth, writeRotation } from './planet'
export { type ScatterPluginOptions, scatterPlugin, updateScatter } from './plugin'
export { scatterSetPreview } from './preview'
export {
  type CompiledItem,
  type CompiledRule,
  cellRandom,
  cellSize,
  compileRules,
  FOLIAGE,
  jitterFor,
  MAX_FOLIAGE_PER_CHUNK,
  MAX_PROPS_PER_CHUNK,
  PROP,
  type SetSource,
} from './rules'
export {
  type ChunkState,
  defaultMaterial,
  finalPlacements,
  type ItemVariant,
  neighborChunks,
  PLACEMENT_DELAY,
  type RuleStats,
  Scatter,
  ScatterState,
  SurfaceScatter,
} from './runtime'
export {
  PROP_COLLIDERS,
  type PropCollider,
  type ScatterItemValue,
  type ScatterRuleValue,
  ScatterSet,
  type ScatterSetValue,
} from './set'
export {
  type ChunkPlacements,
  type FoliagePatch,
  P_CELL,
  P_ITEM,
  P_QX,
  P_RADIUS,
  P_SCALE,
  P_SHADE,
  P_VARIANT,
  P_X,
  type PatchJob,
  PLACEMENT_STRIDE,
  type PlacementJob,
  type Surface,
  type SurfaceChunk,
} from './surface'
