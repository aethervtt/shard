/**
 * Driver-owned vehicle networking (0118), `@aethervtt/shard-vehicle/net`. A vehicle's
 * `Replicated.owner` is its driver's peer (0: the server). The driver's client simulates it
 * (`OwnerSimulated` keeps replication off it) and sends its state each network tick as a
 * `vehicle/Drive` command; the server checks speed, acceleration and that it didn't pass through
 * static colliders, then writes the state to its copy, which replicates to everyone else. A failed
 * check rejects the command and hands the vehicle to the server for `lockout` seconds; the
 * driver's client then takes the server's pose. Vehicles nobody drives are the server's.
 */
import {
  defineResource,
  defineSystem,
  type Entity,
  FixedUpdate,
  t,
  type World,
} from '@aethervtt/shard-core'
import {
  commands,
  defineNetCommand,
  NetRole,
  OwnerSimulated,
  Replicated,
  type ReplicationEntry,
  replicate,
  sendCommand,
} from '@aethervtt/shard-net'
import { Physics, PhysicsSystems, RigidBody, Velocity } from '@aethervtt/shard-physics'
import { definePlugin, FixedTime, type Plugin } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import type RAPIER from '@dimforge/rapier3d-compat'
import { Vehicle, VehicleState } from './components'
import { gearRatio } from './sim'
import { VehicleSimsResource } from './sims'

/** The driver's state for one network tick. */
export const VehicleDrive = defineNetCommand(
  'vehicle/Drive',
  {
    vehicle: t.entity(),
    translation: t.vec3(),
    rotation: t.quat(),
    linear: t.vec3(),
    angular: t.vec3(),
    rpm: t.f32(),
    gear: t.i8(),
    steer: t.f32(),
    throttle: t.f32(),
    load: t.f32(),
    clutch: t.f32(),
    speed: t.f32(),
  },
  { description: 'A driving client’s vehicle state, checked and applied by the server (0118).' },
)

export interface VehicleNetConfigValue {
  /** States are rejected above this share of the vehicle's top speed (plus 3 m/s). */
  speedScale: number
  /** Accelerations above this are rejected (m/s²). */
  maxAccel: number
  /** Seconds the server keeps a vehicle after rejecting its driver's state. */
  lockout: number
  /** States the driver sends per second (at most the server's commandsPerSecond). */
  sendRate: number
}

export const VehicleNetConfig = defineResource<VehicleNetConfigValue>('vehicle/NetConfig', {
  description: 'Driver-owned vehicle checks (0118).',
  init: () => ({ speedScale: 1.25, maxAccel: 40, lockout: 1, sendRate: 30 }),
})

/** Replication for vehicles, beside the game's Transform: state for audio and visuals, velocity. */
export function vehicleReplicate(): ReplicationEntry[] {
  return [replicate(VehicleState), replicate(Velocity, { mode: 'interpolate' })]
}

/** Server: hands a vehicle to a driver (a peer), or back to the server (0). */
export function setDriver(world: World, vehicle: Entity, peer: number): void {
  world.set(vehicle, Replicated, { owner: peer })
  world.resource(DriveState).lockouts.delete(vehicle)
}

/** Whether this app simulates the vehicle: the server for undriven ones, a client for its own. */
export function simulatesVehicle(world: World, vehicle: Entity): boolean {
  const role = world.tryResource(NetRole)
  if (!role) return true
  const table = world.entityTable(vehicle)
  const owner = table.has(Replicated)
    ? table.column(Replicated, 'owner')[world.entityRow(vehicle)]!
    : 0
  return role.role === 'server' ? owner === 0 : role.peer !== 0 && owner === role.peer
}

