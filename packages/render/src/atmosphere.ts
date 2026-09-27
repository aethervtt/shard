import {
  defineComponent,
  defineResource,
  defineSchema,
  defineSystem,
  type Entity,
  findComponent,
  ShardError,
  t,
  type World,
} from '@shard/core'
import { type AppMethod, LogResource } from '@shard/runtime'
import { GlobalTransform } from '@shard/transform'
import {
  type AtmosphereModel,
  createModel,
  createSkySample,
  integrateSky,
  type Lut,
  type ModelSun,
  multiscatterLut,
  transmittanceLut,
  transmittanceToTop,
} from './atmosphere-model'
import { Camera3d } from './camera'
import { DefaultEnvironment, EnvironmentMap, ProceduralSky } from './environment'
import { DirectionalLight, Lights, MAX_DIRECTIONAL } from './lights'
import { Views } from './plugin'
import { PostEffect, postAliases } from './post'
import { type CameraData, cameraOf, viewAliases } from './view'

// --- components ------------------------------------------------------------------------------

export const Atmosphere = defineComponent(
  'render/Atmosphere',
  {
    bottomRadius: t.f64({
      min: 0,
      unit: 'm',
      description:
        "Where the atmosphere starts: the visible surface, or a gas giant's cloud top. 0: the entity's terrain/Planet radius, else 6 360 km (Earth 6 360 000, Mars 3 389 500).",
    }),
    thickness: t.f32({
      default: 60_000,
      unit: 'm',
      description: 'Top radius = bottomRadius + thickness. Earth 60 000–100 000, Mars 80 000.',
    }),
    rayleighScattering: t.vec3({
      default: [5.802e-6, 13.558e-6, 33.1e-6],
      min: 0,
      unit: '1/m',
      description:
        'Molecular scattering at the bottom, red/green/blue. Blue above red makes a blue sky and orange sunsets; swap them for a red sky with blue sunsets. Earth [5.8e-6, 13.6e-6, 33.1e-6], Mars about 2% of that.',
    }),
    rayleighScale: t.f32({
      default: 8000,
      min: 1,
      unit: 'm',
      description:
        'Rayleigh scale height: the air thins by e every this many metres. Earth 8 000, Mars 11 100.',
    }),
    mieScattering: t.f32({
      default: 3.996e-6,
      min: 0,
      unit: '1/m',
      description:
        'Aerosol (dust, haze) scattering at the bottom: the white glow around the sun and hazy horizons. Earth 4e-6 (very clear) to 1e-4 (hazy), Mars dust 3e-5.',
    }),
    mieAbsorption: t.f32({
      default: 4.4e-6,
      min: 0,
      unit: '1/m',
      description: 'Aerosol absorption: darker, dirtier haze. Earth 4.4e-6.',
    }),
    mieScale: t.f32({
      default: 1200,
      min: 1,
      unit: 'm',
      description: 'Aerosol scale height. Earth 1 200, Mars dust 11 000.',
    }),
    mieG: t.f32({
      default: 0.8,
      min: -0.99,
      max: 0.99,
      description: 'Aerosol forward scattering: 0 even, 0.8 a tight bright halo around the sun.',
    }),
    mieGOffset: t.vec3({
      default: [0, 0, 0],
      min: -0.5,
      max: 0.5,
      description:
        "Added to mieG per channel (red, green, blue). Fine dust that scatters blue more forward, like Mars' [-0.15, 0, 0.2], gives a blue glow around a setting sun.",
    }),
    absorption: t.vec3({
      default: [0.65e-6, 1.881e-6, 0.085e-6],
      min: 0,
      unit: '1/m',
      description:
        "Ozone-like absorption in a tent-shaped layer, red/green/blue: Earth's ozone absorbs green and red, keeping twilight skies blue. Methane-like [3e-6, 0.3e-6, 0] gives Neptune blues.",
    }),
    absorptionCenter: t.f32({
      default: 25_000,
      unit: 'm',
      description:
        'Altitude of the absorbing layer. Earth 25 000; 0 with a wide layer for dust near the ground.',
    }),
    absorptionWidth: t.f32({
      default: 30_000,
      min: 1,
      unit: 'm',
      description: 'Full width of the absorbing layer. Earth 30 000.',
    }),
    groundAlbedo: t.color({
      default: [0.3, 0.3, 0.3, 1],
      description:
        'Surface color below the horizon and for light bounced into the sky. Earth 0.3, Mars [0.45, 0.25, 0.15].',
    }),
    intensity: t.f32({
      default: 1,
      min: 0,
      description: 'Artistic multiplier on the sky and haze brightness. 1 is physical.',
    }),
    deckDepth: t.f32({
      min: 0,
      unit: 'm',
      description:
        'Gas giants: the depth below bottomRadius over which haze thickens to opaque cloud. 0 (default): a solid surface at bottomRadius.',
    }),
  },
  {
    description:
      "A planet's atmosphere (Hillaire 2020): the sky from the surface, flight, and orbit, haze over distant terrain, and sunlight dimmed and reddened on its way down. Centered on the entity's origin. Presets (AtmospherePresets): earth, mars, thin, thick-haze, alien-violet, gas-giant.",
  },
)

