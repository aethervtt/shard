import { type AnimationLayerValue, AnimationPlayer, samplePose } from '@aethervtt/shard-animation'
import { CharacterStates } from '@aethervtt/shard-characters'
import { ChildOf, type Entity, type World } from '@aethervtt/shard-core'
import { Collider, Physics } from '@aethervtt/shard-physics'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { type RagdollAsset, RagdollAssets, type RagdollShape } from './asset'
import { bindRagdoll, capsuleHalfHeight } from './binding'
import { Ragdoll, RagdollBody, Reaction } from './components'
import { qmul, qrotate, qrotateInv, quatFromRows } from './math'
import { skeletonOf } from './skeleton'

/**
 * A game's pose for hit tests on a root with no skeleton here (a server without clips): per body,
 * its joint's pose relative to the root (t xyz, r xyzw) at `time` seconds ago. False: not known.
 */
export type RagdollPoseSource = (
  world: World,
  root: Entity,
  time: number,
  out: Float32Array,
) => boolean

const poseSources = new WeakMap<World, RagdollPoseSource>()
/** The simulation's live bodies (world poses), set by ragdollPlugin. */
const activeSources = new WeakMap<World, (root: Entity, out: Float64Array) => boolean>()
/** Frozen corpses' model-space joint rows, set by ragdollPlugin. */
const frozenSources = new WeakMap<World, (root: Entity) => Float32Array | undefined>()

/** Registers the game's pose source for hit tests (second after a Shard character). */
export function ragdollPoseSource(world: World, source: RagdollPoseSource): void {
  poseSources.set(world, source)
}

export function setActiveSource(world: World, f: (root: Entity, out: Float64Array) => boolean) {
  activeSources.set(world, f)
}

export function setFrozenSource(world: World, f: (root: Entity) => Float32Array | undefined) {
  frozenSources.set(world, f)
}

/** A rest's lying pose for a pose source: its extracted body poses, relative to the root. */
export function restPose(asset: RagdollAsset, rest: string | number, out: Float32Array): boolean {
  const r = typeof rest === 'number' ? asset.rests[rest] : asset.rests.find((x) => x.name === rest)
  if (!r?.bodies) return false
  out.set(r.bodies.subarray(0, asset.bodies.length * 7))
  return true
}

export interface BoneHit {
  /** The body hit (index in the asset), its joint name and zone. */
  body: number
  bone: string
  zone: string
  distance: number
  point: Float64Array
  normal: Float64Array
}

export const createBoneHit = (): BoneHit => ({
  body: -1,
  bone: '',
  zone: '',
  distance: 0,
  point: new Float64Array(3),
  normal: new Float64Array(3),
})

let poses = new Float64Array(7 * 32)
let model7 = new Float32Array(7 * 32)
let rows = new Float32Array(12 * 64)
const m4 = new Float64Array(4)

function rootWorld(world: World, e: Entity, out: Float64Array): void {
  const g = world.get(e, GlobalTransform).matrix
  out[0] = g[3]!
  out[1] = g[7]!
  out[2] = g[11]!
  quatFromRows(out, 3, g, 0)
}

const rootPose = new Float64Array(7)

/** Model-space body poses (relative to `frame`'s world pose) into world poses. */
function toWorld(src: ArrayLike<number>, n: number, frame: Float64Array, out: Float64Array) {
  for (let i = 0; i < n; i++) {
    const o = i * 7
    qrotate(out, o, frame, 3, src, o)
    out[o] = out[o]! + frame[0]!
    out[o + 1] = out[o + 1]! + frame[1]!
    out[o + 2] = out[o + 2]! + frame[2]!
    qmul(out, o + 3, frame, 3, src, o + 3)
  }
}

/**
 * World poses of a root's bodies (t xyz, r xyzw each) at its current pose, `time` seconds ago (lag
 * compensation; layers only): the live simulation, a Shard character (joints, a frozen pose, or
 * its clips sampled now), the game's pose source, then the asset's rest. Cold path.
 */
