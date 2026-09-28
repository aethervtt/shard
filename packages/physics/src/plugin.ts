import {
  ChildOf,
  defineSystem,
  defineSystemSet,
  type Entity,
  FixedUpdate,
  onAdd,
  onRemove,
  onSet,
  PostUpdate,
  ShardError,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { type App, FixedTime, FrameDemand, type Plugin } from '@aethervtt/shard-runtime'
import {
  GlobalTransform,
  GridCell,
  GridFramesResource,
  OriginShift,
  Transform,
  TransformSystems,
} from '@aethervtt/shard-transform'
import { characterSystem } from './character'
import * as componentsModule from './components'
import {
  CharacterController,
  Collider,
  CollisionEvent,
  ContactForceEvent,
  ExternalForce,
  ExternalImpulse,
  GravitySource,
  Joint,
  PhysicsConfig,
  PhysicsRange,
  RigidBody,
  Velocity,
} from './components'
import { createGravitySources, gatherGravitySources, sampleGravity } from './gravity'
import { physicsMethods } from './methods'
import * as pluginModule from './plugin'
import { isGrid, parentOf, worldToLocal } from './pose'
import { loadRapier } from './rapier'
import * as renderModule from './render'
import { rendererMeshes } from './render'
import { type BodyRecord, Physics, PhysicsWorld } from './world'

export { Physics }

/** Physics sync and step run in this set, in FixedUpdate. Move bodies before it. */
export const PhysicsSystems = defineSystemSet('physics/PhysicsSystems')

/** The physics world, or `physics/not-ready` before the plugin's `ready` step. */
export function physics(world: World): PhysicsWorld {
  const p = world.tryResource(Physics)
  if (!p) {
    throw new ShardError('physics/not-ready', 'Physics is not ready', {
      hint: 'Add the physics3d or physics2d plugin and await app.init() before querying.',
    })
  }
  return p
}

const KIND_DYNAMIC = 0
const KIND_FIXED = 1
const KIND_KINEMATIC_POSITION = 2

/** Entities whose parent changed since the last sync; their colliders rebuild. */
const reparented = new WeakMap<World, Set<Entity>>()

// --- sync in -------------------------------------------------------------------

const syncIn = defineSystem({
  name: 'physics/sync-in',
  description:
    'Creates and rebuilds bodies, colliders, and joints from component changes; pushes teleports, velocities, forces, and gravity sources into Rapier.',
  setup: (world) => ({
    bodies: world.query({ with: [RigidBody] }),
    colliders: world.query({ with: [Collider] }),
    joints: world.query({ with: [Joint] }),
    velocities: world.query({ with: [Velocity, RigidBody] }),
    impulses: world.query({ with: [ExternalImpulse] }),
    forces: world.query({ with: [ExternalForce] }),
    sources: world.query({ with: [GravitySource, GlobalTransform] }),
    forcedLast: [] as BodyRecord[],
    forcedNow: [] as BodyRecord[],
    stamp: 0,
    stamps: new Uint32Array(64),
    gravity: createGravitySources(),
    pull: new Float64Array(4),
    gravityVisit: undefined as ((handle: number) => void) | undefined,
  }),
  run: (s, world, ctx) => {
    const p = world.tryResource(Physics)
    if (!p) return
    const since = ctx.lastRunTick
    const moved = reparented.get(world)
    if (moved && moved.size > 0) {
      for (const e of moved) p.reparented(world, e)
      moved.clear()
    }

    // Interpolation left blended poses in Transform; put the simulated ones back first.
    const userTick = Math.max(p.writeTick, p.interpTick)
    if (p.config.interpolate && p.interpTick > p.writeTick) restorePoses(world, p)

    // Grids appeared or went away (spec 0040): the frame Rapier simulates in changed under it.
    const frames = world.tryResource(GridFramesResource)
    const gridsActive = frames?.active === true
    if (gridsActive !== p.gridsActive) {
      p.gridsActive = gridsActive
      p.resync(world)
    }

    // Bodies added or changed rebuild; ones reparented teleport.
    for (let t = 0; t < s.bodies.tables.length; t++) {
      const table = s.bodies.tables[t]!
      if (table.lastChanged(RigidBody) <= since) continue
      const ticks = table.changedTicks(RigidBody)
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! > since) p.createBody(world, table.entities[row]!)
      }
    }
    if (p.dirtyBodies.size > 0) {
      for (const e of p.dirtyBodies) {
        const record = p.bodies.get(e)
        if (record && world.isAlive(e)) p.moveBody(world, record)
      }
      p.dirtyBodies.clear()
    }

    // Colliders: changed ones, ones whose mesh reloaded, and ones waiting for a mesh.
    for (let t = 0; t < s.colliders.tables.length; t++) {
      const table = s.colliders.tables[t]!
      if (table.lastChanged(Collider) <= since) continue
      const ticks = table.changedTicks(Collider)
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! > since) p.dirtyColliders.add(table.entities[row]!)
      }
    }
    if (p.meshColliders.size > 0) {
      for (const [e, m] of p.meshColliders)
        if (m.mesh.version !== m.version) p.dirtyColliders.add(e)
    }
    if (p.pendingMesh.size > 0) for (const e of p.pendingMesh) p.dirtyColliders.add(e)
    if (p.dirtyColliders.size > 0) {
      for (const e of p.dirtyColliders) {
        if (world.isAlive(e) && world.has(e, Collider)) p.createCollider(world, e)
      }
      p.dirtyColliders.clear()
    }

    // Joints, once both bodies exist.
    for (let t = 0; t < s.joints.tables.length; t++) {
      const table = s.joints.tables[t]!
      if (table.lastChanged(Joint) <= since) continue
      const ticks = table.changedTicks(Joint)
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! > since) p.dirtyJoints.add(table.entities[row]!)
      }
    }
    if (p.dirtyJoints.size > 0) {
      for (const e of p.dirtyJoints) {
        if (!world.isAlive(e) || !world.has(e, Joint)) {
          p.dirtyJoints.delete(e)
          continue
        }
        p.createJoint(world, e)
        if (p.joints.has(e)) p.dirtyJoints.delete(e)
      }
    }

    // Transforms written by games: teleports, and targets for kinematic bodies.
    for (let t = 0; t < s.bodies.tables.length; t++) {
      const table = s.bodies.tables[t]!
      const kinematicMoved = table.lastChanged(GlobalTransform) > since
      // A game moving a grid child to another cell is a teleport too.
      const cells =
        table.has(GridCell) && table.lastChanged(GridCell) > userTick
          ? table.changedTicks(GridCell)
          : undefined
      if (table.lastChanged(Transform) <= userTick && !kinematicMoved && cells === undefined) {
        continue
      }
      const ticks = table.changedTicks(Transform)
      const globals = table.changedTicks(GlobalTransform)
      for (let row = 0; row < table.count; row++) {
        const record = p.bodies.get(table.entities[row]!)
        if (!record) continue
        if (ticks[row]! > userTick || (cells !== undefined && cells[row]! > userTick)) {
          p.moveBody(world, record)
        } else if (record.kind === KIND_KINEMATIC_POSITION && globals[row]! > since) {
          p.moveBody(world, record)
        }
      }
    }

    // Velocities written by games.
    for (let t = 0; t < s.velocities.tables.length; t++) {
      const table = s.velocities.tables[t]!
      if (table.lastChanged(Velocity) <= userTick) continue
      const ticks = table.changedTicks(Velocity)
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! <= userTick) continue
        const record = p.bodies.get(table.entities[row]!)
        if (record && record.kind !== KIND_FIXED) p.setVelocity(world, record)
      }
    }

    // Impulses apply once, then zero.
    for (let t = 0; t < s.impulses.tables.length; t++) {
      const table = s.impulses.tables[t]!
      if (table.lastChanged(ExternalImpulse) <= since) continue
      const imp = table.column(ExternalImpulse, 'impulse')
      const tor = table.column(ExternalImpulse, 'torque')
      const ticks = table.changedTicks(ExternalImpulse)
      let wrote = false
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! <= since) continue
        const o = row * 3
        const record = p.bodies.get(table.entities[row]!)
        if (!record || record.kind !== KIND_DYNAMIC) continue
        if (imp[o] || imp[o + 1] || imp[o + 2]) {
          record.body.applyImpulse(p.vec(imp[o]!, imp[o + 1]!, imp[o + 2]!), true)
        }
        if (tor[o] || tor[o + 1] || tor[o + 2]) {
          if (p.dim === 3)
            record.body.applyTorqueImpulse(p.vec(tor[o]!, tor[o + 1]!, tor[o + 2]!), true)
          else
            (
              record.body as unknown as { applyTorqueImpulse(t: number, w: boolean): void }
            ).applyTorqueImpulse(tor[o + 2]!, true)
        }
        imp[o] = imp[o + 1] = imp[o + 2] = 0
        tor[o] = tor[o + 1] = tor[o + 2] = 0
        wrote = true
      }
      if (wrote) table.markChanged(ExternalImpulse)
    }

    applyForces(s, p, since)

    // Far from the origin: out of Rapier until it comes back (spec 0040). Nothing without grids.
    if (gridsActive) p.updateParking(world, world.resource(PhysicsRange).radius)
    else if (p.parkedCount > 0) p.unparkAll(world)
  },
})