export const AtmosphereSettings = defineComponent(
  'render/AtmosphereSettings',
  {
    aerialPerspective: t.bool({
      default: true,
      description: 'Haze over geometry (distant terrain turns blue). False: only the sky.',
    }),
    skyViewSize: t.vec2({
      default: [192, 108],
      min: 16,
      max: 1024,
      description: 'Sky-view LUT size (azimuth × elevation).',
    }),
    froxels: t.vec3({
      default: [32, 32, 32],
      min: 4,
      max: 128,
      description: 'Aerial-perspective volume size (x, y, depth slices).',
    }),
    maxDistance: t.f32({
      default: 32_000,
      min: 100,
      unit: 'm',
      description:
        'The froxel volume reaches at least this far, and from altitude on to the horizon and the peaks past it; beyond it the haze is raymarched per pixel.',
    }),
  },
  { description: "A camera's atmosphere quality settings.", requires: [Camera3d] },
)

export interface AtmosphereValue {
  bottomRadius: number
  thickness: number
  rayleighScattering: [number, number, number]
  rayleighScale: number
  mieScattering: number
  mieAbsorption: number
  mieScale: number
  mieG: number
  mieGOffset: [number, number, number]
  absorption: [number, number, number]
  absorptionCenter: number
  absorptionWidth: number
  groundAlbedo: [number, number, number, number]
  intensity: number
  deckDepth: number
}

const EARTH: AtmosphereValue = {
  bottomRadius: 0,
  thickness: 60_000,
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
  rayleighScale: 8000,
  mieScattering: 3.996e-6,
  mieAbsorption: 4.4e-6,
  mieScale: 1200,
  mieG: 0.8,
  mieGOffset: [0, 0, 0],
  absorption: [0.65e-6, 1.881e-6, 0.085e-6],
  absorptionCenter: 25_000,
  absorptionWidth: 30_000,
  groundAlbedo: [0.3, 0.3, 0.3, 1],
  intensity: 1,
  deckDepth: 0,
}

/**
 * Atmosphere presets: whole component values (bottomRadius 0: the planet's radius). Apply one with
 * `world.set(e, Atmosphere, AtmospherePresets.mars)` or copy its values into a scene.
 */
export const AtmospherePresets = {
  earth: EARTH,
  /** Thin CO₂ and fine dust: butterscotch by day, a blue glow around the setting sun. */
  mars: {
    ...EARTH,
    thickness: 80_000,
    rayleighScattering: [0.11e-6, 0.26e-6, 0.63e-6],
    rayleighScale: 11_100,
    mieScattering: 3e-5,
    mieAbsorption: 0.3e-5,
    mieScale: 11_000,
    mieG: 0.72,
    mieGOffset: [-0.15, 0, 0.2],
    absorption: [0.3e-5, 0.8e-5, 1.6e-5],
    absorptionCenter: 0,
    absorptionWidth: 44_000,
    groundAlbedo: [0.45, 0.25, 0.15, 1],
  },
  /** A small world's thin air: a dark blue sky and faint haze. */
  thin: {
    ...EARTH,
    thickness: 30_000,
    rayleighScattering: [1.45e-6, 3.39e-6, 8.28e-6],
    rayleighScale: 5000,
    mieScattering: 0.4e-6,
    mieAbsorption: 0.44e-6,
    absorption: [0, 0, 0],
  },
  /** Dense aerosols: a pale sky and distant hills lost in haze a few km out. */
  'thick-haze': {
    ...EARTH,
    mieScattering: 8e-5,
    mieAbsorption: 2e-5,
    mieScale: 3000,
    mieG: 0.7,
  },
  /** Red and blue scatter, green passes: a violet sky with green-gold sunsets. */
  'alien-violet': {
    ...EARTH,
    rayleighScattering: [26e-6, 6e-6, 33.1e-6],
  },
  /** Hydrogen and helium over a cloud deck: tall, weakly absorbing; raise absorption for Neptune. */
  'gas-giant': {
    ...EARTH,
    bottomRadius: 69_911_000,
    thickness: 2_000_000,
    rayleighScattering: [1.4e-6, 3.3e-6, 8e-6],
    rayleighScale: 27_000,
    mieScattering: 1e-6,
    mieAbsorption: 0.2e-6,
    mieScale: 20_000,
    absorption: [0.3e-6, 0.03e-6, 0],
    absorptionCenter: 0,
    absorptionWidth: 400_000,
    groundAlbedo: [0.8, 0.7, 0.55, 1],
    deckDepth: 200_000,
  },
} as const satisfies Record<string, AtmosphereValue>

export type AtmospherePreset = keyof typeof AtmospherePresets

// --- records ---------------------------------------------------------------------------------

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

function createRecord(entity: Entity, wrapper: boolean): AtmosphereRecord {
  return {
    entity,
    wrapper,
    model: createModel(),
    version: 0,
    problem: undefined,
    center: new Float64Array(3),
    seen: 0,
    cpu: undefined,
    layer: -1,
    layerVersion: -1,
  }
}

function createCameraAtmosphere(camera: Entity): CameraAtmosphere {
  const sunTransmittance = new Float32Array(16).fill(1)
  return {
    camera,
    primary: undefined,
    inside: false,
    altitude: 0,
    list: [],
    origins: new Float64Array(16),
    sunTransmittance,
    suns: { count: 0, index: new Int32Array(2), data: new Float32Array(16) },
    frame: new Float64Array(9),
    background: -1,
    aerialPerspective: true,
    skyViewSize: [192, 108],
    froxels: [32, 32, 32],
    maxDistance: 32_000,
    fogIgnored: false,
    bakeKey: '',
    pixels: new Float64Array(4),
  }
}

const scratchModel = createModel()

