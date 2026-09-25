import { defineSystem, type Entity, type Table, type World } from '@shard/core'
import { CharacterController, CharacterIntent, Physics, Velocity } from '@shard/physics'
import { FixedTime } from '@shard/runtime'
import { GlobalTransform, Transform } from '@shard/transform'
import { NavAgent, NavAgentState, NavAreas, NavArrived, NavUnreachable } from './components'
import { traceSegment } from './grid'
import type { NavMeshRuntime } from './navmesh'
import { createNavPath, findPath, type NavPath } from './query'
import { type AgentRecord, type GridRecord, Nav, type NavState } from './state'

const IDLE = 0
const MOVING = 1
const ARRIVED = 2
const UNREACHABLE = 3

const DRIVE_CHARACTER = 0
const DRIVE_TRANSFORM = 1
const DRIVE_VELOCITY = 2

/** Detour crowd update flags. */
const ANTICIPATE_TURNS = 1
const OBSTACLE_AVOIDANCE = 2
const OPTIMIZE_VIS = 8
const OPTIMIZE_TOPO = 16
/** Detour crowd agent states. */
const CROWD_OFFMESH = 2
/** Straight-path flag on a crowd corner: the path's end. */
const STRAIGHTPATH_END = 2

const CORNERS = 128

interface Columns {
  destination: Float32Array
  target: Float64Array
  speed: Float32Array
  acceleration: Float32Array
  radius: Float32Array
  stopping: Float32Array
  avoidance: Uint8Array
  repath: Float32Array
  drive: Uint8Array
  stopped: Uint8Array
  nav: Float64Array
  agentTicks: Uint32Array
  status: Uint8Array
  remaining: Float32Array
  corners: Uint16Array
  velocity: Float32Array
  translation: Float32Array
  rotation: Float32Array
}

function columns(table: Table, out: Columns): void {
  out.destination = table.column(NavAgent, 'destination') as Float32Array
  out.target = table.column(NavAgent, 'target') as Float64Array
  out.speed = table.column(NavAgent, 'speed') as Float32Array
  out.acceleration = table.column(NavAgent, 'acceleration') as Float32Array
  out.radius = table.column(NavAgent, 'radius') as Float32Array
  out.stopping = table.column(NavAgent, 'stoppingDistance') as Float32Array
  out.avoidance = table.column(NavAgent, 'avoidance') as Uint8Array
  out.repath = table.column(NavAgent, 'repathInterval') as Float32Array
  out.drive = table.column(NavAgent, 'drive') as Uint8Array
  out.stopped = table.column(NavAgent, 'stopped') as Uint8Array
  out.nav = table.column(NavAgent, 'nav') as Float64Array
  out.agentTicks = table.changedTicks(NavAgent)
  out.status = table.column(NavAgentState, 'status') as Uint8Array
  out.remaining = table.column(NavAgentState, 'remaining') as Float32Array
  out.corners = table.column(NavAgentState, 'corners') as Uint16Array
  out.velocity = table.column(NavAgentState, 'velocity') as Float32Array
  out.translation = table.column(Transform, 'translation') as Float32Array
  out.rotation = table.column(Transform, 'rotation') as Float32Array
}

function newRecord(entity: Entity): AgentRecord {
  return {
    entity,
    nav: -1,
    kind: 'none',
    crowdIndex: -1,
    corners: new Float32Array(CORNERS * 3),
    count: 0,
    next: 1,
    goal: new Float64Array(3),
    navVersion: -1,
    sinceRepath: 0,
    reachable: true,
    status: IDLE,
    agentTick: 0,
    drive: DRIVE_TRANSFORM,
    link: { active: false, lift: 0, x0: 0, z0: 0, y0: 0, x1: 0, z1: 0, y1: 0, arc: 0 },
  }
}

/** Scratch shared by one run of the system. */
const pos = new Float64Array(3)
const goal = new Float64Array(3)
const seg = new Float64Array(4)
const vec = { x: 0, y: 0, z: 0 }

