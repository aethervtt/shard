import { type Entity, ShardError, type World } from '@aethervtt/shard-core'
import { type SkinAsset, Skins } from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'
import { type AnimationClipAsset, AnimationClips } from './clip'
import {
  type AnimationLayerValue,
  AnimationMasks,
  AnimationPlayer,
  ROOT_MOTION_MODES,
} from './components'
import {
  type Binding,
  bindClip,
  blendLayers,
  type ClipLookup,
  type FlatLayout,
  holdTimes,
  type MaskLookup,
  makeSlot,
  mulRows,
  newBinding,
  normalizeAt,
  prepareRoot,
  restRows,
  type Slot,
  setRetarget,
  syncRetarget,
} from './player'
import type { JointMapAsset, RETARGET_MODES } from './retarget'

/**
 * A skeleton for flat poses (0115): joints by index instead of entities. Characters on one rig
 * share it.
 */
export interface FlatSkeleton {
  /** Joint paths relative to the player entity (a SkinAsset's `joints`). */
  paths: string[]
  /** Parent joint index, or -1. */
  parents: Int16Array
  /**
   * 12 floats (3x4 affine rows) per joint: for a top joint (parent -1), the model-space transform
   * of its non-joint ancestors under the player; identity otherwise.
   */
  pre: Float32Array
  /** 16 per joint, column-major (SkinAsset.inverseBindMatrices). */
  inverseBind: Float32Array
}

/** One character's flat pose, owned by the caller. */
export interface FlatPose {
  skeleton: FlatSkeleton
  /** 10 floats per joint (t xyz, r xyzw, s xyz): the build's rest pose. */
  rest: Float32Array
  /** 10 per joint: the last sampled local pose (rest where unanimated). */
  local: Float32Array
  /** 12 per joint: model-space rows (relative to the player) of the last sample. */
  model: Float32Array
  /** The sampler's state: clip bindings by joint lane, key cursors, retarget plans. Internal. */
  readonly state: object
}

/** A joint's local transform, as a SkinAsset's rest pose holds it. */
export interface JointTrs {
  translation: ArrayLike<number>
  rotation: ArrayLike<number>
  scale: ArrayLike<number>
}

interface Layout extends FlatLayout {
  skeleton: FlatSkeleton
  /** Joint paths, and their ancestors as -1 (retargeting matches names among them). */
  paths: Map<string, Entity>
  /** Three lanes per joint: translation, rotation, scale. */
  slots: Slot[]
  byKey: Map<string, number>
  /** Joint indices, parents before children. */
  order: Int32Array
  /** Inverse binds as affine rows (12 per joint). */
  bindRows: Float32Array
}

const layouts = new WeakMap<FlatSkeleton, Layout>()

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** The lanes and lookups every pose of a skeleton shares (cold: once per skeleton). */
function layoutOf(skeleton: FlatSkeleton): Layout {
  const hit = layouts.get(skeleton)
  if (hit) return hit
  const n = skeleton.paths.length
  if (skeleton.parents.length !== n || skeleton.pre.length < n * 12) {
    throw new ShardError(
      'animation/invalid-flat-skeleton',
      `A flat skeleton of ${n} joints needs ${n} parents and ${n * 12} pre floats`,
      { hint: 'Build it with flatSkeleton(skin).' },
    )
  }
  const index = new Map<string, number>()
  const paths = new Map<string, Entity>()
  const slots: Slot[] = []
  const byKey = new Map<string, number>()
  for (let j = 0; j < n; j++) {
    const path = skeleton.paths[j]!
    index.set(path, j)
    paths.set(path, j)
    for (let p = parentPath(path); p !== '' && !paths.has(p); p = parentPath(p)) paths.set(p, -1)
    const lanes = [
      ['translation', 3, 0],
      ['rotation', 4, 3],
      ['scale', 3, 7],
    ] as const
    for (const [field, width, at] of lanes) {
      byKey.set(`${path}|${Transform.name}|${field}`, slots.length)
      slots.push(
        makeSlot(
          -1,
          path,
          Transform,
          field,
          width,
          field === 'rotation',
          false,
          j * 10 + at,
          width,
        ),
      )
    }
  }
  // Parents before children: by depth in the joint hierarchy.
  const depth = new Int32Array(n)
  for (let j = 0; j < n; j++) {
    let d = 0
    for (let p = skeleton.parents[j]!; p >= 0 && d <= n; p = skeleton.parents[p]!) d++
    if (d > n) {
      throw new ShardError('animation/invalid-flat-skeleton', `Joint ${j}'s parents form a cycle`)
    }
    depth[j] = d
  }
  const order = Int32Array.from({ length: n }, (_, j) => j).sort((a, b) => depth[a]! - depth[b]!)
  // Inverse binds are affine (bottom row 0 0 0 1): keep their top three rows.
  const ibm = skeleton.inverseBind
  if (ibm.length < n * 16) {
    throw new ShardError(
      'animation/invalid-flat-skeleton',
      `A flat skeleton of ${n} joints needs ${n * 16} inverse bind floats, not ${ibm.length}`,
    )
  }
  const bindRows = new Float32Array(n * 12)
  for (let j = 0; j < n; j++)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++) bindRows[j * 12 + r * 4 + c] = ibm[j * 16 + c * 4 + r]!
  const layout: Layout = {
    skeleton,
    index,
    parents: skeleton.parents,
    pre: skeleton.pre,
    paths,
    slots,
    byKey,
    order,
    bindRows,
  }
  layouts.set(skeleton, layout)
  return layout
}