/** Writes a model from component values; returns whether it differs from `into`. */
function writeModel(
  v: AtmosphereValue,
  bottomMeters: number,
  sky: { turbidity: number; rayleigh: number; mie: number } | undefined,
  into: AtmosphereModel,
): boolean {
  const m = scratchModel
  const km = 1000
  m.bottom = bottomMeters / km
  m.top = (bottomMeters + v.thickness) / km
  m.ground = Math.max((bottomMeters - v.deckDepth) / km, m.bottom * 0.05)
  const ray = sky ? sky.rayleigh : 1
  // ProceduralSky's turbidity 2 is Earth's default aerosol; mie multiplies on top.
  const mie = sky ? (sky.mie * sky.turbidity) / 2 : 1
  for (let c = 0; c < 3; c++) {
    m.rayleigh[c] = v.rayleighScattering[c]! * km * ray
    m.mieG[c] = Math.min(0.99, Math.max(-0.99, v.mieG + v.mieGOffset[c]!))
    m.absorption[c] = v.absorption[c]! * km
    m.albedo[c] = v.groundAlbedo[c]!
  }
  m.rayleighInvScale = km / v.rayleighScale
  m.mieScattering = v.mieScattering * km * mie
  m.mieAbsorption = v.mieAbsorption * km * mie
  m.mieInvScale = km / v.mieScale
  m.absorptionCenter = v.absorptionCenter / km
  m.absorptionWidth = v.absorptionWidth / km
  m.intensity = v.intensity
  let changed = false
  const keys = [
    'bottom',
    'top',
    'ground',
    'rayleighInvScale',
    'mieScattering',
    'mieAbsorption',
    'mieInvScale',
    'absorptionCenter',
    'absorptionWidth',
    'intensity',
  ] as const
  for (const k of keys) {
    if (into[k] !== m[k]) {
      into[k] = m[k]
      changed = true
    }
  }
  for (const k of ['rayleigh', 'mieG', 'absorption', 'albedo'] as const) {
    for (let c = 0; c < 3; c++) {
      if (into[k][c] !== m[k][c]) {
        into[k][c] = m[k][c]!
        changed = true
      }
    }
  }
  return changed
}

/** The model of an atmosphere component's values (with bottomRadius already resolved), in km. */
export function atmosphereModel(value: AtmosphereValue, bottomRadius: number): AtmosphereModel {
  const m = createModel()
  writeModel(value, bottomRadius, undefined, m)
  return m
}

let planetDef: ReturnType<typeof findComponent> | null | undefined
/** A terrain/Planet's radius on the entity (the default bottomRadius), without importing terrain. */
function planetRadius(world: World, entity: Entity): number | undefined {
  if (planetDef === undefined || planetDef === null) {
    try {
      planetDef = findComponent('terrain/Planet') ?? null
    } catch {
      planetDef = null
    }
  }
  if (!planetDef) return undefined
  const v = world.tryGet(entity, planetDef as never) as { radius?: number } | undefined
  return v?.radius
}

const EARTH_RADIUS = 6_360_000

function logOnce(store: AtmosphereStore, key: string, fn: () => void): void {
  if (store.logged.has(key)) return
  store.logged.add(key)
  fn()
}

/** Reads every Atmosphere into a record; bumps versions when parameters change. */
function updateRecords(
  world: World,
  store: AtmosphereStore,
  q: ReturnType<World['query']>,
  since: number,
): void {
  // An automatic bottomRadius follows its planet; check it now and then.
  const recheck = store.frame % 30 === 0
  let seenThisFrame = 0
  for (const table of q.tables) {
    const g = table.column(GlobalTransform, 'matrix')
    const bottom = table.column(Atmosphere, 'bottomRadius')
    const thickness = table.column(Atmosphere, 'thickness')
    const changed = table.changedTicks(Atmosphere)
    for (let i = 0; i < table.count; i++) {
      const entity = table.entities[i]!
      let rec = store.records.get(entity)
      if (!rec) {
        rec = createRecord(entity, false)
        store.records.set(entity, rec)
      }
      rec.seen = store.frame
      seenThisFrame++
      rec.center[0] = g[i * 12 + 3]!
      rec.center[1] = g[i * 12 + 7]!
      rec.center[2] = g[i * 12 + 11]!
      if (thickness[i]! <= 0) {
        if (!rec.problem) {
          rec.problem = new ShardError(
            'render/atmosphere-inside-ground',
            `Atmosphere on entity ${entity} has thickness ${thickness[i]} m; its top is inside the ground`,
            { hint: 'Give it a positive thickness (Earth 60 000 m).' },
          )
          const problem = rec.problem
          logOnce(store, `inside-ground:${entity}`, () =>
            world.tryResource(LogResource)?.error(problem),
          )
        }
        continue
      }
      const stale = rec.version === 0 || rec.problem !== undefined || changed[i]! > since
      rec.problem = undefined
      if (!stale && !(recheck && bottom[i]! <= 0)) continue
      const b = bottom[i]! > 0 ? bottom[i]! : (planetRadius(world, entity) ?? EARTH_RADIUS)
      const value = world.get(entity, Atmosphere) as unknown as AtmosphereValue
      if (writeModel(value, b, undefined, rec.model) || rec.version === 0) rec.version++
    }
  }
  if (store.records.size > seenThisFrame) {
    for (const [entity, rec] of store.records) {
      if (store.frame - rec.seen > 1) store.records.delete(entity)
    }
  }
}

interface SkyChoice {
  sky: {
    turbidity: number
    rayleigh: number
    mie: number
    groundAlbedo: number[]
    sunDiskSize: number
  }
  background: number
}

const SKY_DEFAULTS = {
  turbidity: 2,
  rayleigh: 1,
  mie: 1,
  groundAlbedo: [0.3, 0.3, 0.3, 1],
  sunDiskSize: 1,
}

