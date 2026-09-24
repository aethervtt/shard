import {
  type AssetRef,
  ChildOf,
  type ComponentDef,
  type ComponentStorage,
  defineResource,
  defineSystem,
  type Entity,
  findComponent,
  type Table,
  type TypedArray,
  type World,
} from '@shard/core'
import { descendantPaths } from '@shard/render'
import { Time } from '@shard/runtime'
import { Transform } from '@shard/transform'
import {
  type AnimationChannel,
  type AnimationClipAsset,
  AnimationClips,
  sampleChannelAt,
  slerpAt,
} from './clip'
import {
  AnimationEvent,
  AnimationFinished,
  type AnimationLayerValue,
  type AnimationMaskAsset,
  AnimationMasks,
  AnimationPlayer,
  maskWeight,
  ROOT_MOTION_MODES,
  RootMotion,
} from './components'

// --- binding ---------------------------------------------------------------------------------

/** One animated value: a component field of a bound entity, with its cached column. */
interface Slot {
  entity: Entity
  path: string
  def: ComponentDef
  field: string
  width: number
  quat: boolean
  /** An object column holding number[] (morph weights). */
  list: boolean
  /** Where this slot's floats sit in the binding's pose and rest arrays. */
  offset: number
  // Cached column access; refetched when the entity moves table or the table grows.
  table: Table | undefined
  capacity: number
  row: number
  storage: ComponentStorage | undefined
  column: TypedArray | unknown[] | undefined
  stride: number
}

interface ClipBinding {
  channels: AnimationChannel[]
  /** Slot per channel, or -1 for a target that isn't there. */
  slotOf: Int32Array
  /** Last frame's key per channel, so sampling is O(1). */
  cursors: Uint32Array
  /** Channels whose target is missing: `target component.field (why)`. */
  unbound: string[]
  /** Frame to retry the unbound ones (instances spawn late). */
  retryAt: number
}

interface MaskBinding {
  joints: Record<string, number>
  slotCount: number
  weights: Float32Array
}

interface Binding {
  root: Entity
  paths: Map<string, Entity>
  slots: Slot[]
  byKey: Map<string, number>
  pose: Float32Array
  rest: Float32Array
  active: Uint8Array
  clips: Map<AnimationClipAsset, ClipBinding>
  masks: Map<AnimationMaskAsset, MaskBinding>
  /** Scratch for one sampled value (the widest channel). */
  scratch: Float32Array
  /** Per layer: its effective weight on the root (for blending root motion). */
  layerWeights: Float32Array
  root_: RootState
  /** CharacterIntent.move added last frame, taken back before adding this frame's. */
  added: Float32Array
}

/** Root motion: which slots are the root's translation and rotation, and this frame's motion. */
interface RootState {
  path: string | undefined
  translation: number
  rotation: number
  /** Model-space transform of the root's parent (affine rows) and its rotation. */
  parent: Float32Array
  parentInverse: Float32Array
  parentRotation: Float32Array
  motion: Float32Array
  yaw: number
  /** The yaw taken out at the layer's previous time (travel turns with it). */
  turn: number
}

function createRoot(): RootState {
  return {
    path: undefined,
    translation: -1,
    rotation: -1,
    parent: new Float32Array(12),
    parentInverse: new Float32Array(12),
    parentRotation: new Float32Array(4),
    motion: new Float32Array(3),
    yaw: 0,
    turn: 0,
  }
}

/** The player state of every entity with an AnimationPlayer. */
export interface AnimationState {
  bindings: Map<Entity, Binding>
  frame: number
}

export const AnimationStateResource = defineResource<AnimationState>('animation/State', {
  description: "Players' bindings: slots per channel, rest poses, and cursors. Internal.",
  init: () => ({ bindings: new Map(), frame: 0 }),
})

function createBinding(world: World, root: Entity): Binding {
  return {
    root,
    paths: descendantPaths(world, root),
    slots: [],
    byKey: new Map(),
    pose: new Float32Array(64),
    rest: new Float32Array(64),
    active: new Uint8Array(16),
    clips: new Map(),
    masks: new Map(),
    scratch: new Float32Array(16),
    layerWeights: new Float32Array(8),
    root_: createRoot(),
    added: new Float32Array(3),
  }
}

const animatableKinds = new Set([
  'f32',
  'f64',
  'i8',
  'i16',
  'i32',
  'u8',
  'u16',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'quat',
  'color',
])

