/**
 * Headless test maneuvers (0118): scripted drives on a flat plane (or a grade) that measure a
 * vehicle: 0–100 km/h, top speed per gear, 100–0 braking, skidpad grip, step steer, the steepest
 * grade it climbs, and its understeer gradient. `shard vehicle test` and the tests run these.
 */
import type { Entity, World } from '@aethervtt/shard-core'
import { type SurfacePreset, Velocity } from '@aethervtt/shard-physics'
import type { App } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import {
  VehicleAssists,
  VehicleInput,
  VehicleState,
  VehicleTransmission,
  WheelState,
} from './components'
import { gearRatio } from './sim'
import { VehicleSimsResource } from './sims'

export const MANEUVERS = [
  'accel',
  'top',
  'brake',
  'skidpad',
  'step',
  'climb',
  'understeer',
] as const
export type Maneuver = (typeof MANEUVERS)[number]

/** Makes a fresh app with ground of the surface (top at y = 0, rising toward −Z by `grade`) and spawns the vehicle. */
export type ManeuverStage = (options: {
  surface: SurfacePreset
  grade: number
}) => Promise<{ app: App; vehicle: Entity }>

export interface VehicleTestReport {
  surface: SurfacePreset
  /** 0–100 km/h, s (undefined: never got there in 30 s). */
  accel?: { to60: number | undefined; to100: number | undefined; quarterMile: number | undefined }
  /** Rev-limited speed per forward gear from the ratios (km/h), and the speed reached in 60 s. */
  top?: { perGear: number[]; reached: number }
  /** From 100 km/h (or `brakeFrom`) to a stop, m, and whether ABS acted. */
  brake?: { distance: number; abs: boolean; from: number }
  /** Highest steady lateral acceleration on a constant steer, g. */
  skidpad?: { lateralG: number }
  /** A full-lock step at speed: peak drift angle (deg), spun (past 90°), rolled (past 70°), two wheels lifted. */
  step?: { speed: number; peakDrift: number; spun: boolean; rolled: boolean; lifted: boolean }
  /** Steepest grade climbed from a standstill, percent. */
  climb?: { grade: number }
  /** Understeer gradient K (s²/m) for ESC's reference. */
  understeer?: { k: number }
}

const DT = 1 / 60
const KMH = 3.6

function input(world: World, car: Entity, values: Record<string, number>): void {
  world.set(car, VehicleInput, { throttle: 0, brake: 0, steer: 0, handbrake: 0, ...values })
}

function state(world: World, car: Entity) {
  return world.get(car, VehicleState)
}

function position(world: World, car: Entity): [number, number, number] {
  const t = world.get(car, Transform).translation
  return [t[0], t[1], t[2]]
}

/** Up axis of the chassis (y of its rotated +Y). */
function upY(world: World, car: Entity): number {
  const [x, y, z, w] = world.get(car, Transform).rotation
  return 1 - 2 * (x * x + z * z) + 0 * (y * w)
}

/** Settles the vehicle for a second with no input. */
function settle(app: App, car: Entity): void {
  input(app.world, car, {})
  for (let i = 0; i < 60; i++) app.update(DT)
}

/** Full throttle until a speed (m/s) or a time limit; returns the time or undefined. */
function accelerateTo(app: App, car: Entity, speed: number, limit: number): number | undefined {
  const world = app.world
  input(world, car, { throttle: 1 })
  for (let t = 0; t < limit / DT; t++) {
    app.update(DT)
    if (state(world, car).speed >= speed) return (t + 1) * DT
  }
  return undefined
}

