import type { Entity, World } from '@aethervtt/shard-core'
import { Collider, RigidBody, type SurfacePreset, Velocity } from '@aethervtt/shard-physics'
import { App } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import {
  NO_GEAR,
  VehicleEngine,
  VehicleEngineEvent,
  VehicleInput,
  VehicleShiftEvent,
  VehicleState,
  WheelState,
} from './components'
import { testVehicle } from './maneuvers'
import { VehicleSimsResource } from './plugin'
import { checkGears, gearRatio, sprungMasses } from './sim'
import { drive, frames, ground, spawnCar, vehicleApp } from './testing'

const KMH = 3.6

async function stage(
  options: Parameters<typeof spawnCar>[1] = {},
  surface?: Parameters<typeof ground>[1],
) {
  const app = await vehicleApp()
  ground(app.world, surface)
  const car = spawnCar(app.world, options)
  return { app, world: app.world, car }
}

function y(world: World, e: Entity): number {
  return world.get(e, Transform).translation[1]
}

function pos(world: World, e: Entity): [number, number, number] {
  const t = world.get(e, Transform).translation
  return [t[0], t[1], t[2]]
}

function speed(world: World, e: Entity): number {
  return world.get(e, VehicleState).speed
}

describe('setup', () => {
  it('sprung masses balance about the center of mass', () => {
    const m = sprungMasses([-0.8, 0.8, -0.8, 0.8], [-1.2, -1.2, 1.5, 1.5], 1500)!
    expect(m.reduce((a, b) => a + b)).toBeCloseTo(1500, 6)
    // Front axle nearer the center carries more.
    expect(m[0]!).toBeGreaterThan(m[2]!)
    let mz = 0
    for (const [i, z] of [-1.2, -1.2, 1.5, 1.5].entries()) mz += m[i]! * z
    expect(mz).toBeCloseTo(0, 6)
    // Center of mass behind every support: a negative mass.
    expect(sprungMasses([-0.8, 0.8], [1, 1], 1000)).toBeUndefined()
  })

  it('rejects gears that would hunt', () => {
    expect(checkGears([3.6, 2.1, 1.4, 1.0, 0.8], 0.85, 0.4)).toBeUndefined()
    expect(checkGears([3.6, 1.0], 0.85, 0.4)).toMatch(/hunt/)
    expect(checkGears([2.0, 2.5], 0.85, 0.4)).toMatch(/isn't below/)
  })

  it('reports a chassis without a dynamic body', async () => {
    const app = await vehicleApp()
    const { chassis } = spawnCar(app.world)
    app.world.set(chassis, RigidBody, { kind: 'fixed' })
    frames(app, 2)
    expect(app.world.resource(VehicleSimsResource).sims.get(chassis)?.error).toBe(
      'vehicle/not-dynamic',
    )
  })
})

describe('suspension and standstill', () => {
  it('settles at ride height and sleeps', async () => {
    const { app, world, car } = await stage({ at: [0, 0.83, 0] })
    frames(app, 90)
    for (const w of car.wheels) {
      // Ride height: the chassis origin sits at the wheel radius above the ground.
      expect(Math.abs(y(world, car.chassis) - 0.33)).toBeLessThan(0.01)
      expect(world.get(w, WheelState).grounded).toBe(true)
    }
    frames(app, 90)
    expect(world.get(car.chassis, Velocity).linear.every((v) => Math.abs(v) < 1e-3)).toBe(true)
    const p = world.resource(VehicleSimsResource).sims.get(car.chassis)!
    expect(p.sticky).toBe(true)
  })

  it('holds on a 20% grade with the handbrake', async () => {
    const { app, world, car } = await stage({}, { grade: 0.2 })
    // Spawned level above the slope: let it land and settle, then hold.
    drive(world, car.chassis, { handbrake: 1 })
    frames(app, 120)
    const before = pos(world, car.chassis)
    frames(app, 600)
    const after = pos(world, car.chassis)
    expect(Math.hypot(after[0] - before[0], after[2] - before[2])).toBeLessThan(0.01)
  })

  it('rolls slowly without jitter, and coasts without grabbing', async () => {
    const { app, world, car } = await stage()
    frames(app, 60)
    world.set(car.chassis, Velocity, { linear: [0, 0, -0.5] })
    let flips = 0
    let last = 0
    let lateral = 0
    for (let i = 0; i < 300; i++) {
      frames(app, 1)
      const spin = world.get(car.wheels[0]!, WheelState).spin
      if (last !== 0 && Math.sign(spin) !== Math.sign(last) && Math.abs(spin) > 1e-3) flips++
      if (Math.abs(spin) > 1e-3) last = spin
      const v = world.get(car.chassis, Velocity).linear
      lateral = Math.max(lateral, Math.abs(v[0]))
    }
    expect(flips).toBe(0)
    expect(lateral).toBeLessThan(0.001)
    // Coasting at 1 m/s: rolling resistance and drag only, well under 0.1 g.
    world.set(car.chassis, Velocity, { linear: [0, 0, -1] })
    frames(app, 2)
    const v0 = speed(world, car.chassis)
    frames(app, 30)
    const v1 = speed(world, car.chassis)
    expect((v0 - v1) / 0.5 / 9.81).toBeLessThan(0.1)
  })
})

describe('drivetrain', () => {
  it('reaches each gear’s rev-limited speed', async () => {
    const { app, world, car } = await stage({
      vehicle: { aeroDrag: 0 },
      transmission: { mode: 'manual' },
    })
    frames(app, 30)
    const sim = world.resource(VehicleSimsResource).sims.get(car.chassis)!
    for (let g = 1; g <= 3; g++) {
      drive(world, car.chassis, { gear: g, throttle: 1 })
      // Run up to the limiter in this gear.
      for (let i = 0; i < 1200; i++) {
        frames(app, 1)
        if (world.get(car.chassis, VehicleState).rpm > sim.engine!.max - 30) break
      }
      frames(app, 30)
      const expected =
        ((sim.engine!.max * 2 * Math.PI) / 60 / gearRatio(sim.transmission!, g)) * 0.33
      expect(Math.abs(speed(world, car.chassis) - expected) / expected).toBeLessThan(0.02)
    }
  })

  it('shifts up through every gear without hunting, and down under braking', async () => {
    for (const throttle of [1, 0.5]) {
      // Start at the far end: the run is long.
      const { app, world, car } = await stage({ at: [0, 0.34, 1400] })
      frames(app, 30)
      const shifts: { from: number; to: number }[] = []
      const reader = world.reader(VehicleShiftEvent)
      drive(world, car.chassis, { throttle })
      const top = throttle === 1 ? 5 : 4
      for (let i = 0; i < 60 * 70 && world.get(car.chassis, VehicleState).gear < top; i++) {
        frames(app, 1)
        for (const e of reader.read()) shifts.push({ from: e.from, to: e.to })
      }
      // Every shift goes up while accelerating.
      expect(shifts.length).toBeGreaterThanOrEqual(throttle === 1 ? 4 : 3)
      for (const s of shifts) expect(s.to).toBe(s.from + 1)
      // Moderate braking: the box steps down through the gears before the stop.
      const down: { from: number; to: number }[] = []
      drive(world, car.chassis, { brake: 0.4 })
      for (let i = 0; i < 60 * 20 && speed(world, car.chassis) > 3; i++) {
        frames(app, 1)
        for (const e of reader.read()) down.push({ from: e.from, to: e.to })
      }
      expect(down.some((s) => s.to < s.from && s.to >= 1)).toBe(true)
    }
  })

  it('stalls a manual stopped in gear with the clutch released', async () => {
    const { app, world, car } = await stage({
      engine: { stall: true },
      transmission: { mode: 'manual', clutch: 'pedal' },
    })
    frames(app, 30)
    const reader = world.reader(VehicleEngineEvent)
    const kinds: string[] = []
    drive(world, car.chassis, { clutch: 1, gear: 1, brake: 1 })
    frames(app, 30)
    drive(world, car.chassis, { clutch: 0, brake: 1, gear: NO_GEAR })
    for (let i = 0; i < 60; i++) {
      frames(app, 1)
      for (const e of reader.read()) kinds.push(e.kind)
    }
    expect(kinds).toContain('stalled')
    expect(world.get(car.chassis, VehicleEngine).running).toBe(false)
  })
})

describe('handling', () => {
  const surfaceStage =
    (assists?: Record<string, unknown>, extra = {}) =>
    async ({ surface, grade }: { surface: SurfacePreset; grade: number }) => {
      const app = await vehicleApp()
      ground(app.world, { surface, grade })
      const car = spawnCar(app.world, { assists, ...extra })
      return { app, vehicle: car.chassis }
    }

  it('brakes within 10% of v²/2μg with ABS, and slides without it', async () => {
    const abs = await testVehicle(surfaceStage({ abs: 1 }), { maneuvers: ['brake'] })
    const v = abs.brake!.from / KMH
    const ideal = (v * v) / (2 * 1 * 9.81)
    expect(abs.brake!.abs).toBe(true)
    expect(abs.brake!.distance).toBeLessThan(ideal * 1.1)
    const locked = await testVehicle(surfaceStage(), { maneuvers: ['brake'] })
    expect(locked.brake!.distance).toBeGreaterThan(abs.brake!.distance * 1.15)
  }, 120_000)

  it('holds its heading with locked front wheels under full steer', async () => {
    const { app, world, car } = await stage()
    frames(app, 30)
    drive(world, car.chassis, { throttle: 1 })
    while (speed(world, car.chassis) < 20) frames(app, 1)
    const q0 = world.get(car.chassis, Transform).rotation
    drive(world, car.chassis, { brake: 1, steer: 1 })
    frames(app, 60)
    const q1 = world.get(car.chassis, Transform).rotation
    const dot = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3])
    const angle = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
    expect(angle).toBeLessThan(2)
  })

  it('corners at 0.8–1 g, and ice brakes 7× longer', async () => {
    const pad = await testVehicle(surfaceStage(), { maneuvers: ['skidpad'] })
    expect(pad.skidpad!.lateralG).toBeGreaterThan(0.8)
    expect(pad.skidpad!.lateralG).toBeLessThan(1.0)
    // From 30 km/h with traction control: on ice a rear-drive car at full throttle spins round.
    const dry = await testVehicle(surfaceStage({ abs: 1, tcs: 1 }), {
      maneuvers: ['brake'],
      brakeFrom: 30,
    })
    const ice = await testVehicle(surfaceStage({ abs: 1, tcs: 1 }), {
      maneuvers: ['brake'],
      surface: 'ice',
      brakeFrom: 30,
    })
    // Ice is braked from whatever speed it reached; compare decelerations.
    const decel = (r: typeof dry) => (r.brake!.from / KMH) ** 2 / (2 * r.brake!.distance)
    expect(decel(dry) / decel(ice)).toBeGreaterThan(7)
  }, 240_000)

  it('survives a 100 km/h step steer with ESC, and rolls with a high center of mass', async () => {
    const safe = await testVehicle(surfaceStage({ preset: 'sim', esc: 1 }), {
      maneuvers: ['step'],
    })
    expect(safe.step!.peakDrift).toBeLessThan(15)
    expect(safe.step!.lifted).toBe(false)
    const tall = await testVehicle(
      surfaceStage({ esc: 0 }, { comHeight: 0.82, wheel: { forceHeight: 0 } }),
      {
        maneuvers: ['step'],
      },
    )
    expect(tall.step!.rolled).toBe(true)
  }, 120_000)

  it('ESC with a measured understeer leaves a steady 0.5 g corner alone', async () => {
    const k = (await testVehicle(surfaceStage(), { maneuvers: ['understeer'] })).understeer!.k
    const { app, world, car } = await stage({ assists: { esc: 1, understeer: k } })
    frames(app, 30)
    // 0.5 g on a 50 m radius: v = √(0.5 g R) ≈ 15.7 m/s.
    let acted = 0
    for (let i = 0; i < 60 * 25; i++) {
      const st = world.get(car.chassis, VehicleState)
      const want = 15.7
      const sim = world.resource(VehicleSimsResource).sims.get(car.chassis)!
      // Steer for a 50 m radius: δ ≈ L/R (1 + K v²), as a share of the lock at this speed.
      const delta = (2.7 / 50) * (1 + k * st.speed * st.speed)
      const lock = sim.steering.maxAngle * Math.max(0.35, 1 - (0.65 * st.speed) / 30)
      drive(world, car.chassis, {
        throttle: Math.max(0, Math.min(1, (want - st.speed) * 0.3 + 0.2)),
        steer: -delta / lock,
      })
      frames(app, 1)
      if (i > 60 * 15 && st.assists & 4) acted++
    }
    expect(acted).toBe(0)
  }, 60_000)

  it('arcade: a handbrake turn holds a 20–45° drift with counter-steer', async () => {
    const { app, world, car } = await stage({ assists: { preset: 'arcade' } })
    frames(app, 30)
    drive(world, car.chassis, { throttle: 1 })
    while (speed(world, car.chassis) < 60 / KMH) frames(app, 1)
    drive(world, car.chassis, { throttle: 0.6, steer: 1, handbrake: 1 })
    frames(app, 25)
    let held = 0
    let best = 0
    for (let i = 0; i < 60 * 4; i++) {
      const drift = (world.get(car.chassis, VehicleState).driftAngle * 180) / Math.PI
      // Driver: throttle on, steering toward a 30° slide (into the turn when it's less, against
      // it when it's more); the counter-steer assist adds its share.
      drive(world, car.chassis, {
        throttle: 0.75,
        steer: Math.max(-1, Math.min(1, 0.3 - (Math.abs(drift) - 30) * 0.04)),
      })
      frames(app, 1)
      if (Math.abs(drift) >= 20 && Math.abs(drift) <= 45) held++
      else held = 0
      best = Math.max(best, held)
    }
    expect(best / 60).toBeGreaterThanOrEqual(2)
  })
})

