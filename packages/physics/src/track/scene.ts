import { type Quat, ShardError, type Vec3 } from '@aethervtt/shard-core'
import { Hasher } from './hash'

/**
 * What a track records: fixed colliders, and bodies with their starting poses and velocities. Plain
 * data, so it crosses a worker boundary and hashes the same everywhere. The caller computes every
 * number (dice draw theirs from a seeded Rng); the recorder never draws random numbers.
 */
export interface TrackScene {
  version: 1
  dim: 3
  /** Seconds per step, e.g. 1 / 60. */
  step: number
  /** The longest the track can be, in steps (at most 65535). */
  maxSteps: number
  gravity: Vec3
  /** Floor, walls: colliders without a body. */
  fixed: TrackCollider[]
  /** Recorded, in this order: body i of the track is `bodies[i]`. */
  bodies: TrackBody[]
  /** Collision groups colliders name; a collider without one collides with everything. */
  groups?: { [name: string]: TrackGroup }
}

export interface TrackGroup {
  /** Bits of the 16 collision layers this group is in. */
  layers: number
  /** The layers it collides with. Two colliders touch when each one's layers meet the other's mask. */
  mask: number
}

export interface TrackBody {
  /** Names the body in errors (`physics/track-diverged`); unique in the scene. */
  id: string
  translation: Vec3
  rotation: Quat
  linear: Vec3
  angular: Vec3
  colliders: TrackCollider[]
  ccd?: boolean
  /** Default true. */
  canSleep?: boolean
  linearDamping?: number
  angularDamping?: number
}

export interface TrackCollider {
  shape: 'ball' | 'cuboid' | 'convex'
  radius?: number
  halfExtents?: Vec3
  /** Convex hull points, x y z each, already scaled. */
  points?: Float32Array
  /** Offset from the body (default none). Fixed colliders: their place in the world. */
  translation?: Vec3
  rotation?: Quat
  friction: number
  restitution: number
  density: number
  /** A key of `TrackScene.groups`. */
  group?: string
}

export const TRACK_SCENE_VERSION = 1
/** Contacts store step indices as u16. */
export const MAX_TRACK_STEPS = 65535
/** Contacts store body indices as i16. */
export const MAX_TRACK_BODIES = 32767

function invalid(message: string, path: string): ShardError {
  return new ShardError('physics/track-scene', message, {
    path,
    hint: 'See TrackScene in @aethervtt/shard-physics/track.',
  })
}

function finite(v: unknown, path: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw invalid(`${path} is not a finite number`, path)
}

function vector(v: unknown, n: number, path: string): void {
  if (!Array.isArray(v) || v.length !== n) throw invalid(`${path} needs ${n} numbers`, path)
  for (let i = 0; i < n; i++) finite(v[i], `${path}[${i}]`)
}

function checkCollider(c: TrackCollider, path: string, groups: TrackScene['groups']): void {
  if (c.shape === 'ball') {
    finite(c.radius, `${path}.radius`)
    if (c.radius! <= 0) throw invalid(`${path}.radius must be positive`, `${path}.radius`)
  } else if (c.shape === 'cuboid') {
    vector(c.halfExtents, 3, `${path}.halfExtents`)
    if (c.halfExtents!.some((h) => h <= 0))
      throw invalid(`${path}.halfExtents must be positive`, `${path}.halfExtents`)
  } else if (c.shape === 'convex') {
    const p = c.points
    if (!(p instanceof Float32Array) || p.length < 12 || p.length % 3 !== 0)
      throw invalid(
        `${path}.points needs 4 or more x y z points in a Float32Array`,
        `${path}.points`,
      )
    for (let i = 0; i < p.length; i++) finite(p[i], `${path}.points[${i}]`)
  } else {
    throw invalid(
      `${path}.shape "${String(c.shape)}" isn't ball, cuboid or convex`,
      `${path}.shape`,
    )
  }
  if (c.translation !== undefined) vector(c.translation, 3, `${path}.translation`)
  if (c.rotation !== undefined) vector(c.rotation, 4, `${path}.rotation`)
  finite(c.friction, `${path}.friction`)
  finite(c.restitution, `${path}.restitution`)
  finite(c.density, `${path}.density`)
  if (c.group !== undefined && !groups?.[c.group])
    throw invalid(`${path}.group "${c.group}" isn't in scene.groups`, `${path}.group`)
}

