import { AssetStore, defineAssetType, defineDataAsset, type LoadContext } from '@shard/assets'
import {
  defineComponent,
  defineResource,
  defineSchema,
  type JsonValue,
  ShardError,
  t,
} from '@shard/core'
import type { SkinAsset } from '@shard/render'
import type { AnimationChannel } from './clip'

// --- joint maps ------------------------------------------------------------------------------

export const JointMapSchema = defineSchema(
  'animation/JointMap',
  {
    joints: t.json({
      default: {},
      description:
        'Source joint → target joint, by name or path: { "mixamorig:LeftUpLeg": "Thigh_L", "Spine1": "Chest" }. Joints not listed match by normalized name.',
    }),
  },
  { description: 'Joint names from one skeleton to another (*.jointmap.json), for retargeting.' },
)

export interface JointMapAsset {
  joints: Record<string, string>
}

export const JointMaps = defineResource<AssetStore<JointMapAsset, 'JointMap'>>(
  'animation/JointMaps',
  { description: 'Joint maps by guid.', init: () => new AssetStore('JointMap') },
)

function loadJointMap(json: JsonValue | undefined, _ctx?: LoadContext): JointMapAsset {
  const joints = ((json as { joints?: unknown } | undefined)?.joints ?? {}) as Record<
    string,
    unknown
  >
  const out: Record<string, string> = {}
  for (const [source, target] of Object.entries(joints)) {
    if (typeof target !== 'string' || target === '') {
      throw new ShardError(
        'animation/invalid-joint-map',
        `Joint map entry "${source}" must name a target joint`,
        { path: `/joints/${source.replace(/~/g, '~0').replace(/\//g, '~1')}` },
      )
    }
    out[source] = target
  }
  return { joints: out }
}

export const JointMapAssetType = defineAssetType<JointMapAsset>('JointMap', {
  store: JointMaps,
  load: (artifact, ctx) => loadJointMap(artifact.json, ctx),
  update: (existing, next) => {
    existing.joints = next.joints
  },
})

/** `*.jointmap.json` files import as JointMap. */
export const JointMapImporter = defineDataAsset('JointMap', JointMapSchema, {
  extension: 'jointmap',
})

// --- the component ---------------------------------------------------------------------------

export const RETARGET_MODES = ['rotation', 'rotation-and-root'] as const

export const Retarget = defineComponent(
  'animation/Retarget',
  {
    source: t.handle('Skin', {
      description:
        'The skeleton the clips were authored for (its #Skin sub-asset): its rest pose and joint names.',
    }),
    map: t.handle('JointMap', {
      description:
        'Optional *.jointmap.json of source → target names. Without one, names match after normalizing case, prefixes (mixamorig:), and sides (_L, .L, Left).',
    }),
    mode: t.enum(RETARGET_MODES, {
      description:
        "rotation: only joint rotations carry over (bone lengths stay the target's). rotation-and-root: the root joint's translation too, scaled by the ratio of hip heights (root motion scales with it).",
    }),
  },
  {
    description:
      "Plays clips authored for another skeleton on this player's model: channels bind by joint name, and each rotation is carried from the source's rest pose to this model's.",
  },
)

// --- names -----------------------------------------------------------------------------------

/** Where a side is written: Left… / …Left / L_… / …_L, with the side and the rest's groups. */
const SIDE_PATTERNS: [RegExp, number, number][] = [
  [/^(left|right)[_.\s-]?(.+)$/, 1, 2],
  [/^(.+?)[_.\s-]?(left|right)$/, 2, 1],
  [/^([lr])[_.\s-](.+)$/, 1, 2],
  [/^(.+?)[_.\s-]([lr])$/, 2, 1],
]

/**
 * A joint name reduced to what two rigs share: the last path segment, without namespace prefixes
 * (`mixamorig:`, `Armature|`), lowercased, without separators, with the side as a `.l`/`.r` suffix
 * whether it was written `_L`, `.L`, `L_`, `Left`, or `left_`. `mixamorig:LeftUpLeg`, `UpLeg_L`,
 * and `upleg.l` all become `upleg.l`.
 */
export function jointKey(name: string): string {
  let n = name.slice(name.lastIndexOf('/') + 1)
  n = n.slice(Math.max(n.lastIndexOf(':'), n.lastIndexOf('|')) + 1)
  let side = ''
  n = n.toLowerCase()
  for (const [re, sideAt, restAt] of SIDE_PATTERNS) {
    const m = re.exec(n)
    if (!m) continue
    side = m[sideAt]!.charAt(0)
    n = m[restAt]!
    break
  }
  n = n.replace(/[_.\s-]+/g, '')
  return side ? `${n}.${side}` : n
}

