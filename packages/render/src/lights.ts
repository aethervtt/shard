import {
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  onRemove,
  t,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { LightPresets } from './camera'

/** Luminous power presets in lumens, for point and spot lights. */
export const LuminousPowerPresets = {
  candle: 12,
  'bulb-40w': 450,
  bulb: 800,
  floodlight: 20_000,
} as const

export type LuminousPowerPreset = keyof typeof LuminousPowerPresets

/** Lumens for a preset name or a number. */
export const lumens = (value: LuminousPowerPreset | number): number =>
  typeof value === 'number' ? value : LuminousPowerPresets[value]

const shadowFields = (defaults: { bias: number; normalBias: number }) => ({
  shadows: t.bool({ description: 'Casts shadows (within the shadow budget).' }),
  shadowBias: t.f32({
    default: defaults.bias,
    min: 0,
    unit: 'm',
    description: 'Moves receivers toward the light before the depth test. Fixes acne.',
  }),
  shadowNormalBias: t.f32({
    default: defaults.normalBias,
    min: 0,
    description:
      'Moves receivers along their normal, in shadow-map texels. Fixes acne at grazing angles.',
  }),
  shadowSoftness: t.f32({
    min: 0,
    description: 'PCF filter radius in texels beyond the base 3x3 (0 = 3x3). Softer edges.',
  }),
})

export const CascadeSettings = t.struct(
  {
    count: t.u8({ default: 4, min: 1, max: 4, description: 'Number of cascades.' }),
    maxDistance: t.f32({
      default: 150,
      min: 0.01,
      unit: 'm',
      description: 'Shadows end this far from the camera.',
    }),
    splitLambda: t.f32({
      default: 0.8,
      min: 0,
      max: 1,
      description: 'Blend of logarithmic (1) and uniform (0) cascade splits.',
    }),
  },
  { description: 'How cascaded shadow maps divide the view.' },
)

export const DirectionalLight = defineComponent(
  'render/DirectionalLight',
  {
    color: t.color({ default: [1, 1, 1, 1], description: 'Light color (linear).' }),
    illuminance: t.f32({
      default: LightPresets.daylight,
      min: 0,
      unit: 'lux',
      presets: LightPresets,
      description:
        'Presets: direct-sun 100000, daylight 10000, overcast 1000, indoor 400, twilight 10, moonlight 0.3.',
    }),
    ...shadowFields({ bias: 0.02, normalBias: 1.5 }),
    cascades: CascadeSettings,
    angularDiameter: t.f32({
      default: 0.53,
      min: 0,
      max: 30,
      unit: 'deg',
      description:
        "The sun disk's size in an atmosphere's sky (the Sun 0.53°). 0: no disk. Illuminance is at the top of the atmosphere.",
    }),
  },
  {
    description:
      'Sun-like light shining along its -Z axis. Up to 4 are lit; the first with shadows gets cascaded shadow maps. Inside an Atmosphere its light is dimmed and reddened by the air toward it, and the brightest two draw sun disks.',
    requires: [Transform],
  },
)

const pointFields = {
  color: t.color({ default: [1, 1, 1, 1], description: 'Light color (linear).' }),
  intensity: t.f32({
    default: LuminousPowerPresets.bulb,
    min: 0,
    unit: 'lm',
    presets: LuminousPowerPresets,
    description: 'Luminous power. Presets: candle 12, bulb-40w 450, bulb 800, floodlight 20000.',
  }),
  range: t.f32({
    default: 20,
    min: 0.01,
    unit: 'm',
    description: "Where the light's contribution is windowed to zero (and where culling stops).",
  }),
  radius: t.f32({
    min: 0,
    unit: 'm',
    description: 'Emitter size: softens specular highlights.',
  }),
}

export const PointLight = defineComponent(
  'render/PointLight',
  { ...pointFields, ...shadowFields({ bias: 0.02, normalBias: 1 }) },
  {
    description:
      'Light emitted equally in all directions, in lumens (intensity lm / 4π candela), with physical inverse-square falloff windowed to zero at range.',
    requires: [Transform],
  },
)

export const SpotLight = defineComponent(
  'render/SpotLight',
  {
    ...pointFields,
    ...shadowFields({ bias: 0.02, normalBias: 1 }),
    innerAngle: t.f32({
      default: 30,
      min: 0,
      max: 89,
      unit: 'deg',
      description: 'Full brightness inside this angle from the axis.',
    }),
    outerAngle: t.f32({
      default: 45,
      min: 0.1,
      max: 89.9,
      unit: 'deg',
      description: 'No light outside this angle from the axis.',
    }),
  },
  {
    description:
      "A cone of light along -Z. Brightness is lm / 4π candela regardless of the cone's width.",
    requires: [Transform],
  },
)

export interface AmbientLightValue {
  /** Linear color. */
  color: [number, number, number]
  /** Sky luminance in cd/m². A useful fill is roughly illuminance / 10 of the main light. */
  brightness: number
}

export const AmbientLight = defineResource<AmbientLightValue>('render/AmbientLight', {
  description: 'Uniform fill light, in cd/m². Used when no environment map lights the view.',
  init: () => ({ color: [1, 1, 1], brightness: 0 }),
})

export interface LightingSettingsValue {
  /** Point and spot lights the light buffer holds. */
  maxLights: number
  /** Where the last cluster slice ends (m). 0: the camera's far plane, or 1 km. */
  clusterFar: number
  cascadeMapSize: number
  /** Spot and point shadow map size (per face). */
  shadowMapSize: number
  maxShadowedPoints: number
  maxShadowedSpots: number
}

export const LightingSettings = defineResource<LightingSettingsValue>('render/LightingSettings', {
  description: 'Light and shadow budgets: light buffer size, cluster range, shadow map sizes.',
  init: () => ({
    maxLights: 1024,
    clusterFar: 0,
    cascadeMapSize: 2048,
    shadowMapSize: 1024,
    maxShadowedPoints: 4,
    maxShadowedSpots: 8,
  }),
})

/** Floats per light record in the light buffer. */
export const LIGHT_FLOATS = 20
export const LIGHT_KIND = { point: 0, spot: 1 } as const
export const MAX_DIRECTIONAL = 4

/** A clustered light (point or spot) as the renderer tracks it. */
export interface LightRecord {
  entity: Entity
  kind: 0 | 1
  /** Slot in the light buffer. */
  slot: number
  /** World position and range; spot axis (unit, direction light travels) and cos(outer). */
  x: number
  y: number
  z: number
  range: number
  dx: number
  dy: number
  dz: number
  cosOuter: number
  /** Luminous power (lm), for describe and shadow ranking. */
  intensity: number
  shadows: boolean
  /** Shadow map index this frame (spot layer, or point cube index), or -1. */
  shadowIndex: number
  outerAngle: number
  radius: number
  alive: boolean
}

/**
 * Point and spot lights in a storage buffer (`array<Light>`). Each light owns a slot; only lights
 * whose data changed this frame are uploaded (coalesced runs), and the counters say how many.
 */
export class LightStore {
  readonly records: LightRecord[] = []
  readonly byEntity = new Map<Entity, LightRecord>()
  data: Float32Array
  u32: Uint32Array
  private dirty: Uint8Array
  private readonly free: number[] = []
  high = 0
  /** Lights uploaded in the last frame, and bytes. */
  uploadedLights = 0
  uploadedBytes = 0
  readonly buffer: GpuBuffer
  /** Directional lights: count + up to 4 × (direction, shadow cascade flag, color × lux, disk radius). */
  readonly directional: GpuBuffer
  readonly directionalData = new Float32Array(4 + MAX_DIRECTIONAL * 8)
  readonly directionalU32 = new Uint32Array(this.directionalData.buffer)
  /** The first directional light with shadows: entity, and its settings. */
  shadowSun: {
    entity: Entity
    direction: Float32Array
    count: number
    maxDistance: number
    splitLambda: number
    bias: number
    normalBias: number
    softness: number
  } | null = null
  directionalCount = 0
  private generation: number
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext, capacity: number) {
    this.gpu = gpu
    this.generation = gpu.generation
    this.data = new Float32Array(capacity * LIGHT_FLOATS)
    this.u32 = new Uint32Array(this.data.buffer)
    this.dirty = new Uint8Array(capacity)
    this.buffer = new GpuBuffer(gpu, {
      label: 'lights',
      usage: GPUBufferUsage.STORAGE,
      size: capacity * LIGHT_FLOATS * 4,
    })
    this.directional = new GpuBuffer(gpu, {
      label: 'lights/directional',
      usage: GPUBufferUsage.STORAGE,
      size: this.directionalData.byteLength,
    })
  }

  get capacity(): number {
    return this.dirty.length
  }

  /** The live records (dense list; order follows slots). */
  live(): LightRecord[] {
    return this.records.filter((r) => r.alive)
  }

  record(entity: Entity, kind: 0 | 1): LightRecord | undefined {
    let r = this.byEntity.get(entity)
    if (r && r.kind === kind) return r
    if (r) this.remove(entity)
    const slot = this.free.pop() ?? (this.high < this.capacity ? this.high++ : -1)
    if (slot < 0) return undefined // over maxLights
    r = {
      entity,
      kind,
      slot,
      x: 0,
      y: 0,
      z: 0,
      range: 0,
      dx: 0,
      dy: 0,
      dz: -1,
      cosOuter: -2,
      intensity: 0,
      shadows: false,
      shadowIndex: -1,
      outerAngle: 0,
      radius: 0,
      alive: true,
    }
    this.records[slot] = r
    this.byEntity.set(entity, r)
    return r
  }

  remove(entity: Entity): void {
    const r = this.byEntity.get(entity)
    if (!r) return
    this.byEntity.delete(entity)
    r.alive = false
    // A zero-range light contributes nothing and is never clustered.
    this.data.fill(0, r.slot * LIGHT_FLOATS, (r.slot + 1) * LIGHT_FLOATS)
    this.dirty[r.slot] = 1
    this.free.push(r.slot)
  }

  /** Writes a float into a light's record, marking it dirty only when the value changes. */
  set(slot: number, index: number, value: number): void {
    const o = slot * LIGHT_FLOATS + index
    const d = this.data
    const before = d[o]!
    d[o] = value
    // Compare after the f32 rounding, so unchanged values never count as changes.
    if (d[o] !== before && !(Number.isNaN(before) && Number.isNaN(d[o]!))) this.dirty[slot] = 1
  }

  setU32(slot: number, index: number, value: number): void {
    const o = slot * LIGHT_FLOATS + index
    if (this.u32[o] !== value >>> 0) {
      this.u32[o] = value >>> 0
      this.dirty[slot] = 1
    }
  }

  upload(): void {
    if (this.generation !== this.gpu.generation) {
      this.generation = this.gpu.generation
      this.dirty.fill(1, 0, this.high)
    }
    let lights = 0
    let runStart = -1
    for (let s = 0; s <= this.high; s++) {
      const d = s < this.high && this.dirty[s] === 1
      if (d) {
        this.dirty[s] = 0
        lights++
        if (runStart < 0) runStart = s
      } else if (runStart >= 0) {
        this.buffer.write(
          this.data,
          runStart * LIGHT_FLOATS * 4,
          runStart * LIGHT_FLOATS,
          (s - runStart) * LIGHT_FLOATS,
        )
        runStart = -1
      }
    }
    this.uploadedLights = lights
    this.uploadedBytes = lights * LIGHT_FLOATS * 4
    this.directional.write(this.directionalData)
  }
}

