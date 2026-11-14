import {
  AnimationClips,
  type AnimationLayerValue,
  AnimationPlayer,
  animationLayer,
  ChainIk,
  createFlatPose,
  crossfade,
  type FlatPose,
  FootPlacement,
  LookAtIk,
  samplePose,
  TwoBoneIk,
} from '@aethervtt/shard-animation'
import { assetServer } from '@aethervtt/shard-assets'
import {
  CharacterPart,
  CharacterStates,
  CharacterTier,
  freezeCharacter,
} from '@aethervtt/shard-characters'
import {
  type AssetRef,
  ChildOf,
  Children,
  type ComponentDef,
  defineResource,
  defineSystem,
  type Entity,
  type World,
} from '@aethervtt/shard-core'
import {
  Collider,
  Joint,
  Mass,
  Physics,
  PhysicsDisabled,
  type PhysicsWorld,
  RigidBody,
} from '@aethervtt/shard-physics'
import { FixedTime, LogResource, Time } from '@aethervtt/shard-runtime'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import type { RagdollAsset, RagdollRest } from './asset'
import { RagdollAssets } from './asset'
import { bindRagdoll, capsuleHalfHeight, impulseShares, type RagdollBinding } from './binding'
import {
  CorpseEvicted,
  CorpseSettled,
  DEAD,
  DOWN,
  GETTING_UP,
  NONE,
  PARTIAL,
  Ragdoll,
  RagdollBody,
  RagdollBudget,
  REACTION_STATES,
  RESTED,
  Reaction,
} from './components'
import { setActiveSource, setFrozenSource } from './hit'
import {
  qangle,
  qlog,
  qmul,
  qmulByConj,
  qmulConj,
  qnormalize,
  qrotate,
  qrotateInv,
  qslerp,
  quatFromRows,
} from './math'
import { getUpDurations, landsLocally, rootVelocity } from './reactions'
import { type SkeletonView, skeletonOf } from './skeleton'

/** The collision layer ragdoll bodies are in (character capsules ignore it unless blocking). */
export const RAGDOLL_LAYER = 1 << 15

const MODE_PARTIAL = 0
const MODE_FULL = 1
/** Bodies given up, the snapshot held at full weight (a downed ragdoll evicted). */
const MODE_HELD = 2
/** From the snapshot back to the animation (the rest's lying pose). */
const MODE_REST = 3
const MODE_NAMES = ['partial', 'full', 'held', 'rest-blend'] as const

/** A pool of bodies for one binding. */
export interface Slot {
  binding: RagdollBinding
  bodies: Entity[]
  colliders: Entity[]
  ready: boolean
  user: Active | null
}

/** A root the simulation is showing. Internal. */
export interface Active {
  root: Entity
  view: SkeletonView
  binding: RagdollBinding
  asset: RagdollAsset
  slot: Slot | null
  mode: number
  start: number
  /** Physics waiting for its slot, rig and first step. */
  pending: boolean
  peak: Float32Array
  weight: Float32Array
  strength: Float32Array
  /** Animated model poses of the bodies' joints (t, r), captured after sampling. */
  targets: Float32Array
  /** Angular velocities of the animated poses (model space), from frame to frame. */
  targetVel: Float32Array
  /** Each body's reference velocity at the last step (world): what its drive followed. */
  refVel: Float32Array
  targetsSet: boolean
  snapshot: Float32Array
  animLocal: Float32Array
  wrote: Float32Array
  orig: Float32Array
  wroteMask: Uint8Array
  model: Float64Array
  anim: Float64Array
  anchored: Uint8Array
  hitBody: number
  /** The body a partial reaction centres on (reactingBody). */
  reactBody: number
  impulse: Float64Array
  point: Float64Array
  launch: boolean
  seq: number
  state: number
  lastHit: number
  /** IK components zeroed while full, and their weights. */
  ik: { entity: Entity; def: ComponentDef; weight: number }[]
  /** The root's capsule, disabled while blocking characters (its own bodies would hit it). */
  capsuleOff: boolean
  /** The root's velocity over the hit frame, for roots nothing else gives one (moved by Transform). */
  rootVel: Float64Array
}

interface Corpse {
  root: Entity
  /** Model-space joint rows (12 per joint), relative to the skeleton owner. */
  model: Float32Array
  at: number
}

interface ClipTrack {
  /** Layers saved when the reaction took over the animation (auto). */
  saved: AnimationLayerValue[] | null
  seq: number
  state: number
  deadAt: number
  deathClip: number
}

export interface RagdollSim {
  actives: Map<Entity, Active>
  slots: Map<RagdollBinding, Slot[]>
  corpses: Map<Entity, Corpse>
  clips: Map<Entity, ClipTrack>
  stats: {
    activated: number
    fallbacks: number
    driveMs: number
    blendMs: number
    evictions: number
  }
  warned: Set<string>
}

export const RagdollSimResource = defineResource<RagdollSim>('ragdoll/Sim', {
  description: 'Simulated ragdolls, body pools, corpses (0117). Internal.',
  init: () => ({
    actives: new Map(),
    slots: new Map(),
    corpses: new Map(),
    clips: new Map(),
    stats: { activated: 0, fallbacks: 0, driveMs: 0, blendMs: 0, evictions: 0 },
    warned: new Set(),
  }),
})

/** Clip names the asset uses, by name: registered by the game (synthetic clips, a library). */
export const RagdollClipNames = defineResource<Map<string, AssetRef<'AnimationClip'>>>(
  'ragdoll/ClipNames',
  { description: 'Clips by name for ragdoll roles and rests.', init: () => new Map() },
)

// --- helpers ---------------------------------------------------------------------------------

function warnOnce(world: World, sim: RagdollSim, key: string, code: string, message: string) {
  if (sim.warned.has(key)) return
  sim.warned.add(key)
  world.tryResource(LogResource)?.warn(code, message)
}

/** A clip by the asset's name for it: registered names, the character's rig, then asset paths. */
export function resolveClip(
  world: World,
  view: SkeletonView,
  name: string,
): AssetRef<'AnimationClip'> | undefined {
  const named = world.tryResource(RagdollClipNames)?.get(name)
  if (named) return named
  if (view.character) {
    const st = world.tryResource(CharacterStates)?.get(view.owner)
    const ref = st?.rig.options.clips?.[name]
    if (ref) return ref
  }
  try {
    return assetServer(world).resolve<'AnimationClip'>(name)
  } catch {
    return undefined
  }
}

/** World pose of an entity (t xyz, r xyzw, uniform scale) from its Transforms, fresh this frame. */
function worldOf(world: World, e: Entity, out: Float64Array): void {
  out[0] = out[1] = out[2] = 0
  out[3] = out[4] = out[5] = 0
  out[6] = 1
  out[7] = 1
  let depth = 0
  let cur: Entity | null = e
  for (; cur !== null && depth < 32; depth++) {
    chain[depth] = cur
    const table = world.entityTableUnchecked(cur)
    cur = table.has(ChildOf)
      ? (table.column(ChildOf, 'parent')[world.entityRowUnchecked(cur)]! as Entity)
      : null
  }
  for (let k = depth - 1; k >= 0; k--) {
    const c = chain[k]!
    const table = world.entityTableUnchecked(c)
    if (!table.has(Transform)) continue
    const row = world.entityRowUnchecked(c)
    compose(
      out,
      0,
      table.column(Transform, 'translation'),
      row * 3,
      table.column(Transform, 'rotation'),
      row * 4,
      table.column(Transform, 'scale')[row * 3]!,
    )
  }
}

const chain = new Int32Array(32) as unknown as Entity[]

const v3 = new Float64Array(3)

