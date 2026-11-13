import { defineSystem, type Entity, type Table, type World } from '@aethervtt/shard-core'
import { CharacterController, CharacterSuspended } from '@aethervtt/shard-physics'
import { FixedTime } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { gateLeg, navAgentAt, setNavMover } from './breach'
import {
  NavAgent,
  NavAgentState,
  NavArrived,
  NavBudget,
  NavTier,
  NavUnreachable,
} from './components'
import { type FlowField, flowAim, flowPasses, type NavFlowState } from './flow'
import { NavFlows } from './flow-state'
import type { NavMeshRuntime } from './navmesh'
import { createNavPath, findPath } from './query'
import type { Recast } from './recast'
import { type AgentRecord, Nav, type NavState } from './state'
import { NavMovers } from './steer-state'
import { moveAlong, nearestPoly, polyHeight, raycast, surf } from './surface'

// Movement tiers (0115). Near players, agents walk in Detour's crowd (nav/agents). Further out,
// nav/steer moves them itself: every 1/steerHz s (staggered by entity) it plans legs along the
// path's corners, or along a flow field's portals, with Detour's moveAlongSurface, and every fixed
// step it moves the Transform along those legs, with no Detour call. Coarse agents do the same at
// coarseHz without separation. Below the crowd the Transform is the drive, and a
// CharacterController is suspended (physics/CharacterSuspended).

type RFilter = InstanceType<Recast['QueryFilter']>

const CROWD = 0
const STEER = 1
const COARSE = 2

/** NavAgentState.status codes (AGENT_STATUSES order). */
const MOVING = 1
const ARRIVED = 2
const UNREACHABLE = 3
const BLOCKED = 4
/** Polygons ahead on a flow route checked for a gate the agent breaches. */
const GATE_LOOKAHEAD = 8
/** A leg's corners: the path's up to legCount, then legEnd (scratch). */
let legCorners = new Float64Array(3 * 130)

/** Legs a decision plans at most (corners or portals passed in one interval). */
const LEGS = 6
/** How far separation looks, in combined radii. */
const SEPARATION = 1.5

/** One agent nav/steer may move: its tier, where its legs go, and its place on the surface. */
export class Mover {
  readonly entity: Entity
  /** The tier it moves at (CROWD: nav/agents' crowd has it). */
  tier = CROWD
  /** nav/steer moves it (it handed it to itself with setNavMover). */
  owned = false
  /** Decide on its next step (taken over, or its tier changed). */
  think = true
  /** Its surface polygon and point where the legs end, and its height above the surface. */
  ref = 0
  readonly at = new Float64Array(3)
  lift = 0
  /** Leg points (x, y, z) and the time each is reached, since the decision. */
  readonly legs = new Float64Array((LEGS + 1) * 3)
  readonly times = new Float64Array(LEGS + 1)
  count = 0
  seg = 0
  tau = 0
  /** Decisions in a row that got (almost) nowhere along its corners: 3 plan it again. */
  stuck = 0
  /** Following a findPath path to its flow field's goal (outside the field). */
  fallback = false
  readonly fallbackGoal = new Float64Array(3)

  constructor(entity: Entity) {
    this.entity = entity
  }
}

export class NavMoverState {
  readonly movers = new Map<Entity, Mover>()
  /** Agents joined to and left the crowd since start, and the last step's joins. */
  joins = 0
  leaves = 0
  lastJoins = 0
  /** findPath calls nav/steer made (flow agents outside their field). */
  fallbacks = 0

  drop(entity: Entity): void {
    this.movers.delete(entity)
  }
}

// --- tiers -------------------------------------------------------------------------

/**
 * Applies NavTier (0115): agents below the crowd go to nav/steer (setNavMover 'external', and a
 * CharacterController is suspended); agents coming back join the crowd, at most NavBudget.joins a
 * step and up to NavBudget.crowd per navmesh. Those not admitted yet keep steering.
 */