export const Lights = defineResource<LightStore>('render/Lights', {
  description: 'Point and spot lights on the GPU, plus the directional lights.',
})

const POINT_KIND = LIGHT_KIND.point
const SPOT_KIND = LIGHT_KIND.spot
const INV_4PI = 1 / (4 * Math.PI)

/** Fills a light's record from its components (only changed values mark it for upload). */
function writeLight(
  store: LightStore,
  r: LightRecord,
  g: ArrayLike<number>,
  o: number,
  color: ArrayLike<number>,
  c: number,
  intensity: number,
  range: number,
  radius: number,
  bias: number,
  normalBias: number,
  softness: number,
  inner: number,
  outer: number,
): void {
  const s = r.slot
  r.x = g[o + 3]!
  r.y = g[o + 7]!
  r.z = g[o + 11]!
  r.range = range
  r.intensity = intensity
  r.radius = radius
  // The light shines along its -Z.
  const dx = -g[o + 2]!
  const dy = -g[o + 6]!
  const dz = -g[o + 10]!
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
  r.dx = dx / len
  r.dy = dy / len
  r.dz = dz / len
  const candela = intensity * INV_4PI
  store.set(s, 0, r.x)
  store.set(s, 1, r.y)
  store.set(s, 2, r.z)
  store.set(s, 3, range)
  store.set(s, 4, color[c]! * candela)
  store.set(s, 5, color[c + 1]! * candela)
  store.set(s, 6, color[c + 2]! * candela)
  store.set(s, 7, radius)
  store.set(s, 8, r.dx)
  store.set(s, 9, r.dy)
  store.set(s, 10, r.dz)
  store.setU32(s, 11, r.kind)
  if (r.kind === SPOT_KIND) {
    const cosOuter = Math.cos((outer * Math.PI) / 180)
    const cosInner = Math.cos((Math.min(inner, outer - 0.01) * Math.PI) / 180)
    // Angular attenuation: saturate(cos · scale + offset)² (Filament).
    const scale = 1 / Math.max(cosInner - cosOuter, 1e-4)
    store.set(s, 12, scale)
    store.set(s, 13, -cosOuter * scale)
    r.cosOuter = cosOuter
    r.outerAngle = outer
  } else {
    store.set(s, 12, 0)
    store.set(s, 13, 1)
    r.cosOuter = -2
  }
  store.setU32(s, 14, r.shadowIndex < 0 ? 0xffffffff : r.shadowIndex)
  store.set(s, 15, bias)
  store.set(s, 16, normalBias)
  store.set(s, 17, softness)
}