/** out[oo] (pos, rot, scale) ∘ local (t at to, r at ro, uniform s). */
function compose(
  out: Float64Array,
  oo: number,
  t: ArrayLike<number>,
  to: number,
  r: ArrayLike<number>,
  ro: number,
  s: number,
): void {
  const sc = out[oo + 7]!
  v3[0] = t[to]! * sc
  v3[1] = t[to + 1]! * sc
  v3[2] = t[to + 2]! * sc
  qrotate(v3, 0, out, oo + 3, v3, 0)
  out[oo] = out[oo]! + v3[0]!
  out[oo + 1] = out[oo + 1]! + v3[1]!
  out[oo + 2] = out[oo + 2]! + v3[2]!
  qmul(out, oo + 3, out, oo + 3, r, ro)
  qnormalize(out, oo + 3)
  out[oo + 7] = sc * s
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

const IK_DEFS = [TwoBoneIk, LookAtIk, ChainIk, FootPlacement] as ComponentDef[]

function zeroIk(world: World, a: Active): void {
  if (a.ik.length > 0) return
  const consider = (e: Entity) => {
    for (const def of IK_DEFS) {
      if (!world.has(e, def)) continue
      const v = world.get(e, def) as { weight: number }
      a.ik.push({ entity: e, def, weight: v.weight })
      world.set(e, def, { ...v, weight: 0 })
    }
  }
  consider(a.view.owner)
  const kids = world.tryGet(a.view.owner, Children)?.entities ?? []
  for (const k of kids)
    if (k !== null && world.isAlive(k) && !world.has(k, CharacterPart)) consider(k)
}

function restoreIk(world: World, a: Active): void {
  for (const { entity, def, weight } of a.ik) {
    if (world.isAlive(entity) && world.has(entity, def)) {
      world.set(entity, def, { ...(world.get(entity, def) as object), weight })
    }
  }
  a.ik.length = 0
}

function setClaim(world: World, owner: Entity, on: boolean): void {
  if (!world.has(owner, CharacterTier)) return
  const table = world.entityTableUnchecked(owner)
  const row = world.entityRowUnchecked(owner)
  const col = table.column(CharacterTier, 'claim')
  if ((col[row] !== 0) === on) return
  col[row] = on ? 1 : 0
  table.markChanged(CharacterTier, row)
}

// --- pool ------------------------------------------------------------------------------------

/** Spawns a slot's bodies, set aside (PhysicsDisabled): Rapier makes them at the next step. */
export function makeSlot(world: World, b: RagdollBinding, solverIterations = 12): Slot {
  const bodies: Entity[] = []
  const colliders: Entity[] = []
  const far: [number, number, number] = [0, -10000, 0]
  for (let i = 0; i < b.count; i++) {
    const body = world.spawn(
      [Transform, { translation: far }],
      [RigidBody, { kind: 'dynamic', angularDamping: 0.6, linearDamping: 0.05, solverIterations }],
      [Mass, { mass: b.mass[i]! }],
      [RagdollBody, { root: null, body: i }],
    )
    world.add(body, PhysicsDisabled)
    bodies.push(body)
    const shape = b.asset.bodies[i]!.shape
    const cp = b.colliderPose
    const collider =
      shape.kind === 'capsule'
        ? {
            shape: 'capsule' as const,
            radius: shape.radius,
            halfHeight: Math.max(0.001, capsuleHalfHeight(shape)),
          }
        : shape.kind === 'box'
          ? { shape: 'cuboid' as const, halfExtents: shape.half }
          : { shape: 'ball' as const, radius: shape.radius }
    colliders.push(
      world.spawn(
        [
          Transform,
          {
            translation: [cp[i * 7]!, cp[i * 7 + 1]!, cp[i * 7 + 2]!],
            rotation: [cp[i * 7 + 3]!, cp[i * 7 + 4]!, cp[i * 7 + 5]!, cp[i * 7 + 6]!],
          },
        ],
        [Collider, { ...collider, friction: 0.8, layers: RAGDOLL_LAYER, mask: 0xffff }],
        [ChildOf, { parent: body }],
      ),
    )
  }
  for (let i = 0; i < b.count; i++) {
    const p = b.parent[i]!
    if (p < 0) continue
    const l = b.limits
    world.add(bodies[i]!, Joint, {
      kind: b.hinge[i] ? 'hinge' : 'spherical',
      other: bodies[p]!,
      anchor: [0, 0, 0],
      otherAnchor: [b.anchor[i * 3]!, b.anchor[i * 3 + 1]!, b.anchor[i * 3 + 2]!],
      frame: [b.frame[i * 4]!, b.frame[i * 4 + 1]!, b.frame[i * 4 + 2]!, b.frame[i * 4 + 3]!],
      otherFrame: [
        b.otherFrame[i * 4]!,
        b.otherFrame[i * 4 + 1]!,
        b.otherFrame[i * 4 + 2]!,
        b.otherFrame[i * 4 + 3]!,
      ],
      twist: [l[i * 6]!, l[i * 6 + 1]!],
      swingY: [l[i * 6 + 2]!, l[i * 6 + 3]!],
      swingZ: [l[i * 6 + 4]!, l[i * 6 + 5]!],
      contacts: false,
    })
  }
  return { binding: b, bodies, colliders, ready: false, user: null }
}

function slotReady(p: PhysicsWorld, s: Slot): boolean {
  if (s.ready) return true
  for (let i = 0; i < s.bodies.length; i++) {
    const e = s.bodies[i]!
    if (!p.bodies.has(e)) return false
    if (s.binding.parent[i]! >= 0 && !p.joints.has(e)) return false
  }
  s.ready = true
  return true
}

function freeSlot(world: World, sim: RagdollSim, b: RagdollBinding): Slot {
  let list = sim.slots.get(b)
  if (!list) {
    list = []
    sim.slots.set(b, list)
  }
  for (const s of list) if (s.user === null) return s
  const s = makeSlot(world, b, world.resource(RagdollBudget).solverIterations)
  list.push(s)
  return s
}

function activeSlots(sim: RagdollSim): number {
  let n = 0
  for (const a of sim.actives.values()) if (a.slot) n++
  return n
}

/** Sets the slot's bodies aside again and frees it. */
function releaseSlot(world: World, a: Active): void {
  const s = a.slot
  if (!s) return
  for (let i = 0; i < s.bodies.length; i++) {
    const e = s.bodies[i]!
    if (!world.isAlive(e)) continue
    if (!world.has(e, PhysicsDisabled)) world.add(e, PhysicsDisabled)
    world.set(e, RagdollBody, { root: null, body: i })
  }
  s.user = null
  a.slot = null
  if (a.capsuleOff) {
    world.tryResource(Physics)?.colliders.get(a.root)?.setEnabled(true)
    a.capsuleOff = false
  }
}

// --- starting --------------------------------------------------------------------------------

function newActive(world: World, root: Entity, view: SkeletonView, asset: RagdollAsset): Active {
  const binding = bindRagdoll(asset, view.skeleton, view.rest)
  const n = binding.count
  const j = view.skeleton.paths.length
  return {
    root,
    view,
    binding,
    asset,
    slot: null,
    mode: MODE_PARTIAL,
    start: world.resource(Time).elapsed,
    pending: false,
    peak: new Float32Array(n),
    weight: new Float32Array(n),
    strength: new Float32Array(n).fill(1),
    targets: new Float32Array(n * 7),
    targetVel: new Float32Array(n * 3),
    refVel: new Float32Array(n * 3),
    targetsSet: false,
    snapshot: new Float32Array(n * 7),
    animLocal: new Float32Array(j * 10),
    wrote: new Float32Array(j * 7),
    orig: new Float32Array(j * 7),
    wroteMask: new Uint8Array(j),
    model: new Float64Array(j * 8),
    anim: new Float64Array(j * 8),
    anchored: new Uint8Array(n),
    hitBody: 0,
    reactBody: 0,
    impulse: new Float64Array(3),
    point: new Float64Array(3),
    launch: false,
    seq: -1,
    state: NONE,
    lastHit: 0,
    ik: [],
    capsuleOff: false,
    rootVel: new Float64Array(3),
  }
}

/** The screen size a root's character had at its last selection (1 for plain models). */
function screenOf(world: World, view: SkeletonView): number {
  return view.character ? (world.tryGet(view.owner, CharacterTier)?.screen ?? 0) : 1
}

/** Whether the reaction gets physics: a slot (evicting the lowest-ranked) and enough screen. */
function wantPhysics(world: World, sim: RagdollSim, view: SkeletonView, full: boolean): boolean {
  const budget = world.resource(RagdollBudget)
  if (!world.tryResource(Physics)) return false
  const screen = screenOf(world, view)
  if (screen < budget.promoteScreen) return false
  if (activeSlots(sim) < budget.maxActive) return true
  // Evict the lowest-ranked one with a slot, when this one ranks above it.
  let worst: Active | undefined
  let worstScore = Number.POSITIVE_INFINITY
  for (const a of sim.actives.values()) {
    if (!a.slot) continue
    const s = screenOf(world, a.view) * (1 + a.lastHit * 1e-6)
    if (s < worstScore) {
      worstScore = s
      worst = a
    }
  }
  if (!worst || (worstScore >= screen && !full)) return false
  evict(world, sim, worst)
  return true
}

function evict(world: World, sim: RagdollSim, a: Active): void {
  sim.stats.evictions++
  const now = world.resource(Time).elapsed
  if (a.mode === MODE_PARTIAL) {
    // Blends out over 0.15 s with no physics: the snapshot is what shows now.
    captureSnapshot(world, a)
    releaseSlot(world, a)
    a.mode = MODE_REST
    a.start = now - world.resource(RagdollBudget).restBlend + 0.15
    return
  }
  if (a.state === DEAD) {
    freeze(world, sim, a)
    return
  }
  captureSnapshot(world, a)
  releaseSlot(world, a)
  a.mode = MODE_HELD
}

/** Starts or upgrades physics for a reaction. */
function engage(world: World, sim: RagdollSim, a: Active, full: boolean): void {
  const now = world.resource(Time).elapsed
  if (full) {
    if (a.mode !== MODE_FULL || !a.slot) a.start = now
    a.mode = a.slot || a.pending ? MODE_FULL : MODE_FULL
    zeroIk(world, a)
  } else if (a.mode !== MODE_FULL) {
    a.mode = MODE_PARTIAL
    a.start = now
  }
  if (a.slot) {
    if (!a.pending) applyHit(world, a, full)
    return
  }
  a.slot = freeSlot(world, sim, a.binding)
  a.slot.user = a
  a.pending = true
  sim.stats.activated++
  if (a.view.character) setClaim(world, a.view.owner, true)
}

// --- the react system (PostUpdate, before sampling) ----------------------------------------

/**
 * Starts what a Reaction asks for (0117): physics (a slot, a claim on the near tier), role clips
 * and rests (drive auto), the rest blend, and corpses. Runs on clients and single-player.
 */
export const reactSystem = defineSystem({
  name: 'ragdoll/react',
  description:
    'Turns Reaction changes into physics (claims, slots), role, rest and get-up clips (drive auto), rest blends and corpses.',
  setup: (world) => ({ roots: world.query({ with: [Ragdoll, Reaction] }) }),
  run: ({ roots }, world, ctx) => {
    const sim = world.resource(RagdollSimResource)
    const store = world.tryResource(RagdollAssets)
    if (!store) return
    const now = world.resource(Time).elapsed
    for (let t = 0; t < roots.tables.length; t++) {
      const table = roots.tables[t]!
      if (table.lastChanged(Reaction) <= ctx.lastRunTick) continue
      const ticks = table.changedTicks(Reaction)
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! <= ctx.lastRunTick) continue
        const root = table.entities[row]!
        const asset = store.get(world.get(root, Ragdoll).asset!)
        if (!asset) continue
        onReaction(world, sim, root, asset, now)
      }
    }
    // Clip-only deaths freeze when their clip ends.
    for (const [root, ct] of sim.clips) {
      if (ct.deadAt < 0 || sim.actives.has(root)) continue
      if (!world.isAlive(root)) {
        sim.clips.delete(root)
        continue
      }
      const budget = world.resource(RagdollBudget)
      if (
        now - ct.deadAt >=
        Math.min(budget.corpseAfter, ct.deathClip > 0 ? ct.deathClip : budget.corpseAfter)
      ) {
        ct.deadAt = -1
        freezeFromClip(world, sim, root)
      }
    }
  },
})