/** The slot for a channel's target, created (with its rest value) on first use. Cold path. */
function slotFor(world: World, b: Binding, c: AnimationChannel): number | string {
  const entity = b.paths.get(c.target)
  if (entity === undefined || !world.isAlive(entity)) return 'no entity at this path'
  const key = `${c.target}|${c.component}|${c.field}`
  const existing = b.byKey.get(key)
  if (existing !== undefined) return existing
  const def = findComponent(c.component)
  if (!def) return 'component not defined'
  if (!world.has(entity, def)) return `entity has no ${c.component}`
  const layout = def.layout.find((l) => l.name === c.field)
  if (!layout) return 'no such field'
  const list = layout.field.kind === 'list'
  if (!list && !animatableKinds.has(layout.field.kind)) return 'field is not numeric'
  const width = list ? c.width : layout.stride
  const offset = b.slots.length === 0 ? 0 : slotEnd(b.slots[b.slots.length - 1]!)
  const slot: Slot = {
    entity,
    path: c.target,
    def,
    field: c.field,
    width,
    quat: layout.field.kind === 'quat',
    list,
    offset,
    table: undefined,
    capacity: 0,
    row: 0,
    storage: undefined,
    column: undefined,
    stride: layout.stride,
  }
  const index = b.slots.length
  b.slots.push(slot)
  b.byKey.set(key, index)
  const floats = offset + width
  if (floats > b.pose.length) {
    let size = b.pose.length * 2
    while (size < floats) size *= 2
    const pose = new Float32Array(size)
    pose.set(b.pose)
    const rest = new Float32Array(size)
    rest.set(b.rest)
    b.pose = pose
    b.rest = rest
  }
  if (b.slots.length > b.active.length) {
    const active = new Uint8Array(b.active.length * 2)
    active.set(b.active)
    b.active = active
  }
  if (width > b.scratch.length) b.scratch = new Float32Array(width * 2)
  // The value when bound is the rest pose that layers blend from.
  refresh(world, slot)
  readSlot(slot, b.rest, offset)
  b.masks.clear()
  return index
}

function slotEnd(s: Slot): number {
  return s.offset + s.width
}

/** Re-reads the slot's table, row, and columns if the entity moved or its table grew. */
function refresh(world: World, s: Slot): boolean {
  if (!world.isAlive(s.entity)) return false
  const table = world.entityTableUnchecked(s.entity)
  const row = world.entityRowUnchecked(s.entity)
  if (table !== s.table || table.capacity !== s.capacity) {
    const storage = table.storage(s.def)
    if (!storage) return false
    s.table = table
    s.capacity = table.capacity
    s.storage = storage
    s.column = storage.byName[s.field] as TypedArray | unknown[]
  }
  s.row = row
  return true
}

function readSlot(s: Slot, out: Float32Array, o: number): void {
  if (s.list) {
    const list = (s.column as unknown[])[s.row] as number[] | undefined
    for (let k = 0; k < s.width; k++) out[o + k] = list?.[k] ?? 0
    return
  }
  const col = s.column as TypedArray
  const base = s.row * s.stride
  for (let k = 0; k < s.width; k++) out[o + k] = col[base + k]!
}

function writeSlot(s: Slot, from: Float32Array, o: number, tick: number): void {
  if (s.list) {
    const col = s.column as unknown[]
    let list = col[s.row] as number[] | undefined
    if (!list) {
      list = []
      col[s.row] = list
    }
    for (let k = 0; k < s.width; k++) list[k] = from[o + k]!
  } else {
    const col = s.column as TypedArray
    const base = s.row * s.stride
    for (let k = 0; k < s.width; k++) col[base + k] = from[o + k]!
  }
  const storage = s.storage!
  storage.changed[s.row] = tick
  storage.lastChanged = tick
}

function bindClip(world: World, b: Binding, clip: AnimationClipAsset, frame: number): ClipBinding {
  const channels = clip.channels
  const cb: ClipBinding = {
    channels,
    slotOf: new Int32Array(channels.length).fill(-1),
    cursors: new Uint32Array(channels.length),
    unbound: [],
    retryAt: frame + 30,
  }
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i]!
    const r = slotFor(world, b, c)
    if (typeof r === 'number') cb.slotOf[i] = r
    else cb.unbound.push(`${c.target || '(self)'} ${c.component}.${c.field} (${r})`)
  }
  b.clips.set(clip, cb)
  b.root_.path = undefined // re-pick the root joint
  return cb
}

function maskFor(b: Binding, mask: AnimationMaskAsset): Float32Array {
  let m = b.masks.get(mask)
  if (!m || m.joints !== mask.joints || m.slotCount !== b.slots.length) {
    const weights = new Float32Array(b.slots.length)
    for (let k = 0; k < b.slots.length; k++) weights[k] = maskWeight(mask, b.slots[k]!.path)
    m = { joints: mask.joints, slotCount: b.slots.length, weights }
    b.masks.set(mask, m)
  }
  return m.weights
}

// --- blending --------------------------------------------------------------------------------

// Doubles passed between the sampler's functions ride in these instead of arguments: V8 boxes a
// double passed to (or returned from) a call it doesn't inline, and these calls run per channel.
const dtArg = new Float64Array(1)
const timeArg = new Float64Array(1)
const weightArg = new Float64Array(1)
const prevArg = new Float64Array(1)
const rootWeightArg = new Float64Array(1)
const sampleArg = new Float64Array(1)
const spanArg = new Float64Array(4)

const qa = new Float32Array(4)
const qb = new Float32Array(4)

