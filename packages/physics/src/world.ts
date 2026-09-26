import type RAPIER from '@dimforge/rapier3d-compat'
import { assetServer } from '@shard/assets'
import {
  type AssetRef,
  Children,
  defineResource,
  type Entity,
  ShardError,
  type World,
} from '@shard/core'
import type { Mesh } from '@shard/mesh'
import { Meshes } from '@shard/render'
import { LogResource } from '@shard/runtime'
import { GlobalTransform, GridFramesResource } from '@shard/transform'
import {
  BODY_KINDS,
  CharacterController,
  Collider,
  type CollisionEventData,
  Joint,
  Mass,
  type PhysicsConfigValue,
  PhysicsParked,
  RigidBody,
  type Shape,
  Velocity,
} from './components'
import { createPose, mulQuat, parentOf, poseOf, rotate } from './pose'

export type Rapier = typeof RAPIER
type RWorld = InstanceType<Rapier['World']>
type RBody = InstanceType<Rapier['RigidBody']>
type RCollider = InstanceType<Rapier['Collider']>
type RColliderDesc = InstanceType<Rapier['ColliderDesc']>
type RJoint = InstanceType<Rapier['ImpulseJoint']>
type RShape = InstanceType<Rapier['Shape']>

/** The physics world, once Rapier has loaded (the plugin's `ready` step). */
export const Physics = defineResource<PhysicsWorld>('physics/World', {
  description:
    'The Rapier world: raycast, shapeCast, overlapPoint, overlapShape, describe. Present after the physics plugin is ready.',
})

const modules: Partial<Record<2 | 3, Promise<Rapier>>> = {}

/** Loads and initializes Rapier's WASM for a dimension, once per process. */
export function loadRapier(dim: 2 | 3): Promise<Rapier> {
  modules[dim] ??= (async () => {
    const mod =
      dim === 3
        ? await import('@dimforge/rapier3d-compat')
        : await import('@dimforge/rapier2d-compat')
    const R = ((mod as { default?: unknown }).default ?? mod) as Rapier
    await R.init()
    return R
  })()
  return modules[dim]!
}

/** A body the physics world owns, by entity. */
export interface BodyRecord {
  entity: Entity
  handle: number
  body: RBody
  kind: number
  /** Dense index into the interpolation buffers. */
  slot: number
  /** Position in `PhysicsWorld.list`. */
  index: number
  /** Out of PhysicsRange: disabled in Rapier, the entity has PhysicsParked. */
  parked: boolean
}

/** A character's Rapier controller and the body and capsule it moves. */
export interface CharacterRecord {
  entity: Entity
  body: BodyRecord
  collider: RCollider
  kcc: InstanceType<Rapier['KinematicCharacterController']>
  /** Whether snap-to-ground is on right now (off while moving up, so jumps leave the ground). */
  snapping: boolean
  snapDistance: number
  /** Cosine of maxSlope: ground normals at least this aligned with up are walkable. */
  cosMaxSlope: number
  /** From the capsule's center to its bottom, m. */
  bottom: number
}

/** The gap Rapier keeps between a character and what it touches, m. */
export const CHARACTER_OFFSET = 0.01

export interface RayHit {
  /** The collider's entity. */
  entity: Entity
  /** The body it belongs to, or -1 for a fixed collider without a body. */
  body: Entity
  distance: number
  point: Float32Array
  normal: Float32Array
}

export const createRayHit = (): RayHit => ({
  entity: -1 as Entity,
  body: -1 as Entity,
  distance: 0,
  point: new Float32Array(3),
  normal: new Float32Array(3),
})

export interface QueryOptions {
  /** Longest ray or cast, m (default: no limit). */
  maxDistance?: number
  /** Only colliders in these layers (bitmask, default all). */
  mask?: number
  /** The query's own layers, for colliders whose mask filters queries (default all). */
  layers?: number
  /** Skip this entity's colliders (and its body's). */
  exclude?: Entity
  /** A ray starting inside a shape hits at distance 0 (default true). */
  solid?: boolean
  /** Include sensors (default false). */
  sensors?: boolean
}

export interface QueryShape {
  shape: 'ball' | 'cuboid' | 'capsule'
  radius?: number
  halfExtents?: ArrayLike<number>
  halfHeight?: number
}

export interface PhysicsStats {
  bodies: Record<string, number>
  sleeping: number
  colliders: Record<string, number>
  joints: number
  /** Character controllers (not counted in bodies or colliders). */
  characters: number
  contacts: number
  stepMs: number
  steps: number
  pending: number
  /** Bodies out of PhysicsRange, set aside until the origin comes near (spec 0040). */
  parked: number
}

const KIND_DYNAMIC = 0
const KIND_FIXED = 1
const KIND_KINEMATIC_POSITION = 2

/**
 * The Rapier world for one app, plus the maps between Rapier handles and entities. Systems in
 * `plugin.ts` keep it in sync with the components; queries read it.
 */
export class PhysicsWorld {
  readonly R: Rapier
  readonly dim: 2 | 3
  readonly raw: RWorld
  readonly events: InstanceType<Rapier['EventQueue']>
  readonly bodies = new Map<Entity, BodyRecord>()
  /** Every body record, for loops that shouldn't allocate an iterator. */
  readonly list: BodyRecord[] = []
  readonly bodyByHandle = new Map<number, BodyRecord>()
  readonly colliders = new Map<Entity, RCollider>()
  readonly colliderEntity = new Map<number, Entity>()
  /** Collider entity → the body entity it's attached to (absent: fixed). */
  readonly colliderOwner = new Map<Entity, Entity>()
  /** Shape kind per collider entity, for describe and the overlay. */
  readonly colliderShape = new Map<Entity, Shape>()
  readonly joints = new Map<Entity, { joint: RJoint; a: Entity; b: Entity }>()
  /** Character controllers by entity; each also has a body record and a capsule collider. */
  readonly characters = new Map<Entity, CharacterRecord>()
  /** Colliders to (re)build at the next sync, e.g. after their body changed. */
  readonly dirtyColliders = new Set<Entity>()
  readonly dirtyJoints = new Set<Entity>()
  readonly dirtyBodies = new Set<Entity>()
  /** Collider entities waiting for their mesh to load. */
  readonly pendingMesh = new Set<Entity>()
  /** Mesh colliders and the mesh version they were built from, to rebuild on hot reload. */
  readonly meshColliders = new Map<Entity, { mesh: Mesh; version: number }>()
  /** Last step's poses (slot × 7: translation, rotation), and the ones before, for interpolation. */
  prev = new Float64Array(7 * 64)
  curr = new Float64Array(7 * 64)
  private freeSlots: number[] = []
  private nextSlot = 0
  /** Ticks: when sync-out last wrote Transforms, and when interpolation did. */
  writeTick = 0
  interpTick = 0
  /** Whether the world had grids at the last sync (spec 0040), so a change resyncs every body. */
  gridsActive = false
  /** Bodies parked out of PhysicsRange. */
  parkedCount = 0
  stepMs = 0
  steps = 0
  readonly config: PhysicsConfigValue
  private readonly scratchPose = createPose()
  private readonly scratchPose2 = createPose()
  readonly v3 = { x: 0, y: 0, z: 0 }
  readonly q4 = { x: 0, y: 0, z: 0, w: 1 }
  readonly rawVec: unknown | undefined
  private readonly ray: InstanceType<Rapier['Ray']>
  private logged = new Set<string>()