function clipTrack(sim: RagdollSim, root: Entity): ClipTrack {
  let c = sim.clips.get(root)
  if (!c) {
    c = { saved: null, seq: -1, state: NONE, deadAt: -1, deathClip: 0 }
    sim.clips.set(root, c)
  }
  return c
}

function onReaction(world: World, sim: RagdollSim, root: Entity, asset: RagdollAsset, now: number) {
  const r = world.get(root, Reaction)
  const state = REACTION_STATES.indexOf(r.state)
  const ct = clipTrack(sim, root)
  const newHit = r.seq !== ct.seq
  const changed = state !== ct.state
  const prevState = ct.state
  ct.seq = r.seq
  ct.state = state
  if (!newHit && !changed) return
  const view = skeletonOf(world, root)
  if (!view) {
    warnOnce(
      world,
      sim,
      `skel:${root}`,
      'ragdoll/no-skeleton',
      `Ragdoll root ${root} has nothing skinned to drive`,
    )
    return
  }
  const auto = world.get(root, Ragdoll).drive === 'auto'
  let a = sim.actives.get(root)
  if (newHit && (state === PARTIAL || state === DOWN || state === DEAD)) {
    const full = state !== PARTIAL
    if (!a && sim.corpses.has(root)) return // a corpse takes no more hits
    const physics =
      a?.slot !== null && a?.slot !== undefined ? true : wantPhysics(world, sim, view, full)
    if (physics) {
      if (!a) {
        a = newActive(world, root, view, asset)
        sim.actives.set(root, a)
      }
      a.hitBody = r.bone
      a.impulse[0] = r.impulse[0]
      a.impulse[1] = r.impulse[1]
      a.impulse[2] = r.impulse[2]
      a.launch = r.launch
      a.lastHit = now
      a.state = state
      const def = asset.bodies[r.bone]
      if (def) {
        // The hit point: the hit body's joint (the exact point isn't replicated).
        a.point.fill(Number.NaN)
      }
      if (a.slot === null) measureRootVelocity(world, a)
      engage(world, sim, a, full)
    } else sim.stats.fallbacks++
    // Role clips: with drive auto, on top of the physics (or alone without it).
    if (auto && r.role !== 255) playRole(world, view, asset, r.role, ct)
    if (state === DEAD && !physics) {
      ct.deadAt = now
      const role = asset.roles.get(asset.roleNames[r.role] ?? '')
      const ref = role ? resolveClip(world, view, role.clips[0]!) : undefined
      ct.deathClip = ref ? (world.resource(AnimationClips).get(ref)?.duration ?? 0) : 0
    }
  }
  if (!changed) return
  if (a) a.state = state
  if (state === RESTED) {
    const rest = asset.rests[r.rest]
    if (auto && rest) {
      saveLayers(world, view, ct)
      const ref = resolveClip(world, view, rest.pose)
      if (ref) crossfade(world, view.owner, ref, 0, { loop: 'loop' })
      else
        warnOnce(
          world,
          sim,
          `clip:${rest.pose}`,
          'ragdoll/missing-clip',
          `No clip "${rest.pose}" for rest ${rest.name}`,
        )
      noteGetUp(world, view, rest)
    }
    if (a && (a.mode === MODE_FULL || a.mode === MODE_HELD)) {
      if (a.slot) {
        captureSnapshot(world, a)
        // Simulated here alone: the root lies down where the body did, facing as it fell.
        if (landsLocally(world)) landRoot(world, a, rest)
      }
      releaseSlot(world, a)
      a.mode = MODE_REST
      a.start = now
    }
  } else if (state === GETTING_UP && auto) {
    const rest = asset.rests[r.rest]
    const ref = rest ? resolveClip(world, view, rest.getUp) : undefined
    if (ref) crossfade(world, view.owner, ref, 0.1, { loop: 'once' })
    else if (rest)
      warnOnce(
        world,
        sim,
        `clip:${rest.getUp}`,
        'ragdoll/missing-clip',
        `No clip "${rest.getUp}" for rest ${rest.name}`,
      )
  } else if (
    state === NONE &&
    (prevState === GETTING_UP || prevState === RESTED || prevState === DOWN)
  ) {
    if (auto) restoreLayers(world, view, ct)
    if (a && a.mode === MODE_HELD) {
      a.mode = MODE_REST
      a.start = now
    }
  } else if (state === DEAD && a) {
    a.state = DEAD
  }
}

/** Plays a role's clip (drive auto): additive as a once layer on top, override as a crossfade. */
function playRole(
  world: World,
  view: SkeletonView,
  asset: RagdollAsset,
  role: number,
  ct: ClipTrack,
) {
  const r = asset.roles.get(asset.roleNames[role] ?? '')
  if (!r || !world.has(view.owner, AnimationPlayer)) return
  const name = r.clips[(ct.seq >>> 0) % r.clips.length]!
  const ref = resolveClip(world, view, name)
  if (!ref) return
  if (r.blend === 'additive') {
    const player = world.get(view.owner, AnimationPlayer)
    const layers = player.layers.filter(
      (l) =>
        !(
          l.blend === 'additive' &&
          l.loop === 'once' &&
          l.time >= (world.resource(AnimationClips).get(l.clip!)?.duration ?? 0)
        ),
    )
    layers.push(animationLayer(ref, { blend: 'additive', loop: 'once' }))
    world.set(view.owner, AnimationPlayer, { ...player, layers })
  } else {
    saveLayers(world, view, ct)
    crossfade(world, view.owner, ref, 0.1, { loop: 'once' })
  }
}

function saveLayers(world: World, view: SkeletonView, ct: ClipTrack): void {
  if (ct.saved || !world.has(view.owner, AnimationPlayer)) return
  ct.saved = world.get(view.owner, AnimationPlayer).layers.map((l) => ({ ...l }))
}

