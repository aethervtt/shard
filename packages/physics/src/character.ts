import { defineSystem, type Entity, type Table, type World } from '@aethervtt/shard-core'
import { FixedTime } from '@aethervtt/shard-runtime'
import { GlobalTransform, GridFramesResource, Transform } from '@aethervtt/shard-transform'
import type RAPIER from '@dimforge/rapier3d-compat'
import {
  CharacterController,
  CharacterGroundEvent,
  CharacterIntent,
  CharacterState,
  GravitySource,
} from './components'
import { createGravitySources, gatherGravitySources, sampleGravity } from './gravity'
import { createPose, parentOf, poseOf, rotate, worldToLocal } from './pose'
import { CHARACTER_OFFSET, type CharacterRecord, Physics, type PhysicsWorld } from './world'

const KIND_KINEMATIC_POSITION = 2
const KIND_KINEMATIC_VELOCITY = 3

/** The parts of Rapier's controller called directly, to skip the wrapper's per-call allocations. */
interface RawController {
  setUp(v: unknown): void
  computeColliderMovement(
    dt: number,
    broadPhase: unknown,
    narrowPhase: unknown,
    bodies: unknown,
    colliders: unknown,
    collider: number,
    desired: unknown,
    applyImpulses: boolean,
    mass: number | undefined,
    flags: number,
    groups: number,
    predicate: undefined,
  ): void
}

type Vec = { x: number; y: number; z: number }
type Rot = { x: number; y: number; z: number; w: number }

/** Columns of one table, looked up once per table. */
interface Columns {
  radius: Float32Array
  up: Uint8Array
  fixedUp: Float32Array
  gravity: Float32Array
  jumpSpeed: Float32Array
  airControl: Float32Array
  pushForce: Float32Array
  layers: Uint16Array
  mask: Uint16Array
  align: Uint8Array
  move: Float32Array
  jump: Uint8Array
  grounded: Uint8Array
  groundNormal: Float32Array
  groundEntity: Float64Array
  velocity: Float32Array
  stateUp: Float32Array
  airTime: Float32Array
  translation: Float32Array
  rotation: Float32Array
}

function columns(table: Table, out: Columns): void {
  out.radius = table.column(CharacterController, 'radius')
  out.up = table.column(CharacterController, 'up')
  out.fixedUp = table.column(CharacterController, 'fixedUp')
  out.gravity = table.column(CharacterController, 'gravity')
  out.jumpSpeed = table.column(CharacterController, 'jumpSpeed')
  out.airControl = table.column(CharacterController, 'airControl')
  out.pushForce = table.column(CharacterController, 'pushForce')
  out.layers = table.column(CharacterController, 'layers')
  out.mask = table.column(CharacterController, 'mask')
  out.align = table.column(CharacterController, 'alignRotation')
  out.move = table.column(CharacterIntent, 'move')
  out.jump = table.column(CharacterIntent, 'jump')
  out.grounded = table.column(CharacterState, 'grounded')
  out.groundNormal = table.column(CharacterState, 'groundNormal')
  out.groundEntity = table.column(CharacterState, 'groundEntity')
  out.velocity = table.column(CharacterState, 'velocity')
  out.stateUp = table.column(CharacterState, 'up')
  out.airTime = table.column(CharacterState, 'airTime')
  out.translation = table.column(Transform, 'translation')
  out.rotation = table.column(Transform, 'rotation')
}

const vec = (): Vec => ({ x: 0, y: 0, z: 0 })
const rot = (): Rot => ({ x: 0, y: 0, z: 0, w: 1 })

/**
 * Moves every character by its intent (spec 0029): up from gravity, velocity from intent, gravity,
 * and jumps, Rapier's controller for the move, then state, ground events, pushes, and platforms.
 */
