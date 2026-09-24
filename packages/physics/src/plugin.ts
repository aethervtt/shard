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
} from '@shard/core'
import { defineOverlay } from '@shard/render'
import { type App, FixedTime, type Plugin } from '@shard/runtime'
import { GlobalTransform, Transform, TransformSystems } from '@shard/transform'
import {
  Collider,
  CollisionEvent,
  ContactForceEvent,
  ExternalForce,
  ExternalImpulse,
  GravitySource,
  Joint,
  PhysicsConfig,
  RigidBody,
  Velocity,
} from './components'
import { physicsMethods } from './methods'
import { parentOf, rotate, worldToLocal } from './pose'
import { type BodyRecord, loadRapier, Physics, PhysicsWorld } from './world'

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
    sourceData: new Float64Array(6 * 8),
    gravityVisit: undefined as ((handle: number) => void) | undefined,
    sourceCount: 0,
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
      if (table.lastChanged(Transform) <= userTick && !kinematicMoved) continue
      const ticks = table.changedTicks(Transform)
      const globals = table.changedTicks(GlobalTransform)
      for (let row = 0; row < table.count; row++) {
        const record = p.bodies.get(table.entities[row]!)
        if (!record) continue
        if (ticks[row]! > userTick) p.moveBody(world, record)
        else if (record.kind === KIND_KINEMATIC_POSITION && globals[row]! > since) {
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
  },
})

function restorePoses(world: World, p: PhysicsWorld): void {
  for (let i = 0; i < p.list.length; i++) {
    const r = p.list[i]!
    if (r.kind === KIND_FIXED || r.kind === KIND_KINEMATIC_POSITION) continue
    const table = world.entityTableUnchecked(r.entity)
    const row = world.entityRowUnchecked(r.entity)
    // Only poses interpolation wrote (and nobody changed since).
    if (table.changedTicks(Transform)[row] !== p.interpTick) continue
    if (parentOf(world, r.entity) !== undefined) continue
    writePose(table, row, p.curr, r.slot * 7, p.dim)
  }
}