/**
 * Whether the camera's environment is a procedural sky (its own ProceduralSky, or the default sky
 * when it has no environment map and there's no default map): the same precedence as
 * `prepareEnvironments`.
 */
function skyOf(world: World, e: Entity): SkyChoice | undefined {
  const own = world.isAlive(e)
  const map = own ? world.tryGet(e, EnvironmentMap) : undefined
  if (map?.texture) return undefined
  const sky = own ? world.tryGet(e, ProceduralSky) : undefined
  if (sky) return { sky: sky as SkyChoice['sky'], background: 1 }
  const defaults = world.resource(DefaultEnvironment)
  if (defaults.map?.texture) return undefined
  if (!defaults.sky) return undefined
  return {
    sky: { ...SKY_DEFAULTS, ...defaults.sky } as SkyChoice['sky'],
    background: defaults.background ? 1 : -1,
  }
}

/** Sun index order: the brightest two directional lights. */
function pickSuns(world: World, out: CameraAtmosphere['suns'], diskScale: number): void {
  const lights = world.tryResource(Lights)
  out.count = 0
  if (!lights) return
  const d = lights.directionalData
  let best = -1
  let bestLum = -1
  let second = -1
  let secondLum = -1
  for (let i = 0; i < lights.directionalCount; i++) {
    const o = 4 + i * 8
    const lum = 0.2126 * d[o + 4]! + 0.7152 * d[o + 5]! + 0.0722 * d[o + 6]!
    if (lum > bestLum) {
      second = best
      secondLum = bestLum
      best = i
      bestLum = lum
    } else if (lum > secondLum) {
      second = i
      secondLum = lum
    }
  }
  for (let k = 0; k < 2; k++) {
    const i = k === 0 ? best : second
    if (i < 0) continue
    const o = 4 + i * 8
    const s = out.count * 8
    out.index[out.count] = i
    out.data[s] = d[o]!
    out.data[s + 1] = d[o + 1]!
    out.data[s + 2] = d[o + 2]!
    out.data[s + 3] = d[o + 7]! * diskScale
    out.data[s + 4] = d[o + 4]!
    out.data[s + 5] = d[o + 5]!
    out.data[s + 6] = d[o + 6]!
    out.data[s + 7] = 0
    out.count++
  }
}

const tScratch = new Float64Array(3)

/** Sphere (center, radius) against a camera's frustum planes. */
function sphereVisible(cam: CameraData, x: number, y: number, z: number, r: number): boolean {
  const f = cam.frustum
  for (let p = 0; p < 24; p += 4) {
    if (f[p]! * x + f[p + 1]! * y + f[p + 2]! * z + f[p + 3]! < -r) return false
  }
  return true
}

/** The screen radius (px) of a sphere at distance `dist`. */
function pixelRadius(cam: CameraData, dist: number, r: number): number {
  const focal = cam.proj[5]! * cam.height * 0.5
  if (cam.orthographic) return r * focal
  if (dist <= r) return Number.POSITIVE_INFINITY
  return (r / Math.sqrt(dist * dist - r * r)) * focal
}

/** ProceduralSky's Earth, with the camera's ground albedo. */
const wrapperValue: AtmosphereValue = { ...EARTH, groundAlbedo: [0.3, 0.3, 0.3, 1] }
const secondaries: AtmosphereRecord[] = []
const byDistance = (a: { distance: number }, b: { distance: number }) => a.distance - b.distance
const candidates: { rec: AtmosphereRecord; distance: number; pixels: number }[] = []
const pool: { rec: AtmosphereRecord; distance: number; pixels: number }[] = []

/**
 * Per camera: picks the primary atmosphere (the one it's in, or else the nearest on screen) and up
 * to three secondaries (on screen, over 4 px), computes sunlight transmittance at the camera, and
 * turns on the sky, the aerial-perspective pass, and the fog override.
 */
export const selectAtmospheres = defineSystem({
  name: 'render/atmosphere-select',
  description:
    "Chooses each camera's primary and secondary atmospheres and dims directional lights by the air between the camera and each sun.",
  setup: (world) => ({ q: world.query({ with: [Atmosphere, GlobalTransform] }) }),
  run: ({ q }, world, ctx) => {
    const store = world.resource(Atmospheres)
    store.frame++
    updateRecords(world, store, q, ctx.lastRunTick)
    for (const view of world.resource(Views).list) {
      const cam = cameraOf(view)
      if (!cam) continue
      const e = cam.entity
      let ca = store.cameras.get(e)
      if (!ca) {
        ca = createCameraAtmosphere(e)
        store.cameras.set(e, ca)
      }
      selectFor(world, store, cam, ca)
      view.data.atmosphere = ca.list.length > 0 ? ca : undefined
      // The aerial-perspective pass joins the post chain; ignored fog leaves it.
      const before = cam.post.effects
      if (ca.list.length > 0 && ca.aerialPerspective) cam.post.effects |= PostEffect.Atmosphere
      if (ca.fogIgnored) cam.post.effects &= ~PostEffect.Fog
      if (cam.post.effects !== before) view.aliases = postAliases(cam, viewAliases(cam))
    }
    if (store.frame % 60 === 0) {
      for (const [e, rec] of store.wrappers) {
        if (store.frame - rec.seen > 1) store.wrappers.delete(e)
      }
      for (const e of store.cameras.keys()) {
        if (!world.isAlive(e)) store.cameras.delete(e)
      }
    }
  },
})

