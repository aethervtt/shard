import {
  ChildOf,
  Children,
  defineSystem,
  type Entity,
  FixedUpdate,
  onAdd,
  onRemove,
  PostUpdate,
  ShardError,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import {
  CharacterState,
  CharacterSuspended,
  characterSystem,
  createSurfaceSample,
  Joint,
  Mass,
  Physics,
  PhysicsConfig,
  type PhysicsWorld,
  physicsStep,
  RigidBody,
  RoadConditions,
  Surfaces,
  surfaceAt,
} from '@aethervtt/shard-physics'
import { definePlugin, FixedTime, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { InstancePart } from '@aethervtt/shard-scene'
import { GlobalTransform, Transform, TransformSystems } from '@aethervtt/shard-transform'
import type RAPIER from '@dimforge/rapier3d-compat'
import * as componentsModule from './components'
import {
  NO_GEAR,
  Vehicle,
  VehicleAssists,
  VehicleConfig,
  VehicleEngine,
  VehicleEngineEvent,
  VehicleHitEvent,
  VehicleInput,
  VehicleLandedEvent,
  VehicleShiftEvent,
  VehicleState,
  VehicleTransmission,
  VehicleWheel,
  VehicleWheelEvent,
  WheelState,
} from './components'
import { vehicleMethods } from './methods'
import { vehicleOverlay } from './overlay'
import { ASSIST_PRESET_VALUES } from './presets'
import {
  type AxleSim,
  beginStep,
  checkCurve,
  checkGears,
  createInput,
  createWheel,
  cylinderRotation,
  DIFF_LOCKED,
  DIFF_LSD,
  DIFF_OPEN,
  hardpoint,
  type InputSim,
  inertiaTimes,
  type ProbeHit,
  principal,
  readChassis,
  SIDE_CENTER,
  SIDE_LEFT,
  SIDE_RIGHT,
  type StepContext,
  setSurfaceLookup,
  sprungMasses,
  stepControls,
  stepDynamics,
  stepFinish,
  stepGround,
  stepPresented,
  VehicleSim,
  type WheelSim,
} from './sim'
import { VehicleSimsResource } from './sims'
import * as tireModule from './tire'
import { registerTirePresets, resolveTire } from './tire'

const KIND_DYNAMIC = 0
const KIND_FIXED = 1
const DEG = Math.PI / 180
const RPM = 60 / (Math.PI * 2)

export { VehicleSims, VehicleSimsResource } from './sims'

// --- building (cold) --------------------------------------------------------------

function report(world: World, sim: VehicleSim, err: ShardError): void {
  sim.ok = false
  if (sim.error === err.code) return
  sim.error = err.code
  world.tryResource(LogResource)?.error(err)
}

/** The wheels of a chassis: children (and their children) with VehicleWheel, not under another body. */
function wheelsOf(world: World, chassis: Entity, out: Entity[]): Entity[] {
  out.length = 0
  const visit = (e: Entity) => {
    const kids = world.tryGet(e, Children)?.entities
    if (!kids) return
    for (const k of kids) {
      if (k === null || !world.isAlive(k)) continue
      if (world.has(k, RigidBody)) continue
      if (world.has(k, VehicleWheel)) out.push(k)
      visit(k)
    }
  }
  visit(chassis)
  return out
}

/** A descendant's position in the chassis frame, composing local Transforms up to the chassis. */
function localToChassis(world: World, chassis: Entity, e: Entity, out: Float64Array): void {
  let x = 0
  let y = 0
  let z = 0
  let node: Entity | null = e
  while (node !== null && node !== chassis) {
    const tr = world.get(node, Transform)
    const [qx, qy, qz, qw] = tr.rotation
    const [sx, sy, sz] = tr.scale
    const px = x * sx
    const py = y * sy
    const pz = z * sz
    // rotate (px, py, pz) by the node's rotation, then translate.
    const tx = 2 * (qy * pz - qz * py)
    const ty = 2 * (qz * px - qx * pz)
    const tz = 2 * (qx * py - qy * px)
    x = px + qw * tx + (qy * tz - qz * ty) + tr.translation[0]
    y = py + qw * ty + (qz * tx - qx * tz) + tr.translation[1]
    z = pz + qw * tz + (qx * ty - qy * tx) + tr.translation[2]
    node = world.tryGet(node, ChildOf)?.parent ?? null
  }
  out[0] = x
  out[1] = y
  out[2] = z
}

const scratch3 = new Float64Array(3)

/** (Re)builds a vehicle's settings from its components, keeping its running state. */
export function buildVehicle(world: World, p: PhysicsWorld, sim: VehicleSim): boolean {
  const entity = sim.entity
  sim.ok = false
  const record = p.bodies.get(entity)
  // Fixed is a mistake; kinematic is a vehicle another machine simulates (it's presented).
  if (!record || record.kind === KIND_FIXED) {
    report(
      world,
      sim,
      new ShardError('vehicle/not-dynamic', `Vehicle ${entity} has no dynamic RigidBody`, {
        hint: 'A vehicle chassis is a RigidBody { kind: "dynamic" } with colliders and Mass.',
      }),
    )
    return false
  }
  const vehicle = world.get(entity, Vehicle)
  // Assist presets write their values once, then read custom.
  const assists = world.tryGet(entity, VehicleAssists)
  if (assists && assists.preset !== 'custom') {
    world.set(entity, VehicleAssists, { ...ASSIST_PRESET_VALUES[assists.preset], preset: 'custom' })
  }

  // Mass properties from Rapier (after physics/sync-in built the body).
  const body = record.body
  sim.mass = body.mass()
  sim.invMass = sim.mass > 0 ? 1 / sim.mass : 0
  const lc = body.localCom() as { x: number; y: number; z: number }
  sim.comLocal[0] = lc.x
  sim.comLocal[1] = lc.y
  sim.comLocal[2] = lc.z
  const inv = body.invPrincipalInertia() as { x: number; y: number; z: number }
  const frame = body.principalInertiaLocalFrame() as { x: number; y: number; z: number; w: number }
  const inertia = body.principalInertia() as { x: number; y: number; z: number }
  principal.set(sim, {
    inv: new Float64Array([inv.x, inv.y, inv.z]),
    inertia: new Float64Array([inertia.x, inertia.y, inertia.z]),
    frame: new Float64Array([frame.x, frame.y, frame.z, frame.w]),
  })

  // Wheels.
  const entities = wheelsOf(world, entity, [])
  if (entities.length === 0) {
    report(
      world,
      sim,
      new ShardError('vehicle/no-wheels', `Vehicle ${entity} has no wheels`, {
        hint: 'Add children with vehicle/VehicleWheel at the wheel centers (ride height).',
      }),
    )
    return false
  }
  const old = new Map(sim.wheels.map((w) => [w.entity, w]))
  const wheels: WheelSim[] = []
  let tiresReady = true
  for (const e of entities) {
    const c = world.get(e, VehicleWheel)
    const wh = old.get(e) ?? createWheel(e)
    if (c.axle >= vehicle.axles.length) {
      report(
        world,
        sim,
        new ShardError(
          'vehicle/bad-axle',
          `Wheel ${e} names axle ${c.axle}; the vehicle has ${vehicle.axles.length}`,
          { hint: 'VehicleWheel.axle indexes Vehicle.axles (0 is the first).' },
        ),
      )
      return false
    }
    wh.axle = c.axle
    wh.side = c.side === 'left' ? SIDE_LEFT : c.side === 'right' ? SIDE_RIGHT : SIDE_CENTER
    wh.radius = c.radius
    wh.width = c.width
    wh.inertia = 0.5 * c.mass * c.radius * c.radius
    const tire = resolveTire(world, c.tire)
    wh.tireReady = tire !== undefined
    if (!tire) tiresReady = false
    wh.tire = tire ?? (resolveTire(world, null) as NonNullable<typeof tire>)
    wh.frequency = c.frequency
    wh.dampBump = c.damping[0]
    wh.dampRebound = c.damping[1]
    wh.travelUp = c.travel[0]
    wh.travelDown = c.travel[1]
    wh.camber = c.camber * DEG
    wh.forceHeight = c.forceHeight
    wh.gripScale = c.gripScale
    wh.visual = (c.visual ?? -1) as Entity
    wh.visualName = c.visualName
    localToChassis(world, entity, e, scratch3)
    wh.hx = scratch3[0]!
    wh.hy = scratch3[1]!
    wh.hz = scratch3[2]!
    wheels.push(wh)
  }
  sim.wheels = wheels
  sim.pendingTires = !tiresReady

  // Axles.
  const axles: AxleSim[] = vehicle.axles.map((a) => ({
    steer: a.steer,
    drive: a.drive,
    diff:
      a.differential === 'locked'
        ? DIFF_LOCKED
        : a.differential === 'limited-slip'
          ? DIFF_LSD
          : DIFF_OPEN,
    torqueBias: a.torqueBias,
    preload: a.preload,
    antiRoll: a.antiRoll,
    brakeTorque: a.brakeTorque,
    handbrakeTorque: a.handbrakeTorque,
    left: -1,
    right: -1,
    wheels: [],
    z: 0,
    accLock: 0,
  }))
  for (let i = 0; i < wheels.length; i++) {
    const wh = wheels[i]!
    const axle = axles[wh.axle]!
    axle.wheels.push(i)
    if (wh.side === SIDE_LEFT && axle.left < 0) axle.left = i
    if (wh.side === SIDE_RIGHT && axle.right < 0) axle.right = i
  }
  for (const axle of axles) {
    let z = 0
    for (const i of axle.wheels) z += wheels[i]!.hz
    axle.z = axle.wheels.length > 0 ? z / axle.wheels.length : 0
  }
  sim.axles = axles
  const hasEngine = world.has(entity, VehicleEngine) && world.has(entity, VehicleTransmission)
  sim.driven = []
  for (let a = 0; a < axles.length; a++)
    if (axles[a]!.drive > 0 && axles[a]!.wheels.length > 0) sim.driven.push(a)
  for (const wh of wheels) {
    const axle = axles[wh.axle]!
    wh.drive = hasEngine && axle.wheels.length > 0 ? axle.drive / axle.wheels.length : 0
  }
  // Wheelbase and the steering reference line (the unsteered axles, else the rearmost).
  let minZ = Infinity
  let maxZ = -Infinity
  let refZ = 0
  let refN = 0
  for (const axle of axles) {
    if (axle.wheels.length === 0) continue
    minZ = Math.min(minZ, axle.z)
    maxZ = Math.max(maxZ, axle.z)
    if (axle.steer === 0) {
      refZ += axle.z
      refN++
    }
  }
  sim.wheelbase = Math.max(0.5, maxZ - minZ)
  sim.rearZ = refN > 0 ? refZ / refN : maxZ

  // Sprung masses: wheels, plus a hitch joint as a support (a trailer rests on it).
  const xs: number[] = []
  const zs: number[] = []
  for (const wh of wheels) {
    xs.push(wh.hx - sim.comLocal[0]!)
    zs.push(wh.hz - sim.comLocal[2]!)
  }
  const joint = world.tryGet(entity, Joint)
  const hitched = joint !== undefined && joint.other !== null
  if (hitched) {
    xs.push(joint.anchor[0] - sim.comLocal[0]!)
    zs.push(joint.anchor[2] - sim.comLocal[2]!)
  }
  const masses = sprungMasses(xs, zs, sim.mass)
  if (!masses) {
    report(
      world,
      sim,
      new ShardError(
        'vehicle/bad-sprung-mass',
        `Vehicle ${entity}'s center of mass is outside its wheels: a wheel would carry negative weight`,
        {
          hint: 'Move physics/Mass.centerOfMass between the wheels (or hitch a trailer with a Joint).',
        },
      ),
    )
    return false
  }
  const config = world.resource(PhysicsConfig)
  const g = Math.sqrt(config.gravity[0] ** 2 + config.gravity[1] ** 2 + config.gravity[2] ** 2)
  for (let i = 0; i < wheels.length; i++) {
    const wh = wheels[i]!
    const m = Math.max(masses[i]!, 1e-3)
    const omega = 2 * Math.PI * wh.frequency
    wh.sprungMass = m
    wh.staticLoad = m * g
    wh.k = m * omega * omega
    const crit = 2 * Math.sqrt(wh.k * m)
    wh.cBump = wh.dampBump * crit
    wh.cRebound = wh.dampRebound * crit
  }

  // Steering.
  const st = vehicle.steer
  sim.steering.maxAngle = st.maxAngle * DEG
  sim.steering.ackermann = st.ackermann
  sim.steering.speed = st.speed * DEG
  sim.steering.returnSpeed = st.returnSpeed * DEG
  sim.steering.atSpeed = new Float64Array(st.atSpeed.flat())
  sim.centerDiff =
    vehicle.centerDiff === 'locked'
      ? DIFF_LOCKED
      : vehicle.centerDiff === 'limited-slip'
        ? DIFF_LSD
        : DIFF_OPEN
  sim.centerBias = vehicle.centerTorqueBias
  sim.aeroDrag = vehicle.aeroDrag
  sim.substeps = Math.max(1, vehicle.substeps)
  sim.iterations = Math.max(1, vehicle.iterations)
  sim.cylinder = vehicle.probe === 'cylinder'
  sim.mask = vehicle.mask

  // Engine and gearbox.
  const engine = world.tryGet(entity, VehicleEngine)
  const gearbox = world.tryGet(entity, VehicleTransmission)
  if (engine && gearbox) {
    const curve = new Float64Array(engine.torque.flat())
    const bad = checkCurve(curve)
    if (bad) {
      report(
        world,
        sim,
        new ShardError('vehicle/bad-curve', bad, {
          hint: 'VehicleEngine.torque: (rpm, N·m) points, rpm increasing.',
        }),
      )
      return false
    }
    const badGears = checkGears(gearbox.gears, gearbox.upshift, gearbox.downshift)
    if (badGears) {
      report(
        world,
        sim,
        new ShardError('vehicle/bad-gears', badGears, {
          hint: 'Forward ratios descend; raise upshift, lower downshift, or space the ratios closer.',
        }),
      )
      return false
    }
    const fresh = sim.engine === undefined
    sim.engine = {
      torque: curve,
      idle: engine.idleRpm,
      max: engine.maxRpm,
      stallRpm: engine.stallRpm,
      stall: engine.stall,
      inertia: engine.inertia,
      braking: engine.braking,
      torqueScale: engine.torqueScale,
    }
    sim.transmission = {
      manual: gearbox.mode === 'manual',
      pedal: gearbox.clutch === 'pedal',
      gears: new Float64Array(gearbox.gears),
      reverse: gearbox.reverse,
      finalDrive: gearbox.finalDrive,
      efficiency: gearbox.efficiency,
      shiftTime: gearbox.shiftTime,
      clutchTorque: gearbox.clutchTorque,
      upshift: gearbox.upshift,
      downshift: gearbox.downshift,
      reverseOnBrake: gearbox.reverseOnBrake,
    }
    if (fresh) {
      sim.running = engine.running
      sim.omegaE = engine.running ? engine.idleRpm / RPM : 0
      sim.gear = sim.targetGear = gearbox.mode === 'manual' ? 0 : 1
    }
    if (sim.gear > gearbox.gears.length) sim.gear = sim.targetGear = gearbox.gears.length
  } else {
    sim.engine = undefined
    sim.transmission = undefined
    sim.gear = 0
  }

  const a = world.tryGet(entity, VehicleAssists)
  if (a && a.preset === 'custom') {
    const s = sim.assists
    s.abs = a.abs
    s.tcs = a.tcs
    s.esc = a.esc
    s.understeer = a.understeer
    s.counterSteer = a.counterSteer
    s.driftGrip = a.driftGrip
    s.driftHold = a.driftHold
    s.downforce = a.downforce
    s.airX = a.airControl[0]
    s.airY = a.airControl[1]
    s.airZ = a.airControl[2]
    s.selfRight = a.selfRight
    s.antiFlip = a.antiFlip
  } else if (!a) {
    Object.assign(sim.assists, {
      abs: 0,
      tcs: 0,
      esc: 0,
      counterSteer: 0,
      driftGrip: 1,
      driftHold: 0,
      downforce: 0,
      airX: 0,
      airY: 0,
      airZ: 0,
      selfRight: false,
      antiFlip: 0,
    })
  }

  // State components the step writes.
  if (!world.has(entity, VehicleState)) world.add(entity, VehicleState, {})
  for (const wh of wheels)
    if (!world.has(wh.entity, WheelState)) world.add(wh.entity, WheelState, {})
  sim.sources = [entity, ...entities]
  sim.ok = true
  sim.error = undefined
  return true
}

// --- the step system -------------------------------------------------------------

interface StepScratch {
  vehicles: ReturnType<World['query']>
  wheels: ReturnType<World['query']>
  hits: ProbeHit[]
  ctx: StepContext | undefined
  input: InputSim
  hp: Float64Array
  rot: Float64Array
  torque: Float64Array
  ray: RAPIER.Ray | undefined
  shapes: Map<WheelSim, RAPIER.Shape>
  predicate: ((c: RAPIER.Collider) => boolean) | undefined
  pos: { x: number; y: number; z: number }
  dir: { x: number; y: number; z: number }
  quat: { x: number; y: number; z: number; w: number }
  hitVisit: ((other: number) => void) | undefined
  hitSim: VehicleSim | undefined
  hitCandidates: Entity[]
  lastHit: Map<string, number>
  touchingSpare: Set<Entity>
}

const createHit = (): ProbeHit => ({
  hit: false,
  distance: 0,
  px: 0,
  py: 0,
  pz: 0,
  nx: 0,
  ny: 1,
  nz: 0,
  collider: -1 as Entity,
  body: -1 as Entity,
})

const COS_80 = Math.cos(80 * DEG)

/**
 * Ground under one wheel, into `hit`: a ray under the hub, and with `probe: 'cylinder'` a cast of
 * the wheel's cylinder too, taken when it touches clearly sooner (a curb or step edge under the
 * tire's front or back). The ray keeps flat ground exact: a cast against a very large shape can
 * lose precision.
 */
function probe(
  p: PhysicsWorld,
  s: StepScratch,
  sim: VehicleSim,
  wh: WheelSim,
  hit: ProbeHit,
  body: RAPIER.RigidBody,
): void {
  const hp = s.hp
  hardpoint(sim, wh, hp)
  const up = sim.up
  const range = wh.travelUp + wh.travelDown + wh.sinkage + wh.bumpAmp + 0.02
  const groups = (0xffff << 16) | (sim.mask & 0xffff)
  const flags = p.R.QueryFilterFlags.EXCLUDE_SENSORS
  const predicate = p.characters.size > 0 ? s.predicate : undefined
  const R = p.R
  hit.hit = false
  s.dir.x = -up[0]!
  s.dir.y = -up[1]!
  s.dir.z = -up[2]!
  s.ray ??= new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
  const ray = s.ray
  ray.origin.x = hp[3]!
  ray.origin.y = hp[4]!
  ray.origin.z = hp[5]!
  ray.dir.x = s.dir.x
  ray.dir.y = s.dir.y
  ray.dir.z = s.dir.z
  const rh = p.raw.castRayAndGetNormal(
    ray,
    range + wh.radius,
    true,
    flags,
    groups,
    undefined,
    body,
    predicate,
  )
  if (rh) {
    const entity = p.colliderEntity.get(rh.collider.handle)
    const n = rh.normal
    if (entity !== undefined && n.x * up[0]! + n.y * up[1]! + n.z * up[2]! >= COS_80) {
      hit.hit = true
      hit.distance = rh.timeOfImpact - wh.radius
      hit.px = hp[3]! + s.dir.x * rh.timeOfImpact
      hit.py = hp[4]! + s.dir.y * rh.timeOfImpact
      hit.pz = hp[5]! + s.dir.z * rh.timeOfImpact
      hit.nx = n.x
      hit.ny = n.y
      hit.nz = n.z
      hit.collider = entity
      hit.body = (p.colliderOwner.get(entity) ?? -1) as Entity
    }
  }
  if (!sim.cylinder) return
  let shape = s.shapes.get(wh)
  if (!shape || (shape as RAPIER.Cylinder).radius !== wh.radius) {
    shape = new R.Cylinder(wh.width / 2, wh.radius)
    s.shapes.set(wh, shape)
  }
  cylinderRotation(sim, wh.steer, s.rot)
  s.pos.x = hp[3]!
  s.pos.y = hp[4]!
  s.pos.z = hp[5]!
  s.quat.x = s.rot[0]!
  s.quat.y = s.rot[1]!
  s.quat.z = s.rot[2]!
  s.quat.w = s.rot[3]!
  const limit = hit.hit ? hit.distance - CURB : range
  if (limit <= 0) return
  const cast = p.raw.castShape(
    s.pos as RAPIER.Vector,
    s.quat as RAPIER.Rotation,
    s.dir as RAPIER.Vector,
    shape,
    0,
    limit,
    true,
    flags,
    groups,
    undefined,
    body,
    predicate,
  )
  if (!cast) return
  const n = cast.normal1
  const entity = p.colliderEntity.get(cast.collider.handle)
  // Steeper than 80° (a wall at the wheel's side) doesn't hold the wheel up.
  if (entity === undefined || n.x * up[0]! + n.y * up[1]! + n.z * up[2]! < COS_80) return
  // A curb touches higher than the ground under the hub: a cast that touched at the ray's own
  // height is a spurious early hit (casts against very large shapes lose precision).
  if (hit.hit) {
    const w = cast.witness1
    const rise = (w.x - hit.px) * up[0]! + (w.y - hit.py) * up[1]! + (w.z - hit.pz) * up[2]!
    if (rise < CURB) return
  }
  // The patch center: the cast's center pushed down the normal by the radius.
  const toi = cast.time_of_impact
  hit.hit = true
  hit.distance = toi
  hit.px = hp[3]! + s.dir.x * toi - n.x * wh.radius
  hit.py = hp[4]! + s.dir.y * toi - n.y * wh.radius
  hit.pz = hp[5]! + s.dir.z * toi - n.z * wh.radius
  hit.nx = n.x
  hit.ny = n.y
  hit.nz = n.z
  hit.collider = entity
  hit.body = (p.colliderOwner.get(entity) ?? -1) as Entity
}

/** How much sooner (m) the cylinder must touch than the ray to count as a curb or edge. */
const CURB = 0.004

/** Ground velocity at each grounded wheel's contact (moving platforms, other bodies). */
function groundVelocity(p: PhysicsWorld, s: StepScratch, wh: WheelSim): void {
  wh.gvx = wh.gvy = wh.gvz = 0
  wh.groundDynamic = false
  if (!wh.grounded || wh.groundBody < 0) return
  const record = p.bodies.get(wh.groundBody)
  if (!record || record.kind === 1) return
  wh.groundDynamic = record.kind === KIND_DYNAMIC
  s.pos.x = wh.px
  s.pos.y = wh.py
  s.pos.z = wh.pz
  const gv = record.body.velocityAtPoint(s.pos as RAPIER.Vector, p.v3 as RAPIER.Vector) as {
    x: number
    y: number
    z: number
  }
  wh.gvx = gv.x
  wh.gvy = gv.y
  wh.gvz = gv.z
}

/** Reads VehicleInput's columns into `out` (zeros without one). */
function readInput(table: Table, row: number, out: InputSim): void {
  if (!table.has(VehicleInput)) {
    out.throttle = out.brake = out.steer = out.handbrake = out.clutch = out.shift = 0
    out.gear = NO_GEAR
    return
  }
  out.throttle = clamp01(table.column(VehicleInput, 'throttle')[row]!)
  out.brake = clamp01(table.column(VehicleInput, 'brake')[row]!)
  out.steer = Math.max(-1, Math.min(1, table.column(VehicleInput, 'steer')[row]!))
  out.handbrake = clamp01(table.column(VehicleInput, 'handbrake')[row]!)
  out.clutch = clamp01(table.column(VehicleInput, 'clutch')[row]!)
  out.shift = table.column(VehicleInput, 'shift')[row]!
  out.gear = table.column(VehicleInput, 'gear')[row]!
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x || 0)

function writeState(world: World, sim: VehicleSim): void {
  const table = world.entityTable(sim.entity)
  const row = world.entityRow(sim.entity)
  table.column(VehicleState, 'speed')[row] = sim.speed
  table.column(VehicleState, 'rpm')[row] = sim.engine ? sim.omegaE * RPM : 0
  table.column(VehicleState, 'gear')[row] = sim.shiftLeft > 0 ? 0 : sim.gear
  table.column(VehicleState, 'shifting')[row] = sim.shiftLeft > 0 ? 1 : 0
  table.column(VehicleState, 'clutch')[row] = sim.clutch
  table.column(VehicleState, 'throttle')[row] = sim.throttle
  table.column(VehicleState, 'load')[row] = sim.load
  table.column(VehicleState, 'grounded')[row] = sim.grounded
  table.column(VehicleState, 'airTime')[row] = sim.airTime
  table.column(VehicleState, 'driftAngle')[row] = sim.driftAngle
  table.column(VehicleState, 'steer')[row] = sim.steerAngle
  table.column(VehicleState, 'assists')[row] = sim.assistFlags
  table.markChanged(VehicleState, row)
  writeWheels(world, sim)
}

function writeWheels(world: World, sim: VehicleSim): void {
  for (let i = 0; i < sim.wheels.length; i++) {
    const wh = sim.wheels[i]!
    if (!world.isAlive(wh.entity)) continue
    const t = world.entityTable(wh.entity)
    const r = world.entityRow(wh.entity)
    if (!t.has(WheelState)) continue
    t.column(WheelState, 'grounded')[r] = wh.grounded ? 1 : 0
    t.column(WheelState, 'compression')[r] =
      (wh.x + wh.travelDown) / Math.max(1e-6, wh.travelUp + wh.travelDown)
    const pt = t.column(WheelState, 'point')
    pt[r * 3] = wh.px
    pt[r * 3 + 1] = wh.py
    pt[r * 3 + 2] = wh.pz
    const nm = t.column(WheelState, 'normal')
    nm[r * 3] = wh.nx
    nm[r * 3 + 1] = wh.ny
    nm[r * 3 + 2] = wh.nz
    t.column(WheelState, 'ground')[r] = wh.grounded ? wh.ground : -1
    t.column(WheelState, 'surface')[r] = wh.surface
    t.column(WheelState, 'load')[r] = wh.load
    t.column(WheelState, 'slipRatio')[r] = wh.slipRatio
    t.column(WheelState, 'slipAngle')[r] = wh.slipAngle
    t.column(WheelState, 'skid')[r] = wh.grounded ? wh.skid : 0
    t.column(WheelState, 'spin')[r] = wh.omega
    t.column(WheelState, 'angle')[r] = wh.angle
    t.column(WheelState, 'steer')[r] = wh.steer
    t.column(WheelState, 'sinkage')[r] = wh.grounded ? wh.sinkage : 0
    t.markChanged(WheelState, r)
  }
}

/** A presented vehicle's engine and steering come from its replicated VehicleState. */
function presentState(world: World, sim: VehicleSim): void {
  const table = world.entityTable(sim.entity)
  if (!table.has(VehicleState)) return
  const row = world.entityRow(sim.entity)
  sim.steerAngle = table.column(VehicleState, 'steer')[row]!
  sim.omegaE = table.column(VehicleState, 'rpm')[row]! / RPM
  sim.gear = table.column(VehicleState, 'gear')[row]!
  sim.load = table.column(VehicleState, 'load')[row]!
  sim.throttle = table.column(VehicleState, 'throttle')[row]!
  sim.clutch = table.column(VehicleState, 'clutch')[row]!
}

/**
 * Whether the body's mass moved off what the vehicle was built with: physics fixes it when the
 * chassis' colliders attach, a frame or two after the vehicle first builds.
 */
function massMoved(body: RAPIER.RigidBody, sim: VehicleSim): boolean {
  return Math.abs(body.mass() - sim.mass) > 1e-6 * Math.max(1, sim.mass)
}

/** The chassis components a vehicle is built from. */
const SOURCES = [Vehicle, VehicleEngine, VehicleTransmission, VehicleAssists, Joint] as const

/** Has any of the vehicle's source components changed since the last build? */
function changedSince(world: World, sim: VehicleSim, tick: number): boolean {
  const e = sim.entity
  const t = world.entityTable(e)
  const r = world.entityRow(e)
  for (let i = 0; i < SOURCES.length; i++) {
    const def = SOURCES[i]!
    if (t.has(def) && t.changedTicks(def)[r]! > tick) return true
  }
  if (t.has(Children) && t.changedTicks(Children)[r]! > tick) return true
  for (let i = 1; i < sim.sources.length; i++) {
    const w = sim.sources[i]!
    if (!world.isAlive(w)) return true
    const wt = world.entityTable(w)
    const wr = world.entityRow(w)
    if (wt.changedTicks(VehicleWheel)[wr]! > tick || wt.changedTicks(Transform)[wr]! > tick)
      return true
  }
  return false
}

/** Engine-only state when the vehicle is asleep: idles, reads `running`. */
function syncRunning(t: Table, r: number, sim: VehicleSim): void {
  if (!sim.engine) return
  const running = t.column(VehicleEngine, 'running')[r] === 1
  const scale = t.column(VehicleEngine, 'torqueScale')[r]!
  sim.engine.torqueScale = scale
  if (running !== sim.running) {
    sim.running = running
    if (running) {
      sim.events.started = true
      sim.omegaE = Math.max(sim.omegaE, sim.engine.idle / RPM)
    } else sim.events.stopped = true
  }
}

function sendEvents(world: World, sim: VehicleSim): void {
  const ev = sim.events
  const vehicle = sim.entity
  if (ev.shifted) world.send(VehicleShiftEvent, { vehicle, from: ev.shiftFrom, to: ev.shiftTo })
  if (ev.started) world.send(VehicleEngineEvent, { vehicle, kind: 'started' })
  if (ev.stopped) world.send(VehicleEngineEvent, { vehicle, kind: 'stopped' })
  if (ev.stalled) {
    world.send(VehicleEngineEvent, { vehicle, kind: 'stalled' })
    const t = world.entityTable(vehicle)
    const r = world.entityRow(vehicle)
    t.column(VehicleEngine, 'running')[r] = 0
    t.markChanged(VehicleEngine, r)
  }
  if (ev.backfire) world.send(VehicleEngineEvent, { vehicle, kind: 'backfire' })
  if (ev.landed)
    world.send(VehicleLandedEvent, { vehicle, airTime: ev.landedAir, speed: ev.landedSpeed })
  for (let i = 0; i < sim.wheels.length; i++) {
    const wh = sim.wheels[i]!
    if (wh.bottomSpeed > 1)
      world.send(VehicleWheelEvent, {
        vehicle,
        wheel: wh.entity,
        kind: 'bottom-out',
        speed: wh.bottomSpeed,
        surface: wh.surface,
      })
    if (wh.surfaceChanged && wh.grounded)
      world.send(VehicleWheelEvent, {
        vehicle,
        wheel: wh.entity,
        kind: 'surface',
        speed: 0,
        surface: wh.surface,
      })
  }
  if (ev.tookShift || ev.tookGear) {
    const t = world.entityTable(vehicle)
    const r = world.entityRow(vehicle)
    if (ev.tookShift) t.column(VehicleInput, 'shift')[r] = 0
    if (ev.tookGear) t.column(VehicleInput, 'gear')[r] = NO_GEAR
    t.markChanged(VehicleInput, r)
  }
}

/** Characters touching the chassis: momentum lost by mass ratio, and a VehicleHitEvent. */
function hitCharacters(
  world: World,
  p: PhysicsWorld,
  s: StepScratch,
  sim: VehicleSim,
  elapsed: number,
): void {
  const colliders = p.bodyColliders.get(sim.entity)
  if (!colliders || p.characters.size === 0) {
    sim.touching.clear()
    return
  }
  const config = world.resource(VehicleConfig)
  const found = s.hitCandidates
  found.length = 0
  s.hitSim = sim
  s.hitVisit ??= (other: number) => {
    const e = p.colliderEntity.get(other)
    if (e === undefined || !p.characters.has(e)) return
    // Occupants (and other suspended characters) ride along; they aren't hit.
    if (world.has(e, CharacterSuspended)) return
    if (!found.includes(e)) found.push(e)
  }
  for (const c of colliders) {
    const collider = p.colliders.get(c)
    if (collider) p.raw.narrowPhase.contactPairsWith(collider.handle, s.hitVisit)
  }
  // Only contacts that just started hit: a character still against the chassis was hit already.
  const touching = sim.touching
  sim.touching = s.touchingSpare
  s.touchingSpare = touching
  sim.touching.clear()
  for (let i = 0; i < found.length; i++) sim.touching.add(found[i]!)
  if (found.length === 0) return
  const v = sim.v
  const w = sim.w
  for (let i = 0; i < found.length; i++) {
    const ch = found[i]!
    if (touching.has(ch)) continue
    const key = `${sim.entity}:${ch}`
    const last = s.lastHit.get(key)
    if (last !== undefined && elapsed - last < config.hitCooldown) continue
    const record = p.bodies.get(ch)
    if (!record) continue
    const o = record.slot * 7
    const cx = p.curr[o]!
    const cy = p.curr[o + 1]!
    const cz = p.curr[o + 2]!
    // Horizontal (in the chassis' ground plane) direction from the center of mass to the character.
    let nx = cx - sim.com[0]!
    let ny = cy - sim.com[1]!
    let nz = cz - sim.com[2]!
    const d = nx * sim.up[0]! + ny * sim.up[1]! + nz * sim.up[2]!
    nx -= sim.up[0]! * d
    ny -= sim.up[1]! * d
    nz -= sim.up[2]! * d
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (l < 1e-4) continue
    nx /= l
    ny /= l
    nz /= l
    // Chassis velocity at the character, minus the character's own.
    const rx = cx - sim.com[0]!
    const ry = cy - sim.com[1]!
    const rz = cz - sim.com[2]!
    let vx = v[0]! + w[1]! * rz - w[2]! * ry
    let vy = v[1]! + w[2]! * rx - w[0]! * rz
    let vz = v[2]! + w[0]! * ry - w[1]! * rx
    if (world.has(ch, CharacterState)) {
      const t = world.entityTable(ch)
      const vel = t.column(CharacterState, 'velocity')
      const r = world.entityRow(ch)
      vx -= vel[r * 3]!
      vy -= vel[r * 3 + 1]!
      vz -= vel[r * 3 + 2]!
    }
    const vn = vx * nx + vy * ny + vz * nz
    if (vn < config.hitSpeed) continue
    const m = config.characterMass
    const dv = (vn * m) / (sim.mass + m)
    v[0] = v[0]! - nx * dv
    v[1] = v[1]! - ny * dv
    v[2] = v[2]! - nz * dv
    if (s.lastHit.size > 4096) s.lastHit.clear()
    s.lastHit.set(key, elapsed)
    world.send(VehicleHitEvent, {
      vehicle: sim.entity,
      other: ch,
      point: [cx, cy, cz],
      normal: [nx, ny, nz],
      speed: vn,
      character: true,
    })
  }
}

/**
 * Vehicles (0118): controls, probes, suspension, drivetrain and tires per physics step, between
 * physics/sync-in and the Rapier step; writes the chassis velocity back once.
 */
export const vehicleSystem = defineSystem({
  name: 'vehicle/step',
  description:
    'Steps every vehicle: steering and gearbox, wheel probes, suspension, drivetrain and tires; writes the chassis velocity and VehicleState and WheelState.',
  setup: (world) => {
    const s: StepScratch = {
      vehicles: world.query({ with: [Vehicle, RigidBody] }),
      wheels: world.query({ with: [VehicleWheel] }),
      hits: [],
      ctx: undefined,
      input: createInput(),
      hp: new Float64Array(6),
      rot: new Float64Array(4),
      torque: new Float64Array(3),
      ray: undefined,
      shapes: new Map(),
      predicate: undefined,
      pos: { x: 0, y: 0, z: 0 },
      dir: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      hitVisit: undefined,
      hitSim: undefined,
      hitCandidates: [],
      lastHit: new Map(),
      touchingSpare: new Set(),
    }
    return s
  },
  run: (s, world, ctx) => {
    const p = world.tryResource(Physics)
    if (!p || p.config.paused || p.dim !== 3) return
    const start = performance.now()
    const sims = world.resource(VehicleSimsResource)
    const fixed = world.resource(FixedTime)
    const config = p.config
    const gx = config.gravity[0]
    const gy = config.gravity[1]
    const gz = config.gravity[2]
    if (!s.ctx) {
      setSurfaceLookup(surfaceAt)
      s.ctx = {
        world,
        dt: fixed.step,
        gravity: 0,
        gx,
        gy,
        gz,
        wetness: 0,
        surfaces: world.resource(Surfaces),
        sample: createSurfaceSample(),
        hits: s.hits,
      }
      s.predicate = (c: RAPIER.Collider) => {
        const e = p.colliderEntity.get(c.handle)
        return e === undefined || !p.characters.has(e)
      }
    }
    const sc = s.ctx
    sc.dt = fixed.step
    sc.gx = gx
    sc.gy = gy
    sc.gz = gz
    sc.gravity = Math.sqrt(gx * gx + gy * gy + gz * gz)
    sc.wetness = world.resource(RoadConditions).wetness
    let active = 0
    const since = ctx.lastRunTick
    // Whether any wheel changed at all: only then is each vehicle's wheel list checked.
    let wheelsChanged = false
    for (let t = 0; t < s.wheels.tables.length; t++) {
      const wt = s.wheels.tables[t]!
      if (wt.lastChanged(VehicleWheel) > since || wt.lastChanged(Transform) > since)
        wheelsChanged = true
    }
    for (let t = 0; t < s.vehicles.tables.length; t++) {
      const table: Table = s.vehicles.tables[t]!
      // Table-level gates: most steps nothing a vehicle is built from changed.
      let tableChanged = table.has(Children) && table.lastChanged(Children) > since
      for (let i = 0; i < SOURCES.length; i++) {
        const def = SOURCES[i]!
        if (table.has(def) && table.lastChanged(def) > since) tableChanged = true
      }
      const massChanged = table.has(Mass) && table.lastChanged(Mass) > since
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]!
        let sim = sims.sims.get(entity)
        if (!sim) {
          sim = new VehicleSim(entity)
          sims.sims.set(entity, sim)
          sims.dirty.add(entity)
        }
        const record = p.bodies.get(entity)
        if (!record) continue
        if (
          sims.dirty.has(entity) ||
          sim.pendingTires ||
          (sim.ok && (tableChanged || wheelsChanged) && changedSince(world, sim, since)) ||
          (sim.ok && (massChanged || !record.body.isSleeping()) && massMoved(record.body, sim))
        ) {
          sims.dirty.delete(entity)
          buildVehicle(world, p, sim)
        }
        if (!sim.ok || record.parked || record.held) continue
        if (record.kind !== KIND_DYNAMIC || !sims.simulates(world, entity)) {
          // Another machine simulates it: wheels follow the ground and its replicated state.
          while (s.hits.length < sim.wheels.length) s.hits.push(createHit())
          readChassis(sim, p, record.slot, record.body)
          presentState(world, sim)
          beginStep(sim)
          for (let i = 0; i < sim.wheels.length; i++)
            probe(p, s, sim, sim.wheels[i]!, s.hits[i]!, record.body)
          stepGround(sim, sc)
          stepPresented(sim, sc.dt)
          hitCharacters(world, p, s, sim, fixed.elapsed)
          writeWheels(world, sim)
          continue
        }
        readInput(table, row, s.input)
        if (sim.engine) syncRunning(table, row, sim)
        const input = s.input
        const idle =
          input.throttle === 0 &&
          input.brake === 0 &&
          input.steer === 0 &&
          input.handbrake === 0 &&
          input.shift === 0 &&
          input.gear === NO_GEAR
        const body = record.body
        if (body.isSleeping()) {
          if (idle) {
            sendEvents(world, sim)
            sim.events.started = sim.events.stopped = false
            continue
          }
          body.wakeUp()
        }
        active++
        // Hits array sized to the wheels.
        while (s.hits.length < sim.wheels.length) s.hits.push(createHit())
        readChassis(sim, p, record.slot, body)
        stepControls(sim, input, sc.dt)
        beginStep(sim)
        for (let i = 0; i < sim.wheels.length; i++)
          probe(p, s, sim, sim.wheels[i]!, s.hits[i]!, body)
        stepGround(sim, sc)
        for (let i = 0; i < sim.wheels.length; i++) groundVelocity(p, s, sim.wheels[i]!)
        stepDynamics(sim, input, sc)
        hitCharacters(world, p, s, sim, fixed.elapsed)
        stepFinish(sim, input, sc)
        // The step's change of velocity goes to Rapier as a one-step force and torque, so it
        // integrates with gravity over Rapier's substeps (a velocity write would leave a car at
        // rest with a phantom sink speed). A car at a standstill doesn't keep itself awake.
        const wake = !(sim.sticky && sim.settled && idle)
        const inv = 1 / sc.dt
        const fx = (sim.v[0]! - sim.v0[0]!) * sim.mass * inv
        const fy = (sim.v[1]! - sim.v0[1]!) * sim.mass * inv
        const fz = (sim.v[2]! - sim.v0[2]!) * sim.mass * inv
        inertiaTimes(
          sim,
          (sim.w[0]! - sim.w0[0]!) * inv,
          (sim.w[1]! - sim.w0[1]!) * inv,
          (sim.w[2]! - sim.w0[2]!) * inv,
          s.torque,
          0,
        )
        p.addStepForce(entity, fx, fy, fz, s.torque[0]!, s.torque[1]!, s.torque[2]!, wake)
        // Dynamic ground under a wheel takes the opposite impulse.
        for (let i = 0; i < sim.wheels.length; i++) {
          const wh = sim.wheels[i]!
          if (!wh.grounded || !wh.groundDynamic) continue
          p.applyImpulseAtPoint(wh.groundBody, -wh.ix, -wh.iy, -wh.iz, wh.px, wh.py, wh.pz)
        }
        writeState(world, sim)
        sendEvents(world, sim)
      }
    }
    sims.active = active
    sims.stepMs = performance.now() - start
    sims.steps++
  },
})