export const characterSystem = defineSystem({
  name: 'physics/character',
  description:
    'Moves CharacterController entities by their CharacterIntent: up and rotation from gravity, walking, jumping, stepping, sliding, pushing bodies, riding platforms. Writes CharacterState.',
  setup: (world) => ({
    controllers: world.query({ with: [CharacterController] }),
    query: world.query({ with: [CharacterController, CharacterIntent, CharacterState, Transform] }),
    sources: world.query({ with: [GravitySource, GlobalTransform] }),
    gravity: createGravitySources(),
    cols: {} as Columns,
    pose: createPose(),
    g: new Float64Array(4),
    tmp: new Float64Array(3),
    q: new Float64Array(4),
    arc: new Float64Array(4),
    pos: new Float64Array(3),
    carry: new Float64Array(3),
    ray: undefined as InstanceType<PhysicsWorld['R']['Ray']> | undefined,
    hit: undefined as InstanceType<PhysicsWorld['R']['CharacterCollision']> | undefined,
    t1: vec(),
    t2: vec(),
    r1: rot(),
    r2: rot(),
    moved: vec(),
    rootIdentity: true,
  }),
  run: (s, world, ctx) => {
    const p = world.tryResource(Physics)
    if (!p) return
    const since = ctx.lastRunTick
    for (let t = 0; t < s.controllers.tables.length; t++) {
      const table = s.controllers.tables[t]!
      if (table.lastChanged(CharacterController) <= since) continue
      const ticks = table.changedTicks(CharacterController)
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! > since) p.createCharacter(world, table.entities[row]!)
      }
    }
    if (p.characters.size === 0 || p.config.paused) return
    const dt = world.resource(FixedTime).step
    p.raw.timestep = dt
    gatherGravitySources(s.sources, s.gravity)
    s.hit ??= new p.R.CharacterCollision()
    s.rootIdentity = world.tryResource(GridFramesResource)?.rootIdentity !== false
    for (let t = 0; t < s.query.tables.length; t++) {
      const table = s.query.tables[t]!
      columns(table, s.cols)
      for (let row = 0; row < table.count; row++) {
        const record = p.characters.get(table.entities[row]!)
        if (record && !record.body.parked) stepCharacter(s, world, p, table, row, record, dt)
      }
      table.markChanged(CharacterState)
      table.markChanged(Transform)
    }
  },
})

type State = ReturnType<NonNullable<typeof characterSystem.setup>>