function selectFor(
  world: World,
  store: AtmosphereStore,
  cam: CameraData,
  ca: CameraAtmosphere,
): void {
  const e = cam.entity
  const px = cam.position[0]!
  const py = cam.position[1]!
  const pz = cam.position[2]!
  const settings = world.isAlive(e) ? world.tryGet(e, AtmosphereSettings) : undefined
  ca.aerialPerspective = settings?.aerialPerspective ?? true
  ca.skyViewSize[0] = Math.round(settings?.skyViewSize[0] ?? 192)
  ca.skyViewSize[1] = Math.round(settings?.skyViewSize[1] ?? 108)
  ca.froxels[0] = Math.round(settings?.froxels[0] ?? 32)
  ca.froxels[1] = Math.round(settings?.froxels[1] ?? 32)
  ca.froxels[2] = Math.round(settings?.froxels[2] ?? 32)
  ca.maxDistance = settings?.maxDistance ?? 32_000
  // Candidates: every atmosphere, by distance from the camera to its top.
  candidates.length = 0
  let primary: AtmosphereRecord | undefined
  let inside = false
  let nearest = Number.POSITIVE_INFINITY
  for (const rec of store.records.values()) {
    if (rec.problem) continue
    const cx = rec.center[0]! - px
    const cy = rec.center[1]! - py
    const cz = rec.center[2]! - pz
    const dist = Math.sqrt(cx * cx + cy * cy + cz * cz)
    const top = rec.model.top * 1000
    const toTop = dist - top
    if (toTop < 0) {
      // Inside: the innermost (nearest center) wins.
      if (!inside || toTop < nearest) {
        primary = rec
        nearest = toTop
        inside = true
      }
      continue
    }
    const visible = sphereVisible(cam, rec.center[0]!, rec.center[1]!, rec.center[2]!, top)
    if (!visible) continue
    const c = pool[candidates.length] ?? { rec, distance: 0, pixels: 0 }
    pool[candidates.length] = c
    c.rec = rec
    c.distance = dist
    c.pixels = pixelRadius(cam, dist, top)
    candidates.push(c)
    if (!inside && toTop < nearest) {
      primary = rec
      nearest = toTop
    }
  }
  // A ProceduralSky camera gets an Earth atmosphere pinned 10 m below it.
  const sky = primary ? undefined : skyOf(world, e)
  ca.background = 1
  let diskScale = 1
  if (sky) {
    let rec = store.wrappers.get(e)
    if (!rec) {
      rec = createRecord(e, true)
      store.wrappers.set(e, rec)
    }
    rec.seen = store.frame
    const albedo = wrapperValue.groundAlbedo
    for (let c = 0; c < 3; c++) albedo[c] = sky.sky.groundAlbedo[c] ?? 0.3
    if (writeModel(wrapperValue, EARTH_RADIUS, sky.sky, rec.model) || rec.version === 0)
      rec.version++
    rec.center[0] = px
    rec.center[1] = py - (EARTH_RADIUS + 10)
    rec.center[2] = pz
    primary = rec
    inside = true
    ca.background = sky.background
    diskScale = sky.sky.sunDiskSize
    candidates.length = 0
  }
  ca.primary = primary
  ca.inside = inside
  ca.list.length = 0
  // Secondaries: on screen, over 4 px, nearest first; up to three.
  candidates.sort(byDistance)
  secondaries.length = 0
  for (const c of candidates) {
    if (secondaries.length >= 3) break
    if (c.rec === primary || c.pixels <= 4) continue
    secondaries.push(c.rec)
  }
  // Far to near, the primary last.
  for (let i = secondaries.length - 1; i >= 0; i--) ca.list.push(secondaries[i]!)
  if (primary) ca.list.push(primary)
  for (let i = 0; i < ca.list.length; i++) {
    const rec = ca.list[i]!
    const ox = (px - rec.center[0]!) / 1000
    const oy = (py - rec.center[1]!) / 1000
    const oz = (pz - rec.center[2]!) / 1000
    ca.origins[i * 4] = ox
    ca.origins[i * 4 + 1] = oy
    ca.origins[i * 4 + 2] = oz
    const r = Math.sqrt(ox * ox + oy * oy + oz * oz)
    ca.origins[i * 4 + 3] = r < rec.model.top ? 1 : 0
    ca.pixels[i] = pixelRadius(cam, r * 1000, rec.model.top * 1000)
  }
  pickSuns(world, ca.suns, diskScale)
  // Sunlight at the camera: every directional light through the primary, 40 steps on the CPU.
  const st = ca.sunTransmittance
  st.fill(1)
  ca.altitude = 0
  const lights = world.tryResource(Lights)
  if (primary && lights) {
    const m = primary.model
    let ox = (px - primary.center[0]!) / 1000
    let oy = (py - primary.center[1]!) / 1000
    let oz = (pz - primary.center[2]!) / 1000
    let r = Math.sqrt(ox * ox + oy * oy + oz * oz)
    ca.altitude = (r - m.bottom) * 1000
    // Below the LUT floor (inside a deck, or clipping terrain): measure from just above it.
    if (r < m.ground + 1e-4) {
      const k = (m.ground + 1e-4) / Math.max(r, 1e-9)
      ox *= k
      oy *= k
      oz *= k
      r = m.ground + 1e-4
    }
    const d = lights.directionalData
    for (let i = 0; i < lights.directionalCount && i < MAX_DIRECTIONAL; i++) {
      const o = 4 + i * 8
      transmittanceToTop(m, ox, oy, oz, d[o]!, d[o + 1]!, d[o + 2]!, tScratch)
      st[i * 4] = tScratch[0]!
      st[i * 4 + 1] = tScratch[1]!
      st[i * 4 + 2] = tScratch[2]!
    }
    // Sky-view frame: radial up, azimuth 0 toward the brightest sun.
    const f = ca.frame
    f[0] = ox / r
    f[1] = oy / r
    f[2] = oz / r
    let ax = 1
    let ay = 0
    let az = 0
    if (ca.suns.count > 0) {
      ax = ca.suns.data[0]!
      ay = ca.suns.data[1]!
      az = ca.suns.data[2]!
    }
    let dot = ax * f[0]! + ay * f[1]! + az * f[2]!
    let tx = ax - dot * f[0]!
    let ty = ay - dot * f[1]!
    let tz = az - dot * f[2]!
    let tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
    if (tl < 1e-4) {
      // The sun straight up (or none): any tangent.
      ax = Math.abs(f[0]!) < 0.9 ? 1 : 0
      ay = ax ? 0 : 1
      az = 0
      dot = ax * f[0]! + ay * f[1]!
      tx = ax - dot * f[0]!
      ty = ay - dot * f[1]!
      tz = az - dot * f[2]!
      tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
    }
    f[3] = tx / tl
    f[4] = ty / tl
    f[5] = tz / tl
    f[6] = f[1]! * f[5]! - f[2]! * f[4]!
    f[7] = f[2]! * f[3]! - f[0]! * f[5]!
    f[8] = f[0]! * f[4]! - f[1]! * f[3]!
  }
  // Fog and a planet's atmosphere disagree at the horizon: fog steps aside unless it's additive.
  ca.fogIgnored = false
  if (primary && !primary.wrapper && cam.post.effects & PostEffect.Fog && cam.post.fog.mode !== 1) {
    ca.fogIgnored = true
    logOnce(store, `fog:${e}`, () =>
      world
        .tryResource(LogResource)
        ?.log('warn', `Camera ${e} has Fog inside an atmosphere; the fog is ignored`, {
          code: 'render/fog-with-atmosphere',
          hint: 'The atmosphere hazes distant terrain already. For extra ground fog, set Fog.mode to "add".',
        }),
    )
  }
  // The froxels reach the horizon and 10 km peaks beyond it, so terrain seen from altitude reads
  // them instead of marching every pixel (exponential slices keep the near range fine).
  if (primary && inside) {
    const m = primary.model
    const r = Math.max(m.bottom + ca.altitude / 1000, m.bottom)
    const horizon = Math.sqrt(Math.max(r * r - m.bottom * m.bottom, 0))
    const peak = m.bottom + Math.min(10, m.top - m.bottom)
    const beyond = Math.sqrt(peak * peak - m.bottom * m.bottom)
    ca.maxDistance = Math.max(ca.maxDistance, (horizon + beyond) * 1000)
  }
  ca.bakeKey = primary ? bakeKey(primary, ca) : ''
}

