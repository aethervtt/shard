import {
  ChildOf,
  defineSystem,
  type Entity,
  findComponent,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { Nav, navRaycast, setNavMover } from '@aethervtt/shard-nav'
import { NetRole } from '@aethervtt/shard-net'
import { CharacterController, CharacterState, CharacterSuspended } from '@aethervtt/shard-physics'
import { Time } from '@aethervtt/shard-runtime'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { type RagdollAsset, RagdollAssets, type RagdollRest } from './asset'
import {
  DEAD,
  DOWN,
  GETTING_UP,
  GotUp,
  type HitKind,
  KnockedDown,
  NONE,
  PARTIAL,
  Ragdoll,
  REACTION_STATES,
  RESTED,
  Reaction,
  ReactionStarted,
  Rested,
} from './components'
import { hitTest } from './hit'

export interface HitOptions {
  /** Where it landed (world). Without `bone`, the body nearest it takes the hit. */
  point?: ArrayLike<number>
  /** N·s, world. */
  impulse?: ArrayLike<number>
  /** A velocity (m/s) given to every body instead of an impulse at one: a car. Always full. */
  launch?: ArrayLike<number>
  /** The body hit, by joint name or index. */
  bone?: string | number
  kind?: HitKind
  /** Lie in this rest instead of the one the direction picks. */
  rest?: string
}

/** Per root: what the reaction keeps between frames. Internal. */
export interface ReactionTrack {
  /** Time stagger was last decayed to. */
  stamp: number
  /** The get-up (or a travelling role clip) moving the root: start pose and duration. */
  travel: [number, number][] | undefined
  travelStart: Float64Array
  travelYaw: number
  travelFrom: number
  travelFor: number
  /** Movement handed off while down: restore on standing. */
  suspended: boolean
  external: boolean
  /** A knockdown's slide, run over the fall rather than in one step: from, to (root local). */
  slideFrom: Float64Array
  slideTo: Float64Array
  sliding: boolean
}

const tracks = new WeakMap<World, Map<Entity, ReactionTrack>>()

export function reactionTracks(world: World): Map<Entity, ReactionTrack> {
  let m = tracks.get(world)
  if (!m) {
    m = new Map()
    tracks.set(world, m)
  }
  return m
}

function track(world: World, root: Entity): ReactionTrack {
  const m = reactionTracks(world)
  let t = m.get(root)
  if (!t) {
    t = {
      stamp: world.resource(Time).elapsed,
      travel: undefined,
      travelStart: new Float64Array(3),
      travelYaw: 0,
      travelFrom: 0,
      travelFor: 0,
      suspended: false,
      external: false,
      slideFrom: new Float64Array(3),
      slideTo: new Float64Array(3),
      sliding: false,
    }
    m.set(root, t)
  }
  return t
}

/** The root's ragdoll asset, or a ragdoll/no-asset error. */
export function assetOf(world: World, root: Entity): RagdollAsset {
  const r = world.tryGet(root, Ragdoll)
  const asset = r?.asset ? world.tryResource(RagdollAssets)?.get(r.asset) : undefined
  if (!asset) {
    throw new ShardError(
      'ragdoll/no-asset',
      r ? `Entity ${root}'s ragdoll asset isn't loaded` : `Entity ${root} has no ragdoll/Ragdoll`,
      { hint: 'Add ragdoll/Ragdoll { asset } to the root and load the *.ragdoll.json first.' },
    )
  }
  return asset
}

/** Whether this app only mirrors reactions (a net client): the server decides them. */
export function mirrorsReactions(world: World): boolean {
  return world.tryResource(NetRole)?.role === 'client'
}

/** The ragdoll root an entity belongs to (itself or an ancestor with Ragdoll), if any. */
export function ragdollRootOf(world: World, entity: Entity): Entity | undefined {
  let e: Entity | null = entity
  for (let depth = 0; e !== null && depth < 16; depth++) {
    if (!world.isAlive(e)) return undefined
    if (world.has(e, Ragdoll)) return e
    e = world.has(e, ChildOf) ? world.get(e, ChildOf).parent : null
  }
  return undefined
}

const scratchHit = {
  body: -1,
  zone: '',
  bone: '',
  distance: 0,
  point: new Float64Array(3),
  normal: new Float64Array(3),
}

/** The body nearest a world point: by a ray from the point toward the root's centre. */
function nearestBody(world: World, root: Entity, asset: RagdollAsset, point: ArrayLike<number>) {
  const g = world.get(root, GlobalTransform).matrix
  const dir = [g[3]! - point[0]!, g[7]! + 1 - point[1]!, g[11]! - point[2]!]
  // Start just outside the point, aimed through it at the body's middle.
  const len = Math.sqrt(dir[0]! ** 2 + dir[1]! ** 2 + dir[2]! ** 2) || 1
  const from = [
    point[0]! - (dir[0]! / len) * 0.5,
    point[1]! - (dir[1]! / len) * 0.5,
    point[2]! - (dir[2]! / len) * 0.5,
  ]
  if (hitTest(world, root, from, dir, scratchHit, { maxDistance: 2 })) return scratchHit.body
  return asset.bodies.findIndex((b) => b.parent < 0 || b.joint === asset.bodies[0]!.joint)
}

/** The rest a hit from this direction lands in: from the front on its back, and so on. */
function chooseRest(
  asset: RagdollAsset,
  world: World,
  root: Entity,
  dx: number,
  dz: number,
): number {
  if (asset.rests.length === 0) return 255
  const g = world.get(root, GlobalTransform).matrix
  // The root's forward (+z) on the ground.
  let fx = g[2]!
  let fz = g[10]!
  const fl = Math.sqrt(fx * fx + fz * fz) || 1
  fx /= fl
  fz /= fl
  const l = Math.sqrt(dx * dx + dz * dz)
  const along = l > 1e-6 ? (dx * fx + dz * fz) / l : -1
  // Pushed backward (against its facing): hit from the front.
  const from = along < -0.5 ? 'front' : along > 0.5 ? 'back' : 'side'
  let k = asset.rests.findIndex((r) => r.from === from)
  if (k < 0 && from === 'side')
    k = asset.rests.findIndex((r) => r.from === (along <= 0 ? 'front' : 'back'))
  return k < 0 ? 0 : k
}

/** The role a hit picks: `hit.<light|heavy|moving>[.zone]` or `death[.moving][.zone]`. */
function chooseRole(
  asset: RagdollAsset,
  death: boolean,
  heavy: boolean,
  moving: boolean,
  zone: string,
): number {
  const names = asset.roleNames
  const tryRole = (base: string) => {
    const z = names.indexOf(`${base}.${zone}`)
    if (z >= 0) return z
    return names.indexOf(base)
  }
  let k = -1
  if (death) {
    if (moving) k = tryRole('death.moving')
    if (k < 0) k = tryRole('death')
  } else {
    if (moving) k = tryRole('hit.moving')
    if (k < 0 && heavy) k = tryRole('hit.heavy')
    if (k < 0) k = tryRole('hit.light')
  }
  return k < 0 ? 255 : k
}

/** The root's horizontal speed (m/s): its controller's, else 0. */
export function rootVelocity(world: World, root: Entity, out: Float64Array): void {
  out[0] = out[1] = out[2] = 0
  const cs = world.tryGet(root, CharacterState)
  if (cs) {
    out[0] = cs.velocity[0]
    out[1] = cs.velocity[1]
    out[2] = cs.velocity[2]
    return
  }
  const def = findComponent('nav/NavAgentState')
  const st =
    def && world.has(root, def) ? (world.get(root, def) as { velocity?: number[] }) : undefined
  if (st?.velocity) {
    out[0] = st.velocity[0]!
    out[1] = st.velocity[1]!
    out[2] = st.velocity[2]!
  }
}

const vel = new Float64Array(3)

/**
 * Registers a hit on a ragdoll root (0117): stagger, the reaction it starts (partial, down, dead),
 * the rest a knockdown lands in and where the root slides, and the clip role. On a net client it
 * does nothing: the server's Reaction arrives replicated. Cold path (a hit).
 */
export function hit(world: World, root: Entity, options: HitOptions): void {
  if (mirrorsReactions(world)) return
  const asset = assetOf(world, root)
  if (!world.has(root, Reaction)) world.add(root, Reaction, {})
  const now = world.resource(Time).elapsed
  const tr = track(world, root)
  decay(world, root, asset, tr, now)
  const r = world.get(root, Reaction)
  let body = 0
  if (typeof options.bone === 'number') body = options.bone
  else if (typeof options.bone === 'string') {
    const b = asset.byJoint.get(options.bone)
    if (b === undefined) {
      throw new ShardError('ragdoll/unknown-joint', `The ragdoll has no body "${options.bone}"`, {
        hint: `Bodies: ${asset.bodies.map((b) => b.joint).join(', ')}.`,
      })
    }
    body = b
  } else if (options.point) body = Math.max(0, nearestBody(world, root, asset, options.point))
  else
    body = Math.max(
      0,
      asset.bodies.findIndex((b) => b.parent < 0),
    )
  const def = asset.bodies[body]!
  const launch = options.launch !== undefined
  const v = launch ? options.launch! : (options.impulse ?? [0, 0, 0])
  const vx = v[0]!
  const vy = v[1]!
  const vz = v[2]!
  const magnitude = Math.sqrt(vx * vx + vy * vy + vz * vz)
  // The velocity change: an impulse spreads over the whole mass.
  const dv = launch ? magnitude : magnitude / asset.mass
  const kind = options.kind ?? 'auto'
  let stagger =
    r.stagger + (launch ? 1 : (dv / Math.max(asset.reactions.knockdownSpeed, 1e-6)) * def.stagger)
  const state = REACTION_STATES.indexOf(r.state)
  let next = state
  if (state === DEAD) next = DEAD
  else if (kind === 'death') next = DEAD
  else if (launch || kind === 'knockdown' || (kind === 'auto' && stagger >= 1)) {
    next = state === DOWN || state === RESTED ? state : DOWN
  } else if (state === NONE || state === PARTIAL) next = PARTIAL
  if (next === DOWN && state !== DOWN) stagger = 0
  rootVelocity(world, root, vel)
  const moving = Math.sqrt(vel[0]! ** 2 + vel[2]! ** 2) > asset.reactions.movingSpeed
  const role = chooseRole(
    asset,
    next === DEAD && state !== DEAD,
    magnitude >= asset.reactions.heavyImpulse,
    moving,
    def.zone,
  )
  let rest = r.rest
  if (next === DOWN && state !== DOWN) {
    const named =
      options.rest !== undefined ? asset.rests.findIndex((x) => x.name === options.rest) : -1
    rest = named >= 0 ? named : chooseRest(asset, world, root, vx, vz)
    // Where it lands: the simulation's own landing when this app simulates it alone, else a
    // deterministic slide (a server, or a client's server) run over the fall.
    if (!landsLocally(world)) {
      slide(world, root, asset, launch ? vx : vx / asset.mass, launch ? vz : vz / asset.mass, tr)
    }
    holdMovement(world, root, tr)
  }
  if (next === DEAD && state !== DEAD) holdMovement(world, root, tr)
  const changed = next !== state
  world.set(root, Reaction, {
    state: REACTION_STATES[next]!,
    since: changed ? now : r.since,
    stagger,
    bone: body,
    rest,
    role,
    impulse: [vx, vy, vz],
    launch,
    seq: (r.seq + 1) & 0xffff,
  })
  world.send(ReactionStarted, {
    entity: root,
    kind: REACTION_STATES[next]!,
    bone: def.joint,
    zone: def.zone,
    role: role === 255 ? '' : asset.roleNames[role]!,
  })
  if (changed && next === DOWN) {
    world.send(KnockedDown, { entity: root, rest: asset.rests[rest]?.name ?? '' })
  }
}

/** A downed root (drive game) is standing again: its reaction ends. */
export function stand(world: World, root: Entity): void {
  if (mirrorsReactions(world) || !world.has(root, Reaction)) return
  const r = world.get(root, Reaction)
  if (r.state === 'dead' || r.state === 'none') return
  finish(world, root, track(world, root))
}

function finish(world: World, root: Entity, tr: ReactionTrack): void {
  const r = world.get(root, Reaction)
  const wasDown = r.state === 'down' || r.state === 'rested' || r.state === 'getting-up'
  world.set(root, Reaction, {
    ...r,
    state: 'none',
    since: world.resource(Time).elapsed,
    stagger: 0,
  })
  releaseMovement(world, root, tr)
  tr.travel = undefined
  if (wasDown) world.send(GotUp, { entity: root })
}

/** While down or dead, nav stops moving the agent and its controller is suspended. */
function holdMovement(world: World, root: Entity, tr: ReactionTrack): void {
  if (!tr.external && world.tryResource(Nav)?.agents.has(root)) {
    setNavMover(world, root, 'external')
    tr.external = true
  }
  if (
    !tr.suspended &&
    world.has(root, CharacterController) &&
    !world.has(root, CharacterSuspended)
  ) {
    world.add(root, CharacterSuspended)
    tr.suspended = true
  }
}

function releaseMovement(world: World, root: Entity, tr: ReactionTrack): void {
  if (tr.external) {
    if (world.tryResource(Nav)) setNavMover(world, root, 'crowd')
    tr.external = false
  }
  if (tr.suspended) {
    if (world.has(root, CharacterSuspended)) world.remove(root, CharacterSuspended)
    tr.suspended = false
  }
}

const navHit = { t: 1, point: new Float64Array(3), normal: new Float64Array(3) }

/**
 * Where a knockdown lands: the root slides along the ground in the velocity change's horizontal
 * direction, `min(Δv² / (2 × groundDecel), maxSlide)`, stopping at navmesh walls when there's one.
 */
function slide(
  world: World,
  root: Entity,
  asset: RagdollAsset,
  dvx: number,
  dvz: number,
  tr: ReactionTrack,
): void {
  const speed = Math.sqrt(dvx * dvx + dvz * dvz)
  if (speed < 1e-6) return
  const d = Math.min(
    (speed * speed) / (2 * Math.max(asset.reactions.groundDecel, 1e-3)),
    asset.reactions.maxSlide,
  )
  const t = world.get(root, Transform)
  const from = [t.translation[0], t.translation[1], t.translation[2]]
  let dx = (dvx / speed) * d
  let dz = (dvz / speed) * d
  // A root under a parent moves in its parent's frame: the world step turned into it.
  const parent = world.has(root, ChildOf) ? world.get(root, ChildOf).parent : null
  if (parent !== null && world.has(parent, GlobalTransform)) {
    const g = world.get(parent, GlobalTransform).matrix
    const lx = g[0]! * dx + g[8]! * dz
    const lz = g[2]! * dx + g[10]! * dz
    dx = lx
    dz = lz
  }
  const to = [from[0]! + dx, from[1]!, from[2]! + dz]
  if (world.tryResource(Nav) && parent === null) {
    try {
      if (navRaycast(world, from, to, navHit)) {
        to[0] = navHit.point[0]!
        to[2] = navHit.point[2]!
      }
    } catch {
      // No navmesh under it: slide straight.
    }
  }
  tr.slideFrom.set(from)
  tr.slideTo[0] = to[0]!
  tr.slideTo[1] = to[1]!
  tr.slideTo[2] = to[2]!
  tr.sliding = true
}

/** Moves a sliding root along its slide: eased out over the fall, at its end by `downTime`. */
function slideStep(world: World, root: Entity, tr: ReactionTrack, k: number): void {
  // Starts once the ragdoll has taken over (activation and blend-in), slows to a stop.
  const x = Math.min(1, Math.max(0, k))
  const e = 1 - (1 - x) * (1 - x)
  const t = world.get(root, Transform)
  world.set(root, Transform, {
    ...t,
    translation: [
      tr.slideFrom[0]! + (tr.slideTo[0]! - tr.slideFrom[0]!) * e,
      t.translation[1],
      tr.slideFrom[2]! + (tr.slideTo[2]! - tr.slideFrom[2]!) * e,
    ],
  })
  if (x >= 1) tr.sliding = false
}

const local = new WeakSet<World>()

/** ragdollPlugin's mark: this app simulates ragdolls (no server decides where they land). */
export function setLocalLanding(world: World): void {
  local.add(world)
}

/**
 * Whether a knockdown lands where this app's ragdoll lands: it simulates ragdolls and has no net
 * role. A server (or a client mirroring one) slides the root deterministically instead.
 */
export function landsLocally(world: World): boolean {
  return local.has(world) && world.tryResource(NetRole) === undefined
}

/** Stagger lost since it was last decayed. */
function decay(
  world: World,
  root: Entity,
  asset: RagdollAsset,
  tr: ReactionTrack,
  now: number,
): void {
  const dt = now - tr.stamp
  tr.stamp = now
  if (dt <= 0 || !world.has(root, Reaction)) return
  const r = world.get(root, Reaction)
  if (r.stagger <= 0) return
  const s = Math.max(0, r.stagger - asset.reactions.staggerDecay * dt)
  const table = world.entityTableUnchecked(root)
  table.column(Reaction, 'stagger')[world.entityRowUnchecked(root)] = s
}

/** Where a travel curve has carried the root at t (0–1), in its start frame. */
export function travelAt(curve: [number, number][], t: number, out: Float64Array): void {
  const x = Math.min(1, Math.max(0, t)) * (curve.length - 1)
  const i = Math.min(curve.length - 2, Math.floor(x))
  const a = curve[i]!
  const b = curve[i + 1]!
  out[0] = a[0] + (b[0] - a[0]) * (x - i)
  out[1] = a[1] + (b[1] - a[1]) * (x - i)
}

/** Seconds a rest's get-up runs: its clip's, else the default. Set by the sim when clips load. */
export const getUpDurations = new WeakMap<RagdollRest, number>()
const DEFAULT_GET_UP = 1.5

const at = new Float64Array(2)

/**
 * The reactions' clock (authoritative side: a server, or a game without net): stagger decays;
 * partial ends after `recover`; down rests after `downTime`; with drive auto, a rested root gets
 * up after `restTime` along its get-up's travel and stands. Update.
 */
export const reactionsSystem = defineSystem({
  name: 'ragdoll/reactions',
  description:
    'Decays stagger and moves reactions on: partial to none, down to rested, rested to getting-up (drive auto) along the get-up’s travel, and getting-up to none.',
  setup: (world) => ({ roots: world.query({ with: [Ragdoll, Reaction] }) }),
  run: ({ roots }, world) => {
    if (mirrorsReactions(world)) return
    const now = world.resource(Time).elapsed
    const store = world.tryResource(RagdollAssets)
    if (!store) return
    for (let t = 0; t < roots.tables.length; t++) {
      const table = roots.tables[t]!
      const states = table.column(Reaction, 'state')
      const stagger = table.column(Reaction, 'stagger')
      for (let row = 0; row < table.count; row++) {
        const state = states[row]!
        if (state === NONE && stagger[row]! <= 0) continue
        const root = table.entities[row]!
        const r = world.get(root, Reaction)
        const asset = store.get(world.get(root, Ragdoll).asset!)
        if (!asset) continue
        const tr = track(world, root)
        decay(world, root, asset, tr, now)
        const age = now - r.since
        const drive = world.get(root, Ragdoll).drive
        if (state === PARTIAL && age >= asset.reactions.recover) {
          world.set(root, Reaction, { ...world.get(root, Reaction), state: 'none', since: now })
        } else if (state === DOWN && tr.sliding && age < asset.reactions.downTime) {
          const lead = 0.12
          slideStep(world, root, tr, (age - lead) / Math.max(asset.reactions.downTime - lead, 1e-3))
        } else if (state === DOWN && age >= asset.reactions.downTime) {
          if (tr.sliding) slideStep(world, root, tr, 1)
          world.set(root, Reaction, { ...world.get(root, Reaction), state: 'rested', since: now })
          world.send(Rested, { entity: root, rest: asset.rests[r.rest]?.name ?? '' })
        } else if (state === RESTED && drive === 'auto' && age >= asset.reactions.restTime) {
          const rest = asset.rests[r.rest]
          world.set(root, Reaction, {
            ...world.get(root, Reaction),
            state: 'getting-up',
            since: now,
          })
          tr.travel = rest?.travel
          tr.travelFor = rest
            ? (getUpDurations.get(rest) ?? rest.duration ?? DEFAULT_GET_UP)
            : DEFAULT_GET_UP
          tr.travelFrom = now
          const tf = world.get(root, Transform)
          tr.travelStart[0] = tf.translation[0]
          tr.travelStart[1] = tf.translation[1]
          tr.travelStart[2] = tf.translation[2]
          const q = tf.rotation
          tr.travelYaw = Math.atan2(
            2 * (q[3] * q[1] + q[0] * q[2]),
            1 - 2 * (q[1] * q[1] + q[0] * q[0]),
          )
        } else if (state === GETTING_UP) {
          const k = (now - tr.travelFrom) / Math.max(tr.travelFor, 1e-3)
          if (tr.travel) {
            travelAt(tr.travel, k, at)
            const c = Math.cos(tr.travelYaw)
            const s = Math.sin(tr.travelYaw)
            const tf = world.get(root, Transform)
            world.set(root, Transform, {
              ...tf,
              translation: [
                tr.travelStart[0]! + at[0]! * c + at[1]! * s,
                tf.translation[1],
                tr.travelStart[2]! - at[0]! * s + at[1]! * c,
              ],
            })
          }
          if (k >= 1) finish(world, root, tr)
        }
      }
    }
  },
})

export { DEAD, DOWN, GETTING_UP, NONE, PARTIAL, RESTED }
