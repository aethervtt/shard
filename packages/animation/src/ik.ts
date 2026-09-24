import {
  type ComponentDef,
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  findComponent,
  findResource,
  type ResourceDef,
  ShardError,
  type Table,
  t,
  type World,
} from '@shard/core'
import { defineOverlay, findModelRoot } from '@shard/render'
import { LogResource } from '@shard/runtime'
import { GlobalTransform, propagateSubtree, Transform } from '@shard/transform'
import {
  arg,
  isAncestor,
  parentOf,
  parentRotation,
  qaxisAngle,
  qcopy,
  qfromTo,
  qidentity,
  qmul,
  qmulConj,
  qslerp,
  quatId,
  readPosition,
  readRotation,
  readWorld,
  vec,
  vnormalize,
  vrotate,
  vsub,
  writeRotation,
} from './ik-math'

// --- components ------------------------------------------------------------------------------

const JOINT_PATH =
  'Resolved under this entity or its nearest ancestor that has the path (put IK on the model root, or on an entity under it), so it works on generated model joints and again after the model respawns:'

const weightField = () =>
  t.f32({
    default: 1,
    min: 0,
    max: 1,
    description: 'How much the solution counts: slerps each joint from its animated rotation.',
  })

export const TwoBoneIk = defineComponent(
  'animation/TwoBoneIk',
  {
    root: t.string({
      description: `The upper joint (thigh, upper arm). ${JOINT_PATH} "Armature/Hips/UpLeg_L".`,
    }),
    mid: t.string({ description: 'The joint that bends (knee, elbow), under root. A path.' }),
    tip: t.string({ description: 'The end (ankle, wrist), under mid. A path.' }),
    target: t.entity({ description: 'Where the tip goes (its world position).' }),
    pole: t.entity({
      description: 'The mid joint bends toward this. None: keeps the current bend plane.',
    }),
    weight: weightField(),
    tipRotation: t.f32({
      min: 0,
      max: 1,
      description:
        "How much the tip takes the target's world rotation (1 for feet FootPlacement aligns to the ground). 0: the tip keeps its animated local rotation.",
    }),
  },
  {
    description:
      'Two-bone IK (legs, arms): puts tip on target by rotating root and mid, bending toward pole. Solved after the animated pose, before rendering.',
  },
)

export const LookAtIk = defineComponent(
  'animation/LookAtIk',
  {
    joint: t.string({
      description: `The joint that aims: a head, an eye, a turret. ${JOINT_PATH} "Armature/Hips/Spine/Neck/Head".`,
    }),
    target: t.entity({ description: 'What it looks at (its world position).' }),
    axis: t.vec3({
      default: [0, 0, -1],
      description: "The joint's forward in its own frame (-Z by default).",
    }),
    maxAngle: t.f32({
      default: 70,
      min: 0,
      max: 180,
      unit: 'deg',
      description: 'The most it turns away from the animated forward.',
    }),
    weight: weightField(),
    chain: t.list(
      t.struct({
        joint: t.string({ description: 'Path of a joint above joint (spine, neck).' }),
        share: t.f32({ description: 'Part of the turn this joint takes (0 to 1).' }),
      }),
      {
        description:
          'Joints above that share the turn, top first: [{ "joint": "Spine", "share": 0.2 }, { "joint": "Neck", "share": 0.3 }]. The joint aims the rest of the way.',
      },
    ),
  },
  {
    description:
      'Turns a joint (and a share of the joints above it) to face a target, clamped to maxAngle.',
  },
)

export const ChainIk = defineComponent(
  'animation/ChainIk',
  {
    root: t.string({
      description: `The first joint of the chain (it stays put). ${JOINT_PATH} "Body/Tail0".`,
    }),
    tip: t.string({ description: 'The last joint, under root: a tail or tentacle tip. A path.' }),
    target: t.entity({ description: 'Where the tip goes.' }),
    iterations: t.u8({ default: 10, min: 1, description: 'FABRIK passes at most.' }),
    tolerance: t.f32({
      default: 0.001,
      min: 0,
      unit: 'm',
      description: 'Stops once the tip is this close to the target.',
    }),
    weight: weightField(),
  },
  {
    description:
      'FABRIK over every joint from root to tip (tails, tentacles, spines), with segment lengths from the current pose.',
  },
)

export const FootPlacement = defineComponent(
  'animation/FootPlacement',
  {
    feet: t.list(
      t.struct({
        ik: t.entity({ description: 'The entity with this leg’s animation/TwoBoneIk.' }),
        footJoint: t.string({ description: 'Path of the ankle joint (usually the IK tip).' }),
        offset: t.f32({
          unit: 'm',
          description: 'Height of the ankle above the sole in the animated pose.',
        }),
      }),
      { description: 'One entry per leg.' },
    ),
    hips: t.string({
      description: `The joint lowered so the lowest foot reaches the ground. ${JOINT_PATH} "Armature/Hips".`,
    }),
    maxStep: t.f32({
      default: 0.4,
      min: 0,
      unit: 'm',
      description: 'How far a foot moves up or down, and the hips down, at most.',
    }),
    mask: t.u32({
      default: 0xffffffff,
      description: 'Collision layers the foot rays hit.',
    }),
    weight: weightField(),
  },
  {
    description:
      "Plants feet on uneven ground: casts down from each animated foot along this entity's up (physics), lowers the hips for the lowest foot (never raises them), and puts each leg's IK target on the ground, turned to its normal. Put it on the model root, level with the soles.",
  },
)

// --- solver state ----------------------------------------------------------------------------

const KIND_TWO_BONE = 0
const KIND_LOOK_AT = 1
const KIND_CHAIN = 2
const KIND_FEET = 3
const KIND_NAMES = ['two-bone', 'look-at', 'chain', 'feet'] as const

interface Solver {
  kind: number
  entity: Entity
  /** The paths the joints were resolved from, to notice edits. */
  names: string[]
  list: unknown
  resolved: boolean
  /** Frame to try again when a joint wasn't there (models spawn late). */
  retryAt: number
  /** Feet: each foot's ankle joint. */
  feetJoints: Int32Array
  ok: boolean
  problem: ShardError | null
  /** Joints the solver writes, top first (the first is the top of the changed subtree). */
  joints: Int32Array
  count: number
  /** Each written joint's value before IK (rotation, or the hips' translation). */
  saved: Float64Array
  written: Uint8Array
  /** Tick of the last write, so an un-animated joint gets its pose back before the next solve. */
  writtenAt: number
  // Scratch sized to the chain.
  pos: Float64Array
  rot: Float64Array
  next: Float64Array
  len: Float64Array
  // Results, for describe and the overlay.
  error: number
  iterations: number
  clamped: boolean
  solved: boolean
  /** Feet: per foot origin (3), hit (3), normal (3), hit? (1). */
  rays: Float64Array
  hipsDrop: number
  /** Feet: the body whose colliders the rays skip. */
  exclude: Entity
}

export interface IkState {
  solvers: Map<Entity, Solver>[]
  frame: number
}

export const IkStateResource = defineResource<IkState>('animation/IkState', {
  description: 'IK solvers: resolved joints, the pose before IK, and last results. Internal.',
  init: () => ({ solvers: [new Map(), new Map(), new Map(), new Map()], frame: 0 }),
})

