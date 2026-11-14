import {
  AssetStore,
  defineAssetType,
  defineDataAsset,
  type LoadContext,
} from '@aethervtt/shard-assets'
import { defineResource, defineSchema, type JsonValue, ShardError, t } from '@aethervtt/shard-core'

/** A body's collision shape, in its joint's rest frame (metres, model units). */
export type RagdollShape =
  | {
      kind: 'capsule'
      radius: number
      from: [number, number, number]
      to: [number, number, number]
    }
  | { kind: 'box'; half: [number, number, number]; center: [number, number, number] }
  | { kind: 'sphere'; radius: number; center: [number, number, number] }

/** How a body hangs from its parent body. Angles in radians, about the joint's own frame. */
export type RagdollJointDef =
  | { kind: 'spherical'; swing: [number, number]; twist: [number, number] }
  | { kind: 'revolute'; axis: [number, number, number]; limits: [number, number] }

export interface RagdollBodyDef {
  /** The skeleton joint the body follows (by name: the last path segment). */
  joint: string
  /** Index of the parent body (bodies are parents first), or -1 for the root body. */
  parent: number
  shape: RagdollShape
  /** Share of the asset's total mass. */
  mass: number
  zone: string
  /** How it hangs from its parent; undefined on the root body. */
  limits: RagdollJointDef | undefined
  /** Partial reactions: the most physics shows on it, and how much a hit here counts. */
  maxWeight: number
  stagger: number
  /**
   * Its joint's model-space pose at rest (t xyz, r xyzw), written by `shard ragdoll gen`: a server
   * with no skeleton hit-tests against it.
   */
  rest: Float32Array | undefined
}

export interface RagdollProfile {
  /** 1/s: an error closes over about 1/stiffness seconds. */
  stiffness: number
  /**
   * Damping ratio: 1 settles without overshoot, below 1 rings (a head hit swinging back and forth),
   * above 1 is sluggish. The settle rate is 4 × stiffness × damping².
   */
  damping: number
  /** 0 to 1: how much the drive pulls toward the animated world pose instead of the joint pose. */
  world: number
}

export interface RagdollRest {
  name: string
  from: 'front' | 'back' | 'side'
  /** Clip names: the lying pose and the get-up from it. */
  pose: string
  getUp: string
  /**
   * Extracted from `pose` (`shard ragdoll gen --clips`): per body, its joint's model-space pose
   * (t xyz, r xyzw) lying, relative to the root. For hit tests and the fall's steer.
   */
  bodies: Float32Array | undefined
  /** The get-up's root travel: [x, z] in its start frame at evenly spaced times. */
  travel: [number, number][] | undefined
  /** The get-up's length (s), extracted, for a side without its clip. */
  duration: number | undefined
}

export interface RagdollClipRole {
  clips: string[]
  blend: 'additive' | 'override'
  travel: [number, number][] | undefined
}

export interface RagdollReactionSettings {
  /** Partial weight per joint step from the hit body. */
  falloff: number
  /** How far a hit lowers a body's drive at full weight (0 to 1). */
  hitDrop: number
  /** Seconds a partial reaction takes to blend back. */
  recover: number
  /** The velocity change (m/s) that knocks it down by itself. */
  knockdownSpeed: number
  /** Stagger lost per second. */
  staggerDecay: number
  /** Impulse (N·s) past which a hit is heavy. */
  heavyImpulse: number
  /** Root speed (m/s) past which a hit is moving. */
  movingSpeed: number
  /** Seconds down before resting. */
  downTime: number
  /** Seconds rested before getting up, with drive auto. */
  restTime: number
  /** Ground deceleration (m/s²) for the knockdown slide. */
  groundDecel: number
  maxSlide: number
}

export interface RagdollAsset {
  /** Total mass, kg. */
  mass: number
  /** Parents first. */
  bodies: RagdollBodyDef[]
  /** Body index by joint name. */
  byJoint: Map<string, number>
  profiles: Map<string, RagdollProfile>
  rests: RagdollRest[]
  /** Clip roles: `hit.<light|heavy|moving>.<zone>`, `death[.moving].<zone>`. */
  roles: Map<string, RagdollClipRole>
  /** Role names in a fixed order (Reaction.role indexes it). */
  roleNames: string[]
  reactions: RagdollReactionSettings
}

export const DEFAULT_REACTIONS: RagdollReactionSettings = {
  falloff: 0.6,
  hitDrop: 0.9,
  recover: 0.85,
  knockdownSpeed: 2.5,
  staggerDecay: 0.8,
  heavyImpulse: 60,
  movingSpeed: 0.5,
  downTime: 2,
  restTime: 0,
  groundDecel: 6,
  maxSlide: 6,
}