/** Blends toward `value` by weightArg[0]. */
function blendOverride(
  pose: Float32Array,
  o: number,
  value: Float32Array,
  width: number,
  quat: boolean,
): void {
  const w = weightArg[0]!
  if (w >= 1) {
    for (let k = 0; k < width; k++) pose[o + k] = value[k]!
    return
  }
  if (quat) {
    slerpAt(qa, pose, o, value, 0, weightArg)
    pose[o] = qa[0]!
    pose[o + 1] = qa[1]!
    pose[o + 2] = qa[2]!
    pose[o + 3] = qa[3]!
    return
  }
  for (let k = 0; k < width; k++) pose[o + k] = pose[o + k]! + (value[k]! - pose[o + k]!) * w
}

/**
 * Adds the channel's change since its first key, scaled by weightArg[0] (rotations: pose ·
 * first⁻¹ · value).
 */
function blendAdditive(
  pose: Float32Array,
  o: number,
  value: Float32Array,
  c: AnimationChannel,
  quat: boolean,
  scale: boolean,
): void {
  const w = weightArg[0]!
  const width = c.width
  const first = c.interpolation === 'cubic' ? width : 0
  const v0 = c.values
  if (quat) {
    // delta = inverse(first) · value, then pose · slerp(identity, delta, w).
    const x0 = -v0[first]!
    const y0 = -v0[first + 1]!
    const z0 = -v0[first + 2]!
    const w0 = v0[first + 3]!
    const x = value[0]!
    const y = value[1]!
    const z = value[2]!
    const qw = value[3]!
    qb[0] = w0 * x + x0 * qw + y0 * z - z0 * y
    qb[1] = w0 * y - x0 * z + y0 * qw + z0 * x
    qb[2] = w0 * z + x0 * y - y0 * x + z0 * qw
    qb[3] = w0 * qw - x0 * x - y0 * y - z0 * z
    if (w < 1) {
      qa[0] = 0
      qa[1] = 0
      qa[2] = 0
      qa[3] = 1
      slerpAt(qb, qa, 0, qb, 0, weightArg)
    }
    const px = pose[o]!
    const py = pose[o + 1]!
    const pz = pose[o + 2]!
    const pw = pose[o + 3]!
    pose[o] = pw * qb[0]! + px * qb[3]! + py * qb[2]! - pz * qb[1]!
    pose[o + 1] = pw * qb[1]! - px * qb[2]! + py * qb[3]! + pz * qb[0]!
    pose[o + 2] = pw * qb[2]! + px * qb[1]! - py * qb[0]! + pz * qb[3]!
    pose[o + 3] = pw * qb[3]! - px * qb[0]! - py * qb[1]! - pz * qb[2]!
    return
  }
  if (scale) {
    for (let k = 0; k < width; k++) {
      const base = v0[first + k]!
      const ratio = base !== 0 ? value[k]! / base : 1
      pose[o + k] = pose[o + k]! * (1 + (ratio - 1) * w)
    }
    return
  }
  for (let k = 0; k < width; k++) pose[o + k] = pose[o + k]! + (value[k]! - v0[first + k]!) * w
}

// --- time ------------------------------------------------------------------------------------

/** A ping-pong layer's clip time: its running time, bounced between 0 and the duration. */
function bounce(out: Float64Array, k: number, duration: number): void {
  const d2 = duration * 2
  let t = out[k]! % d2
  if (t < 0) t += d2
  out[k] = t <= duration ? t : d2 - t
}

/**
 * Advances a layer's time by dtArg[0], sending events it crosses and AnimationFinished when a
 * once layer reaches its end.
 */
function advance(
  world: World,
  entity: Entity,
  index: number,
  layer: AnimationLayerValue,
  clip: AnimationClipAsset,
): void {
  const dt = dtArg[0]!
  const d = clip.duration
  const before = layer.time
  if (!layer.playing || layer.speed === 0 || dt === 0) return
  let after = before + dt * layer.speed
  // The clip time covered, as one or two spans (a loop that wrapped), for events.
  let spans = 1
  spanArg[0] = before
  if (layer.loop === 'once') {
    if (after >= d) after = d
    if (after <= 0) after = 0
    const ended = layer.speed > 0 ? before < d && after >= d : before > 0 && after <= 0
    if (ended) world.send(AnimationFinished, { entity, layer: index })
    spanArg[1] = after
  } else if (layer.loop === 'loop') {
    if (d <= 0) after = 0
    else if (after >= d) {
      after %= d
      spanArg[1] = d
      spanArg[2] = -1e-9
      spans = 2
    } else if (after < 0) {
      after = (after % d) + d
      spanArg[1] = 0
      spanArg[2] = d + 1e-9
      spans = 2
    }
    if (spans === 1) spanArg[1] = after
    else spanArg[3] = after
  } else {
    // Ping-pong: time runs on; events fire on the bounced clip time.
    after = d > 0 ? after % (d * 2) : 0
    if (after < 0) after += d * 2
    spanArg[1] = after
    if (d > 0) {
      bounce(spanArg, 0, d)
      bounce(spanArg, 1, d)
    }
  }
  layer.time = after
  if (clip.events.length === 0) return
  for (let k = 0; k < spans; k++) fireEvents(world, entity, index, clip, k)
}

