import {
  type AnimationLayerValue,
  AnimationPlayer,
  AnimationSampling,
  ChainIk,
  FootPlacement,
  LookAtIk,
  samplePose,
  TwoBoneIk,
} from '@aethervtt/shard-animation'
import {
  Children,
  type ComponentDef,
  defineResource,
  defineSystem,
  defineTag,
  type Entity,
  findComponent,
  frustum,
  mat4,
  type World,
} from '@aethervtt/shard-core'
import {
  Camera3d,
  Cameras,
  type DeformStore,
  Instances,
  SkinPose,
  Visibility,
} from '@aethervtt/shard-render'
import { Time } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import {
  Character,
  CharacterPart,
  CharacterTier,
  FAR,
  MID,
  NEAR,
  OFF,
  TierBudget,
  TierSource,
} from './components'
import { type BuildBake, ensureBake } from './rig'
import { checkoutRig, returnRig } from './rigs'
import { type CharacterState, CharacterStates } from './spawn'

const MAX_VIEWERS = 8
/** Joint rows (vec4) per joint in a pose range. */
const ROWS = 3
/** The clock is rebased past this many seconds, so f32 keeps sub-millisecond precision. */
const REBASE = 1024
const SOURCE_POSE = 1
const SOURCE_BAKED = 2
const SOURCE_JOINTS = 0
const IK_DEFS = [TwoBoneIk, LookAtIk, ChainIk, FootPlacement] as ComponentDef[]

/**
 * A stand-in drawn for a horde member past replication (`@aethervtt/shard-characters/net`): never
 * finer than far, so it never gets a rig or a pose range, whatever its screen size.
 */
export const HordeProxy = defineTag('characters/HordeProxy', {
  description: 'A far-tier horde proxy (0115): tier selection never makes it finer than far.',
})

export interface TierStats {
  counts: Int32Array
  simCounts: Int32Array
  pinned: number
  swaps: number
  jointsSampled: number
  selectMs: number
  sampleMs: number
}

export interface TierRun {
  stats: TierStats
  /** Clock origin (s of Time.elapsed). */
  clockBase: number
  frame: number
}

/** This frame's selection run (counts, timings, clock), for the sample system and describe. */
export const TierRunResource = defineResource<{ run: TierRun | null }>('characters/TierRun', {
  description: "This frame's tier counts and timings (describe). Internal.",
  init: () => ({ run: null }),
})

const sphere = new Float32Array(4)
const vp = new Float32Array(16)
const view = new Float32Array(16)
const proj = new Float32Array(16)

function viewerScratch() {
  return {
    planes: new Float32Array(MAX_VIEWERS * 24),
    pos: new Float32Array(MAX_VIEWERS * 3),
    /** Screen size per metre of diameter at 1 m (perspective), or per metre (orthographic). */
    k: new Float32Array(MAX_VIEWERS),
    ortho: new Uint8Array(MAX_VIEWERS),
    count: 0,
  }
}

/** Planes, position and screen factor of each viewer camera, from this frame's transforms. */
function gatherViewers(
  world: World,
  q: ReturnType<World['query']>,
  v: ReturnType<typeof viewerScratch>,
) {
  v.count = 0
  const cameras = world.tryResource(Cameras)
  for (let t = 0; t < q.tables.length; t++) {
    const table = q.tables[t]!
    const viewer = table.column(TierSource, 'viewer')
    const g = table.column(GlobalTransform, 'matrix')
    const fov = table.column(Camera3d, 'fovY')
    const near = table.column(Camera3d, 'near')
    const far = table.column(Camera3d, 'far')
    const projection = table.column(Camera3d, 'projection')
    const orthoHeight = table.column(Camera3d, 'orthoHeight')
    const active = table.column(Camera3d, 'active')
    for (let i = 0; i < table.count && v.count < MAX_VIEWERS; i++) {
      if (viewer[i] === 0 || active[i] === 0) continue
      const aspect = cameras?.get(table.entities[i]!)?.aspect ?? 16 / 9
      const o = i * 12
      // World rows → column-major view matrix (inverse of the camera's world).
      mat4.identity(view)
      view[0] = g[o]!
      view[4] = g[o + 1]!
      view[8] = g[o + 2]!
      view[12] = g[o + 3]!
      view[1] = g[o + 4]!
      view[5] = g[o + 5]!
      view[9] = g[o + 6]!
      view[13] = g[o + 7]!
      view[2] = g[o + 8]!
      view[6] = g[o + 9]!
      view[10] = g[o + 10]!
      view[14] = g[o + 11]!
      if (!mat4.invert(view, view)) continue
      const c = v.count
      const isOrtho = projection[i] !== 0
      if (isOrtho) {
        const h = orthoHeight[i]!
        mat4.orthographic(
          proj,
          (-h * aspect) / 2,
          (h * aspect) / 2,
          -h / 2,
          h / 2,
          near[i]!,
          far[i]!,
        )
        v.k[c] = h > 0 ? 1 / h : 0
      } else {
        const fovY = (fov[i]! * Math.PI) / 180
        mat4.perspective(proj, fovY, aspect, near[i]!, far[i]! > 0 ? far[i]! : 1e6)
        v.k[c] = 1 / (2 * Math.tan(fovY / 2))
      }
      mat4.multiply(vp, proj, view)
      frustum.fromViewProjection(v.planes.subarray(c * 24, c * 24 + 24), vp)
      v.pos[c * 3] = g[o + 3]!
      v.pos[c * 3 + 1] = g[o + 7]!
      v.pos[c * 3 + 2] = g[o + 11]!
      v.ortho[c] = isOrtho ? 1 : 0
      v.count++
    }
  }
}

