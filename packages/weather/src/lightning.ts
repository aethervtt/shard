import { defineResource, defineSystem, type Entity, quat, type World } from '@aethervtt/shard-core'
import { DirectionalLight } from '@aethervtt/shard-render'
import { Time } from '@aethervtt/shard-runtime'
import { Clouds, SkyFlash } from '@aethervtt/shard-sky'
import { Transform } from '@aethervtt/shard-transform'
import { CH, LightningStrike, WeatherState } from './components'

/** Bolt segments drawn at most. */
export const MAX_SEGMENTS = 256
/** Floats per segment: start xyz, width, end xyz, brightness. */
export const SEGMENT_FLOATS = 8

export interface LightningStateValue {
  /** Real seconds of the next strike. */
  next: number
  /** The strike in progress: when it began, where its top and foot are, whether it reaches ground. */
  start: number
  top: Float64Array
  foot: Float64Array
  ground: boolean
  /** How bright the strike is now: re-strokes over half a second. */
  envelope: number
  /** How bright the bolt is now: the strokes, and the channel's afterglow. */
  bolt: number
  segments: Float32Array
  /** Segments of the current bolt (drawn while envelope > 0 and ground). */
  count: number
  /** The DirectionalLight that is the flash over the land. */
  light: Entity | -1
  strikes: number
  /** A strike asked for with strikeLightning: where its foot lands, taken on the next frame. */
  pending: Float64Array | undefined
}

export const LightningState = defineResource<LightningStateValue>('weather/Lightning', {
  description: 'Lightning (0133): the strike in progress, its bolt, and the next strike.',
  init: () => ({
    next: 3,
    start: -10,
    top: new Float64Array(3),
    foot: new Float64Array(3),
    ground: false,
    envelope: 0,
    bolt: 0,
    segments: new Float32Array(MAX_SEGMENTS * SEGMENT_FLOATS),
    count: 0,
    light: -1,
    strikes: 0,
    pending: undefined,
  }),
})

let seed = 12345
function rand(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 4294967296
}

/** A jagged bolt from top to foot by midpoint displacement, with a few branches. */
function buildBolt(s: LightningStateValue): void {
  const out = s.segments
  let n = 0
  const add = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    w: number,
    b: number,
  ) => {
    if (n >= MAX_SEGMENTS) return
    const o = n * SEGMENT_FLOATS
    out[o] = ax
    out[o + 1] = ay
    out[o + 2] = az
    out[o + 3] = w
    out[o + 4] = bx
    out[o + 5] = by
    out[o + 6] = bz
    out[o + 7] = b
    n++
  }
  const split = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    depth: number,
    w: number,
    b: number,
    branches: boolean,
  ): void => {
    const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2)
    if (depth === 0 || len < 25) {
      add(ax, ay, az, bx, by, bz, w, b)
      return
    }
    const j = len * 0.16
    const mx = (ax + bx) / 2 + (rand() - 0.5) * j * 2
    const my = (ay + by) / 2 + (rand() - 0.5) * j * 0.6
    const mz = (az + bz) / 2 + (rand() - 0.5) * j * 2
    split(ax, ay, az, mx, my, mz, depth - 1, w, b, branches)
    split(mx, my, mz, bx, by, bz, depth - 1, w, b, branches)
    if (branches && depth >= 3 && rand() < 0.35) {
      const bl = len * (0.4 + rand() * 0.4)
      split(
        mx,
        my,
        mz,
        mx + (rand() - 0.5) * bl,
        my - bl * (0.5 + rand() * 0.4),
        mz + (rand() - 0.5) * bl,
        depth - 2,
        w * 0.5,
        b * 0.45,
        false,
      )
    }
  }
  split(s.top[0]!, s.top[1]!, s.top[2]!, s.foot[0]!, s.foot[1]!, s.foot[2]!, 7, 4, 1, true)
  s.count = n
}

const x = new Float64Array(3)
const y = new Float64Array(3)
const d = new Float64Array(3)
const rotation = [0, 0, 0, 1]

function towardLight(dir: Float64Array): number[] {
  let ax = dir[2]!
  let az = -dir[0]!
  let len = Math.sqrt(ax * ax + az * az)
  if (len < 1e-6) {
    ax = 1
    az = 0
    len = 1
  }
  x[0] = ax / len
  x[1] = 0
  x[2] = az / len
  y[0] = dir[1]! * x[2]! - dir[2]! * x[1]!
  y[1] = dir[2]! * x[0]! - dir[0]! * x[2]!
  y[2] = dir[0]! * x[1]! - dir[1]! * x[0]!
  return quat.fromBasis(rotation, x, y, dir)
}