// --- wheel visuals -----------------------------------------------------------------

interface VisualBind {
  /** Rest translation and rotation (the visual's own local Transform). */
  t: Float64Array
  r: Float64Array
  /** Chassis frame → the visual's parent frame: linear map (row-major 3×3) and its rotation. */
  m: Float64Array
  q: Float64Array
  /** The wheel's hub at ride height in the parent frame: the visual turns about it. */
  c: Float64Array
}

const binds = new WeakMap<WheelSim, VisualBind>()

/** A descendant of `root` whose generated path (a model node) ends with `name`. */
function findNamed(world: World, root: Entity, name: string): Entity | undefined {
  const stack = [root]
  while (stack.length > 0) {
    const e = stack.pop()!
    if (e !== root) {
      const part = world.tryGet(e, InstancePart)
      if (part && (part.path === name || part.path.endsWith(`/${name}`))) return e
    }
    for (const k of world.tryGet(e, Children)?.entities ?? []) if (k !== null) stack.push(k)
  }
  return undefined
}

function bindVisual(world: World, chassis: Entity, wh: WheelSim): VisualBind | undefined {
  if (wh.visual < 0 && wh.visualName) {
    const found = findNamed(world, chassis, wh.visualName)
    if (found === undefined) return undefined
    wh.visual = found
  }
  const visual = wh.visual
  if (visual < 0 || !world.isAlive(visual) || !world.has(visual, Transform)) return undefined
  const parent = world.tryGet(visual, ChildOf)?.parent
  const tr = world.get(visual, Transform)
  const bind: VisualBind = {
    t: new Float64Array(tr.translation),
    r: new Float64Array(tr.rotation),
    m: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    q: new Float64Array([0, 0, 0, 1]),
    c: new Float64Array([wh.hx, wh.hy, wh.hz]),
  }
  if (
    parent !== undefined &&
    parent !== null &&
    parent !== chassis &&
    world.has(parent, GlobalTransform)
  ) {
    // m = inverse(parent global) · chassis global (linear parts); the hub through the full map.
    const pg = world.get(parent, GlobalTransform).matrix
    const cg = world.get(chassis, GlobalTransform).matrix
    const pm = inverse3(pg)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let sum = 0
        for (let k = 0; k < 3; k++) sum += pm[i * 3 + k]! * cg[k * 4 + j]!
        bind.m[i * 3 + j] = sum
      }
    quatFromMatrix(bind.m, bind.q)
    // Hub in world, then into the parent frame.
    const wx = cg[0]! * wh.hx + cg[1]! * wh.hy + cg[2]! * wh.hz + cg[3]!
    const wy = cg[4]! * wh.hx + cg[5]! * wh.hy + cg[6]! * wh.hz + cg[7]!
    const wz = cg[8]! * wh.hx + cg[9]! * wh.hy + cg[10]! * wh.hz + cg[11]!
    const dx = wx - pg[3]!
    const dy = wy - pg[7]!
    const dz = wz - pg[11]!
    bind.c[0] = pm[0]! * dx + pm[1]! * dy + pm[2]! * dz
    bind.c[1] = pm[3]! * dx + pm[4]! * dy + pm[5]! * dz
    bind.c[2] = pm[6]! * dx + pm[7]! * dy + pm[8]! * dz
  }
  return bind
}