function createSolver(kind: number, entity: Entity): Solver {
  return {
    kind,
    entity,
    names: [],
    list: undefined,
    resolved: false,
    retryAt: 0,
    feetJoints: new Int32Array(2),
    ok: false,
    problem: null,
    joints: new Int32Array(4),
    count: 0,
    saved: new Float64Array(16),
    written: new Uint8Array(4),
    writtenAt: -1,
    pos: new Float64Array(12),
    rot: new Float64Array(16),
    next: new Float64Array(12),
    len: new Float64Array(4),
    error: Number.NaN,
    iterations: 0,
    clamped: false,
    solved: false,
    rays: new Float64Array(20),
    hipsDrop: 0,
    exclude: -1 as Entity,
  }
}

/** Sizes a solver's arrays for n joints. Cold. */
function sizeFor(s: Solver, n: number): void {
  if (s.joints.length < n) {
    s.joints = new Int32Array(n)
    s.saved = new Float64Array(n * 4)
    s.written = new Uint8Array(n)
    s.pos = new Float64Array(n * 3)
    s.rot = new Float64Array(n * 4)
    s.next = new Float64Array(n * 3)
    s.len = new Float64Array(n)
  }
  s.count = n
}

// --- resolving joints (cold: when paths change, joints die, or a retry is due) ---------------

let modelCache: { entity: Entity; frame: number; roots: Map<string, Map<string, Entity> | null> } =
  {
    entity: -1 as Entity,
    frame: -1,
    roots: new Map(),
  }

/** The joint at `path` under `entity` or its nearest ancestor that has it, or -1. */
function jointAt(world: World, entity: Entity, path: string, frame: number): Entity {
  if (!path) return -1 as Entity
  if (modelCache.entity !== entity || modelCache.frame !== frame) {
    modelCache = { entity, frame, roots: new Map() }
  }
  let paths = modelCache.roots.get(path)
  if (paths === undefined) {
    paths = findModelRoot(world, entity, path)?.paths ?? null
    modelCache.roots.set(path, paths)
  }
  const joint = paths?.get(path)
  return joint !== undefined && world.isAlive(joint) && world.has(joint, Transform)
    ? joint
    : (-1 as Entity)
}

function unknownJoint(name: string, e: Entity, field: string, path: string): ShardError {
  return new ShardError(
    'ik/unknown-joint',
    path
      ? `${name} on entity ${e}: no joint at "${path}" (${field}) under it or its ancestors`
      : `${name} on entity ${e}: "${field}" is empty`,
    {
      hint: 'Joint fields are paths under the IK entity or an ancestor (the model root): "Armature/Hips/UpLeg_L". animation_describe on the model lists what bound.',
      path: `/${field}`,
    },
  )
}

function notAChain(name: string, e: Entity, what: string): ShardError {
  return new ShardError('ik/not-a-chain', `${name} on entity ${e}: ${what}`, {
    hint: 'Each joint must be an ancestor of the next (root → mid → tip; chain entries top first, above the joint).',
  })
}

/** Records a solver's problem (logging it once, not on every retry); returns whether it's usable. */
function report(world: World, s: Solver, problem: ShardError | null, frame: number): boolean {
  if (problem && problem.message !== s.problem?.message)
    world.tryResource(LogResource)?.error(problem)
  s.problem = problem
  s.ok = problem === null
  s.resolved = true
  s.retryAt = frame + 30
  return s.ok
}

function resolveTwoBone(world: World, s: Solver, frame: number, names: string[]): boolean {
  sizeFor(s, 3)
  const fields = ['root', 'mid', 'tip']
  for (let k = 0; k < 3; k++) {
    const j = jointAt(world, s.entity, names[k]!, frame)
    if (j < 0)
      return report(world, s, unknownJoint('TwoBoneIk', s.entity, fields[k]!, names[k]!), frame)
    s.joints[k] = j
  }
  const root = s.joints[0]! as Entity
  const mid = s.joints[1]! as Entity
  const tip = s.joints[2]! as Entity
  const ok =
    root !== mid && mid !== tip && isAncestor(world, root, mid) && isAncestor(world, mid, tip)
  return report(
    world,
    s,
    ok ? null : notAChain('TwoBoneIk', s.entity, 'root, mid, and tip are not one chain'),
    frame,
  )
}

function resolveChain(world: World, s: Solver, frame: number, names: string[]): boolean {
  const root = jointAt(world, s.entity, names[0]!, frame)
  if (root < 0) return report(world, s, unknownJoint('ChainIk', s.entity, 'root', names[0]!), frame)
  const tip = jointAt(world, s.entity, names[1]!, frame)
  if (tip < 0) return report(world, s, unknownJoint('ChainIk', s.entity, 'tip', names[1]!), frame)
  const path: Entity[] = []
  let cur = tip
  for (let guard = 0; guard < 256; guard++) {
    path.push(cur)
    if (cur === root) break
    cur = parentOf(world, cur)
    if (cur < 0 || !world.isAlive(cur)) break
  }
  if (path[path.length - 1] !== root || path.length < 2) {
    sizeFor(s, 0)
    return report(world, s, notAChain('ChainIk', s.entity, 'root is not an ancestor of tip'), frame)
  }
  path.reverse()
  sizeFor(s, path.length)
  for (let k = 0; k < path.length; k++) s.joints[k] = path[k]!
  return report(world, s, null, frame)
}

interface ChainEntry {
  joint: string
  share: number
}

function resolveLookAt(world: World, s: Solver, frame: number, names: string[]): boolean {
  const n = names.length
  sizeFor(s, n)
  for (let k = 0; k < n; k++) {
    const j = jointAt(world, s.entity, names[k]!, frame)
    const field = k === n - 1 ? 'joint' : `chain/${k}/joint`
    if (j < 0) return report(world, s, unknownJoint('LookAtIk', s.entity, field, names[k]!), frame)
    s.joints[k] = j
  }
  for (let k = 0; k < n - 1; k++) {
    const below = s.joints[k + 1]! as Entity
    if (s.joints[k] === below || !isAncestor(world, s.joints[k]! as Entity, below)) {
      return report(
        world,
        s,
        notAChain(
          'LookAtIk',
          s.entity,
          `chain/${k} is not above ${k + 1 < n - 1 ? `chain/${k + 1}` : 'joint'}`,
        ),
        frame,
      )
    }
  }
  return report(world, s, null, frame)
}

interface FootEntry {
  ik: Entity | null
  footJoint: string
  offset: number
}

let physicsWorld: ResourceDef<unknown> | null | undefined

function resolveFeet(
  world: World,
  s: Solver,
  frame: number,
  names: string[],
  feet: FootEntry[],
): boolean {
  sizeFor(s, 1)
  if (s.rays.length < feet.length * 10) s.rays = new Float64Array(feet.length * 10)
  if (s.feetJoints.length < feet.length) s.feetJoints = new Int32Array(feet.length)
  const hips = jointAt(world, s.entity, names[0]!, frame)
  if (hips < 0)
    return report(world, s, unknownJoint('FootPlacement', s.entity, 'hips', names[0]!), frame)
  s.joints[0] = hips
  for (let k = 0; k < feet.length; k++) {
    const f = feet[k]!
    if (f.ik === null || !world.isAlive(f.ik) || !world.has(f.ik, TwoBoneIk)) {
      return report(
        world,
        s,
        new ShardError(
          'ik/unknown-joint',
          `FootPlacement on entity ${s.entity}: feet/${k}/ik has no animation/TwoBoneIk`,
          {
            hint: 'Point each foot at the entity holding that leg’s TwoBoneIk.',
            path: `/feet/${k}/ik`,
          },
        ),
        frame,
      )
    }
    const foot = jointAt(world, s.entity, f.footJoint, frame)
    if (foot < 0) {
      return report(
        world,
        s,
        unknownJoint('FootPlacement', s.entity, `feet/${k}/footJoint`, f.footJoint),
        frame,
      )
    }
    s.feetJoints[k] = foot
  }
  // The rays skip the character's own body: the nearest ancestor with a body or collider.
  const bodyDefs: ComponentDef[] = []
  for (const name of ['physics/RigidBody', 'physics/Collider', 'physics/CharacterController']) {
    const def = findComponent(name)
    if (def) bodyDefs.push(def)
  }
  s.exclude = -1 as Entity
  let cur = s.entity
  for (let guard = 0; cur >= 0 && guard < 64 && s.exclude < 0; guard++) {
    for (const def of bodyDefs) if (world.has(cur, def)) s.exclude = cur
    cur = parentOf(world, cur)
  }
  return report(world, s, null, frame)
}