/**
 * A flat skeleton from a skin: parents from the joint paths, and each top joint's `pre` composed
 * from `ancestorOf` (the local transform of a non-joint path above it, such as a glTF Armature
 * node; undefined is identity).
 */
export function flatSkeleton(
  skin: SkinAsset,
  ancestorOf?: (path: string) => JointTrs | undefined,
): FlatSkeleton {
  const n = skin.joints.length
  const index = new Map(skin.joints.map((p, j) => [p, j]))
  const parents = new Int16Array(n).fill(-1)
  const pre = new Float32Array(n * 12)
  const rows = new Float32Array(12)
  const trs = new Float32Array(10)
  for (let j = 0; j < n; j++) {
    let p = parentPath(skin.joints[j]!)
    while (p !== '' && !index.has(p)) p = parentPath(p)
    if (p !== '') {
      parents[j] = index.get(p)!
      pre.set(IDENTITY_ROWS, j * 12)
      continue
    }
    // Top joint: its ancestors from the player down.
    const m = pre.subarray(j * 12, j * 12 + 12)
    m.set(IDENTITY_ROWS)
    const segments = skin.joints[j]!.split('/')
    for (let k = 1; k < segments.length; k++) {
      const local = ancestorOf?.(segments.slice(0, k).join('/'))
      if (!local) continue
      trs.set(local.translation, 0)
      trs.set(local.rotation, 3)
      trs.set(local.scale, 7)
      restRows(rows, trs, 0)
      mulRows(m, m, rows)
    }
  }
  return { paths: [...skin.joints], parents, pre, inverseBind: skin.inverseBindMatrices }
}

const IDENTITY_ROWS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]

/** A skin's rest pose as a flat pose's `rest` (10 floats per joint). */
export function flatRest(skin: SkinAsset): Float32Array {
  const out = new Float32Array(skin.joints.length * 10)
  for (let j = 0; j < skin.joints.length; j++) {
    const r = skin.restPose[j]
    out.set(r?.translation ?? [0, 0, 0], j * 10)
    out.set(r?.rotation ?? [0, 0, 0, 1], j * 10 + 3)
    out.set(r?.scale ?? [1, 1, 1], j * 10 + 7)
  }
  return out
}

/** A character's flat pose on `skeleton`, starting at `rest` (10 floats per joint, kept by reference). */
export function createFlatPose(skeleton: FlatSkeleton, rest: Float32Array): FlatPose {
  const layout = layoutOf(skeleton)
  const n = skeleton.paths.length
  if (rest.length < n * 10) {
    throw new ShardError(
      'animation/invalid-flat-pose',
      `A rest pose for ${n} joints needs ${n * 10} floats, not ${rest.length}`,
    )
  }
  const local = new Float32Array(n * 10)
  local.set(rest.subarray(0, n * 10))
  const state = newBinding(
    -1,
    layout.paths,
    layout.slots,
    layout.byKey,
    local,
    rest,
    new Uint8Array(n * 3),
    layout,
  )
  return { skeleton, rest, local, model: new Float32Array(n * 12), state }
}

const NO_LAYERS: AnimationLayerValue[] = []

/** This sample's model-space joint bounds (min xyz, max xyz). */
const bounds = new Float64Array(6)