/** Inverse of an affine3x4's linear part, row-major 3×3. */
function inverse3(a: ArrayLike<number>): Float64Array {
  const a00 = a[0]!
  const a01 = a[1]!
  const a02 = a[2]!
  const a10 = a[4]!
  const a11 = a[5]!
  const a12 = a[6]!
  const a20 = a[8]!
  const a21 = a[9]!
  const a22 = a[10]!
  const c00 = a11 * a22 - a12 * a21
  const c01 = a02 * a21 - a01 * a22
  const c02 = a01 * a12 - a02 * a11
  const det = a00 * c00 + a10 * c01 + a20 * c02 || 1
  return new Float64Array([
    c00 / det,
    c01 / det,
    c02 / det,
    (a12 * a20 - a10 * a22) / det,
    (a00 * a22 - a02 * a20) / det,
    (a02 * a10 - a00 * a12) / det,
    (a10 * a21 - a11 * a20) / det,
    (a01 * a20 - a00 * a21) / det,
    (a00 * a11 - a01 * a10) / det,
  ])
}

/** The rotation of a 3×3 linear map with its scale removed. */
function quatFromMatrix(m: Float64Array, out: Float64Array): void {
  const c = new Float64Array(9)
  for (let j = 0; j < 3; j++) {
    const l = Math.sqrt(m[j]! ** 2 + m[3 + j]! ** 2 + m[6 + j]! ** 2) || 1
    c[j] = m[j]! / l
    c[3 + j] = m[3 + j]! / l
    c[6 + j] = m[6 + j]! / l
  }
  const tr = c[0]! + c[4]! + c[8]!
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    out[3] = 0.25 * s
    out[0] = (c[7]! - c[5]!) / s
    out[1] = (c[2]! - c[6]!) / s
    out[2] = (c[3]! - c[1]!) / s
  } else if (c[0]! > c[4]! && c[0]! > c[8]!) {
    const s = Math.sqrt(1 + c[0]! - c[4]! - c[8]!) * 2
    out[3] = (c[7]! - c[5]!) / s
    out[0] = 0.25 * s
    out[1] = (c[1]! + c[3]!) / s
    out[2] = (c[2]! + c[6]!) / s
  } else if (c[4]! > c[8]!) {
    const s = Math.sqrt(1 + c[4]! - c[0]! - c[8]!) * 2
    out[3] = (c[2]! - c[6]!) / s
    out[0] = (c[1]! + c[3]!) / s
    out[1] = 0.25 * s
    out[2] = (c[5]! + c[7]!) / s
  } else {
    const s = Math.sqrt(1 + c[8]! - c[0]! - c[4]!) * 2
    out[3] = (c[3]! - c[1]!) / s
    out[0] = (c[2]! + c[6]!) / s
    out[1] = (c[5]! + c[7]!) / s
    out[2] = 0.25 * s
  }
}