/** Back to the layers playing before the reaction took over, faded in over 0.25 s. */
function restoreLayers(world: World, view: SkeletonView, ct: ClipTrack): void {
  const saved = ct.saved
  ct.saved = null
  if (!saved || !world.has(view.owner, AnimationPlayer)) return
  const player = world.get(view.owner, AnimationPlayer)
  const layers = player.layers.map((l) => ({
    ...l,
    fadeTo: 0,
    fadeSpeed: Math.max(l.weight, 1e-6) / 0.25,
  }))
  for (const l of saved) {
    if (l.fadeTo === 0 && l.fadeSpeed > 0) continue
    layers.push({ ...l, weight: 0, fadeTo: l.weight > 0 ? l.weight : 1, fadeSpeed: 1 / 0.25 })
  }
  world.set(view.owner, AnimationPlayer, { ...player, layers })
}

function noteGetUp(world: World, view: SkeletonView, rest: RagdollRest): void {
  if (getUpDurations.has(rest)) return
  const ref = resolveClip(world, view, rest.getUp)
  const clip = ref ? world.resource(AnimationClips).get(ref) : undefined
  if (clip) getUpDurations.set(rest, clip.duration)
}

// --- activation and drives (FixedUpdate, before physics) -------------------------------------

const _pose8 = new Float64Array(8)
const prevOwner = new Float64Array(8)
const q = new Float64Array(4)
const q2 = new Float64Array(4)
const w3 = new Float64Array(3)
const w3b = new Float64Array(3)
const rv = new Float64Array(3)
let scratchRows = new Float32Array(12 * 64)
const plainPoses = new WeakMap<object, FlatPose>()

function flatPoseFor(world: World, a: Active): FlatPose | undefined {
  if (a.view.character) return world.tryResource(CharacterStates)?.get(a.view.owner)?.pose
  let pose = plainPoses.get(a.view.skeleton)
  if (!pose) {
    pose = createFlatPose(a.view.skeleton, a.view.rest)
    plainPoses.set(a.view.skeleton, pose)
  }
  return pose
}

/** Places the bodies at the drawn pose, moving as the animation was, and applies the hit. */
function activate(world: World, p: PhysicsWorld, a: Active, dt: number): void {
  const s = a.slot!
  const b = a.binding
  const joints = a.view.joints!
  const n = b.count
  const budget = world.resource(RagdollBudget)
  // The pose one step earlier, from the clips, for the bodies' velocities.
  const prev = new Float64Array(n * 7)
  let havePrev = false
  const pose = flatPoseFor(world, a)
  rootVelocity(world, a.root, rv)
  if (rv[0] === 0 && rv[1] === 0 && rv[2] === 0) rv.set(a.rootVel)
  if (pose && world.has(a.view.owner, AnimationPlayer)) {
    const layers = world.get(a.view.owner, AnimationPlayer).layers
    const jc = a.view.skeleton.paths.length
    if (scratchRows.length < jc * 12) scratchRows = new Float32Array(jc * 12)
    for (const l of layers) l.time -= dt * l.speed
    try {
      samplePose(world, a.view.owner, pose, scratchRows, 0)
      havePrev = true
    } catch {
      havePrev = false
    } finally {
      for (const l of layers) l.time += dt * l.speed
    }
    if (havePrev) {
      // The joints' drawn pose is last frame's (their GlobalTransforms): one step before it, the
      // owner stood where its GlobalTransform says, less a step of the root's motion.
      const og = world.get(a.view.owner, GlobalTransform).matrix
      prevOwner[0] = og[3]!
      prevOwner[1] = og[7]!
      prevOwner[2] = og[11]!
      prevOwner[7] = quatFromRows(prevOwner, 3, og, 0)
      prevOwner[0] = prevOwner[0]! - rv[0]! * dt
      prevOwner[1] = prevOwner[1]! - rv[1]! * dt
      prevOwner[2] = prevOwner[2]! - rv[2]! * dt
      for (let i = 0; i < n; i++) {
        const m = b.joint[i]! * 12
        const o = i * 7
        w3[0] = pose.model[m + 3]! * prevOwner[7]!
        w3[1] = pose.model[m + 7]! * prevOwner[7]!
        w3[2] = pose.model[m + 11]! * prevOwner[7]!
        qrotate(prev, o, prevOwner, 3, w3, 0)
        prev[o] = prev[o]! + prevOwner[0]!
        prev[o + 1] = prev[o + 1]! + prevOwner[1]!
        prev[o + 2] = prev[o + 2]! + prevOwner[2]!
        quatFromRows(q, 0, pose.model, m)
        qmul(prev, o + 3, prevOwner, 3, q, 0)
      }
    }
  }
  const partial = a.mode === MODE_PARTIAL
  // Anchored in a partial reaction: the root and the legs, a hit leg included. A simulated leg
  // under a walking body swings against the walk; the torso takes a leg hit instead.
  for (let i = 0; i < n; i++) a.anchored[i] = partial && b.anchored[i] ? 1 : 0
  a.reactBody = reactingBody(a)
  if (budget.blockCharacters) {
    const c = p.colliders.get(a.root)
    if (c) {
      c.setEnabled(false)
      a.capsuleOff = true
    }
  }
  for (let i = 0; i < n; i++) {
    const e = s.bodies[i]!
    const g = world.get(joints[b.joint[i]!]!, GlobalTransform).matrix
    quatFromRows(q, 0, g, 0)
    world.set(e, Transform, {
      translation: [g[3]!, g[7]!, g[11]!],
      rotation: [q[0]!, q[1]!, q[2]!, q[3]!],
      scale: [1, 1, 1],
    })
    world.set(e, RagdollBody, { root: a.root, body: i })
    p.setKind(e, a.anchored[i] ? 'kinematic-position' : 'dynamic')
    world.remove(e, PhysicsDisabled)
    const rec = p.bodies.get(e)
    if (!rec) continue
    // Driven bodies carry no weight: under a weakened drive, gravity sagged a hit head forward
    // as the hit faded (a nod back and forth). A full ragdoll falls.
    rec.body.setGravityScale(partial ? 0 : 1, true)
    if (a.anchored[i]) continue
    // Velocity: the animation's motion over the last step, plus the root's.
    if (havePrev) {
      const o = i * 7
      w3[0] = (g[3]! - prev[o]!) / dt
      w3[1] = (g[7]! - prev[o + 1]!) / dt
      w3[2] = (g[11]! - prev[o + 2]!) / dt
      qmulByConj(q2, 0, q, 0, prev, o + 3)
      qlog(w3b, 0, q2, 0)
      w3b[0] = w3b[0]! / dt
      w3b[1] = w3b[1]! / dt
      w3b[2] = w3b[2]! / dt
    } else {
      w3[0] = rv[0]!
      w3[1] = rv[1]!
      w3[2] = rv[2]!
      w3b[0] = w3b[1] = w3b[2] = 0
    }
    if (a.launch) {
      const k = launchShare(world, a, g[7]!)
      w3[0] = w3[0]! + a.impulse[0]! * k
      w3[1] = w3[1]! + a.impulse[1]!
      w3[2] = w3[2]! + a.impulse[2]! * k
    }
    rec.body.setLinvel(p.vec(w3[0]!, w3[1]!, w3[2]!), true)
    rec.body.setAngvel(p.vec(w3b[0]!, w3b[1]!, w3b[2]!), true)
    // The drive's reference starts at the animation's turn: only the hit departs from it.
    a.refVel[i * 3] = w3b[0]!
    a.refVel[i * 3 + 1] = w3b[1]!
    a.refVel[i * 3 + 2] = w3b[2]!
  }
  a.pending = false
  setWeights(a)
  if (!a.launch) applyImpulse(world, p, a)
}

/**
 * A launch's horizontal share at a body's height: full at the feet, 45% at the head, as a bumper
 * takes the legs and the body pitches over it. A launch that moved every body alike flew as a plank.
 */
function launchShare(world: World, a: Active, y: number): number {
  const g = world.get(a.root, GlobalTransform).matrix
  const h = (y - g[7]!) / 1.7
  return 1 - 0.55 * Math.min(1, Math.max(0, h))
}

/**
 * The body a partial reaction centres on: the hit body, or for a hit on an anchored body (a leg,
 * the pelvis) the root body's first moving child, so the torso flinches above it.
 */
function reactingBody(a: Active): number {
  const b = a.binding
  if (!a.anchored[a.hitBody]) return a.hitBody
  for (let k = 0; k < b.count; k++) {
    const i = b.order[k]!
    if (b.parent[i] === b.root && !a.anchored[i]) return i
  }
  return a.hitBody
}

const now8 = new Float64Array(8)

/**
 * The root's velocity over this frame: where its Transforms put it now against last frame's
 * GlobalTransform. Runs before propagation (PostUpdate, before sampling), so the two differ by
 * this frame's move. A root walking by Transform otherwise starts its ragdoll at rest and the body
 * is left behind, leaning back and catching up.
 */
