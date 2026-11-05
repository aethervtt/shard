import {
  defineResource,
  defineSystem,
  type Entity,
  type Query,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { sinCos } from '@aethervtt/shard-mesh'
import { NetClock, NetRole } from '@aethervtt/shard-net'
import { FixedTime, LogResource, Time } from '@aethervtt/shard-runtime'
import { Wind, WindState } from '@aethervtt/shard-wind'
import { WaterBodies, type WaterBodyRecord } from '../bodies'
import {
  buildSea,
  COMPONENT_FLOATS,
  CROSSFADE_TICKS,
  checkCascades,
  DEFAULT_CASCADES,
  OceanWaves,
  PARAM_FLOATS,
  packParams,
  REPEAT,
  type Sea,
  type SpectrumParams,
} from './spectrum'

// Each body's sea (0098): its spectrum resolved from OceanWaves and the body's wind, rebuilt when
// either changes and crossfaded from the old one over 120 ticks, and the CPU evaluator waterAt
// reads. Time is the tick's: every machine (on a client, the server's tick) gets the same sea.

/** One body's waves. */
export interface WaveSet {
  entity: Entity
  /** What the sea was built from, flat (`packParams`). */
  readonly key: Float64Array
  sea: Sea
  /** The sea before the last change, while it fades out. */
  old: Sea | undefined
  /** The tick the crossfade began. */
  fadeStart: number
  /** Cascades' first layer in the GPU's wave textures (−1: not drawn). */
  layer: number
  foam: [number, number, number]
  /** Bumps when `sea` or `old` changes: the GPU uploads them again. */
  version: number
  problem: ShardError | null
  seen: number
}

export class WaveSetsState {
  readonly sets = new Map<Entity, WaveSet>()
  /** Bumps when a set appears, goes, or changes its spectrum. */
  version = 0
  frame = 0
  bodiesVersion = -1
  readonly reported = new Set<string>()
}

export const WaveSets = defineResource<WaveSetsState>('water/WaveSets', {
  description: 'Each body’s sea (0098): spectrum, cascades, the crossfade, and its GPU layers.',
  init: () => new WaveSetsState(),
})

/**
 * The tick waves are at: the fixed tick (the server's on a client), with the fraction toward the
 * next when `smooth` (what rendering uses; gameplay uses the tick itself).
 */
export function waveTick(world: World, smooth = false): number {
  const fixed = world.tryResource(FixedTime)
  if (!fixed) return 0
  if (world.tryResource(NetRole)?.role === 'client') {
    const t = world.tryResource(NetClock)?.serverTick ?? 0
    return smooth ? t : Math.floor(t)
  }
  return smooth ? fixed.tick + fixed.alpha : fixed.tick
}

/** Seconds of sea time at a tick: (tick × step) mod REPEAT, which loops exactly. */
export function waveTime(world: World, tick = waveTick(world)): number {
  const fixed = world.tryResource(FixedTime)
  const seconds = fixed ? tick * fixed.step : (world.tryResource(Time)?.elapsed ?? 0)
  return seconds - Math.floor(seconds / REPEAT) * REPEAT
}

/** How far a set's crossfade has come at a tick: 0 the old sea, 1 the new one. */
export function fadeWeight(set: WaveSet, tick: number): number {
  if (!set.old) return 1
  return Math.min(1, Math.max(0, (tick - set.fadeStart) / CROSSFADE_TICKS))
}

const scratchParams = new Float64Array(PARAM_FLOATS)

function resolveParams(
  world: World,
  body: WaterBodyRecord,
  waves: OceanWavesValue,
): SpectrumParams {
  let speed: number
  let dir: readonly number[]
  if (waves.wind === 'own') {
    speed = waves.windSpeed
    dir = waves.windDirection
  } else if (body.windOwn) {
    speed = body.windSpeed
    dir = body.windDirection
  } else {
    const wind = world.tryResource(Wind)
    speed = wind?.speed ?? 0
    dir = wind?.direction ?? [1, 0, 0]
  }
  const horizontal = (d: readonly number[]) => {
    const l = Math.sqrt(d[0]! * d[0]! + d[2]! * d[2]!)
    return l > 1e-9 ? [d[0]! / l, d[2]! / l] : [1, 0]
  }
  const [wx, wz] = horizontal(dir)
  const [sx, sz] = horizontal(waves.swellDirection)
  return {
    seed: waves.seed,
    windSpeed: speed,
    windX: wx!,
    windZ: wz!,
    fetch: waves.fetch * 1000,
    gamma: waves.gamma,
    spread: waves.spread,
    swell: waves.swell,
    swellHeight: waves.swellHeight,
    swellPeriod: waves.swellPeriod,
    swellX: sx!,
    swellZ: sz!,
    swellSpread: waves.swellSpread,
    depth: waves.depth,
    choppiness: waves.choppiness,
    lengths: waves.cascades.length > 0 ? waves.cascades.map((c) => c.length) : DEFAULT_CASCADES,
    resolution: waves.resolution,
  }
}

type OceanWavesValue = ReturnType<typeof readWaves>
const readWaves = (world: World, e: Entity) => world.get(e, OceanWaves)

/** Whether a set's wind-driven parameters (speed and direction) differ from `key`'s. */
const windChanged = (a: Float64Array, b: Float64Array) =>
  a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]