interface Accepted {
  tick: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

const DriveState = defineResource<{
  last: Map<Entity, Accepted>
  lockouts: Map<Entity, { peer: number; until: number }>
  sent: Map<Entity, number>
}>('vehicle/DriveState', {
  description: 'Driver-owned vehicles: last accepted states, lockouts, send times (0118).',
  init: () => ({ last: new Map(), lockouts: new Map(), sent: new Map() }),
})

/** A vehicle's top speed from its gearing (m/s), or 60 without an engine. */
function topSpeed(world: World, vehicle: Entity): number {
  const sim = world.tryResource(VehicleSimsResource)?.sims.get(vehicle)
  if (!sim?.engine || !sim.transmission || sim.wheels.length === 0) return 60
  const r = sim.wheels.reduce((m, w) => Math.max(m, w.radius), 0)
  let top = 0
  for (let g = 1; g <= sim.transmission.gears.length; g++) {
    top = Math.max(top, ((sim.engine.max * 2 * Math.PI) / 60 / gearRatio(sim.transmission, g)) * r)
  }
  return top
}

/** Bodies follow authority: dynamic where this app simulates, kinematic (posed) elsewhere. */
const bodies = defineSystem({
  name: 'vehicle/net-bodies',
  description: 'Makes vehicle bodies dynamic where this app simulates them, kinematic elsewhere.',
  setup: (world) => ({ vehicles: world.query({ with: [Vehicle, RigidBody, Replicated] }) }),
  run: (s, world) => {
    if (!world.tryResource(NetRole)) return
    for (const table of s.vehicles.tables) {
      for (let row = table.count - 1; row >= 0; row--) {
        const e = table.entities[row]!
        const kind = simulatesVehicle(world, e) ? 'dynamic' : 'kinematic-position'
        if (world.get(e, RigidBody).kind !== kind) world.set(e, RigidBody, { kind })
      }
    }
  },
})

/** Server: drive commands, checked, applied or rejected; lockouts expire. */
const receive = defineSystem({
  name: 'vehicle/net-receive',
  description: 'Checks drivers’ vehicle states and applies them, or rejects and takes the vehicle.',
  run: (_, world) => {
    const role = world.tryResource(NetRole)
    if (role?.role !== 'server') return
    const state = world.resource(DriveState)
    const config = world.resource(VehicleNetConfig)
    const fixed = world.resource(FixedTime)
    for (const [vehicle, lock] of state.lockouts) {
      if (fixed.elapsed < lock.until) continue
      state.lockouts.delete(vehicle)
      if (world.isAlive(vehicle)) world.set(vehicle, Replicated, { owner: lock.peer })
    }
    for (const cmd of commands(world, VehicleDrive)) {
      const d = cmd.data
      const vehicle = d.vehicle as Entity | null
      if (vehicle === null || !world.isAlive(vehicle) || !world.has(vehicle, Vehicle)) {
        cmd.reject('vehicle/not-a-vehicle', 'No such vehicle')
        continue
      }
      if (world.get(vehicle, Replicated).owner !== cmd.peer) {
        cmd.reject('vehicle/not-driver', 'Another peer drives this vehicle')
        continue
      }
      const reason = check(world, vehicle, cmd.arrivedTick, d, config, state)
      if (reason) {
        cmd.reject('vehicle/rejected', reason)
        // The server takes it for a moment: the driver's client follows its pose meanwhile.
        state.lockouts.set(vehicle, { peer: cmd.peer, until: fixed.elapsed + config.lockout })
        state.last.delete(vehicle)
        world.set(vehicle, Replicated, { owner: 0 })
        continue
      }
      world.set(vehicle, Transform, { translation: d.translation, rotation: d.rotation })
      world.set(vehicle, Velocity, { linear: d.linear, angular: d.angular })
      world.set(vehicle, VehicleState, {
        rpm: d.rpm,
        gear: d.gear,
        steer: d.steer,
        throttle: d.throttle,
        load: d.load,
        clutch: d.clutch,
        speed: d.speed,
      })
      state.last.set(vehicle, {
        tick: cmd.arrivedTick,
        x: d.translation[0],
        y: d.translation[1],
        z: d.translation[2],
        vx: d.linear[0],
        vy: d.linear[1],
        vz: d.linear[2],
      })
      cmd.accept()
    }
  },
})

/** The ball swept along a driver's move (made once Rapier is loaded). */
let ball: RAPIER.Ball | undefined

function ballFor(R: { Ball: typeof RAPIER.Ball }): RAPIER.Ball {
  ball ??= new R.Ball(0.4)
  return ball
}

/** Why a driver's state is refused, or undefined. */
function check(
  world: World,
  vehicle: Entity,
  tick: number,
  d: { translation: readonly number[]; linear: readonly number[] },
  config: VehicleNetConfigValue,
  state: { last: Map<Entity, Accepted> },
): string | undefined {
  const vx = d.linear[0]!
  const vy = d.linear[1]!
  const vz = d.linear[2]!
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz)
  const top = topSpeed(world, vehicle) * config.speedScale + 3
  if (!(speed <= top)) return `speed ${speed.toFixed(1)} m/s over ${top.toFixed(1)}`
  const last = state.last.get(vehicle)
  const from =
    last ??
    (() => {
      const t = world.get(vehicle, Transform).translation
      return { tick, x: t[0], y: t[1], z: t[2], vx: 0, vy: 0, vz: 0 }
    })()
  const dt = Math.max(1, tick - from.tick) * world.resource(FixedTime).step
  if (last) {
    const dv = Math.sqrt((vx - last.vx) ** 2 + (vy - last.vy) ** 2 + (vz - last.vz) ** 2)
    if (dv / dt > config.maxAccel + 10) return `acceleration ${(dv / dt).toFixed(0)} m/s²`
  }
  const tx = d.translation[0]!
  const ty = d.translation[1]!
  const tz = d.translation[2]!
  const dx = tx - from.x
  const dy = ty - from.y
  const dz = tz - from.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (last && dist > (top + 2) * dt + 1) return `moved ${dist.toFixed(1)} m in ${dt.toFixed(2)} s`
  // Through a wall: a ball swept from the last pose to this one meets a fixed collider first.
  const p = world.tryResource(Physics)
  if (p && dist > 0.05) {
    const flags = p.R.QueryFilterFlags.EXCLUDE_DYNAMIC | p.R.QueryFilterFlags.EXCLUDE_KINEMATIC
    const origin = [from.x, from.y + 0.5, from.z]
    const hit = p.raw.castShape(
      { x: origin[0]!, y: origin[1]!, z: origin[2]! },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: dx / dist, y: dy / dist, z: dz / dist },
      ballFor(p.R),
      0,
      dist,
      true,
      flags | p.R.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      p.bodies.get(vehicle)?.body,
    )
    if (hit && hit.time_of_impact < dist - 0.05) return 'passed through a wall'
  }
  return undefined
}