/**
 * Moves every NavAgent (spec 0037): repaths when the destination changes or the target moves,
 * steers grid agents (seek, arrive, separation) and mesh agents (Detour's crowd), writes the
 * drive (CharacterIntent, Velocity, or Transform), NavAgentState, and arrival events.
 */
export const navAgents = defineSystem({
  name: 'nav/agents',
  description:
    'Steers NavAgents along paths on grids (seek, arrive, separation) and navmeshes (Detour crowd with avoidance), repaths for moving targets, writes CharacterIntent / Velocity / Transform and NavAgentState, sends NavArrived and NavUnreachable.',
  setup: (world) => ({
    query: world.query({ with: [NavAgent, NavAgentState, Transform] }),
    cols: {} as Columns,
    path: createNavPath(CORNERS),
    find: { out: undefined as NavPath | undefined, nav: null as Entity | null },
    // Grid separation: agent positions and radii this step, bucketed in a spatial hash.
    gx: new Float64Array(64),
    gy: new Float64Array(64),
    gr: new Float64Array(64),
    gnav: new Float64Array(64),
    heads: new Int32Array(1024),
    next: new Int32Array(64),
    gridCount: 0,
    cellSize: 1,
  }),
  run: (s, world, ctx) => {
    const nav = world.tryResource(Nav)
    if (!nav) return
    const dt = world.resource(FixedTime).step
    const since = ctx.lastRunTick
    const physicsDim = world.tryResource(Physics)?.dim ?? 3
    // Pass 0: grid agents' positions into the spatial hash for separation.
    buildHash(s, nav)
    // Pass 1: navigation, repaths, grid steering, crowd requests.
    let crowds = false
    for (let t = 0; t < s.query.tables.length; t++) {
      const table = s.query.tables[t]!
      columns(table, s.cols)
      for (let row = 0; row < table.count; row++) {
        if (stepAgent(s, world, nav, table, row, dt, since, physicsDim)) crowds = true
      }
      table.markChanged(NavAgentState)
    }
    if (!crowds) return
    // Pass 2: Detour crowds step, then mesh agents read their velocities back.
    for (let i = 0; i < nav.meshList.length; i++) nav.meshList[i]!.crowd?.update(dt)
    for (let t = 0; t < s.query.tables.length; t++) {
      const table = s.query.tables[t]!
      columns(table, s.cols)
      for (let row = 0; row < table.count; row++)
        readCrowd(s, world, nav, table, row, dt, physicsDim)
    }
  },
})

type State = ReturnType<NonNullable<typeof navAgents.setup>>

function buildHash(s: State, nav: NavState): void {
  let n = 0
  let maxR = 0.1
  for (let t = 0; t < s.query.tables.length; t++) {
    const table = s.query.tables[t]!
    const tr = table.column(Transform, 'translation') as Float32Array
    const radius = table.column(NavAgent, 'radius') as Float32Array
    for (let row = 0; row < table.count; row++) {
      const rec = nav.agents.get(table.entities[row]!)
      if (rec?.kind !== 'grid') continue
      if (n === s.gx.length) {
        s.gx = grow(s.gx)
        s.gy = grow(s.gy)
        s.gr = grow(s.gr)
        s.gnav = grow(s.gnav)
        const next = new Int32Array(s.next.length * 2)
        next.set(s.next)
        s.next = next
      }
      s.gx[n] = tr[row * 3]!
      s.gy[n] = tr[row * 3 + 1]!
      s.gr[n] = radius[row]!
      s.gnav[n] = rec.nav
      if (radius[row]! > maxR) maxR = radius[row]!
      n++
    }
  }
  s.gridCount = n
  s.cellSize = maxR * 4
  s.heads.fill(-1)
  for (let i = 0; i < n; i++) {
    const h = hashCell(Math.floor(s.gx[i]! / s.cellSize), Math.floor(s.gy[i]! / s.cellSize))
    s.next[i] = s.heads[h]!
    s.heads[h] = i
  }
}

function grow(a: Float64Array): Float64Array<ArrayBuffer> {
  const b = new Float64Array(a.length * 2)
  b.set(a)
  return b
}

