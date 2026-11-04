export {
  buildShape,
  gatherWaterBodies,
  insideShape,
  MAX_OUTLINE_POINTS,
  MAX_WATER_BODIES,
  WaterBodies,
  WaterBodiesState,
  type WaterBodyRecord,
  type WaterShape,
} from './bodies'
export {
  GROUND_TEXELS_PER_FRAME,
  INFO_SNAP,
  InfoClipmap,
  levelTexel,
  placeRings,
  RING_BASE_CELL,
  ringCell,
  ringLevel,
  SurfaceRings,
} from './clipmap'
export { WATER_KINDS, WaterBody, type WaterKind, WaterSpline } from './components'
export { readWaterInfo, waterInfoView } from './debug'
export { describeWater, waterMethods } from './methods'
export {
  registerOpticsPresets,
  resolveOptics,
  WATER_OPTICS_PRESETS,
  WaterOptics,
  type WaterOpticsPreset,
  type WaterOpticsValue,
  waterOptics,
} from './optics'
export { prepareWater, waterPlugin } from './plugin'
export {
  bodyAt,
  groundAt,
  heightfieldGround,
  type WaterSample,
  waterAt,
  waterSample,
} from './query'
export {
  infoNode,
  WATER_PHASE,
  WaterGpu,
  WaterRender,
  type WaterRenderState,
  waterDepthNode,
  waterNode,
  waterRenderOf,
} from './render'
export { bakeRipples, RIPPLE_SIZE } from './ripples'
export {
  HORIZON,
  INFO_LEVELS,
  INFO_SIZE,
  INFO_TEXEL,
  MAX_RINGS,
  MORPH_START,
  NO_GROUND,
  NO_WATER,
  RING_CELLS,
  WATER_SHADERS,
  WATER_UNIFORM_VEC4S,
} from './shaders'