function measureRootVelocity(world: World, a: Active): void {
  const dt = world.resource(Time).delta
  a.rootVel.fill(0)
  if (!(dt > 0) || !world.has(a.root, GlobalTransform)) return
  worldOf(world, a.root, now8)
  const g = world.get(a.root, GlobalTransform).matrix
  a.rootVel[0] = (now8[0]! - g[3]!) / dt
  a.rootVel[1] = (now8[1]! - g[7]!) / dt
  a.rootVel[2] = (now8[2]! - g[11]!) / dt
  // A teleport isn't a velocity.
  if (Math.hypot(a.rootVel[0]!, a.rootVel[1]!, a.rootVel[2]!) > 15) a.rootVel.fill(0)
}

/** Partial peaks by graph distance from the reacting body (anchored bodies show none). */
function setWeights(a: Active): void {
  const b = a.binding
  const n = b.count
  const falloff = a.asset.reactions.falloff
  for (let i = 0; i < n; i++) {
    if (a.mode !== MODE_PARTIAL) {
      a.peak[i] = 1
      continue
    }
    if (a.anchored[i]) {
      a.peak[i] = 0
      continue
    }
    const d = b.distance[a.reactBody * n + i]!
    const w = Math.min(a.asset.bodies[i]!.maxWeight, falloff ** d)
    a.peak[i] = Math.max(a.peak[i]!, w)
  }
}

const shares = new Float32Array(64)

/** The hit's impulse, spread over the moving bodies by mass × falloff (impulseShares). */
function applyImpulse(world: World, p: PhysicsWorld, a: Active): void {
  const s = a.slot
  if (!s) return
  const b = a.binding
  const anchored = a.anchored
  impulseShares(b, a.reactBody, a.asset.reactions.falloff, shares, (i) => !anchored[i])
  for (let i = 0; i < b.count; i++) {
    const k = shares[i]!
    if (k <= 0) continue
    const rec = p.bodies.get(s.bodies[i]!)
    if (!rec) continue
    rec.body.applyImpulse(p.vec(a.impulse[0]! * k, a.impulse[1]! * k, a.impulse[2]! * k), true)
  }
  void world
}

/** A new hit on a ragdoll already moving: its impulse, and (partial) fresh weights. */
function applyHit(world: World, a: Active, full: boolean): void {
  const p = world.tryResource(Physics)
  if (!p || !a.slot) return
  if (full && a.mode === MODE_FULL) {
    // Upgrade: every body dynamic, nothing anchored, and falling.
    for (let i = 0; i < a.binding.count; i++) {
      if (a.anchored[i]) p.setKind(a.slot.bodies[i]!, 'dynamic')
      a.anchored[i] = 0
      p.bodies.get(a.slot.bodies[i]!)?.body.setGravityScale(1, true)
    }
    if (a.launch) {
      for (const e of a.slot.bodies) {
        const rec = p.bodies.get(e)
        const v = rec?.body.linvel()
        if (!rec || !v) continue
        const k = launchShare(world, a, rec.body.translation().y)
        rec.body.setLinvel(
          p.vec(v.x + a.impulse[0]! * k, v.y + a.impulse[1]!, v.z + a.impulse[2]! * k),
          true,
        )
      }
      return
    }
  } else {
    a.reactBody = reactingBody(a)
    setWeights(a)
  }
  applyImpulse(world, p, a)
}

const tgt = new Float64Array(4)
const ff = new Float64Array(3)
const cur = new Float64Array(4)
const par = new Float64Array(4)
const des = new Float64Array(4)
const err = new Float64Array(4)
const owner8 = new Float64Array(8)

function readRot(
  rec: { body: { rotation(): { x: number; y: number; z: number; w: number } } },
  out: Float64Array,
) {
  const r = rec.body.rotation()
  out[0] = r.x
  out[1] = r.y
  out[2] = r.z
  out[3] = r.w
}

/**
 * Activates pending ragdolls and drives the moving ones (0117): partial bodies are turned toward
 * the animated pose at their (lowered) strength, anchored ones follow it kinematically, and a
 * falling one is steered toward its rest. FixedUpdate, before the physics step.
 */
export const driveSystem = defineSystem({
  name: 'ragdoll/drive',
  description:
    'Places activated ragdolls at the drawn pose with its motion and the hit, drives partial bodies toward the animation, moves anchored ones, and steers falls toward their rest.',
  run: (_, world) => {
    const sim = world.tryResource(RagdollSimResource)
    const p = world.tryResource(Physics)
    if (!sim || !p || sim.actives.size === 0) return
    const t0 = performance.now()
    const dt = world.resource(FixedTime).step
    for (const a of sim.actives.values()) {
      if (dropIfDead(world, sim, a)) continue
      const s = a.slot
      if (!s) continue
      if (a.pending) {
        if (!slotReady(p, s)) continue
        const joints = a.view.character ? refreshJoints(world, a) : a.view.joints
        if (!joints) continue
        activate(world, p, a, dt)
        continue
      }
      worldOf(world, a.view.owner, owner8)
      const b = a.binding
      const profile =
        a.asset.profiles.get(world.tryGet(a.root, Ragdoll)?.profile ?? 'default') ??
        a.asset.profiles.get('default')!
      for (let k = 0; k < b.count; k++) {
        const i = b.order[k]!
        const rec = p.bodies.get(s.bodies[i]!)
        if (!rec) continue
        const o = i * 7
        // The animated world pose of the body's joint.
        qmul(tgt, 0, owner8, 3, a.targets, o + 3)
        if (a.anchored[i]) {
          w3[0] = a.targets[o]! * owner8[7]!
          w3[1] = a.targets[o + 1]! * owner8[7]!
          w3[2] = a.targets[o + 2]! * owner8[7]!
          qrotate(w3, 0, owner8, 3, w3, 0)
          rec.body.setNextKinematicTranslation(
            p.vec(w3[0]! + owner8[0]!, w3[1]! + owner8[1]!, w3[2]! + owner8[2]!),
          )
          rec.body.setNextKinematicRotation({ x: tgt[0]!, y: tgt[1]!, z: tgt[2]!, w: tgt[3]! })
          continue
        }
        if (a.mode === MODE_FULL) {
          if (i === b.root && a.state === DOWN) steer(world, a, rec, profile.stiffness)
          continue
        }
        const strength = profile.stiffness * a.strength[i]!
        if (strength <= 0) continue
        readRot(rec, cur)
        const pi = b.parent[i]!
        if (pi >= 0) {
          const prec = p.bodies.get(s.bodies[pi]!)
          if (!prec) continue
          readRot(prec, par)
          // Joint drive: parent now × the animated relative turn.
          qmul(des, 0, owner8, 3, a.targets, pi * 7 + 3)
          qmulConj(q, 0, des, 0, tgt, 0)
          qmul(des, 0, par, 0, q, 0)
          if (profile.world > 0) qslerp(des, 0, des, 0, tgt, 0, profile.world)
          // The reference: the parent as it turns, plus the animation's own turn against it.
          const pw = prec.body.angvel()
          ff[0] = a.targetVel[i * 3]! - a.targetVel[pi * 3]!
          ff[1] = a.targetVel[i * 3 + 1]! - a.targetVel[pi * 3 + 1]!
          ff[2] = a.targetVel[i * 3 + 2]! - a.targetVel[pi * 3 + 2]!
          qrotate(ff, 0, owner8, 3, ff, 0)
          w3b[0] = pw.x + ff[0]!
          w3b[1] = pw.y + ff[1]!
          w3b[2] = pw.z + ff[2]!
        } else {
          des.set(tgt)
          qrotate(w3b, 0, owner8, 3, a.targetVel, i * 3)
        }
        qmulByConj(err, 0, des, 0, cur, 0)
        qlog(w3, 0, err, 0)
        const av = rec.body.angvel()
        // A step's share of settling, weakened by the hit like the stiffness.
        // Settling at 4 × stiffness × ratio²: a ratio of 1 is critical, no overshoot.
        const settle = 4 * strength * profile.damping * profile.damping
        const k2 = 1 - Math.exp(-settle * dt)
        // Fed forward: the body turns with its reference in full, and only its own deviation
        // from it (a hit's) settles slowly, so a weakened drive still follows the walk.
        const r0 = i * 3
        const ex = av.x - a.refVel[r0]!
        const ey = av.y - a.refVel[r0 + 1]!
        const ez = av.z - a.refVel[r0 + 2]!
        rec.body.setAngvel(
          p.vec(
            w3b[0]! + ex * (1 - k2) + w3[0]! * strength * k2,
            w3b[1]! + ey * (1 - k2) + w3[1]! * strength * k2,
            w3b[2]! + ez * (1 - k2) + w3[2]! * strength * k2,
          ),
          true,
        )
        a.refVel[r0] = w3b[0]!
        a.refVel[r0 + 1] = w3b[1]!
        a.refVel[r0 + 2] = w3b[2]!
      }
    }
    sim.stats.driveMs = performance.now() - t0
  },
})