export const navTiers = defineSystem({
  name: 'nav/tiers',
  description:
    'Moves NavAgents between movement tiers (NavTier): crowd joins capped at NavBudget.joins a step and NavBudget.crowd per navmesh, CharacterSuspended below the crowd.',
  setup: (world) => ({
    query: world.query({ with: [NavAgent, Transform] }),
    navs: new Float64Array(8),
    counts: new Int32Array(8),
    meshes: 0,
    suspend: [] as Entity[],
    resume: [] as Entity[],
  }),
  run: (s, world) => {
    const nav = world.tryResource(Nav)
    if (!nav?.R) return
    const movers = world.resource(NavMovers)
    const budget = world.tryResource(NavBudget)
    let joins = budget?.joins ?? 8
    const cap = budget?.crowd ?? 128
    // Crowd agents per navmesh.
    s.meshes = 0
    for (let t = 0; t < s.query.tables.length; t++) {
      const table = s.query.tables[t]!
      for (let row = 0; row < table.count; row++) {
        const e = table.entities[row]!
        const rec = nav.agents.get(e)
        if (rec?.kind === 'mesh' && !nav.external.has(e)) s.counts[slot(s, rec.nav)]!++
      }
    }
    s.suspend.length = 0
    s.resume.length = 0
    movers.lastJoins = 0
    for (let t = 0; t < s.query.tables.length; t++) {
      const table = s.query.tables[t]!
      const tiered = table.has(NavTier)
      const tiers = tiered ? (table.column(NavTier, 'tier') as Uint8Array) : null
      const character = table.has(CharacterController)
      const suspended = table.has(CharacterSuspended)
      const stopped = table.column(NavAgent, 'stopped') as Uint8Array
      for (let row = 0; row < table.count; row++) {
        const e = table.entities[row]!
        let m = movers.movers.get(e)
        if (!tiers && !m) continue
        const rec = nav.agents.get(e)
        // Grid agents steer themselves, and framed navmeshes (0043) keep the crowd.
        let want = tiers ? tiers[row]! : CROWD
        if (rec && (rec.kind === 'grid' || rec.framed)) want = CROWD
        // An agent about to enter the crowd for the first time joins like any other: within the
        // step's joins and the navmesh's crowd, or it steers until admitted.
        if (
          want === CROWD &&
          !m?.owned &&
          stopped[row] !== 1 &&
          !nav.external.has(e) &&
          (rec === undefined || (rec.kind === 'mesh' && rec.crowdIndex < 0))
        ) {
          const k = slot(s, rec ? rec.nav : -1)
          if (joins > 0 && s.counts[k]! < cap) {
            joins--
            if (!rec) s.counts[k]!++
            movers.lastJoins++
            continue
          }
          want = STEER
        }
        if (want !== CROWD) {
          if (!m) {
            m = new Mover(e)
            movers.movers.set(e, m)
          }
          if (!m.owned) {
            const was = rec?.kind === 'mesh' && !nav.external.has(e)
            m.owned = true
            m.think = true
            m.ref = 0
            m.count = 0
            m.lift = -1
            m.fallback = false
            setNavMover(world, e, 'external')
            movers.leaves++
            // Its path was made where it started, and the crowd took it elsewhere since: plan
            // again from here (flow agents follow their field instead).
            if (was && rec!.flow < 0) rec!.navVersion = -1
            if (was) s.counts[slot(s, rec!.nav)]!--
            if (character && !suspended) s.suspend.push(e)
          }
          if (m.tier !== want) {
            m.tier = want
            m.think = true
          }
        } else if (m?.owned) {
          const k = slot(s, rec ? rec.nav : -1)
          if (joins > 0 && s.counts[k]! < cap) {
            joins--
            s.counts[k]!++
            m.owned = false
            m.tier = CROWD
            m.count = 0
            setNavMover(world, e, 'crowd')
            movers.joins++
            movers.lastJoins++
            if (suspended) s.resume.push(e)
          } else if (m.tier !== STEER) {
            // Waiting to be admitted: it keeps steering.
            m.tier = STEER
            m.think = true
          }
        }
      }
    }
    for (let i = 0; i < s.suspend.length; i++) world.add(s.suspend[i]!, CharacterSuspended)
    for (let i = 0; i < s.resume.length; i++) world.remove(s.resume[i]!, CharacterSuspended)
  },
})

type TierState = ReturnType<NonNullable<typeof navTiers.setup>>

/** The count slot for navmesh `nav` (a handful of navmeshes: a linear search). */
function slot(s: TierState, nav: number): number {
  for (let i = 0; i < s.meshes; i++) if (s.navs[i] === nav) return i
  if (s.meshes === s.navs.length) {
    const navs = new Float64Array(s.navs.length * 2)
    navs.set(s.navs)
    s.navs = navs
    const counts = new Int32Array(s.counts.length * 2)
    counts.set(s.counts)
    s.counts = counts
  }
  s.navs[s.meshes] = nav
  s.counts[s.meshes] = 0
  return s.meshes++
}

// --- steer and coarse ------------------------------------------------------------------