/** Reads lights into the light store. Only lights whose values changed are re-uploaded later. */
export const extractLights = defineSystem({
  name: 'render/extract-lights',
  description: 'Reads directional, point, and spot lights into GPU light buffers.',
  setup: (world) => ({
    directional: world.query({ with: [DirectionalLight, GlobalTransform] }),
    points: world.query({ with: [PointLight, GlobalTransform] }),
    spots: world.query({ with: [SpotLight, GlobalTransform] }),
    seen: new Set<Entity>(),
  }),
  run: ({ directional, points, spots, seen }, world, ctx) => {
    const store = world.resource(Lights)
    const since = ctx.lastRunTick
    seen.clear()
    for (const [def, kind, q] of [
      [PointLight, POINT_KIND, points],
      [SpotLight, SPOT_KIND, spots],
    ] as const) {
      for (const table of q.tables) {
        const n = table.count
        if (n === 0) continue
        const g = table.column(GlobalTransform, 'matrix')
        const gChanged = table.changedTicks(GlobalTransform)
        const changed = table.changedTicks(def)
        const color = table.column(def, 'color')
        const intensity = table.column(def, 'intensity')
        const range = table.column(def, 'range')
        const radius = table.column(def, 'radius')
        const shadows = table.column(def, 'shadows')
        const bias = table.column(def, 'shadowBias')
        const normalBias = table.column(def, 'shadowNormalBias')
        const softness = table.column(def, 'shadowSoftness')
        const inner = kind === SPOT_KIND ? table.column(SpotLight, 'innerAngle') : undefined
        const outer = kind === SPOT_KIND ? table.column(SpotLight, 'outerAngle') : undefined
        for (let i = 0; i < n; i++) {
          const entity = table.entities[i]!
          seen.add(entity)
          const existing = store.byEntity.get(entity)
          const r = store.record(entity, kind)
          if (!r) continue
          r.shadows = shadows[i] !== 0
          if (existing === r && gChanged[i]! <= since && changed[i]! <= since) continue
          writeLight(
            store,
            r,
            g,
            i * 12,
            color,
            i * 4,
            intensity[i]!,
            range[i]!,
            radius[i]!,
            bias[i]!,
            normalBias[i]!,
            softness[i]!,
            inner ? inner[i]! : 0,
            outer ? outer[i]! : 90,
          )
        }
      }
    }
    // Lights whose component went away (observers handle despawn; this catches kind changes).
    if (seen.size !== store.byEntity.size) {
      for (const entity of [...store.byEntity.keys()]) if (!seen.has(entity)) store.remove(entity)
    }

    // Directional lights: up to four, the first with shadows gets cascades.
    const d = store.directionalData
    const du = store.directionalU32
    let count = 0
    store.shadowSun = null
    for (const table of directional.tables) {
      const g = table.column(GlobalTransform, 'matrix')
      const color = table.column(DirectionalLight, 'color')
      const lux = table.column(DirectionalLight, 'illuminance')
      const shadows = table.column(DirectionalLight, 'shadows')
      const cascades = table.column(DirectionalLight, 'cascades')
      const angular = table.column(DirectionalLight, 'angularDiameter')
      for (let i = 0; i < table.count && count < MAX_DIRECTIONAL; i++) {
        const o = 4 + count * 8
        // Toward the light: the +Z column of the light's world matrix.
        const x = g[i * 12 + 2]!
        const y = g[i * 12 + 6]!
        const z = g[i * 12 + 10]!
        const len = Math.sqrt(x * x + y * y + z * z) || 1
        d[o] = x / len
        d[o + 1] = y / len
        d[o + 2] = z / len
        const shadowed = shadows[i] !== 0 && store.shadowSun === null
        du[o + 3] = shadowed ? 1 : 0
        d[o + 4] = color[i * 4]! * lux[i]!
        d[o + 5] = color[i * 4 + 1]! * lux[i]!
        d[o + 6] = color[i * 4 + 2]! * lux[i]!
        // Angular radius (rad), for sun disks.
        d[o + 7] = (angular[i]! * Math.PI) / 360
        if (shadowed) {
          const c = cascades[i] as { count: number; maxDistance: number; splitLambda: number }
          store.shadowSun = {
            entity: table.entities[i]!,
            direction: new Float32Array([x / len, y / len, z / len]),
            count: c.count,
            maxDistance: c.maxDistance,
            splitLambda: c.splitLambda,
            bias: table.column(DirectionalLight, 'shadowBias')[i]!,
            normalBias: table.column(DirectionalLight, 'shadowNormalBias')[i]!,
            softness: table.column(DirectionalLight, 'shadowSoftness')[i]!,
          }
        }
        count++
      }
    }
    du[0] = count
    store.directionalCount = count
  },
})

/** Frees a light's slot when its component goes away (including despawn). */
export function observeLightRemovals(world: World): void {
  for (const def of [PointLight, SpotLight]) {
    world.observe(onRemove(def), ({ entity, world }) => {
      world.tryResource(Lights)?.remove(entity)
    })
  }
}

/** Sets a light's shadow index (marks it dirty if it changed). */
export function setShadowIndex(store: LightStore, r: LightRecord, index: number): void {
  if (r.shadowIndex === index) return
  r.shadowIndex = index
  store.setU32(r.slot, 14, index < 0 ? 0xffffffff : index)
}