export function bodyPoses(
  world: World,
  root: Entity,
  asset: RagdollAsset,
  out: Float64Array,
  time = 0,
): boolean {
  const n = asset.bodies.length
  if (activeSources.get(world)?.(root, out)) return true
  const view = skeletonOf(world, root)
  if (view) {
    const b = bindRagdoll(asset, view.skeleton, view.rest)
    if (view.joints) {
      for (let i = 0; i < n; i++) {
        const e = view.joints[b.joint[i]!]!
        const g = world.get(e, GlobalTransform).matrix
        out[i * 7] = g[3]!
        out[i * 7 + 1] = g[7]!
        out[i * 7 + 2] = g[11]!
        quatFromRows(out, i * 7 + 3, g, 0)
      }
      return true
    }
    const st = view.character ? world.tryResource(CharacterStates)?.get(view.owner) : undefined
    let model: Float32Array | undefined = frozenSources.get(world)?.(root)
    if (!model && st && world.has(view.owner, AnimationPlayer)) {
      const joints = view.skeleton.paths.length
      if (rows.length < joints * 12) rows = new Float32Array(joints * 12)
      const layers = world.get(view.owner, AnimationPlayer).layers as AnimationLayerValue[]
      if (time !== 0) for (const l of layers) l.time -= time * l.speed
      try {
        samplePose(world, view.owner, st.pose, rows, 0)
      } finally {
        if (time !== 0) for (const l of layers) l.time += time * l.speed
      }
      model = st.pose.model
    }
    if (model) {
      rootWorld(world, view.owner, rootPose)
      for (let i = 0; i < n; i++) {
        const m = b.joint[i]! * 12
        model7[i * 7] = model[m + 3]!
        model7[i * 7 + 1] = model[m + 7]!
        model7[i * 7 + 2] = model[m + 11]!
        quatFromRows(model7, i * 7 + 3, model, m)
      }
      toWorld(model7, n, rootPose, out)
      return true
    }
  }
  if (model7.length < n * 7) model7 = new Float32Array(n * 7)
  const source = poseSources.get(world)
  let known = source?.(world, root, time, model7) === true
  if (!known) {
    const r = world.tryGet(root, Reaction)
    const lying = r && (r.state === 'down' || r.state === 'rested' || r.state === 'dead')
    if (lying && asset.rests[r.rest]?.bodies) known = restPose(asset, r.rest, model7)
    else if (asset.bodies.every((x) => x.rest !== undefined)) {
      for (let i = 0; i < n; i++) model7.set(asset.bodies[i]!.rest!, i * 7)
      known = true
    }
  }
  if (!known) return false
  rootWorld(world, root, rootPose)
  toWorld(model7, n, rootPose, out)
  return true
}

const lo = new Float64Array(3)
const ld = new Float64Array(3)
const tmp = new Float64Array(3)
const nrm = new Float64Array(3)

/** Ray (origin o, unit direction d) against a shape in its own frame; distance or -1, normal out. */
function rayShape(shape: RagdollShape, o: Float64Array, d: Float64Array, max: number): number {
  if (shape.kind === 'sphere') return raySphere(o, d, 0, 0, 0, shape.radius, max)
  if (shape.kind === 'box') return rayBox(o, d, shape.half, max)
  return rayCapsule(o, d, capsuleHalfHeight(shape), shape.radius, max)
}

function raySphere(
  o: Float64Array,
  d: Float64Array,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  max: number,
): number {
  const ox = o[0]! - cx
  const oy = o[1]! - cy
  const oz = o[2]! - cz
  const b = ox * d[0]! + oy * d[1]! + oz * d[2]!
  const c = ox * ox + oy * oy + oz * oz - r * r
  const disc = b * b - c
  if (disc < 0) return -1
  let t = -b - Math.sqrt(disc)
  if (t < 0) t = c <= 0 ? 0 : -1
  if (t < 0 || t > max) return -1
  nrm[0] = (ox + d[0]! * t) / r
  nrm[1] = (oy + d[1]! * t) / r
  nrm[2] = (oz + d[2]! * t) / r
  return t
}

function rayBox(o: Float64Array, d: Float64Array, h: readonly number[], max: number): number {
  let t0 = 0
  let t1 = max
  let axis = -1
  let sign = 0
  for (let k = 0; k < 3; k++) {
    const dk = d[k]!
    const ok = o[k]!
    if (Math.abs(dk) < 1e-12) {
      if (ok < -h[k]! || ok > h[k]!) return -1
      continue
    }
    let a = (-h[k]! - ok) / dk
    let b = (h[k]! - ok) / dk
    let s = -1
    if (a > b) {
      const x = a
      a = b
      b = x
      s = 1
    }
    if (a > t0) {
      t0 = a
      axis = k
      sign = s
    }
    if (b < t1) t1 = b
    if (t0 > t1) return -1
  }
  nrm[0] = nrm[1] = nrm[2] = 0
  if (axis >= 0) nrm[axis] = sign
  return t0
}