/** A character's rig joints, once it is near and its player has sampled the rig. */
function refreshJoints(world: World, a: Active): Entity[] | null {
  const st = world.tryResource(CharacterStates)?.get(a.view.owner)
  if (!st?.rigInstance || st.joining || st.tier !== 0) return null
  a.view.joints = st.rigInstance.joints
  return a.view.joints
}

const up = new Float64Array(3)
const fwd = new Float64Array(3)

/** A falling root body turned gently toward its rest: on its back, its front faces up. */
function steer(
  world: World,
  a: Active,
  rec: {
    body: {
      angvel(): { x: number; y: number; z: number }
      setAngvel(v: unknown, w: boolean): void
      rotation(): { x: number; y: number; z: number; w: number }
    }
  },
  stiffness: number,
) {
  const r = world.get(a.root, Reaction)
  const rest = a.asset.rests[r.rest]
  if (!rest) return
  const age = world.resource(Time).elapsed - r.since
  const k = Math.min(1, age / Math.max(a.asset.reactions.downTime, 0.1)) * 0.15 * stiffness
  readRot(rec, cur)
  // The model's forward (+z) as the root body carries it.
  qmulConj(q, 0, a.binding.rest, a.binding.root * 7 + 3, cur, 0)
  fwd[0] = 0
  fwd[1] = 0
  fwd[2] = 1
  qmulConj(q2, 0, a.binding.rest, a.binding.root * 7 + 3, a.binding.rest, a.binding.root * 7 + 3)
  // cur · rest⁻¹ maps model directions to world.
  qmulByConj(q, 0, cur, 0, a.binding.rest, a.binding.root * 7 + 3)
  qrotate(fwd, 0, q, 0, fwd, 0)
  // Back: forward up. Front: forward down. Side: forward level.
  up[0] = 0
  up[2] = 0
  up[1] = rest.from === 'front' ? 1 : rest.from === 'back' ? -1 : 0
  if (rest.from === 'side') {
    const l = Math.sqrt(fwd[0]! * fwd[0]! + fwd[2]! * fwd[2]!) || 1
    up[0] = fwd[0]! / l
    up[2] = fwd[2]! / l
  }
  // ω += k · (fwd × want).
  const cx = fwd[1]! * up[2]! - fwd[2]! * up[1]!
  const cy = fwd[2]! * up[0]! - fwd[0]! * up[2]!
  const cz = fwd[0]! * up[1]! - fwd[1]! * up[0]!
  const av = rec.body.angvel()
  const dt = world.resource(FixedTime).step
  rec.body.setAngvel(
    { x: av.x + cx * k * dt * 10, y: av.y + cy * k * dt * 10, z: av.z + cz * k * dt * 10 },
    true,
  )
}

// --- the blend (PostUpdate, after sampling, before transforms) ------------------------------

const before8 = new Float64Array(8)
const after8 = new Float64Array(8)
const tmp7 = new Float64Array(7)

/**
 * Moves the root under the ragdoll's root body, turned so the rest's lying pose lies the way the
 * body does (head where its head is), and re-expresses the snapshot against it, so the rest blend
 * settles in place instead of sliding the body across the ground. Cold (once per knockdown).
 */
function landRoot(world: World, a: Active, rest: RagdollRest | undefined): void {
  const p = world.tryResource(Physics)
  const s = a.slot
  if (!p || !s || world.has(a.root, ChildOf)) return
  const b = a.binding
  const pelvis = p.bodies.get(s.bodies[b.root]!)?.body.translation()
  const headBody = a.asset.bodies.findIndex((x) => x.zone === 'head')
  const head = headBody >= 0 ? p.bodies.get(s.bodies[headBody]!)?.body.translation() : undefined
  if (!pelvis) return
  // The head's direction from the pelvis, lying in the world and in the rest's pose.
  let wantYaw: number | undefined
  if (head) {
    const wx = head.x - pelvis.x
    const wz = head.z - pelvis.z
    let mx = 0
    let mz = rest?.from === 'back' ? 1 : -1
    if (rest?.bodies && headBody >= 0) {
      mx = rest.bodies[headBody * 7]! - rest.bodies[b.root * 7]!
      mz = rest.bodies[headBody * 7 + 2]! - rest.bodies[b.root * 7 + 2]!
    }
    if (Math.hypot(wx, wz) > 0.1 && Math.hypot(mx, mz) > 0.05) {
      wantYaw = Math.atan2(wx, wz) - Math.atan2(mx, mz)
    }
  }
  // The snapshot (owner model space) to the world, before the root moves.
  worldOf(world, a.view.owner, before8)
  for (let i = 0; i < b.count; i++) toWorld8(before8, a.snapshot, i * 7)
  const t = world.get(a.root, Transform)
  const rot = t.rotation
  world.set(a.root, Transform, {
    ...t,
    translation: [pelvis.x, t.translation[1], pelvis.z],
    rotation:
      wantYaw === undefined ? [...rot] : [0, Math.sin(wantYaw / 2), 0, Math.cos(wantYaw / 2)],
  })
  worldOf(world, a.view.owner, after8)
  for (let i = 0; i < b.count; i++) toModel8(after8, a.snapshot, i * 7)
}

/** A model pose (t, r) at o in `pose` to world through `frame` (pos, rot, scale), in place. */
function toWorld8(frame: Float64Array, pose: Float32Array, o: number): void {
  tmp7[0] = pose[o]! * frame[7]!
  tmp7[1] = pose[o + 1]! * frame[7]!
  tmp7[2] = pose[o + 2]! * frame[7]!
  qrotate(tmp7, 0, frame, 3, tmp7, 0)
  pose[o] = tmp7[0]! + frame[0]!
  pose[o + 1] = tmp7[1]! + frame[1]!
  pose[o + 2] = tmp7[2]! + frame[2]!
  qmul(tmp7, 3, frame, 3, pose, o + 3)
  for (let k = 3; k < 7; k++) pose[o + k] = tmp7[k]!
}

/** The inverse: a world pose at o back into `frame`'s model space, in place. */
function toModel8(frame: Float64Array, pose: Float32Array, o: number): void {
  tmp7[0] = pose[o]! - frame[0]!
  tmp7[1] = pose[o + 1]! - frame[1]!
  tmp7[2] = pose[o + 2]! - frame[2]!
  qrotateInv(tmp7, 0, frame, 3, tmp7, 0)
  const inv = 1 / (frame[7]! || 1)
  pose[o] = tmp7[0]! * inv
  pose[o + 1] = tmp7[1]! * inv
  pose[o + 2] = tmp7[2]! * inv
  qmulConj(tmp7, 3, frame, 3, pose, o + 3)
  for (let k = 3; k < 7; k++) pose[o + k] = tmp7[k]!
}

const bodyPose = new Float64Array(7)
const _preModel = new Float64Array(8)

/** The current (interpolated) world pose of a slot body into model space. */
function physicalModel(
  p: PhysicsWorld,
  a: Active,
  i: number,
  alpha: number,
  ow: Float64Array,
  out: Float64Array,
  o: number,
) {
  const rec = p.bodies.get(a.slot!.bodies[i]!)
  if (!rec) return false
  const s = rec.slot * 7
  const prev = p.prev
  const curr = p.curr
  for (let k = 0; k < 3; k++) bodyPose[k] = prev[s + k]! + (curr[s + k]! - prev[s + k]!) * alpha
  qslerp(bodyPose, 3, prev, s + 3, curr, s + 3, alpha)
  w3[0] = bodyPose[0]! - ow[0]!
  w3[1] = bodyPose[1]! - ow[1]!
  w3[2] = bodyPose[2]! - ow[2]!
  qrotateInv(out, o, ow, 3, w3, 0)
  const inv = 1 / (ow[7]! || 1)
  out[o] = out[o]! * inv
  out[o + 1] = out[o + 1]! * inv
  out[o + 2] = out[o + 2]! * inv
  qmulConj(out, o + 3, ow, 3, bodyPose, 3)
  return true
}

function captureSnapshot(world: World, a: Active): void {
  // What shows now: the blended model poses of the bodies' joints.
  const b = a.binding
  for (let i = 0; i < b.count; i++) {
    const j = b.joint[i]! * 8
    a.snapshot[i * 7] = a.model[j]!
    a.snapshot[i * 7 + 1] = a.model[j + 1]!
    a.snapshot[i * 7 + 2] = a.model[j + 2]!
    a.snapshot[i * 7 + 3] = a.model[j + 3]!
    a.snapshot[i * 7 + 4] = a.model[j + 4]!
    a.snapshot[i * 7 + 5] = a.model[j + 5]!
    a.snapshot[i * 7 + 6] = a.model[j + 6]!
  }
  void world
}

const src = new Float64Array(7 * 64)