interface Columns {
  speed: Float32Array
  radius: Float32Array
  stopping: Float32Array
  stopped: Uint8Array
  filter: string[]
  status: Uint8Array
  remaining: Float32Array
  corners: Uint16Array
  velocity: Float32Array
  translation: Float32Array
}

function columns(table: Table, out: Columns): void {
  out.speed = table.column(NavAgent, 'speed') as Float32Array
  out.radius = table.column(NavAgent, 'radius') as Float32Array
  out.stopping = table.column(NavAgent, 'stoppingDistance') as Float32Array
  out.stopped = table.column(NavAgent, 'stopped') as Uint8Array
  out.filter = table.column(NavAgent, 'filter') as unknown as string[]
  out.status = table.column(NavAgentState, 'status') as Uint8Array
  out.remaining = table.column(NavAgentState, 'remaining') as Float32Array
  out.corners = table.column(NavAgentState, 'corners') as Uint16Array
  out.velocity = table.column(NavAgentState, 'velocity') as Float32Array
  out.translation = table.column(Transform, 'translation') as Float32Array
}

/**
 * Moves the agents below the crowd (0115). Each decides every 1/steerHz s (coarse: 1/coarseHz),
 * staggered by entity: seek the next corner (arrive at the last) or the next portal of its flow
 * field, push apart from crowd and steer agents nearby (steer only), and plan legs over the
 * interval with moveAlongSurface and the surface's height. Every fixed step moves the Transform
 * along the legs.
 */
export const navSteer = defineSystem({
  name: 'nav/steer',
  description:
    'Moves NavAgents below the crowd (NavTier steer and coarse): decisions every 1/steerHz or 1/coarseHz s along path corners or flow field portals with Detour moveAlongSurface, then the Transform along the legs every step.',
  setup: (world) => ({
    query: world.query({ with: [NavAgent, NavAgentState, Transform] }),
    cols: {} as Columns,
    step: 0,
    find: { out: createNavPath(128), filter: '', nav: null as Entity | null },
    // Separation: every navmesh agent's position, radius and navmesh, bucketed in a spatial hash.
    hx: new Float64Array(256),
    hz: new Float64Array(256),
    hr: new Float64Array(256),
    hnav: new Float64Array(256),
    heads: new Int32Array(4096),
    next: new Int32Array(256),
    count: 0,
    cell: 1,
  }),
  run: (s, world) => {
    const nav = world.tryResource(Nav)
    if (!nav?.R) return
    const movers = world.resource(NavMovers)
    if (movers.movers.size === 0) return
    const flows = world.tryResource(NavFlows)
    const dt = world.resource(FixedTime).step
    const budget = world.tryResource(NavBudget)
    const steerPeriod = Math.max(1, Math.round(1 / ((budget?.steerHz ?? 10) * dt)))
    const coarsePeriod = Math.max(1, Math.round(1 / ((budget?.coarseHz ?? 2) * dt)))
    s.step++
    if (flows) for (let i = 0; i < flows.list.length; i++) flows.list[i]!.agents = 0
    buildHash(s, nav)
    for (let t = 0; t < s.query.tables.length; t++) {
      const table = s.query.tables[t]!
      columns(table, s.cols)
      let moved = false
      for (let row = 0; row < table.count; row++) {
        const e = table.entities[row]!
        const rec = nav.agents.get(e)
        if (!rec) continue
        if (rec.flow >= 0 && flows) {
          const f = flows.fields.get(rec.flow as Entity)
          if (f) f.agents++
        }
        const m = movers.movers.get(e)
        if (!m?.owned || rec.kind !== 'mesh' || !rec.external) continue
        const rt = nav.meshes.get(rec.nav)
        if (!rt) continue
        moved = true
        if (s.cols.stopped[row] === 1) {
          // nav/agents set it idle; it stands.
          stand(s, row, m, false)
          continue
        }
        const period = m.tier === COARSE ? coarsePeriod : steerPeriod
        const phase = (s.step + e) % period
        if (m.think || phase === 0) {
          // Plan to the next regular decision, so the legs end where the agent then stands.
          const steps = phase === 0 ? period : period - phase
          think(s, world, nav, flows, rt, rec, m, row, steps * dt)
          m.think = false
        }
        integrate(s, m, row, dt)
      }
      if (moved) {
        table.markChanged(Transform)
        table.markChanged(NavAgentState)
      }
    }
  },
})

type SteerState = ReturnType<NonNullable<typeof navSteer.setup>>