function rayCapsule(o: Float64Array, d: Float64Array, h: number, r: number, max: number): number {
  // The infinite cylinder about y, then the caps.
  let best = -1
  const a = d[0]! * d[0]! + d[2]! * d[2]!
  if (a > 1e-12) {
    const b = o[0]! * d[0]! + o[2]! * d[2]!
    const c = o[0]! * o[0]! + o[2]! * o[2]! - r * r
    const disc = b * b - a * c
    if (disc >= 0) {
      let t = (-b - Math.sqrt(disc)) / a
      if (t < 0 && c <= 0) t = 0
      const y = o[1]! + d[1]! * t
      if (t >= 0 && t <= max && y >= -h && y <= h) {
        best = t
        nrm[0] = (o[0]! + d[0]! * t) / r
        nrm[1] = 0
        nrm[2] = (o[2]! + d[2]! * t) / r
      }
    }
  }
  for (const cy of [-h, h]) {
    const n0 = nrm[0]!
    const n1 = nrm[1]!
    const n2 = nrm[2]!
    const t = raySphere(o, d, 0, cy, 0, r, max)
    if (t >= 0 && (best < 0 || t < best)) best = t
    else {
      nrm[0] = n0
      nrm[1] = n1
      nrm[2] = n2
    }
  }
  return best
}

export interface HitTestOptions {
  maxDistance?: number
  /** Seconds back (lag compensation, 0088). */
  time?: number
}

/**
 * Tests a ray against a root's bodies posed as it stands now (0117): the nearest body hit, with its
 * joint name and zone. Works on every tier and on a server: see bodyPoses for where the pose comes
 * from. Cold path (a shot).
 */
export function hitTest(
  world: World,
  root: Entity,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  out:
    | BoneHit
    | {
        body: number
        bone: string
        zone: string
        distance: number
        point: Float64Array
        normal: Float64Array
      },
  options: HitTestOptions = {},
): boolean {
  const ref = world.tryGet(root, Ragdoll)?.asset
  const asset = ref ? world.tryResource(RagdollAssets)?.get(ref) : undefined
  if (!asset) return false
  const n = asset.bodies.length
  if (poses.length < n * 7) poses = new Float64Array(n * 7)
  if (!bodyPoses(world, root, asset, poses, options.time ?? 0)) return false
  const dl = Math.sqrt(direction[0]! ** 2 + direction[1]! ** 2 + direction[2]! ** 2)
  if (dl === 0) return false
  const dx = direction[0]! / dl
  const dy = direction[1]! / dl
  const dz = direction[2]! / dl
  const max = options.maxDistance ?? 1e9
  let best = -1
  let bestT = max
  for (let i = 0; i < n; i++) {
    const shape = asset.bodies[i]!.shape
    const o = i * 7
    // Into the body's frame, then the collider's (its center, turned so a capsule runs along y).
    tmp[0] = origin[0]! - poses[o]!
    tmp[1] = origin[1]! - poses[o + 1]!
    tmp[2] = origin[2]! - poses[o + 2]!
    qrotateInv(lo, 0, poses, o + 3, tmp, 0)
    tmp[0] = dx
    tmp[1] = dy
    tmp[2] = dz
    qrotateInv(ld, 0, poses, o + 3, tmp, 0)
    shapeFrame(shape, m4)
    if (shape.kind === 'capsule') {
      const cx = (shape.from[0] + shape.to[0]) / 2
      const cy = (shape.from[1] + shape.to[1]) / 2
      const cz = (shape.from[2] + shape.to[2]) / 2
      tmp[0] = lo[0]! - cx
      tmp[1] = lo[1]! - cy
      tmp[2] = lo[2]! - cz
      qrotateInv(lo, 0, m4, 0, tmp, 0)
      qrotateInv(ld, 0, m4, 0, ld, 0)
    } else {
      lo[0] = lo[0]! - shape.center[0]
      lo[1] = lo[1]! - shape.center[1]
      lo[2] = lo[2]! - shape.center[2]
    }
    const t = rayShape(shape, lo, ld, bestT)
    if (t < 0 || t >= bestT) continue
    bestT = t
    best = i
    // The normal back to world.
    if (shape.kind === 'capsule') qrotate(tmp, 0, m4, 0, nrm, 0)
    else {
      tmp[0] = nrm[0]!
      tmp[1] = nrm[1]!
      tmp[2] = nrm[2]!
    }
    qrotate(out.normal, 0, poses, o + 3, tmp, 0)
  }
  if (best < 0) return false
  out.body = best
  out.bone = asset.bodies[best]!.joint
  out.zone = asset.bodies[best]!.zone
  out.distance = bestT
  out.point[0] = origin[0]! + dx * bestT
  out.point[1] = origin[1]! + dy * bestT
  out.point[2] = origin[2]! + dz * bestT
  return true
}