const scratchPos = new Float64Array(3)
const scratchRot = new Float64Array(4)

/** Whether the root frame is the origin frame (always, unless the origin is inside a grid). */
function rootIsOrigin(world: World): boolean {
  return world.tryResource(GridFramesResource)?.rootIdentity !== false
}

/**
 * How a body's origin-frame pose goes into its Transform: 0 directly (a root, with the root frame
 * the origin frame), 1 through its grid's frame (a grid child, or a root with the origin in a
 * grid), -1 not at all (parented to an ordinary entity: interpolation leaves it alone).
 */
function writeMode(world: World, entity: Entity, rootIdentity: boolean): number {
  const parent = parentOf(world, entity)
  if (parent === undefined) return rootIdentity ? 0 : 1
  return isGrid(world, parent) ? 1 : -1
}

/** Writes an origin-frame pose (position, rotation) into a Transform through its grid's frame. */
function writeGridPose(
  world: World,
  entity: Entity,
  table: Table,
  row: number,
  pos: Float64Array,
  rot: Float64Array,
  dim: 2 | 3,
): void {
  const tr = table.column(Transform, 'translation')
  const z = tr[row * 3 + 2]!
  worldToLocal(
    world,
    parentOf(world, entity),
    entity,
    pos,
    rot,
    tr,
    row * 3,
    table.column(Transform, 'rotation'),
    row * 4,
  )
  if (dim === 2) tr[row * 3 + 2] = z
  table.markChanged(Transform, row)
}