export async function runManeuver(
  stage: ManeuverStage,
  maneuver: Maneuver,
  surface: SurfacePreset,
  report: VehicleTestReport,
  options: { brakeFrom?: number } = {},
): Promise<void> {
  switch (maneuver) {
    case 'accel': {
      const { app, vehicle } = await stage({ surface, grade: 0 })
      settle(app, vehicle)
      const world = app.world
      const start = position(world, vehicle)
      input(world, vehicle, { throttle: 1 })
      let to60: number | undefined
      let to100: number | undefined
      let quarter: number | undefined
      for (let t = 1; t <= 30 / DT; t++) {
        app.update(DT)
        const v = state(world, vehicle).speed * KMH
        if (to60 === undefined && v >= 60) to60 = t * DT
        if (to100 === undefined && v >= 100) to100 = t * DT
        const p = position(world, vehicle)
        if (quarter === undefined && Math.hypot(p[0] - start[0], p[2] - start[2]) >= 402.3)
          quarter = t * DT
        if (to100 !== undefined && quarter !== undefined) break
      }
      report.accel = { to60, to100, quarterMile: quarter }
      return
    }
    case 'top': {
      const { app, vehicle } = await stage({ surface, grade: 0 })
      const world = app.world
      settle(app, vehicle)
      const sim = world.resource(VehicleSimsResource).sims.get(vehicle)
      const perGear: number[] = []
      if (sim?.transmission && sim.engine && sim.wheels.length > 0) {
        const r = sim.wheels.find((w) => w.drive > 0)?.radius ?? sim.wheels[0]!.radius
        for (let g = 1; g <= sim.transmission.gears.length; g++) {
          const ratio = gearRatio(sim.transmission, g)
          perGear.push(((sim.engine.max * 2 * Math.PI) / 60 / ratio) * r * KMH)
        }
      }
      input(world, vehicle, { throttle: 1 })
      let reached = 0
      for (let t = 0; t < 60 / DT; t++) {
        app.update(DT)
        reached = Math.max(reached, state(world, vehicle).speed * KMH)
      }
      report.top = { perGear, reached }
      return
    }
    case 'brake': {
      const { app, vehicle } = await stage({ surface, grade: 0 })
      const world = app.world
      settle(app, vehicle)
      const reachedAt = accelerateTo(app, vehicle, (options.brakeFrom ?? 100) / KMH, 90)
      const from = state(world, vehicle).speed * KMH
      if (reachedAt === undefined) {
        report.brake = { distance: Number.NaN, abs: false, from }
        return
      }
      const start = position(world, vehicle)
      input(world, vehicle, { brake: 1 })
      let abs = false
      for (let t = 0; t < 30 / DT; t++) {
        app.update(DT)
        const st = state(world, vehicle)
        if (st.assists & 1) abs = true
        if (st.speed <= 0.05) break
      }
      const end = position(world, vehicle)
      report.brake = { distance: Math.hypot(end[0] - start[0], end[2] - start[2]), abs, from }
      return
    }
    case 'skidpad': {
      const { app, vehicle } = await stage({ surface, grade: 0 })
      const world = app.world
      settle(app, vehicle)
      // A fixed steer while the speed creeps up; lateral acceleration from the change of
      // velocity across the chassis, averaged over half a second.
      let best = 0
      let avg = 0
      let prev = world.get(vehicle, Velocity).linear
      for (let t = 0; t < 40 / DT; t++) {
        const st = state(world, vehicle)
        const target = 4 + t * DT * 0.6
        const throttle = Math.max(0, Math.min(1, (target - st.speed) * 0.5 + 0.2))
        input(world, vehicle, { throttle, steer: -0.35 })
        app.update(DT)
        const v = world.get(vehicle, Velocity).linear
        const [qx, qy, qz, qw] = world.get(vehicle, Transform).rotation
        // Chassis right (+X) in the world.
        const rx = 1 - 2 * (qy * qy + qz * qz)
        const ry = 2 * (qx * qy + qw * qz)
        const rz = 2 * (qx * qz - qw * qy)
        const a = ((v[0] - prev[0]) * rx + (v[1] - prev[1]) * ry + (v[2] - prev[2]) * rz) / DT
        prev = v
        avg += (Math.abs(a) / 9.81 - avg) * (DT / 0.5)
        if (t * DT > 2 && avg > best) best = avg
        // Spun: stop measuring.
        if (Math.abs(st.driftAngle) > 0.5) break
      }
      report.skidpad = { lateralG: best }
      return
    }
    case 'step': {
      const { app, vehicle } = await stage({ surface, grade: 0 })
      const world = app.world
      settle(app, vehicle)
      const speed = 100 / KMH
      accelerateTo(app, vehicle, speed, 40)
      // Hold the speed briefly, then a full-lock step.
      for (let t = 0; t < 30; t++) {
        const st = state(world, vehicle)
        input(world, vehicle, { throttle: st.speed < speed ? 0.6 : 0.1 })
        app.update(DT)
      }
      const at = state(world, vehicle).speed * KMH
      let peak = 0
      let rolled = false
      let lifted = false
      for (let t = 0; t < 4 / DT; t++) {
        input(world, vehicle, { steer: 1 })
        app.update(DT)
        const st = state(world, vehicle)
        peak = Math.max(peak, Math.abs(st.driftAngle))
        if (upY(world, vehicle) < Math.cos((70 * Math.PI) / 180)) rolled = true
        const sim = world.resource(VehicleSimsResource).sims.get(vehicle)
        if (sim) {
          let left = 0
          let right = 0
          for (const wh of sim.wheels) if (!wh.grounded) wh.side === 0 ? left++ : right++
          if (left >= 2 || right >= 2) lifted = true
        }
      }
      report.step = {
        speed: at,
        peakDrift: (peak * 180) / Math.PI,
        spun: peak > Math.PI / 2,
        rolled,
        lifted,
      }
      return
    }
    case 'climb': {
      // Binary search the grade (percent) it climbs 20 m up from a standstill in 20 s.
      let lo = 0
      let hi = 100
      for (let k = 0; k < 6; k++) {
        const grade = (lo + hi) / 2
        const { app, vehicle } = await stage({ surface, grade: grade / 100 })
        const world = app.world
        settle(app, vehicle)
        const start = position(world, vehicle)
        input(world, vehicle, { throttle: 1 })
        let ok = false
        for (let t = 0; t < 20 / DT; t++) {
          app.update(DT)
          const p = position(world, vehicle)
          if (start[2] - p[2] > 20) {
            ok = true
            break
          }
        }
        if (ok) lo = grade
        else hi = grade
      }
      report.climb = { grade: Math.round(lo) }
      return
    }
    case 'understeer': {
      // Steady state on a small steer at two speeds: r = v δ / (L (1 + K v²)) gives K.
      const ks: number[] = []
      for (const v of [10, 20]) {
        const { app, vehicle } = await stage({ surface, grade: 0 })
        const world = app.world
        if (world.has(vehicle, VehicleAssists))
          world.set(vehicle, VehicleAssists, { esc: 0, counterSteer: 0 })
        settle(app, vehicle)
        accelerateTo(app, vehicle, v, 30)
        let yaw = 0
        let delta = 0
        let speed = 0
        for (let t = 0; t < 6 / DT; t++) {
          const st = state(world, vehicle)
          input(world, vehicle, {
            throttle: Math.max(0, Math.min(1, (v - st.speed) * 0.4 + 0.15)),
            steer: -0.08,
          })
          app.update(DT)
          const sim = world.resource(VehicleSimsResource).sims.get(vehicle)
          if (!sim) break
          yaw = sim.w[0]! * sim.up[0]! + sim.w[1]! * sim.up[1]! + sim.w[2]! * sim.up[2]!
          delta = sim.steerAngle
          speed = st.speed
        }
        const sim = world.resource(VehicleSimsResource).sims.get(vehicle)
        if (!sim || Math.abs(yaw) < 1e-4) continue
        const k = ((speed * delta) / (sim.wheelbase * yaw) - 1) / (speed * speed)
        ks.push(k)
      }
      const k = ks.length > 0 ? Math.max(0, ks.reduce((a, b) => a + b, 0) / ks.length) : 0
      report.understeer = { k }
      return
    }
  }
}

/** Runs the maneuvers on a surface (all by default) into a report. */
export async function testVehicle(
  stage: ManeuverStage,
  options: { surface?: SurfacePreset; maneuvers?: readonly Maneuver[]; brakeFrom?: number } = {},
): Promise<VehicleTestReport> {
  const surface = options.surface ?? 'asphalt'
  const report: VehicleTestReport = { surface }
  for (const m of options.maneuvers ?? MANEUVERS)
    await runManeuver(stage, m, surface, report, options)
  return report
}

/** Whether every wheel is grounded (a sanity check for stages). */
export function allGrounded(world: World, wheels: Entity[]): boolean {
  return wheels.every((w) => world.get(w, WheelState).grounded)
}

/** Forward ratios of a vehicle's gearbox (for reports). */
export function gearsOf(world: World, car: Entity): number[] {
  return world.has(car, VehicleTransmission) ? [...world.get(car, VehicleTransmission).gears] : []
}