function writePose(
  table: import('@shard/core').Table,
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
  let n = 0
  for (let t = 0; t < s.sources.tables.length; t++) {
    const table = s.sources.tables[t]!
    const m = table.column(GlobalTransform, 'matrix')
    const strength = table.column(GravitySource, 'strength')
    const radius = table.column(GravitySource, 'radius')
    const range = table.column(GravitySource, 'range')
    const falloff = table.column(GravitySource, 'falloff')
    for (let row = 0; row < table.count; row++) {
      if ((n + 1) * 6 > s.sourceData.length) {
        const grown = new Float64Array(s.sourceData.length * 2)
        grown.set(s.sourceData)
        s.sourceData = grown
      }
      const d = s.sourceData
      d[n * 6] = m[row * 12 + 3]!
      d[n * 6 + 1] = m[row * 12 + 7]!
      d[n * 6 + 2] = m[row * 12 + 11]!
      d[n * 6 + 3] = strength[row]!
      d[n * 6 + 4] = radius[row]!
      d[n * 6 + 5] = falloff[row] === 1 ? -range[row]! - 1 : range[row]!
      n++
    }
  }
  if (n === 0) return
  s.sourceCount = n
  s.gravityVisit ??= (handle: number) => {
    const record = p.bodyByHandle.get(handle)
    if (!record || record.kind !== KIND_DYNAMIC) return
    const c = p.curr
    const o = record.slot * 7
    const px = c[o]!
    const py = c[o + 1]!
    const pz = c[o + 2]!
    let fx = 0
    let fy = 0
    let fz = 0
    const d = s.sourceData
    for (let i = 0; i < s.sourceCount; i++) {
      const dx = d[i * 6]! - px
      const dy = d[i * 6 + 1]! - py
      const dz = p.dim === 3 ? d[i * 6 + 2]! - pz : 0
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < 1e-6) continue
      const packed = d[i * 6 + 5]!
      const constant = packed < 0
      const range = constant ? -packed - 1 : packed
      if (range > 0 && dist > range) continue
      const r = d[i * 6 + 4]!
      const accel = constant ? d[i * 6 + 3]! : d[i * 6 + 3]! * ((r * r) / (dist * dist))
      fx += (dx / dist) * accel
      fy += (dy / dist) * accel
      fz += (dz / dist) * accel
    }
    const k = record.body.mass() * record.body.gravityScale()
    if (s.stamps[record.slot] !== s.stamp) {
      s.stamps[record.slot] = s.stamp
      s.forcedLast.push(record)
    }
    rv.x = fx * k
    rv.y = fy * k
    if (p.dim === 3) rv.z = fz * k
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
    pos: new Float64Array(3),
    rot: new Float64Array(4),
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
    s.visit ??= (handle: number) => {
      const record = p.bodyByHandle.get(handle)
      if (!record || record.kind === KIND_FIXED) return
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
        if (parent === undefined) {
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
          worldToLocal(world, parent, s.pos, s.rot, tr, row * 3, rt, row * 4)
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
    p.raw.islands.forEachActiveRigidBodyHandle(s.visit)
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
    for (let i = 0; i < p.list.length; i++) {
      const r = p.list[i]!
      if (r.kind === KIND_FIXED || r.kind === KIND_KINEMATIC_POSITION) continue
      const table = world.entityTableUnchecked(r.entity)
      const row = world.entityRowUnchecked(r.entity)
      // Skip bodies a game moved since the step (a teleport pending), and parented ones.
      if (table.changedTicks(Transform)[row]! > ours) continue
      if (parentOf(world, r.entity) !== undefined) continue
      const o = r.slot * 7
      const tr = table.column(Transform, 'translation')
      const rt = table.column(Transform, 'rotation')
      tr[row * 3] = prev[o]! + (curr[o]! - prev[o]!) * alpha
      tr[row * 3 + 1] = prev[o + 1]! + (curr[o + 1]! - prev[o + 1]!) * alpha
      if (p.dim === 3) tr[row * 3 + 2] = prev[o + 2]! + (curr[o + 2]! - prev[o + 2]!) * alpha
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
      let x = ax + (bx - ax) * alpha
      let y = ay + (by - ay) * alpha
      let z = az + (bz - az) * alpha
      let w = aw + (bw - aw) * alpha
      const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1
      x /= len
      y /= len
      z /= len
      w /= len
      rt[row * 4] = x
      rt[row * 4 + 1] = y
      rt[row * 4 + 2] = z
      rt[row * 4 + 3] = w
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
}

function physicsPlugin(dim: 2 | 3): Plugin {
  return {
    name: dim === 3 ? 'physics3d' : 'physics2d',
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
      if (dim === 2) {
        const config = app.world.resource(PhysicsConfig)
        config.gravity = [0, -9.81, 0]
      }
      observe(app.world)
      app.addSystems(
        FixedUpdate,
        syncIn.inSet(PhysicsSystems),
        step.after(syncIn).inSet(PhysicsSystems),
        syncOut.after(step).inSet(PhysicsSystems),
      )
      app.addSystems(PostUpdate, interpolate.before(TransformSystems))
      app.addMethod(...physicsMethods)
    },
    async ready(app: App) {
      const R = await loadRapier(dim)
      app.world.insertResource(Physics, new PhysicsWorld(R, dim, app.world.resource(PhysicsConfig)))
    },
  }
}

/** 3D rigid bodies, colliders, joints, and scene queries (Rapier). */
export const physics3dPlugin: Plugin = physicsPlugin(3)
/** 2D rigid bodies, colliders, joints, and scene queries in the XY plane (Rapier 2D). */
export const physics2dPlugin: Plugin = physicsPlugin(2)

// --- overlay -----------------------------------------------------------------------

const COLORS = [
  [1, 0.55, 0.2, 1], // dynamic
  [0.55, 0.55, 0.6, 1], // fixed
  [0.3, 0.8, 1, 1], // kinematic
  [0.3, 0.8, 1, 1],
]
const SLEEPING = [0.5, 0.35, 0.2, 1]
const SENSOR = [0.3, 1, 0.4, 1]
const CONTACT = [1, 0.2, 0.3, 1]
const pa = new Float64Array(3)
const pb = new Float64Array(3)
const q = new Float64Array(4)
const center = new Float64Array(3)

defineOverlay({
  name: 'colliders',
  description:
    'Physics collider outlines, colored by body kind (sleeping dimmed, sensors green), and contact normals.',
  draw(world, g, passes) {
    const p = world.tryResource(Physics)
    if (!p) return
    for (const [entity, collider] of p.colliders) {
      if (!passes(entity)) continue
      const owner = p.colliderOwner.get(entity)
      const record = owner === undefined ? undefined : p.bodies.get(owner)
      const color = collider.isSensor()
        ? SENSOR
        : record?.body.isSleeping()
          ? SLEEPING
          : COLORS[record?.kind ?? KIND_FIXED]!
      const t = collider.translation(p.v3 as never)
      center[0] = t.x
      center[1] = t.y
      center[2] = p.dim === 3 ? (t as { z: number }).z : 0
      if (p.dim === 3) {
        const r = collider.rotation(p.q4 as never) as { x: number; y: number; z: number; w: number }
        q[0] = r.x
        q[1] = r.y
        q[2] = r.z
        q[3] = r.w
      } else {
        const angle = collider.rotation() as unknown as number
        q[0] = 0
        q[1] = 0
        q[2] = Math.sin(angle / 2)
        q[3] = Math.cos(angle / 2)
      }
      drawCollider(p, g, collider, p.colliderShape.get(entity)!, color)
    }
    // Contact normals around awake bodies, up to a budget: past a thousand pairs they're an
    // unreadable carpet, and each pair costs several calls into Rapier.
    contactBudget = MAX_CONTACT_PAIRS
    for (let i = 0; i < p.list.length && contactBudget > 0; i++) {
      const record = p.list[i]!
      if (record.kind !== KIND_DYNAMIC || record.body.isSleeping()) continue
      const n = record.body.numColliders()
      for (let c = 0; c < n; c++) drawContacts(p, g, record.body.collider(c))
    }
  },
})

type Gz = import('@shard/render').GizmoStore
type RCollider = InstanceType<PhysicsWorld['R']['Collider']>

const MAX_CONTACT_PAIRS = 1000
let contactBudget = 0

/** An awake dynamic body's collider, whose pairs the loop visits from its own side too. */
function visitedFromOtherSide(other: RCollider): boolean {
  const body = other.parent()
  return body?.isDynamic() === true && !body.isSleeping()
}

function drawContacts(p: PhysicsWorld, g: Gz, collider: RCollider): void {
  p.raw.contactPairsWith(collider, (other) => {
    if (contactBudget <= 0) return
    // Each pair once: when both sides are visited, only from the lower handle.
    if (other.handle < collider.handle && visitedFromOtherSide(other)) return
    contactBudget--
    p.raw.contactPair(collider, other, (manifold) => {
      const count = manifold.numSolverContacts()
      if (count === 0) return
      const n = manifold.normal()
      for (let i = 0; i < count; i++) {
        const point = manifold.solverContactPoint(i)
        if (!point) continue
        pa[0] = point.x
        pa[1] = point.y
        pa[2] = p.dim === 3 ? (point as { z: number }).z : 0
        pb[0] = pa[0] + n.x * 0.25
        pb[1] = pa[1] + n.y * 0.25
        pb[2] = pa[2] + (p.dim === 3 ? (n as { z: number }).z : 0) * 0.25
        g.line(pa, pb, CONTACT)
      }
    })
  })
}

/** A point in the collider's local frame (centered at `center`, rotated by `q`) into out. */
function local(out: Float64Array, x: number, y: number, z: number): Float64Array {
  rotate(out, 0, q, 0, x, y, z)
  out[0] = out[0]! + center[0]!
  out[1] = out[1]! + center[1]!
  out[2] = out[2]! + center[2]!
  return out
}

/** A circle of radius r in a local plane (axis 0: YZ, 1: XZ, 2: XY), offset along y by dy. */
const SEGMENTS = 24
/** The unit circle's points, once (cos, sin per segment boundary). */
const UNIT = (() => {
  const out = new Float64Array((SEGMENTS + 1) * 2)
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2
    out[i * 2] = Math.cos(t)
    out[i * 2 + 1] = Math.sin(t)
  }
  return out
})()

/** A circle of radius r in a local plane (axis 0: YZ, 1: XZ, 2: XY), offset along y by dy. */
function localCircle(g: Gz, axis: number, r: number, dy: number, color: ArrayLike<number>): void {
  for (let i = 0; i <= SEGMENTS; i++) {
    const u = UNIT[i * 2]! * r
    const v = UNIT[i * 2 + 1]! * r
    if (axis === 0) local(pb, 0, u + dy, v)
    else if (axis === 1) local(pb, u, dy, v)
    else local(pb, u, v + dy, 0)
    if (i > 0) g.line(pa, pb, color)
    pa[0] = pb[0]!
    pa[1] = pb[1]!
    pa[2] = pb[2]!
  }
}

function drawCollider(
  p: PhysicsWorld,
  g: Gz,
  collider: InstanceType<PhysicsWorld['R']['Collider']>,
  shape: string,
  color: ArrayLike<number>,
): void {
  const is2d = p.dim === 2
  switch (shape) {
    case 'ball': {
      const r = collider.radius()
      localCircle(g, 2, r, 0, color)
      if (!is2d) {
        localCircle(g, 0, r, 0, color)
        localCircle(g, 1, r, 0, color)
      }
      return
    }
    case 'cuboid': {
      const he = collider.halfExtents() as { x: number; y: number; z?: number }
      const hz = is2d ? 0 : he.z!
      const size = [he.x * 2, he.y * 2, hz * 2]
      g.box(center, size, q, color)
      return
    }
    case 'capsule':
    case 'cylinder':
    case 'cone': {
      const r = collider.radius()
      const h = collider.halfHeight()
      if (is2d) {
        local(pa, -r, -h, 0)
        local(pb, -r, h, 0)
        g.line(pa, pb, color)
        local(pa, r, -h, 0)
        local(pb, r, h, 0)
        g.line(pa, pb, color)
        localCircle(g, 2, r, h, color)
        localCircle(g, 2, r, -h, color)
        return
      }
      const top = shape === 'cone' ? 0 : r
      localCircle(g, 1, r, -h, color)
      if (top > 0) localCircle(g, 1, top, h, color)
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2
        local(pa, Math.cos(a) * r, -h, Math.sin(a) * r)
        local(pb, Math.cos(a) * top, h, Math.sin(a) * top)
        g.line(pa, pb, color)
      }
      if (shape === 'capsule') {
        localCircle(g, 0, r, h, color)
        localCircle(g, 0, r, -h, color)
        localCircle(g, 2, r, h, color)
        localCircle(g, 2, r, -h, color)
      }
      return
    }
    case 'heightfield':
      drawHeightfield(p, g, collider, color)
      return
    default: {
      // Meshes, hulls, polylines: their edges from Rapier's own vertices.
      const vertices = collider.vertices?.() as Float32Array | undefined
      const indices = collider.indices?.() as Uint32Array | undefined
      if (!vertices || vertices.length === 0) return
      const d = p.dim
      const edge = (i: number, j: number) => {
        local(pa, vertices[i * d]!, vertices[i * d + 1]!, d === 3 ? vertices[i * d + 2]! : 0)
        local(pb, vertices[j * d]!, vertices[j * d + 1]!, d === 3 ? vertices[j * d + 2]! : 0)
        g.line(pa, pb, color)
      }
      if (indices && indices.length > 0) {
        const stride = shape === 'polyline' || is2d ? 2 : 3
        const limit = Math.min(indices.length, 30000)
        for (let i = 0; i + stride - 1 < limit; i += stride) {
          for (let k = 0; k < stride; k++) {
            if (stride === 2 && k === 1) break
            edge(indices[i + k]!, indices[i + ((k + 1) % stride)]!)
          }
        }
      } else {
        const n = vertices.length / d
        for (let i = 0; i + 1 < n; i++) edge(i, i + 1)
        // A 2D convex polygon comes as its outline; close it.
        if (shape === 'convex' && n > 2) edge(n - 1, 0)
      }
    }
  }
}