// --- restoring the animated pose -------------------------------------------------------------

/**
 * Joints IK wrote last frame that nothing animated since get their pre-IK value back, so IK never
 * stacks on its own output (and fading weight out returns to the animation).
 */
function restore(world: World, s: Solver): void {
  if (s.writtenAt < 0) return
  const at = s.writtenAt
  s.writtenAt = -1
  let any = false
  for (let k = 0; k < s.count; k++) {
    if (s.written[k] === 0) continue
    s.written[k] = 0
    const e = s.joints[k]! as Entity
    if (!world.isAlive(e)) continue
    const table = world.entityTableUnchecked(e)
    if (!table.has(Transform)) continue
    const row = world.entityRowUnchecked(e)
    const changed = table.changedTicks(Transform)
    if (changed[row] !== at) continue
    if (s.kind === KIND_FEET) {
      const tr = table.column(Transform, 'translation')
      tr[row * 3] = s.saved[k * 4]!
      tr[row * 3 + 1] = s.saved[k * 4 + 1]!
      tr[row * 3 + 2] = s.saved[k * 4 + 2]!
    } else {
      const r = table.column(Transform, 'rotation')
      r[row * 4] = s.saved[k * 4]!
      r[row * 4 + 1] = s.saved[k * 4 + 1]!
      r[row * 4 + 2] = s.saved[k * 4 + 2]!
      r[row * 4 + 3] = s.saved[k * 4 + 3]!
    }
    changed[row] = world.tick
    table.touch(Transform)
    any = true
  }
  if (any) propagateSubtree(world, s.joints[0]! as Entity)
}

const qCur = quatId()
const qNew = quatId()

/** Blends a new local rotation with the joint's current one by arg[2], saves the old, writes. */
function commit(world: World, s: Solver, k: number, local: Float64Array, tick: number): void {
  const e = s.joints[k]! as Entity
  readRotation(world, e, qCur)
  if (s.written[k] === 0) {
    s.saved[k * 4] = qCur[0]!
    s.saved[k * 4 + 1] = qCur[1]!
    s.saved[k * 4 + 2] = qCur[2]!
    s.saved[k * 4 + 3] = qCur[3]!
    s.written[k] = 1
  }
  const w = arg[2]!
  if (w < 1) {
    arg[0] = w
    qslerp(qNew, qCur, local)
    writeRotation(world, e, qNew, tick)
  } else {
    writeRotation(world, e, local, tick)
  }
  s.writtenAt = tick
}

// --- two-bone --------------------------------------------------------------------------------

const pA = vec()
const pB = vec()
const pC = vec()
const pT = vec()
const pP = vec()
const qA = quatId()
const qB = quatId()
const qC = quatId()
const qT = quatId()
const qPA = quatId()
const qPB = quatId()
const qPC = quatId()
const v0 = vec()
const v1 = vec()
const v2 = vec()
const v3 = vec()
const dir = vec()
const bend = vec()
const q1 = quatId()
const q2 = quatId()
const q12 = quatId()
const qw = quatId()
const qp = quatId()
const qLocal = quatId()

/** Solves one two-bone chain; arg[2] is the weight, arg[3] the tip rotation weight. */
function solveTwoBone(world: World, s: Solver, target: Entity, pole: Entity, tick: number): void {
  const root = s.joints[0]! as Entity
  const mid = s.joints[1]! as Entity
  const tip = s.joints[2]! as Entity
  s.solved = false
  if (!readWorld(world, target, pT, qT)) return
  if (!readWorld(world, root, pA, qA) || !readWorld(world, mid, pB, qB)) return
  if (!readWorld(world, tip, pC, qC)) return
  parentRotation(world, root, qPA)
  parentRotation(world, mid, qPB)
  parentRotation(world, tip, qPC)
  vsub(v0, pB, pA)
  vnormalize(v0)
  const lab = arg[1]!
  vsub(v1, pC, pB)
  vnormalize(v1)
  const lbc = arg[1]!
  vsub(dir, pT, pA)
  vnormalize(dir)
  let dist = arg[1]!
  if (lab < 1e-6 || lbc < 1e-6 || dist < 1e-6) return
  const reach = lab + lbc
  const least = Math.abs(lab - lbc)
  if (dist > reach - 1e-5) dist = reach - 1e-5
  if (dist < least + 1e-5) dist = least + 1e-5
  // The bend plane: toward the pole, or the current bend.
  if (pole < 0 || !readPosition(world, pole, pP)) {
    pP[0] = pB[0]!
    pP[1] = pB[1]!
    pP[2] = pB[2]!
  }
  vsub(bend, pP, pA)
  let along = bend[0]! * dir[0]! + bend[1]! * dir[1]! + bend[2]! * dir[2]!
  bend[0] = bend[0]! - dir[0]! * along
  bend[1] = bend[1]! - dir[1]! * along
  bend[2] = bend[2]! - dir[2]! * along
  vnormalize(bend)
  if (arg[1]! < 1e-6) {
    // The pole is on the line to the target: use the current bend, then any perpendicular.
    vsub(bend, pB, pA)
    along = bend[0]! * dir[0]! + bend[1]! * dir[1]! + bend[2]! * dir[2]!
    bend[0] = bend[0]! - dir[0]! * along
    bend[1] = bend[1]! - dir[1]! * along
    bend[2] = bend[2]! - dir[2]! * along
    vnormalize(bend)
    if (arg[1]! < 1e-6) {
      bend[0] = -dir[1]!
      bend[1] = dir[0]!
      bend[2] = 0
      vnormalize(bend)
      if (arg[1]! < 1e-6) {
        bend[0] = 1
        bend[1] = 0
        bend[2] = 0
      }
    }
  }
  // Law of cosines: the angle at root, then where mid goes.
  let cosA = (lab * lab + dist * dist - lbc * lbc) / (2 * lab * dist)
  if (cosA > 1) cosA = 1
  if (cosA < -1) cosA = -1
  const sinA = Math.sqrt(1 - cosA * cosA)
  v1[0] = dir[0]! * cosA + bend[0]! * sinA
  v1[1] = dir[1]! * cosA + bend[1]! * sinA
  v1[2] = dir[2]! * cosA + bend[2]! * sinA
  // Root: turn its bone onto the new mid direction.
  qfromTo(q1, v0, v1)
  // Where tip went with it, and the turn at mid onto the target.
  vsub(v2, pC, pA)
  vrotate(v2, q1, v2)
  // v2 = (tip after q1) − (new mid) and v3 = (tip goal) − (new mid), from root.
  v2[0] = v2[0]! - v1[0]! * lab
  v2[1] = v2[1]! - v1[1]! * lab
  v2[2] = v2[2]! - v1[2]! * lab
  v3[0] = dir[0]! * dist - v1[0]! * lab
  v3[1] = dir[1]! * dist - v1[1]! * lab
  v3[2] = dir[2]! * dist - v1[2]! * lab
  vnormalize(v2)
  vnormalize(v3)
  qfromTo(q2, v2, v3)
  qmul(q12, q2, q1)
  // Locals: root's parent is untouched; mid's parent turned with root; tip's with both.
  qmul(qw, q1, qA)
  qmulConj(qLocal, qPA, qw)
  commit(world, s, 0, qLocal, tick)
  qmul(qw, q12, qB)
  qmul(qp, q1, qPB)
  qmulConj(qLocal, qp, qw)
  commit(world, s, 1, qLocal, tick)
  const tipWeight = arg[3]!
  if (tipWeight > 0) {
    qmul(qw, q12, qC)
    arg[0] = tipWeight
    qslerp(qw, qw, qT)
    qmul(qp, q12, qPC)
    qmulConj(qLocal, qp, qw)
    commit(world, s, 2, qLocal, tick)
  }
  propagateSubtree(world, root)
  readPosition(world, tip, pC)
  vsub(v0, pC, pT)
  vnormalize(v0)
  s.error = arg[1]!
  s.solved = true
}