// --- the plan --------------------------------------------------------------------------------

export const CHANNEL_AS_IS = 0
export const CHANNEL_ROTATION = 1
export const CHANNEL_ROOT = 2
export const CHANNEL_DROPPED = 3

/** How each of a clip's channels lands on the target skeleton. */
export interface RetargetPlan {
  /** Per channel: the target path to bind (undefined: nothing to bind to). */
  targets: (string | undefined)[]
  /** Per channel: as-is, rotation (pre · value · post), root translation, or dropped. */
  kinds: Uint8Array
  /** Per channel: pre (4 floats) then post (4) for rotations; pre and [ratio, 0, 0, 0] for the root. */
  corrections: Float32Array
  /** Source joints the clip animates that match nothing on the target. */
  unmapped: string[]
  /** retarget/unmapped-root when the source's root joint matched nothing. */
  problem: ShardError | null
  /** Hip height ratio (target / source). */
  ratio: number
  /** The source root joint and where it went. */
  root: { source: string; target: string | null } | null
}

type Trs = { t: number[]; r: number[]; s: number[] }
interface Pose {
  p: number[]
  q: number[]
  s: number
}

/**
 * Maps a clip's channels onto the target model: `paths` are its entities by path under the player,
 * `restOf(path)` the local rest transform of one of them. Cold path: runs when a clip binds.
 */
export function planRetarget(
  channels: readonly AnimationChannel[],
  skin: SkinAsset,
  map: JointMapAsset | undefined,
  mode: (typeof RETARGET_MODES)[number],
  paths: ReadonlyMap<string, unknown>,
  restOf: (path: string) => Trs | undefined,
): RetargetPlan {
  const n = channels.length
  const plan: RetargetPlan = {
    targets: new Array(n).fill(undefined),
    kinds: new Uint8Array(n),
    corrections: new Float32Array(n * 8),
    unmapped: [],
    problem: null,
    ratio: 1,
    root: null,
  }
  // Target lookups: exact names and normalized keys, the shallowest path winning.
  const byName = new Map<string, string>()
  const byKey = new Map<string, string>()
  const sorted = [...paths.keys()].filter((p) => p !== '').sort((a, b) => depth(a) - depth(b))
  for (const path of sorted) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (!byName.has(name)) byName.set(name, path)
    const key = jointKey(name)
    if (!byKey.has(key)) byKey.set(key, path)
  }
  const find = (name: string): string | undefined => {
    if (paths.has(name) && name !== '') return name
    return byName.get(name.slice(name.lastIndexOf('/') + 1)) ?? byKey.get(jointKey(name))
  }
  const mapped = (source: string): string | undefined => {
    const name = source.slice(source.lastIndexOf('/') + 1)
    const to = map?.joints[source] ?? map?.joints[name]
    return to !== undefined ? find(to) : find(name)
  }
  // Source rest poses in skin (model) space.
  const srcIndex = new Map<string, number>()
  const srcByName = new Map<string, number>()
  skin.joints.forEach((p, i) => {
    srcIndex.set(p, i)
    const name = p.slice(p.lastIndexOf('/') + 1)
    if (!srcByName.has(name)) srcByName.set(name, i)
  })
  const srcWorld = sourceWorldPoses(skin)
  const indexOf = (target: string) =>
    srcIndex.get(target) ?? srcByName.get(target.slice(target.lastIndexOf('/') + 1))
  // The source root: the shallowest skin joint the clip animates.
  let rootIdx = -1
  for (const c of channels) {
    const j = indexOf(c.target)
    if (j === undefined) continue
    if (rootIdx < 0 || depth(skin.joints[j]!) < depth(skin.joints[rootIdx]!)) rootIdx = j
  }
  const targetWorld = new Map<string, Pose>()
  const tgtPose = (path: string): Pose => worldOfTarget(path, restOf, targetWorld)
  if (rootIdx >= 0) {
    const source = skin.joints[rootIdx]!
    const target = mapped(source) ?? null
    plan.root = { source, target }
    if (target === null) {
      plan.problem = new ShardError(
        'retarget/unmapped-root',
        `Retarget: the source root joint "${source}" matches no joint on the target`,
        {
          hint: 'Add it to the joint map (*.jointmap.json): { "joints": { "<source>": "<target>" } }.',
        },
      )
    } else {
      const srcY = srcWorld[rootIdx]!.p[1]!
      const tgtY = tgtPose(target).p[1]!
      plan.ratio = Math.abs(srcY) > 1e-6 ? tgtY / srcY : 1
    }
  }
  const unmapped = new Set<string>()
  for (let i = 0; i < n; i++) {
    const c = channels[i]!
    if (c.component !== 'core/Transform') {
      plan.targets[i] = c.target
      plan.kinds[i] = CHANNEL_AS_IS
      continue
    }
    const target = mapped(c.target)
    const j = indexOf(c.target)
    if (target === undefined) {
      unmapped.add(c.target.slice(c.target.lastIndexOf('/') + 1))
      plan.kinds[i] = CHANNEL_DROPPED
      continue
    }
    const isRoot = j !== undefined && j === rootIdx
    if (
      c.field === 'scale' ||
      (c.field === 'translation' && !(isRoot && mode === 'rotation-and-root'))
    ) {
      plan.kinds[i] = CHANNEL_DROPPED
      continue
    }
    if (c.field !== 'rotation' && c.field !== 'translation') {
      plan.kinds[i] = CHANNEL_DROPPED
      continue
    }
    plan.targets[i] = target
    // C = sourceParent⁻¹ · targetParent: how the parents' rest orientations differ.
    const srcParent = j !== undefined ? parentPose(skin, srcWorld, j) : IDENTITY
    const tgtParent = tgtPose(parentPath(target))
    const C = qmul(qconj(srcParent.q), tgtParent.q)
    const pre = qconj(C)
    plan.corrections.set(pre, i * 8)
    if (c.field === 'translation') {
      plan.kinds[i] = CHANNEL_ROOT
      plan.corrections.set([plan.ratio * (srcParent.s / (tgtParent.s || 1)), 0, 0, 0], i * 8 + 4)
      continue
    }
    // target = pre · sampled · post, post = sourceRest⁻¹ · C · targetRest.
    const srcRest = j !== undefined ? skin.restPose[j]!.rotation : [0, 0, 0, 1]
    const tgtRest = restOf(target)?.r ?? [0, 0, 0, 1]
    const post = qmul(qmul(qconj(srcRest), C), tgtRest)
    plan.kinds[i] = CHANNEL_ROTATION
    plan.corrections.set(post, i * 8 + 4)
  }
  plan.unmapped = [...unmapped].sort()
  return plan
}