function inFrustum(planes: Float32Array, o: number, s: Float32Array, pad: number): boolean {
  for (let p = o; p < o + 24; p += 4) {
    if (
      planes[p]! * s[0]! + planes[p + 1]! * s[1]! + planes[p + 2]! * s[2]! + planes[p + 3]! <
      -s[3]! - pad
    )
      return false
  }
  return true
}

/** The character's sphere in world space, into `sphere`. */
function worldSphere(s: CharacterState, g: Float32Array, o: number): void {
  const m = s.sphere[3]! > 0 ? s.sphere : s.rig.restSphere
  const x = m[0]!
  const y = m[1]!
  const z = m[2]!
  sphere[0] = g[o]! * x + g[o + 1]! * y + g[o + 2]! * z + g[o + 3]!
  sphere[1] = g[o + 4]! * x + g[o + 5]! * y + g[o + 6]! * z + g[o + 7]!
  sphere[2] = g[o + 8]! * x + g[o + 9]! * y + g[o + 10]! * z + g[o + 11]!
  const sx = g[o]! * g[o]! + g[o + 4]! * g[o + 4]! + g[o + 8]! * g[o + 8]!
  const sy = g[o + 1]! * g[o + 1]! + g[o + 5]! * g[o + 5]! + g[o + 9]! * g[o + 9]!
  const sz = g[o + 2]! * g[o + 2]! + g[o + 6]! * g[o + 6]! + g[o + 10]! * g[o + 10]!
  sphere[3] = m[3]! * Math.sqrt(Math.max(sx, sy, sz))
}

/**
 * Chooses every character's tier (screen size against viewer cameras, caps, hysteresis, pins) and
 * sim tier (distance to the nearest player), and swaps representations. PostUpdate, after
 * transform propagation, before visibility.
 */