// --- look-at ---------------------------------------------------------------------------------

const pJ = vec()
const fwd = vec()
const toT = vec()
const aim = vec()
const axisV = vec()
const qTot = quatId()
const qAcc = quatId()
const qShare = quatId()
const qI = quatId()
const qTmp = quatId()

/** Aims the joint at target; arg[2] is the weight, arg[3] the max angle in radians. */
function solveLookAt(
  world: World,
  s: Solver,
  target: Entity,
  axis: Float32Array,
  axisOffset: number,
  chain: ChainEntry[],
  tick: number,
): void {
  const n = s.count
  const joint = s.joints[n - 1]! as Entity
  s.solved = false
  if (!readPosition(world, target, pT) || !readWorld(world, joint, pJ, qA)) return
  // Every written joint's world rotation (rot) and its parent's (at n + k), before any change.
  if (s.rot.length < n * 8) s.rot = new Float64Array(n * 8)
  for (let k = 0; k < n; k++) {
    readWorld(world, s.joints[k]! as Entity, v0, qw)
    s.rot[k * 4] = qw[0]!
    s.rot[k * 4 + 1] = qw[1]!
    s.rot[k * 4 + 2] = qw[2]!
    s.rot[k * 4 + 3] = qw[3]!
    parentRotation(world, s.joints[k]! as Entity, qp)
    s.rot[(n + k) * 4] = qp[0]!
    s.rot[(n + k) * 4 + 1] = qp[1]!
    s.rot[(n + k) * 4 + 2] = qp[2]!
    s.rot[(n + k) * 4 + 3] = qp[3]!
  }
  axisV[0] = axis[axisOffset]!
  axisV[1] = axis[axisOffset + 1]!
  axisV[2] = axis[axisOffset + 2]!
  vnormalize(axisV)
  vrotate(fwd, qA, axisV)
  vsub(toT, pT, pJ)
  vnormalize(toT)
  if (arg[1]! < 1e-6) return
  let cos = fwd[0]! * toT[0]! + fwd[1]! * toT[1]! + fwd[2]! * toT[2]!
  if (cos > 1) cos = 1
  if (cos < -1) cos = -1
  const angle = Math.acos(cos)
  const max = arg[3]!
  s.clamped = angle > max
  if (s.clamped) {
    // Turn forward toward the target by max, about their common perpendicular.
    v1[0] = fwd[1]! * toT[2]! - fwd[2]! * toT[1]!
    v1[1] = fwd[2]! * toT[0]! - fwd[0]! * toT[2]!
    v1[2] = fwd[0]! * toT[1]! - fwd[1]! * toT[0]!
    vnormalize(v1)
    if (arg[1]! < 1e-9) {
      v1[0] = 0
      v1[1] = 1
      v1[2] = 0
    }
    arg[0] = max
    qaxisAngle(qTmp, v1)
    vrotate(aim, qTmp, fwd)
  } else {
    aim[0] = toT[0]!
    aim[1] = toT[1]!
    aim[2] = toT[2]!
  }
  qfromTo(qTot, fwd, aim)
  // The chain takes its shares, top first; each turn carries everything below.
  qidentity(qAcc)
  qidentity(qI)
  for (let k = 0; k < n - 1; k++) {
    arg[0] = chain[k]!.share
    qslerp(qShare, qI, qTot)
    qcopy(qp, s.rot, (n + k) * 4)
    qmul(qp, qAcc, qp) // parent, after the turns above
    qmul(qAcc, qShare, qAcc)
    qcopy(qw, s.rot, k * 4)
    qmul(qw, qAcc, qw)
    qmulConj(qLocal, qp, qw)
    commit(world, s, k, qLocal, tick)
  }
  // The joint aims the rest of the way.
  qcopy(qw, s.rot, (n - 1) * 4)
  qmul(qw, qAcc, qw)
  vrotate(v2, qw, axisV)
  qfromTo(qTmp, v2, aim)
  qmul(qw, qTmp, qw)
  qcopy(qp, s.rot, (2 * n - 1) * 4)
  qmul(qp, qAcc, qp)
  qmulConj(qLocal, qp, qw)
  commit(world, s, n - 1, qLocal, tick)
  propagateSubtree(world, s.joints[0]! as Entity)
  // What's left: the angle between where it faces now and the target, in degrees.
  readWorld(world, joint, pJ, qA)
  vrotate(fwd, qA, axisV)
  vsub(toT, pT, pJ)
  vnormalize(toT)
  cos = fwd[0]! * toT[0]! + fwd[1]! * toT[1]! + fwd[2]! * toT[2]!
  s.error = (Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos) * 180) / Math.PI
  s.solved = true
}

// --- FABRIK ----------------------------------------------------------------------------------