/** Throws `physics/track-scene` naming the first thing wrong with a scene. */
export function checkTrackScene(scene: TrackScene): void {
  if (scene.version !== TRACK_SCENE_VERSION)
    throw invalid(`Track scene version ${scene.version} isn't 1`, 'version')
  if (scene.dim !== 3) throw invalid('Only 3D tracks exist (dim: 3)', 'dim')
  finite(scene.step, 'step')
  if (scene.step <= 0) throw invalid('step must be positive', 'step')
  if (!Number.isInteger(scene.maxSteps) || scene.maxSteps < 1 || scene.maxSteps > MAX_TRACK_STEPS)
    throw invalid(`maxSteps must be an integer from 1 to ${MAX_TRACK_STEPS}`, 'maxSteps')
  vector(scene.gravity, 3, 'gravity')
  for (const [name, g] of Object.entries(scene.groups ?? {})) {
    for (const key of ['layers', 'mask'] as const) {
      const v = g[key]
      if (!Number.isInteger(v) || v < 0 || v > 0xffff)
        throw invalid(`groups.${name}.${key} must be a 16-bit mask`, `groups.${name}.${key}`)
    }
  }
  scene.fixed.forEach((c, i) => {
    checkCollider(c, `fixed[${i}]`, scene.groups)
  })
  if (scene.bodies.length > MAX_TRACK_BODIES)
    throw invalid(`A track holds at most ${MAX_TRACK_BODIES} bodies`, 'bodies')
  const ids = new Set<string>()
  scene.bodies.forEach((b, i) => {
    const path = `bodies[${i}]`
    if (typeof b.id !== 'string' || ids.has(b.id))
      throw invalid(`${path}.id must be a string unique in the scene`, `${path}.id`)
    ids.add(b.id)
    vector(b.translation, 3, `${path}.translation`)
    vector(b.rotation, 4, `${path}.rotation`)
    vector(b.linear, 3, `${path}.linear`)
    vector(b.angular, 3, `${path}.angular`)
    if (b.linearDamping !== undefined) finite(b.linearDamping, `${path}.linearDamping`)
    if (b.angularDamping !== undefined) finite(b.angularDamping, `${path}.angularDamping`)
    if (b.colliders.length === 0) throw invalid(`${path} has no colliders`, `${path}.colliders`)
    b.colliders.forEach((c, j) => {
      checkCollider(c, `${path}.colliders[${j}]`, scene.groups)
    })
  })
}

type JsonCollider = Omit<TrackCollider, 'points'> & { points?: number[] }

/** A scene as JSON can hold it: convex points as plain arrays. */
export function trackSceneToJson(scene: TrackScene): unknown {
  const collider = (c: TrackCollider): JsonCollider =>
    c.points ? { ...c, points: Array.from(c.points) } : (c as JsonCollider)
  return {
    ...scene,
    fixed: scene.fixed.map(collider),
    bodies: scene.bodies.map((b) => ({ ...b, colliders: b.colliders.map(collider) })),
  }
}

/** A scene from JSON (`trackSceneToJson`, a file): points become Float32Arrays, then it's checked. */
export function trackSceneFromJson(json: unknown): TrackScene {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as TrackScene).bodies)) {
    throw invalid('A track scene is an object with fixed and bodies', '')
  }
  const s = json as Omit<TrackScene, 'fixed' | 'bodies'> & {
    fixed?: JsonCollider[]
    bodies: (Omit<TrackBody, 'colliders'> & { colliders?: JsonCollider[] })[]
  }
  const collider = (c: JsonCollider): TrackCollider =>
    Array.isArray(c.points) ? { ...c, points: Float32Array.from(c.points) } : (c as TrackCollider)
  const scene: TrackScene = {
    ...s,
    fixed: (s.fixed ?? []).map(collider),
    bodies: s.bodies.map((b) => ({ ...b, colliders: (b.colliders ?? []).map(collider) })),
  }
  checkTrackScene(scene)
  return scene
}

function hashCollider(h: Hasher, c: TrackCollider): void {
  h.str(c.shape).f64(c.radius ?? 0)
  const he = c.halfExtents ?? [0, 0, 0]
  h.f64(he[0]).f64(he[1]).f64(he[2])
  h.array(c.points ?? new Float32Array(0))
  const t = c.translation ?? [0, 0, 0]
  const r = c.rotation ?? [0, 0, 0, 1]
  h.f64(t[0]).f64(t[1]).f64(t[2])
  h.f64(r[0]).f64(r[1]).f64(r[2]).f64(r[3])
  h.f64(c.friction)
    .f64(c.restitution)
    .f64(c.density)
    .str(c.group ?? '')
}

/**
 * The hash of a scene's canonical form: every field in a fixed order, defaults filled in, groups
 * sorted by name. Two scenes that record the same track hash the same.
 */
export function sceneHash(scene: TrackScene): number {
  const h = new Hasher()
  h.u32(scene.version).u32(scene.dim).f64(scene.step).u32(scene.maxSteps)
  h.f64(scene.gravity[0]).f64(scene.gravity[1]).f64(scene.gravity[2])
  const groups = Object.keys(scene.groups ?? {}).sort()
  h.u32(groups.length)
  for (const name of groups) {
    const g = scene.groups![name]!
    h.str(name).u32(g.layers).u32(g.mask)
  }
  h.u32(scene.fixed.length)
  for (const c of scene.fixed) hashCollider(h, c)
  h.u32(scene.bodies.length)
  for (const b of scene.bodies) {
    h.str(b.id)
    for (const v of [b.translation, b.rotation, b.linear, b.angular]) for (const x of v) h.f64(x)
    h.bool(b.ccd ?? false).bool(b.canSleep ?? true)
    h.f64(b.linearDamping ?? 0).f64(b.angularDamping ?? 0)
    h.u32(b.colliders.length)
    for (const c of b.colliders) hashCollider(h, c)
  }
  return h.digest()
}