/**
 * Samples `entity`'s AnimationPlayer layers at their current times (it never advances them) into
 * `pose`: the same channel code, blending, masks (by joint path) and Retarget corrections as
 * animation/sample, onto joints by index, from `pose.rest` where nothing animates. Only joint
 * Transform channels play; property and morph channels are skipped. With root motion on, the root
 * joint is pinned in place as on entities, and nothing moves the entity. Writes `pose.local`,
 * `pose.model`, and at `out[outBase + j * 12]` the rows of `model × inverseBind` (3x4, row-major).
 * With `radii` (per joint; -1 unused) and `sphere`, writes the model-space bounding sphere of the
 * posed joints padded by their radii (center xyz, radius). Allocates nothing once its clips bind.
 */
export function samplePose(
  world: World,
  entity: Entity,
  pose: FlatPose,
  out: Float32Array,
  outBase: number,
  radii?: Float32Array,
  sphere?: Float32Array,
): void {
  if (!world.isAlive(entity)) {
    throw new ShardError('animation/no-entity', `samplePose: entity ${entity} is not alive`)
  }
  const b = pose.state as Binding
  const table = world.entityTableUnchecked(entity)
  const row = world.entityRowUnchecked(entity)
  let layers = NO_LAYERS
  let pin = false
  let rootJoint = ''
  if (table.has(AnimationPlayer)) {
    layers = (table.column(AnimationPlayer, 'layers') as AnimationLayerValue[][])[row]!
    pin = ROOT_MOTION_MODES[table.column(AnimationPlayer, 'rootMotion')[row]!] !== 'none'
    rootJoint = (table.column(AnimationPlayer, 'rootJoint') as string[])[row]!
    syncRetarget(world, b, table, row, world.tryResource(Skins))
  }
  const clips = world.resource(AnimationClips)
  sampleFlat(world, b, pose, layers, clips, world.tryResource(AnimationMasks), pin, rootJoint)
  poseRows(pose, b.flat as Layout, out, outBase, radii)
  if (radii !== undefined && sphere !== undefined) boundsSphere(sphere)
}

/** Binds, then blends layers into pose.local (rest where unanimated, rotations normalized). */
function sampleFlat(
  world: World,
  b: Binding,
  pose: FlatPose,
  layers: AnimationLayerValue[],
  clips: ClipLookup,
  masks: MaskLookup | undefined,
  pin: boolean,
  rootJoint: string,
): void {
  for (let li = 0; li < layers.length; li++) {
    const clip = clips.get(layers[li]!.clip)
    if (!clip) continue
    const cb = b.clips.get(clip)
    // The skeleton never changes, so channels with no joint stay unbound (no retries).
    if (!cb || cb.channels !== clip.channels) bindClip(world, b, clip, 0)
  }
  holdTimes(layers)
  const rootOn = pin && prepareRoot(world, b, rootJoint)
  const local = pose.local
  local.set(pose.rest)
  blendLayers(b, layers, clips, masks, rootOn, false)
  const active = b.active
  const n = pose.skeleton.paths.length
  for (let j = 0; j < n; j++) if (active[j * 3 + 1] !== 0) normalizeAt(local, j * 10 + 3)
}

/**
 * pose.model from pose.local (parents first, `pre` above top joints), then `model × inverseBind`
 * rows into `out`, and with `radii` the joints' bounds into `bounds`.
 */