describe('surfaces', () => {
  it('sand stops a coasting car in under a quarter of asphalt’s distance', async () => {
    const coast = async (surface?: 'sand') => {
      const { app, world, car } = await stage({}, { surface })
      frames(app, 60)
      world.set(car.chassis, Velocity, { linear: [0, 0, -40 / KMH] })
      frames(app, 1)
      const start = pos(world, car.chassis)
      for (let i = 0; i < 60 * 120 && speed(world, car.chassis) > 0.05; i++) frames(app, 1)
      const end = pos(world, car.chassis)
      return Math.abs(end[2] - start[2])
    }
    const asphalt = await coast()
    const sand = await coast('sand')
    expect(sand).toBeLessThan(asphalt / 4)
  }, 120_000)

  it('mud: 2WD digs in and stays; locked 4WD on half throttle drives out', async () => {
    {
      const { app, world, car } = await stage({}, { surface: 'mud' })
      frames(app, 60)
      const start = pos(world, car.chassis)
      drive(world, car.chassis, { throttle: 1 })
      frames(app, 180)
      const sim = world.resource(VehicleSimsResource).sims.get(car.chassis)!
      const rear = sim.wheels.filter((w) => w.drive > 0)
      for (const w of rear) expect(w.dug).toBeGreaterThanOrEqual(w.maxSinkage * 0.8)
      const end = pos(world, car.chassis)
      expect(Math.abs(end[2] - start[2])).toBeLessThan(1)
    }
    {
      const { app, world, car } = await stage(
        {
          class: 'offroad',
          vehicle: {
            centerDiff: 'locked',
          },
        },
        { surface: 'mud' },
      )
      const v = world.get(car.chassis, (await import('./components')).Vehicle)
      world.set(car.chassis, (await import('./components')).Vehicle, {
        axles: v.axles.map((a) => ({ ...a, differential: 'locked' as const })),
      })
      frames(app, 60)
      const start = pos(world, car.chassis)
      drive(world, car.chassis, { throttle: 0.5 })
      frames(app, 600)
      const end = pos(world, car.chassis)
      expect(Math.abs(end[2] - start[2])).toBeGreaterThan(10)
    }
  }, 120_000)

  it('split grip: an open diff needs TCS or a preloaded limited slip to move off', async () => {
    const run = async (assists: Record<string, unknown> | undefined, lsd: boolean) => {
      const app = await vehicleApp()
      const world = app.world
      // Left half ice, right half asphalt, split along x = 0 under the car's left wheels.
      for (const [x, surface] of [
        [-50.4, 'ice'],
        [49.6, 'asphalt'],
      ] as const) {
        world.spawn(
          [RigidBody, { kind: 'fixed' }],
          [
            Collider,
            {
              shape: 'cuboid',
              halfExtents: [50, 0.5, 200],
              surface: (await import('@aethervtt/shard-physics')).surfacePreset(surface),
            },
          ],
          [Transform, { translation: [x, -0.5, 0] }],
        )
      }
      const car = spawnCar(world, { assists })
      if (lsd) {
        const V = (await import('./components')).Vehicle
        const v = world.get(car.chassis, V)
        world.set(car.chassis, V, {
          axles: v.axles.map((a, i) =>
            i === 1 ? { ...a, differential: 'limited-slip' as const, preload: 250 } : a,
          ),
        })
      }
      frames(app, 60)
      const start = pos(world, car.chassis)
      drive(world, car.chassis, { throttle: 0.6 })
      frames(app, 300)
      const end = pos(world, car.chassis)
      return Math.abs(end[2] - start[2])
    }
    // An open diff with a whole wheel on ice barely moves (the iced wheel just spins).
    const open = await run(undefined, false)
    const tcs = await run({ tcs: 1 }, false)
    const lsd = await run(undefined, true)
    expect(tcs).toBeGreaterThan(open * 3)
    expect(lsd).toBeGreaterThan(open * 3)
    expect(open).toBeLessThan(5)
  }, 120_000)
})