function buildHash(s: SteerState, nav: NavState): void {
  let n = 0
  let maxR = 0.1
  for (let t = 0; t < s.query.tables.length; t++) {
    const table = s.query.tables[t]!
    const tr = table.column(Transform, 'translation') as Float32Array
    const radius = table.column(NavAgent, 'radius') as Float32Array
    for (let row = 0; row < table.count; row++) {
      const rec = nav.agents.get(table.entities[row]!)
      if (rec?.kind !== 'mesh') continue
      if (n === s.hx.length) {
        s.hx = grow(s.hx)
        s.hz = grow(s.hz)
        s.hr = grow(s.hr)
        s.hnav = grow(s.hnav)
        const next = new Int32Array(s.next.length * 2)
        next.set(s.next)
        s.next = next
      }
      s.hx[n] = tr[row * 3]!
      s.hz[n] = tr[row * 3 + 2]!
      s.hr[n] = radius[row]!
      s.hnav[n] = rec.nav
      if (radius[row]! > maxR) maxR = radius[row]!
      n++
    }
  }
  s.count = n
  s.cell = maxR * 2 * SEPARATION
  s.heads.fill(-1)
  for (let i = 0; i < n; i++) {
    const h = hashCell(Math.floor(s.hx[i]! / s.cell), Math.floor(s.hz[i]! / s.cell))
    s.next[i] = s.heads[h]!
    s.heads[h] = i
  }
}

function grow(a: Float64Array): Float64Array<ArrayBuffer> {
  const b = new Float64Array(a.length * 2)
  b.set(a)
  return b
}

const hashCell = (x: number, z: number) => (Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) & 4095

/** Separation push (x, z) for an agent at (x, z) with radius r on navmesh `navE`. */
const push = new Float64Array(2)

function separation(
  s: SteerState,
  x: number,
  z: number,
  r: number,
  navE: number,
  speed: number,
): void {
  push[0] = 0
  push[1] = 0
  const cs = s.cell
  const cx = Math.floor(x / cs)
  const cz = Math.floor(z / cs)
  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (let j = s.heads[hashCell(cx + ox, cz + oz)]!; j !== -1; j = s.next[j]!) {
        if (s.hnav[j] !== navE) continue
        const ax = x - s.hx[j]!
        const az = z - s.hz[j]!
        const min = (r + s.hr[j]!) * SEPARATION
        const dd = ax * ax + az * az
        if (dd >= min * min || dd < 1e-12) continue
        const dist = Math.sqrt(dd)
        const k = ((min - dist) / min) * speed * 2
        push[0] += (ax / dist) * k
        push[1] += (az / dist) * k
      }
    }
  }
}

/**
 * The walk filter: the polygons a steer agent may enter. A breaching filter's walk variant
 * (0114) excludes its breach states too, so nothing moves a steer agent through a shut door.
 */
function walkFilter(rt: NavMeshRuntime, rec: AgentRecord): RFilter {
  return rt.walkFilter(rec.filter)
}

/** Where the agent heads next (flowAim). */
const aim = new Float64Array(3)
const flowGoalPoint = new Float64Array(3)

function setStatus(
  world: World,
  s: SteerState,
  row: number,
  rec: AgentRecord,
  status: number,
): void {
  // Corner walkers' status is nav/agents' stepExternal's (0114), from legEnd; a flow agent's is ours.
  if (rec.flow < 0) return
  s.cols.status[row] = status
  if (status === rec.status) return
  rec.status = status
  if (status === ARRIVED) world.send(NavArrived, { entity: rec.entity })
  else if (status === UNREACHABLE) world.send(NavUnreachable, { entity: rec.entity })
}

/**
 * It stands: on its surface point when `snap` (decided this step, so the legs start there), else
 * where it is.
 */
function stand(s: SteerState, row: number, m: Mover, snap = true): void {
  m.count = snap ? 1 : 0
  const v = s.cols.velocity
  v[row * 3] = 0
  v[row * 3 + 1] = 0
  v[row * 3 + 2] = 0
}

/** Starts the legs at the agent's surface point. */
function legsFrom(m: Mover): void {
  m.legs[0] = m.at[0]!
  m.legs[1] = m.at[1]!
  m.legs[2] = m.at[2]!
  m.times[0] = 0
  m.count = 1
  m.seg = 0
  m.tau = 0
}