/** FABRIK from root to tip; arg[2] is the weight, arg[3] the tolerance. */
function solveChain(
  world: World,
  s: Solver,
  target: Entity,
  iterations: number,
  tick: number,
): void {
  const n = s.count
  s.solved = false
  if (n < 2 || !readPosition(world, target, pT)) return
  const pos = s.pos
  const next = s.next
  const len = s.len
  const rot = s.rot
  for (let k = 0; k < n; k++) {
    readWorld(world, s.joints[k]! as Entity, v0, qw)
    pos[k * 3] = v0[0]!
    pos[k * 3 + 1] = v0[1]!
    pos[k * 3 + 2] = v0[2]!
    next[k * 3] = v0[0]!
    next[k * 3 + 1] = v0[1]!
    next[k * 3 + 2] = v0[2]!
    rot[k * 4] = qw[0]!
    rot[k * 4 + 1] = qw[1]!
    rot[k * 4 + 2] = qw[2]!
    rot[k * 4 + 3] = qw[3]!
  }
  parentRotation(world, s.joints[0]! as Entity, qPA)
  let total = 0
  for (let k = 0; k < n - 1; k++) {
    const dx = pos[k * 3 + 3]! - pos[k * 3]!
    const dy = pos[k * 3 + 4]! - pos[k * 3 + 1]!
    const dz = pos[k * 3 + 5]! - pos[k * 3 + 2]!
    len[k] = Math.sqrt(dx * dx + dy * dy + dz * dz)
    total += len[k]!
  }
  const rx = pT[0]! - pos[0]!
  const ry = pT[1]! - pos[1]!
  const rz = pT[2]! - pos[2]!
  const reach = Math.sqrt(rx * rx + ry * ry + rz * rz)
  const tolerance = arg[3]!
  let passes = 0
  if (reach >= total) {
    // Out of reach: straight at it.
    for (let k = 0; k < n - 1; k++) {
      const f = len[k]! / (reach || 1)
      next[k * 3 + 3] = next[k * 3]! + rx * f
      next[k * 3 + 4] = next[k * 3 + 1]! + ry * f
      next[k * 3 + 5] = next[k * 3 + 2]! + rz * f
    }
    passes = 1
  } else {
    const t = (n - 1) * 3
    for (; passes < iterations; ) {
      const ex = next[t]! - pT[0]!
      const ey = next[t + 1]! - pT[1]!
      const ez = next[t + 2]! - pT[2]!
      if (Math.sqrt(ex * ex + ey * ey + ez * ez) <= tolerance) break
      passes++
      // Backward: tip on the target, each joint pulled after it.
      next[t] = pT[0]!
      next[t + 1] = pT[1]!
      next[t + 2] = pT[2]!
      for (let k = n - 2; k >= 0; k--) fabrikStep(next, k, k + 1, len[k]!)
      // Forward: root back in place, each joint pulled after it.
      next[0] = pos[0]!
      next[1] = pos[1]!
      next[2] = pos[2]!
      for (let k = 0; k < n - 1; k++) fabrikStep(next, k + 1, k, len[k]!)
    }
  }
  s.iterations = passes
  // Positions to rotations, top first: each joint turns its bone onto the new direction.
  qidentity(qAcc)
  for (let k = 0; k < n - 1; k++) {
    v0[0] = pos[k * 3 + 3]! - pos[k * 3]!
    v0[1] = pos[k * 3 + 4]! - pos[k * 3 + 1]!
    v0[2] = pos[k * 3 + 5]! - pos[k * 3 + 2]!
    vrotate(v0, qAcc, v0)
    vnormalize(v0)
    v1[0] = next[k * 3 + 3]! - next[k * 3]!
    v1[1] = next[k * 3 + 4]! - next[k * 3 + 1]!
    v1[2] = next[k * 3 + 5]! - next[k * 3 + 2]!
    vnormalize(v1)
    // The parent's new world rotation: the turn so far on the one above (or untouched).
    if (k === 0) {
      qp[0] = qPA[0]!
      qp[1] = qPA[1]!
      qp[2] = qPA[2]!
      qp[3] = qPA[3]!
    } else {
      qcopy(qp, rot, (k - 1) * 4)
      qmul(qp, qAcc, qp)
    }
    qfromTo(qTmp, v0, v1)
    qmul(qAcc, qTmp, qAcc)
    qcopy(qw, rot, k * 4)
    qmul(qw, qAcc, qw)
    qmulConj(qLocal, qp, qw)
    commit(world, s, k, qLocal, tick)
  }
  propagateSubtree(world, s.joints[0]! as Entity)
  readPosition(world, s.joints[n - 1]! as Entity, v0)
  vsub(v0, v0, pT)
  vnormalize(v0)
  s.error = arg[1]!
  s.solved = true
}

/** Moves joint `a` to `length` from joint `b`, along the line between them. */
function fabrikStep(p: Float64Array, a: number, b: number, length: number): void {
  const dx = p[a * 3]! - p[b * 3]!
  const dy = p[a * 3 + 1]! - p[b * 3 + 1]!
  const dz = p[a * 3 + 2]! - p[b * 3 + 2]!
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const f = d > 1e-12 ? length / d : 0
  p[a * 3] = p[b * 3]! + dx * f
  p[a * 3 + 1] = p[b * 3 + 1]! + dy * f
  p[a * 3 + 2] = p[b * 3 + 2]! + dz * f
}

// --- foot placement --------------------------------------------------------------------------

interface Raycaster {
  raycast(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    options: RayOptions,
    out: RayHitLike,
  ): boolean
}

interface RayOptions {
  maxDistance: number
  mask: number
  exclude: Entity | undefined
}

interface RayHitLike {
  entity: Entity
  body: Entity
  distance: number
  point: Float32Array
  normal: Float32Array
}

const rayOptions: RayOptions = { maxDistance: 0, mask: 0xffff, exclude: undefined }
const rayHit: RayHitLike = {
  entity: -1 as Entity,
  body: -1 as Entity,
  distance: 0,
  point: new Float32Array(3),
  normal: new Float32Array(3),
}
const rayOrigin = new Float32Array(3)
const rayDir = new Float32Array(3)
const up = vec()
const base = vec()
const foot = vec()
const goal = vec()
const normal = vec()
const qFoot = quatId()

/** The physics world when @shard/physics is installed and ready (found by name: no dependency). */
function raycaster(world: World): Raycaster | undefined {
  if (physicsWorld === undefined) physicsWorld = findResource('physics/World') ?? null
  if (physicsWorld === null) {
    physicsWorld = undefined // physics may register later
    return undefined
  }
  return world.tryResource(physicsWorld) as Raycaster | undefined
}

/**
 * Casts each foot down, lowers the hips for the lowest, and writes each leg's IK target. arg[2]
 * is the weight, arg[3] maxStep.
 */