/** Events with time in span k of spanArg: (from, to] going forward, [to, from) going backward. */
function fireEvents(
  world: World,
  entity: Entity,
  layer: number,
  clip: AnimationClipAsset,
  k: number,
): void {
  const from = spanArg[k * 2]!
  const to = spanArg[k * 2 + 1]!
  const list = clip.events
  if (from === to) return
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!
    const crossed = to > from ? e.time > from && e.time <= to : e.time < from && e.time >= to
    if (crossed)
      world.send(AnimationEvent, { entity, layer, name: e.name, time: e.time, data: e.data })
  }
}

// --- root motion -----------------------------------------------------------------------------

const TRANSFORM = 'core/Transform'

/** Picks the root joint's slots and computes its parent's model-space transform. */
function prepareRoot(world: World, b: Binding, wanted: string): boolean {
  const r = b.root_
  if (r.path === undefined || (wanted && r.path !== wanted)) {
    let best: Slot | undefined
    for (const s of b.slots) {
      if (s.def.name !== TRANSFORM || s.field !== 'translation' || s.path === '') continue
      if (wanted ? s.path !== wanted : best && depth(s.path) >= depth(best.path)) continue
      best = s
    }
    r.path = best?.path ?? ''
    r.translation = best ? (b.byKey.get(`${best.path}|${TRANSFORM}|translation`) ?? -1) : -1
    r.rotation = best ? (b.byKey.get(`${best.path}|${TRANSFORM}|rotation`) ?? -1) : -1
  }
  if (r.translation < 0 && r.rotation < 0) return false
  // The chain from the player (exclusive) down to the root's parent, as affine rows.
  const joint = b.slots[r.translation >= 0 ? r.translation : r.rotation]!.entity
  identityRows(r.parent)
  r.parentRotation[0] = 0
  r.parentRotation[1] = 0
  r.parentRotation[2] = 0
  r.parentRotation[3] = 1
  let e: Entity | null = world.has(joint, ChildOf) ? world.get(joint, ChildOf).parent : null
  for (let guard = 0; e !== null && e !== b.root && guard < 64; guard++) {
    if (!world.isAlive(e)) break
    const table = world.entityTableUnchecked(e)
    if (table.has(Transform)) {
      const row = world.entityRowUnchecked(e)
      trsRows(
        local,
        table.column(Transform, 'translation'),
        table.column(Transform, 'rotation'),
        table.column(Transform, 'scale'),
        row,
      )
      mulRows(r.parent, local, r.parent)
      const q = table.column(Transform, 'rotation')
      quatMulInto(r.parentRotation, q, row * 4, r.parentRotation, 0)
    }
    e = world.has(e, ChildOf) ? world.get(e, ChildOf).parent : null
  }
  invertRows(r.parentInverse, r.parent)
  return true
}

function depth(path: string): number {
  let n = 1
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) n++
  return n
}

const local = new Float32Array(12)
const p0 = new Float32Array(3)
const p1 = new Float32Array(3)
const pref = new Float32Array(3)
const sample0 = new Float32Array(4)
const sampleRef = new Float32Array(4)
const qm = new Float32Array(4)

function identityRows(m: Float32Array): void {
  m.fill(0)
  m[0] = 1
  m[5] = 1
  m[10] = 1
}

function trsRows(
  out: Float32Array,
  t: Float32Array,
  q: Float32Array,
  s: Float32Array,
  row: number,
): void {
  const x = q[row * 4]!
  const y = q[row * 4 + 1]!
  const z = q[row * 4 + 2]!
  const w = q[row * 4 + 3]!
  const sx = s[row * 3]!
  const sy = s[row * 3 + 1]!
  const sz = s[row * 3 + 2]!
  out[0] = (1 - 2 * (y * y + z * z)) * sx
  out[1] = 2 * (x * y - w * z) * sy
  out[2] = 2 * (x * z + w * y) * sz
  out[3] = t[row * 3]!
  out[4] = 2 * (x * y + w * z) * sx
  out[5] = (1 - 2 * (x * x + z * z)) * sy
  out[6] = 2 * (y * z - w * x) * sz
  out[7] = t[row * 3 + 1]!
  out[8] = 2 * (x * z - w * y) * sx
  out[9] = 2 * (y * z + w * x) * sy
  out[10] = (1 - 2 * (x * x + y * y)) * sz
  out[11] = t[row * 3 + 2]!
}

const mulScratch = new Float32Array(12)
/** out = a × b (affine rows); out may alias either. */
function mulRows(out: Float32Array, a: Float32Array, b: Float32Array): void {
  const m = mulScratch
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      m[r * 4 + c] =
        a[r * 4]! * b[c]! +
        a[r * 4 + 1]! * b[4 + c]! +
        a[r * 4 + 2]! * b[8 + c]! +
        (c === 3 ? a[r * 4 + 3]! : 0)
    }
  }
  out.set(m)
}