const hashCell = (x: number, y: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & 1023

/** Picks the grid or navmesh an agent is in: its `nav`, else the one containing it. */
function locate(nav: NavState, preferred: number, x: number, y: number, z: number): number {
  if (preferred >= 0) return nav.grids.has(preferred) || nav.meshes.has(preferred) ? preferred : -1
  for (let i = 0; i < nav.gridList.length; i++) {
    const g = nav.gridList[i]!
    if (!g.grid) continue
    const cx = (x - g.ox) / g.csx
    const cy = (y - g.oy) / g.csy
    if (cx >= 0 && cy >= 0 && cx < g.grid.width && cy < g.grid.height) return g.entity
  }
  for (let i = 0; i < nav.meshList.length; i++) {
    const m = nav.meshList[i]!
    const pad = m.settings.agentRadius + m.settings.cellSize * 2
    if (
      x >= m.min[0]! - pad &&
      x <= m.max[0]! + pad &&
      z >= m.min[2]! - pad &&
      z <= m.max[2]! + pad &&
      y >= m.min[1]! - m.settings.agentHeight &&
      y <= m.max[1]! + m.settings.agentHeight
    )
      return m.entity
  }
  return -1
}

function removeFromCrowd(nav: NavState, rec: AgentRecord): void {
  if (rec.crowdIndex >= 0) {
    const rt = nav.meshes.get(rec.nav)
    rt?.crowd?.removeAgent(rec.crowdIndex)
    rec.crowdIndex = -1
  }
}

/** Returns true when the agent is on a navmesh crowd (pass 2 reads it back). */
function stepAgent(
  s: State,
  world: World,
  nav: NavState,
  table: Table,
  row: number,
  dt: number,
  since: number,
  dim: number,
): boolean {
  const c = s.cols
  const entity = table.entities[row]!
  let rec = nav.agents.get(entity)
  if (!rec) {
    rec = newRecord(entity)
    nav.agents.set(entity, rec)
  }
  const o3 = row * 3
  pos[0] = c.translation[o3]!
  pos[1] = c.translation[o3 + 1]!
  pos[2] = c.translation[o3 + 2]!
  // DRIVES order: character, transform, velocity.
  const drive = c.drive[row]!
  rec.drive =
    drive === DRIVE_CHARACTER && !table.has(CharacterController)
      ? DRIVE_TRANSFORM
      : drive === DRIVE_VELOCITY && !table.has(Velocity)
        ? DRIVE_TRANSFORM
        : drive
  const navEntity = locate(nav, c.nav[row]!, pos[0], pos[1], pos[2])
  if (navEntity !== rec.nav) {
    removeFromCrowd(nav, rec)
    rec.nav = navEntity
    rec.kind = navEntity < 0 ? 'none' : nav.grids.has(navEntity) ? 'grid' : 'mesh'
    rec.navVersion = -1
    rec.count = 0
  }
  if (rec.kind === 'none' || c.stopped[row] === 1) {
    removeFromCrowd(nav, rec)
    halt(s, world, table, row, rec, IDLE, dim)
    return false
  }
  // Where it's going: the target's position, or the destination.
  const target = c.target[row]!
  if (target >= 0 && world.isAlive(target) && world.has(target, GlobalTransform)) {
    const tt = world.entityTable(target)
    const tm = tt.column(GlobalTransform, 'matrix') as Float32Array
    const tr = world.entityRow(target)
    goal[0] = tm[tr * 12 + 3]!
    goal[1] = tm[tr * 12 + 7]!
    goal[2] = tm[tr * 12 + 11]!
  } else {
    goal[0] = c.destination[o3]!
    goal[1] = c.destination[o3 + 1]!
    goal[2] = c.destination[o3 + 2]!
  }
  rec.sinceRepath += dt
  const grid = rec.kind === 'grid' ? nav.grids.get(rec.nav)! : undefined
  const mesh = rec.kind === 'mesh' ? nav.meshes.get(rec.nav)! : undefined
  const version = grid ? grid.version : mesh!.version
  const cell = grid
    ? Math.max(grid.csx, grid.csy)
    : Math.max(c.radius[row]!, mesh!.settings.cellSize)
  const gdx = goal[0] - rec.goal[0]!
  const gdy = goal[1] - rec.goal[1]!
  const gdz = goal[2] - rec.goal[2]!
  const moved = Math.sqrt(gdx * gdx + gdy * gdy + gdz * gdz)
  const edited = c.agentTicks[row]! > since && c.agentTicks[row]! !== rec.agentTick
  const repath =
    rec.navVersion !== version ||
    edited ||
    moved > cell ||
    (target >= 0 && moved > 1e-4 && rec.sinceRepath >= c.repath[row]!)
  if (repath) {
    rec.agentTick = c.agentTicks[row]!
    rec.goal[0] = goal[0]
    rec.goal[1] = goal[1]
    rec.goal[2] = goal[2]
    rec.navVersion = version
    rec.sinceRepath = 0
    plan(s, world, nav, rec)
    if (rec.status === ARRIVED || rec.status === IDLE) rec.status = MOVING
  }
  if (grid) {
    steerGrid(s, world, table, row, rec, grid, dt, dim)
    return false
  }
  return requestCrowd(s, world, nav, table, row, rec, mesh!, repath, dim)
}

function plan(s: State, world: World, nav: NavState, rec: AgentRecord): void {
  const path: NavPath = s.path
  if (rec.kind === 'grid' && !nav.grids.get(rec.nav)?.grid) {
    rec.count = 0
    return
  }
  s.find.out = path
  s.find.nav = rec.nav
  findPath(world, pos, rec.goal, s.find)
  rec.corners.set(path.corners.subarray(0, path.count * 3))
  rec.count = path.count
  rec.next = 1
  rec.reachable = path.status === 'complete'
}

/** Stops an agent: zero velocity, the drive told to stand still, status set. */
function halt(
  s: State,
  world: World,
  table: Table,
  row: number,
  rec: AgentRecord,
  status: number,
  dim: number,
): void {
  const c = s.cols
  c.velocity[row * 3] = 0
  c.velocity[row * 3 + 1] = 0
  c.velocity[row * 3 + 2] = 0
  applyDrive(table, row, rec, 0, 0, 0, 0, dim)
  if (status !== ARRIVED) c.remaining[row] = 0
  c.corners[row] = 0
  setStatus(world, s, row, rec, status)
}

function setStatus(world: World, s: State, row: number, rec: AgentRecord, status: number): void {
  s.cols.status[row] = status
  if (status === rec.status) return
  rec.status = status
  if (status === ARRIVED) world.send(NavArrived, { entity: rec.entity })
  else if (status === UNREACHABLE) world.send(NavUnreachable, { entity: rec.entity })
}

/**
 * Writes a world velocity to the agent's drive. character: CharacterIntent.move in the
 * character's frame (2D: x only). velocity: the body's Velocity (keeping its vertical part in
 * 3D, for gravity). transform: moves by `v · dt`.
 */
function applyDrive(
  table: Table,
  row: number,
  rec: AgentRecord,
  vx: number,
  vy: number,
  vz: number,
  dt: number,
  dim: number,
): void {
  if (rec.drive === DRIVE_CHARACTER) {
    const move = table.column(CharacterIntent, 'move') as Float32Array
    if (dim === 2) {
      move[row * 3] = vx
      move[row * 3 + 1] = 0
      move[row * 3 + 2] = 0
    } else {
      // Into the character's frame: the conjugate rotation.
      const q = table.column(Transform, 'rotation') as Float32Array
      const qx = -q[row * 4]!
      const qy = -q[row * 4 + 1]!
      const qz = -q[row * 4 + 2]!
      const qw = q[row * 4 + 3]!
      const tx = 2 * (qy * vz - qz * vy)
      const ty = 2 * (qz * vx - qx * vz)
      const tz = 2 * (qx * vy - qy * vx)
      move[row * 3] = vx + qw * tx + (qy * tz - qz * ty)
      move[row * 3 + 1] = 0
      move[row * 3 + 2] = vz + qw * tz + (qx * ty - qy * tx)
    }
    table.markChanged(CharacterIntent, row)
    return
  }
  if (rec.drive === DRIVE_VELOCITY) {
    const lin = table.column(Velocity, 'linear') as Float32Array
    lin[row * 3] = vx
    if (dim === 2 || rec.kind === 'grid') lin[row * 3 + 1] = vy
    else lin[row * 3 + 2] = vz
    table.markChanged(Velocity, row)
    return
  }
  if (dt > 0) {
    const tr = table.column(Transform, 'translation') as Float32Array
    tr[row * 3] = tr[row * 3]! + vx * dt
    tr[row * 3 + 1] = tr[row * 3 + 1]! + vy * dt
    tr[row * 3 + 2] = tr[row * 3 + 2]! + vz * dt
    table.markChanged(Transform, row)
  }
}

// --- grid agents -----------------------------------------------------------------

function steerGrid(
  s: State,
  world: World,
  table: Table,
  row: number,
  rec: AgentRecord,
  g: GridRecord,
  dt: number,
  dim: number,
): void {
  const c = s.cols
  const o3 = row * 3
  const speed = c.speed[row]!
  const accel = c.acceleration[row]!
  const radius = c.radius[row]!
  const stopping = c.stopping[row]!
  const corners = rec.corners
  if (rec.count === 0) {
    halt(s, world, table, row, rec, UNREACHABLE, dim)
    return
  }
  // Advance past corners already reached.
  const reach = Math.max(stopping, radius * 0.5, 1e-3)
  while (rec.next < rec.count - 1) {
    const dx = corners[rec.next * 3]! - pos[0]!
    const dy = corners[rec.next * 3 + 1]! - pos[1]!
    if (dx * dx + dy * dy > reach * reach) break
    rec.next++
  }
  if (rec.next >= rec.count) rec.next = rec.count - 1
  // Remaining distance: to the next corner, then along the rest.
  let remaining = 0
  {
    let px = pos[0]!
    let py = pos[1]!
    for (let i = rec.next; i < rec.count; i++) {
      const dx = corners[i * 3]! - px
      const dy = corners[i * 3 + 1]! - py
      remaining += Math.sqrt(dx * dx + dy * dy)
      px = corners[i * 3]!
      py = corners[i * 3 + 1]!
    }
  }
  c.remaining[row] = remaining
  c.corners[row] = rec.count - rec.next
  const end = remaining <= stopping
  if (end && rec.next === rec.count - 1) {
    halt(s, world, table, row, rec, rec.reachable ? ARRIVED : UNREACHABLE, dim)
    c.remaining[row] = remaining
    return
  }
  // Seek the next corner, slowing to arrive at the last one.
  const tx = corners[rec.next * 3]! - pos[0]!
  const ty = corners[rec.next * 3 + 1]! - pos[1]!
  const d = Math.sqrt(tx * tx + ty * ty) || 1
  let want = speed
  const brake = Math.sqrt(2 * accel * Math.max(0, remaining - stopping * 0.5))
  if (brake < want) want = brake
  let dvx = (tx / d) * want
  let dvy = (ty / d) * want
  // Separation from neighbors in the spatial hash (same grid).
  const cs = s.cellSize
  const hx = Math.floor(pos[0]! / cs)
  const hy = Math.floor(pos[1]! / cs)
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (let j = s.heads[hashCell(hx + ox, hy + oy)]!; j !== -1; j = s.next[j]!) {
        if (s.gnav[j] !== rec.nav) continue
        const ax = pos[0]! - s.gx[j]!
        const ay = pos[1]! - s.gy[j]!
        const min = radius + s.gr[j]!
        const dd = ax * ax + ay * ay
        if (dd >= min * min || dd < 1e-12) continue
        const dist = Math.sqrt(dd)
        const push = ((min - dist) / min) * speed * 2
        dvx += (ax / dist) * push
        dvy += (ay / dist) * push
      }
    }
  }
  const dl = Math.sqrt(dvx * dvx + dvy * dvy)
  if (dl > speed) {
    dvx = (dvx / dl) * speed
    dvy = (dvy / dl) * speed
  }
  // Accelerate toward it.
  let vx = c.velocity[o3]!
  let vy = c.velocity[o3 + 1]!
  const ex = dvx - vx
  const ey = dvy - vy
  const el = Math.sqrt(ex * ex + ey * ey)
  const maxDv = accel * dt
  if (el > maxDv) {
    vx += (ex / el) * maxDv
    vy += (ey / el) * maxDv
  } else {
    vx = dvx
    vy = dvy
  }
  // Moving the transform: don't step into blocked cells (slide along them instead).
  if (rec.drive === DRIVE_TRANSFORM && g.grid) {
    const grid = g.grid
    seg[0] = (pos[0]! - g.ox) / g.csx
    seg[1] = (pos[1]! - g.oy) / g.csy
    seg[2] = (pos[0]! + vx * dt - g.ox) / g.csx
    seg[3] = (pos[1]! + vy * dt - g.oy) / g.csy
    if (!traceSegment(grid, seg, 2, 255)) {
      seg[3] = seg[1]!
      if (traceSegment(grid, seg, 2, 255)) vy = 0
      else {
        seg[2] = seg[0]!
        seg[3] = (pos[1]! + vy * dt - g.oy) / g.csy
        if (traceSegment(grid, seg, 2, 255)) vx = 0
        else {
          vx = 0
          vy = 0
        }
      }
    }
  }
  c.velocity[o3] = vx
  c.velocity[o3 + 1] = vy
  c.velocity[o3 + 2] = 0
  applyDrive(table, row, rec, vx, vy, 0, dt, dim)
  setStatus(world, s, row, rec, rec.reachable ? MOVING : UNREACHABLE)
}