function restorePoses(world: World, p: PhysicsWorld): void {
  const rootIdentity = rootIsOrigin(world)
  for (let i = 0; i < p.list.length; i++) {
    const r = p.list[i]!
    if (r.kind === KIND_FIXED || r.kind === KIND_KINEMATIC_POSITION || r.parked) continue
    const table = world.entityTableUnchecked(r.entity)
    const row = world.entityRowUnchecked(r.entity)
    // Only poses interpolation wrote (and nobody changed since).
    if (table.changedTicks(Transform)[row] !== p.interpTick) continue
    const mode = writeMode(world, r.entity, rootIdentity)
    if (mode < 0) continue
    if (mode === 0) {
      writePose(table, row, p.curr, r.slot * 7, p.dim)
      continue
    }
    const o = r.slot * 7
    for (let k = 0; k < 3; k++) scratchPos[k] = p.curr[o + k]!
    for (let k = 0; k < 4; k++) scratchRot[k] = p.curr[o + 3 + k]!
    writeGridPose(world, r.entity, table, row, scratchPos, scratchRot, p.dim)
  }
}

function writePose(
  table: import('@aethervtt/shard-core').Table,
  row: number,
  pose: ArrayLike<number>,
  o: number,
  dim: 2 | 3,
): void {
  const tr = table.column(Transform, 'translation')
  const rot = table.column(Transform, 'rotation')
  tr[row * 3] = pose[o]!
  tr[row * 3 + 1] = pose[o + 1]!
  if (dim === 3) tr[row * 3 + 2] = pose[o + 2]!
  rot[row * 4] = pose[o + 3]!
  rot[row * 4 + 1] = pose[o + 4]!
  rot[row * 4 + 2] = pose[o + 5]!
  rot[row * 4 + 3] = pose[o + 6]!
  table.markChanged(Transform, row)
}

