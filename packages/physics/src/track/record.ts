import { ShardError } from '@aethervtt/shard-core'
import type RAPIER from '@dimforge/rapier3d-compat'
import { loadDeterministic3d, type Rapier } from '../rapier'
import { TRACK_VERSION, type Track, type Writable } from './format'
import {
  checkTrackScene,
  sceneHash,
  type TrackCollider,
  type TrackGroup,
  type TrackScene,
} from './scene'

type RBody = InstanceType<Rapier['RigidBody']>
type RCollider = InstanceType<Rapier['Collider']>

/** What a settle rule sees after each step. Reading it allocates nothing. */
export interface SettleView {
  /** The step just simulated, from 1. */
  readonly step: number
  readonly bodyCount: number
  /** 1 where body i sleeps after this step. */
  readonly sleeping: Uint8Array
  /** Body i's pose after this step. */
  pose(body: number, outPos: Writable, outRot: Writable): void
}

/**
 * A change of rules mid-track, applied after the step that returned it (a die that won't settle
 * cocked against a wall: walls off, dice stop touching each other, everyone wakes). Return it
 * once; a rule keeps its own state.
 */
export interface TrackPhase {
  /** New layers and masks for these groups. */
  groups?: { [name: string]: TrackGroup }
  /** These groups collide with nothing from now on. */
  disableGroups?: string[]
  /** Wake every body. */
  wake?: true
}

export type SettleResult = 'continue' | 'done' | TrackPhase
/** Called after every step: end the track, keep going, or change the rules. */
export type Settle = (view: SettleView) => SettleResult
/**
 * A settle rule by name, for recordings in a worker, where a function can't be sent: it takes the
 * recording's parameters and returns a fresh `Settle` for it.
 */
export type SettleRule = (params: unknown) => Settle

/** Done once every body sleeps. */
export const settleWhenAsleep: Settle = (view) => {
  for (let i = 0; i < view.bodyCount; i++) if (view.sleeping[i] === 0) return 'continue'
  return 'done'
}

/** The rules every worker knows: `sleep` ends the track when every body sleeps. */
export const builtinSettleRules: { [name: string]: SettleRule } = {
  sleep: () => settleWhenAsleep,
}

export interface TrackContactOptions {
  /** Contacts weaker than this (N) aren't recorded. */
  minForce: number
  /** A pair touching again within this many steps is the same contact (default 3). */
  dedupeSteps?: number
  /** Stop recording contacts after this many (default 1024). */
  max?: number
}

export interface RecordTrackOptions {
  /** Aborting it rejects the recording with `physics/track-cancelled` within one chunk. */
  signal?: AbortSignal
  /** Default: done when every body sleeps. */
  settle?: Settle
  /** Record contacts (default: none). */
  contacts?: TrackContactOptions
}

/** Steps run between yields at most this many at a time, and for about this long. */
export const TRACK_CHUNK_STEPS = 64
export const TRACK_CHUNK_MS = 4

export function trackCancelled(): ShardError {
  return new ShardError('physics/track-cancelled', 'The track recording was cancelled', {
    hint: 'Its signal was aborted or its client disposed: nothing to fix, record again when needed.',
  })
}

// A macrotask without setTimeout's 4 ms clamp: setImmediate in Node, a MessageChannel elsewhere.
const host = globalThis as unknown as {
  setImmediate?: (fn: () => void) => unknown
  MessageChannel?: typeof MessageChannel
}
let channel: MessageChannel | undefined
const waiting: (() => void)[] = []

function yieldTask(): Promise<void> {
  if (host.setImmediate) return new Promise((resolve) => host.setImmediate!(resolve))
  if (!channel) {
    channel = new host.MessageChannel!()
    channel.port1.onmessage = () => waiting.shift()?.()
  }
  return new Promise((resolve) => {
    waiting.push(resolve)
    channel!.port2.postMessage(0)
  })
}

const ALL_GROUPS = 0xffffffff

const packGroups = (g: TrackGroup) => (((g.layers & 0xffff) << 16) | (g.mask & 0xffff)) >>> 0

function colliderDesc(
  R: Rapier,
  c: TrackCollider,
  path: string,
): InstanceType<Rapier['ColliderDesc']> {
  const D = R.ColliderDesc
  let desc: InstanceType<Rapier['ColliderDesc']> | null
  if (c.shape === 'ball') desc = D.ball(c.radius!)
  else if (c.shape === 'cuboid')
    desc = D.cuboid(c.halfExtents![0], c.halfExtents![1], c.halfExtents![2])
  else desc = D.convexHull(c.points!)
  if (!desc) {
    throw new ShardError(
      'physics/track-scene',
      `${path} has no volume: its convex points all lie in one plane`,
      { path, hint: 'See TrackScene in @aethervtt/shard-physics/track.' },
    )
  }
  if (c.translation) desc.setTranslation(c.translation[0], c.translation[1], c.translation[2])
  if (c.rotation) {
    const [x, y, z, w] = c.rotation
    desc.setRotation({ x, y, z, w })
  }
  desc.setFriction(c.friction)
  desc.setRestitution(c.restitution)
  desc.setDensity(c.density)
  return desc
}