/**
 * The IBL is rebaked when this changes: the atmosphere, 2% of (altitude + 1 km), the local up by
 * 0.25°, and each sun's direction by 0.25° or its illuminance by 1%.
 */
function bakeKey(rec: AtmosphereRecord, ca: CameraAtmosphere): string {
  const q = (v: number) => Math.round(v * 229)
  const alt = Math.round(Math.log(1 + Math.max(ca.altitude, 0) / 1000) / Math.log(1.02))
  const f = ca.frame
  let key = `${rec.wrapper ? 'w' : 'a'}${rec.entity}:${rec.version}|${alt}|${q(f[0]!)},${q(f[1]!)},${q(f[2]!)}`
  const s = ca.suns
  for (let i = 0; i < s.count; i++) {
    const o = i * 8
    const lum = 0.2126 * s.data[o + 4]! + 0.7152 * s.data[o + 5]! + 0.0722 * s.data[o + 6]!
    const lux = lum > 0 ? Math.round(Math.log(lum) / Math.log(1.01)) : -1
    key += `|${q(s.data[o]!)},${q(s.data[o + 1]!)},${q(s.data[o + 2]!)},${lux}`
  }
  return key
}

// --- gameplay and agent queries --------------------------------------------------------------

function recordOf(world: World, atmosphere: Entity): AtmosphereRecord {
  const store = world.resource(Atmospheres)
  const rec = store.records.get(atmosphere) ?? store.wrappers.get(atmosphere)
  if (rec) {
    if (rec.problem) throw rec.problem
    return rec
  }
  if (!world.isAlive(atmosphere) || !world.has(atmosphere, Atmosphere)) {
    throw new ShardError('render/not-an-atmosphere', `Entity ${atmosphere} has no Atmosphere`, {
      hint: 'Pass the entity that has render/Atmosphere (render.describe lists each camera’s).',
    })
  }
  // Not extracted yet (no frame has run): read it now.
  const r = createRecord(atmosphere, false)
  const value = world.get(atmosphere, Atmosphere) as unknown as AtmosphereValue
  const b =
    value.bottomRadius > 0 ? value.bottomRadius : (planetRadius(world, atmosphere) ?? EARTH_RADIUS)
  writeModel(value, b, undefined, r.model)
  const g = world.tryGet(atmosphere, GlobalTransform)?.matrix as ArrayLike<number> | undefined
  if (g) {
    r.center[0] = g[3]!
    r.center[1] = g[7]!
    r.center[2] = g[11]!
  }
  return r
}