// --- navmesh agents --------------------------------------------------------------

function crowdParams(s: State, row: number, rt: NavMeshRuntime) {
  const c = s.cols
  const r = c.radius[row]!
  const avoid = c.avoidance[row] === 1
  return {
    radius: r,
    height: rt.settings.agentHeight,
    maxAcceleration: c.acceleration[row]!,
    maxSpeed: c.speed[row]!,
    collisionQueryRange: r * 12,
    pathOptimizationRange: r * 30,
    // Separation pushes across the whole query range (12 radii): agents at the edge of a group
    // settle short of their goals. Velocity-obstacle avoidance alone keeps them apart.
    separationWeight: 0,
    updateFlags: ANTICIPATE_TURNS | OPTIMIZE_VIS | OPTIMIZE_TOPO | (avoid ? OBSTACLE_AVOIDANCE : 0),
    obstacleAvoidanceType: 3,
    queryFilterType: 0,
  }
}

function ensureCrowd(world: World, nav: NavState, rt: NavMeshRuntime, radius: number): void {
  let agents = 0
  for (const r of nav.agents.values()) if (r.nav === rt.entity) agents++
  if (rt.crowd && rt.crowdCapacity >= agents && rt.crowdRadius >= radius) return
  const capacity = Math.max(32, rt.crowdCapacity * 2, agents * 2)
  const maxRadius = Math.max(radius, rt.crowdRadius, rt.settings.agentRadius)
  rt.destroyCrowd()
  rt.crowd = new rt.R.Crowd(rt.navMesh, { maxAgents: capacity, maxAgentRadius: maxRadius })
  rt.crowdCapacity = capacity
  rt.crowdRadius = maxRadius
  rt.applyAreas(world.tryResource(NavAreas) ?? {})
  for (const r of nav.agents.values()) if (r.nav === rt.entity) r.crowdIndex = -1
}