function poseRows(
  pose: FlatPose,
  layout: Layout,
  out: Float32Array,
  outBase: number,
  radii: Float32Array | undefined,
): void {
  const order = layout.order
  const parents = layout.parents
  const pre = layout.pre
  const bind = layout.bindRows
  const local = pose.local
  const model = pose.model
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let n = 0; n < order.length; n++) {
    const j = order[n]!
    const o = j * 10
    // Local rows from TRS.
    const x = local[o + 3]!
    const y = local[o + 4]!
    const z = local[o + 5]!
    const w = local[o + 6]!
    const sx = local[o + 7]!
    const sy = local[o + 8]!
    const sz = local[o + 9]!
    const l00 = (1 - 2 * (y * y + z * z)) * sx
    const l01 = 2 * (x * y - w * z) * sy
    const l02 = 2 * (x * z + w * y) * sz
    const l03 = local[o]!
    const l10 = 2 * (x * y + w * z) * sx
    const l11 = (1 - 2 * (x * x + z * z)) * sy
    const l12 = 2 * (y * z - w * x) * sz
    const l13 = local[o + 1]!
    const l20 = 2 * (x * z - w * y) * sx
    const l21 = 2 * (y * z + w * x) * sy
    const l22 = (1 - 2 * (x * x + y * y)) * sz
    const l23 = local[o + 2]!
    // model = parent × local (rounded to f32 as stored, so children compose what's kept).
    const p = parents[j]!
    const P = p < 0 ? pre : model
    const po = p < 0 ? j * 12 : p * 12
    const mo = j * 12
    let a0 = P[po]!
    let a1 = P[po + 1]!
    let a2 = P[po + 2]!
    let a3 = P[po + 3]!
    model[mo] = a0 * l00 + a1 * l10 + a2 * l20
    model[mo + 1] = a0 * l01 + a1 * l11 + a2 * l21
    model[mo + 2] = a0 * l02 + a1 * l12 + a2 * l22
    model[mo + 3] = a0 * l03 + a1 * l13 + a2 * l23 + a3
    a0 = P[po + 4]!
    a1 = P[po + 5]!
    a2 = P[po + 6]!
    a3 = P[po + 7]!
    model[mo + 4] = a0 * l00 + a1 * l10 + a2 * l20
    model[mo + 5] = a0 * l01 + a1 * l11 + a2 * l21
    model[mo + 6] = a0 * l02 + a1 * l12 + a2 * l22
    model[mo + 7] = a0 * l03 + a1 * l13 + a2 * l23 + a3
    a0 = P[po + 8]!
    a1 = P[po + 9]!
    a2 = P[po + 10]!
    a3 = P[po + 11]!
    model[mo + 8] = a0 * l00 + a1 * l10 + a2 * l20
    model[mo + 9] = a0 * l01 + a1 * l11 + a2 * l21
    model[mo + 10] = a0 * l02 + a1 * l12 + a2 * l22
    model[mo + 11] = a0 * l03 + a1 * l13 + a2 * l23 + a3
    // out = model × inverseBind.
    const bo = j * 12
    const b00 = bind[bo]!
    const b01 = bind[bo + 1]!
    const b02 = bind[bo + 2]!
    const b03 = bind[bo + 3]!
    const b10 = bind[bo + 4]!
    const b11 = bind[bo + 5]!
    const b12 = bind[bo + 6]!
    const b13 = bind[bo + 7]!
    const b20 = bind[bo + 8]!
    const b21 = bind[bo + 9]!
    const b22 = bind[bo + 10]!
    const b23 = bind[bo + 11]!
    const oo = outBase + j * 12
    const m00 = model[mo]!
    const m01 = model[mo + 1]!
    const m02 = model[mo + 2]!
    const m03 = model[mo + 3]!
    const m10 = model[mo + 4]!
    const m11 = model[mo + 5]!
    const m12 = model[mo + 6]!
    const m13 = model[mo + 7]!
    const m20 = model[mo + 8]!
    const m21 = model[mo + 9]!
    const m22 = model[mo + 10]!
    const m23 = model[mo + 11]!
    out[oo] = m00 * b00 + m01 * b10 + m02 * b20
    out[oo + 1] = m00 * b01 + m01 * b11 + m02 * b21
    out[oo + 2] = m00 * b02 + m01 * b12 + m02 * b22
    out[oo + 3] = m00 * b03 + m01 * b13 + m02 * b23 + m03
    out[oo + 4] = m10 * b00 + m11 * b10 + m12 * b20
    out[oo + 5] = m10 * b01 + m11 * b11 + m12 * b21
    out[oo + 6] = m10 * b02 + m11 * b12 + m12 * b22
    out[oo + 7] = m10 * b03 + m11 * b13 + m12 * b23 + m13
    out[oo + 8] = m20 * b00 + m21 * b10 + m22 * b20
    out[oo + 9] = m20 * b01 + m21 * b11 + m22 * b21
    out[oo + 10] = m20 * b02 + m21 * b12 + m22 * b22
    out[oo + 11] = m20 * b03 + m21 * b13 + m22 * b23 + m23
    if (radii === undefined) continue
    // Bounds: the joint's sphere, its radius scaled by the joint's largest axis.
    const radius = radii[j]!
    if (radius < 0) continue
    let s2 = m00 * m00 + m10 * m10 + m20 * m20
    const s2y = m01 * m01 + m11 * m11 + m21 * m21
    const s2z = m02 * m02 + m12 * m12 + m22 * m22
    if (s2y > s2) s2 = s2y
    if (s2z > s2) s2 = s2z
    const wr = radius * Math.sqrt(s2)
    if (m03 - wr < minX) minX = m03 - wr
    if (m13 - wr < minY) minY = m13 - wr
    if (m23 - wr < minZ) minZ = m23 - wr
    if (m03 + wr > maxX) maxX = m03 + wr
    if (m13 + wr > maxY) maxY = m13 + wr
    if (m23 + wr > maxZ) maxZ = m23 + wr
  }
  bounds[0] = minX
  bounds[1] = minY
  bounds[2] = minZ
  bounds[3] = maxX
  bounds[4] = maxY
  bounds[5] = maxZ
}