type SyncState = ReturnType<NonNullable<typeof syncIn.setup>>

/** ExternalForce every step plus GravitySource pulls, reset first so old forces don't linger. */
function applyForces(s: SyncState, p: PhysicsWorld, since: number): void {
  const raw = p.raw.bodies.raw as unknown as {
    rbAddForce(h: number, v: unknown, w: boolean): void
    rbAddTorque(h: number, v: unknown, w: boolean): void
    rbResetForces(h: number, w: boolean): void
    rbResetTorques(h: number, w: boolean): void
  }
  const rv = p.rawVec as unknown as { x: number; y: number; z: number }
  for (let i = 0; i < s.forcedLast.length; i++) {
    const r = s.forcedLast[i]!
    if (!p.bodyByHandle.has(r.handle)) continue
    raw.rbResetForces(r.handle, false)
    raw.rbResetTorques(r.handle, false)
  }
  const swap = s.forcedLast
  s.forcedLast = s.forcedNow
  s.forcedNow = swap
  s.forcedNow.length = 0
  s.stamp++
  if (s.stamps.length < p.slotCapacity) {
    const grown = new Uint32Array(p.slotCapacity)
    grown.set(s.stamps)
    s.stamps = grown
  }

  for (let t = 0; t < s.forces.tables.length; t++) {
    const table = s.forces.tables[t]!
    const f = table.column(ExternalForce, 'force')
    const tq = table.column(ExternalForce, 'torque')
    const ticks = table.changedTicks(ExternalForce)
    for (let row = 0; row < table.count; row++) {
      const record = p.bodies.get(table.entities[row]!)
      if (!record || record.kind !== KIND_DYNAMIC) continue
      const o = row * 3
      const wake = ticks[row]! > since
      if (s.stamps[record.slot] !== s.stamp) {
        s.stamps[record.slot] = s.stamp
        s.forcedLast.push(record)
      }
      if (f[o] || f[o + 1] || f[o + 2]) {
        rv.x = f[o]!
        rv.y = f[o + 1]!
        if (p.dim === 3) rv.z = f[o + 2]!
        raw.rbAddForce(record.handle, rv, wake)
      }
      if (tq[o] || tq[o + 1] || tq[o + 2]) {
        if (p.dim === 3) {
          rv.x = tq[o]!
          rv.y = tq[o + 1]!
          rv.z = tq[o + 2]!
          raw.rbAddTorque(record.handle, rv, wake)
        } else {
          ;(raw as unknown as { rbAddTorque(h: number, t: number, w: boolean): void }).rbAddTorque(
            record.handle,
            tq[o + 2]!,
            wake,
          )
        }
      }
    }
  }

  // Gravity sources: gather positions, then pull every awake dynamic body.
  gatherGravitySources(s.sources, s.gravity)
  if (s.gravity.count === 0) return
  s.gravityVisit ??= (handle: number) => {
    const record = p.bodyByHandle.get(handle)
    if (!record || record.kind !== KIND_DYNAMIC) return
    const c = p.curr
    const o = record.slot * 7
    const g = s.pull
    sampleGravity(s.gravity, p.dim, c[o]!, c[o + 1]!, c[o + 2]!, false, g)
    const k = record.body.mass() * record.body.gravityScale()
    if (s.stamps[record.slot] !== s.stamp) {
      s.stamps[record.slot] = s.stamp
      s.forcedLast.push(record)
    }
    rv.x = g[0]! * k
    rv.y = g[1]! * k
    if (p.dim === 3) rv.z = g[2]! * k
    raw.rbAddForce(handle, rv, false)
  }
  p.raw.islands.forEachActiveRigidBodyHandle(s.gravityVisit)
}

// --- step and sync out ---------------------------------------------------------

