import {
  type AnimationClipAsset,
  type BakeRetarget,
  bakeClip,
  type FlatSkeleton,
} from '@aethervtt/shard-animation'
import { type JsonObject, ShardError, type World } from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import { jointOrderOf, restModels } from './binding'
import { qrotateInv, quatFromRows } from './math'

export interface GenerateOptions {
  /** humanoid: 14 bodies found by joint names. all: every joint that mainly moves vertices. */
  bodies?: 'humanoid' | 'all'
  /** Total mass, kg (default 70). */
  mass?: number
  /** The model it came from, recorded in the asset. */
  skeleton?: string
}

export interface GenerateInput {
  skeleton: FlatSkeleton
  /** 10 floats per joint (the skin's rest pose). */
  rest: Float32Array
  /** Skinned meshes on this skeleton (joint indices in the skin's order). */
  meshes: Mesh[]
}

const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Dempster's segment fractions over the 14 humanoid bodies (they sum to 1). */
const HUMANOID: { slot: string; mass: number }[] = [
  { slot: 'pelvis', mass: 0.142 },
  { slot: 'spine_lower', mass: 0.139 },
  { slot: 'spine_upper', mass: 0.216 },
  { slot: 'head', mass: 0.081 },
  { slot: 'upperarm_l', mass: 0.028 },
  { slot: 'upperarm_r', mass: 0.028 },
  { slot: 'lowerarm_l', mass: 0.022 },
  { slot: 'lowerarm_r', mass: 0.022 },
  { slot: 'thigh_l', mass: 0.1 },
  { slot: 'thigh_r', mass: 0.1 },
  { slot: 'calf_l', mass: 0.0465 },
  { slot: 'calf_r', mass: 0.0465 },
  { slot: 'foot_l', mass: 0.0145 },
  { slot: 'foot_r', mass: 0.0145 },
]

/** Limits by humanoid slot: spherical swing [y, z] and twist, or a hinge's flexion range. */
const LIMITS: Record<string, JsonObject> = {
  spine_lower: { spherical: { swing: [0.35, 0.35], twist: [-0.3, 0.3] } },
  spine_upper: { spherical: { swing: [0.3, 0.3], twist: [-0.3, 0.3] } },
  head: { spherical: { swing: [0.6, 0.5], twist: [-0.7, 0.7] } },
  upperarm: { spherical: { swing: [1.3, 1.3], twist: [-0.9, 0.9] } },
  lowerarm: { revolute: { limits: [0, 2.5] } },
  thigh: { spherical: { swing: [1.1, 0.7], twist: [-0.4, 0.4] } },
  calf: { revolute: { limits: [0, 2.4] } },
  foot: { spherical: { swing: [0.5, 0.35], twist: [-0.3, 0.3] } },
}

function side(name: string): 'l' | 'r' | '' {
  const n = name.toLowerCase()
  if (/(^|[^a-z])(l|left)$|[._]l$|^left|left/.test(n) && !/right/.test(n)) return 'l'
  if (/(^|[^a-z])(r|right)$|[._]r$|^right|right/.test(n)) return 'r'
  return ''
}

/** Joints by humanoid slot, from their names (game-engine, Mixamo, UE and Blender styles). */
function humanoidSlots(skeleton: FlatSkeleton): Map<string, number> {
  const names = skeleton.paths.map((p) =>
    lastSegment(p)
      .toLowerCase()
      .replace(/^mixamorig:?/, ''),
  )
  const out = new Map<string, number>()
  const find = (re: RegExp, s: 'l' | 'r' | '' = '') =>
    names.findIndex(
      (n) => re.test(n) && (s === '' || side(n) === s) && !/end$|_end|twist|roll/.test(n),
    )
  const set = (slot: string, j: number) => {
    if (j >= 0) out.set(slot, j)
  }
  set('pelvis', find(/pelvis|hips?$/))
  const spines = names
    .map((n, j) => ({ n, j }))
    .filter(({ n }) => /spine|chest/.test(n) && !/end$/.test(n))
    .map(({ j }) => j)
  if (spines.length >= 2) {
    // The middle spine and the top one (the chest).
    set('spine_lower', spines[Math.floor((spines.length - 1) / 2)]!)
    set('spine_upper', spines[spines.length - 1]!)
  } else if (spines.length === 1) set('spine_upper', spines[0]!)
  set('head', find(/^head$|head$/))
  for (const s of ['l', 'r'] as const) {
    set(`upperarm_${s}`, find(/upper_?arm|^arm|[^e]arm[._]?[lr]?$/, s))
    set(`lowerarm_${s}`, find(/lower_?arm|fore_?arm/, s))
    set(`thigh_${s}`, find(/thigh|up_?leg|upper_?leg/, s))
    set(`calf_${s}`, find(/calf|shin|lower_?leg|^leg[._]?[lr]$|[^p]leg[._]?[lr]$/, s))
    set(`foot_${s}`, find(/foot/, s))
  }
  return out
}