/** The sphere around `bounds` (center, half diagonal), as render's skinned bounds; 0 when empty. */
function boundsSphere(sphere: Float32Array): void {
  if (bounds[0]! > bounds[3]!) {
    sphere[0] = sphere[1] = sphere[2] = sphere[3] = 0
    return
  }
  const ex = (bounds[3]! - bounds[0]!) * 0.5
  const ey = (bounds[4]! - bounds[1]!) * 0.5
  const ez = (bounds[5]! - bounds[2]!) * 0.5
  sphere[0] = bounds[0]! + ex
  sphere[1] = bounds[1]! + ey
  sphere[2] = bounds[2]! + ez
  sphere[3] = Math.sqrt(ex * ex + ey * ey + ez * ez)
}

/** What bakeClip retargets from: as the Retarget component, with assets instead of handles. */
export interface BakeRetarget {
  skin: SkinAsset
  map?: JointMapAsset
  mode: (typeof RETARGET_MODES)[number]
  /** Default true, as Retarget's. */
  align?: boolean
}

export interface BakedClip {
  frames: number
  /** frames × joints × 12: each frame's `model × inverseBind` rows, as samplePose writes them. */
  rows: Float32Array
  /** Model-space bounding sphere over every frame (center xyz, radius). */
  sphere: Float32Array
}

/**
 * Bakes one clip on a skeleton: sampled alone (weight 1, override) at `max(2, round(duration ×
 * fps) + 1)` evenly spaced times from 0 to the duration inclusive, through samplePose's code, so a
 * frame equals samplePose at its time bit for bit (for a player whose rootMotion is 'none' unless
 * `pin`). With `pin`, the root joint's ground-plane travel and yaw are taken out, as samplePose
 * does with root motion on. `radii` pad the bounds (per joint, -1 unused; default 0 for every
 * joint). Cold: allocates its result.
 */
export function bakeClip(
  world: World,
  skeleton: FlatSkeleton,
  rest: Float32Array,
  clip: AnimationClipAsset,
  fps: number,
  retarget?: BakeRetarget,
  radii?: Float32Array,
  pin = false,
): BakedClip {
  if (!(fps > 0)) {
    throw new ShardError('animation/invalid-bake', `bakeClip needs fps > 0, not ${fps}`)
  }
  const pose = createFlatPose(skeleton, rest)
  const b = pose.state as Binding
  if (retarget) {
    setRetarget(b, retarget.skin, retarget.map, retarget.mode, retarget.align ?? true)
  }
  const n = skeleton.paths.length
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1)
  const rows = new Float32Array(frames * n * 12)
  const layer: AnimationLayerValue = {
    clip: null,
    time: 0,
    speed: 1,
    weight: 1,
    loop: 'loop',
    blend: 'override',
    mask: null,
    playing: true,
    fadeTo: 1,
    fadeSpeed: 0,
  }
  const layers = [layer]
  const lookup: ClipLookup = { get: () => clip }
  const pad = radii ?? new Float32Array(n)
  const all = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]
  for (let f = 0; f < frames; f++) {
    layer.time = (f / (frames - 1)) * clip.duration
    sampleFlat(world, b, pose, layers, lookup, undefined, pin, '')
    poseRows(pose, b.flat as Layout, rows, f * n * 12, pad)
    for (let k = 0; k < 3; k++) {
      all[k] = Math.min(all[k]!, bounds[k]!)
      all[k + 3] = Math.max(all[k + 3]!, bounds[k + 3]!)
    }
  }
  bounds.set(all)
  const sphere = new Float32Array(4)
  boundsSphere(sphere)
  return { frames, rows, sphere }
}