/** Directional lights brightest first: direction toward each and its illuminance per channel. */
function sunsOf(world: World): ModelSun[] {
  const lights = world.tryResource(Lights)
  const suns: (ModelSun & { lum: number })[] = []
  if (!lights) {
    // Headless (no GPU, no light buffer): the components, as extractLights would read them.
    for (const table of world.query({ with: [DirectionalLight, GlobalTransform] }).tables) {
      const g = table.column(GlobalTransform, 'matrix')
      const color = table.column(DirectionalLight, 'color')
      const lux = table.column(DirectionalLight, 'illuminance')
      for (let i = 0; i < table.count; i++) {
        const x = g[i * 12 + 2]!
        const y = g[i * 12 + 6]!
        const z = g[i * 12 + 10]!
        const len = Math.sqrt(x * x + y * y + z * z) || 1
        const e = [
          color[i * 4]! * lux[i]!,
          color[i * 4 + 1]! * lux[i]!,
          color[i * 4 + 2]! * lux[i]!,
        ]
        suns.push({
          direction: [x / len, y / len, z / len],
          illuminance: e,
          lum: 0.2126 * e[0]! + 0.7152 * e[1]! + 0.0722 * e[2]!,
        })
      }
    }
    return suns.sort((a, b) => b.lum - a.lum)
  }
  const d = lights.directionalData
  for (let i = 0; i < lights.directionalCount; i++) {
    const o = 4 + i * 8
    suns.push({
      direction: [d[o]!, d[o + 1]!, d[o + 2]!],
      illuminance: [d[o + 4]!, d[o + 5]!, d[o + 6]!],
      lum: 0.2126 * d[o + 4]! + 0.7152 * d[o + 5]! + 0.0722 * d[o + 6]!,
    })
  }
  return suns.sort((a, b) => b.lum - a.lum)
}

/**
 * Transmittance (rgb) of the air between a point (world space, origin-relative m) and a sun, through
 * an atmosphere: the factor the renderer applies to that sun's light at the camera. `sun` counts
 * directional lights brightest first. Zero when the planet is in the way. Headless-safe.
 */
export function sunTransmittanceAt(
  world: World,
  atmosphere: Entity,
  position: ArrayLike<number>,
  sun = 0,
): [number, number, number] {
  const rec = recordOf(world, atmosphere)
  const s = sunsOf(world)[sun]
  if (!s) return [1, 1, 1]
  const m = rec.model
  let ox = (position[0]! - rec.center[0]!) / 1000
  let oy = (position[1]! - rec.center[1]!) / 1000
  let oz = (position[2]! - rec.center[2]!) / 1000
  const r = Math.sqrt(ox * ox + oy * oy + oz * oz)
  if (r < m.ground + 1e-4) {
    const k = (m.ground + 1e-4) / Math.max(r, 1e-9)
    ox *= k
    oy *= k
    oz *= k
  }
  const out = new Float64Array(3)
  transmittanceToTop(m, ox, oy, oz, s.direction[0]!, s.direction[1]!, s.direction[2]!, out)
  return [out[0]!, out[1]!, out[2]!]
}

function cpuLuts(rec: AtmosphereRecord) {
  if (!rec.cpu || rec.cpu.version !== rec.version) {
    const transmittance = transmittanceLut(rec.model)
    rec.cpu = {
      version: rec.version,
      transmittance,
      multiscatter: multiscatterLut(rec.model, transmittance),
    }
  }
  return rec.cpu
}

export interface AtmosphereSampleResult {
  /** Sky radiance toward the direction (cd/m²), the ground's where the ray ends on it. */
  radiance: [number, number, number]
  luminance: number
  /** How much of what's behind (space, stars) shows through, per channel. */
  transmittance: [number, number, number]
  hitsGround: boolean
  /** Of the position above bottomRadius (m). */
  altitude: number
  inside: boolean
}

/** Sky radiance and transmittance from a position (world, m) toward a direction, on the CPU. */
export function sampleAtmosphere(
  world: World,
  atmosphere: Entity,
  position: ArrayLike<number>,
  direction: ArrayLike<number>,
): AtmosphereSampleResult {
  const rec = recordOf(world, atmosphere)
  const { transmittance, multiscatter } = cpuLuts(rec)
  const m = rec.model
  const o = [
    (position[0]! - rec.center[0]!) / 1000,
    (position[1]! - rec.center[1]!) / 1000,
    (position[2]! - rec.center[2]!) / 1000,
  ]
  const r = Math.hypot(o[0]!, o[1]!, o[2]!)
  if (r < m.ground + 1e-4) for (let k = 0; k < 3; k++) o[k] = (o[k]! * (m.ground + 1e-4)) / r
  const len = Math.hypot(direction[0]!, direction[1]!, direction[2]!) || 1
  const d = [direction[0]! / len, direction[1]! / len, direction[2]! / len]
  const s = createSkySample()
  integrateSky(m, transmittance, multiscatter, o, d, sunsOf(world).slice(0, 2), s)
  const L = s.radiance
  return {
    radiance: [L[0]!, L[1]!, L[2]!],
    luminance: 0.2126 * L[0]! + 0.7152 * L[1]! + 0.0722 * L[2]!,
    transmittance: [s.transmittance[0]!, s.transmittance[1]!, s.transmittance[2]!],
    hitsGround: s.hitsGround,
    altitude: (r - m.bottom) * 1000,
    inside: r < m.top,
  }
}

// --- describe --------------------------------------------------------------------------------

const round = (v: number, digits = 4) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/** GPU ms of a timed pass, if the profiler has it. */
type Timings = Record<string, { avg: number }>