describe('hits, visuals, determinism', () => {
  it('a character hit costs the car its mass share of speed, once', async () => {
    // No drivetrain: nothing but the hit changes its speed over the contact.
    const { app, world, car } = await stage({ vehicle: { aeroDrag: 0 }, engine: false })
    const { CharacterController } = await import('@aethervtt/shard-physics')
    const { VehicleHitEvent } = await import('./components')
    const ch = world.spawn(
      [Transform, { translation: [0, 0.95, -12] }],
      [CharacterController, { radius: 0.3, height: 1.8 }],
    )
    frames(app, 30)
    // Coast at 10 m/s, no rolling losses to speak of over the contact.
    world.set(car.chassis, Velocity, { linear: [0, 0, -10] })
    const reader = world.reader(VehicleHitEvent)
    const hits: number[] = []
    let before = 0
    let after = 0
    for (let i = 0; i < 120; i++) {
      const b = speed(world, car.chassis)
      frames(app, 1)
      for (const e of reader.read()) {
        if (hits.length === 0) {
          before = b
          after = speed(world, car.chassis)
        }
        hits.push(e.speed)
      }
    }
    expect(hits).toHaveLength(1)
    expect(hits[0]!).toBeGreaterThan(9)
    // Momentum by mass: 1,500 kg at 10 m/s against 70 kg loses 70 / 1,570 of its speed.
    const lost = (before - after) / before
    expect(Math.abs(lost - 70 / 1570) / (70 / 1570)).toBeLessThan(0.02)
    expect(world.isAlive(ch)).toBe(true)
  })

  it('the visual spins distance over radius', async () => {
    const { app, world, car } = await stage()
    frames(app, 30)
    const start = pos(world, car.chassis)
    const a0 = world.get(car.wheels[0]!, WheelState).angle
    world.set(car.chassis, Velocity, { linear: [0, 0, -8] })
    frames(app, 120)
    const end = pos(world, car.chassis)
    const a1 = world.get(car.wheels[0]!, WheelState).angle
    const dist = Math.hypot(end[0] - start[0], end[2] - start[2])
    expect(Math.abs((a1 - a0) * 0.33 - dist) / dist).toBeLessThan(0.01)
  })

  it('two runs give the same state', async () => {
    const run = async () => {
      const { app, world, car } = await stage({ assists: { preset: 'arcade' } })
      for (let i = 0; i < 600; i++) {
        drive(world, car.chassis, {
          throttle: i < 300 ? 1 : 0.3,
          steer: Math.sin(i / 40),
          brake: i > 500 ? 0.5 : 0,
        })
        frames(app, 1)
      }
      const st = world.get(car.chassis, VehicleState)
      return [...pos(world, car.chassis), st.rpm, st.gear, st.speed].map((v) => v.toFixed(6))
    }
    expect(await run()).toEqual(await run())
  })
})

void App
void VehicleInput