  constructor(R: Rapier, dim: 2 | 3, config: PhysicsConfigValue) {
    this.R = R
    this.dim = dim
    this.config = config
    this.raw = new R.World(this.gravityVector())
    this.events = new R.EventQueue(true)
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
    const ops = (R as unknown as { VectorOps?: { intoRaw(v: unknown): unknown } }).VectorOps
    this.rawVec = ops?.intoRaw({ x: 0, y: 0, z: 0 }) as unknown
  }

  gravityVector(): { x: number; y: number; z: number } {
    const g = this.config.gravity
    return { x: g[0], y: g[1], z: g[2] }
  }

  // --- helpers ---------------------------------------------------------------

  /** Writes a vector into the reused {x, y, z} object (Rapier's 2D API ignores z). */
  vec(x: number, y: number, z: number): { x: number; y: number; z: number } {
    this.v3.x = x
    this.v3.y = y
    this.v3.z = z
    return this.v3
  }

  /** A rotation for Rapier from a quaternion at offset o (in 2D, its angle around Z). */
  rotation(q: ArrayLike<number>, o = 0): RAPIER.Rotation {
    if (this.dim === 2) return quatToAngle(q, o) as unknown as RAPIER.Rotation
    this.q4.x = q[o]!
    this.q4.y = q[o + 1]!
    this.q4.z = q[o + 2]!
    this.q4.w = q[o + 3]!
    return this.q4
  }

  /** Logs a problem once per entity and code, so a bad collider doesn't flood the log. */
  report(world: World, entity: Entity, err: ShardError): void {
    const key = `${entity}|${err.code}`
    if (this.logged.has(key)) return
    this.logged.add(key)
    world.tryResource(LogResource)?.error(err)
  }

  /** Slots the interpolation buffers hold. */
  get slotCapacity(): number {
    return this.curr.length / 7
  }

  private allocSlot(): number {
    const slot = this.freeSlots.pop() ?? this.nextSlot++
    if ((slot + 1) * 7 > this.curr.length) {
      const grow = (a: Float64Array) => {
        const b = new Float64Array(a.length * 2)
        b.set(a)
        return b
      }
      this.prev = grow(this.prev)
      this.curr = grow(this.curr)
    }
    return slot
  }

  // --- bodies ----------------------------------------------------------------

  createBody(world: World, entity: Entity): void {
    this.removeBody(world, entity)
    const rb = world.get(entity, RigidBody)
    const R = this.R
    const kind = BODY_KINDS.indexOf(rb.kind)
    const desc =
      kind === KIND_DYNAMIC
        ? R.RigidBodyDesc.dynamic()
        : kind === KIND_FIXED
          ? R.RigidBodyDesc.fixed()
          : kind === KIND_KINEMATIC_POSITION
            ? R.RigidBodyDesc.kinematicPositionBased()
            : R.RigidBodyDesc.kinematicVelocityBased()
    const pose = poseOf(world, entity, this.scratchPose)
    desc.setTranslation(pose[0]!, pose[1]!, pose[2]!)
    desc.setRotation(this.rotation(pose, 3))
    desc.setGravityScale(rb.gravityScale)
    desc.setLinearDamping(rb.linearDamping)
    desc.setAngularDamping(rb.angularDamping)
    desc.setCcdEnabled(rb.ccd)
    desc.setCanSleep(rb.canSleep)
    desc.setDominanceGroup(rb.dominance)
    const [lx, ly, lz] = rb.lockTranslation
    const [rx, ry, rz] = rb.lockRotation
    if (this.dim === 3) {
      if (lx || ly || lz) desc.enabledTranslations(!lx, !ly, !lz)
      if (rx || ry || rz) desc.enabledRotations(!rx, !ry, !rz)
    } else {
      const d2 = desc as unknown as {
        enabledTranslations(x: boolean, y: boolean): void
        lockRotations(): void
      }
      if (lx || ly) d2.enabledTranslations(!lx, !ly)
      if (rz) d2.lockRotations()
    }
    const velocity = world.tryGet(entity, Velocity)
    if (velocity) {
      const [vx, vy, vz] = velocity.linear
      const [ax, ay, az] = velocity.angular
      desc.setLinvel(vx, vy, vz)
      if (this.dim === 3) desc.setAngvel({ x: ax, y: ay, z: az })
      else (desc as unknown as { setAngvel(a: number): void }).setAngvel(az)
    }
    const record = this.addBody(entity, this.raw.createRigidBody(desc), kind)
    // Parked when saved or rebuilt: it stays parked (and keeps its stored velocity) until the
    // range check finds it near the origin.
    if (world.has(entity, PhysicsParked)) {
      record.body.setEnabled(false)
      record.parked = true
      this.parkedCount++
    }
    // Colliders on this entity and on descendants attach to the new body.
    this.markSubtreeColliders(world, entity)
    for (const [jointEntity, j] of this.joints) {
      if (j.a === entity || j.b === entity) this.dirtyJoints.add(jointEntity)
    }
    if (world.has(entity, Joint)) this.dirtyJoints.add(entity)
    for (const e of world.query({ with: [Joint] }).tables) {
      const others = e.column(Joint, 'other')
      for (let i = 0; i < e.count; i++) {
        if (others[i] === entity) this.dirtyJoints.add(e.entities[i]!)
      }
    }
  }