/** One decision: where the agent is on the surface, where it heads, and its legs for `span` s. */
function think(
  s: SteerState,
  world: World,
  nav: NavState,
  flows: NavFlowState | undefined,
  rt: NavMeshRuntime,
  rec: AgentRecord,
  m: Mover,
  row: number,
  span: number,
): void {
  const c = s.cols
  const tr = c.translation
  const px = tr[row * 3]!
  const py = tr[row * 3 + 1]!
  const pz = tr[row * 3 + 2]!
  const filter = walkFilter(rt, rec)
  // Its place on the surface: where its legs ended, unless it was moved, taken over, or decides
  // before its legs ran out (its tier changed).
  const off = (px - m.at[0]!) ** 2 + (pz - m.at[2]!) ** 2
  const midway = m.count > 1 && m.tau < m.times[m.count - 1]! - 1e-9
  if (m.ref === 0 || midway || off > 1e-4 || !rt.navMesh.isValidPolyRef(m.ref)) {
    const below = m.lift > 0 ? m.lift : 0
    if (!nearestPoly(rt, filter, px, py - below, pz, 1, rt.settings.agentHeight * 1.5)) {
      stand(s, row, m, false)
      return
    }
    m.ref = surf.ref
    m.at[0] = surf.x
    m.at[1] = surf.y
    m.at[2] = surf.z
    if (m.lift < 0) m.lift = Math.max(0, py - surf.y)
  }
  legsFrom(m)
  // Waiting in a slot at a shut gate (0114): it stands until the gate passes its filter.
  if (rec.status === BLOCKED) {
    stand(s, row, m)
    if (rec.flow >= 0) c.status[row] = BLOCKED
    return
  }
  const speed = c.speed[row]!
  const radius = c.radius[row]!
  const stopping = c.stopping[row]!
  // A flow agent heads along its field while it's in it; outside, along a findPath path.
  let f: FlowField | undefined
  let node = -1
  if (rec.flow >= 0 && flows) {
    f = flows.fields.get(rec.flow as Entity)
    if (f && f.rt === rt && f.cur && f.graph) {
      const n = f.graph.node(m.ref)
      if (f.cur.has(n)) node = n
    }
    if (node < 0 && f && (f.pending() || !f.graph)) {
      // A build is on its way: wait for it rather than path alone.
      stand(s, row, m)
      setStatus(world, s, row, rec, MOVING)
      return
    }
    if (node < 0 && !fallback(s, world, rt, rec, m, f)) {
      stand(s, row, m)
      setStatus(world, s, row, rec, UNREACHABLE)
      return
    }
    if (node >= 0) m.fallback = false
  }
  // A flow agent at a gate it breaches walks its leg there (0114) until the gate lets it on.
  if (node >= 0 && rec.leg < 0)
    flowLegs(s, world, nav, rt, rec, m, f!, node, filter, row, speed, radius, stopping, span)
  else cornerLegs(s, world, rt, rec, m, filter, row, speed, radius, stopping, span)
}

/** A flow agent outside its field paths to the field's goal with findPath (counted). */
function fallback(
  s: SteerState,
  world: World,
  rt: NavMeshRuntime,
  rec: AgentRecord,
  m: Mover,
  f: FlowField | undefined,
): boolean {
  const goal = flowGoalPoint
  if (!f) return false
  goal.set(f.cur ? f.cur.goal : f.want)
  const dx = goal[0]! - m.fallbackGoal[0]!
  const dz = goal[2]! - m.fallbackGoal[2]!
  if (m.fallback && rec.count > 0 && dx * dx + dz * dz <= 4) return true
  s.find.filter = rec.filter && rt.named.has(rec.filter) ? rec.filter : ''
  s.find.nav = rt.entity
  const path = findPath(world, m.at, goal, s.find)
  rec.paths++
  if (f) f.fallbacks++
  world.resource(NavMovers).fallbacks++
  rec.corners.set(path.corners.subarray(0, path.count * 3))
  rec.count = path.count
  rec.next = 1
  rec.reachable = path.status === 'complete'
  // Its leg is the whole path (0114's legs come from plan(), which a flow agent skips).
  rec.leg = -1
  rec.legCount = path.count
  if (path.count > 0) {
    const e = (path.count - 1) * 3
    rec.legEnd[0] = path.corners[e]!
    rec.legEnd[1] = path.corners[e + 1]!
    rec.legEnd[2] = path.corners[e + 2]!
  }
  m.fallback = true
  m.fallbackGoal.set(goal)
  return path.count > 0
}

/** The last leg added: its length, and whether it slid along an edge (1). */
const legOut = new Float64Array(2)

/**
 * Adds a leg from the last point toward (tx, ty, tz) along the surface (`legOut`); false when
 * Detour couldn't move from there.
 */