export function spawnFlashLight(world: World): void {
  const s = world.resource(LightningState)
  s.light = world.spawn(
    [
      DirectionalLight,
      { color: [0.8, 0.85, 1, 1] as never, illuminance: 0, shadows: false, angularDiameter: 0 },
    ],
    Transform,
  )
}

/** Strikes lightning at a world position on the next frame (a ground strike, whatever the weather). */
export function strikeLightning(world: World, position: ArrayLike<number>): void {
  world.resource(LightningState).pending = Float64Array.from([
    position[0]!,
    position[1]!,
    position[2]!,
  ])
}

/**
 * Lightning (0133): strikes come more often the higher the thunder channel, at random places
 * around the listener. Each lights the clouds from inside (SkyFlash), flashes the land (a
 * DirectionalLight from the strike), and a ground strike draws a bolt. Raises LightningStrike with
 * the thunder's delay.
 */
export const updateLightning = defineSystem({
  name: 'weather/lightning',
  description: 'Places lightning strikes, flashes the land and clouds, and builds bolts (0133).',
  run: (_, world) => {
    const s = world.resource(LightningState)
    const state = world.resource(WeatherState)
    const now = world.tryResource(Time)?.elapsed ?? 0
    const thunder = state.channels[CH.thunder]!
    const pending = s.pending
    if (pending || (thunder > 0.02 && now >= s.next)) {
      s.strikes++
      s.start = now
      s.ground = pending !== undefined || rand() < 0.55
      const L = state.listener
      const angle = pending
        ? Math.atan2(pending[2]! - L[2]!, pending[0]! - L[0]!)
        : rand() * Math.PI * 2
      const dist = pending
        ? Math.hypot(pending[0]! - L[0]!, pending[2]! - L[2]!)
        : 700 + rand() * 5000
      s.pending = undefined
      let base = 1600
      for (const table of world.query({ with: [Clouds] }).tables) {
        if (table.count > 0) base = table.column(Clouds, 'bottom')[0]!
      }
      s.top[0] = L[0]! + Math.cos(angle) * dist
      s.top[1] = base + 300
      s.top[2] = L[2]! + Math.sin(angle) * dist
      s.foot[0] = s.top[0]! + (rand() - 0.5) * 600
      s.foot[1] = 0
      s.foot[2] = s.top[2]! + (rand() - 0.5) * 600
      if (s.ground) buildBolt(s)
      else s.count = 0
      s.next = now + (1.5 + rand() * 9) / Math.max(thunder, 0.05)
      world.send(LightningStrike, {
        position: [s.foot[0]!, s.foot[1]!, s.foot[2]!],
        distance: dist,
        thunderIn: dist / 343,
      })
    }
    // Re-strokes: a flash, then one or two more within a third of a second.
    const t = now - s.start
    let e = 0
    if (t >= 0 && t < 0.6) {
      for (const at of [0, 0.09, 0.23]) {
        if (t >= at) e += Math.exp(-(t - at) / 0.045)
      }
    }
    s.envelope = e
    s.bolt = t >= 0 && t < 0.55 ? Math.max(e, 0.35 * (1 - t / 0.55)) : 0
    const flash = world.tryResource(SkyFlash)
    if (flash) {
      flash.position[0] = s.top[0]!
      flash.position[1] = s.top[1]! + 200
      flash.position[2] = s.top[2]!
      flash.strength = e * (s.ground ? 9000 : 5000)
    }
    if (s.light !== -1 && world.isAlive(s.light as Entity)) {
      const L = state.listener
      d[0] = s.top[0]! - L[0]!
      d[1] = s.top[1]! - L[1]!
      d[2] = s.top[2]! - L[2]!
      const len = Math.sqrt(d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!) || 1
      d[0] = d[0]! / len
      d[1] = d[1]! / len
      d[2] = d[2]! / len
      const lux = e * (s.ground ? 40 : 15) * (3000 / (3000 + len))
      const light = world.get(s.light as Entity, DirectionalLight)
      if (light.illuminance !== lux) {
        world.set(s.light as Entity, DirectionalLight, { illuminance: lux } as never)
        if (lux > 0) world.set(s.light as Entity, Transform, { rotation: towardLight(d) as never })
      }
    }
  },
})
