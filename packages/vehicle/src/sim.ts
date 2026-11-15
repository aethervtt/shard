/**
 * The vehicle simulation (0118): per physics step, wheel probes, suspension, and a small
 * sequential-impulse solver over the chassis, the wheels and the drivetrain, integrated in
 * substeps on a local copy of the chassis velocity, then written back to Rapier once.
 */
import type { Entity, World } from '@aethervtt/shard-core'
import type { PhysicsWorld, SurfaceRegistry, SurfaceSample } from '@aethervtt/shard-physics'
import { gripCurve, type TireValue } from './tire'

const TAU = Math.PI * 2
const RPM = 60 / TAU
const DEG = Math.PI / 180

export const SIDE_LEFT = 0
export const SIDE_RIGHT = 1
export const SIDE_CENTER = 2

export const DIFF_OPEN = 0
export const DIFF_LSD = 1
export const DIFF_LOCKED = 2

export const PIN_NONE = 0
export const PIN_LOCK = 1
export const PIN_ABS = 2

export const ASSIST_ABS = 1
export const ASSIST_TCS = 2
export const ASSIST_ESC = 4

/** One wheel's settings and state. Plain numbers, built once, mutated per step. */
export interface WheelSim {
  entity: Entity
  axle: number
  side: number
  radius: number
  width: number
  inertia: number
  tire: TireValue
  /** False while the tire asset loads (the wheel drives on road meanwhile). */
  tireReady: boolean
  frequency: number
  dampBump: number
  dampRebound: number
  travelUp: number
  travelDown: number
  camber: number
  forceHeight: number
  gripScale: number
  visual: Entity
  /** Model node name to find the visual by, when `visual` isn't set. */
  visualName: string
  /** Hardpoint (wheel center at ride height) in the chassis frame. */
  hx: number
  hy: number
  hz: number
  /** Drive coefficient: share of driveshaft torque this wheel gets (axle drive / wheels on it). */
  drive: number
  sprungMass: number
  staticLoad: number
  k: number
  cBump: number
  cRebound: number

  // --- per step ---
  grounded: boolean
  /** Suspension displacement from ride height, m (+ compressed). */
  x: number
  /** Compression speed, m/s (+ compressing). */
  xdot: number
  px: number
  py: number
  pz: number
  nx: number
  ny: number
  nz: number
  ground: Entity
  /** Ground body when it moves (dynamic or kinematic), else −1. */
  groundBody: Entity
  groundDynamic: boolean
  gvx: number
  gvy: number
  gvz: number
  surface: number
  surfaceB: number
  surfaceWeight: number
  grip: number
  rolling: number
  loose: number
  sinkSurface: number
  drag: number
  dig: number
  maxSinkage: number
  bumpAmp: number
  bumpWave: number
  /** Dug depth (m), grows while spinning on soft ground. */
  dug: number
  sinkage: number
  load: number
  omega: number
  angle: number
  steer: number
  slipRatio: number
  slipAngle: number
  skid: number
  /** Ground-plane forward and right (world). */
  fx: number
  fy: number
  fz: number
  sx: number
  sy: number
  sz: number
  /** Tire force arm from the center of mass (raised by forceHeight) and the contact arm. */
  rx: number
  ry: number
  rz: number
  cx: number
  cy: number
  cz: number
  /** Hardpoint arm from the center of mass. */
  ax: number
  ay: number
  az: number
  /** Inverse effective masses of the chassis: along forward and right at the tire arm, up at the hardpoint. */
  kf: number
  ks: number
  ku: number
  /** Per-substep impulse bounds and accumulators. */
  limX: number
  limY: number
  accX: number
  accY: number
  brakeBound: number
  accBrake: number
  /** Assist modulation for the next step. */
  absScale: number
  tcsBrake: number
  escBrake: number
  /** Sum of impulses on the chassis at the contact this step, for the ground body's reaction. */
  ix: number
  iy: number
  iz: number
  /** Suspension force this step, N. */
  spring: number
  /** Load smoothed over about 0.15 s. */
  loadAvg: number
  /** Softness (1 / (stiffness · h)) of the tire's longitudinal and lateral constraints. */
  softX: number
  softY: number
  /** Pinned this substep: locked by the brakes, or held at `absSlip` by ABS. */
  pin: number
  absSlip: number
  /** 1 / inertia, or 0 while pinned. */
  invI: number
  /** Step's peak compression speed into the bump stop. */
  bottomSpeed: number
  /** The surface under it changed this step. */
  surfaceChanged: boolean
  /** Visual interpolation: previous step's values. */
  prevX: number
  prevAngle: number
  prevSteer: number
}

export interface AxleSim {
  steer: number
  drive: number
  diff: number
  torqueBias: number
  preload: number
  antiRoll: number
  brakeTorque: number
  handbrakeTorque: number
  /** Wheel indices: left, right (−1 none), and every wheel on it. */
  left: number
  right: number
  wheels: number[]
  /** Mean hardpoint z and x (chassis frame). */
  z: number
  /** Accumulated lock impulse this substep. */
  accLock: number
}

export interface EngineSim {
  torque: Float64Array
  idle: number
  max: number
  stallRpm: number
  stall: boolean
  inertia: number
  braking: number
  torqueScale: number
}

export interface TransmissionSim {
  manual: boolean
  pedal: boolean
  gears: Float64Array
  reverse: number
  finalDrive: number
  efficiency: number
  shiftTime: number
  clutchTorque: number
  upshift: number
  downshift: number
  reverseOnBrake: boolean
}

export interface AssistSim {
  abs: number
  tcs: number
  esc: number
  understeer: number
  counterSteer: number
  driftGrip: number
  driftHold: number
  downforce: number
  airX: number
  airY: number
  airZ: number
  selfRight: boolean
  antiFlip: number
}

export interface SteerSim {
  maxAngle: number
  ackermann: number
  speed: number
  returnSpeed: number
  atSpeed: Float64Array
}

/** The driver's inputs for a step. */
export interface InputSim {
  throttle: number
  brake: number
  steer: number
  handbrake: number
  clutch: number
  shift: number
  gear: number
}

export const createInput = (): InputSim => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: 0,
  clutch: 0,
  shift: 0,
  gear: 127,
})

/** What a step did that the plugin turns into events. Flags reset each step. */
export interface StepEvents {
  shiftFrom: number
  shiftTo: number
  shifted: boolean
  started: boolean
  stopped: boolean
  stalled: boolean
  backfire: boolean
  landed: boolean
  landedAir: number
  landedSpeed: number
  /** Took the manual shift or gear input (the plugin clears it). */
  tookShift: boolean
  tookGear: boolean
}

export class VehicleSim {
  readonly entity: Entity
  wheels: WheelSim[] = []
  axles: AxleSim[] = []
  steering: SteerSim = {
    maxAngle: 35 * DEG,
    ackermann: 1,
    speed: 180 * DEG,
    returnSpeed: 360 * DEG,
    atSpeed: new Float64Array([0, 1, 30, 0.35]),
  }
  engine: EngineSim | undefined
  transmission: TransmissionSim | undefined
  assists: AssistSim = {
    abs: 0,
    tcs: 0,
    esc: 0,
    understeer: 0.0015,
    counterSteer: 0,
    driftGrip: 1,
    driftHold: 0,
    downforce: 0,
    airX: 0,
    airY: 0,
    airZ: 0,
    selfRight: false,
    antiFlip: 0,
  }
  centerDiff = DIFF_OPEN
  centerBias = 3
  centerAcc = 0
  substeps = 4
  iterations = 3
  aeroDrag = 0.4
  cylinder = true
  mask = 0xffff
  /** Driven axles (indices), for the center differential. */
  driven: number[] = []
  /** Wheelbase and the steering reference (mean z of unsteered axles), chassis frame. */
  wheelbase = 2.6
  rearZ = 1.3
  /** Last build's tick, and whether it built (errors keep it off). */
  builtTick = -1
  ok = false
  error: string | undefined
  /** Track of what the plugin last built from, to rebuild on change. */
  sources: Entity[] = []
  /** A wheel's tire asset is still loading: rebuild until it lands. */
  pendingTires = false
  /** Characters touching the chassis at the last step (hits fire when contact starts). */
  touching = new Set<Entity>()

  // --- drivetrain state ---
  running = true
  omegaE = 0
  gear = 1
  targetGear = 1
  shiftLeft = 0
  sinceShift = 10
  clutch = 0
  clutchAcc = 0
  throttle = 0
  lastThrottle = 0
  load = 0
  tcsCut = 0
  reverseHold = 0
  sinceHandbrake = 10

  // --- chassis state ---
  steerAngle = 0
  speed = 0
  grounded = 0
  airTime = 0
  driftAngle = 0
  assistFlags = 0
  stillTime = 0
  upsideTime = 0
  sticky = false
  /** Every suspension has stopped moving (the chassis may sleep). */
  settled = false
  readonly events: StepEvents = {
    shiftFrom: 0,
    shiftTo: 0,
    shifted: false,
    started: false,
    stopped: false,
    stalled: false,
    backfire: false,
    landed: false,
    landedAir: 0,
    landedSpeed: 0,
    tookShift: false,
    tookGear: false,
  }

  // --- solver scratch: chassis velocity (world), pose, mass ---
  readonly v = new Float64Array(3)
  readonly w = new Float64Array(3)
  readonly pos = new Float64Array(3)
  readonly q = new Float64Array(4)
  readonly com = new Float64Array(3)
  readonly comLocal = new Float64Array(3)
  /** World inverse inertia, row-major 3×3. */
  readonly iinv = new Float64Array(9)
  /** Principal frame in the world (row-major 3×3), for the inertia itself. */
  readonly basis = new Float64Array(9)
  /** Chassis velocity as read at the step's start, to turn the change into a force. */
  readonly v0 = new Float64Array(3)
  readonly w0 = new Float64Array(3)
  invMass = 0
  mass = 0
  /** Unit up, forward (−Z) and right (+X) of the chassis, world. */
  readonly up = new Float64Array(3)
  readonly fwd = new Float64Array(3)
  readonly right = new Float64Array(3)

  constructor(entity: Entity) {
    this.entity = entity
  }
}