export const DEFAULT_PROFILE: RagdollProfile = { stiffness: 30, damping: 1, world: 0.15 }

export const RagdollSchema = defineSchema(
  'ragdoll/Ragdoll',
  {
    skeleton: t.string({ description: 'The model it was made from (informational).' }),
    mass: t.f32({ default: 70, min: 0, unit: 'kg', description: 'Total mass of the bodies.' }),
    bodies: t.json({
      default: {},
      description:
        'By joint name: { shape: { capsule: { radius, from, to } } | { box: [hx, hy, hz], center? } | { sphere: { radius, center? } }, mass (share), parent?, zone?, joint?: { spherical: { swing: [y, z], twist: [min, max] } } | { revolute: { axis, limits } }, partial?: { maxWeight, stagger }, rest? }. Shapes are in the joint’s rest frame, in metres.',
    }),
    profiles: t.json({
      default: {},
      description:
        'Drive settings by name: { stiffness (1/s), damping (ratio: 1 critical), world (0-1) }.',
    }),
    rests: t.json({
      default: {},
      description:
        'Lying postures by name: { from: front|back|side, pose: clip, getUp: clip, bodies?, travel? }.',
    }),
    clips: t.json({
      default: {},
      description:
        'Clip roles: { "hit.light": { clip: name | names, blend: additive|override, travel? }, "death.head": … }.',
    }),
    reactions: t.json({
      default: {},
      description:
        'falloff, hitDrop, recover, knockdownSpeed, staggerDecay, heavyImpulse, movingSpeed, downTime, restTime, groundDecel, maxSlide.',
    }),
  },
  {
    description:
      'A ragdoll (*.ragdoll.json, 0117): bodies by joint name, joint limits, drive profiles, rests and clip roles.',
  },
)

export const RagdollAssets = defineResource<AssetStore<RagdollAsset, 'Ragdoll'>>(
  'ragdoll/RagdollAssets',
  { description: 'Ragdoll assets by guid.', init: () => new AssetStore('Ragdoll') },
)

export const RagdollAssetType = defineAssetType<RagdollAsset>('Ragdoll', {
  store: RagdollAssets,
  load: (artifact, ctx) => parseRagdoll(artifact.json, ctx),
  update: (existing, next) => Object.assign(existing, next),
})

/** `*.ragdoll.json` files import as Ragdoll. */
export const RagdollImporter = defineDataAsset('Ragdoll', RagdollSchema, { extension: 'ragdoll' })

const ZONES_BY_PATTERN: [RegExp, string][] = [
  [/head|neck/i, 'head'],
  [/(arm|hand|shoulder|clavicle).*(_l|\.l|left)$|left.*(arm|hand|shoulder)/i, 'arm_l'],
  [/(arm|hand|shoulder|clavicle).*(_r|\.r|right)$|right.*(arm|hand|shoulder)/i, 'arm_r'],
  [/(thigh|calf|leg|foot|ball|toe).*(_l|\.l|left)$|left.*(leg|foot|thigh)/i, 'leg_l'],
  [/(thigh|calf|leg|foot|ball|toe).*(_r|\.r|right)$|right.*(leg|foot|thigh)/i, 'leg_r'],
]

