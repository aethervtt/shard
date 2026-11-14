import type { Entity, World } from '@aethervtt/shard-core'
import {
  Collider,
  Physics,
  PhysicsConfig,
  PhysicsDisabled,
  physics3dPlugin,
  RigidBody,
} from '@aethervtt/shard-physics'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { impulseShares, type RagdollBinding } from './binding'
import { qmul, qmulConj } from './math'
import { makeSlot } from './sim'

export interface CheckOptions {
  /** Random hits (default 100). */
  trials?: number
  seed?: number
  /** Impulse range, N·s (default 50 to 500). */
  min?: number
  max?: number
  /** Seconds each hit settles (default 4). */
  settle?: number
  /** Solver iterations (PhysicsConfig.iterations; default Rapier's 4). */
  iterations?: number
  /** Extra iterations for the ragdoll's bodies (default 12, as RagdollBudget's). */
  solverIterations?: number
}

export interface CheckResult {
  trials: number
  /** Bodies whose pose went NaN. */
  nan: number
  /** Joints more than 2 cm under the ground once settled. */
  below: number
  /** The worst amount a joint ended past its limits (deg), and which. */
  worstPastLimitDeg: number
  worstJoint: string
  ok: boolean
}

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

const f1 = new Float64Array(4)
const f2 = new Float64Array(4)
const r = new Float64Array(4)
const q = new Float64Array(4)

/**
 * How far past its limits each joint is now (deg, the worst): the parent's joint frame against the
 * child's, per axis, as Rapier measures it (sin of half the angle about each axis).
 */
export function pastLimits(
  world: World,
  b: RagdollBinding,
  bodies: Entity[],
): { deg: number; joint: string } {
  const p = world.resource(Physics)
  let worst = 0
  let joint = ''
  for (let i = 0; i < b.count; i++) {
    const pi = b.parent[i]!
    if (pi < 0) continue
    const c = p.bodies.get(bodies[i]!)?.body.rotation()
    const pr = p.bodies.get(bodies[pi]!)?.body.rotation()
    if (!c || !pr) continue
    q[0] = c.x
    q[1] = c.y
    q[2] = c.z
    q[3] = c.w
    qmul(f1, 0, q, 0, b.frame, i * 4)
    q[0] = pr.x
    q[1] = pr.y
    q[2] = pr.z
    q[3] = pr.w
    qmul(f2, 0, q, 0, b.otherFrame, i * 4)
    qmulConj(r, 0, f1, 0, f2, 0)
    if (r[3]! < 0) for (let k = 0; k < 4; k++) r[k] = -r[k]!
    for (let k = 0; k < 3; k++) {
      const lo = b.limits[i * 6 + k * 2]!
      const hi = b.limits[i * 6 + k * 2 + 1]!
      if (lo >= hi) continue
      const a = 2 * Math.asin(Math.max(-1, Math.min(1, r[k]!)))
      const past = Math.max(lo - a, a - hi, 0) * (180 / Math.PI)
      if (past > worst) {
        worst = past
        joint = `${b.asset.bodies[i]!.joint} axis ${'xyz'[k]} at ${Math.round((a * 180) / Math.PI)}° [${Math.round((lo * 180) / Math.PI)}, ${Math.round((hi * 180) / Math.PI)}]`
      }
    }
  }
  return { deg: worst, joint }
}

/**
 * Hits a ragdoll at random headless (0117): each trial stands its bodies at rest on a ground,
 * spreads a random impulse from a random body as a game's hit does, lets it settle, and records
 * NaNs, joints under the ground, and how far joints end past their limits.
 */
export async function checkRagdoll(
  b: RagdollBinding,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const trials = options.trials ?? 100
  const min = options.min ?? 50
  const max = options.max ?? 500
  const steps = Math.round((options.settle ?? 4) * 60)
  const app = new App().addPlugin(TransformPlugin, physics3dPlugin({ deterministic: true }))
  await app.init()
  const world = app.world
  if (options.iterations) world.resource(PhysicsConfig).iterations = options.iterations
  world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [50, 0.5, 50], friction: 0.9 }],
    [Transform, { translation: [0, -0.5, 0] }],
  )
  const slot = makeSlot(world, b, options.solverIterations ?? 12)
  app.update(1 / 60)
  const random = rng(options.seed ?? 1)
  const shares = new Float32Array(b.count)
  let nan = 0
  let below = 0
  let worst = 0
  let worstJoint = ''
  // The lowest joint at rest stands on the ground.
  let low = Number.POSITIVE_INFINITY
  for (let i = 0; i < b.count; i++) low = Math.min(low, b.rest[i * 7 + 1]!)
  const lift = Math.max(0, -low) + 0.08
  try {
    for (let t = 0; t < trials; t++) {
      for (let i = 0; i < b.count; i++) {
        const o = i * 7
        world.set(slot.bodies[i]!, Transform, {
          translation: [b.rest[o]!, b.rest[o + 1]! + lift, b.rest[o + 2]!],
          rotation: [b.rest[o + 3]!, b.rest[o + 4]!, b.rest[o + 5]!, b.rest[o + 6]!],
          scale: [1, 1, 1],
        })
        if (world.has(slot.bodies[i]!, PhysicsDisabled))
          world.remove(slot.bodies[i]!, PhysicsDisabled)
      }
      const p = world.resource(Physics)
      const hit = Math.floor(random() * b.count)
      const mag = min + random() * (max - min)
      const a = random() * Math.PI * 2
      const up = random() * 0.6 - 0.1
      impulseShares(b, hit, b.asset.reactions.falloff, shares)
      for (let i = 0; i < b.count; i++) {
        const w = shares[i]! * mag
        p.bodies
          .get(slot.bodies[i]!)
          ?.body.applyImpulse({ x: Math.cos(a) * w, y: up * w, z: Math.sin(a) * w }, true)
      }
      for (let f = 0; f < steps; f++) app.update(1 / 60)
      for (const e of slot.bodies) {
        const tr = p.bodies.get(e)!.body.translation()
        if (!Number.isFinite(tr.x + tr.y + tr.z)) nan++
        else if (tr.y < -0.02) below++
      }
      const past = pastLimits(world, b, slot.bodies)
      if (past.deg > worst) {
        worst = past.deg
        worstJoint = past.joint
      }
      for (const e of slot.bodies) world.add(e, PhysicsDisabled)
      app.update(1 / 60)
    }
  } finally {
    await app.dispose()
  }
  const worstPastLimitDeg = Math.round(worst * 10) / 10
  return {
    trials,
    nan,
    below,
    worstPastLimitDeg,
    worstJoint,
    ok: nan === 0 && below === 0 && worstPastLimitDeg <= 5,
  }
}