export const selectTiers = defineSystem({
  name: 'characters/select',
  description:
    "Chooses each character's representation tier (near, mid, far, off) and sim tier, with caps and hysteresis, and swaps representations.",
  setup: (world) => ({
    viewers: world.query({ with: [TierSource, Camera3d, GlobalTransform] }),
    players: world.query({ with: [TierSource, GlobalTransform] }),
    chars: world.query({ with: [Character, CharacterTier, GlobalTransform] }),
    v: viewerScratch(),
    list: [] as CharacterState[],
    screen: new Float32Array(256),
    want: new Uint8Array(256),
    simTier: new Uint8Array(256),
    // Flags per character, then capTier's candidates after them: twice the characters.
    order: new Int32Array(512),
    score: new Float32Array(256),
    playerPos: new Float32Array(3 * 16),
    run: {
      stats: {
        counts: new Int32Array(4),
        simCounts: new Int32Array(3),
        pinned: 0,
        swaps: 0,
        jointsSampled: 0,
        selectMs: 0,
        sampleMs: 0,
      },
      clockBase: 0,
      frame: 0,
    } as TierRun,
  }),
  run: (s, world) => {
    const t0 = performance.now()
    const states = world.tryResource(CharacterStates)
    if (!states || states.size === 0) return
    const budget = world.resource(TierBudget)
    const time = world.resource(Time)
    const now = time.elapsed
    const h = budget.hysteresis
    const run = s.run
    run.frame++
    world.resource(TierRunResource).run = run
    gatherViewers(world, s.viewers, s.v)
    const v = s.v
    const headless = v.count === 0
    // Players for sim tiers.
    let players = 0
    for (let t = 0; t < s.players.tables.length; t++) {
      const table = s.players.tables[t]!
      const player = table.column(TierSource, 'player')
      const g = table.column(GlobalTransform, 'matrix')
      for (let i = 0; i < table.count && players < 16; i++) {
        if (player[i] === 0) continue
        s.playerPos[players * 3] = g[i * 12 + 3]!
        s.playerPos[players * 3 + 1] = g[i * 12 + 7]!
        s.playerPos[players * 3 + 2] = g[i * 12 + 11]!
        players++
      }
    }
    // Pass 1: screen size, visibility, wanted tier before caps, sim tier.
    let n = 0
    const list = s.list
    for (let t = 0; t < s.chars.tables.length; t++) {
      const table = s.chars.tables[t]!
      const g = table.column(GlobalTransform, 'matrix')
      const pin = table.column(CharacterTier, 'pin')
      const proxy = table.has(HordeProxy)
      for (let i = 0; i < table.count; i++) {
        const st = states.get(table.entities[i]!)
        if (!st) continue
        if (n >= s.screen.length) grow(s)
        list[n] = st
        st.pinned = pin[i] !== 0
        worldSphere(st, g, i * 12)
        // Sim tier: distance to the nearest player.
        let best = Number.POSITIVE_INFINITY
        for (let p = 0; p < players; p++) {
          const dx = sphere[0]! - s.playerPos[p * 3]!
          const dy = sphere[1]! - s.playerPos[p * 3 + 1]!
          const dz = sphere[2]! - s.playerPos[p * 3 + 2]!
          const d = dx * dx + dy * dy + dz * dz
          if (d < best) best = d
        }
        best = Math.sqrt(best)
        const simWas = st.simTier
        const nearT = budget.simNear * (simWas === 0 ? 1 + h : 1 - h)
        const midT = budget.simMid * (simWas <= 1 ? 1 + h : 1 - h)
        st.simTier = best <= nearT ? 0 : best <= midT ? 1 : 2
        s.simTier[n] = st.simTier
        // Screen size and visibility.
        let size = 0
        let visible = false
        let nearest = Number.POSITIVE_INFINITY
        for (let c = 0; c < v.count; c++) {
          const dx = sphere[0]! - v.pos[c * 3]!
          const dy = sphere[1]! - v.pos[c * 3 + 1]!
          const dz = sphere[2]! - v.pos[c * 3 + 2]!
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (d < nearest) nearest = d
          const sz = v.ortho[c]
            ? 2 * sphere[3]! * v.k[c]!
            : (2 * sphere[3]! * v.k[c]!) / Math.max(d, 1e-3)
          if (sz > size) size = sz
          if (!visible && inFrustum(v.planes, c * 24, sphere, 0)) visible = true
        }
        s.screen[n] = size
        let want: number
        const rig = st.rig
        if (headless) {
          // A server gives out rigs only with serverRigs, pinned or not; near acts as mid.
          const sim = pin[i] !== 0 ? 0 : st.simTier
          want = sim === 0 ? (budget.serverRigs ? NEAR : MID) : sim
        } else if (pin[i] !== 0) want = NEAR
        else if (!visible || nearest > rig.farDistance || size < rig.farScreen) want = OFF
        else {
          const cur = st.tier
          const nearAt = rig.nearScreen * (cur === NEAR ? 1 - h : 1 + h)
          const midAt = rig.midScreen * (cur <= MID ? 1 - h : 1 + h)
          want = size >= nearAt ? NEAR : size >= midAt ? MID : FAR
        }
        if (proxy && want < FAR) want = FAR
        s.want[n] = want
        n++
      }
    }
    // Pass 2: caps. Near: unpinned, largest first, incumbents favoured; entrants limited per frame.
    capTier(s, n, NEAR, budget.maxNear, budget.joinsPerFrame, h, MID)
    capTier(s, n, MID, budget.maxMid, n, h, FAR)
    // Pass 3: apply, with dwell (off is immediate) and the IK fade before leaving near.
    const stats = run.stats
    stats.counts.fill(0)
    stats.simCounts.fill(0)
    stats.pinned = 0
    stats.swaps = 0
    const dt = time.delta
    for (let k = 0; k < n; k++) {
      const st = list[k]!
      let want = s.want[k]!
      // Too soon after the last change keeps the tier, unless off is involved or a cap demotes it.
      if (
        want !== st.tier &&
        want !== OFF &&
        st.tier !== OFF &&
        now - st.since < budget.dwell &&
        !capped(s, k)
      ) {
        want = st.tier
      }
      if (st.tier === NEAR && st.ikEntities.length > 0) {
        // IK fades in on entering near, and out before leaving it (off is immediate).
        const leaving = want !== NEAR && want !== OFF
        // IK runs before selection, at the weight set the frame before: a frame has drawn the pose
        // without IK once two selections in a row began with the fade at 0.
        st.ikIdle = st.ik === 0 ? st.ikIdle + 1 : 0
        fadeIk(world, st, leaving ? -dt / budget.ikFade : dt / budget.ikFade)
        if (leaving && st.ikIdle < 2) want = NEAR
      }
      if (want !== st.tier) {
        changeTier(world, st, want, now)
        stats.swaps++
      } else if (st.joining) finishJoin(world, st)
      stats.counts[st.tier]!++
      stats.simCounts[st.simTier]!++
    }
    list.length = n
    // Movement tiers (nav/NavTier, when nav is installed): crowd near players, steer, coarse.
    const navTier = navTierDef()
    // Write the components.
    let k = 0
    for (let t = 0; t < s.chars.tables.length; t++) {
      const table = s.chars.tables[t]!
      const tier = table.column(CharacterTier, 'tier')
      const sim = table.column(CharacterTier, 'sim')
      const tick = table.column(CharacterTier, 'simTick')
      const screen = table.column(CharacterTier, 'screen')
      const pin = table.column(CharacterTier, 'pin')
      for (let i = 0; i < table.count; i++) {
        // Same order as pass 1, which listed every character with a state.
        const st = list[k]
        if (st === undefined || st.entity !== table.entities[i]) continue
        tier[i] = st.tier
        if (navTier && st.navTier !== st.simTier) {
          setNavTier(world, table.entities[i]!, navTier, st.simTier)
        }
        sim[i] = st.simTier
        const every = budget.simEvery[st.simTier]!
        tick[i] = (run.frame + (table.entities[i]! % every)) % every === 0 ? 1 : 0
        screen[i] = s.screen[k++]!
        if (pin[i] !== 0) stats.pinned++
      }
      table.markChanged(CharacterTier)
    }
    if (navTier && pendingNav.length > 0) addPendingNavTiers(world, navTier)
    stats.selectMs = performance.now() - t0
  },
})