/**
 * Records a track: builds a deterministic Rapier world from the scene, in body order, and writes
 * every body's pose at every step, step 0 included, until `settle` says done or maxSteps. Steps
 * run in chunks with a macrotask between them, where `signal` is checked. Needs no ECS and no
 * renderer: it runs the same in a worker, in Node, or inline.
 */
export async function recordTrack(
  scene: TrackScene,
  options: RecordTrackOptions = {},
): Promise<Track> {
  const { signal } = options
  checkTrackScene(scene)
  if (signal?.aborted) throw trackCancelled()
  const R = await loadDeterministic3d()
  if (signal?.aborted) throw trackCancelled()
  const settle = options.settle ?? settleWhenAsleep
  const n = scene.bodies.length
  const maxSteps = scene.maxSteps
  const g = scene.gravity
  const world = new R.World({ x: g[0], y: g[1], z: g[2] })
  const events = new R.EventQueue(true)
  try {
    world.timestep = scene.step
    const groups = new Map<string, number>()
    const inGroup = new Map<string, RCollider[]>()
    for (const [name, group] of Object.entries(scene.groups ?? {})) {
      groups.set(name, packGroups(group))
      inGroup.set(name, [])
    }
    const addCollider = (c: TrackCollider, path: string, body?: RBody): RCollider => {
      const desc = colliderDesc(R, c, path)
      desc.setCollisionGroups(c.group === undefined ? ALL_GROUPS : groups.get(c.group)!)
      if (body && options.contacts) {
        desc.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        desc.setContactForceEventThreshold(options.contacts.minForce)
      }
      const collider = world.createCollider(desc, body)
      if (c.group !== undefined) inGroup.get(c.group)!.push(collider)
      return collider
    }
    scene.fixed.forEach((c, i) => {
      addCollider(c, `fixed[${i}]`)
    })
    const bodies: RBody[] = []
    /** Collider handle → body index, for contacts. */
    const bodyOf = new Map<number, number>()
    scene.bodies.forEach((b, i) => {
      const [x, y, z, w] = b.rotation
      const desc = R.RigidBodyDesc.dynamic()
        .setTranslation(b.translation[0], b.translation[1], b.translation[2])
        .setRotation({ x, y, z, w })
        .setLinvel(b.linear[0], b.linear[1], b.linear[2])
        .setAngvel({ x: b.angular[0], y: b.angular[1], z: b.angular[2] })
        .setCcdEnabled(b.ccd ?? false)
        .setCanSleep(b.canSleep ?? true)
        .setLinearDamping(b.linearDamping ?? 0)
        .setAngularDamping(b.angularDamping ?? 0)
      const body = world.createRigidBody(desc)
      bodies.push(body)
      b.colliders.forEach((c, j) => {
        bodyOf.set(addCollider(c, `bodies[${i}].colliders[${j}]`, body).handle, i)
      })
    })

    // Poses grow by doubling, up to maxSteps + 1 of them.
    let capacity = Math.min(maxSteps + 1, 256)
    let positions = new Float32Array(capacity * n * 3)
    let rotations = new Float32Array(capacity * n * 4)
    const v3 = { x: 0, y: 0, z: 0 }
    const q4 = { x: 0, y: 0, z: 0, w: 1 }
    const writePoses = (s: number): void => {
      if (s >= capacity) {
        capacity = Math.min(maxSteps + 1, capacity * 2)
        const p = new Float32Array(capacity * n * 3)
        p.set(positions)
        positions = p
        const r = new Float32Array(capacity * n * 4)
        r.set(rotations)
        rotations = r
      }
      for (let i = 0; i < n; i++) {
        const body = bodies[i]!
        const t = body.translation(v3 as RAPIER.Vector)
        const r = body.rotation(q4 as RAPIER.Rotation)
        const o3 = (s * n + i) * 3
        const o4 = (s * n + i) * 4
        positions[o3] = t.x
        positions[o3 + 1] = t.y
        positions[o3 + 2] = t.z
        rotations[o4] = r.x
        rotations[o4 + 1] = r.y
        rotations[o4 + 2] = r.z
        rotations[o4 + 3] = r.w
        // x - x is 0 for every finite x, NaN otherwise, and NaN spreads through the sum.
        const bad = t.x - t.x + (t.y - t.y) + (t.z - t.z)
        if (bad + (r.x - r.x) + (r.y - r.y) + (r.z - r.z) + (r.w - r.w) !== 0) {
          throw new ShardError(
            'physics/track-diverged',
            `Body "${scene.bodies[i]!.id}" left finite numbers at step ${s}`,
            {
              path: `bodies[${i}]`,
              hint: 'Check its speed, mass and colliders; a smaller step or ccd can help.',
            },
          )
        }
      }
    }

    let step = 0
    const sleeping = new Uint8Array(n)
    const view: SettleView = {
      get step() {
        return step
      },
      bodyCount: n,
      sleeping,
      pose(body, outPos, outRot) {
        const o3 = (step * n + body) * 3
        const o4 = (step * n + body) * 4
        outPos[0] = positions[o3]!
        outPos[1] = positions[o3 + 1]!
        outPos[2] = positions[o3 + 2]!
        outRot[0] = rotations[o4]!
        outRot[1] = rotations[o4 + 1]!
        outRot[2] = rotations[o4 + 2]!
        outRot[3] = rotations[o4 + 3]!
      },
    }
    const applyPhase = (phase: TrackPhase): void => {
      const changed = new Set<string>()
      for (const [name, group] of Object.entries(phase.groups ?? {})) {
        if (!groups.has(name)) throw unknownGroup(name, step)
        groups.set(name, packGroups(group))
        changed.add(name)
      }
      for (const name of phase.disableGroups ?? []) {
        if (!groups.has(name)) throw unknownGroup(name, step)
        groups.set(name, 0)
        changed.add(name)
      }
      for (const name of changed) {
        for (const c of inGroup.get(name)!) c.setCollisionGroups(groups.get(name)!)
      }
      if (phase.wake) for (const body of bodies) body.wakeUp()
    }

    // Contacts, deduplicated per pair: the last step each pair was seen touching.
    const contacts = options.contacts
    const maxContacts = contacts?.max ?? 1024
    const dedupe = contacts?.dedupeSteps ?? 3
    const lastSeen = new Map<number, number>()
    const cSteps: number[] = []
    const cA: number[] = []
    const cB: number[] = []
    const cForce: number[] = []
    const onForce = (e: InstanceType<Rapier['TempContactForceEvent']>): void => {
      let a = bodyOf.get(e.collider1()) ?? -1
      let b = bodyOf.get(e.collider2()) ?? -1
      if (a < 0 || (b >= 0 && b < a)) {
        const swap = a
        a = b
        b = swap
      }
      if (a < 0) return
      const key = a * 65536 + b + 1
      const last = lastSeen.get(key)
      lastSeen.set(key, step)
      if ((last !== undefined && step - last <= dedupe) || cSteps.length >= maxContacts) return
      cSteps.push(step)
      cA.push(a)
      cB.push(b)
      cForce.push(e.totalForceMagnitude())
    }

    writePoses(0)
    let settled = false
    let simulationMs = 0
    while (!settled && step < maxSteps) {
      const start = performance.now()
      for (let k = 0; k < TRACK_CHUNK_STEPS && step < maxSteps; k++) {
        world.step(events)
        step++
        if (contacts) events.drainContactForceEvents(onForce)
        writePoses(step)
        for (let i = 0; i < n; i++) sleeping[i] = bodies[i]!.isSleeping() ? 1 : 0
        const result = settle(view)
        if (result === 'done') {
          settled = true
          break
        }
        if (typeof result === 'object') applyPhase(result)
        if (performance.now() - start >= TRACK_CHUNK_MS) break
      }
      simulationMs += performance.now() - start
      if (settled || step >= maxSteps) break
      await yieldTask()
      if (signal?.aborted) throw trackCancelled()
    }

    const poses = (step + 1) * n
    return {
      version: TRACK_VERSION,
      engine: `rapier3d-deterministic@${R.version()}`,
      sceneHash: sceneHash(scene),
      step: scene.step,
      steps: step,
      bodyCount: n,
      settled,
      maxStepsHit: !settled,
      positions: positions.slice(0, poses * 3),
      rotations: rotations.slice(0, poses * 4),
      contacts: {
        steps: Uint16Array.from(cSteps),
        a: Int16Array.from(cA),
        b: Int16Array.from(cB),
        force: Float32Array.from(cForce),
      },
      simulationMs,
    }
  } finally {
    world.free()
    events.free()
  }
}

function unknownGroup(name: string, step: number): ShardError {
  return new ShardError(
    'physics/track-scene',
    `A settle phase at step ${step} names group "${name}", which isn't in scene.groups`,
    { path: 'groups' },
  )
}