  private addBody(entity: Entity, body: RBody, kind: number): BodyRecord {
    const record: BodyRecord = {
      entity,
      handle: body.handle,
      body,
      kind,
      slot: this.allocSlot(),
      index: this.list.length,
      parked: false,
    }
    this.list.push(record)
    this.bodies.set(entity, record)
    this.bodyByHandle.set(body.handle, record)
    this.storePose(record)
    this.prev.set(this.curr.subarray(record.slot * 7, record.slot * 7 + 7), record.slot * 7)
    return record
  }

  removeBody(world: World, entity: Entity): void {
    const record = this.bodies.get(entity)
    if (!record) return
    const character = this.characters.get(entity)
    if (character) {
      this.raw.removeCharacterController(character.kcc)
      this.characters.delete(entity)
    }
    // Rapier removes the body's colliders and joints with it.
    for (const [collider, owner] of this.colliderOwner) {
      if (owner !== entity) continue
      this.forgetCollider(collider)
      if (world.isAlive(collider) && world.has(collider, Collider)) {
        this.dirtyColliders.add(collider)
      }
    }
    for (const [jointEntity, j] of this.joints) {
      if (j.a !== entity && j.b !== entity) continue
      this.joints.delete(jointEntity)
      if (world.isAlive(jointEntity) && world.has(jointEntity, Joint)) {
        this.dirtyJoints.add(jointEntity)
      }
    }
    this.raw.removeRigidBody(record.body)
    if (record.parked) this.parkedCount--
    const last = this.list.pop()!
    if (last !== record) {
      this.list[record.index] = last
      last.index = record.index
    }
    this.bodies.delete(entity)
    this.bodyByHandle.delete(record.handle)
    this.freeSlots.push(record.slot)
  }

  /** Copies a body's current pose into `curr` at its slot. */
  storePose(record: BodyRecord): void {
    const o = record.slot * 7
    const c = this.curr
    const body = record.body
    const t = body.translation(this.v3 as RAPIER.Vector)
    c[o] = t.x
    c[o + 1] = t.y
    c[o + 2] = this.dim === 3 ? t.z : 0
    if (this.dim === 3) {
      const r = body.rotation(this.q4 as RAPIER.Rotation)
      c[o + 3] = r.x
      c[o + 4] = r.y
      c[o + 5] = r.z
      c[o + 6] = r.w
    } else {
      const angle = body.rotation() as unknown as number
      c[o + 3] = 0
      c[o + 4] = 0
      c[o + 5] = Math.sin(angle / 2)
      c[o + 6] = Math.cos(angle / 2)
    }
  }

  /** Teleports a body (or sets a kinematic target) to the entity's current world pose. */
  moveBody(world: World, record: BodyRecord, wake = true): void {
    const pose = poseOf(world, record.entity, this.scratchPose)
    const body = record.body
    const t = this.vec(pose[0]!, pose[1]!, pose[2]!)
    if (record.kind === KIND_KINEMATIC_POSITION && wake) {
      body.setNextKinematicTranslation(t)
      body.setNextKinematicRotation(this.rotation(pose, 3))
    } else {
      body.setTranslation(t, wake)
      body.setRotation(this.rotation(pose, 3), wake)
    }
    // A teleport shouldn't be interpolated from the old place.
    this.storePose(record)
    this.prev.set(this.curr.subarray(record.slot * 7, record.slot * 7 + 7), record.slot * 7)
  }

  setVelocity(world: World, record: BodyRecord): void {
    const table = world.entityTableUnchecked(record.entity)
    const row = world.entityRowUnchecked(record.entity)
    const lin = table.column(Velocity, 'linear')
    const ang = table.column(Velocity, 'angular')
    const o = row * 3
    record.body.setLinvel(this.vec(lin[o]!, lin[o + 1]!, lin[o + 2]!), true)
    if (this.dim === 3) record.body.setAngvel(this.vec(ang[o]!, ang[o + 1]!, ang[o + 2]!), true)
    else
      (record.body as unknown as { setAngvel(a: number, w: boolean): void }).setAngvel(
        ang[o + 2]!,
        true,
      )
  }

  // --- large worlds (spec 0040) --------------------------------------------------