function solveFeet(world: World, s: Solver, feet: FootEntry[], mask: number, tick: number): void {
  s.solved = false
  const caster = raycaster(world)
  if (!caster || !readWorld(world, s.entity, base, qA)) return
  const weight = arg[2]!
  const maxStep = arg[3]!
  v0[0] = 0
  v0[1] = 1
  v0[2] = 0
  vrotate(up, qA, v0)
  rayOptions.mask = mask
  rayOptions.exclude = s.exclude >= 0 ? s.exclude : undefined
  let drop = 0
  const rays = s.rays
  for (let k = 0; k < feet.length; k++) {
    const f = feet[k]!
    const o = k * 10
    rays[o + 9] = 0
    if (!readPosition(world, s.feetJoints[k]! as Entity, foot)) continue
    // Height of the animated foot above the entity's ground plane.
    const height =
      (foot[0]! - base[0]!) * up[0]! +
      (foot[1]! - base[1]!) * up[1]! +
      (foot[2]! - base[2]!) * up[2]!
    const clearance = Math.max(0, height - f.offset)
    rayOrigin[0] = foot[0]! + up[0]! * maxStep
    rayOrigin[1] = foot[1]! + up[1]! * maxStep
    rayOrigin[2] = foot[2]! + up[2]! * maxStep
    rayDir[0] = -up[0]!
    rayDir[1] = -up[1]!
    rayDir[2] = -up[2]!
    rays[o] = rayOrigin[0]!
    rays[o + 1] = rayOrigin[1]!
    rays[o + 2] = rayOrigin[2]!
    rayOptions.maxDistance = maxStep * 2 + Math.max(0, height)
    // Where the ray ends when it misses, for the overlay.
    rays[o + 3] = rayOrigin[0]! + rayDir[0]! * rayOptions.maxDistance
    rays[o + 4] = rayOrigin[1]! + rayDir[1]! * rayOptions.maxDistance
    rays[o + 5] = rayOrigin[2]! + rayDir[2]! * rayOptions.maxDistance
    if (!caster.raycast(rayOrigin, rayDir, rayOptions, rayHit)) continue
    normal[0] = rayHit.normal[0]!
    normal[1] = rayHit.normal[1]!
    normal[2] = rayHit.normal[2]!
    if (normal[0]! * up[0]! + normal[1]! * up[1]! + normal[2]! * up[2]! < 0) {
      normal[0] = -normal[0]!
      normal[1] = -normal[1]!
      normal[2] = -normal[2]!
    }
    // The ankle's goal: offset off the ground along its normal, lifted by the animated clearance.
    rays[o + 3] = rayHit.point[0]!
    rays[o + 4] = rayHit.point[1]!
    rays[o + 5] = rayHit.point[2]!
    rays[o + 6] = normal[0]!
    rays[o + 7] = normal[1]!
    rays[o + 8] = normal[2]!
    rays[o + 9] = 1
    const gx = rayHit.point[0]! + normal[0]! * f.offset + up[0]! * clearance
    const gy = rayHit.point[1]! + normal[1]! * f.offset + up[1]! * clearance
    const gz = rayHit.point[2]! + normal[2]! * f.offset + up[2]! * clearance
    let d = (gx - foot[0]!) * up[0]! + (gy - foot[1]!) * up[1]! + (gz - foot[2]!) * up[2]!
    if (d < -maxStep) d = -maxStep
    if (d < drop) drop = d
  }
  drop *= weight
  s.hipsDrop = drop
  // The hips go down (never up), carrying the legs.
  const hips = s.joints[0]! as Entity
  if (drop < 0) moveHips(world, s, hips, drop, tick)
  for (let k = 0; k < feet.length; k++) {
    const f = feet[k]!
    const o = k * 10
    if (f.ik === null || !world.isAlive(f.ik)) continue
    const ikTable = world.entityTableUnchecked(f.ik!)
    const target = ikTable.column(TwoBoneIk, 'target')[world.entityRowUnchecked(f.ik!)]! as Entity
    if (target < 0 || !world.isAlive(target)) continue
    if (!readWorld(world, s.feetJoints[k]! as Entity, foot, qFoot)) continue
    goal[0] = foot[0]!
    goal[1] = foot[1]!
    goal[2] = foot[2]!
    qcopy(qw, qFoot, 0)
    if (rays[o + 9] === 1) {
      const height =
        (foot[0]! - base[0]!) * up[0]! +
        (foot[1]! - base[1]!) * up[1]! +
        (foot[2]! - base[2]!) * up[2]! -
        drop
      const clearance = Math.max(0, height - f.offset)
      normal[0] = rays[o + 6]!
      normal[1] = rays[o + 7]!
      normal[2] = rays[o + 8]!
      let gx = rays[o + 3]! + normal[0]! * f.offset + up[0]! * clearance
      let gy = rays[o + 4]! + normal[1]! * f.offset + up[1]! * clearance
      let gz = rays[o + 5]! + normal[2]! * f.offset + up[2]! * clearance
      // No farther than maxStep from the animated foot along up.
      const d = (gx - foot[0]!) * up[0]! + (gy - foot[1]!) * up[1]! + (gz - foot[2]!) * up[2]!
      const excess = d > maxStep ? d - maxStep : d < -maxStep ? d + maxStep : 0
      gx -= up[0]! * excess
      gy -= up[1]! * excess
      gz -= up[2]! * excess
      goal[0] = foot[0]! + (gx - foot[0]!) * weight
      goal[1] = foot[1]! + (gy - foot[1]!) * weight
      goal[2] = foot[2]! + (gz - foot[2]!) * weight
      // Planted feet turn to the ground; lifted ones less, the higher they are.
      let align = maxStep > 0 ? 1 - clearance / maxStep : 1
      if (align < 0) align = 0
      qfromTo(qTmp, up, normal)
      qidentity(qI)
      arg[0] = align * weight
      qslerp(qTmp, qI, qTmp)
      qmul(qw, qTmp, qFoot)
    }
    setWorldPose(world, target, goal, qw, tick)
  }
  s.solved = true
}

const invScratch = vec()

/** Moves the hips by `drop` along up, in their parent's frame (saving the animated value). */
function moveHips(world: World, s: Solver, hips: Entity, drop: number, tick: number): void {
  const table = world.entityTableUnchecked(hips)
  const row = world.entityRowUnchecked(hips)
  const tr = table.column(Transform, 'translation')
  if (s.written[0] === 0) {
    s.saved[0] = tr[row * 3]!
    s.saved[1] = tr[row * 3 + 1]!
    s.saved[2] = tr[row * 3 + 2]!
    s.written[0] = 1
  }
  invScratch[0] = up[0]! * drop
  invScratch[1] = up[1]! * drop
  invScratch[2] = up[2]! * drop
  toParentFrame(world, hips, invScratch, false)
  tr[row * 3] = tr[row * 3]! + invScratch[0]!
  tr[row * 3 + 1] = tr[row * 3 + 1]! + invScratch[1]!
  tr[row * 3 + 2] = tr[row * 3 + 2]! + invScratch[2]!
  table.changedTicks(Transform)[row] = tick
  table.touch(Transform)
  s.writtenAt = tick
  propagateSubtree(world, hips)
}

/**
 * A world vector (or point) into the frame of e's parent: inverse of the parent's matrix, assuming
 * rotation and scale (no shear).
 */
function toParentFrame(world: World, e: Entity, v: Float64Array, isPoint: boolean): void {
  const p = parentOf(world, e)
  if (p < 0 || !world.isAlive(p)) return
  const pt = world.entityTableUnchecked(p)
  if (!pt.has(GlobalTransform)) return
  const m = pt.column(GlobalTransform, 'matrix')
  const o = world.entityRowUnchecked(p) * 12
  let x = v[0]!
  let y = v[1]!
  let z = v[2]!
  if (isPoint) {
    x -= m[o + 3]!
    y -= m[o + 7]!
    z -= m[o + 11]!
  }
  // M = R·S, so M⁻¹ v = S⁻² Mᵀ v: each column's dot product over its squared length.
  const c0 = m[o]! * m[o]! + m[o + 4]! * m[o + 4]! + m[o + 8]! * m[o + 8]!
  const c1 = m[o + 1]! * m[o + 1]! + m[o + 5]! * m[o + 5]! + m[o + 9]! * m[o + 9]!
  const c2 = m[o + 2]! * m[o + 2]! + m[o + 6]! * m[o + 6]! + m[o + 10]! * m[o + 10]!
  v[0] = (m[o]! * x + m[o + 4]! * y + m[o + 8]! * z) / (c0 || 1)
  v[1] = (m[o + 1]! * x + m[o + 5]! * y + m[o + 9]! * z) / (c1 || 1)
  v[2] = (m[o + 2]! * x + m[o + 6]! * y + m[o + 10]! * z) / (c2 || 1)
}

const poseP = vec()
const poseQ = quatId()

/** Puts an entity at a world position and rotation (its Transform, in its parent's frame). */
function setWorldPose(
  world: World,
  e: Entity,
  pos: Float64Array,
  rot: Float64Array,
  tick: number,
): void {
  const table = world.entityTableUnchecked(e)
  if (!table.has(Transform)) return
  const row = world.entityRowUnchecked(e)
  poseP[0] = pos[0]!
  poseP[1] = pos[1]!
  poseP[2] = pos[2]!
  toParentFrame(world, e, poseP, true)
  parentRotation(world, e, qp)
  qmulConj(poseQ, qp, rot)
  const tr = table.column(Transform, 'translation')
  const ro = table.column(Transform, 'rotation')
  tr[row * 3] = poseP[0]!
  tr[row * 3 + 1] = poseP[1]!
  tr[row * 3 + 2] = poseP[2]!
  ro[row * 4] = poseQ[0]!
  ro[row * 4 + 1] = poseQ[1]!
  ro[row * 4 + 2] = poseQ[2]!
  ro[row * 4 + 3] = poseQ[3]!
  table.changedTicks(Transform)[row] = tick
  table.touch(Transform)
  propagateSubtree(world, e)
}