/** A heightfield from Rapier's heights: the profile in 2D, a grid of lines in 3D. */
function drawHeightfield(
  p: PhysicsWorld,
  g: Gz,
  collider: RCollider,
  color: ArrayLike<number>,
): void {
  const hf = collider as unknown as {
    heightfieldHeights(): Float32Array
    heightfieldScale(): { x: number; y: number; z?: number }
    heightfieldNRows(): number
    heightfieldNCols(): number
  }
  const heights = hf.heightfieldHeights()
  const scale = hf.heightfieldScale()
  if (p.dim === 2) {
    const n = heights.length
    for (let i = 0; i < n; i++) {
      local(pb, (i / (n - 1) - 0.5) * scale.x, heights[i]! * scale.y, 0)
      if (i > 0) g.line(pa, pb, color)
      pa[0] = pb[0]!
      pa[1] = pb[1]!
      pa[2] = pb[2]!
    }
    return
  }
  // Rows run along Z and columns along X; heights are column-major, (nrows + 1) × (ncols + 1).
  const rows = hf.heightfieldNRows() + 1
  const cols = hf.heightfieldNCols() + 1
  const sz = scale.z ?? 1
  const at = (out: Float64Array, r: number, c: number) =>
    local(
      out,
      (c / (cols - 1) - 0.5) * scale.x,
      heights[c * rows + r]! * scale.y,
      (r / (rows - 1) - 0.5) * sz,
    )
  // Dense fields draw every n-th line so the overlay stays readable.
  const step = Math.max(1, Math.ceil(Math.max(rows, cols) / 64))
  for (let r = 0; r < rows; r += step) {
    for (let c = 0; c + step < cols; c += step) {
      at(pa, r, c)
      at(pb, r, c + step)
      g.line(pa, pb, color)
    }
  }
  for (let c = 0; c < cols; c += step) {
    for (let r = 0; r + step < rows; r += step) {
      at(pa, r, c)
      at(pb, r + step, c)
      g.line(pa, pb, color)
    }
  }
}