/** Client: the driver's state, sent at `sendRate`. After the physics step. */
const send = defineSystem({
  name: 'vehicle/net-send',
  description: 'Sends the state of vehicles this client drives to the server.',
  setup: (world) => ({ vehicles: world.query({ with: [Vehicle, Replicated] }) }),
  run: (s, world) => {
    const role = world.tryResource(NetRole)
    if (role?.role !== 'client' || !role.connected) return
    const state = world.resource(DriveState)
    const config = world.resource(VehicleNetConfig)
    const now = world.resource(FixedTime).elapsed
    for (const table of s.vehicles.tables) {
      for (let row = 0; row < table.count; row++) {
        const e = table.entities[row]!
        if (!simulatesVehicle(world, e)) continue
        const last = state.sent.get(e) ?? -Infinity
        if (now - last < 1 / config.sendRate - 1e-6) continue
        state.sent.set(e, now)
        const tr = world.get(e, Transform)
        const v = world.tryGet(e, Velocity)
        const st = world.tryGet(e, VehicleState)
        sendCommand(world, VehicleDrive, {
          vehicle: e,
          translation: tr.translation,
          rotation: tr.rotation,
          linear: v?.linear ?? [0, 0, 0],
          angular: v?.angular ?? [0, 0, 0],
          rpm: st?.rpm ?? 0,
          gear: st?.gear ?? 0,
          steer: st?.steer ?? 0,
          throttle: st?.throttle ?? 0,
          load: st?.load ?? 0,
          clutch: st?.clutch ?? 0,
          speed: st?.speed ?? 0,
        })
      }
    }
  },
})

/**
 * Driver-owned vehicles over 0086–0089 networking (0118). Add on both sides, with `VehicleDrive`
 * in `netPlugin({ commands })`, `vehicleReplicate()` and the game's Transform in its replicate
 * list, and `OwnerSimulated` on vehicles (spawnVehicle's prefab hook adds it on clients).
 */
export function vehicleNetPlugin(options: Partial<VehicleNetConfigValue> = {}): Plugin {
  return definePlugin({
    name: 'vehicle/net',
    dependencies: ['vehicle'],
    build(app) {
      const w = app.world
      Object.assign(w.initResource(VehicleNetConfig), options)
      w.initResource(DriveState)
      w.initResource(VehicleSimsResource).simulates = simulatesVehicle
      app.addSystems(FixedUpdate, bodies.before(PhysicsSystems))
      app.addSystems(FixedUpdate, receive.before(bodies))
      app.addSystems(FixedUpdate, send.after(PhysicsSystems))
    },
  })
}

export { OwnerSimulated }
