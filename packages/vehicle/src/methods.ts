import { defineSchema, type Entity, ShardError, t, type World } from '@aethervtt/shard-core'
import {
  physics3dPlugin,
  SURFACE_PRESETS,
  type SurfacePreset,
  Surfaces,
} from '@aethervtt/shard-physics'
import { App, type AppMethod } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { Vehicle } from './components'
import { groundTiles } from './ground'
import { MANEUVERS, type Maneuver, testVehicle, type VehicleTestReport } from './maneuvers'
import { vehiclePlugin } from './plugin'
import { VehicleSimsResource } from './sims'
import { captureVehicle, rideHeight, spawnTemplate, type VehicleTemplate } from './template'

const DEG = 180 / Math.PI
const RPM = 60 / (2 * Math.PI)

/** One vehicle: its state and every wheel's, or every vehicle's summary. */
export function describeVehicle(world: World, entity: Entity) {
  const sim = world.tryResource(VehicleSimsResource)?.sims.get(entity)
  if (!sim || !world.has(entity, Vehicle)) {
    throw new ShardError('vehicle/not-a-vehicle', `Entity ${entity} has no vehicle/Vehicle`, {
      hint: 'vehicle.describe without an entity lists every vehicle.',
    })
  }
  const names = world.tryResource(Surfaces)?.names ?? []
  return {
    entity,
    ok: sim.ok,
    error: sim.error ?? null,
    mass: sim.mass,
    wheelbase: sim.wheelbase,
    speed: sim.speed,
    kmh: sim.speed * 3.6,
    rpm: sim.engine ? sim.omegaE * RPM : null,
    gear: sim.shiftLeft > 0 ? 0 : sim.gear,
    running: sim.engine ? sim.running : null,
    clutch: sim.clutch,
    throttle: sim.throttle,
    grounded: sim.grounded,
    airTime: sim.airTime,
    driftAngle: sim.driftAngle * DEG,
    steer: sim.steerAngle * DEG,
    assists: {
      abs: (sim.assistFlags & 1) !== 0,
      tcs: (sim.assistFlags & 2) !== 0,
      esc: (sim.assistFlags & 4) !== 0,
    },
    standstill: sim.sticky,
    wheels: sim.wheels.map((w) => ({
      entity: w.entity,
      axle: w.axle,
      side: w.side === 0 ? 'left' : w.side === 1 ? 'right' : 'center',
      grounded: w.grounded,
      compression: (w.x + w.travelDown) / Math.max(1e-6, w.travelUp + w.travelDown),
      load: w.load,
      sprungMass: w.sprungMass,
      surface: names[w.surface] ?? w.surface,
      slipRatio: w.slipRatio,
      slipAngle: w.slipAngle * DEG,
      skid: w.skid,
      spin: w.omega,
      steer: w.steer * DEG,
      sinkage: w.sinkage,
      pinned: w.pin === 1 ? 'locked' : w.pin === 2 ? 'abs' : null,
    })),
  }
}

function summary(world: World) {
  const sims = world.tryResource(VehicleSimsResource)
  if (!sims) return { vehicles: [], active: 0, stepMs: 0 }
  return {
    vehicles: [...sims.sims.values()].map((s) => ({
      entity: s.entity,
      ok: s.ok,
      error: s.error ?? null,
      speed: s.speed,
      gear: s.gear,
      rpm: s.engine ? s.omegaE * RPM : null,
      grounded: s.grounded,
    })),
    active: sims.active,
    stepMs: sims.stepMs,
  }
}

/**
 * Runs maneuvers on a copy of a vehicle in a fresh headless app (the caller's world is left
 * alone): flat ground of `surface`, deterministic physics.
 */
export async function testTemplate(
  template: VehicleTemplate,
  options: { surface?: SurfacePreset; maneuvers?: readonly Maneuver[]; brakeFrom?: number } = {},
): Promise<VehicleTestReport> {
  const height = rideHeight(template)
  return testVehicle(async ({ surface, grade }) => {
    const app = new App().addPlugin(
      TransformPlugin,
      physics3dPlugin({ deterministic: true }),
      vehiclePlugin(),
    )
    await app.init()
    groundTiles(app.world, { surface, grade })
    const vehicle = spawnTemplate(app.world, template, [0, height, 0])
    return { app, vehicle }
  }, options)
}

export const vehicleMethods: AppMethod[] = [
  {
    name: 'vehicle.describe',
    description:
      'Vehicles (0118). Without an entity: each vehicle’s speed, gear, rpm and wheels on the ground, and the step’s ms. With an entity: its state (speed, rpm, gear, clutch, throttle after TCS, drift angle, steer, assists acting, standstill) and every wheel’s (compression, load, sprung mass, surface, slip ratio and angle, skid, spin, steer, sinkage, pinned by brakes or ABS).',
    params: defineSchema('vehicle/DescribeParams', {
      entity: t.entity({ description: 'A vehicle chassis (or its scene path).' }),
    }),
    handler: ({ world }, p) => {
      const entity = p.entity as Entity | null
      if (entity !== null && entity !== undefined && entity >= 0)
        return describeVehicle(world, entity)
      return summary(world)
    },
  },
  {
    name: 'vehicle.test',
    description:
      'Runs headless maneuvers on a copy of a vehicle (0118) on flat ground: accel (0–60, 0–100 km/h, quarter mile), top (rev-limited speed per gear, speed reached in 60 s), brake (100–0 distance, ABS), skidpad (lateral g), step (100 km/h full-lock step: peak drift, spun, rolled, lifted), climb (steepest grade, %), understeer (K for ESC). The running world is left alone.',
    params: defineSchema('vehicle/TestParams', {
      entity: t.entity({ description: 'The vehicle to copy.' }),
      surface: t.string({ default: 'asphalt', description: 'A surface preset name.' }),
      maneuvers: t.list(t.string, {
        description: `Which to run (default all): ${MANEUVERS.join(', ')}.`,
      }),
    }),
    handler: async ({ world }, p) => {
      const entity = p.entity as Entity
      if (!world.has(entity, Vehicle)) {
        throw new ShardError('vehicle/not-a-vehicle', `Entity ${entity} has no vehicle/Vehicle`)
      }
      const surface = ((p.surface as string) || 'asphalt') as SurfacePreset
      if (!(surface in SURFACE_PRESETS)) {
        throw new ShardError('physics/unknown-surface', `No surface preset "${surface}"`, {
          hint: `Presets: ${Object.keys(SURFACE_PRESETS).join(', ')}.`,
        })
      }
      const list = ((p.maneuvers as string[] | undefined) ?? []).filter((m) =>
        (MANEUVERS as readonly string[]).includes(m),
      ) as Maneuver[]
      return testTemplate(captureVehicle(world, entity), {
        surface,
        maneuvers: list.length > 0 ? list : MANEUVERS,
      })
    },
  },
]