export function createWheel(entity: Entity): WheelSim {
  return {
    entity,
    axle: 0,
    side: SIDE_LEFT,
    radius: 0.33,
    width: 0.22,
    inertia: 1,
    tire: undefined as unknown as TireValue,
    tireReady: false,
    frequency: 1.6,
    dampBump: 0.4,
    dampRebound: 0.6,
    travelUp: 0.12,
    travelDown: 0.15,
    camber: 0,
    forceHeight: 0.3,
    gripScale: 1,
    visual: -1 as Entity,
    visualName: '',
    hx: 0,
    hy: 0,
    hz: 0,
    drive: 0,
    sprungMass: 0,
    staticLoad: 0,
    k: 0,
    cBump: 0,
    cRebound: 0,
    grounded: false,
    x: 0,
    xdot: 0,
    px: 0,
    py: 0,
    pz: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    ground: -1 as Entity,
    groundBody: -1 as Entity,
    groundDynamic: false,
    gvx: 0,
    gvy: 0,
    gvz: 0,
    surface: 0,
    surfaceB: 0,
    surfaceWeight: 0,
    grip: 1,
    rolling: 0.013,
    loose: 0,
    sinkSurface: 0,
    drag: 0,
    dig: 0,
    maxSinkage: 0,
    bumpAmp: 0,
    bumpWave: 1,
    dug: 0,
    sinkage: 0,
    load: 0,
    omega: 0,
    angle: 0,
    steer: 0,
    slipRatio: 0,
    slipAngle: 0,
    skid: 0,
    fx: 0,
    fy: 0,
    fz: -1,
    sx: 1,
    sy: 0,
    sz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    cx: 0,
    cy: 0,
    cz: 0,
    ax: 0,
    ay: 0,
    az: 0,
    kf: 0,
    ks: 0,
    ku: 0,
    limX: 0,
    limY: 0,
    accX: 0,
    accY: 0,
    brakeBound: 0,
    accBrake: 0,
    absScale: 1,
    tcsBrake: 0,
    escBrake: 0,
    ix: 0,
    iy: 0,
    iz: 0,
    spring: 0,
    loadAvg: 0,
    softX: 0,
    softY: 0,
    pin: 0,
    absSlip: 0,
    invI: 1,
    bottomSpeed: 0,
    surfaceChanged: false,
    prevX: 0,
    prevAngle: 0,
    prevSteer: 0,
  }
}

// --- setup math (cold) ------------------------------------------------------------

/**
 * Sprung masses (PhysX's `PxVehicleComputeSprungMasses`): supports in the ground plane relative
 * to the center of mass; exact for 1–3 supports, and for 4 or more the masses closest to equal
 * that sum to `mass` and balance about the center. Returns undefined when one comes out negative
 * (the center of mass outside the supports).
 */
export function sprungMasses(
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  mass: number,
): Float64Array | undefined {
  const n = xs.length
  const out = new Float64Array(n)
  if (n === 0) return out
  if (n === 1) {
    out[0] = mass
    return out
  }
  if (n === 2) {
    // Along the line between them: inversely by distance from the center's projection.
    const dx = xs[1]! - xs[0]!
    const dz = zs[1]! - zs[0]!
    const len2 = dx * dx + dz * dz
    if (len2 < 1e-12) {
      out[0] = out[1] = mass / 2
      return out
    }
    // The center of mass must lie on the line between them, or the vehicle tips over.
    const off = Math.abs(xs[0]! * dz - zs[0]! * dx) / Math.sqrt(len2)
    if (off > 1e-3) return undefined
    const t = -(xs[0]! * dx + zs[0]! * dz) / len2
    out[0] = mass * (1 - t)
    out[1] = mass * t
    return out[0]! < -1e-6 || out[1]! < -1e-6 ? undefined : out
  }
  // Least-norm deviation from equal shares under Σm = M, Σm x = 0, Σm z = 0 (exact for n = 3).
  const base = mass / n
  let s1 = 0
  let sx = 0
  let sz = 0
  let sxx = 0
  let sxz = 0
  let szz = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i]!
    const z = zs[i]!
    s1 += 1
    sx += x
    sz += z
    sxx += x * x
    sxz += x * z
    szz += z * z
  }
  // A Aᵀ λ = b − A (base·1), A rows: [1], [x], [z].
  const a = [s1, sx, sz, sx, sxx, sxz, sz, sxz, szz]
  const r = [mass - base * s1, -base * sx, -base * sz]
  const lambda = solve3(a, r)
  if (!lambda) {
    // Collinear supports (one axle): spread along the line.
    for (let i = 0; i < n; i++) out[i] = base
    return out
  }
  for (let i = 0; i < n; i++) {
    out[i] = base + lambda[0]! + lambda[1]! * xs[i]! + lambda[2]! * zs[i]!
    if (out[i]! < -1e-6) return undefined
  }
  return out
}

function solve3(a: number[], b: number[]): number[] | undefined {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const c0 = a4 * a8 - a5 * a7
  const c1 = a5 * a6 - a3 * a8
  const c2 = a3 * a7 - a4 * a6
  const det = a0 * c0 + a1 * c1 + a2 * c2
  if (Math.abs(det) < 1e-9 * Math.max(1, Math.abs(a0 * a4 * a8))) return undefined
  const inv = [
    c0,
    a2 * a7 - a1 * a8,
    a1 * a5 - a2 * a4,
    c1,
    a0 * a8 - a2 * a6,
    a2 * a3 - a0 * a5,
    c2,
    a1 * a6 - a0 * a7,
    a0 * a4 - a1 * a3,
  ]
  return [
    (inv[0]! * b[0]! + inv[1]! * b[1]! + inv[2]! * b[2]!) / det,
    (inv[3]! * b[0]! + inv[4]! * b[1]! + inv[5]! * b[2]!) / det,
    (inv[6]! * b[0]! + inv[7]! * b[1]! + inv[8]! * b[2]!) / det,
  ]
}

/** Checks gear ratios: descending, and shift points that don't hunt (`vehicle/bad-gears`). */
export function checkGears(
  gears: ArrayLike<number>,
  upshift: number,
  downshift: number,
): string | undefined {
  if (gears.length === 0) return 'A transmission needs at least one forward gear'
  for (let i = 0; i < gears.length; i++) {
    if (!(gears[i]! > 0)) return `Gear ${i + 1}'s ratio must be positive`
    if (i > 0 && gears[i]! >= gears[i - 1]!)
      return `Gear ${i + 1}'s ratio (${gears[i]}) isn't below gear ${i}'s (${gears[i - 1]})`
    if (i > 0 && (upshift * gears[i]!) / gears[i - 1]! <= downshift + 0.05) {
      return `Upshifting from gear ${i} at ${upshift} × maxRpm lands at ${((upshift * gears[i]!) / gears[i - 1]!).toFixed(2)} × maxRpm in gear ${i + 1}, under the downshift line (${downshift}) plus 0.05: it would hunt`
    }
  }
  return undefined
}

/** Checks a torque curve: rpm strictly increasing, at least one point (`vehicle/bad-curve`). */
export function checkCurve(points: ArrayLike<number>): string | undefined {
  if (points.length < 2) return 'A torque curve needs at least one (rpm, N·m) point'
  for (let i = 2; i < points.length; i += 2) {
    if (!(points[i]! > points[i - 2]!))
      return `Torque curve rpm must increase: ${points[i - 2]} then ${points[i]}`
  }
  return undefined
}

/** Piecewise-linear lookup in (x, y) pairs, clamped at the ends. */
export function lookup(points: Float64Array, x: number): number {
  const n = points.length
  if (n === 0) return 0
  if (x <= points[0]!) return points[1]!
  for (let i = 2; i < n; i += 2) {
    const x1 = points[i]!
    if (x <= x1) {
      const x0 = points[i - 2]!
      const y0 = points[i - 1]!
      const t = (x - x0) / (x1 - x0)
      return y0 + (points[i + 1]! - y0) * t
    }
  }
  return points[n - 1]!
}

// --- vector helpers (inlined math, out-params) -------------------------------------

/** Rotates local (x, y, z) by quaternion q into out[o..o+2]. */
function rotate(
  q: Float64Array,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  o: number,
): void {
  const qx = q[0]!
  const qy = q[1]!
  const qz = q[2]!
  const qw = q[3]!
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  out[o] = x + qw * tx + (qy * tz - qz * ty)
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz)
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx)
}

const tmp = new Float64Array(12)

/** Inverse effective mass of the chassis for an impulse along (dx, dy, dz) at arm (rx, ry, rz). */
function invEffMass(
  s: VehicleSim,
  rx: number,
  ry: number,
  rz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const cx = ry * dz - rz * dy
  const cy = rz * dx - rx * dz
  const cz = rx * dy - ry * dx
  const m = s.iinv
  const ix = m[0]! * cx + m[1]! * cy + m[2]! * cz
  const iy = m[3]! * cx + m[4]! * cy + m[5]! * cz
  const iz = m[6]! * cx + m[7]! * cy + m[8]! * cz
  return s.invMass + cx * ix + cy * iy + cz * iz
}

/** Applies impulse j·(dx, dy, dz) at arm (rx, ry, rz) to the chassis' local velocity copy. */
function impulse(
  s: VehicleSim,
  j: number,
  rx: number,
  ry: number,
  rz: number,
  dx: number,
  dy: number,
  dz: number,
): void {
  const jx = j * dx
  const jy = j * dy
  const jz = j * dz
  const v = s.v
  v[0] = v[0]! + jx * s.invMass
  v[1] = v[1]! + jy * s.invMass
  v[2] = v[2]! + jz * s.invMass
  const tx = ry * jz - rz * jy
  const ty = rz * jx - rx * jz
  const tz = rx * jy - ry * jx
  const m = s.iinv
  const w = s.w
  w[0] = w[0]! + m[0]! * tx + m[1]! * ty + m[2]! * tz
  w[1] = w[1]! + m[3]! * tx + m[4]! * ty + m[5]! * tz
  w[2] = w[2]! + m[6]! * tx + m[7]! * ty + m[8]! * tz
}