function stepCharacter(
  s: State,
  world: World,
  p: PhysicsWorld,
  table: Table,
  row: number,
  record: CharacterRecord,
  dt: number,
): void {
  const c = s.cols
  const dim = p.dim
  const entity = record.entity
  const body = record.body.body
  const o3 = row * 3

  // The Transform is the truth: a game writing it teleports the character.
  const pose = poseOf(world, entity, s.pose)
  const bt = body.translation(s.t1 as RAPIER.Vector)
  const ex = bt.x - pose[0]!
  const ey = bt.y - pose[1]!
  const ez = dim === 3 ? bt.z - pose[2]! : 0
  const tol = 1e-4 + 1e-6 * (Math.abs(pose[0]!) + Math.abs(pose[1]!) + Math.abs(pose[2]!))
  if (ex * ex + ey * ey + ez * ez > tol * tol) {
    body.setTranslation(p.vec(pose[0]!, pose[1]!, pose[2]!), true)
    body.setRotation(p.rotation(pose, 3), true)
    p.raw.propagateModifiedBodyPositionsToColliders()
  }
  const px = pose[0]!
  const py = pose[1]!
  const pz = pose[2]!

  // 1. Up, and the gravity acceleration (ax, ay, az).
  let ux: number
  let uy: number
  let uz: number
  let ax = 0
  let ay = 0
  let az = 0
  if (c.up[row] === 0) {
    ux = c.fixedUp[o3]!
    uy = c.fixedUp[o3 + 1]!
    uz = dim === 3 ? c.fixedUp[o3 + 2]! : 0
    const len = Math.sqrt(ux * ux + uy * uy + uz * uz)
    if (len < 1e-9) {
      ux = 0
      uy = 1
      uz = 0
    } else {
      ux /= len
      uy /= len
      uz /= len
    }
    const g = c.gravity[row]!
    ax = -ux * g
    ay = -uy * g
    az = -uz * g
  } else {
    const g = s.g
    sampleGravity(s.gravity, dim, px, py, pz, true, g)
    if (g[3]! < 1e-9) {
      const cg = p.config.gravity
      g[0] = cg[0]
      g[1] = cg[1]
      g[2] = dim === 3 ? cg[2] : 0
      g[3] = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2])
    }
    if (g[3]! > 1e-9) {
      ax = g[0]!
      ay = g[1]!
      az = g[2]!
      ux = -ax / g[3]!
      uy = -ay / g[3]!
      uz = -az / g[3]!
    } else {
      // Weightless: keep the last up.
      ux = c.stateUp[o3]!
      uy = c.stateUp[o3 + 1]!
      uz = dim === 3 ? c.stateUp[o3 + 2]! : 0
      const len = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1
      ux /= len
      uy /= len
      uz /= len
    }
  }

  // The smallest turn that maps the entity's +Y to up keeps its heading.
  const q = s.q
  q[0] = pose[3]!
  q[1] = pose[4]!
  q[2] = pose[5]!
  q[3] = pose[6]!
  if (c.align[row] === 1) alignUp(q, ux, uy, uz, s.arc, s.tmp)

  // 2. Velocity. The intent, in the character's frame, flattened onto the plane under up.
  const mx = c.move[o3]!
  const mz = dim === 3 ? c.move[o3 + 2]! : 0
  rotate(s.tmp, 0, q, 0, mx, 0, mz)
  let hx = s.tmp[0]!
  let hy = s.tmp[1]!
  let hz = dim === 3 ? s.tmp[2]! : 0
  const hu = hx * ux + hy * uy + hz * uz
  hx -= ux * hu
  hy -= uy * hu
  hz -= uz * hu
  const speed = Math.sqrt(mx * mx + mz * mz)
  const hl = Math.sqrt(hx * hx + hy * hy + hz * hz)
  if (hl > 1e-9) {
    hx *= speed / hl
    hy *= speed / hl
    hz *= speed / hl
  } else {
    hx = hy = hz = 0
  }

  const wasGrounded = c.grounded[row] === 1
  let vx: number
  let vy: number
  let vz: number
  let jumped = false
  if (wasGrounded) {
    // Downhill, along the ground: the same horizontal speed, falling with the slope, so it stays
    // on it. Uphill stays level and Rapier climbs: a step's rounded edge reads as a slope, and
    // rising with it would launch the character off every step it walks up.
    const nx = c.groundNormal[o3]!
    const ny = c.groundNormal[o3 + 1]!
    const nz = c.groundNormal[o3 + 2]!
    const nu = nx * ux + ny * uy + nz * uz
    const k = nu > 1e-3 ? Math.max(0, hx * nx + hy * ny + hz * nz) / nu : 0
    vx = hx - ux * k
    vy = hy - uy * k
    vz = hz - uz * k
    if (c.jump[row] === 1) {
      const j = c.jumpSpeed[row]!
      vx += ux * j
      vy += uy * j
      vz += uz * j
      jumped = true
      c.jump[row] = 0
      table.markChanged(CharacterIntent, row)
    }
  } else {
    vx = c.velocity[o3]!
    vy = c.velocity[o3 + 1]!
    vz = dim === 3 ? c.velocity[o3 + 2]! : 0
    const vu = vx * ux + vy * uy + vz * uz
    let wx = vx - ux * vu
    let wy = vy - uy * vu
    let wz = vz - uz * vu
    const air = c.airControl[row]!
    const blend = air >= 1 ? 1 : 1 - (1 - air) ** (dt * 60)
    wx += (hx - wx) * blend
    wy += (hy - wy) * blend
    wz += (hz - wz) * blend
    vx = wx + ux * vu
    vy = wy + uy * vu
    vz = wz + uz * vu
  }

  // Standing on a kinematic body: carried by its motion over this step.
  const carry = s.carry
  carry[0] = carry[1] = carry[2] = 0
  if (wasGrounded) platformCarry(s, p, c.groundEntity[row]!, px, py, pz, dt, carry)

  // 3. Move: velocity-Verlet, exact under constant gravity (jump heights come out right). On the
  // ground there's no push into it: snapping holds the character down, and a push would make
  // Rapier drag it along moving ground by friction, a step late, on top of the carry.
  const half = wasGrounded && !jumped ? 0 : 0.5 * dt * dt
  const dx = vx * dt + ax * half + carry[0]!
  const dy = vy * dt + ay * half + carry[1]!
  const dz = vz * dt + az * half + carry[2]!
  const rising = jumped || (!wasGrounded && vx * ux + vy * uy + vz * uz > 0)
  if (record.snapDistance > 0 && record.snapping === rising) {
    record.snapping = !rising
    if (rising) record.kcc.disableSnapToGround()
    else record.kcc.enableSnapToGround(record.snapDistance)
  }
  const kcc = record.kcc as unknown as { raw: RawController }
  const rv = p.rawVec as Vec
  rv.x = ux
  rv.y = uy
  if (dim === 3) rv.z = uz
  kcc.raw.setUp(rv)
  rv.x = dx
  rv.y = dy
  if (dim === 3) rv.z = dz
  const raw = p.raw as unknown as {
    broadPhase: { raw: unknown }
    narrowPhase: { raw: unknown }
    bodies: { raw: unknown }
    colliders: { raw: unknown }
  }
  kcc.raw.computeColliderMovement(
    dt,
    raw.broadPhase.raw,
    raw.narrowPhase.raw,
    raw.bodies.raw,
    raw.colliders.raw,
    record.collider.handle,
    rv,
    false,
    undefined,
    p.R.QueryFilterFlags.EXCLUDE_SENSORS,
    ((c.layers[row]! & 0xffff) << 16) | (c.mask[row]! & 0xffff),
    undefined,
  )
  const mv = record.kcc.computedMovement(s.moved as RAPIER.Vector)
  const mvx = mv.x
  const mvy = mv.y
  const mvz = dim === 3 ? mv.z : 0
  const grounded = record.kcc.computedGrounded()
  const pos = s.pos
  pos[0] = Math.fround(px + mvx)
  pos[1] = Math.fround(py + mvy)
  pos[2] = Math.fround(pz + mvz)
  const groups = ((c.layers[row]! & 0xffff) << 16) | (c.mask[row]! & 0xffff)

  // 4. State: the walkable ground touched, and what the move ran into.
  let groundDot = -2
  let gnx = ux
  let gny = uy
  let gnz = uz
  let groundEntity = -1
  const hit = s.hit!
  const push = c.pushForce[row]! * dt
  const n = record.kcc.numComputedCollisions()
  for (let i = 0; i < n; i++) {
    if (!record.kcc.computedCollision(i, hit)) continue
    const normal = hit.normal1
    const nx = normal.x
    const ny = normal.y
    const nz = dim === 3 ? normal.z : 0
    const nd = nx * ux + ny * uy + nz * uz
    const collider = hit.collider
    if (nd >= record.cosMaxSlope - 1e-3) {
      if (nd > groundDot && collider) {
        groundDot = nd
        gnx = nx
        gny = ny
        gnz = nz
        const e = p.colliderEntity.get(collider.handle)
        groundEntity = e === undefined ? -1 : (p.colliderOwner.get(e) ?? e)
      }
    } else if (collider && push > 0 && speed > 1e-6) {
      pushBody(s, p, collider, hx / speed, hy / speed, hz / speed, speed, push)
    }
    if (!grounded) {
      // Airborne: lose the velocity going into what was hit (a wall, a ceiling).
      const d = vx * nx + vy * ny + vz * nz
      if (d < 0) {
        vx -= nx * d
        vy -= ny * d
        vz -= nz * d
      }
    }
  }
  if (grounded && groundEntity === -1) {
    // Held down by snapping without touching anything on the way: look straight down.
    const g = s.g
    if (probeGround(s, p, record, pos, ux, uy, uz, groups, g)) {
      gnx = g[0]!
      gny = g[1]!
      gnz = g[2]!
      groundEntity = g[3]!
    } else if (wasGrounded) {
      // Over an edge, the capsule's rim still on it: keep the last ground.
      gnx = c.groundNormal[o3]!
      gny = c.groundNormal[o3 + 1]!
      gnz = c.groundNormal[o3 + 2]!
      groundEntity = c.groundEntity[row]!
    }
  }

  if (grounded) {
    // On the ground: keep only the velocity along it (landing stops the fall).
    const d = vx * gnx + vy * gny + vz * gnz
    vx -= gnx * d
    vy -= gny * d
    vz -= gnz * d
  } else {
    vx += ax * dt
    vy += ay * dt
    vz += az * dt
  }

  // Write the pose: the kinematic body's target for this step, and the Transform.
  body.setNextKinematicTranslation(p.vec(pos[0]!, pos[1]!, pos[2]!))
  body.setNextKinematicRotation(p.rotation(q, 0))
  const parent = parentOf(world, entity)
  if (parent === undefined && s.rootIdentity) {
    c.translation[o3] = pos[0]!
    c.translation[o3 + 1] = pos[1]!
    c.translation[o3 + 2] = pos[2]!
    c.rotation[row * 4] = q[0]!
    c.rotation[row * 4 + 1] = q[1]!
    c.rotation[row * 4 + 2] = q[2]!
    c.rotation[row * 4 + 3] = q[3]!
  } else {
    worldToLocal(world, parent, entity, pos, q, c.translation, o3, c.rotation, row * 4)
  }

  c.grounded[row] = grounded ? 1 : 0
  c.groundNormal[o3] = gnx
  c.groundNormal[o3 + 1] = gny
  c.groundNormal[o3 + 2] = gnz
  c.groundEntity[row] = grounded ? groundEntity : -1
  c.velocity[o3] = vx
  c.velocity[o3 + 1] = vy
  c.velocity[o3 + 2] = vz
  c.stateUp[o3] = ux
  c.stateUp[o3 + 1] = uy
  c.stateUp[o3 + 2] = uz
  c.airTime[row] = grounded ? 0 : c.airTime[row]! + dt
  if (grounded !== wasGrounded) world.send(CharacterGroundEvent, { entity, grounded })
}