/** The tick the shared wind last changed on every machine (WindState's), when there is one. */
function windTick(s: { windStates: Query }): number | undefined {
  for (const table of s.windStates.tables) {
    if (table.count === 0) continue
    return table.column(WindState, 'fromTick')[0]
  }
  return undefined
}

/**
 * Keeps each body's sea in step with its OceanWaves and wind (PostUpdate, after water/bodies):
 * rebuilds a spectrum when they change, crossfading from the old one from the tick the change took
 * effect (WindState's for the wind, OceanWaves.changedAt when the server stamped one, else now).
 * Allocates nothing while nothing changes.
 */
export const updateWaves = defineSystem({
  name: 'water/waves',
  description:
    'Rebuilds a body’s wave spectrum when its OceanWaves or wind changes, crossfading from the old sea over 120 ticks from the tick of the change.',
  setup: (world) => ({
    waves: world.query({ with: [OceanWaves] }),
    windStates: world.query({ with: [WindState] }),
  }),
  run: (s, world, ctx) => {
    const state = world.resource(WaveSets)
    const bodies = world.resource(WaterBodies)
    const frame = ++state.frame
    const tick = waveTick(world)
    const bodiesChanged = bodies.version !== state.bodiesVersion
    state.bodiesVersion = bodies.version
    let seen = 0
    for (const table of s.waves.tables) {
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]!
        seen++
        let set = state.sets.get(entity)
        const body = bodies.records.get(entity)
        if (!body || body.problem) {
          if (set) set.seen = frame
          continue
        }
        // Nothing it's built from changed: only the crossfade moves on.
        if (
          set &&
          !bodiesChanged &&
          !table.isChanged(OceanWaves, row, ctx.lastRunTick) &&
          sameWind(world, body, table.column(OceanWaves, 'wind')[row] === 1, set.key)
        ) {
          set.seen = frame
          if (set.old && fadeWeight(set, tick) >= 1) {
            set.old = undefined
            set.version++
          }
          continue
        }
        const waves = readWaves(world, entity)
        let params: SpectrumParams
        try {
          if (body.kind !== 'ocean' && body.kind !== 'lake') {
            throw new ShardError(
              'water/waves-need-ocean',
              `OceanWaves on ${entity}: a ${body.kind} has no waves`,
              { hint: 'Put OceanWaves on an ocean or lake body.' },
            )
          }
          params = resolveParams(world, body, waves)
          checkCascades(entity, params.lengths, params.resolution)
        } catch (error) {
          if (!(error instanceof ShardError)) throw error
          const key = `${entity}:${error.message}`
          if (!state.reported.has(key)) {
            state.reported.add(key)
            world.tryResource(LogResource)?.error(error)
          }
          if (set) {
            set.problem = error
            set.seen = frame
          }
          continue
        }
        packParams(params, scratchParams)
        if (set && sameParams(set.key, scratchParams)) {
          set.seen = frame
          set.foam[0] = waves.foamThreshold
          set.foam[1] = waves.foamGrowth
          set.foam[2] = waves.foamDecay
          if (set.old && fadeWeight(set, tick) >= 1) {
            set.old = undefined
            set.version++
          }
          continue
        }
        const sea = buildSea(params)
        if (!set) {
          set = {
            entity,
            key: new Float64Array(PARAM_FLOATS),
            sea,
            old: undefined,
            fadeStart: tick,
            layer: -1,
            foam: [waves.foamThreshold, waves.foamGrowth, waves.foamDecay],
            version: 0,
            problem: null,
            seen: frame,
          }
          state.sets.set(entity, set)
        } else {
          // A change: crossfade from the sea as it is now, from the tick the change took effect.
          const wind = windChanged(set.key, scratchParams) ? windTick(s) : undefined
          const stamped = waves.changedAt >= 0 ? waves.changedAt : undefined
          set.old = set.sea
          set.sea = sea
          set.fadeStart = Math.min(tick, stamped ?? wind ?? tick)
          set.version++
        }
        set.key.set(scratchParams)
        set.problem = null
        set.seen = frame
        state.version++
      }
    }
    if (state.sets.size !== seen) {
      for (const [entity, set] of state.sets) {
        if (set.seen !== frame) {
          state.sets.delete(entity)
          state.version++
        }
      }
    }
  },
})

/**
 * Whether the wind a set follows is still what its key holds (speed, then the horizontal unit
 * direction), worked out the way `resolveParams` does, with no arrays.
 */