/**
 * Blends the physics into the animated pose (0117): per body, its joint turns toward its body by
 * its weight (the root body's position too, once full); joints without bodies keep their animated
 * local pose. Captures the animated pose first, for the next drive. Also ends partial reactions
 * and rest blends, and freezes settled corpses.
 */
export const blendSystem = defineSystem({
  name: 'ragdoll/blend',
  description:
    'Captures the animated pose, blends the ragdoll into the joints by weight, and ends partial reactions, rest blends and settled corpses.',
  run: (_, world) => {
    const sim = world.tryResource(RagdollSimResource)
    if (!sim || sim.actives.size === 0) return
    const t0 = performance.now()
    const p = world.tryResource(Physics)
    const now = world.resource(Time).elapsed
    const alpha = world.tryResource(FixedTime)?.alpha ?? 1
    const budget = world.resource(RagdollBudget)
    // Deleting the current entry while iterating a Map is safe.
    for (const a of sim.actives.values()) {
      if (dropIfDead(world, sim, a)) continue
      const joints = a.view.character ? refreshJoints(world, a) : a.view.joints
      if (!joints) continue
      if (
        a.view.character &&
        world.tryResource(CharacterStates)?.get(a.view.owner)?.rigInstance === null
      )
        continue
      capture(world, a, joints)
      // Weights for this frame.
      const b = a.binding
      const n = b.count
      const age = now - a.start
      const ramp = Math.min(1, age / Math.max(budget.blendIn, 1e-3))
      let done = false
      let source = 0 // 0: bodies, 1: snapshot
      if (a.mode === MODE_PARTIAL) {
        // The blend carries the way back: it holds while the hit plays out (the first fifth),
        // then eases to the animation over the rest, slowly, so the body whips away fast and comes
        // back slow. The drives stay soft until it's mostly blended out and only then return:
        // pulled back hard while still shown, the chain swung past the animation the other way.
        const phase = age / Math.max(a.asset.reactions.recover, 1e-3)
        const show = 1 - smoothstep((phase - 0.2) / 0.8)
        const drop = 1 - smoothstep((phase - 0.6) / 0.4)
        for (let i = 0; i < n; i++) {
          // The falloff mostly decides how much a body yields (its drive): what moves, shows.
          a.weight[i] = a.pending ? 0 : Math.min(1, 2 * a.peak[i]!) * ramp * show
          a.strength[i] = 1 - Math.sqrt(a.peak[i]!) * a.asset.reactions.hitDrop * drop
        }
        done = phase >= 1 && !a.pending
      } else if (a.mode === MODE_FULL) {
        for (let i = 0; i < n; i++) {
          a.weight[i] = a.pending ? 0 : ramp
          a.strength[i] = 0
        }
      } else if (a.mode === MODE_HELD) {
        a.weight.fill(1)
        source = 1
      } else {
        const w = 1 - smoothstep(age / Math.max(budget.restBlend, 1e-3))
        a.weight.fill(w)
        source = 1
        done = w <= 0
      }
      if (source === 0 && (!a.slot || a.pending)) a.weight.fill(0)
      // Source poses (model space).
      if (source === 0 && a.slot && !a.pending && p) {
        worldOf(world, a.view.owner, owner8)
        for (let i = 0; i < n; i++) physicalModel(p, a, i, alpha, owner8, src, i * 7)
      } else if (source === 1) src.set(a.snapshot.subarray(0, n * 7))
      blend(world, a, joints, a.mode !== MODE_PARTIAL)
      if (done) {
        finishActive(world, sim, a)
        continue
      }
      // Corpses: settled or out of time.
      if (a.state === DEAD && a.mode === MODE_FULL && a.slot && !a.pending && p) {
        const deadFor = now - a.start
        let asleep = deadFor > 1
        for (let i = 0; i < n && asleep; i++)
          asleep = p.bodies.get(a.slot.bodies[i]!)?.body.isSleeping() === true
        if (asleep || deadFor >= budget.corpseAfter) freeze(world, sim, a)
      }
    }
    sim.stats.blendMs = performance.now() - t0
  },
})

/** A root (or its skeleton) despawned mid-reaction: its bodies go back to the pool. */
function dropIfDead(world: World, sim: RagdollSim, a: Active): boolean {
  if (world.isAlive(a.root) && world.isAlive(a.view.owner)) return false
  releaseSlot(world, a)
  sim.actives.delete(a.root)
  sim.clips.delete(a.root)
  return true
}

function finishActive(world: World, sim: RagdollSim, a: Active): void {
  releaseSlot(world, a)
  restoreIk(world, a)
  // Our last writes stay: put the animated locals back so nothing lingers.
  restoreLocals(world, a)
  if (a.view.character) setClaim(world, a.view.owner, false)
  sim.actives.delete(a.root)
}

function restoreLocals(world: World, a: Active): void {
  const joints = a.view.joints
  if (!joints) return
  for (let j = 0; j < a.wroteMask.length; j++) {
    if (!a.wroteMask[j]) continue
    a.wroteMask[j] = 0
    const e = joints[j]!
    if (!world.isAlive(e)) continue
    const table = world.entityTableUnchecked(e)
    const row = world.entityRowUnchecked(e)
    const tr = table.column(Transform, 'translation')
    const ro = table.column(Transform, 'rotation')
    const o = j * 7
    // Only where the animation hasn't written since.
    if (ro[row * 4] !== a.wrote[o + 3] || ro[row * 4 + 3] !== a.wrote[o + 6]) continue
    for (let k = 0; k < 3; k++) tr[row * 3 + k] = a.orig[o + k]!
    for (let k = 0; k < 4; k++) ro[row * 4 + k] = a.orig[o + 3 + k]!
    table.markChanged(Transform, row)
  }
}

/** The animated locals this frame (where the animation didn't write, what it held before us). */
function capture(world: World, a: Active, joints: Entity[]): void {
  const jc = joints.length
  const local = a.animLocal
  for (let j = 0; j < jc; j++) {
    const e = joints[j]!
    const table = world.entityTableUnchecked(e)
    const row = world.entityRowUnchecked(e)
    const tr = table.column(Transform, 'translation')
    const ro = table.column(Transform, 'rotation')
    const sc = table.column(Transform, 'scale')
    const o = j * 10
    const w = j * 7
    const untouched =
      a.wroteMask[j] === 1 &&
      ro[row * 4] === a.wrote[w + 3] &&
      ro[row * 4 + 1] === a.wrote[w + 4] &&
      ro[row * 4 + 2] === a.wrote[w + 5] &&
      ro[row * 4 + 3] === a.wrote[w + 6] &&
      tr[row * 3] === a.wrote[w] &&
      tr[row * 3 + 1] === a.wrote[w + 1] &&
      tr[row * 3 + 2] === a.wrote[w + 2]
    if (untouched) {
      for (let k = 0; k < 7; k++) local[o + k] = a.orig[w + k]!
    } else {
      local[o] = tr[row * 3]!
      local[o + 1] = tr[row * 3 + 1]!
      local[o + 2] = tr[row * 3 + 2]!
      local[o + 3] = ro[row * 4]!
      local[o + 4] = ro[row * 4 + 1]!
      local[o + 5] = ro[row * 4 + 2]!
      local[o + 6] = ro[row * 4 + 3]!
    }
    local[o + 7] = sc[row * 3]!
    local[o + 8] = sc[row * 3 + 1]!
    local[o + 9] = sc[row * 3 + 2]!
  }
}

/** Parent model (pos, rot, scale) for joint j into out. */
function parentModel(a: Active, j: number, chain: Float64Array, out: Float64Array): void {
  const p = a.view.skeleton.parents[j]!
  if (p >= 0) {
    for (let k = 0; k < 8; k++) out[k] = chain[p * 8 + k]!
    return
  }
  const pre = a.view.skeleton.pre
  out[0] = pre[j * 12 + 3]!
  out[1] = pre[j * 12 + 7]!
  out[2] = pre[j * 12 + 11]!
  out[7] = quatFromRows(out, 3, pre, j * 12)
}

const parentA = new Float64Array(8)
const parentB = new Float64Array(8)
const local7 = new Float64Array(7)

const tq = new Float64Array(4)
const tv = new Float64Array(3)
let frameDt = 0

