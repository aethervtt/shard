import { affine, type Entity, type Query, type World } from '@aethervtt/shard-core'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Camera3d } from './camera'
import { sphereSweepIn } from './instances'
import { DirectionalLight, LightingSettings, readShadowSun, type ShadowSun } from './lights'
import { Views } from './plugin'
import {
  type CascadeCamera,
  createCascadeGeometry,
  fitCascadeGeometry,
  sliceFrustum,
  sweptInSlice,
} from './shadow-volume'
import { pointTanHalf, ShadowsResource } from './shadows'
import { cameraOf } from './view'

// casterRelevant (0116): whether a sphere's shadow can be in a camera's view this frame, for game
// code deciding what it may stop animating or drawing (0115). It fits the camera's cascades with
// the renderer's own function from the same inputs (the camera's GlobalTransform and Camera3d,
// the sun's), so after transform propagation it agrees with that frame's shadow views exactly.

interface CameraFit {
  readonly cam: CascadeCamera & {
    view: Float32Array
    position: Float32Array
    forward: Float32Array
    far: number
  }
  readonly geometry: ReturnType<typeof createCascadeGeometry>
  readonly sweep: Float32Array
  readonly planes: Float32Array
  readonly world: Float32Array
  readonly inverse: Float32Array
  /** What the geometry was fitted from: refit only when any of it changes. */
  readonly inputs: Float64Array
  readonly last: Float64Array
}

const INPUTS = 12 + 7 + 3 + 6

/** Per world: each camera's fit, the sun as last read, and the query that finds it. */
interface Scratch {
  fits: Map<Entity, CameraFit>
  sun: ShadowSun
  suns: Query
}

const scratches = new WeakMap<World, Scratch>()

function scratchOf(world: World): Scratch {
  let s = scratches.get(world)
  if (!s) {
    s = {
      fits: new Map(),
      suns: world.query({ with: [DirectionalLight, GlobalTransform] }),
      sun: {
        entity: -1 as Entity,
        direction: new Float32Array(3),
        count: 4,
        maxDistance: 150,
        splitLambda: 0.8,
        step: 0,
        farEvery: 4,
        minCasterTexels: 1,
        bias: 0,
        normalBias: 0,
        softness: 0,
        cached: false,
      },
    }
    scratches.set(world, s)
  }
  return s
}

const sphere = new Float32Array(4)
const f32 = Math.fround

function fitOf(world: World, camera: Entity): CameraFit {
  const fits = scratchOf(world).fits
  let fit = fits.get(camera)
  if (!fit) {
    fit = {
      cam: {
        view: new Float32Array(16),
        position: new Float32Array(3),
        forward: new Float32Array(3),
        orthographic: false,
        fovY: 1,
        aspect: 1,
        orthoHeight: 1,
        near: 0.1,
        far: 0,
      },
      geometry: createCascadeGeometry(),
      sweep: new Float32Array(4),
      planes: new Float32Array(24),
      world: new Float32Array(12),
      inverse: new Float32Array(12),
      inputs: new Float64Array(INPUTS),
      last: new Float64Array(INPUTS).fill(Number.NaN),
    }
    fits.set(camera, fit)
  }
  return fit
}

/** The shadowed sun as `prepare-lights` picks it: the first with shadows among the first four. */
function shadowSun(suns: Query, out: ShadowSun): ShadowSun | undefined {
  let seen = 0
  const tables = suns.tables
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t]!
    const shadows = table.column(DirectionalLight, 'shadows')
    for (let i = 0; i < table.count && seen < 4; i++, seen++) {
      if (shadows[i] !== 0) return readShadowSun(out, table, i)
    }
  }
  return undefined
}

/**
 * Whether the shadow of a sphere (world center and radius) can be in `camera`'s view this frame:
 * its light-swept capsule meets the camera's frustum slice of some cascade of the shadowed
 * directional light, or the camera drives local shadows (0106) and its shadow from a shadowed spot or
 * point light reaches the camera's frustum. No size or occlusion test: false means no shadow of it
 * can be on screen. Unknown, inactive or never-rendered cameras, and cameras with no shadowed
 * light, return false. Allocation-free after the first call for a camera.
 *
 * Call it after transform propagation (PostUpdate) to see this frame's camera and sun; earlier it
 * sees them where propagation last left them.
 */