function mulQ(
  ax: number,
  ay: number,
  az: number,
  aw: number,
  b: Float64Array,
  out: Float64Array,
): void {
  const bx = b[0]!
  const by = b[1]!
  const bz = b[2]!
  const bw = b[3]!
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
}

const qa = new Float64Array(4)
const qb = new Float64Array(4)

/**
 * Wheel visuals (0118): each wheel's `visual` follows its suspension, steers and spins,
 * interpolated between physics steps by FixedTime.alpha. PostUpdate, before transforms propagate.
 */
export const wheelVisualSystem = defineSystem({
  name: 'vehicle/wheels',
  description: 'Moves wheel visuals with suspension, steering and spin.',
  run: (_, world) => {
    const sims = world.tryResource(VehicleSimsResource)
    if (!sims || sims.sims.size === 0) return
    const alpha = world.resource(FixedTime).alpha
    for (const sim of sims.sims.values()) {
      if (!sim.ok) continue
      for (let i = 0; i < sim.wheels.length; i++) {
        const wh = sim.wheels[i]!
        if (wh.visual < 0) continue
        let bind = binds.get(wh)
        if (!bind) {
          bind = bindVisual(world, sim.entity, wh)
          if (!bind) continue
          binds.set(wh, bind)
        }
        if (!world.isAlive(wh.visual)) continue
        const x = wh.prevX + (wh.x - wh.prevX) * alpha
        const angle = wh.prevAngle + (wh.angle - wh.prevAngle) * alpha
        const steer = wh.prevSteer + (wh.steer - wh.prevSteer) * alpha
        // Chassis-frame rotation: steer about Y · camber about Z · spin about X (rolling forward
        // is a negative turn about +X).
        const camber = wh.side === SIDE_RIGHT ? -wh.camber : wh.camber
        const hs = steer / 2
        const hc = camber / 2
        const hp = -angle / 2
        // q = Ry(steer) · Rz(camber) · Rx(−angle)
        qa[0] = 0
        qa[1] = 0
        qa[2] = Math.sin(hc)
        qa[3] = Math.cos(hc)
        // Ry · Rz
        mulQ(0, Math.sin(hs), 0, Math.cos(hs), qa, qb)
        // (Ry Rz) · Rx
        qa[0] = Math.sin(hp)
        qa[1] = 0
        qa[2] = 0
        qa[3] = Math.cos(hp)
        mulQ(qb[0]!, qb[1]!, qb[2]!, qb[3]!, qa, qb)
        // Into the parent frame: Q · R · Q⁻¹ · rest.
        const q = bind.q
        mulQ(q[0]!, q[1]!, q[2]!, q[3]!, qb, qa)
        qb[0] = -q[0]!
        qb[1] = -q[1]!
        qb[2] = -q[2]!
        qb[3] = q[3]!
        mulQ(qa[0]!, qa[1]!, qa[2]!, qa[3]!, qb, qa)
        mulQ(qa[0]!, qa[1]!, qa[2]!, qa[3]!, bind.r, qb)
        const t = world.entityTable(wh.visual)
        const r = world.entityRow(wh.visual)
        const tr = t.column(Transform, 'translation')
        const rt = t.column(Transform, 'rotation')
        const m = bind.m
        // The hub moves with the suspension; the visual turns about it, wherever its own origin
        // is (models often keep wheel nodes at the model's origin with the vertices offset).
        const cx = bind.c[0]! + m[1]! * x
        const cy = bind.c[1]! + m[4]! * x
        const cz = bind.c[2]! + m[7]! * x
        // R = Q · Rc · Q⁻¹ is qa here (before the rest is applied): rotate (rest − hub).
        const ox = bind.t[0]! - bind.c[0]!
        const oy = bind.t[1]! - bind.c[1]!
        const oz = bind.t[2]! - bind.c[2]!
        const ax = qa[0]!
        const ay = qa[1]!
        const az = qa[2]!
        const aw = qa[3]!
        const tx = 2 * (ay * oz - az * oy)
        const ty = 2 * (az * ox - ax * oz)
        const tz = 2 * (ax * oy - ay * ox)
        tr[r * 3] = cx + ox + aw * tx + (ay * tz - az * ty)
        tr[r * 3 + 1] = cy + oy + aw * ty + (az * tx - ax * tz)
        tr[r * 3 + 2] = cz + oz + aw * tz + (ax * ty - ay * tx)
        rt[r * 4] = qb[0]!
        rt[r * 4 + 1] = qb[1]!
        rt[r * 4 + 2] = qb[2]!
        rt[r * 4 + 3] = qb[3]!
        t.markChanged(Transform, r)
      }
    }
  },
})