const step = defineSystem({
  name: 'physics/step',
  description: 'Steps Rapier by the fixed timestep and sends collision and contact force events.',
  setup: (world) => ({
    onCollision: (e: import('./components').CollisionEventData) => world.send(CollisionEvent, e),
    onForce: (a: Entity, b: Entity, force: number) =>
      world.send(ContactForceEvent, { a, b, force }),
  }),
  run: (s, world) => {
    const p = world.tryResource(Physics)
    if (!p || p.config.paused) return
    p.step(world.resource(FixedTime).step, s.onCollision, s.onForce)
  },
})

/** Columns of the table sync-out last wrote to; active bodies mostly share a few tables. */
interface OutCache {
  table: Table | undefined
  tr: Float32Array
  rt: Float32Array
  trTicks: Uint32Array
  lin: Float32Array | undefined
  ang: Float32Array | undefined
  velTicks: Uint32Array | undefined
  parented: boolean
}

function cacheTable(c: OutCache, table: Table): void {
  c.table = table
  c.tr = table.column(Transform, 'translation')
  c.rt = table.column(Transform, 'rotation')
  c.trTicks = table.changedTicks(Transform)
  table.touch(Transform)
  if (table.has(Velocity)) {
    c.lin = table.column(Velocity, 'linear')
    c.ang = table.column(Velocity, 'angular')
    c.velTicks = table.changedTicks(Velocity)
    table.touch(Velocity)
  } else {
    c.lin = c.ang = c.velTicks = undefined
  }
  c.parented = table.has(ChildOf)
}

const syncOut = defineSystem({
  name: 'physics/sync-out',
  description: 'Writes the poses and velocities of moving bodies to Transform and Velocity.',
  setup: (world) => ({
    visit: undefined as ((handle: number) => void) | undefined,
    world,
    tick: 0,
    /** Awake bodies sync-out wrote this step: while any are, on-demand apps keep rendering. */
    awake: 0,
    pos: new Float64Array(3),
    rot: new Float64Array(4),
    rootIdentity: true,
    cache: {
      table: undefined,
      tr: new Float32Array(0),
      rt: new Float32Array(0),
      trTicks: new Uint32Array(0),
      lin: undefined,
      ang: undefined,
      velTicks: undefined,
      parented: false,
    } as OutCache,
  }),
  run: (s, world, ctx) => {
    const p = world.tryResource(Physics)
    if (!p) return
    p.writeTick = ctx.thisRunTick
    s.tick = ctx.thisRunTick
    s.cache.table = undefined
    s.rootIdentity = rootIsOrigin(world)
    s.visit ??= (handle: number) => {
      const record = p.bodyByHandle.get(handle)
      if (!record || record.kind === KIND_FIXED) return
      s.awake++
      const o = record.slot * 7
      const curr = p.curr
      for (let k = 0; k < 7; k++) p.prev[o + k] = curr[o + k]!
      p.storePose(record)
      const e = record.entity
      const table = world.entityTableUnchecked(e)
      const row = world.entityRowUnchecked(e)
      const c = s.cache
      if (c.table !== table) cacheTable(c, table)
      if (record.kind !== KIND_KINEMATIC_POSITION) {
        const parent = c.parented ? parentOf(world, e) : undefined
        const tr = c.tr
        const rt = c.rt
        if (parent === undefined && s.rootIdentity) {
          tr[row * 3] = curr[o]!
          tr[row * 3 + 1] = curr[o + 1]!
          if (p.dim === 3) tr[row * 3 + 2] = curr[o + 2]!
          rt[row * 4] = curr[o + 3]!
          rt[row * 4 + 1] = curr[o + 4]!
          rt[row * 4 + 2] = curr[o + 5]!
          rt[row * 4 + 3] = curr[o + 6]!
        } else {
          for (let k = 0; k < 3; k++) s.pos[k] = curr[o + k]!
          for (let k = 0; k < 4; k++) s.rot[k] = curr[o + 3 + k]!
          const z = tr[row * 3 + 2]!
          worldToLocal(world, parent, e, s.pos, s.rot, tr, row * 3, rt, row * 4)
          if (p.dim === 2) tr[row * 3 + 2] = z
        }
        c.trTicks[row] = s.tick
      }
      if (c.lin) {
        const lin = c.lin
        const ang = c.ang!
        const v = record.body.linvel(p.v3 as never) as unknown as {
          x: number
          y: number
          z: number
        }
        lin[row * 3] = v.x
        lin[row * 3 + 1] = v.y
        lin[row * 3 + 2] = p.dim === 3 ? v.z : 0
        if (p.dim === 3) {
          const a = record.body.angvel(p.v3 as never) as unknown as {
            x: number
            y: number
            z: number
          }
          ang[row * 3] = a.x
          ang[row * 3 + 1] = a.y
          ang[row * 3 + 2] = a.z
        } else {
          ang[row * 3] = 0
          ang[row * 3 + 1] = 0
          ang[row * 3 + 2] = record.body.angvel() as unknown as number
        }
        c.velTicks![row] = s.tick
      }
    }
    s.awake = 0
    p.raw.islands.forEachActiveRigidBodyHandle(s.visit)
    // Awake bodies keep an on-demand runner going until they sleep (0052).
    world.tryResource(FrameDemand)?.set('physics', s.awake > 0)
  },
})