let navTierCache: ComponentDef | null | undefined
let navAgentCache: ComponentDef | null | undefined

/** nav/NavTier, when nav is installed (characters doesn't depend on nav). */
function navTierDef(): ComponentDef | null {
  if (navTierCache === undefined) navTierCache = findComponent('nav/NavTier') ?? null
  if (navAgentCache === undefined) navAgentCache = findComponent('nav/NavAgent') ?? null
  return navAgentCache ? navTierCache : null
}

/** An agent's movement tier from its sim tier: near → crowd, mid → steer, far → coarse. */
function setNavTier(world: World, entity: Entity, def: ComponentDef, sim: number): void {
  const st = world.resource(CharacterStates).get(entity)
  if (!st || !world.has(entity, navAgentCache!)) return
  st.navTier = sim
  if (world.has(entity, def)) {
    const table = world.entityTableUnchecked(entity)
    const row = world.entityRowUnchecked(entity)
    table.column(def, 'tier')[row] = sim
    table.markChanged(def, row)
  } else {
    // Adding moves the entity's table: done after the loop over tables.
    pendingNav.push(entity)
  }
}

const pendingNav: Entity[] = []
const NAV_NAMES = ['crowd', 'steer', 'coarse'] as const

function addPendingNavTiers(world: World, def: ComponentDef): void {
  const states = world.resource(CharacterStates)
  for (let k = 0; k < pendingNav.length; k++) {
    const e = pendingNav[k]!
    const st = states.get(e)
    if (st && world.isAlive(e) && !world.has(e, def))
      world.add(e, def, { tier: NAV_NAMES[st.navTier]! })
  }
  pendingNav.length = 0
}

type SelectState = ReturnType<NonNullable<typeof selectTiers.setup>>

function grow(s: SelectState): void {
  const size = s.screen.length * 2
  const g = <T extends Float32Array | Uint8Array | Int32Array>(a: T, make: (n: number) => T): T => {
    const out = make(size)
    out.set(a as never)
    return out
  }
  s.screen = g(s.screen, (n) => new Float32Array(n))
  s.want = g(s.want, (n) => new Uint8Array(n))
  s.simTier = g(s.simTier, (n) => new Uint8Array(n))
  const order = new Int32Array(size * 2)
  order.set(s.order)
  s.order = order
  s.score = g(s.score, (n) => new Float32Array(n))
}

/** Whether entry k was demoted by a cap this frame (its wanted tier was finer). */
function capped(s: SelectState, k: number): boolean {
  return (s.order[k]! & 0x40000000) !== 0
}