function leg(
  rt: NavMeshRuntime,
  filter: RFilter,
  m: Mover,
  tx: number,
  ty: number,
  tz: number,
  speed: number,
): boolean {
  const o = (m.count - 1) * 3
  const lx = m.legs[o]!
  const ly = m.legs[o + 1]!
  const lz = m.legs[o + 2]!
  if (!moveAlong(rt, filter, m.ref, lx, ly, lz, tx, ty, tz)) return false
  let rx = surf.x
  let rz = surf.z
  let ref = surf.ref
  const slid = (rx - tx) ** 2 + (rz - tz) ** 2 > 1e-4
  if (
    slid &&
    raycast(rt, filter, m.ref, lx, ly, lz, rx, ly, rz) &&
    surf.t < 1 &&
    surf.t * Math.sqrt((rx - lx) ** 2 + (rz - lz) ** 2) > 0.05
  ) {
    // It slid round a corner: the straight line to where it ended would cut it, so it stops
    // where the line leaves the surface. (From right on an edge, the slide runs along it.)
    const k = surf.t * 0.9
    const cx = lx + (rx - lx) * k
    const cz = lz + (rz - lz) * k
    if (!moveAlong(rt, filter, m.ref, lx, ly, lz, cx, ly, cz)) return false
    rx = surf.x
    rz = surf.z
    ref = surf.ref
  }
  let ry = ly
  if (polyHeight(rt, ref, rx, ly, rz)) ry = surf.y
  push3(m, rx, ry, rz, ref, speed)
  legOut[1] = slid ? 1 : 0
  return true
}

/** Appends a leg point reached at `speed`, its length into `legOut[0]`. */
function push3(m: Mover, x: number, y: number, z: number, ref: number, speed: number): void {
  const o = (m.count - 1) * 3
  const dx = x - m.legs[o]!
  const dz = z - m.legs[o + 2]!
  const len = Math.sqrt(dx * dx + dz * dz)
  const n = m.count * 3
  m.legs[n] = x
  m.legs[n + 1] = y
  m.legs[n + 2] = z
  m.times[m.count] = m.times[m.count - 1]! + (speed > 0 ? len / speed : 0)
  m.count++
  m.ref = ref
  m.at[0] = x
  m.at[1] = y
  m.at[2] = z
  legOut[0] = len
  legOut[1] = 0
}

