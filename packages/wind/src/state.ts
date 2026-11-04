import { defineComponent, defineSystem, type Entity, t, type World } from '@aethervtt/shard-core'
import { NetClock, NetRole, NetSession, Replicated } from '@aethervtt/shard-net'
import { FixedTime } from '@aethervtt/shard-runtime'
import { Wind, type WindValue } from './wind'

/**
 * The server's wind, for clients (0096): resources don't replicate (0087), so the wind lives on a
 * singleton entity. Every machine copies it into `Wind` once the server's tick reaches `fromTick`,
 * so they all switch on the same tick. Replicate it with `replicate(WindState, { channel:
 * 'reliable' })`; the wind plugin then keeps the singleton on the server.
 */
export const WindState = defineComponent(
  'wind/WindState',
  {
    direction: t.vec3({ default: [1, 0, 0.35] }),
    speed: t.f32({ default: 6, min: 0, unit: 'm/s' }),
    gustiness: t.f32({ default: 0.3, min: 0, max: 1 }),
    gustScale: t.f32({ default: 0.05, min: 0, unit: '1/m' }),
    fromTick: t.u32({ description: 'The server tick it takes effect on, everywhere.' }),
  },
  {
    description:
      'The wind from a server tick on (0096): the server writes it when its Wind changes (or ahead of time, with scheduleWind), and every machine copies it into Wind at fromTick.',
  },
)

/** The server's tick now: FixedTime's, or on a client the NetClock estimate. */
export function serverTick(world: World): number {
  const role = world.tryResource(NetRole)
  if (role?.role === 'client') return Math.floor(world.tryResource(NetClock)?.serverTick ?? 0)
  return world.tryResource(FixedTime)?.tick ?? 0
}

/** The WindState singleton's table row, if there is one. */
function singleton(s: SyncState): boolean {
  for (const table of s.query.tables) {
    if (table.count === 0) continue
    s.entity = table.entities[0]!
    s.fromTick = table.column(WindState, 'fromTick')[0]!
    return true
  }
  return false
}

/**
 * Changes the wind on every machine at `fromTick` (a server tick; default now). On a server, give
 * clients time to receive it: a tick a few round trips ahead switches them all exactly then.
 */
export function scheduleWind(
  world: World,
  wind: Partial<WindValue>,
  fromTick = serverTick(world),
): void {
  const current = world.resource(Wind)
  const value = {
    direction: [...(wind.direction ?? current.direction)] as [number, number, number],
    speed: wind.speed ?? current.speed,
    gustiness: wind.gustiness ?? current.gustiness,
    gustScale: wind.gustScale ?? current.gustScale,
    fromTick,
  }
  let entity: Entity | undefined
  for (const table of world.query({ with: [WindState] }).tables)
    if (table.count > 0) entity = table.entities[0]
  if (entity !== undefined) world.set(entity, WindState, value)
  else if (replicatesWind(world))
    world.spawn([WindState, value], [Replicated, { prefab: '', owner: 0 }])
  else world.spawn([WindState, value])
}

/** Whether this is a server that replicates WindState. */
function replicatesWind(world: World): boolean {
  const session = world.tryResource(NetSession)
  if (session?.role !== 'server') return false
  for (const c of session.manifest.components) if (c.def === WindState) return true
  return false
}

interface SyncState {
  query: ReturnType<World['query']>
  /** The singleton and its fromTick, as `singleton` last found them. */
  entity: Entity
  fromTick: number
  /** The wind last published or applied: direction xyz, speed, gustiness, gustScale. */
  last: Float64Array
  /** fromTick of the WindState last applied (-1: none). */
  applied: number
}

function differs(last: Float64Array, w: WindValue): boolean {
  const d = w.direction
  return (
    last[0] !== d[0] ||
    last[1] !== d[1] ||
    last[2] !== d[2] ||
    last[3] !== w.speed ||
    last[4] !== w.gustiness ||
    last[5] !== w.gustScale
  )
}

function remember(last: Float64Array, w: WindValue): void {
  last[0] = w.direction[0]
  last[1] = w.direction[1]
  last[2] = w.direction[2]
  last[3] = w.speed
  last[4] = w.gustiness
  last[5] = w.gustScale
}

/**
 * Applies WindState at its tick; on the server (or with no network), publishes changes the game
 * made to Wind into WindState, from the tick they were seen.
 */
export const syncWind = defineSystem({
  name: 'wind/sync',
  description:
    'Copies wind/WindState into Wind once the server tick reaches its fromTick; on the server, writes Wind changes into WindState for clients.',
  setup: (world): SyncState => ({
    query: world.query({ with: [WindState] }),
    entity: 0 as Entity,
    fromTick: 0,
    last: new Float64Array(6).fill(Number.NaN),
    applied: -1,
  }),
  run: (s, world) => {
    const wind = world.resource(Wind)
    const tick = serverTick(world)
    const found = singleton(s)
    if (found && s.fromTick !== s.applied && s.fromTick <= tick) {
      const state = world.get(s.entity, WindState)
      wind.direction[0] = state.direction[0]
      wind.direction[1] = state.direction[1]
      wind.direction[2] = state.direction[2]
      wind.speed = state.speed
      wind.gustiness = state.gustiness
      wind.gustScale = state.gustScale
      s.applied = s.fromTick
      remember(s.last, wind)
      return
    }
    if (world.tryResource(NetRole)?.role === 'client') return
    if (Number.isNaN(s.last[0]!)) {
      remember(s.last, wind)
      // A server that replicates WindState keeps the singleton from the start.
      if (!found && replicatesWind(world)) publish(world, s, wind, tick)
    } else if (differs(s.last, wind)) {
      // The game changed Wind: clients follow from this tick (late by their latency; schedule
      // ahead with scheduleWind to switch everyone on the same tick).
      if (found || replicatesWind(world)) publish(world, s, wind, tick)
      else remember(s.last, wind)
    }
  },
})

/**
 * Writes Wind into WindState from this tick. The next frame copies it back into Wind here too, so
 * the server runs on the same (f32) values its clients receive.
 */
function publish(world: World, s: SyncState, wind: WindValue, tick: number): void {
  scheduleWind(world, wind, tick)
  remember(s.last, wind)
}