/**
 * Keeps at most `max` characters wanting `tier` (pinned ones aside), largest on screen first with
 * incumbents favoured, at most `joins` of them new; the rest drop to `next`.
 */
function capTier(
  s: SelectState,
  n: number,
  tier: number,
  max: number,
  joins: number,
  h: number,
  next: number,
): void {
  let m = 0
  const list = s.list
  for (let k = 0; k < n; k++) {
    if (tier === NEAR) s.order[k] = s.order[k]! & ~0x40000000
    if (s.want[k] !== tier) continue
    const st = list[k]!
    if (tier === NEAR && st.pinned) continue
    s.score[m] = s.screen[k]! * (st.tier === tier ? 1 + h : 1)
    s.order[n + m] = k
    m++
  }
  if (m <= max && tier !== NEAR) return
  // Insertion sort by score, descending: candidate sets are small (those near the threshold).
  const ord = s.order
  for (let a = 1; a < m; a++) {
    const sc = s.score[a]!
    const idx = ord[n + a]!
    let b = a - 1
    while (b >= 0 && s.score[b]! < sc) {
      s.score[b + 1] = s.score[b]!
      ord[n + b + 1] = ord[n + b]!
      b--
    }
    s.score[b + 1] = sc
    ord[n + b + 1] = idx
  }
  let kept = 0
  let joined = 0
  for (let a = 0; a < m; a++) {
    const k = ord[n + a]!
    const isNew = list[k]!.tier !== tier
    if (kept < max && (!isNew || joined < joins)) {
      kept++
      if (isNew) joined++
    } else {
      s.want[k] = next
      s.order[k] = s.order[k]! | 0x40000000
    }
  }
}

/** Scales the character's IK weights by its fade, moved by `step` (clamped to 0–1). */
function fadeIk(world: World, st: CharacterState, step: number): void {
  const before = st.ik
  st.ik = Math.min(1, Math.max(0, st.ik + step))
  if (st.ik !== before) setIkWeights(world, st, st.ik)
}

/** Every IK component on the character's root and its direct non-part children, with base weights. */
function captureIk(world: World, st: CharacterState): void {
  if (st.ikEntities.length > 0) return
  const consider = (e: Entity) => {
    for (const def of IK_DEFS) {
      if (!world.has(e, def)) continue
      const w = (world.get(e, def) as { weight: number }).weight
      st.ikEntities.push(e)
      st.ikDefs.push(def)
      st.ikBase.push(w)
    }
  }
  consider(st.entity)
  if (world.has(st.entity, Children)) {
    for (const child of world.get(st.entity, Children).entities) {
      if (child === null || world.has(child, CharacterPart)) continue
      consider(child)
    }
  }
}

function setIkWeights(world: World, st: CharacterState, f: number): void {
  for (let k = 0; k < st.ikEntities.length; k++) {
    const e = st.ikEntities[k]!
    if (!world.isAlive(e)) continue
    const table = world.entityTableUnchecked(e)
    const def = st.ikDefs[k]!
    if (!table.has(def)) continue
    const row = world.entityRowUnchecked(e)
    table.column(def, 'weight')[row] = st.ikBase[k]! * f
    table.markChanged(def, row)
  }
}

function setVisible(world: World, entity: Entity, visible: boolean): void {
  const table = world.entityTableUnchecked(entity)
  const row = world.entityRowUnchecked(entity)
  const mode = table.column(Visibility, 'mode')
  const want = visible ? 0 : 2 // inherit, hidden
  if (mode[row] !== want) {
    mode[row] = want
    table.markChanged(Visibility, row)
  }
}

function setSource(
  world: World,
  st: CharacterState,
  entity: Entity,
  source: number,
  base: number,
): void {
  const table = world.entityTableUnchecked(entity)
  const row = world.entityRowUnchecked(entity)
  table.column(SkinPose, 'source')[row] = source
  table.column(SkinPose, 'base')[row] = base
  table.column(SkinPose, 'joints')[row] = st.rig.skeleton.paths.length
  table.column(SkinPose, 'morphBase')[row] = st.morphBase > 0 ? st.morphBase : 0
  table.column(SkinPose, 'morphCount')[row] = st.morphBase > 0 ? st.morphCount : 0
  table.markChanged(SkinPose, row)
}

function setSphere(world: World, entity: Entity, sph: Float32Array): void {
  const table = world.entityTableUnchecked(entity)
  const row = world.entityRowUnchecked(entity)
  const col = table.column(SkinPose, 'sphere')
  col[row * 4] = sph[0]!
  col[row * 4 + 1] = sph[1]!
  col[row * 4 + 2] = sph[2]!
  col[row * 4 + 3] = sph[3]!
}