  /**
   * The floating origin moved: `offset` (m) takes a position in the old origin frame to the new
   * one. Moves every body and free collider by it without waking them (velocities and contacts
   * are relative, so they don't change), shifts the interpolation buffers, and refreshes the
   * broad phase with a zero-length step so queries see the new places before the next step.
   * O(bodies), once per cell crossing.
   */
  shiftOrigin(
    ox: number,
    oy: number,
    oz: number,
    onCollision: (e: CollisionEventData) => void,
  ): void {
    if (ox === 0 && oy === 0 && oz === 0) return
    if (this.dim === 2) oz = 0
    const curr = this.curr
    const prev = this.prev
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!
      const t = r.body.translation(this.v3 as RAPIER.Vector)
      r.body.setTranslation(this.vec(t.x + ox, t.y + oy, this.dim === 3 ? t.z + oz : 0), false)
      const o = r.slot * 7
      curr[o] = curr[o]! + ox
      curr[o + 1] = curr[o + 1]! + oy
      curr[o + 2] = curr[o + 2]! + oz
      prev[o] = prev[o]! + ox
      prev[o + 1] = prev[o + 1]! + oy
      prev[o + 2] = prev[o + 2]! + oz
    }
    // Colliders without a body; ones on bodies moved with them.
    for (const [entity, collider] of this.colliders) {
      if (this.colliderOwner.has(entity)) continue
      const t = collider.translation() as RAPIER.Vector
      collider.setTranslation(this.vec(t.x + ox, t.y + oy, this.dim === 3 ? t.z + oz : 0))
    }
    this.raw.propagateModifiedBodyPositionsToColliders()
    // Queries go through the broad phase, which only a step updates. Nothing moves in a zero-length
    // step; contacts that started since the last step still report.
    this.raw.timestep = 0
    this.raw.step(this.events)
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.colliderEntity.get(h1)
      const b = this.colliderEntity.get(h2)
      if (a === undefined || b === undefined) return
      onCollision({
        kind: started ? 'started' : 'stopped',
        a,
        b,
        bodyA: this.colliderOwner.get(a) ?? (-1 as Entity),
        bodyB: this.colliderOwner.get(b) ?? (-1 as Entity),
        sensor: this.colliders.get(a)!.isSensor() || this.colliders.get(b)!.isSensor(),
      })
    })
    this.events.drainContactForceEvents(() => {})
  }

  /**
   * The frame Rapier simulates in changed without an OriginShift (grids appeared or went away):
   * puts every body and free collider back where its Transform says.
   */
  resync(world: World): void {
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!
      if (world.isAlive(r.entity)) this.moveBody(world, r, false)
    }
    for (const entity of this.colliders.keys()) {
      if (!this.colliderOwner.has(entity)) this.dirtyColliders.add(entity)
    }
  }

  /**
   * Parks bodies farther than `radius` from the origin and brings parked ones back within
   * 0.95 × radius. Active bodies are measured by their last simulated pose, parked ones by their
   * GlobalTransform. Allocation-free unless a body changes state.
   */
  updateParking(world: World, radius: number): void {
    const far = radius * radius
    const near = far * 0.95 * 0.95
    const curr = this.curr
    // Measured from the FloatingOrigin entity (the origin frame's zero is its cell's center).
    let cx = 0
    let cy = 0
    let cz = 0
    const origin = world.tryResource(GridFramesResource)?.originEntity
    if (origin !== undefined && origin >= 0 && world.isAlive(origin)) {
      const table = world.entityTableUnchecked(origin)
      if (table.has(GlobalTransform)) {
        const m = table.column(GlobalTransform, 'matrix')
        const o = world.entityRowUnchecked(origin) * 12
        cx = m[o + 3]!
        cy = m[o + 7]!
        cz = m[o + 11]!
      }
    }
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!
      if (!r.parked) {
        const o = r.slot * 7
        const x = curr[o]! - cx
        const y = curr[o + 1]! - cy
        const z = this.dim === 3 ? curr[o + 2]! - cz : 0
        if (x * x + y * y + z * z > far) this.park(world, r)
        continue
      }
      const table = world.entityTableUnchecked(r.entity)
      if (!table.has(GlobalTransform)) continue
      const m = table.column(GlobalTransform, 'matrix')
      const o = world.entityRowUnchecked(r.entity) * 12
      const x = m[o + 3]! - cx
      const y = m[o + 7]! - cy
      const z = this.dim === 3 ? m[o + 11]! - cz : 0
      if (x * x + y * y + z * z < near) this.unpark(world, r)
    }
  }

  /** Takes a body out of the simulation, storing its velocity on PhysicsParked. */
  park(world: World, record: BodyRecord): void {
    const body = record.body
    const v = body.linvel()
    const linear: [number, number, number] = [v.x, v.y, this.dim === 3 ? v.z : 0]
    const angular: [number, number, number] = [0, 0, 0]
    if (this.dim === 3) {
      const a = body.angvel()
      angular[0] = a.x
      angular[1] = a.y
      angular[2] = a.z
    } else {
      angular[2] = body.angvel() as unknown as number
    }
    body.setEnabled(false)
    record.parked = true
    this.parkedCount++
    world.add(record.entity, PhysicsParked, { linear, angular })
  }

  /** Puts a parked body back where its Transform says, moving with its stored velocity. */
  unpark(world: World, record: BodyRecord): void {
    const body = record.body
    body.setEnabled(true)
    record.parked = false
    this.parkedCount--
    // Straight to its pose (for kinematic bodies too: a target would sweep it there).
    this.moveBody(world, record, false)
    body.wakeUp()
    const stored = world.tryGet(record.entity, PhysicsParked)
    if (stored && record.kind !== KIND_FIXED && record.kind !== KIND_KINEMATIC_POSITION) {
      const [lx, ly, lz] = stored.linear
      const [ax, ay, az] = stored.angular
      body.setLinvel(this.vec(lx, ly, lz), true)
      if (this.dim === 3) body.setAngvel(this.vec(ax, ay, az), true)
      else (body as unknown as { setAngvel(a: number, w: boolean): void }).setAngvel(az, true)
    }
    if (stored) world.remove(record.entity, PhysicsParked)
  }

  /** Grids went away: nothing is out of range any more. */
  unparkAll(world: World): void {
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!
      if (r.parked && world.isAlive(r.entity)) this.unpark(world, r)
    }
  }

  // --- characters ------------------------------------------------------------

  /**
   * (Re)builds a character's kinematic body, capsule collider, and Rapier controller from its
   * CharacterController. The capsule is centered on the entity, its axis along the entity's +Y.
   */
  createCharacter(world: World, entity: Entity): void {
    if (world.has(entity, RigidBody) || world.has(entity, Collider)) {
      this.report(
        world,
        entity,
        new ShardError(
          'physics/character-has-body',
          'A CharacterController entity also has a RigidBody or Collider',
          {
            hint: 'The controller makes its own kinematic body and capsule. Remove RigidBody and Collider, or put extra colliders on a child.',
          },
        ),
      )
      return
    }
    this.removeBody(world, entity)
    const c = world.get(entity, CharacterController)
    const R = this.R
    const pose = poseOf(world, entity, this.scratchPose)
    const desc = R.RigidBodyDesc.kinematicPositionBased()
    desc.setTranslation(pose[0]!, pose[1]!, pose[2]!)
    desc.setRotation(this.rotation(pose, 3))
    const record = this.addBody(entity, this.raw.createRigidBody(desc), KIND_KINEMATIC_POSITION)
    const radius = Math.max(c.radius, 1e-3)
    const halfHeight = Math.max(0, c.height / 2 - radius)
    const shape = halfHeight > 0 ? 'capsule' : 'ball'
    const cdesc =
      halfHeight > 0 ? R.ColliderDesc.capsule(halfHeight, radius) : R.ColliderDesc.ball(radius)
    cdesc.setFriction(0)
    cdesc.setCollisionGroups(((c.layers & 0xffff) << 16) | (c.mask & 0xffff))
    const collider = this.raw.createCollider(cdesc, record.body)
    this.colliders.set(entity, collider)
    this.colliderEntity.set(collider.handle, entity)
    this.colliderShape.set(entity, shape)
    this.colliderOwner.set(entity, entity)

    const kcc = this.raw.createCharacterController(CHARACTER_OFFSET)
    const slope = (Math.min(Math.max(c.maxSlope, 0), 90) * Math.PI) / 180
    kcc.setMaxSlopeClimbAngle(slope)
    kcc.setMinSlopeSlideAngle(slope)
    kcc.setSlideEnabled(true)
    if (c.stepHeight > 0) kcc.enableAutostep(c.stepHeight, radius * 0.5, false)
    if (c.snapDistance > 0) kcc.enableSnapToGround(c.snapDistance)
    this.characters.set(entity, {
      entity,
      body: record,
      collider,
      kcc,
      snapping: c.snapDistance > 0,
      snapDistance: c.snapDistance,
      cosMaxSlope: Math.cos(slope),
      bottom: radius + halfHeight,
    })
    // Colliders on children (a sword, a trigger) ride on the character's body.
    this.markSubtreeColliders(world, entity)
  }

  // --- colliders -------------------------------------------------------------

  private markSubtreeColliders(world: World, entity: Entity): void {
    if (world.has(entity, Collider)) this.dirtyColliders.add(entity)
    const children = world.tryGet(entity, Children)?.entities
    if (!children) return
    for (const child of children) {
      if (child === null || !world.isAlive(child)) continue
      // A descendant with its own body keeps its colliders.
      if (child !== entity && world.has(child, RigidBody)) continue
      this.markSubtreeColliders(world, child)
    }
  }

  /** Marks colliders and bodies under an entity whose place in the hierarchy changed. */
  reparented(world: World, entity: Entity): void {
    if (!world.isAlive(entity)) return
    const walk = (e: Entity) => {
      if (world.has(e, Collider)) this.dirtyColliders.add(e)
      if (this.bodies.has(e)) this.dirtyBodies.add(e)
      const children = world.tryGet(e, Children)?.entities
      if (children) for (const c of children) if (c !== null && world.isAlive(c)) walk(c)
    }
    walk(entity)
  }

  private forgetCollider(entity: Entity): void {
    const collider = this.colliders.get(entity)
    if (!collider) return
    this.colliderEntity.delete(collider.handle)
    this.colliders.delete(entity)
    this.colliderOwner.delete(entity)
    this.colliderShape.delete(entity)
    this.meshColliders.delete(entity)
  }

  removeCollider(entity: Entity): void {
    const collider = this.colliders.get(entity)
    if (!collider) return
    this.forgetCollider(entity)
    this.raw.removeCollider(collider, true)
  }

  /** The nearest ancestor-or-self with a body. */
  ownerOf(world: World, entity: Entity): Entity | undefined {
    let e: Entity | undefined = entity
    while (e !== undefined) {
      if (this.bodies.has(e)) return e
      e = parentOf(world, e)
    }
    return undefined
  }

  createCollider(world: World, entity: Entity): void {
    this.removeCollider(entity)
    this.pendingMesh.delete(entity)
    const c = world.get(entity, Collider)
    const colPose = poseOf(world, entity, this.scratchPose)
    const owner = this.ownerOf(world, entity)
    const sx = Math.abs(colPose[7]!)
    const sy = Math.abs(colPose[8]!)
    const sz = Math.abs(colPose[9]!)
    let mesh: Mesh | undefined
    if (
      (c.shape === 'convex' ||
        c.shape === 'trimesh' ||
        c.shape === 'polyline' ||
        c.shape === 'segment') &&
      c.mesh
    ) {
      mesh = this.meshFor(world, entity, c.mesh)
      if (!mesh) return
    }
    let desc: RColliderDesc | null
    try {
      desc = this.shapeDesc(c, mesh, sx, sy, sz)
    } catch (err) {
      if (err instanceof ShardError) {
        this.report(world, entity, err)
        return
      }
      throw err
    }
    if (!desc) {
      this.report(
        world,
        entity,
        new ShardError('physics/invalid-shape', `Collider "${c.shape}" has no volume or points`, {
          hint: 'Check radius, halfExtents, halfHeight, points, or the mesh.',
        }),
      )
      return
    }
    // Local pose relative to the owner body: rotate the offset into the body's frame.
    if (owner !== undefined) {
      const bodyPose = poseOf(world, owner, this.scratchPose2)
      const dx = colPose[0]! - bodyPose[0]!
      const dy = colPose[1]! - bodyPose[1]!
      const dz = colPose[2]! - bodyPose[2]!
      bodyPose[3] = -bodyPose[3]!
      bodyPose[4] = -bodyPose[4]!
      bodyPose[5] = -bodyPose[5]!
      rotate(colPose, 0, bodyPose, 3, dx, dy, dz)
      mulQuat(colPose, 3, bodyPose, 3, colPose, 3)
    }
    desc.setTranslation(colPose[0]!, colPose[1]!, colPose[2]!)
    desc.setRotation(this.rotation(colPose, 3))
    desc.setFriction(c.friction)
    desc.setRestitution(c.restitution)
    desc.setDensity(c.density)
    desc.setSensor(c.sensor)
    desc.setCollisionGroups(((c.layers & 0xffff) << 16) | (c.mask & 0xffff))
    const R = this.R
    let events = 0
    if (c.events) events |= R.ActiveEvents.COLLISION_EVENTS
    if (c.forceThreshold > 0) {
      events |= R.ActiveEvents.CONTACT_FORCE_EVENTS
      desc.setContactForceEventThreshold(c.forceThreshold)
    }
    if (events) desc.setActiveEvents(events)
    if (c.sensor) {
      // Sensors also notice kinematic bodies (characters) and fixed colliders.
      desc.setActiveCollisionTypes(R.ActiveCollisionTypes.ALL)
    }
    const body = owner !== undefined ? this.bodies.get(owner)!.body : undefined
    const collider = this.raw.createCollider(desc, body)
    this.colliders.set(entity, collider)
    this.colliderEntity.set(collider.handle, entity)
    this.colliderShape.set(entity, c.shape)
    if (owner !== undefined) this.colliderOwner.set(entity, owner)
    if (mesh) this.meshColliders.set(entity, { mesh, version: mesh.version })
    if (owner !== undefined && world.has(owner, Mass)) this.fixMass(world, owner)
  }

  private meshFor(world: World, entity: Entity, ref: AssetRef): Mesh | undefined {
    const mesh = world.tryResource(Meshes)?.get(ref)
    if (mesh) return mesh
    const server = assetServer(world)
    const entry = server.entry(ref)
    if (entry?.state === 'failed') {
      this.report(
        world,
        entity,
        new ShardError('physics/invalid-shape', `The collider's mesh ${ref.path} failed to load`),
      )
      return undefined
    }
    if (entry && entry.state === 'unloaded') void server.request(entry.guid).catch(() => {})
    this.pendingMesh.add(entity)
    return undefined
  }

  /** Scales every collider's density so the body weighs exactly its Mass. */
  fixMass(world: World, owner: Entity): void {
    const record = this.bodies.get(owner)
    if (!record) return
    const target = world.get(owner, Mass).mass
    record.body.setAdditionalMass(0, false)
    record.body.recomputeMassPropertiesFromColliders()
    const current = record.body.mass()
    if (current > 1e-9) {
      const k = target / current
      for (const [entity, o] of this.colliderOwner) {
        if (o !== owner) continue
        const collider = this.colliders.get(entity)!
        collider.setDensity(collider.density() * k)
      }
      record.body.recomputeMassPropertiesFromColliders()
    } else {
      record.body.setAdditionalMass(target, true)
    }
  }

  private shapeDesc(
    c: ReturnType<typeof Collider.defaults>,
    mesh: Mesh | undefined,
    sx: number,
    sy: number,
    sz: number,
  ): RColliderDesc | null {
    const D = this.R.ColliderDesc
    const is2d = this.dim === 2
    const [hx, hy, hz] = c.halfExtents
    switch (c.shape) {
      case 'ball':
        return D.ball(c.radius * Math.max(sx, sy, is2d ? 0 : sz))
      case 'cuboid':
        return is2d
          ? (D as unknown as { cuboid(x: number, y: number): RColliderDesc }).cuboid(
              hx * sx,
              hy * sy,
            )
          : D.cuboid(hx * sx, hy * sy, hz * sz)
      case 'capsule':
        return D.capsule(c.halfHeight * sy, c.radius * (is2d ? sx : Math.max(sx, sz)))
      case 'cylinder':
      case 'cone':
        if (is2d) throw unsupported(c.shape)
        return c.shape === 'cylinder'
          ? D.cylinder(c.halfHeight * sy, c.radius * Math.max(sx, sz))
          : D.cone(c.halfHeight * sy, c.radius * Math.max(sx, sz))
      case 'convex': {
        const points = this.points(c, mesh, sx, sy, sz)
        return points.length < (is2d ? 6 : 12) ? null : D.convexHull(points)
      }
      case 'trimesh': {
        const points = this.points(c, mesh, sx, sy, sz)
        const n = points.length / this.dim
        if (n < 3) return null
        const indices = mesh?.indices
          ? mesh.indices instanceof Uint32Array
            ? mesh.indices
            : Uint32Array.from(mesh.indices)
          : Uint32Array.from({ length: n - (n % 3) }, (_, i) => i)
        return D.trimesh(points, indices)
      }
      case 'polyline': {
        const points = this.points(c, mesh, sx, sy, sz)
        if (points.length < this.dim * 2) return null
        return D.polyline(points, null)
      }
      case 'segment': {
        const p = this.points(c, mesh, sx, sy, sz)
        if (p.length < this.dim * 2) return null
        return is2d
          ? D.segment(
              { x: p[0]!, y: p[1]! } as RAPIER.Vector,
              { x: p[2]!, y: p[3]! } as RAPIER.Vector,
            )
          : D.segment({ x: p[0]!, y: p[1]!, z: p[2]! }, { x: p[3]!, y: p[4]!, z: p[5]! })
      }
      case 'heightfield': {
        const hf = c.heightfield
        const rows = hf.rows
        const cols = hf.cols
        if (is2d) {
          const n = cols || hf.heights.length
          if (n < 2 || hf.heights.length < n) return null
          return (
            D as unknown as {
              heightfield(h: Float32Array, s: { x: number; y: number }): RColliderDesc
            }
          ).heightfield(Float32Array.from(hf.heights.slice(0, n)), {
            x: 2 * hx * sx,
            y: hy * sy,
          })
        }
        if (rows < 2 || cols < 2 || hf.heights.length < rows * cols) return null
        // Rapier wants a column-major (rows × cols) matrix with rows along Z and columns along X.
        const heights = new Float32Array(rows * cols)
        for (let r = 0; r < rows; r++) {
          for (let col = 0; col < cols; col++) heights[col * rows + r] = hf.heights[r * cols + col]!
        }
        return D.heightfield(rows - 1, cols - 1, heights, {
          x: 2 * hx * sx,
          y: hy * sy,
          z: 2 * hz * sz,
        })
      }
    }
    return null
  }

  /** Shape points as a flat array for the current dimension, scaled. */
  private points(
    c: ReturnType<typeof Collider.defaults>,
    mesh: Mesh | undefined,
    sx: number,
    sy: number,
    sz: number,
  ): Float32Array {
    const d = this.dim
    if (mesh) {
      const p = mesh.positions
      const n = p.length / 3
      const out = new Float32Array(n * d)
      for (let i = 0; i < n; i++) {
        out[i * d] = p[i * 3]! * sx
        out[i * d + 1] = p[i * 3 + 1]! * sy
        if (d === 3) out[i * d + 2] = p[i * 3 + 2]! * sz
      }
      return out
    }
    const out = new Float32Array(c.points.length * d)
    c.points.forEach((pt, i) => {
      out[i * d] = pt[0]! * sx
      out[i * d + 1] = pt[1]! * sy
      if (d === 3) out[i * d + 2] = pt[2]! * sz
    })
    return out
  }

  // --- joints ----------------------------------------------------------------

  removeJoint(entity: Entity): void {
    const j = this.joints.get(entity)
    if (!j) return
    this.joints.delete(entity)
    if (this.raw.impulseJoints.contains(j.joint.handle)) this.raw.removeImpulseJoint(j.joint, true)
  }

  createJoint(world: World, entity: Entity): void {
    this.removeJoint(entity)
    const j = world.get(entity, Joint)
    const a = this.bodies.get(entity)
    const other = j.other
    const b = other !== null && other >= 0 ? this.bodies.get(other as Entity) : undefined
    if (!a || !b) return // retried when the missing body appears
    const R = this.R
    const is2d = this.dim === 2
    const anchorA = { x: j.anchor[0], y: j.anchor[1], z: j.anchor[2] }
    const anchorB = { x: j.otherAnchor[0], y: j.otherAnchor[1], z: j.otherAnchor[2] }
    const axis = { x: j.axis[0], y: j.axis[1], z: j.axis[2] }
    const J = R.JointData as unknown as Record<string, (...args: unknown[]) => RAPIER.JointData>
    let data: RAPIER.JointData
    switch (j.kind) {
      case 'fixed': {
        // Keep the bodies' current relative rotation: frame2 = conj(rotB) · rotA.
        if (is2d) {
          const ra = a.body.rotation() as unknown as number
          const rb = b.body.rotation() as unknown as number
          data = J.fixed!(anchorA, 0, anchorB, ra - rb)
        } else {
          const ra = a.body.rotation()
          const rb = b.body.rotation()
          const q = new Float64Array(4)
          mulQuat(q, 0, [-rb.x, -rb.y, -rb.z, rb.w], 0, [ra.x, ra.y, ra.z, ra.w], 0)
          data = J.fixed!(anchorA, { x: 0, y: 0, z: 0, w: 1 }, anchorB, {
            x: q[0],
            y: q[1],
            z: q[2],
            w: q[3],
          })
        }
        break
      }
      case 'revolute':
        data = is2d ? J.revolute!(anchorA, anchorB) : J.revolute!(anchorA, anchorB, axis)
        break
      case 'prismatic':
        data = J.prismatic!(anchorA, anchorB, axis)
        break
      case 'spherical':
        if (is2d) {
          this.report(world, entity, unsupported('spherical joint'))
          return
        }
        data = J.spherical!(anchorA, anchorB)
        break
      case 'rope': {
        let length = j.limits[1]
        if (!(length > 0)) {
          const pa = a.body.translation()
          const pb = b.body.translation()
          length = Math.sqrt(
            (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2 + (is2d ? 0 : (pa.z - pb.z) ** 2),
          )
        }
        data = J.rope!(length, anchorA, anchorB)
        break
      }
    }
    const joint = this.raw.createImpulseJoint(data, a.body, b.body, true)
    const limited = joint as unknown as {
      setLimits?(min: number, max: number): void
      configureMotorVelocity?(v: number, f: number): void
    }
    if ((j.kind === 'revolute' || j.kind === 'prismatic') && j.limits[0] < j.limits[1]) {
      limited.setLimits?.(j.limits[0], j.limits[1])
    }
    if ((j.kind === 'revolute' || j.kind === 'prismatic') && j.motorVelocity !== 0) {
      limited.configureMotorVelocity?.(j.motorVelocity, j.motorFactor)
    }
    this.joints.set(entity, { joint, a: entity, b: other as Entity })
  }

  // --- stepping --------------------------------------------------------------

  step(
    dt: number,
    onCollision: (e: CollisionEventData) => void,
    onForce: (a: Entity, b: Entity, f: number) => void,
  ): void {
    const start = performance.now()
    const g = this.config.gravity
    this.raw.gravity =
      this.dim === 3 ? { x: g[0], y: g[1], z: g[2] } : ({ x: g[0], y: g[1] } as RAPIER.Vector)
    this.raw.timestep = dt
    this.raw.numSolverIterations = this.config.iterations
    this.raw.step(this.events)
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.colliderEntity.get(h1)
      const b = this.colliderEntity.get(h2)
      if (a === undefined || b === undefined) return
      const ca = this.colliders.get(a)!
      const cb = this.colliders.get(b)!
      onCollision({
        kind: started ? 'started' : 'stopped',
        a,
        b,
        bodyA: this.colliderOwner.get(a) ?? (-1 as Entity),
        bodyB: this.colliderOwner.get(b) ?? (-1 as Entity),
        sensor: ca.isSensor() || cb.isSensor(),
      })
    })
    this.events.drainContactForceEvents((event) => {
      const a = this.colliderEntity.get(event.collider1())
      const b = this.colliderEntity.get(event.collider2())
      if (a !== undefined && b !== undefined) onForce(a, b, event.totalForceMagnitude())
    })
    this.stepMs = performance.now() - start
    this.steps++
  }

  // --- queries ---------------------------------------------------------------

  private filter(options: QueryOptions | undefined) {
    const R = this.R
    const flags = options?.sensors ? 0 : R.QueryFilterFlags.EXCLUDE_SENSORS
    const groups =
      (((options?.layers ?? 0xffff) & 0xffff) << 16) | ((options?.mask ?? 0xffff) & 0xffff)
    let excludeCollider: RCollider | undefined
    let excludeBody: RBody | undefined
    if (options?.exclude !== undefined) {
      excludeBody = this.bodies.get(options.exclude)?.body
      if (!excludeBody) excludeCollider = this.colliders.get(options.exclude)
    }
    return { flags, groups, excludeCollider, excludeBody }
  }

  /** The nearest hit along a ray, written into `out`. Direction needn't be normalized. */
  raycast(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    options: QueryOptions | undefined,
    out: RayHit,
  ): boolean {
    const d = this.dim
    let dx = direction[0]!
    let dy = direction[1]!
    let dz = d === 3 ? (direction[2] ?? 0) : 0
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len === 0) return false
    dx /= len
    dy /= len
    dz /= len
    const ray = this.ray
    ray.origin.x = origin[0]!
    ray.origin.y = origin[1]!
    if (d === 3) (ray.origin as RAPIER.Vector).z = origin[2] ?? 0
    ray.dir.x = dx
    ray.dir.y = dy
    if (d === 3) (ray.dir as RAPIER.Vector).z = dz
    const f = this.filter(options)
    const max = options?.maxDistance && options.maxDistance > 0 ? options.maxDistance : 1e9
    const hit = this.raw.castRayAndGetNormal(
      ray,
      max,
      options?.solid ?? true,
      f.flags,
      f.groups,
      f.excludeCollider,
      f.excludeBody,
    )
    if (!hit) return false
    const entity = this.colliderEntity.get(hit.collider.handle)
    if (entity === undefined) return false
    out.entity = entity
    out.body = this.colliderOwner.get(entity) ?? (-1 as Entity)
    out.distance = hit.timeOfImpact
    out.point[0] = origin[0]! + dx * hit.timeOfImpact
    out.point[1] = origin[1]! + dy * hit.timeOfImpact
    out.point[2] = d === 3 ? (origin[2] ?? 0) + dz * hit.timeOfImpact : 0
    out.normal[0] = hit.normal.x
    out.normal[1] = hit.normal.y
    out.normal[2] = d === 3 ? (hit.normal as RAPIER.Vector).z : 0
    return true
  }

  /** Every hit along a ray, nearest first. Cold path. */
  raycastAll(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    options?: QueryOptions,
  ): RayHit[] {
    const d = this.dim
    const dirLen = Math.sqrt(
      direction[0]! ** 2 + direction[1]! ** 2 + (d === 3 ? (direction[2] ?? 0) ** 2 : 0),
    )
    if (dirLen === 0) return []
    const dir = [
      direction[0]! / dirLen,
      direction[1]! / dirLen,
      d === 3 ? (direction[2] ?? 0) / dirLen : 0,
    ]
    const ray = new this.R.Ray(
      { x: origin[0]!, y: origin[1]!, z: origin[2] ?? 0 },
      { x: dir[0]!, y: dir[1]!, z: dir[2]! },
    )
    const f = this.filter(options)
    const hits: RayHit[] = []
    const max = options?.maxDistance && options.maxDistance > 0 ? options.maxDistance : 1e9
    this.raw.intersectionsWithRay(
      ray,
      max,
      options?.solid ?? true,
      (hit) => {
        const entity = this.colliderEntity.get(hit.collider.handle)
        if (entity === undefined) return true
        const h = createRayHit()
        h.entity = entity
        h.body = this.colliderOwner.get(entity) ?? (-1 as Entity)
        h.distance = hit.timeOfImpact
        for (let k = 0; k < 3; k++) h.point[k] = (origin[k] ?? 0) + dir[k]! * hit.timeOfImpact
        h.normal[0] = hit.normal.x
        h.normal[1] = hit.normal.y
        h.normal[2] = d === 3 ? (hit.normal as RAPIER.Vector).z : 0
        hits.push(h)
        return true
      },
      f.flags,
      f.groups,
      f.excludeCollider,
      f.excludeBody,
    )
    return hits.sort((a, b) => a.distance - b.distance)
  }

  private queryShape(q: QueryShape): RShape {
    const R = this.R
    const he = q.halfExtents ?? [0.5, 0.5, 0.5]
    switch (q.shape) {
      case 'ball':
        return new R.Ball(q.radius ?? 0.5)
      case 'cuboid':
        return this.dim === 3
          ? new R.Cuboid(he[0]!, he[1]!, he[2]!)
          : new (R.Cuboid as unknown as new (x: number, y: number) => RShape)(he[0]!, he[1]!)
      case 'capsule':
        return new R.Capsule(q.halfHeight ?? 0.5, q.radius ?? 0.5)
    }
  }

  /** Sweeps a shape along `velocity` × maxDistance; the first hit's entity and distance. */
  shapeCast(
    shape: QueryShape,
    position: ArrayLike<number>,
    rotation: ArrayLike<number>,
    direction: ArrayLike<number>,
    options: QueryOptions | undefined,
    out: RayHit,
  ): boolean {
    const f = this.filter(options)
    const d = this.dim
    const len = Math.sqrt(
      direction[0]! ** 2 + direction[1]! ** 2 + (d === 3 ? (direction[2] ?? 0) ** 2 : 0),
    )
    if (len === 0) return false
    const vel = {
      x: direction[0]! / len,
      y: direction[1]! / len,
      z: d === 3 ? (direction[2] ?? 0) / len : 0,
    }
    const max = options?.maxDistance && options.maxDistance > 0 ? options.maxDistance : 1e9
    const hit = this.raw.castShape(
      { x: position[0]!, y: position[1]!, z: position[2] ?? 0 },
      this.rotation(rotation),
      vel,
      this.queryShape(shape),
      0,
      max,
      true,
      f.flags,
      f.groups,
      f.excludeCollider,
      f.excludeBody,
    )
    if (!hit) return false
    const entity = this.colliderEntity.get(hit.collider.handle)
    if (entity === undefined) return false
    out.entity = entity
    out.body = this.colliderOwner.get(entity) ?? (-1 as Entity)
    out.distance = hit.time_of_impact
    const w = hit.witness1
    out.point[0] = w.x
    out.point[1] = w.y
    out.point[2] = d === 3 ? (w as RAPIER.Vector).z : 0
    const n = hit.normal1
    out.normal[0] = n.x
    out.normal[1] = n.y
    out.normal[2] = d === 3 ? (n as RAPIER.Vector).z : 0
    return true
  }

  /** Calls `visit` for each collider entity containing the point; return false to stop. */
  overlapPoint(
    point: ArrayLike<number>,
    options: QueryOptions | undefined,
    visit: (entity: Entity) => boolean | undefined,
  ): void {
    const f = this.filter(options)
    this.raw.intersectionsWithPoint(
      { x: point[0]!, y: point[1]!, z: point[2] ?? 0 },
      (collider) => {
        const e = this.colliderEntity.get(collider.handle)
        return e === undefined ? true : visit(e) !== false
      },
      f.flags,
      f.groups,
      f.excludeCollider,
      f.excludeBody,
    )
  }

  /** Calls `visit` for each collider entity overlapping the shape; return false to stop. */
  overlapShape(
    shape: QueryShape,
    position: ArrayLike<number>,
    rotation: ArrayLike<number>,
    options: QueryOptions | undefined,
    visit: (entity: Entity) => boolean | undefined,
  ): void {
    const f = this.filter(options)
    this.raw.intersectionsWithShape(
      { x: position[0]!, y: position[1]!, z: position[2] ?? 0 },
      this.rotation(rotation),
      this.queryShape(shape),
      (collider) => {
        const e = this.colliderEntity.get(collider.handle)
        return e === undefined ? true : visit(e) !== false
      },
      f.flags,
      f.groups,
      f.excludeCollider,
      f.excludeBody,
    )
  }

  describe(): PhysicsStats {
    const bodies: Record<string, number> = {}
    let sleeping = 0
    for (const r of this.bodies.values()) {
      if (this.characters.has(r.entity)) continue
      const kind = BODY_KINDS[r.kind]!
      bodies[kind] = (bodies[kind] ?? 0) + 1
      if (r.body.isSleeping()) sleeping++
    }
    const colliders: Record<string, number> = {}
    for (const [entity, shape] of this.colliderShape) {
      if (!this.characters.has(entity)) colliders[shape] = (colliders[shape] ?? 0) + 1
    }
    let contacts = 0
    for (const c of this.colliders.values()) {
      this.raw.contactPairsWith(c, () => {
        contacts++
      })
    }
    return {
      bodies,
      sleeping,
      colliders,
      joints: this.joints.size,
      characters: this.characters.size,
      contacts: contacts / 2,
      stepMs: this.stepMs,
      steps: this.steps,
      pending: this.pendingMesh.size,
      parked: this.parkedCount,
    }
  }

  free(): void {
    this.raw.free()
    this.events.free()
  }
}

function unsupported(what: string): ShardError {
  return new ShardError('physics/unsupported-shape', `2D physics has no ${what}`, {
    hint: '2D shapes: ball, cuboid, capsule, convex, trimesh, heightfield, segment, polyline.',
  })
}

/** Angle around Z of a quaternion (2D rotation). */
export function quatToAngle(q: ArrayLike<number>, o = 0): number {
  return 2 * Math.atan2(q[o + 2]!, q[o + 3]!)
}