/** Turns q (in place) by the shortest arc taking its +Y to (ux, uy, uz). */
function alignUp(
  q: Float64Array,
  ux: number,
  uy: number,
  uz: number,
  arc: Float64Array,
  tmp: Float64Array,
): void {
  rotate(tmp, 0, q, 0, 0, 1, 0)
  const yx = tmp[0]!
  const yy = tmp[1]!
  const yz = tmp[2]!
  const d = yx * ux + yy * uy + yz * uz
  if (d > 1 - 1e-12) return
  if (d < -1 + 1e-9) {
    // Upside down: half a turn around the entity's own X.
    rotate(tmp, 0, q, 0, 1, 0, 0)
    arc[0] = tmp[0]!
    arc[1] = tmp[1]!
    arc[2] = tmp[2]!
    arc[3] = 0
  } else {
    arc[0] = yy * uz - yz * uy
    arc[1] = yz * ux - yx * uz
    arc[2] = yx * uy - yy * ux
    arc[3] = 1 + d
    const len = Math.sqrt(arc[0] ** 2 + arc[1] ** 2 + arc[2] ** 2 + arc[3] ** 2)
    arc[0] /= len
    arc[1] /= len
    arc[2] /= len
    arc[3] /= len
  }
  const bx = q[0]!
  const by = q[1]!
  const bz = q[2]!
  const bw = q[3]!
  const ax = arc[0]!
  const ay = arc[1]!
  const az = arc[2]!
  const aw = arc[3]!
  let x = aw * bx + ax * bw + ay * bz - az * by
  let y = aw * by - ax * bz + ay * bw + az * bx
  let z = aw * bz + ax * by - ay * bx + az * bw
  let w = aw * bw - ax * bx - ay * by - az * bz
  const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1
  x /= len
  y /= len
  z /= len
  w /= len
  q[0] = x
  q[1] = y
  q[2] = z
  q[3] = w
}