// --- the system ------------------------------------------------------------------------------

function solverFor(state: IkState, kind: number, entity: Entity): Solver {
  const map = state.solvers[kind]!
  let s = map.get(entity)
  if (!s) {
    s = createSolver(kind, entity)
    map.set(entity, s)
  }
  return s
}

/** Whether a resolved solver's joints are still alive (a respawned model needs a new resolve). */
function jointsLive(world: World, s: Solver): boolean {
  for (let k = 0; k < s.count; k++) if (!world.isAlive(s.joints[k]! as Entity)) return false
  if (s.kind === KIND_FEET && s.ok) {
    const feet = s.list as FootEntry[]
    for (let k = 0; k < feet.length; k++)
      if (!world.isAlive(s.feetJoints[k]! as Entity)) return false
  }
  return true
}

/**
 * Whether a solver needs resolving: first use, a path edited (compared without allocating), a
 * joint gone, or a failed resolve due for a retry.
 */
function stale(
  world: World,
  s: Solver,
  frame: number,
  a: string,
  b: string,
  c: string,
  list: unknown,
): boolean {
  if (!s.resolved || s.list !== list) return true
  const names = s.names
  if (names[0] !== a) return true
  if (s.kind === KIND_TWO_BONE && (names[1] !== b || names[2] !== c)) return true
  if (s.kind === KIND_CHAIN && names[1] !== b) return true
  if (s.kind === KIND_LOOK_AT) {
    const chain = list as ChainEntry[]
    if (names.length !== chain.length + 1) return true
    for (let k = 0; k < chain.length; k++) if (chain[k]!.joint !== names[k + 1]) return true
  }
  if (s.kind === KIND_FEET) {
    const feet = list as FootEntry[]
    if (names.length !== feet.length + 1) return true
    for (let k = 0; k < feet.length; k++) if (feet[k]!.footJoint !== names[k + 1]) return true
  }
  if (!s.ok) return frame >= s.retryAt
  return !jointsLive(world, s)
}

interface Queries {
  two: ReturnType<World['query']>
  look: ReturnType<World['query']>
  chain: ReturnType<World['query']>
  feet: ReturnType<World['query']>
}

function prepare(world: World, state: IkState, q: Queries, frame: number): void {
  let tables = q.two.tables
  for (let ti = 0; ti < tables.length; ti++) {
    const table = tables[ti]!
    const roots = table.column(TwoBoneIk, 'root') as string[]
    const mids = table.column(TwoBoneIk, 'mid') as string[]
    const tips = table.column(TwoBoneIk, 'tip') as string[]
    for (let i = 0; i < table.count; i++) {
      const s = solverFor(state, KIND_TWO_BONE, table.entities[i]!)
      if (stale(world, s, frame, roots[i]!, mids[i]!, tips[i]!, undefined)) {
        s.writtenAt = -1
        s.names = [roots[i]!, mids[i]!, tips[i]!]
        s.list = undefined
        resolveTwoBone(world, s, frame, s.names)
      }
      if (s.ok) restore(world, s)
    }
  }
  tables = q.chain.tables
  for (let ti = 0; ti < tables.length; ti++) {
    const table = tables[ti]!
    const roots = table.column(ChainIk, 'root') as string[]
    const tips = table.column(ChainIk, 'tip') as string[]
    for (let i = 0; i < table.count; i++) {
      const s = solverFor(state, KIND_CHAIN, table.entities[i]!)
      if (stale(world, s, frame, roots[i]!, tips[i]!, '', undefined)) {
        s.writtenAt = -1
        s.names = [roots[i]!, tips[i]!]
        s.list = undefined
        resolveChain(world, s, frame, s.names)
      }
      if (s.ok) restore(world, s)
    }
  }
  tables = q.look.tables
  for (let ti = 0; ti < tables.length; ti++) {
    const table = tables[ti]!
    const joints = table.column(LookAtIk, 'joint') as string[]
    const chains = table.column(LookAtIk, 'chain') as ChainEntry[][]
    for (let i = 0; i < table.count; i++) {
      const s = solverFor(state, KIND_LOOK_AT, table.entities[i]!)
      const chain = chains[i]!
      // Names: the joint, then the chain (resolved top first, the joint last).
      if (stale(world, s, frame, joints[i]!, chain[0]?.joint ?? '', chain[1]?.joint ?? '', chain)) {
        s.writtenAt = -1
        s.names = [joints[i]!, ...chain.map((c) => c.joint)]
        s.list = chain
        resolveLookAt(world, s, frame, [...chain.map((c) => c.joint), joints[i]!])
      }
      if (s.ok) restore(world, s)
    }
  }
  tables = q.feet.tables
  for (let ti = 0; ti < tables.length; ti++) {
    const table = tables[ti]!
    const hips = table.column(FootPlacement, 'hips') as string[]
    const feet = table.column(FootPlacement, 'feet') as FootEntry[][]
    for (let i = 0; i < table.count; i++) {
      const s = solverFor(state, KIND_FEET, table.entities[i]!)
      const list = feet[i]!
      if (stale(world, s, frame, hips[i]!, list[0]?.footJoint ?? '', '', list)) {
        s.writtenAt = -1
        s.names = [hips[i]!, ...list.map((f) => f.footJoint)]
        s.list = list
        resolveFeet(world, s, frame, s.names, list)
      }
      if (s.ok) restore(world, s)
    }
  }
}

/**
 * Solves IK on the animated pose: foot placement (hips and leg targets), then two-bone, FABRIK
 * chains, and look-at. Runs in TransformSystems right after propagation, writes local rotations
 * blended by weight, and re-propagates the subtrees it changed, so everything after
 * TransformSystems sees the final pose.
 */
export const solveIk = defineSystem({
  name: 'animation/ik',
  description:
    'Solves foot placement, two-bone, FABRIK, and look-at IK on the animated pose and re-propagates what changed.',
  setup: (world) => ({
    two: world.query({ with: [TwoBoneIk] }),
    look: world.query({ with: [LookAtIk] }),
    chain: world.query({ with: [ChainIk] }),
    feet: world.query({ with: [FootPlacement] }),
  }),
  run: (q, world) => {
    const state = world.resource(IkStateResource)
    const tick = world.tick
    state.frame++
    prepare(world, state, q, state.frame)
    // Feet first: they move the hips and the leg targets the two-bone solvers read.
    let tables = q.feet.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const weights = table.column(FootPlacement, 'weight')
      const steps = table.column(FootPlacement, 'maxStep')
      const masks = table.column(FootPlacement, 'mask')
      const feet = table.column(FootPlacement, 'feet') as FootEntry[][]
      for (let i = 0; i < table.count; i++) {
        const s = state.solvers[KIND_FEET]!.get(table.entities[i]!)!
        if (!s.ok || weights[i]! <= 0) {
          s.solved = false
          continue
        }
        arg[2] = weights[i]!
        arg[3] = steps[i]!
        solveFeet(world, s, feet[i]!, masks[i]!, tick)
      }
    }
    tables = q.two.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const targets = table.column(TwoBoneIk, 'target')
      const poles = table.column(TwoBoneIk, 'pole')
      const weights = table.column(TwoBoneIk, 'weight')
      const tipRot = table.column(TwoBoneIk, 'tipRotation')
      for (let i = 0; i < table.count; i++) {
        const s = state.solvers[KIND_TWO_BONE]!.get(table.entities[i]!)!
        if (!s.ok || weights[i]! <= 0) {
          s.solved = false
          continue
        }
        arg[2] = weights[i]!
        arg[3] = tipRot[i]!
        solveTwoBone(world, s, targets[i]! as Entity, poles[i]! as Entity, tick)
      }
    }
    tables = q.chain.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const targets = table.column(ChainIk, 'target')
      const iterations = table.column(ChainIk, 'iterations')
      const tolerances = table.column(ChainIk, 'tolerance')
      const weights = table.column(ChainIk, 'weight')
      for (let i = 0; i < table.count; i++) {
        const s = state.solvers[KIND_CHAIN]!.get(table.entities[i]!)!
        if (!s.ok || weights[i]! <= 0) {
          s.solved = false
          continue
        }
        arg[2] = weights[i]!
        arg[3] = tolerances[i]!
        solveChain(world, s, targets[i]! as Entity, iterations[i]!, tick)
      }
    }
    tables = q.look.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const targets = table.column(LookAtIk, 'target')
      const axes = table.column(LookAtIk, 'axis')
      const maxAngles = table.column(LookAtIk, 'maxAngle')
      const weights = table.column(LookAtIk, 'weight')
      const chains = table.column(LookAtIk, 'chain') as ChainEntry[][]
      for (let i = 0; i < table.count; i++) {
        const s = state.solvers[KIND_LOOK_AT]!.get(table.entities[i]!)!
        if (!s.ok || weights[i]! <= 0) {
          s.solved = false
          continue
        }
        arg[2] = weights[i]!
        arg[3] = (maxAngles[i]! * Math.PI) / 180
        solveLookAt(world, s, targets[i]! as Entity, axes, i * 3, chains[i]!, tick)
      }
    }
  },
})