/** Velocity of the chassis at arm r along d, relative to the wheel's ground. */
function relVel(
  s: VehicleSim,
  wh: WheelSim,
  rx: number,
  ry: number,
  rz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const v = s.v
  const w = s.w
  const px = v[0]! + w[1]! * rz - w[2]! * ry - wh.gvx
  const py = v[1]! + w[2]! * rx - w[0]! * rz - wh.gvy
  const pz = v[2]! + w[0]! * ry - w[1]! * rx - wh.gvz
  return px * dx + py * dy + pz * dz
}

/** Smooth value noise in [0, 1] at (x, z), deterministic. */
export function bumpNoise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz)
  const b = hash2(ix + 1, iz)
  const c = hash2(ix, iz + 1)
  const d = hash2(ix + 1, iz + 1)
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}

function hash2(x: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

// --- the step ------------------------------------------------------------------------

/** Ground under each wheel, written by the probe. The plugin owns the Rapier queries. */
export interface ProbeHit {
  hit: boolean
  /** Center travel from the probe start along −up, m. */
  distance: number
  px: number
  py: number
  pz: number
  nx: number
  ny: number
  nz: number
  collider: Entity
  body: Entity
}

/** Reads poses, velocities and inverse inertia from Rapier into the sim. Allocates nothing. */
export function readChassis(
  s: VehicleSim,
  p: PhysicsWorld,
  slot: number,
  body: RapierBodyLike,
): void {
  const c = p.curr
  const o = slot * 7
  s.pos[0] = c[o]!
  s.pos[1] = c[o + 1]!
  s.pos[2] = c[o + 2]!
  s.q[0] = c[o + 3]!
  s.q[1] = c[o + 4]!
  s.q[2] = c[o + 5]!
  s.q[3] = c[o + 6]!
  const lv = body.linvel(p.v3 as never) as { x: number; y: number; z: number }
  s.v[0] = lv.x
  s.v[1] = lv.y
  s.v[2] = lv.z
  const av = body.angvel(p.v3 as never) as { x: number; y: number; z: number }
  s.w[0] = av.x
  s.w[1] = av.y
  s.w[2] = av.z
  s.v0.set(s.v)
  s.w0.set(s.w)
  rotate(s.q, s.comLocal[0]!, s.comLocal[1]!, s.comLocal[2]!, s.com, 0)
  s.com[0] = s.com[0]! + s.pos[0]!
  s.com[1] = s.com[1]! + s.pos[1]!
  s.com[2] = s.com[2]! + s.pos[2]!
  rotate(s.q, 0, 1, 0, s.up, 0)
  rotate(s.q, 0, 0, -1, s.fwd, 0)
  rotate(s.q, 1, 0, 0, s.right, 0)
  worldInverseInertia(s)
}

/** The bits of a Rapier body readChassis needs. */
export interface RapierBodyLike {
  linvel(target?: never): unknown
  angvel(target?: never): unknown
}

/** Local principal inverse inertia and its frame, set by the plugin when mass changes. */
export const principal = new WeakMap<
  VehicleSim,
  { inv: Float64Array; inertia: Float64Array; frame: Float64Array }
>()

/** I_world · (x, y, z) into out[o..o+2]. */
export function inertiaTimes(
  s: VehicleSim,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  o: number,
): void {
  const pr = principal.get(s)
  if (!pr) {
    out[o] = out[o + 1] = out[o + 2] = 0
    return
  }
  const b = s.basis
  // Rᵀ v, scaled by the principal inertia, then R back.
  const a0 = (b[0]! * x + b[3]! * y + b[6]! * z) * pr.inertia[0]!
  const a1 = (b[1]! * x + b[4]! * y + b[7]! * z) * pr.inertia[1]!
  const a2 = (b[2]! * x + b[5]! * y + b[8]! * z) * pr.inertia[2]!
  out[o] = b[0]! * a0 + b[1]! * a1 + b[2]! * a2
  out[o + 1] = b[3]! * a0 + b[4]! * a1 + b[5]! * a2
  out[o + 2] = b[6]! * a0 + b[7]! * a1 + b[8]! * a2
}

function worldInverseInertia(s: VehicleSim): void {
  const pr = principal.get(s)
  const m = s.iinv
  if (!pr) {
    m.fill(0)
    return
  }
  // R = q · frame; I⁻¹ = R diag(inv) Rᵀ.
  const q = s.q
  const f = pr.frame
  const ax = q[3]! * f[0]! + q[0]! * f[3]! + q[1]! * f[2]! - q[2]! * f[1]!
  const ay = q[3]! * f[1]! - q[0]! * f[2]! + q[1]! * f[3]! + q[2]! * f[0]!
  const az = q[3]! * f[2]! + q[0]! * f[1]! - q[1]! * f[0]! + q[2]! * f[3]!
  const aw = q[3]! * f[3]! - q[0]! * f[0]! - q[1]! * f[1]! - q[2]! * f[2]!
  const xx = ax * ax
  const yy = ay * ay
  const zz = az * az
  const xy = ax * ay
  const xz = ax * az
  const yz = ay * az
  const wx = aw * ax
  const wy = aw * ay
  const wz = aw * az
  // Columns of R.
  const r00 = 1 - 2 * (yy + zz)
  const r01 = 2 * (xy - wz)
  const r02 = 2 * (xz + wy)
  const r10 = 2 * (xy + wz)
  const r11 = 1 - 2 * (xx + zz)
  const r12 = 2 * (yz - wx)
  const r20 = 2 * (xz - wy)
  const r21 = 2 * (yz + wx)
  const r22 = 1 - 2 * (xx + yy)
  const b = s.basis
  b[0] = r00
  b[1] = r01
  b[2] = r02
  b[3] = r10
  b[4] = r11
  b[5] = r12
  b[6] = r20
  b[7] = r21
  b[8] = r22
  const i0 = pr.inv[0]!
  const i1 = pr.inv[1]!
  const i2 = pr.inv[2]!
  m[0] = r00 * r00 * i0 + r01 * r01 * i1 + r02 * r02 * i2
  m[1] = r00 * r10 * i0 + r01 * r11 * i1 + r02 * r12 * i2
  m[2] = r00 * r20 * i0 + r01 * r21 * i1 + r02 * r22 * i2
  m[3] = m[1]!
  m[4] = r10 * r10 * i0 + r11 * r11 * i1 + r12 * r12 * i2
  m[5] = r10 * r20 * i0 + r11 * r21 * i1 + r12 * r22 * i2
  m[6] = m[2]!
  m[7] = m[5]!
  m[8] = r20 * r20 * i0 + r21 * r21 * i1 + r22 * r22 * i2
}

/** World-space hardpoint of a wheel into out[0..2], and the probe start (raised by travel.up) into out[3..5]. */
export function hardpoint(s: VehicleSim, wh: WheelSim, out: Float64Array): void {
  rotate(s.q, wh.hx, wh.hy, wh.hz, out, 0)
  out[0] = out[0]! + s.pos[0]!
  out[1] = out[1]! + s.pos[1]!
  out[2] = out[2]! + s.pos[2]!
  out[3] = out[0]! + s.up[0]! * wh.travelUp
  out[4] = out[1]! + s.up[1]! * wh.travelUp
  out[5] = out[2]! + s.up[2]! * wh.travelUp
}

/** The wheel's world rotation for Rapier's cylinder: chassis · steer about Y · 90° about Z (axis Y → axle X). */
export function cylinderRotation(s: VehicleSim, steer: number, out: Float64Array): void {
  const sy = Math.sin(steer / 2)
  const cy = Math.cos(steer / 2)
  const k = Math.SQRT1_2
  // (0, sy, 0, cy) ⊗ (0, 0, k, k)
  const lx = sy * k
  const ly = sy * k
  const lz = cy * k
  const lw = cy * k
  const q = s.q
  out[0] = q[3]! * lx + q[0]! * lw + q[1]! * lz - q[2]! * ly
  out[1] = q[3]! * ly - q[0]! * lz + q[1]! * lw + q[2]! * lx
  out[2] = q[3]! * lz + q[0]! * ly - q[1]! * lx + q[2]! * lw
  out[3] = q[3]! * lw - q[0]! * lx - q[1]! * ly - q[2]! * lz
}

/** Context the step needs from the plugin. */
export interface StepContext {
  world: World
  dt: number
  gravity: number
  gx: number
  gy: number
  gz: number
  wetness: number
  surfaces: SurfaceRegistry
  sample: SurfaceSample
  /** Probe results per wheel (the plugin ran the queries). */
  hits: ProbeHit[]
}

/** Steering, the automatic gearbox and manual shifts, from the input. Before probing. */
export function stepControls(s: VehicleSim, input: InputSim, dt: number): void {
  const ev = s.events
  ev.shifted = ev.started = ev.stopped = ev.stalled = ev.backfire = ev.landed = false
  ev.tookShift = ev.tookGear = false

  // Steering: toward the input's share of the speed-limited lock, at the steering rate.
  const st = s.steering
  const lock = st.maxAngle * Math.max(0, lookup(st.atSpeed, Math.abs(s.speed)))
  let target = -input.steer * lock
  if (s.assists.counterSteer > 0 && s.speed > 3) {
    target += s.assists.counterSteer * s.driftAngle
    if (target > st.maxAngle) target = st.maxAngle
    if (target < -st.maxAngle) target = -st.maxAngle
  }
  const cur = s.steerAngle
  const away = Math.abs(target) > Math.abs(cur) && target * cur >= 0
  const rate = (away ? st.speed : st.returnSpeed) * dt
  s.steerAngle = cur + Math.max(-rate, Math.min(rate, target - cur))

  const tr = s.transmission
  const en = s.engine
  s.sinceShift += dt
  if (s.shiftLeft > 0) {
    s.shiftLeft -= dt
    if (s.shiftLeft <= 0) {
      s.shiftLeft = 0
      s.gear = s.targetGear
    }
  }
  if (!tr || !en) return
  // Shifts follow road speed: the driven wheels' speed through the gear (the engine's own rpm
  // falls to idle while braking opens the clutch, and a rev-matched shift would read high).
  let shaft = 0
  for (let i = 0; i < s.wheels.length; i++) shaft += s.wheels[i]!.drive * s.wheels[i]!.omega
  const rpm = s.gear > 0 ? Math.abs(shaft * gearRatio(tr, s.gear)) * RPM : s.omegaE * RPM
  const gears = tr.gears.length
  if (tr.manual) {
    let want = s.shiftLeft > 0 ? s.targetGear : s.gear
    if (input.shift !== 0) {
      want = Math.max(-1, Math.min(gears, want + (input.shift > 0 ? 1 : -1)))
      ev.tookShift = true
    }
    if (input.gear !== 127) {
      want = Math.max(-1, Math.min(gears, input.gear))
      ev.tookGear = true
    }
    if (want !== (s.shiftLeft > 0 ? s.targetGear : s.gear)) startShift(s, want, tr)
    return
  }
  // Automatic.
  if (s.shiftLeft > 0) return
  const stopped = Math.abs(s.speed) < 0.5
  if (tr.reverseOnBrake && stopped) {
    if (s.gear >= 0 && input.brake > 0.1 && input.throttle < 0.05) {
      s.reverseHold += dt
      if (s.reverseHold > 0.3) {
        startShift(s, -1, tr)
        s.reverseHold = 0
      }
      return
    }
    if (s.gear < 0 && input.brake > 0.1 && input.throttle < 0.05) {
      // Throttle and brake swap in reverse: "brake" drives backward. Nothing to shift.
    } else if (s.gear < 0 && input.throttle > 0.1) {
      startShift(s, 1, tr)
      return
    }
    s.reverseHold = 0
  }
  if (s.gear === 0) {
    startShift(s, 1, tr)
    return
  }
  if (s.gear < 0) return
  if (Math.abs(s.speed) < 2 && s.gear > 1 && input.throttle < 0.5) {
    startShift(s, 1, tr)
    return
  }
  if (s.sinceShift < 0.5 || s.grounded === 0) return
  const scale = 0.5 + 0.5 * input.throttle
  const up = tr.upshift * scale * en.max
  const down = tr.downshift * scale * en.max
  // Driven wheels spinning past their peak: hold the gear.
  // Mid-slide: hold the gear too.
  let spinning = Math.abs(s.driftAngle) > 0.2
  for (let i = 0; i < s.wheels.length; i++) {
    const wh = s.wheels[i]!
    if (wh.drive > 0 && wh.slipRatio > wh.tire.longitudinal.peakSlip * 1.5) spinning = true
  }
  if (rpm > up && s.gear < gears && !spinning) {
    startShift(s, s.gear + 1, tr)
  } else if (rpm < down && s.gear > 1) {
    startShift(s, s.gear - 1, tr)
  } else if (
    input.throttle > 0.95 &&
    s.lastThrottle < 0.6 &&
    s.gear > 1 &&
    (rpm * tr.gears[s.gear - 2]!) / tr.gears[s.gear - 1]! < tr.upshift * en.max * 0.9 &&
    rpm < en.max * 0.6
  ) {
    // Kickdown: a throttle stab drops a gear when the lower one has room.
    startShift(s, s.gear - 1, tr)
  }
}

function startShift(s: VehicleSim, to: number, tr: TransmissionSim): void {
  const from = s.shiftLeft > 0 ? s.targetGear : s.gear
  if (to === from) return
  s.events.shifted = true
  s.events.shiftFrom = from
  s.events.shiftTo = to
  s.targetGear = to
  s.sinceShift = 0
  if (tr.shiftTime <= 0) {
    s.gear = to
    s.shiftLeft = 0
  } else {
    s.gear = 0
    s.shiftLeft = tr.shiftTime
  }
}

/** Overall ratio for a gear (engine rpm per driveshaft rpm), signed; 0 in neutral. */
export function gearRatio(tr: TransmissionSim, gear: number): number {
  if (gear === 0) return 0
  if (gear < 0) return -tr.reverse * tr.finalDrive
  return tr.gears[Math.min(gear, tr.gears.length) - 1]! * tr.finalDrive
}

/** Before probing: keep last step's visual values, and steer each wheel (Ackermann). */
export function beginStep(s: VehicleSim): void {
  for (let i = 0; i < s.wheels.length; i++) {
    const wh = s.wheels[i]!
    wh.prevX = wh.x
    wh.prevAngle = wh.angle
    wh.prevSteer = wh.steer
    wh.bottomSpeed = 0
    wh.steer = wheelSteer(s, wh)
  }
}

/**
 * Probe results → suspension geometry, surfaces, contact frames and effective masses. The
 * plugin ran the queries into `ctx.hits` with `hardpoint` and `cylinderRotation`.
 */
export function stepGround(s: VehicleSim, ctx: StepContext): void {
  const reg = ctx.surfaces
  let grounded = 0
  for (let i = 0; i < s.wheels.length; i++) {
    const wh = s.wheels[i]!
    const hit = ctx.hits[i]!
    const range = wh.travelUp + wh.travelDown
    if (!hit.hit || hit.distance > range + wh.sinkage + 1e-4) {
      wh.grounded = false
      wh.x = -wh.travelDown
      wh.load = 0
      wh.ground = -1 as Entity
      wh.groundBody = -1 as Entity
      wh.slipRatio = wh.slipAngle = wh.skid = 0
      continue
    }
    // Surface at the contact, blended between two.
    const sample = ctx.sample
    surfaceAtHit(ctx, hit.collider, hit.px, hit.py, hit.pz, sample)
    const sa = reg.values[sample.a] ?? reg.values[0]!
    const sb = reg.values[sample.b] ?? sa
    const t = sample.weight
    const wet = ctx.wetness
    const gripA = sa.grip * (1 + (sa.wetGrip - 1) * wet)
    const gripB = sb.grip * (1 + (sb.wetGrip - 1) * wet)
    const prevSurface = wh.surface
    wh.surface = t > 0.5 ? sample.b : sample.a
    wh.surfaceB = sample.b
    wh.surfaceWeight = t
    // Per-tire surface scales.
    const tireGripA = tireSurface(wh.tire, reg.names[sample.a] ?? '', 'grip')
    const tireGripB = tireSurface(wh.tire, reg.names[sample.b] ?? '', 'grip')
    const tireLooseA = tireSurface(wh.tire, reg.names[sample.a] ?? '', 'loose')
    const tireLooseB = tireSurface(wh.tire, reg.names[sample.b] ?? '', 'loose')
    wh.grip = gripA * tireGripA + (gripB * tireGripB - gripA * tireGripA) * t
    wh.rolling =
      (sa.rollingResistance + (sb.rollingResistance - sa.rollingResistance) * t) *
      wh.tire.rollingResistance
    wh.loose = Math.min(
      1,
      sa.loose * tireLooseA + (sb.loose * tireLooseB - sa.loose * tireLooseA) * t,
    )
    wh.sinkSurface = sa.sinkage + (sb.sinkage - sa.sinkage) * t
    wh.drag = sa.drag + (sb.drag - sa.drag) * t
    wh.dig = sa.dig + (sb.dig - sa.dig) * t
    wh.maxSinkage = sa.maxSinkage + (sb.maxSinkage - sa.maxSinkage) * t
    wh.bumpAmp = sa.bumps.amplitude + (sb.bumps.amplitude - sa.bumps.amplitude) * t
    wh.bumpWave = sa.bumps.wavelength + (sb.bumps.wavelength - sa.bumps.wavelength) * t
    wh.surfaceChanged = wh.surface !== prevSurface
    // Sinkage: static (by load) plus dug-in; bumps raise the contact.
    const loadShare = wh.staticLoad > 0 ? Math.min(3, wh.load / wh.staticLoad) : 1
    wh.sinkage = Math.min(
      wh.sinkSurface * (wh.load > 0 ? loadShare : 1) + wh.dug,
      Math.max(wh.maxSinkage, wh.sinkSurface * 3),
    )
    let bump = 0
    if (wh.bumpAmp > 0) bump = wh.bumpAmp * bumpNoise(hit.px / wh.bumpWave, hit.pz / wh.bumpWave)
    const dist = hit.distance + wh.sinkage - bump
    wh.x = Math.min(wh.travelUp, wh.travelUp - dist)
    wh.grounded = true
    grounded++
    wh.px = hit.px
    wh.py = hit.py
    wh.pz = hit.pz
    wh.nx = hit.nx
    wh.ny = hit.ny
    wh.nz = hit.nz
    wh.ground = hit.collider
    wh.groundBody = hit.body
  }
  s.grounded = grounded
}

function surfaceAtHit(
  ctx: StepContext,
  collider: Entity,
  x: number,
  y: number,
  z: number,
  out: SurfaceSample,
): void {
  const p = pointScratch
  p[0] = x
  p[1] = y
  p[2] = z
  surfaceLookup(ctx.world, ctx.surfaces, collider, p, out)
}

const pointScratch = new Float64Array(3)

/** Set by the plugin: physics' surfaceAt (kept injectable so sim.ts stays free of world state). */
export let surfaceLookup: (
  world: World,
  registry: SurfaceRegistry,
  collider: Entity,
  point: ArrayLike<number>,
  out: SurfaceSample,
) => SurfaceSample = (_w, _r, _c, _p, out) => {
  out.a = out.b = 0
  out.weight = 0
  return out
}

export function setSurfaceLookup(fn: typeof surfaceLookup): void {
  surfaceLookup = fn
}

function tireSurface(tire: TireValue, name: string, key: 'grip' | 'loose'): number {
  const list = tire.surfaces
  for (let i = 0; i < list.length; i++) if (list[i]!.surface === name) return list[i]![key]
  return 1
}

function wheelSteer(s: VehicleSim, wh: WheelSim): number {
  const axle = s.axles[wh.axle]
  if (!axle || axle.steer === 0) return 0
  const base = s.steerAngle * axle.steer
  if (Math.abs(base) < 1e-5 || axle.steer < 0 || s.steering.ackermann === 0) return base
  // The turning center sits on the unsteered axles' line, where the axle's centerline at `base`
  // points; each wheel then aims at it (Ackermann), blended by `ackermann`.
  const lRef = s.rearZ - axle.z
  const l = s.rearZ - wh.hz
  if (lRef <= 1e-3 || l <= 1e-3) return base
  const cx = -lRef / Math.tan(base)
  const d = wh.hx - cx
  // A wheel at or past the turning center (a very tight turn on a wide axle): keep the base angle.
  if (d * cx >= 0 || Math.abs(d) < 1e-3) return base
  const ack = Math.atan(l / d)
  return base + (ack - base) * s.steering.ackermann
}

/**
 * The substeps: suspension, engine, and the solver over clutch, differentials, brakes and tires,
 * on the chassis velocity copy. Then sinkage, visuals and slip state.
 */
export function stepDynamics(s: VehicleSim, input: InputSim, ctx: StepContext): void {
  const dt = ctx.dt
  const wheels = s.wheels
  const n = wheels.length
  const up = s.up
  const com = s.com
  const tr = s.transmission
  const en = s.engine
  const as = s.assists
  const hb = input.handbrake

  // Driver inputs, swapped in reverse on an automatic (brake drives backward).
  let throttle = input.throttle
  let brake = input.brake
  if (tr && !tr.manual && s.gear < 0) {
    throttle = input.brake
    brake = input.throttle
  }

  // Frames and effective masses per grounded wheel (pose fixed over the step).
  const fwd = s.fwd
  for (let i = 0; i < n; i++) {
    const wh = wheels[i]!
    // Hardpoint arm.
    rotate(s.q, wh.hx, wh.hy, wh.hz, tmp, 0)
    wh.ax = tmp[0]! + s.pos[0]! - com[0]!
    wh.ay = tmp[1]! + s.pos[1]! - com[1]!
    wh.az = tmp[2]! + s.pos[2]! - com[2]!
    wh.ku = invEffMass(s, wh.ax, wh.ay, wh.az, up[0]!, up[1]!, up[2]!)
    if (!wh.grounded) continue
    // Wheel heading: chassis forward turned by steer about up, projected on the ground plane.
    const cs = Math.cos(wh.steer)
    const sn = Math.sin(wh.steer)
    // Rotating forward (−Z) by +steer about +Y turns it toward −X (left).
    let hx = fwd[0]! * cs - s.right[0]! * sn
    let hy = fwd[1]! * cs - s.right[1]! * sn
    let hz = fwd[2]! * cs - s.right[2]! * sn
    const dn = hx * wh.nx + hy * wh.ny + hz * wh.nz
    hx -= dn * wh.nx
    hy -= dn * wh.ny
    hz -= dn * wh.nz
    let l = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1
    wh.fx = hx / l
    wh.fy = hy / l
    wh.fz = hz / l
    // Right = forward × normal.
    let rx = wh.fy * wh.nz - wh.fz * wh.ny
    let ry = wh.fz * wh.nx - wh.fx * wh.nz
    let rz = wh.fx * wh.ny - wh.fy * wh.nx
    l = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
    rx /= l
    ry /= l
    rz /= l
    wh.sx = rx
    wh.sy = ry
    wh.sz = rz
    // Contact arm, and the tire-force arm raised toward the center of mass height.
    wh.cx = wh.px - com[0]!
    wh.cy = wh.py - com[1]!
    wh.cz = wh.pz - com[2]!
    const h = -(wh.cx * up[0]! + wh.cy * up[1]! + wh.cz * up[2]!) * wh.forceHeight
    wh.rx = wh.cx + up[0]! * h
    wh.ry = wh.cy + up[1]! * h
    wh.rz = wh.cz + up[2]! * h
    wh.kf = invEffMass(s, wh.rx, wh.ry, wh.rz, wh.fx, wh.fy, wh.fz)
    wh.ks = invEffMass(s, wh.rx, wh.ry, wh.rz, rx, ry, rz)
    wh.ix = wh.iy = wh.iz = 0
  }

  // Assists from the last step's slip: ABS (in the substeps, below), TCS throttle cut and brake,
  // ESC.
  // ABS acted last step when it held a wheel.
  let flags = 0
  if (as.abs > 0 && brake > 0.05) {
    for (let i = 0; i < n; i++)
      if (wheels[i]!.grounded && wheels[i]!.pin === PIN_ABS) flags |= ASSIST_ABS
  }
  // A handbrake pull is a drift the driver wants: TCS and ESC stand down for 2 s after one.
  s.sinceHandbrake = hb > 0.1 ? 0 : s.sinceHandbrake + dt
  const drifting = s.sinceHandbrake < 2
  // Arcade drifts: the rear stays loose (driftGrip) on the handbrake, and while sliding past 10°
  // on the throttle, so throttle holds a slide instead of the rear snapping back.
  // The looseness fades from 30° to 50° of slide, so a held drift settles instead of spinning.
  const beta = Math.abs(s.driftAngle)
  const fade = beta < 0.52 ? 1 : beta > 0.87 ? 0 : 1 - (beta - 0.52) / 0.35
  const sliding = beta > 0.17 ? Math.min(1, input.throttle * 1.5) * fade : 0
  const driftLoose = as.driftGrip !== 1 ? Math.max(hb, sliding) : 0
  let tcsTarget = 0
  for (let i = 0; i < n; i++) wheels[i]!.tcsBrake = 0
  if (as.tcs > 0 && throttle > 0.05 && !drifting) {
    // Throttle cut from each driven axle's slower wheel: one wheel spinning on an open diff is
    // the brake's job (below), both spinning is too much torque.
    for (let a = 0; a < s.axles.length; a++) {
      const axle = s.axles[a]!
      if (axle.drive <= 0) continue
      let least = Infinity
      for (let k = 0; k < axle.wheels.length; k++) {
        const wh = wheels[axle.wheels[k]!]!
        if (!wh.grounded) continue
        // Slip against a 3 m/s floor: near a standstill any spin reads as a huge slip ratio.
        const vx = wh.omega * wh.radius - wh.slipRatio * Math.max(Math.abs(s.speed), 1)
        const slip = (wh.omega * wh.radius - vx) / Math.max(Math.abs(vx), 3)
        const over = slip / (wh.tire.longitudinal.peakSlip * (1 + wh.loose)) - 1
        if (over < least) least = over
      }
      if (least > 0 && least !== Infinity)
        tcsTarget = Math.max(tcsTarget, Math.min(1, least * 4) * as.tcs)
    }
    // Brake a driven wheel spinning past its partner (brake-based limited slip).
    for (let a = 0; a < s.axles.length; a++) {
      const axle = s.axles[a]!
      if (axle.drive <= 0 || axle.left < 0 || axle.right < 0 || axle.diff === DIFF_LOCKED) continue
      const l = wheels[axle.left]!
      const r = wheels[axle.right]!
      const diff = (l.omega - r.omega) * l.radius
      const band = 0.3 + 0.05 * Math.abs(s.speed)
      if (Math.abs(diff) < band) continue
      const fast = diff > 0 ? l : r
      fast.tcsBrake = as.tcs * Math.min(axle.brakeTorque * 0.6, (Math.abs(diff) - band) * 1500)
      flags |= ASSIST_TCS
    }
  }
  s.tcsCut += (tcsTarget - s.tcsCut) * Math.min(1, dt * (tcsTarget > s.tcsCut ? 30 : 10))
  if (s.tcsCut > 0.05) flags |= ASSIST_TCS
  for (let i = 0; i < n; i++) wheels[i]!.escBrake = 0
  let escCut = 0
  if (as.esc > 0 && s.grounded >= 3 && s.speed > 5 && !drifting) {
    const yaw = s.w[0]! * up[0]! + s.w[1]! * up[1]! + s.w[2]! * up[2]!
    const v = s.speed
    const ref0 = (v * s.steerAngle) / (s.wheelbase * (1 + as.understeer * v * v))
    let mu = 0
    for (let i = 0; i < n; i++) mu += wheels[i]!.grip * wheels[i]!.tire.grip
    mu /= n
    const cap = (mu * ctx.gravity) / v
    const ref = Math.max(-cap, Math.min(cap, ref0))
    const err = yaw - ref
    const band = 0.05 + 0.15 * Math.abs(ref)
    if (Math.abs(err) > band) {
      const over = Math.abs(yaw) > Math.abs(ref) && yaw * ref >= 0
      const turnLeft = (Math.abs(ref) > 0.02 ? ref : yaw) > 0
      const amount = as.esc * Math.min(1, (Math.abs(err) - band) / 0.4)
      // Oversteer: outer front. Understeer: inner rear. Outer is right when turning left.
      const side = over ? (turnLeft ? SIDE_RIGHT : SIDE_LEFT) : turnLeft ? SIDE_LEFT : SIDE_RIGHT
      const front = over
      let best = -1
      let bestZ = front ? Infinity : -Infinity
      for (let i = 0; i < n; i++) {
        const wh = wheels[i]!
        if (wh.side !== side) continue
        if (front ? wh.hz < bestZ : wh.hz > bestZ) {
          bestZ = wh.hz
          best = i
        }
      }
      if (best >= 0) {
        const wh = wheels[best]!
        wh.escBrake = amount * (s.axles[wh.axle]?.brakeTorque ?? 1500)
        escCut = amount * 0.6
        flags |= ASSIST_ESC
      }
    }
  }
  s.assistFlags = flags
  // Shifts cut the throttle (the engine falls toward the next gear's speed) and the clutch
  // re-engages over 0.15 s instead of dumping.
  const shiftCut = s.shiftLeft > 0 ? 0 : 1
  const throttleEff = Math.max(0, throttle * (1 - s.tcsCut) * (1 - escCut) * shiftCut)
  s.throttle = throttleEff

  // Engine events and running state.
  if (en) {
    if (s.running && throttleEff < 0.1 && s.lastThrottle > 0.8 && s.omegaE * RPM > en.max * 0.7)
      s.events.backfire = true
  }
  s.lastThrottle = input.throttle

  // Clutch engagement and the overall ratio.
  const ratio = tr ? gearRatio(tr, s.gear) : 0
  const g = Math.abs(ratio) > 0 ? ratio : 0
  let engage = 0
  if (en && tr && g !== 0 && s.shiftLeft <= 0) {
    if (tr.pedal) engage = 1 - input.clutch
    else {
      // Like a fluid coupling: capacity grows with the square of the engine's rise over idle
      // toward a launch speed, so the engine climbs into its torque curve before it pulls; and it
      // stays engaged while the wheels turn the engine past idle (cruising, engine braking).
      let shaft = 0
      for (let i = 0; i < n; i++) shaft += wheels[i]!.drive * wheels[i]!.omega
      const gearRpm = Math.abs(shaft * g) * RPM
      const rise = Math.max(0, Math.min(1, (s.omegaE * RPM - en.idle) / (0.3 * (en.max - en.idle))))
      const byWheels = (gearRpm - en.idle * 0.9) / (en.idle * 0.3)
      engage = Math.max(0, Math.min(1, Math.max(rise * rise, byWheels)))
      if (!s.running) engage = Math.max(0, Math.min(1, byWheels))
      // Braking with no throttle opens it (a torque converter lets go), so the engine's inertia
      // doesn't fight the brakes and ABS on the driven wheels.
      if (brake > 0.2 && throttle < 0.05) engage = 0
      if (s.sinceShift < tr.shiftTime + 0.15)
        engage *= Math.max(0, Math.min(1, (s.sinceShift - tr.shiftTime) / 0.15))
    }
  }
  s.clutch = engage

  // Brake bounds per wheel (N·m), before the substep scale.
  const sticky = s.sticky

  const steps = s.substeps
  const h = dt / steps
  const v = s.v
  for (let step = 0; step < steps; step++) {
    // Suspension (explicit spring and damper) and the bump stop.
    for (let i = 0; i < n; i++) {
      const wh = wheels[i]!
      if (!wh.grounded) continue
      const ax = wh.ax
      const ay = wh.ay
      const az = wh.az
      // The spring and damper force is the step's: the position is held over the substeps, so
      // a damper reading the substeps' changing velocity would hold the car off its ride height.
      if (step === 0) {
        // Compression speed: chassis moving down along −up relative to the ground.
        wh.xdot = -relVel(s, wh, ax, ay, az, up[0]!, up[1]!, up[2]!)
        let f = wh.staticLoad + wh.k * wh.x + (wh.xdot > 0 ? wh.cBump : wh.cRebound) * wh.xdot
        const axle = s.axles[wh.axle]
        if (axle && axle.antiRoll > 0 && axle.left >= 0 && axle.right >= 0) {
          const other = wheels[wh === wheels[axle.left] ? axle.right : axle.left]!
          if (other.grounded) f += axle.antiRoll * (wh.x - other.x)
          else f += axle.antiRoll * (wh.x + other.travelDown)
        }
        if (f < 0) f = 0
        wh.spring = f
        const cosn = up[0]! * wh.nx + up[1]! * wh.ny + up[2]! * wh.nz
        let load = f * Math.max(0, cosn)
        if (load > wh.staticLoad * 3) load = wh.staticLoad * 3
        wh.load = load
        wh.loadAvg += (load - wh.loadAvg) * Math.min(1, dt / 0.15)
      }
      const j = wh.spring * h
      impulse(s, j, ax, ay, az, up[0]!, up[1]!, up[2]!)
      wh.ix += up[0]! * j
      wh.iy += up[1]! * j
      wh.iz += up[2]! * j
      if (wh.x >= wh.travelUp - 1e-4) {
        const xd = -relVel(s, wh, ax, ay, az, up[0]!, up[1]!, up[2]!)
        if (xd > 0 && wh.ku > 0) {
          const jb = xd / wh.ku
          impulse(s, jb, ax, ay, az, up[0]!, up[1]!, up[2]!)
          wh.ix += up[0]! * jb
          wh.iy += up[1]! * jb
          wh.iz += up[2]! * jb
          if (xd > wh.bottomSpeed) wh.bottomSpeed = xd
        }
      }
    }

    // Gravity, as Rapier will add it, after the springs (so the damper doesn't see it) and before
    // friction (so tires hold against slopes).
    v[0] = v[0]! + ctx.gx * h
    v[1] = v[1]! + ctx.gy * h
    v[2] = v[2]! + ctx.gz * h

    // Automatic and auto-clutch shifts match revs: the engine meets the next gear's speed by
    // the end of the shift, so the clutch closes without a jolt.
    if (en && tr && s.shiftLeft > 0 && !tr.pedal && s.running) {
      const next = gearRatio(tr, s.targetGear)
      let shaft = 0
      for (let i = 0; i < n; i++) shaft += wheels[i]!.drive * wheels[i]!.omega
      const target = Math.max(en.idle / RPM, Math.abs(next * shaft))
      s.omegaE += (target - s.omegaE) * Math.min(1, h / Math.max(h, s.shiftLeft))
    }

    // Engine: torque curve, idle hold, limiter, friction (explicit; not stiff).
    if (en) {
      const rpm = s.omegaE * RPM
      let thr = throttleEff
      if (s.running && rpm < en.idle) thr = Math.max(thr, Math.min(1, (en.idle - rpm) / 150))
      if (rpm >= en.max) thr = 0
      const curve = s.running ? lookup(en.torque, Math.max(rpm, 0)) : 0
      const drive = curve * thr * en.torqueScale * (tr ? tr.efficiency : 1)
      const friction = (en.braking * Math.max(0, rpm)) / en.max + (s.running ? 0 : 20)
      const torque = drive - friction
      s.omegaE += (torque * h) / en.inertia
      if (s.omegaE < 0) s.omegaE = 0
    }

    // Slip, grip and the solver's bounds per wheel.
    for (let i = 0; i < n; i++) {
      const wh = wheels[i]!
      const axle = s.axles[wh.axle]
      wh.accX = wh.accY = wh.accBrake = 0
      const footBrake = axle ? axle.brakeTorque * brake : 0
      const handBrake = axle ? axle.handbrakeTorque * hb : 0
      if (!wh.grounded) {
        wh.limX = wh.limY = 0
        wh.pin = PIN_NONE
        wh.invI = 1 / wh.inertia
        wh.brakeBound = (footBrake + handBrake + wh.tcsBrake + wh.escBrake) * h
        continue
      }
      const vx = relVel(s, wh, wh.rx, wh.ry, wh.rz, wh.fx, wh.fy, wh.fz)
      const vy = relVel(s, wh, wh.rx, wh.ry, wh.rz, wh.sx, wh.sy, wh.sz)
      const denom = Math.max(Math.abs(vx), 1)
      const kappa = (wh.omega * wh.radius - vx) / denom
      const alpha = Math.atan2(vy, denom)
      const lo = wh.tire.longitudinal
      const la = wh.tire.lateral
      const loose = wh.loose
      const widen = 1 + loose
      const px = lo.peakSlip * widen
      const py = la.peakSlip * DEG * widen
      const sxN = kappa / px
      const syN = alpha / py
      const sigma = Math.sqrt(sxN * sxN + syN * syN)
      let mu = wh.tire.grip * wh.grip * wh.gripScale
      if (wh.staticLoad > 0) {
        const lf = 1 - wh.tire.loadSensitivity * (wh.load / wh.staticLoad - 1)
        mu *= lf < 0.3 ? 0.3 : lf
      }
      let muY = mu
      if (driftLoose > 0 && axle && axle.steer === 0) muY *= 1 + (as.driftGrip - 1) * driftLoose
      const slideX = lo.slide + (Math.max(lo.slide, 1.05) - lo.slide) * loose
      const slideY = la.slide + (Math.max(la.slide, 1.05) - la.slide) * loose
      const n0 = wh.load
      let fxn = 0
      let fyn = 0
      if (sigma > 1e-9) {
        fxn = gripCurve(sigma, lo.slideSlip / lo.peakSlip, slideX) * (sxN / sigma)
        fyn = gripCurve(sigma, la.slideSlip / la.peakSlip, slideY) * (syN / sigma)
      }
      // Bounds: the friction ellipse at the current slip (the full peak, split by direction,
      // until the slip passes it; the curve's falling side after). Under them the tire is a soft
      // constraint with the curve's initial slope as its stiffness, solved implicitly: an
      // explicit slip → force loop near the peak has a time constant under a substep and rings.
      if (sticky) {
        // Standstill: static friction up to the full grip, both ways.
        wh.limX = mu * n0 * h
        wh.limY = muY * n0 * h
        wh.softX = wh.softY = 0
      } else {
        if (sigma > 1) {
          // Sliding: friction opposes the slip velocity itself (a locked wheel doesn't steer),
          // blended in from the peak to where the curve settles.
          const svx = vx - wh.omega * wh.radius
          const sv = Math.sqrt(svx * svx + vy * vy)
          let dx = Math.abs(fxn)
          let dy = Math.abs(fyn)
          if (sv > 1e-6) {
            const mag = Math.sqrt(fxn * fxn + fyn * fyn)
            const t = Math.min(1, (sigma - 1) / Math.max(1e-6, lo.slideSlip / lo.peakSlip - 1))
            dx += ((Math.abs(svx) / sv) * mag - dx) * t
            dy += ((Math.abs(vy) / sv) * mag - dy) * t
          }
          wh.limX = dx * mu * n0 * h
          wh.limY = dy * muY * n0 * h
        } else if (sigma > 1e-6) {
          wh.limX = (Math.abs(sxN) / sigma) * mu * n0 * h
          wh.limY = (Math.abs(syN) / sigma) * muY * n0 * h
        } else {
          wh.limX = mu * n0 * h
          wh.limY = muY * n0 * h
        }
        // Stiffness, N per m/s of slip velocity: dF/dκ at zero is 2 μ N / peak, κ = slip / denom.
        const cx = (2 * mu * n0) / (px * denom)
        const cy = (2 * muY * n0) / (py * denom)
        wh.softX = cx > 0 ? 1 / (cx * h) : 1e9
        wh.softY = cy > 0 ? 1 / (cy * h) : 1e9
      }
      // Brakes. A wheel the brakes hold against all the tire and the clutch can do is locked: its
      // spin is pinned at zero, so the light wheel can't creep in the solver's few passes. With
      // ABS, a foot brake that would lock it instead pins its spin at the speed of 90% of peak
      // slip (real ABS pulses around the same point). A pinned wheel's tire works on the chassis
      // alone; the brake torque that takes is the tire's own, under the brake's by the test.
      const tireTorque = mu * n0 * wh.radius
      const abs = as.abs > 0 && footBrake >= tireTorque * 0.98
      const hold = (abs ? 0 : footBrake) + handBrake + wh.tcsBrake + wh.escBrake
      const driveCap = en && tr ? tr.clutchTorque * engage * Math.abs(g) * wh.drive : 0
      wh.pin = hold >= tireTorque * 1.02 + driveCap ? PIN_LOCK : abs ? PIN_ABS : PIN_NONE
      wh.invI = wh.pin === PIN_NONE ? 1 / wh.inertia : 0
      wh.absSlip = px * (0.5 + 0.4 * as.abs)
      wh.brakeBound = (hold + wh.rolling * n0 * wh.radius) * h
      wh.slipRatio = kappa
      wh.slipAngle = alpha
      const sk = sigma > 1 ? Math.min(1, (sigma - 1) / (lo.slideSlip / lo.peakSlip - 1 || 1)) : 0
      wh.skid = sk * (1 - loose * 0.5)
    }

    // The solver: clutch, differentials, brakes, tires.
    s.clutchAcc = 0
    s.centerAcc = 0
    for (let a = 0; a < s.axles.length; a++) s.axles[a]!.accLock = 0
    const iters = s.iterations
    const clutchCap = en && tr ? tr.clutchTorque * engage * h : 0
    for (let it = 0; it < iters; it++) {
      // Clutch: engine speed against the driveshaft's (scaled by the gear).
      if (clutchCap > 0 && en) {
        let shaft = 0
        let kw = 0
        for (let i = 0; i < n; i++) {
          const wh = wheels[i]!
          if (wh.drive <= 0) continue
          shaft += wh.drive * wh.omega
          const gd = g * wh.drive
          kw += gd * gd * wh.invI
        }
        const c = s.omegaE - g * shaft
        const k = 1 / en.inertia + kw
        let lambda = c / k
        const prev = s.clutchAcc
        let next = prev + lambda
        if (next > clutchCap) next = clutchCap
        if (next < -clutchCap) next = -clutchCap
        lambda = next - prev
        s.clutchAcc = next
        s.omegaE -= lambda / en.inertia
        for (let i = 0; i < n; i++) {
          const wh = wheels[i]!
          if (wh.drive > 0) wh.omega += g * wh.drive * lambda * wh.invI
        }
      }
      // Center differential between the first two driven axles.
      if (s.centerDiff !== DIFF_OPEN && s.driven.length >= 2) {
        const fa = s.axles[s.driven[0]!]!
        const ra = s.axles[s.driven[1]!]!
        const fs = axleSpeed(wheels, fa)
        const rs = axleSpeed(wheels, ra)
        const kf = axleInvInertia(wheels, fa)
        const kr = axleInvInertia(wheels, ra)
        if (kf + kr <= 0) continue
        const lambda0 = (fs - rs) / (kf + kr)
        let bound = Infinity
        if (s.centerDiff === DIFF_LSD) {
          const tin = Math.abs(s.clutchAcc * g)
          bound = (tin * (s.centerBias - 1)) / (s.centerBias + 1)
        }
        const prev = s.centerAcc
        let next = prev + lambda0
        if (next > bound) next = bound
        if (next < -bound) next = -bound
        const lambda = next - prev
        s.centerAcc = next
        spreadAxle(wheels, fa, -lambda)
        spreadAxle(wheels, ra, lambda)
      }
      // Axle differentials.
      for (let a = 0; a < s.axles.length; a++) {
        const axle = s.axles[a]!
        if (axle.diff === DIFF_OPEN || axle.left < 0 || axle.right < 0) continue
        const l = wheels[axle.left]!
        const r = wheels[axle.right]!
        const k = l.invI + r.invI
        if (k <= 0) continue
        const lambda0 = (l.omega - r.omega) / k
        let bound = Infinity
        if (axle.diff === DIFF_LSD) {
          const tin = Math.abs(s.clutchAcc * g * axle.drive)
          bound = axle.preload * h + (tin * (axle.torqueBias - 1)) / (axle.torqueBias + 1)
        }
        const prev = axle.accLock
        let next = prev + lambda0
        if (next > bound) next = bound
        if (next < -bound) next = -bound
        const lambda = next - prev
        axle.accLock = next
        l.omega -= lambda * l.invI
        r.omega += lambda * r.invI
      }
      // Brakes and rolling resistance: torque toward zero spin, bounded. Sweeps alternate
      // direction so no wheel always goes first (Gauss-Seidel order bias pulls to one side).
      const back = (it + step) & 1
      for (let ii = 0; ii < n; ii++) {
        const i = back ? n - 1 - ii : ii
        const wh = wheels[i]!
        if (wh.brakeBound <= 0 || wh.pin !== 0) continue
        const prev = wh.accBrake
        let next = prev - wh.omega * wh.inertia
        if (next > wh.brakeBound) next = wh.brakeBound
        if (next < -wh.brakeBound) next = -wh.brakeBound
        wh.omega += (next - prev) / wh.inertia
        wh.accBrake = next
      }
      // Tires: longitudinal couples the chassis and the wheel; lateral the chassis only.
      for (let ii = 0; ii < n; ii++) {
        const i = back ? n - 1 - ii : ii
        const wh = wheels[i]!
        if (!wh.grounded) continue
        const rx = wh.rx
        const ry = wh.ry
        const rz = wh.rz
        // Longitudinal: slip velocity (contact forward speed − rim speed) toward zero.
        const vx = relVel(s, wh, rx, ry, rz, wh.fx, wh.fy, wh.fz)
        if (wh.pin === PIN_LOCK) wh.omega = 0
        else if (wh.pin === PIN_ABS) wh.omega = (vx * (1 - Math.sign(vx) * wh.absSlip)) / wh.radius
        const slip = vx - wh.omega * wh.radius
        // A pinned wheel doesn't spin up: the brake takes the tire's torque.
        const kx = wh.kf + wh.radius * wh.radius * wh.invI
        let prev = wh.accX
        let next = prev - (slip + wh.softX * prev) / (kx + wh.softX)
        if (next > wh.limX) next = wh.limX
        if (next < -wh.limX) next = -wh.limX
        let j = next - prev
        wh.accX = next
        if (j !== 0) {
          impulse(s, j, rx, ry, rz, wh.fx, wh.fy, wh.fz)
          wh.omega -= j * wh.radius * wh.invI
          wh.ix += wh.fx * j
          wh.iy += wh.fy * j
          wh.iz += wh.fz * j
        }
        // Lateral.
        const vy = relVel(s, wh, rx, ry, rz, wh.sx, wh.sy, wh.sz)
        prev = wh.accY
        next = prev - (vy + wh.softY * prev) / (wh.ks + wh.softY)
        if (next > wh.limY) next = wh.limY
        if (next < -wh.limY) next = -wh.limY
        j = next - prev
        wh.accY = next
        if (j !== 0) {
          impulse(s, j, rx, ry, rz, wh.sx, wh.sy, wh.sz)
          wh.ix += wh.sx * j
          wh.iy += wh.sy * j
          wh.iz += wh.sz * j
        }
      }
    }

    // Loose ground: plowing and ruts against the contact's velocity, never reversing it.
    for (let i = 0; i < n; i++) {
      const wh = wheels[i]!
      if (!wh.grounded || wh.sinkage <= 0) continue
      const vx = relVel(s, wh, wh.cx, wh.cy, wh.cz, wh.fx, wh.fy, wh.fz)
      // Plowing grows with speed and sinkage; a dug-in wheel also has to climb out of its rut,
      // a resistance that holds at a standstill.
      const rut = (0.6 * wh.sinkage) / wh.radius
      const j0 = (wh.drag * wh.sinkage * Math.abs(vx) + rut * wh.load) * h
      const stop = Math.abs(vx) / wh.kf
      const j = -Math.sign(vx) * Math.min(j0, stop)
      if (j !== 0) {
        impulse(s, j, wh.cx, wh.cy, wh.cz, wh.fx, wh.fy, wh.fz)
        wh.ix += wh.fx * j
        wh.iy += wh.fy * j
        wh.iz += wh.fz * j
      }
    }

    // Spin integrates the visual angle; digging follows wheel spin.
    for (let i = 0; i < n; i++) {
      const wh = wheels[i]!
      wh.angle += wh.omega * h
      if (wh.grounded && wh.dig > 0) {
        const k = Math.abs(wh.slipRatio)
        const peak = wh.tire.longitudinal.peakSlip * (1 + wh.loose)
        if (k > peak) wh.dug = Math.min(wh.maxSinkage, wh.dug + wh.dig * (k - peak) * h)
        else if (Math.abs(wh.omega * wh.radius) > 0.5)
          wh.dug = Math.max(0, wh.dug - wh.dig * 0.5 * h)
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const wh = wheels[i]!
    if (wh.angle > 1e4 || wh.angle < -1e4) {
      const wrap = Math.round(wh.angle / TAU) * TAU
      wh.angle -= wrap
      wh.prevAngle -= wrap
    }
  }
  // Engine load for audio: −1 engine braking … 1 full power.
  if (en && s.running) {
    const rpm = s.omegaE * RPM
    s.load =
      throttleEff > 0.02
        ? throttleEff
        : rpm > en.idle * 1.2 && engage > 0.5
          ? -Math.min(1, ((rpm - en.idle) / (en.max - en.idle)) * 2)
          : 0
  } else s.load = 0
}

function axleSpeed(wheels: WheelSim[], axle: AxleSim): number {
  let sum = 0
  for (let i = 0; i < axle.wheels.length; i++) sum += wheels[axle.wheels[i]!]!.omega
  return axle.wheels.length > 0 ? sum / axle.wheels.length : 0
}

function axleInvInertia(wheels: WheelSim[], axle: AxleSim): number {
  // An axle's speed is its wheels' mean: an impulse λ spread evenly moves it by λ Σ(1/n²I).
  const n = axle.wheels.length
  let k = 0
  for (let i = 0; i < n; i++) k += wheels[axle.wheels[i]!]!.invI / (n * n)
  return k
}

function spreadAxle(wheels: WheelSim[], axle: AxleSim, lambda: number): void {
  const n = axle.wheels.length
  for (let i = 0; i < n; i++) {
    const wh = wheels[axle.wheels[i]!]!
    wh.omega += (lambda * wh.invI) / n
  }
}

/**
 * After the substeps: chassis aids (downforce, air control, drift hold, anti-flip, self-right),
 * standstill, air time and landings, speed and drift angle, stalls. Leaves the velocity to write
 * back in `s.v` and `s.w` with gravity taken out (Rapier adds it in its step).
 */
export function stepFinish(s: VehicleSim, input: InputSim, ctx: StepContext): void {
  const dt = ctx.dt
  const v = s.v
  const w = s.w
  const up = s.up
  const as = s.assists
  const en = s.engine
  const tr = s.transmission
  const speed = v[0]! * s.fwd[0]! + v[1]! * s.fwd[1]! + v[2]! * s.fwd[2]!
  const lateral = v[0]! * s.right[0]! + v[1]! * s.right[1]! + v[2]! * s.right[2]!
  s.speed = speed
  s.driftAngle = Math.abs(speed) > 2 ? Math.atan2(-lateral, Math.abs(speed)) : 0

  // Air drag against the velocity, never reversing it.
  if (s.aeroDrag > 0) {
    const vl = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!)
    if (vl > 1e-3) {
      const dv = Math.min(vl, s.aeroDrag * vl * vl * dt * s.invMass)
      v[0] = v[0]! - (v[0]! / vl) * dv
      v[1] = v[1]! - (v[1]! / vl) * dv
      v[2] = v[2]! - (v[2]! / vl) * dv
    }
  }
  // Downforce at the center of mass, along −up.
  if (as.downforce > 0 && s.grounded > 0) {
    const f = as.downforce * speed * speed * dt * s.invMass
    v[0] = v[0]! - up[0]! * f
    v[1] = v[1]! - up[1]! * f
    v[2] = v[2]! - up[2]! * f
  }
  // Air control: torque from the inputs while every wheel is off the ground.
  if (s.grounded === 0 && (as.airX > 0 || as.airY > 0 || as.airZ > 0)) {
    const pitch = (input.throttle - input.brake) * as.airX
    const yaw = -input.steer * as.airY
    const roll = input.steer * as.airZ
    // Local axes: pitch about right, yaw about up, roll about forward.
    const tx = s.right[0]! * pitch + up[0]! * yaw + s.fwd[0]! * roll
    const ty = s.right[1]! * pitch + up[1]! * yaw + s.fwd[1]! * roll
    const tz = s.right[2]! * pitch + up[2]! * yaw + s.fwd[2]! * roll
    const m = s.iinv
    w[0] = w[0]! + (m[0]! * tx + m[1]! * ty + m[2]! * tz) * dt
    w[1] = w[1]! + (m[3]! * tx + m[4]! * ty + m[5]! * tz) * dt
    w[2] = w[2]! + (m[6]! * tx + m[7]! * ty + m[8]! * tz) * dt
  }
  // Drift hold: damp yaw past 45° of slide, and keep speed along the travel through a drift.
  if (as.driftHold > 0 && s.grounded > 0 && Math.abs(speed) > 3) {
    const beta = Math.abs(s.driftAngle)
    const yaw = w[0]! * up[0]! + w[1]! * up[1]! + w[2]! * up[2]!
    // Past 35° the yaw is damped, harder the further past, so a drift settles instead of spinning.
    if (beta > 0.6) {
      const d = yaw * as.driftHold * Math.min(1, dt * (4 + 40 * (beta - 0.6)))
      w[0] = w[0]! - up[0]! * d
      w[1] = w[1]! - up[1]! * d
      w[2] = w[2]! - up[2]! * d
    }
    // The handbrake flick: held at speed, it turns the car toward the steer, fading by 45°.
    if (input.handbrake > 0.5 && input.steer !== 0 && beta < 0.8) {
      const kick = -Math.sign(input.steer) * as.driftHold * 3 * (1 - beta / 0.8) * dt
      w[0] = w[0]! + up[0]! * kick
      w[1] = w[1]! + up[1]! * kick
      w[2] = w[2]! + up[2]! * kick
    }
    if (beta > 0.15 && beta < 1.2 && input.throttle > 0.1) {
      const vl = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!) || 1
      const push = as.driftHold * 0.8 * ctx.gravity * dt * input.throttle
      v[0] = v[0]! + (v[0]! / vl) * push
      v[1] = v[1]! + (v[1]! / vl) * push
      v[2] = v[2]! + (v[2]! / vl) * push
    }
  }
  // Anti-flip: damp roll while one side's wheels are off the ground.
  if (as.antiFlip > 0 && s.grounded > 0 && s.grounded < s.wheels.length) {
    const roll = w[0]! * s.fwd[0]! + w[1]! * s.fwd[1]! + w[2]! * s.fwd[2]!
    const d = roll * as.antiFlip * Math.min(1, dt * 10)
    w[0] = w[0]! - s.fwd[0]! * d
    w[1] = w[1]! - s.fwd[1]! * d
    w[2] = w[2]! - s.fwd[2]! * d
  }
  // Self-right: upside down (or on its side) and slow for 2 s, turn upright over about a second.
  const upDot = -(up[0]! * ctx.gx + up[1]! * ctx.gy + up[2]! * ctx.gz) / (ctx.gravity || 1)
  const slow = v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]! < 1
  s.upsideTime = upDot < 0.3 && slow ? s.upsideTime + dt : 0
  if (as.selfRight && s.upsideTime > 2) {
    // Axis: up × world up; angle from the dot.
    const wx = -ctx.gx / (ctx.gravity || 1)
    const wy = -ctx.gy / (ctx.gravity || 1)
    const wz = -ctx.gz / (ctx.gravity || 1)
    let axx = up[1]! * wz - up[2]! * wy
    let axy = up[2]! * wx - up[0]! * wz
    let axz = up[0]! * wy - up[1]! * wx
    let al = Math.sqrt(axx * axx + axy * axy + axz * axz)
    if (al < 1e-4) {
      axx = s.fwd[0]!
      axy = s.fwd[1]!
      axz = s.fwd[2]!
      al = 1
    }
    const angle = Math.acos(Math.max(-1, Math.min(1, upDot)))
    const rate = Math.min(3, angle * 2)
    w[0] = (axx / al) * rate
    w[1] = (axy / al) * rate
    w[2] = (axz / al) * rate
    v[0] = v[0]! + wx * 2 * dt * ctx.gravity
    v[1] = v[1]! + wy * 2 * dt * ctx.gravity
    v[2] = v[2]! + wz * 2 * dt * ctx.gravity
    if (angle < 0.2) s.upsideTime = 0
  }

  // Air time and landings.
  if (s.grounded === 0) s.airTime += dt
  else {
    if (s.airTime >= 0.3) {
      s.events.landed = true
      s.events.landedAir = s.airTime
      s.events.landedSpeed = Math.max(0, -(v[0]! * up[0]! + v[1]! * up[1]! + v[2]! * up[2]!))
    }
    s.airTime = 0
  }

  // Standstill: under 0.2 m/s for 1 s with no drive torque, tires hold statically (PhysX's sticky tire).
  const driving =
    input.throttle > 0.02 ||
    (s.transmission && !s.transmission.manual && s.gear < 0 && input.brake > 0.02)
  let fast = false
  for (let i = 0; i < s.wheels.length; i++) {
    const wh = s.wheels[i]!
    if (Math.abs(wh.omega * wh.radius) > 0.2) fast = true
  }
  let settled = true
  for (let i = 0; i < s.wheels.length; i++) if (Math.abs(s.wheels[i]!.xdot) > 0.01) settled = false
  s.settled = settled
  const crawl = Math.abs(speed) < 0.2 && Math.abs(lateral) < 0.2 && !fast
  s.stillTime = crawl && !driving && s.grounded > 0 ? s.stillTime + dt : 0
  s.sticky = s.stillTime > 1

  // Stall: a manual's clutch dragging the engine under stallRpm.
  if (
    en &&
    tr &&
    en.stall &&
    s.running &&
    s.clutch > 0.5 &&
    s.gear !== 0 &&
    s.omegaE * RPM < en.stallRpm
  ) {
    s.running = false
    s.events.stalled = true
  }

  // Gravity comes back out: Rapier adds it in its step.
  v[0] = v[0]! - ctx.gx * dt
  v[1] = v[1]! - ctx.gy * dt
  v[2] = v[2]! - ctx.gz * dt
}