const interpolate = defineSystem({
  name: 'physics/interpolate',
  description:
    'With PhysicsConfig.interpolate, blends body Transforms between the last two steps by FixedTime.alpha.',
  run: (_, world, ctx) => {
    const p = world.tryResource(Physics)
    if (!p?.config.interpolate) return
    const alpha = world.resource(FixedTime).alpha
    // Transforms last written by sync-out or by this system aren't a game's teleport.
    const ours = Math.max(p.writeTick, p.interpTick)
    const prev = p.prev
    const curr = p.curr
    const rootIdentity = rootIsOrigin(world)
    const pos = scratchPos
    const rot = scratchRot
    for (let i = 0; i < p.list.length; i++) {
      const r = p.list[i]!
      if (r.kind === KIND_FIXED || r.kind === KIND_KINEMATIC_POSITION || r.parked) continue
      const table = world.entityTableUnchecked(r.entity)
      const row = world.entityRowUnchecked(r.entity)
      // Skip bodies a game moved since the step (a teleport pending), and ones parented to an
      // ordinary entity.
      if (table.changedTicks(Transform)[row]! > ours) continue
      const mode = writeMode(world, r.entity, rootIdentity)
      if (mode < 0) continue
      const o = r.slot * 7
      pos[0] = prev[o]! + (curr[o]! - prev[o]!) * alpha
      pos[1] = prev[o + 1]! + (curr[o + 1]! - prev[o + 1]!) * alpha
      pos[2] = prev[o + 2]! + (curr[o + 2]! - prev[o + 2]!) * alpha
      // Normalized lerp, taking the short way around.
      let ax = prev[o + 3]!
      let ay = prev[o + 4]!
      let az = prev[o + 5]!
      let aw = prev[o + 6]!
      const bx = curr[o + 3]!
      const by = curr[o + 4]!
      const bz = curr[o + 5]!
      const bw = curr[o + 6]!
      if (ax * bx + ay * by + az * bz + aw * bw < 0) {
        ax = -ax
        ay = -ay
        az = -az
        aw = -aw
      }
      const x = ax + (bx - ax) * alpha
      const y = ay + (by - ay) * alpha
      const z = az + (bz - az) * alpha
      const w = aw + (bw - aw) * alpha
      const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1
      rot[0] = x / len
      rot[1] = y / len
      rot[2] = z / len
      rot[3] = w / len
      if (mode === 1) {
        writeGridPose(world, r.entity, table, row, pos, rot, p.dim)
        continue
      }
      const tr = table.column(Transform, 'translation')
      const rt = table.column(Transform, 'rotation')
      tr[row * 3] = pos[0]!
      tr[row * 3 + 1] = pos[1]!
      if (p.dim === 3) tr[row * 3 + 2] = pos[2]!
      rt[row * 4] = rot[0]!
      rt[row * 4 + 1] = rot[1]!
      rt[row * 4 + 2] = rot[2]!
      rt[row * 4 + 3] = rot[3]!
      table.markChanged(Transform, row)
    }
    p.interpTick = ctx.thisRunTick
  },
})