function setSampling(world: World, entity: Entity, entities: boolean): void {
  const table = world.entityTableUnchecked(entity)
  const row = world.entityRowUnchecked(entity)
  table.column(AnimationSampling, 'mode')[row] = entities ? 0 : 1
  table.markChanged(AnimationSampling, row)
}

/** Samples a mid (or entering near) character's pose into its pose range now. */
function sampleNow(world: World, store: DeformStore | undefined, st: CharacterState): number {
  const joints = st.rig.skeleton.paths.length
  if (store && st.poseBase < 0) st.poseBase = store.allocPersistent(joints * ROWS)
  const out = store ? store.poses : scratchRows(joints)
  const base = store ? st.poseBase * 4 : 0
  samplePose(world, st.entity, st.pose, out, base, st.radii, st.sphere)
  if (store) store.markPersistent(st.poseBase, joints * ROWS)
  return joints
}

let rowsScratch = new Float32Array(0)
function scratchRows(joints: number): Float32Array {
  if (rowsScratch.length < joints * 12) rowsScratch = new Float32Array(joints * 12)
  return rowsScratch
}

/** Moves a character to another tier: rig, sampling mode, pose source and what's drawn. */
function changeTier(world: World, st: CharacterState, to: number, now: number): void {
  const from = st.tier
  const store = world.tryResource(Instances)?.deform
  captureIk(world, st)
  if (from === NEAR) {
    returnRig(world, st)
    setSampling(world, st.entity, false)
    st.ik = 0
    setIkWeights(world, st, 0)
  }
  // Far needs a bake to draw; headless, nothing draws, so far stays far.
  if (to === FAR && store && !farReady(world, st)) to = MID
  st.joining = false
  if (to !== MID && to !== NEAR && store && st.poseBase >= 0) {
    store.freePersistent(st.poseBase, st.rig.skeleton.paths.length * ROWS)
    st.poseBase = -1
  }
  if (to !== FAR && store && st.header >= 0) {
    store.freePersistent(st.header, 3)
    st.header = -1
  }
  st.tier = to
  st.since = now
  if (to === NEAR) {
    // This frame draws the flat pose (sampled now); the rig, bound from rest, takes over next
    // frame once the player has sampled it.
    sampleNow(world, store, st)
    checkoutRig(world, st)
    setSampling(world, st.entity, true)
    st.ik = 0
    setIkWeights(world, st, 0)
    st.joining = true
    for (const part of st.parts) {
      if (store) {
        setSource(world, st, part, SOURCE_POSE, st.poseBase)
        setSphere(world, part, st.sphere)
      } else setSource(world, st, part, SOURCE_JOINTS, 0)
    }
  } else if (to === MID) {
    if (store) {
      sampleNow(world, store, st)
      // Staggered: characters entering together don't resample on the same frames.
      st.wait = 1 + st.phase
      for (const part of st.parts) {
        setSource(world, st, part, SOURCE_POSE, st.poseBase)
        setSphere(world, part, st.sphere)
      }
    }
  } else if (to === FAR && store) {
    if (st.header < 0) st.header = store.allocPersistent(3)
    st.farKey = Number.NaN
    writeHeader(world, store, st)
    const bake = st.rig.builds[st.build]!.bake!
    for (const part of st.parts) {
      setSource(world, st, part, SOURCE_BAKED, st.header)
      setSphere(world, part, bake.sphere)
    }
    if (st.merged !== null) {
      setSource(world, st, st.merged, SOURCE_BAKED, st.header)
      setSphere(world, st.merged, bake.sphere)
    }
  }
  // What's drawn: parts by their minTier, the merged body only at far.
  for (let p = 0; p < st.parts.length; p++) {
    const drawn =
      to !== OFF &&
      to <= st.partMin[p]! &&
      !(to === FAR && st.partMerged[p] === 1 && st.merged !== null)
    setVisible(world, st.parts[p]!, drawn)
  }
  if (st.merged !== null) setVisible(world, st.merged, to === FAR)
}

/** A character that entered near last frame: its player has sampled the rig, so parts skin by it. */
function finishJoin(world: World, st: CharacterState): void {
  st.joining = false
  for (const part of st.parts) setSource(world, st, part, SOURCE_JOINTS, 0)
  const store = world.tryResource(Instances)?.deform
  if (store && st.poseBase >= 0) {
    store.freePersistent(st.poseBase, st.rig.skeleton.paths.length * ROWS)
    st.poseBase = -1
  }
}