function requestCrowd(
  s: State,
  world: World,
  nav: NavState,
  table: Table,
  row: number,
  rec: AgentRecord,
  rt: NavMeshRuntime,
  repath: boolean,
  dim: number,
): boolean {
  const c = s.cols
  if (!rt.crowd || rec.crowdIndex < 0) ensureCrowd(world, nav, rt, c.radius[row]!)
  const crowd = rt.crowd!
  vec.x = pos[0]!
  vec.y = pos[1]!
  vec.z = pos[2]!
  let agent = rec.crowdIndex >= 0 ? crowd.agents[rec.crowdIndex] : undefined
  if (!agent) {
    agent = crowd.addAgent(vec, crowdParams(s, row, rt))
    rec.crowdIndex = agent.agentIndex
    repath = true
  } else if (c.agentTicks[row]! > rec.agentTick || repath) {
    agent.updateParameters(crowdParams(s, row, rt))
  }
  if (rec.count === 0) {
    halt(s, world, table, row, rec, UNREACHABLE, dim)
    agent.resetMoveTarget()
    return true
  }
  if (repath) {
    // Aim for where the path ends: the goal, or the closest reachable point.
    const e = (rec.count - 1) * 3
    vec.x = rec.corners[e]!
    vec.y = rec.corners[e + 1]!
    vec.z = rec.corners[e + 2]!
    agent.requestMoveTarget(vec)
  }
  // Physics moves character and velocity agents: start the crowd step from where they are.
  if (rec.drive !== DRIVE_TRANSFORM && agent.raw.get_state() !== CROWD_OFFMESH) {
    const raw = agent.raw
    raw.set_npos(0, pos[0]!)
    raw.set_npos(1, pos[1]!)
    raw.set_npos(2, pos[2]!)
  }
  return true
}