/** The zone a joint name falls in by default: head, arm_l, arm_r, leg_l, leg_r, else body. */
export function zoneOf(joint: string): string {
  for (const [re, zone] of ZONES_BY_PATTERN) if (re.test(joint)) return zone
  return 'body'
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const vec = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every(isNum)

function bad(message: string, path: string, hint?: string): ShardError {
  return new ShardError('ragdoll/invalid-asset', message, { path, ...(hint ? { hint } : {}) })
}

function parseShape(raw: unknown, path: string): RagdollShape {
  const s = raw as Record<string, unknown> | undefined
  if (s && typeof s === 'object') {
    const cap = s.capsule as Record<string, unknown> | undefined
    if (cap && isNum(cap.radius) && vec(cap.from, 3) && vec(cap.to, 3)) {
      return {
        kind: 'capsule',
        radius: cap.radius,
        from: cap.from as [number, number, number],
        to: cap.to as [number, number, number],
      }
    }
    if (vec(s.box, 3)) {
      return {
        kind: 'box',
        half: s.box as [number, number, number],
        center: vec(s.center, 3) ? (s.center as [number, number, number]) : [0, 0, 0],
      }
    }
    const sph = s.sphere as Record<string, unknown> | undefined
    if (sph && isNum(sph.radius)) {
      return {
        kind: 'sphere',
        radius: sph.radius,
        center: vec(sph.center, 3) ? (sph.center as [number, number, number]) : [0, 0, 0],
      }
    }
  }
  throw bad(
    'A body needs a shape: capsule { radius, from, to }, box [hx, hy, hz], or sphere { radius }',
    path,
  )
}

function parseLimits(raw: unknown, path: string): RagdollJointDef | undefined {
  if (raw === undefined) return undefined
  const j = raw as Record<string, unknown>
  const sph = j.spherical as Record<string, unknown> | undefined
  if (sph) {
    const swing = sph.swing ?? [Math.PI / 4, Math.PI / 4]
    const twist = sph.twist ?? [-Math.PI / 6, Math.PI / 6]
    if (!vec(swing, 2) || !vec(twist, 2) || swing[0]! < 0 || swing[1]! < 0) {
      throw new ShardError(
        'ragdoll/bad-limit',
        'A spherical joint takes swing [y, z] ≥ 0 and twist [min, max]',
        { path },
      )
    }
    if (twist[0]! > twist[1]!) {
      throw new ShardError('ragdoll/bad-limit', 'twist must be [min, max] with min ≤ max', { path })
    }
    return {
      kind: 'spherical',
      swing: swing as [number, number],
      twist: twist as [number, number],
    }
  }
  const rev = j.revolute as Record<string, unknown> | undefined
  if (rev) {
    if (!vec(rev.axis, 3) || !vec(rev.limits, 2) || rev.limits[0]! > rev.limits[1]!) {
      throw new ShardError(
        'ragdoll/bad-limit',
        'A revolute joint takes axis [x, y, z] and limits [min, max] with min ≤ max',
        { path },
      )
    }
    return {
      kind: 'revolute',
      axis: rev.axis as [number, number, number],
      limits: rev.limits as [number, number],
    }
  }
  throw new ShardError('ragdoll/bad-limit', 'joint must be { spherical: … } or { revolute: … }', {
    path,
  })
}

function parseTravel(raw: unknown, path: string): [number, number][] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length < 2 || !raw.every((p) => vec(p, 2))) {
    throw bad('travel must be a list of at least two [x, z] points', path)
  }
  return raw as [number, number][]
}