function farReady(world: World, st: CharacterState): boolean {
  return ensureBake(world, st.rig, st.build) !== undefined
}

/**
 * Per frame after selection: resamples mid characters that are due (by screen size, staggered),
 * refreshes far playback headers whose layers changed, and runs the clock.
 */
export const sampleTiers = defineSystem({
  name: 'characters/sample',
  description:
    'Samples mid characters into their pose ranges at their rates, and keeps far characters’ baked playback in step with their layers.',
  setup: (world) => ({
    chars: world.query({ with: [Character, CharacterTier, AnimationPlayer, GlobalTransform] }),
  }),
  run: ({ chars }, world, ctx) => {
    const t0 = performance.now()
    const states = world.tryResource(CharacterStates)
    const store = world.tryResource(Instances)?.deform
    const holder = world.tryResource(TierRunResource)
    if (!states || !store || !holder?.run) return
    const run = holder.run
    const time = world.resource(Time)
    // The clock: rebased past REBASE seconds, which re-encodes every far header.
    let clock = time.elapsed - run.clockBase
    let rebased = false
    if (clock >= REBASE) {
      run.clockBase += REBASE
      clock -= REBASE
      rebased = true
    }
    store.setClock(clock)
    let sampled = 0
    for (let t = 0; t < chars.tables.length; t++) {
      const table = chars.tables[t]!
      const screen = table.column(CharacterTier, 'screen')
      const layerLists = table.column(AnimationPlayer, 'layers') as AnimationLayerValue[][]
      const g = table.column(GlobalTransform, 'matrix')
      const moved = table.changedTicks(GlobalTransform)
      for (let i = 0; i < table.count; i++) {
        const st = states.get(table.entities[i]!)
        if (!st) continue
        // Drawn parts follow the root (they're not its children): when it moved, or just swapped.
        if (st.tier !== OFF && (moved[i]! > ctx.lastRunTick || st.since === time.elapsed)) {
          followRoot(world, st, g, i * 12)
        }
        if (st.tier === MID) {
          if (st.wait > 0) {
            st.wait--
            continue
          }
          sampled += sampleNow(world, store, st)
          for (let p = 0; p < st.parts.length; p++) setSphere(world, st.parts[p]!, st.sphere)
          const r = st.rig.midRates
          st.wait = (screen[i]! >= r[0] ? 1 : screen[i]! >= r[1] ? 2 : 4) - 1
        } else if (st.tier === FAR) {
          if (rebased) st.farKey = Number.NaN
          if (farKey(st, layerLists[i]!) !== st.farKey) writeHeader(world, store, st)
        }
      }
    }
    run.stats.jointsSampled = sampled
    run.stats.sampleMs = performance.now() - t0
  },
})

/** Copies the root's world matrix into the parts this tier draws (they have no parent). */
function followRoot(world: World, st: CharacterState, g: Float32Array, o: number): void {
  const tick = world.tick
  for (let p = 0; p < st.parts.length; p++) {
    const drawn =
      st.tier <= st.partMin[p]! &&
      !(st.tier === FAR && st.partMerged[p] === 1 && st.merged !== null)
    if (drawn) copyGlobal(world, st.parts[p]!, g, o, tick)
  }
  if (st.merged !== null && st.tier === FAR) copyGlobal(world, st.merged, g, o, tick)
}

function copyGlobal(world: World, e: Entity, g: Float32Array, o: number, tick: number): void {
  const table = world.entityTableUnchecked(e)
  const row = world.entityRowUnchecked(e)
  const m = table.column(GlobalTransform, 'matrix')
  for (let k = 0; k < 12; k++) m[row * 12 + k] = g[o + k]!
  table.changedTicks(GlobalTransform)[row] = tick
  table.touch(GlobalTransform)
}

// --- far playback ------------------------------------------------------------------------------

const pick = new Int32Array(2)

/**
 * Clip A and clip B for the header, as layer indices in `pick` (-1: none): the two heaviest
 * override layers whose clips are baked. B is the one rising in a crossfade (else the lighter), so
 * the GPU's fade is B's share going up.
 */