/** Legs along the path's corners (0114: the leg's corners up to rec.legCount, then rec.legEnd). */
function cornerLegs(
  s: SteerState,
  world: World,
  rt: NavMeshRuntime,
  rec: AgentRecord,
  m: Mover,
  filter: RFilter,
  row: number,
  speed: number,
  radius: number,
  stopping: number,
  span: number,
): void {
  const c = s.cols
  // The leg (0114): the path's corners up to legCount, then legEnd (a gate's entry or its slot).
  const count = rec.legCount > 0 ? rec.legCount + 1 : 0
  if (legCorners.length < count * 3) legCorners = new Float64Array(count * 6)
  const corners = legCorners
  for (let i = 0; i < rec.legCount * 3; i++) corners[i] = rec.corners[i]!
  corners[rec.legCount * 3] = rec.legEnd[0]!
  corners[rec.legCount * 3 + 1] = rec.legEnd[1]!
  corners[rec.legCount * 3 + 2] = rec.legEnd[2]!
  if (count === 0) {
    stand(s, row, m)
    setStatus(world, s, row, rec, UNREACHABLE)
    c.remaining[row] = 0
    c.corners[row] = 0
    return
  }
  const x = m.at[0]!
  const z = m.at[2]!
  // Past a corner: on it, or near it and beyond it toward the next one (a corner hugs an edge,
  // and turning early would cut across it).
  const reach = Math.max(stopping, radius * 0.5, 0.05)
  while (rec.next < count - 1) {
    const o = rec.next * 3
    const dx = x - corners[o]!
    const dz = z - corners[o + 2]!
    const dd = dx * dx + dz * dz
    if (dd > reach * reach) break
    const beyond = dx * (corners[o + 3]! - corners[o]!) + dz * (corners[o + 5]! - corners[o + 2]!)
    if (dd > 0.0025 && beyond < 0) break
    rec.next++
  }
  if (rec.next >= count) rec.next = count - 1
  let remaining = 0
  {
    let lx = x
    let lz = z
    for (let i = rec.next; i < count; i++) {
      const dx = corners[i * 3]! - lx
      const dz = corners[i * 3 + 2]! - lz
      remaining += Math.sqrt(dx * dx + dz * dz)
      lx = corners[i * 3]!
      lz = corners[i * 3 + 2]!
    }
  }
  c.remaining[row] = remaining
  c.corners[row] = count - rec.next
  if (rec.next === count - 1 && remaining <= stopping) {
    // At a gate's entry or slot (0114): tell nav it stands there, coarse steps or not.
    if (rec.leg >= 0) navAgentAt(world, rec.entity)
    stand(s, row, m)
    setStatus(world, s, row, rec, rec.reachable ? ARRIVED : UNREACHABLE)
    return
  }
  let budget = Math.min(speed * span, remaining)
  for (let k = 0; k < LEGS && budget > 1e-4; k++) {
    const i = rec.next
    const o = (m.count - 1) * 3
    const lx = m.legs[o]!
    const ly = m.legs[o + 1]!
    const lz = m.legs[o + 2]!
    let dx = corners[i * 3]! - lx
    let dz = corners[i * 3 + 2]! - lz
    const d = Math.sqrt(dx * dx + dz * dz)
    let step = Math.min(budget, d)
    if (d > 1e-6) {
      dx /= d
      dz /= d
    }
    let bent = false
    if (k === 0 && m.tier === STEER) bent = bend(s, rec, lx, lz, radius, speed, dx, dz)
    if (bent) {
      dx = bentDir[0]!
      dz = bentDir[1]!
      step = Math.min(budget, d > 0 ? d : budget) * bentDir[2]!
    }
    if (!leg(rt, filter, m, lx + dx * step, ly, lz + dz * step, speed)) break
    budget -= legOut[0]!
    // Stop after sliding along an edge, after a separation push, or short of the corner.
    if (legOut[1] === 1 || bent || step < d - 1e-4) break
    if (i === count - 1) break
    rec.next++
  }
  // Corners it can't walk to from here (pushed off its path): plan again from where it is.
  const ol = (m.count - 1) * 3
  const moved = Math.sqrt((m.legs[ol]! - x) ** 2 + (m.legs[ol + 2]! - z) ** 2)
  m.stuck = moved < Math.min(speed * span, remaining) * 0.05 ? m.stuck + 1 : 0
  if (m.stuck >= 3 && rec.flow < 0) {
    m.stuck = 0
    rec.navVersion = -1
  }
  writeVelocity(s, m, row)
  setStatus(world, s, row, rec, rec.reachable ? MOVING : UNREACHABLE)
}

/** Separation: the seek direction (dx, dz) bent by pushes from neighbours (steer only). */
const bentDir = new Float64Array(3)

function bend(
  s: SteerState,
  rec: AgentRecord,
  x: number,
  z: number,
  radius: number,
  speed: number,
  dx: number,
  dz: number,
): boolean {
  separation(s, x, z, radius, rec.nav, speed)
  if (push[0] === 0 && push[1] === 0) return false
  let vx = dx * speed + push[0]!
  let vz = dz * speed + push[1]!
  const l = Math.sqrt(vx * vx + vz * vz)
  if (l < 1e-6) {
    bentDir[0] = dx
    bentDir[1] = dz
    bentDir[2] = 0
    return true
  }
  // Direction, and speed as a fraction of the agent's (pushes don't make it faster).
  vx /= l
  vz /= l
  bentDir[0] = vx
  bentDir[1] = vz
  bentDir[2] = Math.min(1, l / speed)
  return true
}

