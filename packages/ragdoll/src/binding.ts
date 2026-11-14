import type { FlatSkeleton } from '@aethervtt/shard-animation'
import { ShardError } from '@aethervtt/shard-core'
import type { RagdollAsset, RagdollShape } from './asset'
import { qfromAxes, qmulConj, qnormalize, qrotateInv, quatFromRows } from './math'

/**
 * A ragdoll asset bound to one skeleton and rest pose: joint indices, body parents, rest frames,
 * Rapier joint frames and limits, and collider placements. Cold: built once per (asset, skeleton,
 * rest) and cached.
 */
export interface RagdollBinding {
  asset: RagdollAsset
  skeleton: FlatSkeleton
  /** Bodies. */
  count: number
  /** Per body: its skeleton joint. */
  joint: Int16Array
  /** Per body: its parent body, or -1. */
  parent: Int16Array
  /** Bodies parents first. */
  order: Int16Array
  /** Per skeleton joint: its body, or -1. */
  bodyOf: Int16Array
  /** Skeleton joints parents first. */
  jointOrder: Int16Array
  /** Body graph distances (count × count). */
  distance: Uint8Array
  /** The root body (no parent). */
  root: number
  /** Per body: whether a partial reaction keeps it kinematic (the root and the legs). */
  anchored: Uint8Array
  /** Per body: rest model pose of its joint (t xyz, r xyzw), scale removed. */
  rest: Float32Array
  /** Per body: kg. */
  mass: Float32Array
  /** Per body except the root: where its joint sits in the parent body's frame. */
  anchor: Float32Array
  /** Per body: the joint frame in its own frame, and in its parent's (quaternions). */
  frame: Float32Array
  otherFrame: Float32Array
  /** Per body: Rapier limits [twist min, max, swing y min, max, swing z min, max]. */
  limits: Float32Array
  /** Per body: 1 when its joint is a hinge (turns about the frame's z only). */
  hinge: Uint8Array
  /** Per body: the collider in the body's frame: center xyz, rotation xyzw. */
  colliderPose: Float32Array
}

const cache = new WeakMap<
  RagdollAsset,
  WeakMap<FlatSkeleton, WeakMap<Float32Array, RagdollBinding>>
>()

const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Model-space rows (12 per joint) of a rest pose (10 floats per joint), parents first. */
export function restModels(
  skeleton: FlatSkeleton,
  rest: Float32Array,
  order: Int16Array,
): Float32Array {
  const n = skeleton.paths.length
  const model = new Float32Array(n * 12)
  const l = new Float64Array(12)
  for (let k = 0; k < order.length; k++) {
    const j = order[k]!
    const o = j * 10
    const x = rest[o + 3]!
    const y = rest[o + 4]!
    const z = rest[o + 5]!
    const w = rest[o + 6]!
    const sx = rest[o + 7]!
    const sy = rest[o + 8]!
    const sz = rest[o + 9]!
    l[0] = (1 - 2 * (y * y + z * z)) * sx
    l[1] = 2 * (x * y - w * z) * sy
    l[2] = 2 * (x * z + w * y) * sz
    l[3] = rest[o]!
    l[4] = 2 * (x * y + w * z) * sx
    l[5] = (1 - 2 * (x * x + z * z)) * sy
    l[6] = 2 * (y * z - w * x) * sz
    l[7] = rest[o + 1]!
    l[8] = 2 * (x * z - w * y) * sx
    l[9] = 2 * (y * z + w * x) * sy
    l[10] = (1 - 2 * (x * x + y * y)) * sz
    l[11] = rest[o + 2]!
    const p = skeleton.parents[j]!
    const P = p < 0 ? skeleton.pre : model
    const po = p < 0 ? j * 12 : p * 12
    for (let r = 0; r < 3; r++) {
      const a0 = P[po + r * 4]!
      const a1 = P[po + r * 4 + 1]!
      const a2 = P[po + r * 4 + 2]!
      const a3 = P[po + r * 4 + 3]!
      model[j * 12 + r * 4] = a0 * l[0]! + a1 * l[4]! + a2 * l[8]!
      model[j * 12 + r * 4 + 1] = a0 * l[1]! + a1 * l[5]! + a2 * l[9]!
      model[j * 12 + r * 4 + 2] = a0 * l[2]! + a1 * l[6]! + a2 * l[10]!
      model[j * 12 + r * 4 + 3] = a0 * l[3]! + a1 * l[7]! + a2 * l[11]! + a3
    }
  }
  return model
}