/** The rotation taking +y onto a capsule's axis (identity for other shapes). */
function shapeFrame(shape: RagdollShape, out: Float64Array): void {
  out[0] = out[1] = out[2] = 0
  out[3] = 1
  if (shape.kind !== 'capsule') return
  const dx = shape.to[0] - shape.from[0]
  const dy = shape.to[1] - shape.from[1]
  const dz = shape.to[2] - shape.from[2]
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (l < 1e-9) return
  const ax = dx / l
  const ay = dy / l
  const az = dz / l
  if (ay < -0.999999) {
    out[0] = 1
    out[3] = 0
    return
  }
  // +y × axis, and 1 + +y · axis.
  out[0] = az
  out[1] = 0
  out[2] = -ax
  out[3] = 1 + ay
  const len = Math.sqrt(out[0]! ** 2 + out[2]! ** 2 + out[3]! ** 2)
  out[0] /= len
  out[2] /= len
  out[3] /= len
}

export interface CastHit {
  /** The ragdoll root hit, or -1 for the world. */
  root: Entity
  /** The collider hit (world hits), else the root. */
  entity: Entity
  body: number
  bone: string
  zone: string
  distance: number
  point: Float64Array
  normal: Float64Array
}

/**
 * A bone-accurate raycast (0117): the physics ray, with every ragdoll root's capsule it passes
 * refined against its bodies (a ray grazing a capsule but missing every limb goes on), and live
 * ragdoll bodies hit directly. Returns the nearest bone or world hit, or undefined. Cold path.
 */
export function castHit(
  world: World,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  options: { maxDistance?: number; time?: number; exclude?: Entity } = {},
): CastHit | undefined {
  const p = world.tryResource(Physics)
  if (!p) return undefined
  const hits = p.raycastAll(origin, direction, {
    maxDistance: options.maxDistance,
    sensors: true,
    ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
  })
  const tried = new Set<Entity>()
  const bone = createBoneHit()
  let best: CastHit | undefined
  for (const h of hits) {
    if (best && h.distance >= best.distance) break
    const body = h.body >= 0 ? h.body : h.entity
    // A live ragdoll body: hit directly.
    const rb = world.tryGet(body, RagdollBody)
    if (rb && rb.root !== null && rb.root >= 0) {
      const root = rb.root as Entity
      const asset = world
        .tryResource(RagdollAssets)
        ?.get(world.tryGet(root, Ragdoll)?.asset ?? null!)
      best = {
        root,
        entity: h.entity,
        body: rb.body,
        bone: asset?.bodies[rb.body]?.joint ?? '',
        zone: asset?.bodies[rb.body]?.zone ?? '',
        distance: h.distance,
        point: Float64Array.from(h.point),
        normal: Float64Array.from(h.normal),
      }
      continue
    }
    const root = findRoot(world, body)
    if (root === undefined) {
      if (sensorOnly(world, h.entity)) continue
      best = {
        root: -1 as Entity,
        entity: h.entity,
        body: -1,
        bone: '',
        zone: '',
        distance: h.distance,
        point: Float64Array.from(h.point),
        normal: Float64Array.from(h.normal),
      }
      continue
    }
    if (tried.has(root)) continue
    tried.add(root)
    if (activeSources.get(world)?.(root, poses)) continue // its bodies answer for it
    const max = options.maxDistance ?? 1e9
    if (
      !hitTest(world, root, origin, direction, bone, { maxDistance: max, time: options.time ?? 0 })
    )
      continue
    if (best && bone.distance >= best.distance) continue
    best = {
      root,
      entity: root,
      body: bone.body,
      bone: bone.bone,
      zone: bone.zone,
      distance: bone.distance,
      point: Float64Array.from(bone.point),
      normal: Float64Array.from(bone.normal),
    }
  }
  return best
}

/** A sensor that isn't a ragdoll root's (a trigger): rays pass through. */
function sensorOnly(world: World, e: Entity): boolean {
  return world.tryGet(e, Collider)?.sensor === true
}

/** The ragdoll root a collider belongs to: itself or an ancestor with Ragdoll. */
function findRoot(world: World, e: Entity): Entity | undefined {
  let cur: Entity | null = e
  for (let depth = 0; cur !== null && depth < 16; depth++) {
    if (!world.isAlive(cur)) return undefined
    if (world.has(cur, Ragdoll)) return cur
    cur = world.has(cur, ChildOf) ? world.get(cur, ChildOf).parent : null
  }
  return undefined
}
