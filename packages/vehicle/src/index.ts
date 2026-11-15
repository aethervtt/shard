export {
  VEHICLE_CLASS_VALUES,
  VEHICLE_CLASSES,
  type VehicleClass,
  type VehicleClassValue,
} from './classes'
export {
  ASSIST_PRESETS,
  type AxleValue,
  CLUTCH_MODES,
  DEFAULT_AXLES,
  DIFFERENTIALS,
  type Differential,
  ENGINE_EVENTS,
  NO_GEAR,
  PROBES,
  SEAT_ROLES,
  SIDES,
  TRANSMISSION_MODES,
  Vehicle,
  VehicleAssists,
  VehicleConfig,
  type VehicleConfigValue,
  VehicleEngine,
  type VehicleEngineData,
  VehicleEngineEvent,
  type VehicleHitData,
  VehicleHitEvent,
  VehicleInput,
  type VehicleLandedData,
  VehicleLandedEvent,
  VehicleSeat,
  type VehicleSeatData,
  VehicleSeatEvent,
  type VehicleShiftData,
  VehicleShiftEvent,
  VehicleState,
  VehicleTransmission,
  VehicleWheel,
  type VehicleWheelData,
  VehicleWheelEvent,
  WheelState,
} from './components'
export {
  type FoundWheel,
  findWheels,
  type GenerateVehicleOptions,
  type GltfJson,
  generateVehicle,
  type ModelNode,
  modelNodesFromGltf,
} from './gen'
export { groundTiles } from './ground'
export {
  MANEUVERS,
  type Maneuver,
  type ManeuverStage,
  runManeuver,
  testVehicle,
  type VehicleTestReport,
} from './maneuvers'
export { describeVehicle, testTemplate, vehicleMethods } from './methods'
export { vehicleOverlay } from './overlay'
export {
  buildVehicle,
  VehicleSims,
  VehicleSimsResource,
  vehiclePlugin,
  vehicleSystem,
  wheelVisualSystem,
} from './plugin'
export { ASSIST_PRESET_VALUES } from './presets'
export { enterVehicle, exitVehicle, seatOf, vehicleOf } from './seats'
export {
  checkCurve,
  checkGears,
  gearRatio,
  sprungMasses,
  VehicleSim,
  type WheelSim,
} from './sim'
export { type SpawnedVehicle, type SpawnVehicleOptions, spawnVehicle } from './spawn'
export {
  captureVehicle,
  type PrefabEntityJson,
  rideHeight,
  spawnTemplate,
  templateFromPrefab,
  type VehicleTemplate,
} from './template'
export {
  gripCurve,
  registerTirePresets,
  resolveTire,
  TIRE_PRESETS,
  Tire,
  type TireCurve,
  type TirePreset,
  type TireValue,
  tirePreset,
} from './tire'