function blend(world: World, a: Active, joints: Entity[], full: boolean): void {
  frameDt = world.resource(Time).delta
  const b = a.binding
  const sk = a.view.skeleton
  const order = b.jointOrder
  const local = a.animLocal
  for (let k = 0; k < order.length; k++) {
    const j = order[k]!
    const o = j * 10
    const m = j * 8
    // Animated model.
    parentModel(a, j, a.anim, parentA)
    for (let x = 0; x < 8; x++) a.anim[m + x] = parentA[x]!
    compose(a.anim, m, local, o, local, o + 3, local[o + 7]!)
    // Blended model.
    parentModel(a, j, a.model, parentB)
    const body = b.bodyOf[j]!
    const w = body >= 0 ? a.weight[body]! : 0
    for (let x = 0; x < 8; x++) a.model[m + x] = parentB[x]!
    compose(a.model, m, local, o, local, o + 3, local[o + 7]!)
    if (body >= 0) {
      // Targets for the next drive: the animated pose, and how fast it turns.
      const t = body * 7
      if (a.targetsSet && frameDt > 0) {
        qmulByConj(tq, 0, a.anim, m + 3, a.targets, t + 3)
        qlog(tv, 0, tq, 0)
        a.targetVel[body * 3] = tv[0]! / frameDt
        a.targetVel[body * 3 + 1] = tv[1]! / frameDt
        a.targetVel[body * 3 + 2] = tv[2]! / frameDt
      }
      for (let x = 0; x < 7; x++) a.targets[t + x] = a.anim[m + x]!
    }
    if (w <= 0) continue
    qslerp(a.model, m + 3, a.anim, m + 3, src, body * 7 + 3, w)
    if (full && body === b.root) {
      for (let x = 0; x < 3; x++)
        a.model[m + x] = a.anim[m + x]! + (src[body * 7 + x]! - a.anim[m + x]!) * w
    }
    // Back to a local: parent⁻¹ · model.
    qmulConj(local7, 3, parentB, 3, a.model, m + 3)
    let tx = local[o]!
    let ty = local[o + 1]!
    let tz = local[o + 2]!
    if (full && body === b.root) {
      w3[0] = (a.model[m]! - parentB[0]!) / (parentB[7]! || 1)
      w3[1] = (a.model[m + 1]! - parentB[1]!) / (parentB[7]! || 1)
      w3[2] = (a.model[m + 2]! - parentB[2]!) / (parentB[7]! || 1)
      qrotateInv(w3, 0, parentB, 3, w3, 0)
      tx = w3[0]!
      ty = w3[1]!
      tz = w3[2]!
    }
    const e = joints[j]!
    const table = world.entityTableUnchecked(e)
    const row = world.entityRowUnchecked(e)
    const tr = table.column(Transform, 'translation')
    const ro = table.column(Transform, 'rotation')
    const wo = j * 7
    if (!a.wroteMask[j]) {
      // What the animation wrote: put back where it stops writing.
      for (let x = 0; x < 7; x++) a.orig[wo + x] = local[o + x]!
    } else {
      for (let x = 0; x < 7; x++) a.orig[wo + x] = local[o + x]!
    }
    tr[row * 3] = tx
    tr[row * 3 + 1] = ty
    tr[row * 3 + 2] = tz
    ro[row * 4] = local7[3]!
    ro[row * 4 + 1] = local7[4]!
    ro[row * 4 + 2] = local7[5]!
    ro[row * 4 + 3] = local7[6]!
    // Stored as the columns hold them (f32), so the next capture can compare exactly.
    a.wrote[wo] = tr[row * 3]!
    a.wrote[wo + 1] = tr[row * 3 + 1]!
    a.wrote[wo + 2] = tr[row * 3 + 2]!
    a.wrote[wo + 3] = ro[row * 4]!
    a.wrote[wo + 4] = ro[row * 4 + 1]!
    a.wrote[wo + 5] = ro[row * 4 + 2]!
    a.wrote[wo + 6] = ro[row * 4 + 3]!
    a.wroteMask[j] = 1
    table.markChanged(Transform, row)
  }
  a.targetsSet = true
  void sk
}

// --- corpses ---------------------------------------------------------------------------------

/** The blended model rows (12 per joint) of an active ragdoll. */
function modelRows(a: Active): Float32Array {
  const jc = a.view.skeleton.paths.length
  const rows = new Float32Array(jc * 12)
  for (let j = 0; j < jc; j++) rowsFrom(a.model, j * 8, rows, j * 12)
  return rows
}

function rowsFrom(m: Float64Array, o: number, out: Float32Array, r: number): void {
  const x = m[o + 3]!
  const y = m[o + 4]!
  const z = m[o + 5]!
  const w = m[o + 6]!
  const s = m[o + 7]!
  out[r] = (1 - 2 * (y * y + z * z)) * s
  out[r + 1] = 2 * (x * y - w * z) * s
  out[r + 2] = 2 * (x * z + w * y) * s
  out[r + 3] = m[o]!
  out[r + 4] = 2 * (x * y + w * z) * s
  out[r + 5] = (1 - 2 * (x * x + z * z)) * s
  out[r + 6] = 2 * (y * z - w * x) * s
  out[r + 7] = m[o + 1]!
  out[r + 8] = 2 * (x * z - w * y) * s
  out[r + 9] = 2 * (y * z + w * x) * s
  out[r + 10] = (1 - 2 * (x * x + y * y)) * s
  out[r + 11] = m[o + 2]!
}

/** A dead ragdoll's final pose, kept: a frozen character (0115) or a stilled model. */
function freeze(world: World, sim: RagdollSim, a: Active): void {
  const rows = modelRows(a)
  releaseSlot(world, a)
  restoreIk(world, a)
  sim.actives.delete(a.root)
  if (a.view.character) {
    freezeCharacter(world, a.view.owner, rows)
    setClaim(world, a.view.owner, false)
  } else if (world.has(a.view.owner, AnimationPlayer)) {
    // The joints hold the last pose once nothing samples them.
    world.remove(a.view.owner, AnimationPlayer)
  }
  addCorpse(world, sim, a.root, rows)
}

function freezeFromClip(world: World, sim: RagdollSim, root: Entity): void {
  const view = skeletonOf(world, root)
  if (!view?.character) return
  const st = world.tryResource(CharacterStates)?.get(view.owner)
  if (!st || !world.has(view.owner, AnimationPlayer)) return
  const jc = view.skeleton.paths.length
  if (scratchRows.length < jc * 12) scratchRows = new Float32Array(jc * 12)
  samplePose(world, view.owner, st.pose, scratchRows, 0)
  const rows = new Float32Array(st.pose.model.subarray(0, jc * 12))
  freezeCharacter(world, view.owner, rows)
  addCorpse(world, sim, root, rows)
}

function addCorpse(world: World, sim: RagdollSim, root: Entity, model: Float32Array): void {
  sim.corpses.set(root, { root, model, at: world.resource(Time).elapsed })
  world.send(CorpseSettled, { entity: root })
  const max = world.resource(RagdollBudget).maxCorpses
  while (sim.corpses.size > max) {
    const oldest = sim.corpses.keys().next().value as Entity
    sim.corpses.delete(oldest)
    world.send(CorpseEvicted, { entity: oldest })
  }
}

/** Hooks the simulation into hit tests: live bodies and frozen poses. */
export function installSimSources(world: World): void {
  setActiveSource(world, (root, out) => {
    const sim = world.tryResource(RagdollSimResource)
    const a = sim?.actives.get(root)
    const p = world.tryResource(Physics)
    if (!a?.slot || a.pending || !p) return false
    for (let i = 0; i < a.binding.count; i++) {
      const rec = p.bodies.get(a.slot.bodies[i]!)
      if (!rec) return false
      const t = rec.body.translation()
      const r = rec.body.rotation()
      out[i * 7] = t.x
      out[i * 7 + 1] = t.y
      out[i * 7 + 2] = t.z
      out[i * 7 + 3] = r.x
      out[i * 7 + 4] = r.y
      out[i * 7 + 5] = r.z
      out[i * 7 + 6] = r.w
    }
    return true
  })
  setFrozenSource(world, (root) => world.tryResource(RagdollSimResource)?.corpses.get(root)?.model)
}

/** describe: what the simulation is doing. */
export function describeSim(world: World) {
  const sim = world.tryResource(RagdollSimResource)
  if (!sim) return undefined
  let pooled = 0
  let bodies = 0
  for (const list of sim.slots.values()) {
    for (const s of list) {
      bodies += s.bodies.length
      if (!s.user) pooled += s.bodies.length
    }
  }
  return {
    active: [...sim.actives.values()].map((a) => ({
      root: a.root,
      state: REACTION_STATES[a.state],
      mode: MODE_NAMES[a.mode],
      pending: a.pending,
      physics: a.slot !== null,
      weights: Object.fromEntries(
        a.asset.bodies.map((b, i) => [b.joint, Math.round(a.weight[i]! * 100) / 100]),
      ),
      strengths: Object.fromEntries(
        a.asset.bodies.map((b, i) => [b.joint, Math.round(a.strength[i]! * 100) / 100]),
      ),
    })),
    bodies,
    pooledBodies: pooled,
    corpses: sim.corpses.size,
    stats: { ...sim.stats },
  }
}

export { DEAD, DOWN, MODE_NAMES, qangle }
