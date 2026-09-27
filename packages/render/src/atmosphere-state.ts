import { defineResource, type Entity, type ShardError } from '@aethervtt/shard-core'
import type { AtmosphereModel, Lut } from './atmosphere-model'

// What atmospheres a camera sees, as data: the environment and the forward pass read it, and
// atmospherePlugin fills it. Kept apart from the atmosphere code so core render doesn't carry it.

/** An atmosphere as the renderer tracks it: a component's, or a ProceduralSky camera's. */
export interface AtmosphereRecord {
  /** The atmosphere's entity; for ProceduralSky, the camera's. */
  entity: Entity
  /** A ProceduralSky (or DefaultEnvironment.sky) mapped onto an Earth atmosphere. */
  wrapper: boolean
  model: AtmosphereModel
  /** Bumped when the parameters change (the LUTs are recomputed). */
  version: number
  /** thickness ≤ 0 and the like: not drawn. */
  problem: ShardError | undefined
  /** Center, relative to the floating origin (m). */
  center: Float64Array
  /** The frame it was last seen (records unseen for a while are dropped). */
  seen: number
  /** CPU LUTs for `atmosphere.sample` (built on first use, per version). */
  cpu: { version: number; transmittance: Lut; multiscatter: Lut } | undefined
  /** GPU LUT layer, and the version it holds (`atmosphere-nodes`). */
  layer: number
  layerVersion: number
}

/** The atmospheres a camera sees this frame. */
export interface CameraAtmosphere {
  camera: Entity
  /** The atmosphere the camera is in, or else the nearest one on screen. */
  primary: AtmosphereRecord | undefined
  inside: boolean
  /** Camera height above the primary's bottomRadius (m). */
  altitude: number
  /** Composite order, far to near, primary last (at most 4). */
  list: AtmosphereRecord[]
  /** Camera relative to each listed atmosphere's center (km, xyz) and inside (w). */
  origins: Float64Array
  /** Per directional light (as the light buffer orders them): transmittance rgb toward it. */
  sunTransmittance: Float32Array
  /** The two brightest directional lights: light index, direction, illuminance, disk radius. */
  suns: { count: number; index: Int32Array; data: Float32Array }
  /** Sky-view frame: up, azimuth 0 (toward the sun), azimuth 90°. */
  frame: Float64Array
  /** Draw the sky (and the environment map behind it); -1: don't. */
  background: number
  aerialPerspective: boolean
  skyViewSize: [number, number]
  froxels: [number, number, number]
  maxDistance: number
  /** Fog on this camera was ignored (render/fog-with-atmosphere). */
  fogIgnored: boolean
  /** Changes when the IBL bake is out of date (atmosphere, altitude 2%, up and suns 0.25°). */
  bakeKey: string
  /** Pixels across (radius) of each listed atmosphere's top sphere. */
  pixels: Float64Array
}

export class AtmosphereStore {
  readonly records = new Map<Entity, AtmosphereRecord>()
  /** ProceduralSky wrappers, by camera. */
  readonly wrappers = new Map<Entity, AtmosphereRecord>()
  readonly cameras = new Map<Entity, CameraAtmosphere>()
  frame = 0
  /** Warnings and errors already logged, so each shows once. */
  readonly logged = new Set<string>()
}

export const Atmospheres = defineResource<AtmosphereStore>('render/Atmospheres', {
  description: 'Atmospheres in the world and what each camera sees of them (spec 0044).',
  init: () => new AtmosphereStore(),
})