/** Legs along a flow field's portals, from polygon node `node`. */
function flowLegs(
  s: SteerState,
  world: World,
  nav: NavState,
  rt: NavMeshRuntime,
  rec: AgentRecord,
  m: Mover,
  f: FlowField,
  node: number,
  filter: RFilter,
  row: number,
  speed: number,
  radius: number,
  stopping: number,
  span: number,
): void {
  const c = s.cols
  const d = f.cur!
  const x = m.at[0]!
  const z = m.at[2]!
  c.remaining[row] = d.costAt(node, x, z)
  c.corners[row] = 0
  if (d.next[node]! < 0) {
    const gx = d.goal[0]! - x
    const gz = d.goal[2]! - z
    if (gx * gx + gz * gz <= stopping * stopping) {
      stand(s, row, m)
      setStatus(world, s, row, rec, ARRIVED)
      return
    }
  }
  // A gate a few polygons ahead on the route whose state its filter breaches (0114): its leg ends
  // at the gate's face, and the breach step claims it a slot there. The field walk resumes once
  // the gate lets it on.
  if (rec.breach !== 0) {
    const gates = f.graph!.gate
    let a = d.next[node]!
    for (let hop = 0; hop < GATE_LOOKAHEAD && a >= 0; hop++, a = d.next[a]!) {
      const owner = gates[a]!
      if (owner < 0) continue
      if (((nav.gates.byOwner.get(owner)?.flags ?? 0) & rec.breach) !== 0) {
        gateLeg(nav, rec, owner, x, m.at[1]!, z)
        cornerLegs(s, world, rt, rec, m, filter, row, speed, radius, stopping, span)
        return
      }
      break
    }
  }
  let budget = speed * span
  let n = node
  for (let k = 0; k < LEGS && budget > 1e-4; k++) {
    const ahead = d.next[n]!
    // A polygon the filter no longer passes (a gate shut since the build): wait at its portal.
    if (ahead >= 0 && !flowPasses(nav, f, ahead)) break
    const o = (m.count - 1) * 3
    const lx = m.legs[o]!
    const ly = m.legs[o + 1]!
    const lz = m.legs[o + 2]!
    const then = flowAim(d, n, lx, lz, radius, aim)
    let dx = aim[0]! - lx
    let dz = aim[2]! - lz
    const dd = Math.sqrt(dx * dx + dz * dz)
    let step = Math.min(budget, dd)
    if (dd > 1e-6) {
      dx /= dd
      dz /= dd
    }
    let bent = false
    if (k === 0 && m.tier === STEER) bent = bend(s, rec, lx, lz, radius, speed, dx, dz)
    if (bent) {
      dx = bentDir[0]!
      dz = bentDir[1]!
      step = Math.min(budget, dd > 0 ? dd : budget) * bentDir[2]!
    }
    if (step > 1e-6) {
      if (!leg(rt, filter, m, lx + dx * step, ly, lz + dz * step, speed)) break
      budget -= legOut[0]!
      // Stop after sliding along an edge, after a separation push, or short of the aim.
      if (legOut[1] === 1 || bent || step < dd - 1e-4) break
    }
    if (then < 0 || then === n) break
    n = then
  }
  writeVelocity(s, m, row)
  setStatus(world, s, row, rec, MOVING)
}

function writeVelocity(s: SteerState, m: Mover, row: number): void {
  const v = s.cols.velocity
  if (m.count < 2) {
    v[row * 3] = 0
    v[row * 3 + 1] = 0
    v[row * 3 + 2] = 0
    return
  }
  const dt = m.times[1]! - m.times[0]!
  const k = dt > 1e-9 ? 1 / dt : 0
  v[row * 3] = (m.legs[3]! - m.legs[0]!) * k
  v[row * 3 + 1] = (m.legs[4]! - m.legs[1]!) * k
  v[row * 3 + 2] = (m.legs[5]! - m.legs[2]!) * k
}

/** Moves the Transform along the legs by one fixed step; no Detour call. */
function integrate(s: SteerState, m: Mover, row: number, dt: number): void {
  if (m.count === 0) return
  if (m.count === 1) {
    const tr = s.cols.translation
    tr[row * 3] = m.legs[0]!
    tr[row * 3 + 1] = m.legs[1]! + (m.lift > 0 ? m.lift : 0)
    tr[row * 3 + 2] = m.legs[2]!
    return
  }
  m.tau += dt
  const times = m.times
  const last = m.count - 1
  while (m.seg < last - 1 && times[m.seg + 1]! < m.tau) m.seg++
  const i = m.seg
  const t0 = times[i]!
  const span = times[i + 1]! - t0
  let k = span > 1e-9 ? (m.tau - t0) / span : 1
  if (k > 1) k = 1
  const o = i * 3
  const ax = m.legs[o]!
  const ay = m.legs[o + 1]!
  const az = m.legs[o + 2]!
  const bx = m.legs[o + 3]!
  const by = m.legs[o + 4]!
  const bz = m.legs[o + 5]!
  const tr = s.cols.translation
  tr[row * 3] = ax + (bx - ax) * k
  tr[row * 3 + 1] = ay + (by - ay) * k + (m.lift > 0 ? m.lift : 0)
  tr[row * 3 + 2] = az + (bz - az) * k
  // The leg's velocity, until the legs end short of the next decision (it stands).
  const v = s.cols.velocity
  const inv = span > 1e-9 && m.tau <= times[last]! + 1e-6 ? 1 / span : 0
  v[row * 3] = (bx - ax) * inv
  v[row * 3 + 1] = (by - ay) * inv
  v[row * 3 + 2] = (bz - az) * inv
}