function readCrowd(
  s: State,
  world: World,
  nav: NavState,
  table: Table,
  row: number,
  dt: number,
  dim: number,
): void {
  const c = s.cols
  const rec = nav.agents.get(table.entities[row]!)
  if (rec?.kind !== 'mesh' || rec.crowdIndex < 0 || c.stopped[row] === 1) return
  const rt = nav.meshes.get(rec.nav)
  const agent = rt?.crowd?.agents[rec.crowdIndex]
  if (!agent || rec.count === 0) return
  const raw = agent.raw
  const o3 = row * 3
  const px = raw.get_npos(0)
  const py = raw.get_npos(1)
  const pz = raw.get_npos(2)
  let vx = raw.get_vel(0)
  let vy = raw.get_vel(1)
  let vz = raw.get_vel(2)
  const e = (rec.count - 1) * 3
  const ex = rec.corners[e]! - c.translation[o3]!
  const ez = rec.corners[e + 2]! - c.translation[o3 + 2]!
  const ey = rec.corners[e + 1]! - c.translation[o3 + 1]!
  // Remaining: along the crowd's corners, then straight on to the path's end.
  let remaining = 0
  let lx = c.translation[o3]!
  let ly = c.translation[o3 + 1]!
  let lz = c.translation[o3 + 2]!
  const n = raw.get_ncorners()
  let ended = false
  for (let i = 0; i < n; i++) {
    const cx = raw.get_cornerVerts(i * 3)
    const cy = raw.get_cornerVerts(i * 3 + 1)
    const cz = raw.get_cornerVerts(i * 3 + 2)
    remaining += Math.sqrt((cx - lx) ** 2 + (cy - ly) ** 2 + (cz - lz) ** 2)
    lx = cx
    ly = cy
    lz = cz
    if ((raw.get_cornerFlags(i) & STRAIGHTPATH_END) !== 0) ended = true
  }
  if (!ended) {
    remaining += Math.sqrt(
      (rec.corners[e]! - lx) ** 2 +
        (rec.corners[e + 1]! - ly) ** 2 +
        (rec.corners[e + 2]! - lz) ** 2,
    )
  }
  const flat = Math.sqrt(ex * ex + ez * ez)
  c.remaining[row] = n === 0 ? flat : remaining
  c.corners[row] = n
  if (flat <= c.stopping[row]! && Math.abs(ey) < rt!.settings.agentHeight) {
    agent.resetMoveTarget()
    halt(s, world, table, row, rec, rec.reachable ? ARRIVED : UNREACHABLE, dim)
    c.remaining[row] = flat
    // Leave the crowd agent where the entity is, so the next path starts there.
    raw.set_npos(0, c.translation[o3]!)
    raw.set_npos(1, c.translation[o3 + 1]!)
    raw.set_npos(2, c.translation[o3 + 2]!)
    return
  }
  const offmesh = raw.get_state() === CROWD_OFFMESH
  const link = rec.link
  if (offmesh && !link.active) startLink(nav, rec, c.translation[o3 + 1]!, px, py, pz)
  link.active = offmesh
  if (rec.drive === DRIVE_TRANSFORM || offmesh) {
    // The crowd moved it on the navmesh (and across links): put the entity there. On a link the
    // crowd slides in a straight line at surface height: the height comes from the link's ends
    // instead, plus the entity's own height above the surface (a capsule's center), and an arc
    // so it jumps over the edge instead of through it.
    let y = py
    if (offmesh) {
      const total = Math.sqrt((link.x1 - link.x0) ** 2 + (link.z1 - link.z0) ** 2)
      const done = Math.sqrt((px - link.x0) ** 2 + (pz - link.z0) ** 2)
      const t = total > 1e-6 ? Math.min(1, done / total) : 1
      y = link.y0 + (link.y1 - link.y0) * t + link.lift + link.arc * 4 * t * (1 - t)
    }
    const tr = c.translation
    vx = (px - tr[o3]!) / dt
    vy = (y - tr[o3 + 1]!) / dt
    vz = (pz - tr[o3 + 2]!) / dt
    tr[o3] = px
    tr[o3 + 1] = y
    tr[o3 + 2] = pz
    table.markChanged(Transform, row)
    if (rec.drive !== DRIVE_TRANSFORM) applyDrive(table, row, rec, 0, 0, 0, 0, dim)
  } else {
    applyDrive(table, row, rec, vx, vy, vz, dt, dim)
  }
  c.velocity[o3] = vx
  c.velocity[o3 + 1] = vy
  c.velocity[o3 + 2] = vz
  setStatus(world, s, row, rec, rec.reachable ? MOVING : UNREACHABLE)
}