/**
 * Wheeled vehicles (0118): the Vehicle components, Tire assets and presets, the vehicle step
 * (after the character controller, before the Rapier step) and wheel visuals. Needs physics3d.
 */
export function vehiclePlugin(): Plugin {
  return definePlugin({
    name: 'vehicle',
    provides: [componentsModule, tireModule, vehicleOverlay],
    dependencies: ['core/transform', 'physics3d'],
    build(app) {
      const w = app.world
      w.initResource(VehicleSimsResource)
      w.initResource(VehicleConfig)
      const mark = ({ entity, world }: { entity: Entity; world: World }) => {
        const sims = world.resource(VehicleSimsResource)
        // A wheel added or removed: its chassis rebuilds.
        let node: Entity | undefined = entity
        while (node !== undefined) {
          if (world.has(node, Vehicle)) {
            sims.dirty.add(node)
            return
          }
          node = world.tryGet(node, ChildOf)?.parent ?? undefined
        }
      }
      w.observe(onAdd(VehicleWheel), mark)
      w.observe(onRemove(VehicleWheel), mark)
      w.observe(onRemove(Vehicle), ({ entity, world }) => {
        const sims = world.resource(VehicleSimsResource)
        sims.sims.delete(entity)
        sims.dirty.delete(entity)
      })
      app.addSystems(FixedUpdate, vehicleSystem.after(characterSystem).before(physicsStep))
      app.addSystems(PostUpdate, wheelVisualSystem.before(TransformSystems))
      app.addMethod(...vehicleMethods)
    },
    ready(app) {
      registerTirePresets(app.world)
    },
  })
}