// --- plugins ---------------------------------------------------------------------

const dimensionOf = new WeakMap<World, 2 | 3>()

function observe(world: World): void {
  const get = () => world.tryResource(Physics)
  world.observe(onRemove(RigidBody), (e) => get()?.removeBody(world, e.entity))
  world.observe(onRemove(CharacterController), (e) => {
    const p = get()
    if (p?.characters.has(e.entity)) p.removeBody(world, e.entity)
  })
  world.observe(onRemove(Collider), (e) => {
    const p = get()
    p?.removeCollider(e.entity)
    p?.pendingMesh.delete(e.entity)
  })
  world.observe(onRemove(Joint), (e) => {
    const p = get()
    p?.removeJoint(e.entity)
    p?.dirtyJoints.delete(e.entity)
  })
  let set = reparented.get(world)
  if (!set) {
    set = new Set()
    reparented.set(world, set)
  }
  const moved = set
  const mark = (e: { entity: Entity }) => void moved.add(e.entity)
  world.observe(onAdd(ChildOf), mark)
  world.observe(onSet(ChildOf), mark)
  world.observe(onRemove(ChildOf), mark)
  // The floating origin moved to another cell (spec 0040): move the simulation with it.
  const onCollision = (e: import('./components').CollisionEventData) =>
    world.send(CollisionEvent, e)
  world.observe(OriginShift, ({ data }) => {
    get()?.shiftOrigin(data.offset[0], data.offset[1], data.offset[2], onCollision)
  })
}

export interface PhysicsPluginOptions {
  /**
   * Run on Rapier's deterministic build: the same results on every machine and browser, at some
   * cost in speed (0053). Default false.
   */
  deterministic?: boolean
}

function physicsPlugin(dim: 2 | 3, options: PhysicsPluginOptions | undefined): Plugin {
  const deterministic = options?.deterministic === true
  return {
    name: dim === 3 ? 'physics3d' : 'physics2d',
    provides: [componentsModule, pluginModule, renderModule],
    dependencies: ['core/transform'],
    build(app: App) {
      const other = dimensionOf.get(app.world)
      if (other !== undefined && other !== dim) {
        throw new ShardError(
          'physics/both-dimensions',
          'physics2d and physics3d are both enabled',
          { hint: 'Enable one physics plugin per app: physics3d for 3D games, physics2d for 2D.' },
        )
      }
      dimensionOf.set(app.world, dim)
      app.world.initResource(PhysicsConfig)
      app.world.initResource(PhysicsRange)
      if (dim === 2) {
        const config = app.world.resource(PhysicsConfig)
        config.gravity = [0, -9.81, 0]
      }
      observe(app.world)
      app.addSystems(
        FixedUpdate,
        syncIn.inSet(PhysicsSystems),
        characterSystem.after(syncIn).inSet(PhysicsSystems),
        step.after(characterSystem).inSet(PhysicsSystems),
        syncOut.after(step).inSet(PhysicsSystems),
      )
      app.addSystems(PostUpdate, interpolate.before(TransformSystems))
      app.addMethod(...physicsMethods)
    },
    async ready(app: App) {
      const R = await loadRapier(dim, { deterministic })
      const config = app.world.resource(PhysicsConfig)
      const variant = deterministic ? 'deterministic' : 'regular'
      app.world.insertResource(Physics, new PhysicsWorld(R, dim, config, variant, rendererMeshes))
    },
    dispose(app: App) {
      // Rapier's world lives in WASM memory, which outlives the app unless freed (0052).
      app.world.tryResource(Physics)?.free()
      app.world.removeResource(Physics)
    },
  }
}

/** 3D rigid bodies, colliders, joints, and scene queries (Rapier). */
export function physics3dPlugin(options?: PhysicsPluginOptions): Plugin {
  return physicsPlugin(3, options)
}

/** 2D rigid bodies, colliders, joints, and scene queries in the XY plane (Rapier 2D). */
export function physics2dPlugin(options?: PhysicsPluginOptions): Plugin {
  return physicsPlugin(2, options)
}