/**
 * An agent standing at height `y` stepped onto an off-mesh link at (x, z) (the crowd's surface
 * point at `surface`): finds the link by its nearest end, so the crossing knows both ends, how high
 * the entity rides above the surface, and an arc that clears the rise between the ends.
 */
function startLink(
  nav: NavState,
  rec: AgentRecord,
  y: number,
  x: number,
  surface: number,
  z: number,
): void {
  const link = rec.link
  link.x0 = x
  link.z0 = z
  link.y0 = surface
  link.x1 = x
  link.z1 = z
  link.y1 = surface
  link.arc = 0.5
  let best = Infinity
  for (let i = 0; i < nav.links.length; i++) {
    const l = nav.links[i]!
    const ds = (l.start[0] - x) ** 2 + (l.start[2] - z) ** 2
    const de = l.bidirectional ? (l.end[0] - x) ** 2 + (l.end[2] - z) ** 2 : Infinity
    const d = Math.min(ds, de)
    if (d >= best) continue
    best = d
    const near = ds <= de ? l.start : l.end
    const far = ds <= de ? l.end : l.start
    link.y0 = near[1]
    link.x1 = far[0]
    link.z1 = far[2]
    link.y1 = far[1]
    link.arc = 0.4 + Math.abs(far[1] - near[1])
  }
  // Measured against the link's surface, not the crowd's point: on the step it joins the link,
  // the crowd's point is still partway between where physics put the entity and the surface.
  link.lift = rec.drive === DRIVE_TRANSFORM ? 0 : Math.max(0, y - link.y0)
}

/** Forgets an agent (despawned or NavAgent removed): its crowd slot is freed. */
export function dropAgent(world: World, entity: Entity): void {
  const nav = world.tryResource(Nav)
  const rec = nav?.agents.get(entity)
  if (!nav || !rec) return
  removeFromCrowd(nav, rec)
  nav.agents.delete(entity)
}