const IDENTITY: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1], s: 1 }

function depth(path: string): number {
  let d = 1
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) d++
  return d
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** A target entity's rest pose in model space (relative to the player), composed from its path. */
function worldOfTarget(
  path: string,
  restOf: (path: string) => Trs | undefined,
  cache: Map<string, Pose>,
): Pose {
  if (path === '') return IDENTITY
  const hit = cache.get(path)
  if (hit) return hit
  const parent = worldOfTarget(parentPath(path), restOf, cache)
  const local = restOf(path)
  const pose = local ? compose(parent, local) : parent
  cache.set(path, pose)
  return pose
}

/** Each source joint's rest pose in skin space: the rest pose down the joint hierarchy, with the top joints placed by their inverse bind matrices. */
function sourceWorldPoses(skin: SkinAsset): Pose[] {
  const index = new Map(skin.joints.map((p, i) => [p, i]))
  const out: Pose[] = new Array(skin.joints.length)
  const visit = (i: number): Pose => {
    if (out[i]) return out[i]!
    const path = skin.joints[i]!
    const rest = skin.restPose[i] ?? {
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }
    const local = { t: rest.translation, r: rest.rotation, s: rest.scale }
    let parent: Pose | undefined
    for (let p = parentPath(path); p !== ''; p = parentPath(p)) {
      const k = index.get(p)
      if (k !== undefined) {
        parent = visit(k)
        break
      }
    }
    if (!parent) {
      // Above the top joint: its bind pose (inverse bind matrix) with its rest pose taken out.
      const bind = invertBind(skin.inverseBindMatrices, i)
      const s = (local.s[0]! + local.s[1]! + local.s[2]!) / 3 || 1
      const q = qmul(bind.q, qconj(local.r))
      const ps = bind.s / s
      const offset = qrotate(
        q,
        local.t.map((x) => x * ps),
      )
      parent = { p: bind.p.map((x, k) => x - offset[k]!), q, s: ps }
    }
    out[i] = compose(parent, local)
    return out[i]!
  }
  for (let i = 0; i < skin.joints.length; i++) visit(i)
  return out
}