/**
 * A vehicle another machine simulates (0118): its wheels roll with the ground under them, so
 * visuals, effects and audio still follow; no forces.
 */
export function stepPresented(s: VehicleSim, dt: number): void {
  const v = s.v
  const w = s.w
  let grounded = 0
  for (let i = 0; i < s.wheels.length; i++) {
    const wh = s.wheels[i]!
    if (wh.grounded) {
      grounded++
      const rx = wh.px - s.com[0]!
      const ry = wh.py - s.com[1]!
      const rz = wh.pz - s.com[2]!
      const vx = v[0]! + w[1]! * rz - w[2]! * ry
      const vy = v[1]! + w[2]! * rx - w[0]! * rz
      const vz = v[2]! + w[0]! * ry - w[1]! * rx
      // Forward at this wheel's steer.
      const cs = Math.cos(wh.steer)
      const sn = Math.sin(wh.steer)
      const fx = s.fwd[0]! * cs - s.right[0]! * sn
      const fy = s.fwd[1]! * cs - s.right[1]! * sn
      const fz = s.fwd[2]! * cs - s.right[2]! * sn
      wh.omega = (vx * fx + vy * fy + vz * fz) / wh.radius
      wh.load = wh.staticLoad
    } else wh.omega *= 0.98
    wh.slipRatio = wh.slipAngle = wh.skid = 0
    wh.angle += wh.omega * dt
  }
  s.grounded = grounded
  s.speed = v[0]! * s.fwd[0]! + v[1]! * s.fwd[1]! + v[2]! * s.fwd[2]!
}