/** Skeleton joints, parents first. */
export function jointOrderOf(skeleton: FlatSkeleton): Int16Array {
  const n = skeleton.paths.length
  const order = new Int16Array(n)
  const done = new Uint8Array(n)
  let k = 0
  const visit = (j: number) => {
    if (done[j]) return
    const p = skeleton.parents[j]!
    if (p >= 0) visit(p)
    done[j] = 1
    order[k++] = j
  }
  for (let j = 0; j < n; j++) visit(j)
  return order
}

/** The ragdoll bound to a skeleton at a rest pose (cached). Throws ragdoll/unknown-joint. */
export function bindRagdoll(
  asset: RagdollAsset,
  skeleton: FlatSkeleton,
  rest: Float32Array,
): RagdollBinding {
  let bySkel = cache.get(asset)
  if (!bySkel) {
    bySkel = new WeakMap()
    cache.set(asset, bySkel)
  }
  let byRest = bySkel.get(skeleton)
  if (!byRest) {
    byRest = new WeakMap()
    bySkel.set(skeleton, byRest)
  }
  const hit = byRest.get(rest)
  if (hit) return hit
  const b = build(asset, skeleton, rest)
  byRest.set(rest, b)
  return b
}

function build(asset: RagdollAsset, skeleton: FlatSkeleton, rest: Float32Array): RagdollBinding {
  const n = asset.bodies.length
  const jointCount = skeleton.paths.length
  const byName = new Map<string, number>()
  for (let j = 0; j < jointCount; j++) byName.set(lastSegment(skeleton.paths[j]!), j)
  const joint = new Int16Array(n)
  const bodyOf = new Int16Array(jointCount).fill(-1)
  for (let i = 0; i < n; i++) {
    const name = asset.bodies[i]!.joint
    const j = byName.get(name)
    if (j === undefined) {
      throw new ShardError('ragdoll/unknown-joint', `The skeleton has no joint "${name}"`, {
        path: `/bodies/${name}`,
        hint: 'Body names are joint names (the last segment of the skin’s joint paths).',
      })
    }
    joint[i] = j
    bodyOf[j] = i
  }
  // Parents: declared, else the nearest ancestor joint that has a body.
  const parent = new Int16Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const declared = asset.bodies[i]!.parent
    if (declared >= 0) {
      parent[i] = declared
      continue
    }
    let p = skeleton.parents[joint[i]!]!
    while (p >= 0 && bodyOf[p]! < 0) p = skeleton.parents[p]!
    parent[i] = p >= 0 ? bodyOf[p]! : -1
  }
  const roots: number[] = []
  for (let i = 0; i < n; i++) if (parent[i]! < 0) roots.push(i)
  if (roots.length !== 1) {
    throw new ShardError(
      'ragdoll/skeleton-mismatch',
      `A ragdoll needs exactly one root body; on this skeleton it has ${roots.length} (${roots.map((r) => asset.bodies[r]!.joint).join(', ')})`,
      {
        hint: 'Every body but one needs a body among its joint’s ancestors (or a declared parent).',
      },
    )
  }
  const root = roots[0]!
  // Bodies parents first.
  const order = new Int16Array(n)
  const placed = new Uint8Array(n)
  let k = 0
  const visit = (i: number) => {
    if (placed[i]) return
    if (parent[i]! >= 0) visit(parent[i]!)
    placed[i] = 1
    order[k++] = i
  }
  for (let i = 0; i < n; i++) visit(i)
  // Graph distances (BFS from each body over parent and child links).
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    if (parent[i]! >= 0) {
      adj[i]!.push(parent[i]!)
      adj[parent[i]!]!.push(i)
    }
  }
  const distance = new Uint8Array(n * n).fill(255)
  for (let s = 0; s < n; s++) {
    const queue = [s]
    distance[s * n + s] = 0
    while (queue.length) {
      const c = queue.shift()!
      for (const nb of adj[c]!) {
        if (distance[s * n + nb] !== 255) continue
        distance[s * n + nb] = Math.min(254, distance[s * n + c]! + 1)
        queue.push(nb)
      }
    }
  }
  const jointOrder = jointOrderOf(skeleton)
  const models = restModels(skeleton, rest, jointOrder)
  const restPose = new Float32Array(n * 7)
  for (let i = 0; i < n; i++) {
    const m = joint[i]! * 12
    restPose[i * 7] = models[m + 3]!
    restPose[i * 7 + 1] = models[m + 7]!
    restPose[i * 7 + 2] = models[m + 11]!
    quatFromRows(restPose, i * 7 + 3, models, m)
  }
  const anchored = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const z = asset.bodies[i]!.zone
    anchored[i] = i === root || z === 'leg_l' || z === 'leg_r' ? 1 : 0
  }
  const mass = new Float32Array(n)
  let share = 0
  for (const b of asset.bodies) share += b.mass
  for (let i = 0; i < n; i++) mass[i] = (asset.bodies[i]!.mass / (share || 1)) * asset.mass

  const anchor = new Float32Array(n * 3)
  const frame = new Float32Array(n * 4)
  const otherFrame = new Float32Array(n * 4)
  const limits = new Float32Array(n * 6)
  const hinge = new Uint8Array(n)
  const colliderPose = new Float32Array(n * 7)
  const v = new Float64Array(3)
  const q = new Float64Array(4)
  const axisX = new Float64Array(3)
  const axisZ = new Float64Array(3)
  for (let i = 0; i < n; i++) {
    const def = asset.bodies[i]!
    placeCollider(def.shape, colliderPose, i * 7)
    frame[i * 4 + 3] = 1
    otherFrame[i * 4 + 3] = 1
    const p = parent[i]!
    if (p < 0) continue
    // The joint's origin in the parent body's frame.
    v[0] = restPose[i * 7]! - restPose[p * 7]!
    v[1] = restPose[i * 7 + 1]! - restPose[p * 7 + 1]!
    v[2] = restPose[i * 7 + 2]! - restPose[p * 7 + 2]!
    qrotateInv(anchor, i * 3, restPose, p * 7 + 3, v, 0)
    // The joint frame in this body's frame: x along the bone (its twist axis).
    boneAxis(def.shape, axisX)
    const lim = def.limits ?? {
      kind: 'spherical',
      swing: [Math.PI / 4, Math.PI / 4],
      twist: [-0.5, 0.5],
    }
    if (lim.kind === 'revolute') {
      axisZ[0] = lim.axis[0]
      axisZ[1] = lim.axis[1]
      axisZ[2] = lim.axis[2]
    } else {
      axisZ[0] = 0
      axisZ[1] = 0
      axisZ[2] = 1
    }
    qfromAxes(frame, i * 4, axisX, 0, axisZ, 0)
    // The same frame seen from the parent at rest: parentRest⁻¹ · childRest · frame.
    qmulConj(q, 0, restPose, p * 7 + 3, restPose, i * 7 + 3)
    const fx = frame[i * 4]!
    const fy = frame[i * 4 + 1]!
    const fz = frame[i * 4 + 2]!
    const fw = frame[i * 4 + 3]!
    otherFrame[i * 4] = q[3]! * fx + q[0]! * fw + q[1]! * fz - q[2]! * fy
    otherFrame[i * 4 + 1] = q[3]! * fy - q[0]! * fz + q[1]! * fw + q[2]! * fx
    otherFrame[i * 4 + 2] = q[3]! * fz + q[0]! * fy - q[1]! * fx + q[2]! * fw
    otherFrame[i * 4 + 3] = q[3]! * fw - q[0]! * fx - q[1]! * fy - q[2]! * fz
    qnormalize(otherFrame, i * 4)
    // Rapier measures the parent against this body: angles are negated (physics 0117 test).
    const o = i * 6
    if (lim.kind === 'spherical') {
      limits[o] = -lim.twist[1]
      limits[o + 1] = -lim.twist[0]
      limits[o + 2] = -lim.swing[0]
      limits[o + 3] = lim.swing[0]
      limits[o + 4] = -lim.swing[1]
      limits[o + 5] = lim.swing[1]
    } else {
      // A hinge: x and y are locked by the joint itself; only its bend is limited.
      hinge[i] = 1
      limits[o + 4] = -lim.limits[1]
      limits[o + 5] = -lim.limits[0]
    }
  }
  return {
    asset,
    skeleton,
    count: n,
    joint,
    parent,
    order,
    bodyOf,
    jointOrder,
    distance,
    root,
    anchored,
    rest: restPose,
    mass,
    anchor,
    frame,
    otherFrame,
    limits,
    hinge,
    colliderPose,
  }
}

