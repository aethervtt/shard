import { type AssetRef, ChildOf, type Entity, type World } from '@aethervtt/shard-core'
import { Collider, Mass, RigidBody, Velocity } from '@aethervtt/shard-physics'
import { Transform } from '@aethervtt/shard-transform'
import { VEHICLE_CLASS_VALUES, type VehicleClass } from './classes'
import {
  Vehicle,
  VehicleAssists,
  VehicleEngine,
  VehicleInput,
  VehicleSeat,
  VehicleTransmission,
  VehicleWheel,
} from './components'
import { tirePreset } from './tire'

export interface SpawnVehicleOptions {
  /** Starting values (default sedan). */
  class?: VehicleClass
  /** Chassis origin: the axles' height when sitting at ride height. */
  at?: [number, number, number]
  /** Yaw in radians (0 faces −Z). */
  yaw?: number
  /** Overrides, merged over the class's. */
  vehicle?: Record<string, unknown>
  engine?: Record<string, unknown> | false
  transmission?: Record<string, unknown>
  assists?: Record<string, unknown>
  wheel?: Record<string, unknown>
  mass?: number
  comHeight?: number
  tire?: AssetRef<'vehicle/Tire'> | null
  /**
   * Wheel centers in the chassis frame with axle and side; default: four at the class's track
   * and wheelbase (more rear axles with `axles: 3`).
   */
  wheels?: { at: [number, number, number]; axle: number; side: 'left' | 'right' | 'center' }[]
  /** Rear axles (default 1): trucks and buses have two. */
  rearAxles?: number
  /** Add a body box collider from the class (default true). */
  body?: boolean
  /** Add a driver seat (default true). */
  seat?: boolean
}

export interface SpawnedVehicle {
  chassis: Entity
  wheels: Entity[]
  body: Entity | undefined
  seat: Entity | undefined
}

/**
 * Spawns a drivable vehicle from a class's values (0118): chassis with Mass and a low center of
 * mass, a body box that characters can't stop, wheels at the class's track and wheelbase, an
 * engine and gearbox, input, and a driver seat. Faces −Z.
 */
export function spawnVehicle(world: World, options: SpawnVehicleOptions = {}): SpawnedVehicle {
  const c = VEHICLE_CLASS_VALUES[options.class ?? 'sedan']
  const at = options.at ?? [0, c.radius + 0.01, 0]
  const yaw = options.yaw ?? 0
  const rearAxles = Math.max(1, options.rearAxles ?? 1)
  const axles = [structuredClone(c.axles[0])]
  for (let i = 0; i < rearAxles; i++) {
    const rear = structuredClone(c.axles[1])
    if (rearAxles > 1) rear.drive = c.axles[1].drive / rearAxles
    axles.push(rear)
  }
  const chassis = world.spawn(
    [Transform, { translation: at, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] }],
    [RigidBody, { kind: 'dynamic' }],
    [Velocity, {}],
    [
      Mass,
      {
        mass: options.mass ?? c.mass,
        center: 'authored',
        centerOfMass: [0, options.comHeight ?? c.comHeight, 0],
        inertiaScale: [1, 1, 1],
      },
    ],
    [
      Vehicle,
      {
        axles,
        centerDiff: c.centerDiff,
        aeroDrag: c.aeroDrag,
        steer: {
          maxAngle: c.maxSteer,
          ackermann: 1,
          speed: 180,
          returnSpeed: 360,
          atSpeed: [
            [0, 1],
            [30, 0.35],
          ],
        },
        ...(options.vehicle ?? {}),
      },
    ],
    [VehicleInput, {}],
  )
  if (options.engine !== false) {
    world.add(chassis, VehicleEngine, { ...c.engine, ...(options.engine ?? {}) })
    world.add(chassis, VehicleTransmission, { ...c.gearbox, ...(options.transmission ?? {}) })
  }
  if (options.assists) world.add(chassis, VehicleAssists, options.assists)
  let body: Entity | undefined
  if (options.body !== false) {
    body = world.spawn(
      [Transform, { translation: [0, c.bodyY, 0] }],
      [Collider, { shape: 'cuboid', halfExtents: c.body, ignoreCharacters: true }],
      [ChildOf, { parent: chassis }],
    )
  }
  const spots =
    options.wheels ??
    (() => {
      const out: NonNullable<SpawnVehicleOptions['wheels']> = []
      const front = -c.wheelbase / 2
      out.push({ at: [-c.track / 2, 0, front], axle: 0, side: 'left' })
      out.push({ at: [c.track / 2, 0, front], axle: 0, side: 'right' })
      for (let i = 0; i < rearAxles; i++) {
        const z = c.wheelbase / 2 + i * (c.radius * 2 + 0.25)
        out.push({ at: [-c.track / 2, 0, z], axle: 1 + i, side: 'left' })
        out.push({ at: [c.track / 2, 0, z], axle: 1 + i, side: 'right' })
      }
      return out
    })()
  const wheels: Entity[] = []
  for (const spot of spots) {
    wheels.push(
      world.spawn(
        [Transform, { translation: spot.at }],
        [
          VehicleWheel,
          {
            axle: spot.axle,
            side: spot.side,
            radius: c.radius,
            width: c.width,
            mass: c.wheelMass,
            frequency: c.frequency,
            damping: c.damping,
            travel: c.travel,
            tire: options.tire === undefined ? tirePreset(c.tire) : options.tire,
            ...(options.wheel ?? {}),
          },
        ],
        [ChildOf, { parent: chassis }],
      ),
    )
  }
  let seat: Entity | undefined
  if (options.seat !== false) {
    seat = world.spawn(
      [Transform, { translation: [-c.track / 4, c.bodyY - 0.05, -0.1] }],
      [VehicleSeat, { role: 'driver', exit: [-c.track / 2 - 0.7, -c.bodyY + 0.1, 0] }],
      [ChildOf, { parent: chassis }],
    )
  }
  return { chassis, wheels, body, seat }
}