/** The atmosphere section of `render.describe`. */
export function describeAtmospheres(world: World, timings: Timings = {}) {
  const store = world.tryResource(Atmospheres)
  if (!store) return undefined
  const views: Record<string, unknown> = {}
  const lights = world.tryResource(Lights)
  for (const view of world.resource(Views).list) {
    const cam = cameraOf(view)
    if (!cam) continue
    const ca = store.cameras.get(cam.entity)
    if (!ca || ca.list.length === 0) {
      views[view.name] = { primary: null, secondaries: [] }
      continue
    }
    const p = ca.primary
    const suns = []
    for (let k = 0; k < ca.suns.count; k++) {
      const i = ca.suns.index[k]!
      const o = 4 + i * 8
      const d = lights?.directionalData
      const T = [
        ca.sunTransmittance[i * 4]!,
        ca.sunTransmittance[i * 4 + 1]!,
        ca.sunTransmittance[i * 4 + 2]!,
      ]
      const lux = d ? 0.2126 * d[o + 4]! + 0.7152 * d[o + 5]! + 0.0722 * d[o + 6]! : 0
      const atCamera = d
        ? 0.2126 * d[o + 4]! * T[0]! + 0.7152 * d[o + 5]! * T[1]! + 0.0722 * d[o + 6]! * T[2]!
        : 0
      suns.push({
        light: i,
        direction: [
          round(ca.suns.data[k * 8]!),
          round(ca.suns.data[k * 8 + 1]!),
          round(ca.suns.data[k * 8 + 2]!),
        ],
        illuminance: round(lux, 1),
        transmittance: T.map((v) => round(v)),
        illuminanceAtCamera: round(atCamera, 1),
      })
    }
    const describe = (rec: AtmosphereRecord, i: number) => ({
      entity: rec.entity,
      source: rec.wrapper ? 'procedural-sky' : 'atmosphere',
      bottomRadius: round(rec.model.bottom * 1000, 1),
      thickness: round((rec.model.top - rec.model.bottom) * 1000, 1),
      distance: round(
        Math.hypot(ca.origins[i * 4]!, ca.origins[i * 4 + 1]!, ca.origins[i * 4 + 2]!) * 1000,
        1,
      ),
      pixels: Number.isFinite(ca.pixels[i]!) ? round(ca.pixels[i]!, 1) : 'fills the view',
    })
    const pi = p ? ca.list.indexOf(p) : -1
    views[view.name] = {
      primary: p
        ? { ...describe(p, pi), inside: ca.inside, altitude: round(ca.altitude, 2) }
        : null,
      secondaries: ca.list.filter((r) => r !== p).map((r) => describe(r, ca.list.indexOf(r))),
      suns,
      aerialPerspective: ca.aerialPerspective,
      fogIgnored: ca.fogIgnored,
      gpuMs: {
        luts: timings['gpu:atmosphere/luts']?.avg,
        skyView: timings['gpu:atmosphere/sky-view']?.avg,
        aerial: timings['gpu:atmosphere/aerial']?.avg,
        sky: timings['gpu:atmosphere/sky']?.avg,
        composite: timings['gpu:post/atmosphere']?.avg,
      },
    }
  }
  return {
    views,
    atmospheres: [...store.records.values()].map((r) => ({
      entity: r.entity,
      version: r.version,
      problem: r.problem ? r.problem.toJSON() : null,
    })),
  }
}

// --- methods ---------------------------------------------------------------------------------

const vec3Of = (v: unknown, what: string): number[] => {
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== 'number')) {
    throw new ShardError('render/bad-vector', `${what} must be [x, y, z]`, {
      hint: `e.g. { "${what}": [0, 1, 0] }`,
    })
  }
  return v as number[]
}

export const atmosphereMethods: AppMethod[] = [
  {
    name: 'atmosphere.sample',
    description:
      "Sky radiance (cd/m²) and transmittance through an atmosphere toward a direction, computed on the CPU with the renderer's model (headless-safe): e.g. whether the sky is still blue at 40 km, or how much a star field shows through at dusk. position defaults to the first camera's; entity defaults to that camera's primary atmosphere.",
    params: defineSchema('render/AtmosphereSampleParams', {
      entity: t.json({
        description: 'The Atmosphere entity (default: the first camera’s primary).',
      }),
      position: t.json({
        description: 'World position [x, y, z] in metres (default: the camera).',
      }),
      direction: t.json({ description: 'View direction [x, y, z], e.g. [0, 1, 0] straight up.' }),
    }),
    handler: ({ world }, p) => {
      const store = world.resource(Atmospheres)
      const first = world
        .resource(Views)
        .list.map(cameraOf)
        .find((c) => c !== undefined)
      let entity = p.entity as Entity | undefined
      if (entity === undefined || entity === null) {
        const ca = first ? store.cameras.get(first.entity) : undefined
        entity = ca?.primary?.entity
        if (entity === undefined) {
          const only = [...store.records.keys()]
          if (only.length !== 1) {
            throw new ShardError('render/which-atmosphere', 'Name the atmosphere to sample', {
              hint: 'Pass entity: an entity with render/Atmosphere.',
            })
          }
          entity = only[0]!
        }
      }
      const position =
        p.position !== undefined && p.position !== null
          ? vec3Of(p.position, 'position')
          : first
            ? [first.position[0]!, first.position[1]!, first.position[2]!]
            : [0, 0, 0]
      const direction = vec3Of(p.direction, 'direction')
      const r = sampleAtmosphere(world, entity, position, direction)
      return {
        entity,
        radiance: r.radiance.map((v) => round(v, 3)),
        luminance: round(r.luminance, 3),
        transmittance: r.transmittance.map((v) => round(v, 5)),
        hitsGround: r.hitsGround,
        altitude: round(r.altitude, 2),
        inside: r.inside,
      }
    },
  },
]