const isAncestor = (skeleton: FlatSkeleton, a: number, j: number) => {
  for (let p = skeleton.parents[j]!; p >= 0; p = skeleton.parents[p]!) if (p === a) return true
  return false
}

/** Per vertex, its main joint (heaviest weight) if that weight is at least `min`, else -1. */
function mainJoints(mesh: Mesh, min: number): Int32Array {
  const n = mesh.vertexCount
  const out = new Int32Array(n).fill(-1)
  const joints = mesh.joints
  const weights = mesh.weights
  if (!joints || !weights) return out
  for (let v = 0; v < n; v++) {
    let k = 0
    for (let i = 1; i < 4; i++) if (weights[v * 4 + i]! > weights[v * 4 + k]!) k = i
    if (weights[v * 4 + k]! >= min) out[v] = joints[v * 4 + k]!
  }
  return out
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!
}

const round = (v: number) => Math.round(v * 10000) / 10000

/**
 * A ragdoll asset's JSON for a skinned model (0117): bodies on the humanoid joints (or every joint
 * that mainly moves vertices), each shape fitted to the vertices its joint (and the joints that
 * follow it) mainly moves, limits from a humanoid table (45° and ±30° otherwise), hinge axes from
 * the rest pose, segment masses, and each body's rest pose for servers without a skeleton.
 */