function parentPose(skin: SkinAsset, world: Pose[], j: number): Pose {
  const pose = world[j]!
  const rest = skin.restPose[j]
  if (!rest) return IDENTITY
  // parent = world ∘ rest⁻¹.
  const s = (rest.scale[0]! + rest.scale[1]! + rest.scale[2]!) / 3 || 1
  const q = qmul(pose.q, qconj(rest.rotation))
  const ps = pose.s / s
  const offset = qrotate(
    q,
    rest.translation.map((x) => x * ps),
  )
  return { p: pose.p.map((x, k) => x - offset[k]!), q, s: ps }
}

/** The joint's bind transform: the inverse of its inverse bind matrix (column-major 4×4). */
function invertBind(ibm: Float32Array, j: number): Pose {
  const w = invert4(Array.from(ibm.subarray(j * 16, j * 16 + 16)))
  const at = (row: number, col: number) => w[col * 4 + row]!
  const s = Math.hypot(at(0, 0), at(1, 0), at(2, 0)) || 1
  return { p: [at(0, 3), at(1, 3), at(2, 3)], q: fromRotation((r, c) => at(r, c) / s), s }
}

/** General 4×4 inverse (column-major); identity when singular. */
function invert4(m: number[]): number[] {
  const inv = new Array<number>(16)
  inv[0] =
    m[5]! * m[10]! * m[15]! -
    m[5]! * m[11]! * m[14]! -
    m[9]! * m[6]! * m[15]! +
    m[9]! * m[7]! * m[14]! +
    m[13]! * m[6]! * m[11]! -
    m[13]! * m[7]! * m[10]!
  inv[4] =
    -m[4]! * m[10]! * m[15]! +
    m[4]! * m[11]! * m[14]! +
    m[8]! * m[6]! * m[15]! -
    m[8]! * m[7]! * m[14]! -
    m[12]! * m[6]! * m[11]! +
    m[12]! * m[7]! * m[10]!
  inv[8] =
    m[4]! * m[9]! * m[15]! -
    m[4]! * m[11]! * m[13]! -
    m[8]! * m[5]! * m[15]! +
    m[8]! * m[7]! * m[13]! +
    m[12]! * m[5]! * m[11]! -
    m[12]! * m[7]! * m[9]!
  inv[12] =
    -m[4]! * m[9]! * m[14]! +
    m[4]! * m[10]! * m[13]! +
    m[8]! * m[5]! * m[14]! -
    m[8]! * m[6]! * m[13]! -
    m[12]! * m[5]! * m[10]! +
    m[12]! * m[6]! * m[9]!
  inv[1] =
    -m[1]! * m[10]! * m[15]! +
    m[1]! * m[11]! * m[14]! +
    m[9]! * m[2]! * m[15]! -
    m[9]! * m[3]! * m[14]! -
    m[13]! * m[2]! * m[11]! +
    m[13]! * m[3]! * m[10]!
  inv[5] =
    m[0]! * m[10]! * m[15]! -
    m[0]! * m[11]! * m[14]! -
    m[8]! * m[2]! * m[15]! +
    m[8]! * m[3]! * m[14]! +
    m[12]! * m[2]! * m[11]! -
    m[12]! * m[3]! * m[10]!
  inv[9] =
    -m[0]! * m[9]! * m[15]! +
    m[0]! * m[11]! * m[13]! +
    m[8]! * m[1]! * m[15]! -
    m[8]! * m[3]! * m[13]! -
    m[12]! * m[1]! * m[11]! +
    m[12]! * m[3]! * m[9]!
  inv[13] =
    m[0]! * m[9]! * m[14]! -
    m[0]! * m[10]! * m[13]! -
    m[8]! * m[1]! * m[14]! +
    m[8]! * m[2]! * m[13]! +
    m[12]! * m[1]! * m[10]! -
    m[12]! * m[2]! * m[9]!
  inv[2] =
    m[1]! * m[6]! * m[15]! -
    m[1]! * m[7]! * m[14]! -
    m[5]! * m[2]! * m[15]! +
    m[5]! * m[3]! * m[14]! +
    m[13]! * m[2]! * m[7]! -
    m[13]! * m[3]! * m[6]!
  inv[6] =
    -m[0]! * m[6]! * m[15]! +
    m[0]! * m[7]! * m[14]! +
    m[4]! * m[2]! * m[15]! -
    m[4]! * m[3]! * m[14]! -
    m[12]! * m[2]! * m[7]! +
    m[12]! * m[3]! * m[6]!
  inv[10] =
    m[0]! * m[5]! * m[15]! -
    m[0]! * m[7]! * m[13]! -
    m[4]! * m[1]! * m[15]! +
    m[4]! * m[3]! * m[13]! +
    m[12]! * m[1]! * m[7]! -
    m[12]! * m[3]! * m[5]!
  inv[14] =
    -m[0]! * m[5]! * m[14]! +
    m[0]! * m[6]! * m[13]! +
    m[4]! * m[1]! * m[14]! -
    m[4]! * m[2]! * m[13]! -
    m[12]! * m[1]! * m[6]! +
    m[12]! * m[2]! * m[5]!
  inv[3] =
    -m[1]! * m[6]! * m[11]! +
    m[1]! * m[7]! * m[10]! +
    m[5]! * m[2]! * m[11]! -
    m[5]! * m[3]! * m[10]! -
    m[9]! * m[2]! * m[7]! +
    m[9]! * m[3]! * m[6]!
  inv[7] =
    m[0]! * m[6]! * m[11]! -
    m[0]! * m[7]! * m[10]! -
    m[4]! * m[2]! * m[11]! +
    m[4]! * m[3]! * m[10]! +
    m[8]! * m[2]! * m[7]! -
    m[8]! * m[3]! * m[6]!
  inv[11] =
    -m[0]! * m[5]! * m[11]! +
    m[0]! * m[7]! * m[9]! +
    m[4]! * m[1]! * m[11]! -
    m[4]! * m[3]! * m[9]! -
    m[8]! * m[1]! * m[7]! +
    m[8]! * m[3]! * m[5]!
  inv[15] =
    m[0]! * m[5]! * m[10]! -
    m[0]! * m[6]! * m[9]! -
    m[4]! * m[1]! * m[10]! +
    m[4]! * m[2]! * m[9]! +
    m[8]! * m[1]! * m[6]! -
    m[8]! * m[2]! * m[5]!
  const det = m[0]! * inv[0]! + m[1]! * inv[4]! + m[2]! * inv[8]! + m[3]! * inv[12]!
  if (Math.abs(det) < 1e-20) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  return inv.map((x) => x / det)
}