function sameWind(world: World, body: WaterBodyRecord, own: boolean, key: Float64Array): boolean {
  if (own) return true
  let speed: number
  let x: number
  let z: number
  if (body.windOwn) {
    speed = body.windSpeed
    x = body.windDirection[0]
    z = body.windDirection[2]
  } else {
    const wind = world.tryResource(Wind)
    speed = wind?.speed ?? 0
    x = wind?.direction[0] ?? 1
    z = wind?.direction[2] ?? 0
  }
  const l = Math.sqrt(x * x + z * z)
  if (l > 1e-9) {
    x /= l
    z /= l
  } else {
    x = 1
    z = 0
  }
  return key[1] === speed && key[2] === x && key[3] === z
}

function sameParams(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i < PARAM_FLOATS; i++) if (a[i] !== b[i]) return false
  return true
}

/** What `seaAt` writes: height, horizontal displacement, slopes. */
export interface SeaSample {
  height: number
  dx: number
  dz: number
  /** ∂height/∂x and ∂height/∂z at the point, displacement accounted for. */
  slopeX: number
  slopeZ: number
}

export function seaSample(): SeaSample {
  return { height: 0, dx: 0, dz: 0, slopeX: 0, slopeZ: 0 }
}

/** k·depth past which tanh is 1 to f64 precision: the attenuation is skipped. */
const DEEP = 20

/** A cascade's attenuation in water `depth` deep: tanh(k·d) at its representative wavenumber. */
export function shoreFactor(length: number, depth: number): number {
  if (!(depth < Number.POSITIVE_INFINITY)) return 1
  const kd = ((2 * Math.PI * 4) / length) * Math.max(depth, 0)
  return kd > DEEP ? 1 : Math.tanh(kd)
}

const sc = new Float64Array(2)
const acc = new Float64Array(7)

/** Adds a sea's first `count` components at undisplaced (x, z) into `acc`, weighted by w. */
function accumulate(
  sea: Sea,
  count: number,
  w: number,
  x: number,
  z: number,
  time: number,
  depth: number,
  derivatives: boolean,
): void {
  const c = sea.components
  const lambda = sea.params.choppiness
  const lengths = sea.params.lengths
  let f0 = shoreFactor(lengths[0]!, depth)
  let fc = 0
  const n = Math.min(count, sea.componentCount)
  for (let i = 0; i < n; i++) {
    const o = i * COMPONENT_FLOATS
    const kx = c[o]!
    const kz = c[o + 1]!
    const cascade = c[o + 5]!
    if (cascade !== fc) {
      fc = cascade
      f0 = shoreFactor(lengths[cascade]!, depth)
    }
    const a = c[o + 2]! * w * f0
    sinCos(kx * x + kz * z - c[o + 4]! * time + c[o + 3]!, sc)
    const s = sc[0]!
    const cs = sc[1]!
    const k = Math.sqrt(kx * kx + kz * kz)
    acc[0] = acc[0]! + a * cs
    acc[1] = acc[1]! + ((lambda * kx) / k) * a * s
    acc[2] = acc[2]! + ((lambda * kz) / k) * a * s
    if (derivatives) {
      acc[3] = acc[3]! - a * kx * s
      acc[4] = acc[4]! - a * kz * s
      acc[5] = acc[5]! + ((lambda * kx * kx) / k) * a * cs
      acc[6] = acc[6]! + ((lambda * kz * kz) / k) * a * cs
    }
  }
}

function evaluate(
  set: WaveSet,
  count: number,
  weight: number,
  x: number,
  z: number,
  time: number,
  depth: number,
  d: boolean,
) {
  acc.fill(0)
  accumulate(set.sea, count, weight, x, z, time, depth, d)
  if (set.old && weight < 1) accumulate(set.old, count, 1 - weight, x, z, time, depth, d)
}

/** Fixed-point iterations that find the undisplaced point a displaced one came from. */
export const INVERSE_ITERATIONS = 4
/**
 * Components those iterations sum: the strongest carry nearly all of the displacement, and the
 * height that follows sums them all.
 */
export const INVERSE_COMPONENTS = 16

/**
 * The sea's surface over world (x, z) at a time (0098): the strongest components (128 by default),
 * blended across a crossfade, each cascade attenuated by water `depth` (∞ for deep). Horizontal
 * displacement means the water over x came from elsewhere: 4 fixed-point iterations over the 16
 * strongest find it.
 * Every sine is `sinCos`'s, so the bytes are the same on every machine. No allocation.
 */
export function seaAt(
  set: WaveSet,
  x: number,
  z: number,
  time: number,
  tick: number,
  depth: number,
  out: SeaSample,
): SeaSample {
  const w = fadeWeight(set, tick)
  let ux = x
  let uz = z
  for (let i = 0; i < INVERSE_ITERATIONS; i++) {
    evaluate(set, INVERSE_COMPONENTS, w, ux, uz, time, depth, false)
    ux = x - acc[1]!
    uz = z - acc[2]!
  }
  evaluate(set, Number.MAX_SAFE_INTEGER, w, ux, uz, time, depth, true)
  out.height = acc[0]!
  out.dx = acc[1]!
  out.dz = acc[2]!
  out.slopeX = acc[3]! / (1 + acc[5]!)
  out.slopeZ = acc[4]! / (1 + acc[6]!)
  return out
}