/**
 * A ray from the capsule's center down along -up to just past snapping reach: the walkable ground
 * under it, as normal (out[0..2]) and body or collider entity (out[3]).
 */
function probeGround(
  s: State,
  p: PhysicsWorld,
  record: CharacterRecord,
  pos: Float64Array,
  ux: number,
  uy: number,
  uz: number,
  groups: number,
  out: Float64Array,
): boolean {
  s.ray ??= new p.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
  const ray = s.ray
  const o = ray.origin as Vec
  const d = ray.dir as Vec
  o.x = pos[0]!
  o.y = pos[1]!
  d.x = -ux
  d.y = -uy
  if (p.dim === 3) {
    o.z = pos[2]!
    d.z = -uz
  }
  const reach = record.bottom + CHARACTER_OFFSET + record.snapDistance + 0.05
  const hit = p.raw.castRayAndGetNormal(
    ray,
    reach,
    true,
    p.R.QueryFilterFlags.EXCLUDE_SENSORS,
    groups,
    undefined,
    record.body.body,
  )
  if (!hit) return false
  const n = hit.normal as Vec
  const nz = p.dim === 3 ? n.z : 0
  if (n.x * ux + n.y * uy + nz * uz < record.cosMaxSlope - 1e-3) return false
  out[0] = n.x
  out[1] = n.y
  out[2] = nz
  const e = p.colliderEntity.get(hit.collider.handle)
  out[3] = e === undefined ? -1 : (p.colliderOwner.get(e) ?? e)
  return true
}