/** The shape's long axis in its joint's frame (unit): a capsule's from → to, else +y. */
export function boneAxis(shape: RagdollShape, out: Float64Array): void {
  if (shape.kind === 'capsule') {
    const dx = shape.to[0] - shape.from[0]
    const dy = shape.to[1] - shape.from[1]
    const dz = shape.to[2] - shape.from[2]
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (l > 1e-6) {
      out[0] = dx / l
      out[1] = dy / l
      out[2] = dz / l
      return
    }
  }
  out[0] = 0
  out[1] = 1
  out[2] = 0
}

const Y = [0, 1, 0]

/** A collider's place in its body's frame: a capsule's middle, turned so its y runs from → to. */
function placeCollider(shape: RagdollShape, out: Float32Array, o: number): void {
  if (shape.kind === 'capsule') {
    out[o] = (shape.from[0] + shape.to[0]) / 2
    out[o + 1] = (shape.from[1] + shape.to[1]) / 2
    out[o + 2] = (shape.from[2] + shape.to[2]) / 2
    const axis = new Float64Array(3)
    boneAxis(shape, axis)
    // The rotation taking +y onto the axis.
    const d = axis[1]!
    if (d < -0.999999) {
      out.set([1, 0, 0, 0], o + 3)
      return
    }
    const x = Y[1]! * axis[2]! - Y[2]! * axis[1]!
    const y = Y[2]! * axis[0]! - Y[0]! * axis[2]!
    const z = Y[0]! * axis[1]! - Y[1]! * axis[0]!
    out[o + 3] = x
    out[o + 4] = y
    out[o + 5] = z
    out[o + 6] = 1 + d
    qnormalize(out, o + 3)
    return
  }
  out[o] = shape.center[0]
  out[o + 1] = shape.center[1]
  out[o + 2] = shape.center[2]
  out[o + 3] = 0
  out[o + 4] = 0
  out[o + 5] = 0
  out[o + 6] = 1
}

/** A capsule's half height (the middle's, without the caps). */
export function capsuleHalfHeight(shape: RagdollShape & { kind: 'capsule' }): number {
  const dx = shape.to[0] - shape.from[0]
  const dy = shape.to[1] - shape.from[1]
  const dz = shape.to[2] - shape.from[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / 2
}

/**
 * How a hit's impulse spreads over the bodies (0117): by mass × falloff^distance from the hit body,
 * over the bodies `moving` allows (all when omitted). Writes shares summing to 1 into `out`. A hit
 * on a foot moves the leg and, less, the rest: never a 1 kg foot at hundreds of m/s.
 */
export function impulseShares(
  b: RagdollBinding,
  hit: number,
  falloff: number,
  out: Float32Array,
  moving?: (i: number) => boolean,
): void {
  const n = b.count
  let total = 0
  for (let i = 0; i < n; i++) {
    const s = moving && !moving(i) ? 0 : b.mass[i]! * falloff ** b.distance[hit * n + i]!
    out[i] = s
    total += s
  }
  for (let i = 0; i < n; i++) out[i] = total > 0 ? out[i]! / total : 0
}