export function generateRagdoll(input: GenerateInput, options: GenerateOptions = {}): JsonObject {
  const { skeleton, rest } = input
  const n = skeleton.paths.length
  const order = jointOrderOf(skeleton)
  const model = restModels(skeleton, rest, order)
  // Which joints get bodies, and their masses.
  const chosen = new Map<number, { slot: string; mass: number }>()
  if ((options.bodies ?? 'humanoid') === 'humanoid') {
    const slots = humanoidSlots(skeleton)
    for (const h of HUMANOID) {
      const j = slots.get(h.slot)
      if (j !== undefined && !chosen.has(j)) chosen.set(j, h)
    }
    if (!slots.has('pelvis')) {
      throw new ShardError(
        'ragdoll/skeleton-mismatch',
        'No pelvis or hips joint: not a humanoid skeleton',
        {
          hint: 'Use --bodies all for other skeletons.',
        },
      )
    }
  } else {
    const counts = new Int32Array(n)
    for (const mesh of input.meshes) for (const j of mainJoints(mesh, 0.5)) if (j >= 0) counts[j]!++
    let total = 0
    for (let j = 0; j < n; j++) if (counts[j]! >= 24) total += counts[j]!
    for (let j = 0; j < n; j++) {
      if (counts[j]! >= 24)
        chosen.set(j, { slot: lastSegment(skeleton.paths[j]!), mass: counts[j]! / total })
    }
  }
  if (chosen.size === 0)
    throw new ShardError('ragdoll/skeleton-mismatch', 'No joint moves enough vertices for a body')
  // Each joint follows its nearest chosen ancestor (or itself).
  const owner = new Int32Array(n).fill(-1)
  for (const j of order) {
    if (chosen.has(j)) owner[j] = j
    else owner[j] = skeleton.parents[j]! >= 0 ? owner[skeleton.parents[j]!]! : -1
  }
  // Vertices in each body's joint frame (bind pose, through the inverse binds).
  const pts = new Map<number, number[]>()
  for (const j of chosen.keys()) pts.set(j, [])
  const ib = skeleton.inverseBind
  for (const mesh of input.meshes) {
    const main = mainJoints(mesh, 0.5)
    const p = mesh.positions
    for (let v = 0; v < mesh.vertexCount; v++) {
      const mj = main[v]!
      if (mj < 0 || mj >= n) continue
      const b = owner[mj]!
      if (b < 0) continue
      const m = b * 16
      const x = p[v * 3]!
      const y = p[v * 3 + 1]!
      const z = p[v * 3 + 2]!
      pts
        .get(b)!
        .push(
          ib[m]! * x + ib[m + 4]! * y + ib[m + 8]! * z + ib[m + 12]!,
          ib[m + 1]! * x + ib[m + 5]! * y + ib[m + 9]! * z + ib[m + 13]!,
          ib[m + 2]! * x + ib[m + 6]! * y + ib[m + 10]! * z + ib[m + 14]!,
        )
    }
  }
  // Model-space forward (heel to toe) and down, for hinge axes.
  const restRot = new Float64Array(n * 4)
  for (let j = 0; j < n; j++) quatFromRows(restRot, j * 4, model, j * 12)
  const pos = (j: number) => [model[j * 12 + 3]!, model[j * 12 + 7]!, model[j * 12 + 11]!]
  const names = skeleton.paths.map(lastSegment)
  const slotOf = new Map<number, string>()
  for (const [j, h] of chosen) slotOf.set(j, h.slot)
  const footJ = [...chosen].find(([, h]) => h.slot === 'foot_l' || h.slot === 'foot_r')?.[0]
  let fwd = [0, 0, 1]
  if (footJ !== undefined) {
    const toe = order.find((j) => skeleton.parents[j] === footJ)
    if (toe !== undefined) {
      const a = pos(footJ)
      const b = pos(toe)
      const d = [b[0]! - a[0]!, 0, b[2]! - a[2]!]
      const l = Math.hypot(d[0]!, d[2]!)
      if (l > 1e-4) fwd = [d[0]! / l, 0, d[2]! / l]
    }
  }
  const bodies: JsonObject = {}
  const v3 = new Float64Array(3)
  for (const j of order) {
    const h = chosen.get(j)
    if (!h) continue
    const name = names[j]!
    const list = pts.get(j)!
    const body: JsonObject = { mass: round(h.mass) }
    // The body's long axis: toward its first chosen descendant, else its vertices' centroid.
    let axis = [0, 1, 0]
    const child = order.find(
      (c) =>
        c !== j && chosen.has(c) && isAncestor(skeleton, j, c) && owner[skeleton.parents[c]!] === j,
    )
    if (child !== undefined) {
      const a = pos(j)
      const b = pos(child)
      v3[0] = b[0]! - a[0]!
      v3[1] = b[1]! - a[1]!
      v3[2] = b[2]! - a[2]!
      qrotateInv(v3, 0, restRot, j * 4, v3, 0)
      const l = Math.hypot(v3[0]!, v3[1]!, v3[2]!)
      if (l > 1e-4) axis = [v3[0]! / l, v3[1]! / l, v3[2]! / l]
    } else if (list.length >= 9) {
      let cx = 0
      let cy = 0
      let cz = 0
      for (let i = 0; i < list.length; i += 3) {
        cx += list[i]!
        cy += list[i + 1]!
        cz += list[i + 2]!
      }
      const l = Math.hypot(cx, cy, cz)
      if (l > 1e-6) axis = [cx / l, cy / l, cz / l]
    }
    const torso = h.slot === 'pelvis' || h.slot === 'spine_lower' || h.slot === 'spine_upper'
    if (list.length < 9) {
      body.shape = { sphere: { radius: 0.06 } }
    } else if (torso) {
      // A box over the middle 94% of its vertices on each axis.
      const center: number[] = []
      const half: number[] = []
      for (let k = 0; k < 3; k++) {
        const vals: number[] = []
        for (let i = k; i < list.length; i += 3) vals.push(list[i]!)
        const lo = percentile(vals, 0.03)
        const hi = percentile(vals, 0.97)
        center.push(round((lo + hi) / 2))
        half.push(round(Math.max(0.02, (hi - lo) / 2)))
      }
      body.shape = { box: half, center }
    } else {
      // A capsule along the axis: caps reach the extremes, the radius holds 97% of them.
      const along: number[] = []
      const radial: number[] = []
      for (let i = 0; i < list.length; i += 3) {
        const x = list[i]!
        const y = list[i + 1]!
        const z = list[i + 2]!
        const t = x * axis[0]! + y * axis[1]! + z * axis[2]!
        along.push(t)
        radial.push(Math.hypot(x - axis[0]! * t, y - axis[1]! * t, z - axis[2]! * t))
      }
      const r = Math.max(0.02, percentile(radial, 0.97))
      const lo = percentile(along, 0.01)
      const hi = percentile(along, 0.99)
      let a0 = lo + r
      let a1 = hi - r
      if (a1 < a0) a0 = a1 = (lo + hi) / 2
      body.shape = {
        capsule: {
          radius: round(r),
          from: axis.map((c) => round(c * a0)),
          to: axis.map((c) => round(c * a1)),
        },
      }
    }
    const slot = h.slot.replace(/_[lr]$/, '')
    const limits = LIMITS[slot]
    if (h.slot !== 'pelvis' && options.bodies !== 'all' && limits) {
      if (limits.revolute) {
        // Flexion turns the bone toward its bend: knees back, elbows forward.
        const bend = slot === 'calf' ? [-fwd[0]!, 0, -fwd[2]!] : fwd
        // The bone in model space.
        const r = restRot.subarray(j * 4, j * 4 + 4)
        const d = rotate(r, axis)
        const hinge = norm(cross(d, bend))
        const local = rotateInv(r, hinge)
        body.joint = {
          revolute: { axis: local.map(round), limits: (limits.revolute as JsonObject).limits! },
        }
      } else body.joint = limits
    } else if (skeleton.parents[j]! >= 0 && owner[skeleton.parents[j]!]! >= 0) {
      body.joint = {
        spherical: { swing: [Math.PI / 4, Math.PI / 4], twist: [-Math.PI / 6, Math.PI / 6] },
      }
    }
    if (
      h.slot === 'calf_l' ||
      h.slot === 'calf_r' ||
      h.slot === 'thigh_l' ||
      h.slot === 'thigh_r' ||
      h.slot === 'foot_l' ||
      h.slot === 'foot_r'
    ) {
      body.partial = { maxWeight: 0.4, stagger: 2 }
    } else if (h.slot === 'head') body.partial = { stagger: 1.5 }
    const p = pos(j)
    const r = restRot.subarray(j * 4, j * 4 + 4)
    body.rest = [...p.map(round), ...[...r].map((x) => round(x))]
    bodies[name] = body
  }
  return {
    skeleton: options.skeleton ?? '',
    mass: options.mass ?? 70,
    bodies,
    profiles: { default: { stiffness: 30, damping: 1, world: 0.15 } },
    rests: {},
    clips: {},
    reactions: {},
  }
}