function chooseAB(st: CharacterState, layers: AnimationLayerValue[], bake: BuildBake): void {
  pick[0] = -1
  pick[1] = -1
  let w0 = -1
  let w1 = -1
  for (let li = 0; li < layers.length; li++) {
    const l = layers[li]!
    if (l.blend === 'additive' || l.mask !== null || bakedIndex(st, bake, l) < 0) continue
    const w = l.weight
    if (w > w0) {
      pick[1] = pick[0]!
      w1 = w0
      pick[0] = li
      w0 = w
    } else if (w > w1) {
      pick[1] = li
      w1 = w
    }
  }
  if (pick[1]! < 0) return
  const a = layers[pick[0]!]!
  const b = layers[pick[1]!]!
  const aRising = a.fadeSpeed > 0 && a.fadeTo > a.weight
  const bRising = b.fadeSpeed > 0 && b.fadeTo > b.weight
  if (aRising && !bRising) {
    const t = pick[0]!
    pick[0] = pick[1]!
    pick[1] = t
  }
}

function bakedIndex(st: CharacterState, bake: BuildBake, layer: AnimationLayerValue): number {
  const guid = layer.clip?.guid
  if (guid === undefined) return -1
  let idx = st.rig.clipIndex.get(guid)
  if (idx === undefined) {
    // Resolve once by the rig's clip refs (guids are known once clips load).
    const clips = st.rig.options.clips ?? {}
    idx = -1
    for (let k = 0; k < bake.clips.length; k++) {
      if (clips[bake.clips[k]!.name]?.guid === guid) idx = k
    }
    st.rig.clipIndex.set(guid, idx)
  }
  return idx
}

/** A number that changes when what the header encodes changes (clips, speeds, fades, play). */
function farKey(st: CharacterState, layers: AnimationLayerValue[]): number {
  const bake = st.rig.builds[st.build]!.bake
  if (!bake) return 0
  chooseAB(st, layers, bake)
  let key = 17
  for (let k = 0; k < 2; k++) {
    const li = pick[k]!
    if (li < 0) {
      key = key * 31 + 7
      continue
    }
    const l = layers[li]!
    key = key * 31 + bakedIndex(st, bake, l)
    key = key * 31 + (l.playing ? l.speed : 0) * 1000
    key = key * 31 + l.fadeSpeed * 1000 + l.fadeTo
    key = key * 31 + (l.loop === 'once' ? 1 : 0)
    key %= 1e12
  }
  return key
}

/** Encodes the header from the layers' current times (frame units), so the GPU plays on alone. */
function writeHeader(world: World, store: DeformStore, st: CharacterState): void {
  const bake = st.rig.builds[st.build]!.bake
  if (!bake || st.header < 0) return
  const table = world.entityTableUnchecked(st.entity)
  const row = world.entityRowUnchecked(st.entity)
  const layers = (table.column(AnimationPlayer, 'layers') as AnimationLayerValue[][])[row]!
  chooseAB(st, layers, bake)
  const clock = store.poses[0]!
  const p = store.poses
  const o = st.header * 4
  let flags = 0
  for (let k = 0; k < 2; k++) {
    const li = pick[k]!
    const h = o + k * 4
    if (li < 0) {
      // No clip: B absent; A holds the first baked clip's first frame.
      if (k === 0) {
        const c = bake.clips[0]!
        p[h] = c.base
        p[h + 1] = c.frames
        p[h + 2] = 0
        p[h + 3] = 0
      } else {
        p[h] = 0
        p[h + 1] = 0
        p[h + 2] = 0
        p[h + 3] = 0
      }
      continue
    }
    const l = layers[li]!
    const c = bake.clips[bakedIndex(st, bake, l)]!
    // Frame units: frames - 1 intervals span the clip's duration exactly.
    const rate = c.duration > 0 ? (c.frames - 1) / c.duration : 0
    const speed = (l.playing ? l.speed : 0) * rate
    p[h] = c.base
    p[h + 1] = c.frames
    p[h + 2] = l.time * rate - clock * speed
    p[h + 3] = speed
    if (l.loop === 'once') flags |= 1 << k
  }
  // B's share: a fade in progress runs on the GPU; a steady blend is a fixed weight.
  let fadeStart = 0
  let fadeDuration = 0
  if (pick[1]! >= 0) {
    const a = layers[pick[0]!]!
    const b = layers[pick[1]!]!
    const total = a.weight + b.weight
    const wB = total > 0 ? b.weight / total : 0
    if (b.fadeSpeed > 0 && b.fadeTo > b.weight) {
      // A symmetric crossfade: B's share rises at its fade speed.
      fadeDuration = 1 / b.fadeSpeed
      fadeStart = clock - wB * fadeDuration
    } else {
      fadeDuration = 1e6
      fadeStart = clock - wB * fadeDuration
    }
  }
  p[o + 8] = 1
  p[o + 9] = fadeStart
  p[o + 10] = fadeDuration
  p[o + 11] = flags
  store.markPersistent(st.header, 3)
  st.farKey = farKey(st, layers)
}