/** Forgets a solver when its component goes away. */
export function forgetSolver(world: World, kind: number, entity: Entity): void {
  world.tryResource(IkStateResource)?.solvers[kind]?.delete(entity)
}

export const IK_KINDS = {
  two: KIND_TWO_BONE,
  look: KIND_LOOK_AT,
  chain: KIND_CHAIN,
  feet: KIND_FEET,
}

// --- describe --------------------------------------------------------------------------------

const round = (x: number, digits = 4) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : null)

/** Every IK solver (or those whose entity is under `under`): its joints, weight, and results. */
export function describeIk(world: World, under?: Entity) {
  const state = world.tryResource(IkStateResource)
  const out: Record<string, unknown>[] = []
  if (!state) return out
  const defs: ComponentDef[] = [TwoBoneIk, LookAtIk, ChainIk, FootPlacement]
  for (let kind = 0; kind < 4; kind++) {
    for (const [entity, s] of state.solvers[kind]!) {
      if (!world.isAlive(entity) || !world.has(entity, defs[kind]!)) continue
      if (under !== undefined && !isAncestor(world, under, entity)) continue
      const value = world.get(entity, defs[kind]!) as unknown as { weight: number }
      const entry: Record<string, unknown> = {
        entity,
        kind: KIND_NAMES[kind],
        weight: value.weight,
        solved: s.solved,
        problem: s.problem ? { code: s.problem.code, message: s.problem.message } : null,
      }
      if (kind === KIND_TWO_BONE || kind === KIND_CHAIN) entry.targetError = round(s.error)
      if (kind === KIND_CHAIN) entry.iterations = s.iterations
      if (kind === KIND_LOOK_AT) {
        entry.angleToTarget = round(s.error, 2)
        entry.clamped = s.clamped
      }
      if (kind === KIND_FEET) {
        const feet = (value as unknown as { feet: FootEntry[] }).feet
        entry.hipsDrop = round(s.hipsDrop)
        entry.feet = feet.map((_, k) => ({
          grounded: s.rays[k * 10 + 9] === 1,
          hit:
            s.rays[k * 10 + 9] === 1 ? [0, 1, 2].map((c) => round(s.rays[k * 10 + 3 + c]!)) : null,
          normal:
            s.rays[k * 10 + 9] === 1
              ? [0, 1, 2].map((c) => round(s.rays[k * 10 + 6 + c]!, 3))
              : null,
        }))
      }
      out.push(entry)
    }
  }
  return out
}

// --- the overlay -----------------------------------------------------------------------------

const TARGET = [1, 0.3, 0.9, 1]
const POLE = [0.35, 0.55, 1, 1]
const CHAIN_LINE = [1, 0.6, 0.15, 1]
const RAY_HIT = [0.3, 1, 0.4, 1]
const RAY_MISS = [1, 0.25, 0.25, 1]
const oa = new Float32Array(3)
const ob = new Float32Array(3)
const op = vec()

function cross(
  g: { line(a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>): void },
  p: Float64Array,
  size: number,
  color: number[],
): void {
  for (let axis = 0; axis < 3; axis++) {
    for (let c = 0; c < 3; c++) {
      oa[c] = p[c]!
      ob[c] = p[c]!
    }
    oa[axis] = oa[axis]! - size
    ob[axis] = ob[axis]! + size
    g.line(oa, ob, color)
  }
}

defineOverlay({
  name: 'ik',
  description:
    'IK: targets (magenta), poles (blue), solved chains (orange), and foot rays (green where they hit the ground, red where they miss).',
  draw(world, g, passes) {
    const state = world.tryResource(IkStateResource)
    if (!state) return
    const defs: ComponentDef[] = [TwoBoneIk, LookAtIk, ChainIk, FootPlacement]
    for (let kind = 0; kind < 4; kind++) {
      for (const [entity, s] of state.solvers[kind]!) {
        if (!world.isAlive(entity) || !world.has(entity, defs[kind]!) || !passes(entity)) continue
        if (!s.ok) continue
        const table: Table = world.entityTable(entity)
        const row = world.entityRow(entity)
        if (kind !== KIND_FEET) {
          const target = table.column(defs[kind] as typeof TwoBoneIk, 'target')[row]! as Entity
          if (readPosition(world, target, op)) cross(g, op, 0.05, TARGET)
          for (let k = 0; k + 1 < s.count; k++) {
            if (!readPosition(world, s.joints[k]! as Entity, op)) continue
            oa[0] = op[0]!
            oa[1] = op[1]!
            oa[2] = op[2]!
            if (!readPosition(world, s.joints[k + 1]! as Entity, op)) continue
            g.line(oa, [op[0]!, op[1]!, op[2]!], CHAIN_LINE)
          }
        }
        if (kind === KIND_TWO_BONE) {
          const pole = table.column(TwoBoneIk, 'pole')[row]! as Entity
          if (readPosition(world, pole, op)) cross(g, op, 0.04, POLE)
        }
        if (kind === KIND_FEET) {
          const feet = (table.column(FootPlacement, 'feet') as FootEntry[][])[row]!
          for (let k = 0; k < feet.length; k++) {
            const o = k * 10
            const hit = s.rays[o + 9] === 1
            g.line(
              [s.rays[o]!, s.rays[o + 1]!, s.rays[o + 2]!],
              [s.rays[o + 3]!, s.rays[o + 4]!, s.rays[o + 5]!],
              hit ? RAY_HIT : RAY_MISS,
            )
            if (hit) {
              g.line(
                [s.rays[o + 3]!, s.rays[o + 4]!, s.rays[o + 5]!],
                [
                  s.rays[o + 3]! + s.rays[o + 6]! * 0.15,
                  s.rays[o + 4]! + s.rays[o + 7]! * 0.15,
                  s.rays[o + 5]! + s.rays[o + 8]! * 0.15,
                ],
                RAY_HIT,
              )
            }
          }
        }
      }
    }
  },
})