/** Parses and checks a ragdoll asset's JSON (the importer's load step). */
export function parseRagdoll(json: JsonValue | undefined, _ctx?: LoadContext): RagdollAsset {
  const root = (json ?? {}) as Record<string, unknown>
  const mass = isNum(root.mass) && root.mass > 0 ? root.mass : 70
  const rawBodies = (root.bodies ?? {}) as Record<string, Record<string, unknown>>
  const names = Object.keys(rawBodies)
  if (names.length === 0) throw bad('A ragdoll needs at least one body', '/bodies')
  // Parents: declared, else resolved later against the skeleton (marked -2 here).
  const order: string[] = []
  const placed = new Set<string>()
  const parentName = new Map<string, string | undefined>()
  for (const name of names) {
    const p = rawBodies[name]!.parent
    if (p !== undefined && (typeof p !== 'string' || !(p in rawBodies))) {
      throw new ShardError(
        'ragdoll/unknown-joint',
        `Body "${name}" has parent "${String(p)}", which isn't a body`,
        {
          path: `/bodies/${name}/parent`,
        },
      )
    }
    parentName.set(name, p as string | undefined)
  }
  // Parents first: a stable topological order over declared parents (undeclared go as written).
  const visit = (name: string, stack: Set<string>) => {
    if (placed.has(name)) return
    if (stack.has(name)) {
      throw bad(`Body "${name}" is its own ancestor`, `/bodies/${name}/parent`)
    }
    stack.add(name)
    const p = parentName.get(name)
    if (p !== undefined) visit(p, stack)
    placed.add(name)
    order.push(name)
  }
  for (const name of names) visit(name, new Set())
  const byJoint = new Map<string, number>()
  const bodies: RagdollBodyDef[] = []
  let roots = 0
  for (const name of order) {
    const b = rawBodies[name]!
    const path = `/bodies/${name}`
    const p = parentName.get(name)
    const partial = (b.partial ?? {}) as Record<string, unknown>
    const def: RagdollBodyDef = {
      joint: name,
      parent: p === undefined ? -2 : byJoint.get(p)!,
      shape: parseShape(b.shape, `${path}/shape`),
      mass: isNum(b.mass) && b.mass > 0 ? b.mass : 1 / names.length,
      zone: typeof b.zone === 'string' ? b.zone : zoneOf(name),
      limits: parseLimits(b.joint, `${path}/joint`),
      maxWeight: isNum(partial.maxWeight) ? Math.min(1, Math.max(0, partial.maxWeight)) : 1,
      stagger: isNum(partial.stagger) ? Math.max(0, partial.stagger) : 1,
      rest: vec(b.rest, 7) ? new Float32Array(b.rest as number[]) : undefined,
    }
    if (p === undefined && b.joint === undefined) roots++
    byJoint.set(name, bodies.length)
    bodies.push(def)
  }
  if (roots === 0) {
    throw bad(
      'One body (the root, usually the pelvis) needs no joint',
      '/bodies',
      'Remove "joint" from the pelvis.',
    )
  }
  const profiles = new Map<string, RagdollProfile>()
  profiles.set('default', { ...DEFAULT_PROFILE })
  for (const [name, raw] of Object.entries(
    (root.profiles ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    const base = profiles.get('default')!
    profiles.set(name, {
      stiffness: isNum(raw.stiffness) ? Math.max(0, raw.stiffness) : base.stiffness,
      damping: isNum(raw.damping) ? Math.max(0, raw.damping) : base.damping,
      world: isNum(raw.world) ? Math.min(1, Math.max(0, raw.world)) : base.world,
    })
  }
  const rests: RagdollRest[] = []
  for (const [name, raw] of Object.entries(
    (root.rests ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    const path = `/rests/${name}`
    const from = raw.from
    if (from !== 'front' && from !== 'back' && from !== 'side') {
      throw bad(`Rest "${name}" needs from: front, back or side`, `${path}/from`)
    }
    if (typeof raw.pose !== 'string' || typeof raw.getUp !== 'string') {
      throw bad(`Rest "${name}" needs pose and getUp clip names`, path)
    }
    let poses: Float32Array | undefined
    if (raw.bodies !== undefined) {
      const list = raw.bodies as Record<string, unknown>
      poses = new Float32Array(bodies.length * 7)
      for (let i = 0; i < bodies.length; i++) {
        const v = list[bodies[i]!.joint]
        if (!vec(v, 7))
          throw bad(`Rest "${name}" needs a [t, r] pose for every body`, `${path}/bodies`)
        poses.set(v as number[], i * 7)
      }
    }
    rests.push({
      name,
      from,
      pose: raw.pose,
      getUp: raw.getUp,
      bodies: poses,
      travel: parseTravel(raw.travel, `${path}/travel`),
      duration: isNum(raw.duration) && raw.duration > 0 ? raw.duration : undefined,
    })
  }
  const roles = new Map<string, RagdollClipRole>()
  for (const [name, raw] of Object.entries((root.clips ?? {}) as Record<string, unknown>)) {
    const path = `/clips/${name}`
    if (!/^(hit\.(light|heavy|moving)|death(\.moving)?)(\.[\w-]+)?$/.test(name)) {
      throw bad(
        `Unknown clip role "${name}"`,
        path,
        'Roles are hit.light, hit.heavy, hit.moving, death and death.moving, each optionally .<zone>.',
      )
    }
    const r = (typeof raw === 'string' ? { clip: raw } : raw) as Record<string, unknown>
    const clips = typeof r.clip === 'string' ? [r.clip] : r.clip
    if (!Array.isArray(clips) || clips.length === 0 || !clips.every((c) => typeof c === 'string')) {
      throw bad(`Clip role "${name}" needs clip: a name or a list of names`, `${path}/clip`)
    }
    const blend = r.blend ?? (name.startsWith('hit.light') ? 'additive' : 'override')
    if (blend !== 'additive' && blend !== 'override') {
      throw bad(`Clip role "${name}": blend is additive or override`, `${path}/blend`)
    }
    roles.set(name, {
      clips: clips as string[],
      blend,
      travel: parseTravel(r.travel, `${path}/travel`),
    })
  }
  const rawReactions = (root.reactions ?? {}) as Record<string, unknown>
  const reactions = { ...DEFAULT_REACTIONS }
  for (const key of Object.keys(reactions) as (keyof RagdollReactionSettings)[]) {
    const v = rawReactions[key]
    if (v === undefined) continue
    if (!isNum(v) || v < 0) throw bad(`reactions.${key} must be a number ≥ 0`, `/reactions/${key}`)
    reactions[key] = v
  }
  return {
    mass,
    bodies,
    byJoint,
    profiles,
    rests,
    roles,
    roleNames: [...roles.keys()].sort(),
    reactions,
  }
}