export function casterRelevant(
  world: World,
  camera: Entity,
  center: ArrayLike<number>,
  radius: number,
): boolean {
  if (!world.isAlive(camera)) return false
  const table = world.entityTableUnchecked(camera)
  if (!table.has(Camera3d) || !table.has(GlobalTransform)) return false
  const row = world.entityRowUnchecked(camera)
  if (table.column(Camera3d, 'active')[row] === 0) return false
  // The view's aspect comes from its target, known once it has rendered.
  // The view's aspect comes from its target, known once it has rendered. The camera with the
  // lowest order drives local shadows (as the forward queue ranks them).
  const views = world.resource(Views).list
  let aspect = 0
  let order = 0
  for (let v = 0; v < views.length; v++) {
    const data = cameraOf(views[v]!)
    if (data?.entity === camera) {
      aspect = data.aspect
      order = views[v]!.order
    }
  }
  if (aspect === 0) return false
  let main = true
  for (let v = 0; v < views.length; v++) {
    const data = cameraOf(views[v]!)
    if (data && data.entity !== camera && views[v]!.order < order) main = false
  }
  const fit = fitOf(world, camera)
  readCamera(fit, table, row, aspect)
  sphere[0] = center[0]!
  sphere[1] = center[1]!
  sphere[2] = center[2]!
  sphere[3] = radius
  const scratch = scratchOf(world)
  const sun = shadowSun(scratch.suns, scratch.sun)
  const settings = world.resource(LightingSettings)
  if (sun) {
    const geo = fit.geometry
    if (inputsChanged(fit, sun, settings.cascadeMapSize))
      fitCascadeGeometry(geo, fit.cam, sun, settings.cascadeMapSize)
    for (let i = 0; i < geo.count; i++) {
      const texel = geo.texel[i]!
      const margin = texel * (2 + sun.softness + sun.normalBias)
      fit.sweep[0] = geo.basis[6]!
      fit.sweep[1] = geo.basis[7]!
      fit.sweep[2] = geo.basis[8]!
      fit.sweep[3] = geo.centers[i * 3 + 2]! + geo.radius[i]!
      const r = f32(sphere[3]! + margin)
      if (sweptInSlice(geo.slices, i * 24, fit.sweep, sphere[0]!, sphere[1]!, sphere[2]!, r))
        return true
    }
  }
  if (!main) return false
  // Local shadows the camera drives: this frame's assignment if it ran, else the last.
  const local = world.tryResource(ShadowsResource)?.local
  if (!local || (local.spots.length === 0 && local.points.length === 0)) return false
  const cam = fit.cam
  sliceFrustum(fit.planes, 0, cam, cam.near, cam.far > 0 ? cam.far : 1e7)
  const size = settings.shadowMapSize
  for (let i = 0; i < local.spots.length; i++) {
    const r = local.spots[i]
    if (r && localReaches(fit, r, local.spotParams[i * 4]!, size)) return true
  }
  const tanHalf = pointTanHalf(size)
  for (let i = 0; i < local.points.length; i++) {
    const r = local.points[i]
    if (r && localReaches(fit, r, tanHalf, size)) return true
  }
  return false
}

/** Whether the camera, sun or map size changed since the geometry was last fitted. */
function inputsChanged(fit: CameraFit, sun: ShadowSun, size: number): boolean {
  const a = fit.inputs
  const cam = fit.cam
  for (let k = 0; k < 12; k++) a[k] = fit.world[k]!
  a[12] = cam.orthographic ? 1 : 0
  a[13] = cam.fovY
  a[14] = cam.aspect
  a[15] = cam.orthoHeight
  a[16] = cam.near
  a[17] = cam.far
  a[18] = size
  a[19] = sun.direction[0]!
  a[20] = sun.direction[1]!
  a[21] = sun.direction[2]!
  a[22] = sun.count
  a[23] = sun.maxDistance
  a[24] = sun.splitLambda
  a[25] = sun.step
  a[26] = 0
  a[27] = 0
  const b = fit.last
  let changed = false
  for (let k = 0; k < INPUTS; k++) {
    if (a[k] !== b[k]) {
      changed = true
      b[k] = a[k]!
    }
  }
  return changed
}

function localReaches(
  fit: CameraFit,
  r: {
    x: number
    y: number
    z: number
    range: number
    shadowSoftness: number
    shadowNormalBias: number
  },
  tanHalf: number,
  size: number,
): boolean {
  const texel = (2 * r.range * tanHalf) / size
  const margin = texel * (2 + r.shadowSoftness + r.shadowNormalBias)
  fit.sweep[0] = r.x
  fit.sweep[1] = r.y
  fit.sweep[2] = r.z
  fit.sweep[3] = r.range
  return sphereSweepIn(fit.planes, 2, fit.sweep, sphere, margin)
}

/** The camera's view, position and projection, computed as camera extraction does. */
function readCamera(
  fit: CameraFit,
  table: ReturnType<World['entityTableUnchecked']>,
  row: number,
  aspect: number,
): void {
  const cam = fit.cam
  const g = table.column(GlobalTransform, 'matrix')
  const o = row * 12
  for (let k = 0; k < 12; k++) fit.world[k] = g[o + k]!
  affine.invert(fit.inverse, fit.world)
  affine.toMat4(cam.view, fit.inverse)
  affine.getTranslationAt(cam.position, g, o)
  const fx = -g[o + 2]!
  const fy = -g[o + 6]!
  const fz = -g[o + 10]!
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
  cam.forward[0] = fx / fl
  cam.forward[1] = fy / fl
  cam.forward[2] = fz / fl
  cam.orthographic = table.column(Camera3d, 'projection')[row] !== 0
  cam.fovY = (table.column(Camera3d, 'fovY')[row]! * Math.PI) / 180
  cam.near = table.column(Camera3d, 'near')[row]!
  cam.orthoHeight = table.column(Camera3d, 'orthoHeight')[row]!
  cam.far = cam.orthographic ? table.column(Camera3d, 'far')[row]! : 0
  cam.aspect = aspect
}