/** How far a kinematic ground body moves the point (px, py, pz) over this step, into out. */
function platformCarry(
  s: State,
  p: PhysicsWorld,
  ground: number,
  px: number,
  py: number,
  pz: number,
  dt: number,
  out: Float64Array,
): void {
  if (ground < 0) return
  const record = p.bodies.get(ground as Entity)
  if (!record || p.characters.has(record.entity)) return
  const body = record.body
  const t = body.translation(s.t1 as RAPIER.Vector)
  const rx = px - t.x
  const ry = py - t.y
  const rz = p.dim === 3 ? pz - t.z : 0
  if (record.kind === KIND_KINEMATIC_POSITION) {
    // Where the point goes as the body reaches its target: next + nextRot · conj(rot) · (p - pos).
    const nt = body.nextTranslation(s.t2 as RAPIER.Vector)
    if (p.dim === 3) {
      const r = body.rotation(s.r1 as RAPIER.Rotation)
      const nr = body.nextRotation(s.r2 as RAPIER.Rotation)
      const tmp = s.tmp
      const q = s.arc
      q[0] = -r.x
      q[1] = -r.y
      q[2] = -r.z
      q[3] = r.w
      rotate(tmp, 0, q, 0, rx, ry, rz)
      q[0] = nr.x
      q[1] = nr.y
      q[2] = nr.z
      q[3] = nr.w
      rotate(tmp, 0, q, 0, tmp[0]!, tmp[1]!, tmp[2]!)
      out[0] = nt.x + tmp[0]! - px
      out[1] = nt.y + tmp[1]! - py
      out[2] = nt.z + tmp[2]! - pz
    } else {
      const a = (body.nextRotation() as unknown as number) - (body.rotation() as unknown as number)
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      out[0] = nt.x + rx * cos - ry * sin - px
      out[1] = nt.y + rx * sin + ry * cos - py
    }
  } else if (record.kind === KIND_KINEMATIC_VELOCITY) {
    const lv = body.linvel(s.t2 as RAPIER.Vector)
    if (p.dim === 3) {
      const av = body.angvel(s.r1 as unknown as RAPIER.Vector)
      out[0] = (lv.x + av.y * rz - av.z * ry) * dt
      out[1] = (lv.y + av.z * rx - av.x * rz) * dt
      out[2] = (lv.z + av.x * ry - av.y * rx) * dt
    } else {
      const w = body.angvel() as unknown as number
      out[0] = (lv.x - w * ry) * dt
      out[1] = (lv.y + w * rx) * dt
    }
  }
}

/** Pushes a dynamic body along (dx, dy, dz), by at most `impulse` and never past `speed`. */
function pushBody(
  s: State,
  p: PhysicsWorld,
  collider: InstanceType<PhysicsWorld['R']['Collider']>,
  dx: number,
  dy: number,
  dz: number,
  speed: number,
  impulse: number,
): void {
  const body = collider.parent()
  if (!body?.isDynamic()) return
  const v = body.linvel(s.t2 as RAPIER.Vector)
  const along = v.x * dx + v.y * dy + (p.dim === 3 ? v.z * dz : 0)
  const dv = speed - along
  if (dv <= 0) return
  const j = Math.min(impulse, body.mass() * dv)
  body.applyImpulse(p.vec(dx * j, dy * j, dz * j), true)
}