function rotate(q: ArrayLike<number>, v: number[]): number[] {
  const out = new Float64Array(3)
  const qq = Float64Array.from(q)
  const vv = Float64Array.from(v)
  // q · v · q⁻¹
  const tx = 2 * (qq[1]! * vv[2]! - qq[2]! * vv[1]!)
  const ty = 2 * (qq[2]! * vv[0]! - qq[0]! * vv[2]!)
  const tz = 2 * (qq[0]! * vv[1]! - qq[1]! * vv[0]!)
  out[0] = vv[0]! + qq[3]! * tx + (qq[1]! * tz - qq[2]! * ty)
  out[1] = vv[1]! + qq[3]! * ty + (qq[2]! * tx - qq[0]! * tz)
  out[2] = vv[2]! + qq[3]! * tz + (qq[0]! * ty - qq[1]! * tx)
  return [...out]
}

function rotateInv(q: ArrayLike<number>, v: number[]): number[] {
  return rotate([-q[0]!, -q[1]!, -q[2]!, q[3]!], v)
}

const cross = (a: number[], b: number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
]
const norm = (v: number[]) => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}

/** Affine 4x4 (column-major) inverse into 3x4 rows. */
function invertColumnMajor(m: Float32Array, o: number, out: Float64Array): void {
  // Rows of the 3x3 part and translation.
  const a = m[o]!
  const b = m[o + 4]!
  const c = m[o + 8]!
  const d = m[o + 1]!
  const e = m[o + 5]!
  const f = m[o + 9]!
  const g = m[o + 2]!
  const h = m[o + 6]!
  const i = m[o + 10]!
  const tx = m[o + 12]!
  const ty = m[o + 13]!
  const tz = m[o + 14]!
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C || 1
  const r00 = A / det
  const r01 = -(b * i - c * h) / det
  const r02 = (b * f - c * e) / det
  const r10 = B / det
  const r11 = (a * i - c * g) / det
  const r12 = -(a * f - c * d) / det
  const r20 = C / det
  const r21 = -(a * h - b * g) / det
  const r22 = (a * e - b * d) / det
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

/** Model-space joint rows of one baked frame: rows (model × inverseBind) × bind. */
function bakedModel(
  skeleton: FlatSkeleton,
  rows: Float32Array,
  frame: number,
  out: Float64Array,
): void {
  const n = skeleton.paths.length
  const bind = new Float64Array(12)
  for (let j = 0; j < n; j++) {
    invertColumnMajor(skeleton.inverseBind, j * 16, bind)
    const r = frame * n * 12 + j * 12
    for (let row = 0; row < 3; row++) {
      const a0 = rows[r + row * 4]!
      const a1 = rows[r + row * 4 + 1]!
      const a2 = rows[r + row * 4 + 2]!
      const a3 = rows[r + row * 4 + 3]!
      for (let c = 0; c < 4; c++) {
        out[j * 12 + row * 4 + c] =
          a0 * bind[c]! + a1 * bind[4 + c]! + a2 * bind[8 + c]! + (c === 3 ? a3 : 0)
      }
    }
  }
}

export interface ExtractInput extends GenerateInput {
  world: World
  clips: Map<string, AnimationClipAsset>
  retarget?: BakeRetarget
}

/**
 * Fills a generated asset's rests (and travelling roles) from their clips (`gen --clips`): each
 * rest's lying body poses (the pose clip's first frame), and each get-up's root travel (11 points,
 * [x, z] in its start frame, +z its facing) and length. Missing clips are listed, not fatal.
 */
export function extractClips(json: JsonObject, input: ExtractInput): string[] {
  const missing: string[] = []
  const { skeleton, rest } = input
  const n = skeleton.paths.length
  const names = skeleton.paths.map(lastSegment)
  const bodies = json.bodies as Record<string, JsonObject>
  const order = jointOrderOf(skeleton)
  const rootJoint = order[0]!
  const model = new Float64Array(n * 12)
  const q = new Float64Array(4)
  const q0 = new Float64Array(4)
  const v = new Float64Array(3)
  const bake = (name: string) => {
    const clip = input.clips.get(name)
    if (!clip) {
      missing.push(name)
      return undefined
    }
    return { clip, baked: bakeClip(input.world, skeleton, rest, clip, 30, input.retarget) }
  }
  const travelOf = (b: NonNullable<ReturnType<typeof bake>>) => {
    const f = b.baked.frames
    bakedModel(skeleton, b.baked.rows, 0, model)
    const x0 = model[rootJoint * 12 + 3]!
    const z0 = model[rootJoint * 12 + 11]!
    // Its facing at the start: the root's forward on the ground.
    quatFromRows(q0, 0, model, rootJoint * 12)
    const fx = 2 * (q0[0]! * q0[2]! + q0[3]! * q0[1]!)
    const fz = 1 - 2 * (q0[0]! * q0[0]! + q0[1]! * q0[1]!)
    const yaw = Math.atan2(fx, fz)
    const out: number[][] = []
    for (let k = 0; k <= 10; k++) {
      bakedModel(skeleton, b.baked.rows, Math.round((k / 10) * (f - 1)), model)
      const dx = model[rootJoint * 12 + 3]! - x0
      const dz = model[rootJoint * 12 + 11]! - z0
      const c = Math.cos(-yaw)
      const s = Math.sin(-yaw)
      out.push([round(dx * c + dz * s), round(-dx * s + dz * c)])
    }
    return out
  }
  for (const r of Object.values((json.rests ?? {}) as Record<string, JsonObject>)) {
    const pose = bake(r.pose as string)
    if (pose) {
      bakedModel(skeleton, pose.baked.rows, 0, model)
      const out: JsonObject = {}
      for (const name of Object.keys(bodies)) {
        const j = names.indexOf(name)
        if (j < 0) continue
        quatFromRows(q, 0, model, j * 12)
        v[0] = model[j * 12 + 3]!
        v[1] = model[j * 12 + 7]!
        v[2] = model[j * 12 + 11]!
        out[name] = [...v, ...q].map(round)
      }
      r.bodies = out
    }
    const up = bake(r.getUp as string)
    if (up) {
      r.travel = travelOf(up)
      r.duration = round(up.clip.duration)
    }
  }
  for (const role of Object.values((json.clips ?? {}) as Record<string, JsonObject | string>)) {
    if (typeof role === 'string') continue
    const first = Array.isArray(role.clip) ? (role.clip[0] as string) : (role.clip as string)
    if (!/walk|run|moving/.test(first ?? '')) continue
    const b = bake(first)
    if (b) role.travel = travelOf(b)
  }
  return missing
}