function invertRows(out: Float32Array, m: Float32Array): void {
  const a = m[0]!
  const b = m[1]!
  const c = m[2]!
  const d = m[4]!
  const e = m[5]!
  const f = m[6]!
  const g = m[8]!
  const h = m[9]!
  const i = m[10]!
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-20) {
    identityRows(out)
    return
  }
  const k = 1 / det
  const r00 = A * k
  const r01 = -(b * i - c * h) * k
  const r02 = (b * f - c * e) * k
  const r10 = B * k
  const r11 = (a * i - c * g) * k
  const r12 = -(a * f - c * d) * k
  const r20 = C * k
  const r21 = -(a * h - b * g) * k
  const r22 = (a * e - b * d) * k
  const tx = m[3]!
  const ty = m[7]!
  const tz = m[11]!
  out[0] = r00
  out[1] = r01
  out[2] = r02
  out[3] = -(r00 * tx + r01 * ty + r02 * tz)
  out[4] = r10
  out[5] = r11
  out[6] = r12
  out[7] = -(r10 * tx + r11 * ty + r12 * tz)
  out[8] = r20
  out[9] = r21
  out[10] = r22
  out[11] = -(r20 * tx + r21 * ty + r22 * tz)
}

function point(out: Float32Array, m: Float32Array, v: ArrayLike<number>, o: number): void {
  const x = v[o]!
  const y = v[o + 1]!
  const z = v[o + 2]!
  out[0] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
  out[1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
  out[2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
}

/** out = a · b (quaternions at offsets); out (at 0) may alias b. */
function quatMulInto(
  out: Float32Array,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
): void {
  const ax = a[ao]!
  const ay = a[ao + 1]!
  const az = a[ao + 2]!
  const aw = a[ao + 3]!
  const bx = b[bo]!
  const by = b[bo + 1]!
  const bz = b[bo + 2]!
  const bw = b[bo + 3]!
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
}

/** Rotation about Y (model up) of a model-space quaternion (its twist), in (-π, π], into out[k]. */
function yawInto(out: Float64Array, k: number, q: Float32Array): void {
  // q and -q are the same rotation: take w ≥ 0 so the angle stays in (-π, π].
  const flip = q[3]! < 0 ? -1 : 1
  out[k] = 2 * Math.atan2(q[1]! * flip, q[3]! * flip)
}

/** Wraps out[k] into [-π, π]. */
function wrapAt(out: Float64Array, k: number): void {
  let a = out[k]!
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  out[k] = a
}

/** yaw now, yaw at the clip's start, yaw at the previous time, and scratch. */
const yaws = new Float64Array(5)

/** Samples a channel at sampleArg[0] into out, from its first key (cold: root motion only). */
function sampleAt(c: AnimationChannel, quat: boolean, out: Float32Array): void {
  sampleChannelAt(c, sampleArg, 0, quat, out)
}

/**
 * Takes the root's ground-plane travel out of a sampled translation (pinning it where the clip
 * starts) and adds the layer's travel since prevArg[0] to the root motion, weighted by
 * rootWeightArg[0].
 */
function rootTranslation(
  b: Binding,
  c: AnimationChannel,
  value: Float32Array,
  wrapped: number,
): void {
  const r = b.root_
  const m = r.parent
  const weight = rootWeightArg[0]!
  const n = c.times.length
  const start = n ? c.times[0]! : 0
  const end = n ? c.times[n - 1]! : 0
  point(p1, m, value, 0)
  if (weight > 0) {
    sampleArg[0] = prevArg[0]!
    sampleAt(c, false, sample0)
    point(p0, m, sample0, 0)
    let dx = p1[0]! - p0[0]!
    let dz = p1[2]! - p0[2]!
    if (wrapped !== 0) {
      // Across a loop: to the end (or start) and on from the other side.
      sampleArg[0] = wrapped > 0 ? end : start
      sampleAt(c, false, sample0)
      point(pref, m, sample0, 0)
      sampleArg[0] = wrapped > 0 ? start : end
      sampleAt(c, false, sampleRef)
      point(p0, m, sampleRef, 0)
      dx += pref[0]! - p0[0]!
      dz += pref[2]! - p0[2]!
    }
    // Into the entity's frame: the clip's heading here is turned back by the pinned yaw.
    const cos = Math.cos(r.turn)
    const sin = Math.sin(r.turn)
    r.motion[0] = r.motion[0]! + (cos * dx + sin * dz) * weight
    r.motion[2] = r.motion[2]! + (-sin * dx + cos * dz) * weight
  }
  // Pin: the ground-plane position where the clip starts, height as sampled.
  sampleArg[0] = start
  sampleAt(c, false, sampleRef)
  point(pref, m, sampleRef, 0)
  p1[0] = pref[0]!
  p1[2] = pref[2]!
  point(value, r.parentInverse, p1, 0)
}

/**
 * Takes the root's yaw out of a sampled rotation (keeping the yaw it starts with) and adds the
 * layer's turn since prevArg[0], weighted by rootWeightArg[0]. Sets `turn`, the yaw taken out at
 * the previous time, so travel can turn with it.
 */
function rootRotation(b: Binding, c: AnimationChannel, value: Float32Array, wrapped: number): void {
  const r = b.root_
  const R = r.parentRotation
  const weight = rootWeightArg[0]!
  const n = c.times.length
  const start = n ? c.times[0]! : 0
  const end = n ? c.times[n - 1]! : 0
  quatMulInto(qm, R, 0, value, 0)
  yawInto(yaws, 0, qm)
  sampleArg[0] = start
  sampleAt(c, true, sampleRef)
  quatMulInto(sampleRef, R, 0, sampleRef, 0)
  yawInto(yaws, 1, sampleRef)
  sampleArg[0] = prevArg[0]!
  sampleAt(c, true, sample0)
  quatMulInto(sample0, R, 0, sample0, 0)
  yawInto(yaws, 2, sample0)
  if (weight > 0) {
    yaws[3] = yaws[0]! - yaws[2]!
    wrapAt(yaws, 3)
    if (wrapped !== 0) {
      // To the end (or start), then on from the other side.
      sampleArg[0] = wrapped > 0 ? end : start
      sampleAt(c, true, sample0)
      quatMulInto(sample0, R, 0, sample0, 0)
      yawInto(yaws, 3, sample0)
      yaws[3] = yaws[3]! - yaws[2]!
      wrapAt(yaws, 3)
      sampleArg[0] = wrapped > 0 ? start : end
      sampleAt(c, true, sample0)
      quatMulInto(sample0, R, 0, sample0, 0)
      yawInto(yaws, 4, sample0)
      yaws[4] = yaws[0]! - yaws[4]!
      wrapAt(yaws, 4)
      yaws[3] = yaws[3]! + yaws[4]!
    }
    r.yaw += yaws[3]! * weight
  }
  // value' = R⁻¹ · Ry(yawRef − yaw) · (R · value)
  const half = (yaws[1]! - yaws[0]!) * 0.5
  qa[0] = 0
  qa[1] = Math.sin(half)
  qa[2] = 0
  qa[3] = Math.cos(half)
  quatMulInto(qm, qa, 0, qm, 0)
  qa[0] = -R[0]!
  qa[1] = -R[1]!
  qa[2] = -R[2]!
  qa[3] = R[3]!
  quatMulInto(value, qa, 0, qm, 0)
  yaws[3] = yaws[1]! - yaws[2]!
  wrapAt(yaws, 3)
  r.turn = yaws[3]!
}

let intentDef: ComponentDef | null | undefined

/** Moves the entity by this frame's root motion (dtArg[0] seconds' worth), or hands it to its character controller. */
function applyRootMotion(world: World, entity: Entity, b: Binding, mode: string): void {
  const dt = dtArg[0]!
  const r = b.root_
  const table = world.entityTableUnchecked(entity)
  const row = world.entityRowUnchecked(entity)
  const half = r.yaw * 0.5
  const qy = Math.sin(half)
  const qw = Math.cos(half)
  if (table.has(RootMotion)) {
    const t = table.column(RootMotion, 'translation')
    const q = table.column(RootMotion, 'rotation')
    t[row * 3] = r.motion[0]!
    t[row * 3 + 1] = 0
    t[row * 3 + 2] = r.motion[2]!
    q[row * 4] = 0
    q[row * 4 + 1] = qy
    q[row * 4 + 2] = 0
    q[row * 4 + 3] = qw
    table.markChanged(RootMotion, row)
  }
  const tr = table.column(Transform, 'translation')
  const ro = table.column(Transform, 'rotation')
  const sc = table.column(Transform, 'scale')
  const moved = r.motion[0] !== 0 || r.motion[2] !== 0
  if (mode === 'character') {
    if (intentDef === undefined) intentDef = findComponent('physics/CharacterIntent') ?? null
    if (intentDef && table.has(intentDef)) {
      const move = table.column(intentDef, 'move') as Float32Array
      const inv = dt > 0 ? 1 / dt : 0
      // Take back what root motion added last frame; the game's own intent stays.
      const x = r.motion[0]! * sc[row * 3]! * inv
      const z = r.motion[2]! * sc[row * 3 + 2]! * inv
      move[row * 3] = move[row * 3]! - b.added[0]! + x
      move[row * 3 + 2] = move[row * 3 + 2]! - b.added[2]! + z
      b.added[0] = x
      b.added[2] = z
      table.markChanged(intentDef, row)
    }
  } else if (moved) {
    // translation += rotation · (scale · motion)
    const x = r.motion[0]! * sc[row * 3]!
    const z = r.motion[2]! * sc[row * 3 + 2]!
    p0[0] = x
    p0[1] = 0
    p0[2] = z
    rotateBy(p1, ro, row * 4, p0)
    tr[row * 3] = tr[row * 3]! + p1[0]!
    tr[row * 3 + 1] = tr[row * 3 + 1]! + p1[1]!
    tr[row * 3 + 2] = tr[row * 3 + 2]! + p1[2]!
  }
  if (r.yaw !== 0) {
    // rotation · Ry(yaw)
    qa[0] = 0
    qa[1] = qy
    qa[2] = 0
    qa[3] = qw
    quatMulInto(qb, ro, row * 4, qa, 0)
    for (let k = 0; k < 4; k++) ro[row * 4 + k] = qb[k]!
  }
  if (moved || r.yaw !== 0) table.markChanged(Transform, row)
}

function rotateBy(out: Float32Array, q: Float32Array, o: number, v: Float32Array): void {
  const x = q[o]!
  const y = q[o + 1]!
  const z = q[o + 2]!
  const w = q[o + 3]!
  const vx = v[0]!
  const vy = v[1]!
  const vz = v[2]!
  const ix = w * vx + y * vz - z * vy
  const iy = w * vy + z * vx - x * vz
  const iz = w * vz + x * vy - y * vx
  const iw = -x * vx - y * vy - z * vz
  out[0] = ix * w + iw * -x + iy * -z - iz * -y
  out[1] = iy * w + iw * -y + iz * -x - ix * -z
  out[2] = iz * w + iw * -z + ix * -y - iy * -x
}

// --- the system ------------------------------------------------------------------------------

/** Whether a binding's slots still point at live entities (a respawned model needs a rebind). */
function bindingLive(world: World, b: Binding): boolean {
  const slots = b.slots
  for (let k = 0; k < slots.length; k++) if (!refresh(world, slots[k]!)) return false
  return true
}

const removals: number[] = []

/**
 * Samples every player's layers into its joints and fields: advances time (events, finished),
 * fades weights, blends layers in order (override, additive, masks), takes out root motion, and
 * writes the results into the component columns, marked changed. Runs in PostUpdate before
 * transform propagation.
 */
export const sampleAnimations = defineSystem({
  name: 'animation/sample',
  description:
    'Advances animation players, blends their layers, and writes the pose into joints and fields.',
  setup: (world) => ({ q: world.query({ with: [AnimationPlayer] }) }),
  run: ({ q }, world) => {
    const state = world.resource(AnimationStateResource)
    state.frame++
    const frame = state.frame
    const clips = world.resource(AnimationClips)
    const masks = world.tryResource(AnimationMasks)
    const dt = world.resource(Time).delta
    dtArg[0] = dt
    const tick = world.tick
    const tables = q.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const n = table.count
      if (n === 0) continue
      const layerLists = table.column(AnimationPlayer, 'layers') as AnimationLayerValue[][]
      const modes = table.column(AnimationPlayer, 'rootMotion')
      const roots = table.column(AnimationPlayer, 'rootJoint') as string[]
      for (let i = 0; i < n; i++) {
        const entity = table.entities[i]!
        const layers = layerLists[i]!
        let b = state.bindings.get(entity)
        if (b && !bindingLive(world, b)) b = undefined
        if (!b) {
          b = createBinding(world, entity)
          state.bindings.set(entity, b)
        }
        // Time, fades, events.
        removals.length = 0
        if (prevTimes.length < layers.length) prevTimes = new Float64Array(layers.length * 2)
        for (let li = 0; li < layers.length; li++) {
          const layer = layers[li]!
          if (layer.fadeSpeed > 0) {
            const step = layer.fadeSpeed * dt
            if (layer.weight < layer.fadeTo)
              layer.weight = Math.min(layer.fadeTo, layer.weight + step)
            else layer.weight = Math.max(layer.fadeTo, layer.weight - step)
            // Snap the last sliver of float error: a 0.3 s fade ends at 0.3 s, not a frame later.
            if (Math.abs(layer.weight - layer.fadeTo) < step * 1e-3) layer.weight = layer.fadeTo
            if (layer.weight === layer.fadeTo) {
              layer.fadeSpeed = 0
              if (layer.fadeTo === 0) removals.push(li)
            }
          }
          prevTimes[li] = layer.time
          const clip = clips.get(layer.clip)
          if (clip) advance(world, entity, li, layer, clip)
        }
        // Bind every layer's clip first: root motion picks its joint among the bound slots.
        for (let li = 0; li < layers.length; li++) {
          const clip = clips.get(layers[li]!.clip)
          if (!clip) continue
          const cb: ClipBinding | undefined = b.clips.get(clip)
          if (!cb || cb.channels !== clip.channels) bindClip(world, b, clip, frame)
          else if (cb.unbound.length > 0 && frame >= cb.retryAt) {
            // Targets that weren't there (an instance still spawning) may be now.
            b.paths = descendantPaths(world, entity)
            bindClip(world, b, clip, frame)
          }
        }
        // Blend.
        const mode = ROOT_MOTION_MODES[modes[i]!]!
        const rootOn = mode !== 'none' && prepareRoot(world, b, roots[i]!)
        const r = b.root_
        r.motion[0] = 0
        r.motion[2] = 0
        r.yaw = 0
        if (rootOn) rootWeights(b, layers, clips, masks)
        b.active.fill(0)
        const pose = b.pose
        const rest = b.rest
        for (let li = 0; li < layers.length; li++) {
          const layer = layers[li]!
          const clip = clips.get(layer.clip)
          if (!clip || layer.weight <= 0) continue
          const cb: ClipBinding = b.clips.get(clip)!
          const mask = layer.mask ? masks?.get(layer.mask) : undefined
          const mw = mask ? maskFor(b, mask) : undefined
          // Sample times, inlined: a double returned from a call V8 doesn't inline is boxed.
          const d = clip.duration
          const d2 = d * 2
          const pingPong = layer.loop === 'ping-pong' && d > 0
          let t = layer.time
          const before = prevTimes[li]!
          let prevTime = before
          if (pingPong) {
            t %= d2
            if (t < 0) t += d2
            if (t > d) t = d2 - t
            prevTime %= d2
            if (prevTime < 0) prevTime += d2
            if (prevTime > d) prevTime = d2 - prevTime
          }
          const additive = layer.blend === 'additive'
          // A loop that wrapped this frame: root travel goes to the end and on from the start.
          const wrapped =
            layer.loop !== 'loop'
              ? 0
              : layer.speed > 0 && layer.time < before
                ? 1
                : layer.speed < 0 && layer.time > before
                  ? -1
                  : 0
          b.root_.turn = 0
          timeArg[0] = t
          prevArg[0] = prevTime
          rootWeightArg[0] = rootOn ? b.layerWeights[li]! : 0
          const channels = clip.channels
          // Rotation before translation for the root, so travel can turn with the pinned yaw.
          for (let pass = 0; pass < 2; pass++) {
            for (let c = 0; c < channels.length; c++) {
              const k = cb.slotOf[c]!
              if (k < 0) continue
              const isRootRot = rootOn && k === r.rotation
              const isRootPos = rootOn && k === r.translation
              if (pass === 0 ? !isRootRot : isRootRot) continue
              const w = layer.weight * (mw ? mw[k]! : 1)
              if (w <= 0) continue
              weightArg[0] = w
              const slot = b.slots[k]!
              const channel = channels[c]!
              const o = slot.offset
              if (b.active[k] === 0) {
                for (let x = 0; x < slot.width; x++) pose[o + x] = rest[o + x]!
                b.active[k] = 1
              }
              const value = b.scratch
              cb.cursors[c] = sampleChannelAt(channel, timeArg, cb.cursors[c]!, slot.quat, value)
              if (isRootRot && !additive) rootRotation(b, channel, value, wrapped)
              else if (isRootPos && !additive) rootTranslation(b, channel, value, wrapped)
              if (additive) {
                const scale = slot.field === 'scale' && slot.def.name === TRANSFORM
                blendAdditive(pose, o, value, channel, slot.quat, scale)
              } else {
                blendOverride(pose, o, value, slot.width, slot.quat)
              }
            }
          }
        }
        // Write.
        const slots = b.slots
        for (let k = 0; k < slots.length; k++) {
          if (b.active[k] === 0) continue
          const slot = slots[k]!
          if (slot.quat) normalizeAt(pose, slot.offset)
          writeSlot(slot, pose, slot.offset, tick)
        }
        if (rootOn) applyRootMotion(world, entity, b, mode)
        // Layers faded out to 0 go away (after blending, so indices held while it ran).
        for (let k = removals.length - 1; k >= 0; k--) layers.splice(removals[k]!, 1)
        if (removals.length > 0) table.markChanged(AnimationPlayer, i)
      }
    }
  },
})

/** Each layer's time before this frame's advance (root motion samples both ends). */
let prevTimes = new Float64Array(16)

/**
 * Root motion weight per layer: an override layer's weight on the root joint, times what the
 * override layers after it leave (they blend over it). Additive layers add no travel.
 */
function rootWeights(
  b: Binding,
  layers: AnimationLayerValue[],
  clips: { get(ref: AssetRef | null): AnimationClipAsset | undefined },
  masks: { get(ref: AssetRef | null): AnimationMaskAsset | undefined } | undefined,
): void {
  if (b.layerWeights.length < layers.length) b.layerWeights = new Float32Array(layers.length * 2)
  const r = b.root_
  const rootSlot = r.translation >= 0 ? r.translation : r.rotation
  let remaining = 1
  for (let li = layers.length - 1; li >= 0; li--) {
    const layer = layers[li]!
    b.layerWeights[li] = 0
    const clip = clips.get(layer.clip)
    if (!clip || layer.blend === 'additive') continue
    const mask = layer.mask ? masks?.get(layer.mask) : undefined
    const w = layer.weight * (mask ? maskFor(b, mask)[rootSlot]! : 1)
    b.layerWeights[li] = w * remaining
    remaining *= 1 - Math.min(1, w)
  }
}

function normalizeAt(p: Float32Array, o: number): void {
  const len = Math.sqrt(
    p[o]! * p[o]! + p[o + 1]! * p[o + 1]! + p[o + 2]! * p[o + 2]! + p[o + 3]! * p[o + 3]!,
  )
  if (len > 0) {
    p[o] = p[o]! / len
    p[o + 1] = p[o + 1]! / len
    p[o + 2] = p[o + 2]! / len
    p[o + 3] = p[o + 3]! / len
  }
}

/** Forgets a player's binding when its component goes away. */
export function forgetBinding(world: World, entity: Entity): void {
  world.tryResource(AnimationStateResource)?.bindings.delete(entity)
}

/** A binding's summary for animation.describe. */
export function describeBinding(world: World, entity: Entity) {
  const b = world.tryResource(AnimationStateResource)?.bindings.get(entity)
  if (!b) return { bound: 0, unbound: [] as string[], rootJoint: null as string | null }
  const unbound = new Set<string>()
  for (const cb of b.clips.values()) for (const u of cb.unbound) unbound.add(u)
  return {
    bound: b.slots.length,
    unbound: [...unbound],
    rootJoint: b.root_.path || null,
  }
}