function fromRotation(m: (row: number, col: number) => number): number[] {
  const m00 = m(0, 0)
  const m11 = m(1, 1)
  const m22 = m(2, 2)
  const trace = m00 + m11 + m22
  let q: number[]
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    q = [(m(2, 1) - m(1, 2)) * s, (m(0, 2) - m(2, 0)) * s, (m(1, 0) - m(0, 1)) * s, 0.25 / s]
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    q = [0.25 * s, (m(0, 1) + m(1, 0)) / s, (m(0, 2) + m(2, 0)) / s, (m(2, 1) - m(1, 2)) / s]
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    q = [(m(0, 1) + m(1, 0)) / s, 0.25 * s, (m(1, 2) + m(2, 1)) / s, (m(0, 2) - m(2, 0)) / s]
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    q = [(m(0, 2) + m(2, 0)) / s, (m(1, 2) + m(2, 1)) / s, 0.25 * s, (m(1, 0) - m(0, 1)) / s]
  }
  const len = Math.hypot(...q) || 1
  return q.map((x) => x / len)
}

function compose(parent: Pose, local: Trs): Pose {
  const s = (local.s[0]! + local.s[1]! + local.s[2]!) / 3
  const offset = qrotate(
    parent.q,
    local.t.map((x) => x * parent.s),
  )
  return {
    p: parent.p.map((x, k) => x + offset[k]!),
    q: qmul(parent.q, local.r),
    s: parent.s * s,
  }
}

export function qmul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return [
    a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
    a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
    a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
    a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
  ]
}

export function qconj(a: ArrayLike<number>): number[] {
  return [-a[0]!, -a[1]!, -a[2]!, a[3]!]
}

export function qrotate(q: ArrayLike<number>, v: ArrayLike<number>): number[] {
  const r = qmul(qmul(q, [v[0]!, v[1]!, v[2]!, 0]), qconj(q))
  return [r[0]!, r[1]!, r[2]!]
}
