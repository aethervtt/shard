import type { Entity, World } from '@aethervtt/shard-core'
import { NavBreach, type NavBreachValue, NavGateBlocked } from './components'
import type { NavMeshRuntime } from './navmesh'
import type { NavGate } from './sources'
import { type AgentRecord, Nav, type NavState } from './state'

// Breaching (0114): agents whose filter plans through shut gates walk in legs, each ending at the
// next gate they have to breach. Near it they claim a slot in rows along its face, wait there
// (status blocked, NavGateBlocked), and walk on once the gate passes their filter. All of it runs
// from the agent's record and position, so it works whatever moves the agent: Detour's crowd, or
// another system (setNavMover).

/** NavAgentState.status codes (AGENT_STATUSES order). */
export const MOVING = 1
export const BLOCKED = 4
/** NavAgentState.row while waiting for a slot. */
export const NO_ROW = 255

/** Slots on one side of one gate: points in rows along its face, and who holds each. */
export class SlotSet {
  readonly gate: Entity
  readonly side: number
  /** The agent radius it was spaced for. */
  readonly radius: number
  count = 0
  /** Free slots, and the lowest row with one (255: none). */
  free = 0
  lowestFree = 255
  x: Float64Array
  y: Float64Array
  z: Float64Array
  row: Uint8Array
  /** The entity holding each slot, or -1. */
  owner: Float64Array
  /** Agents near the gate with no free slot, in the order they came. */
  readonly waiting: Entity[] = []
  /**
   * Once the gate opens, its agents walk on one at a time (`order`, nearest the gate first): the
   * next goes when the last (which started at x, z) has gone two slots.
   */
  open = false
  order: Entity[] = []
  released = 0
  lastX = 0
  lastZ = 0
  /** How long the next in line has waited for the last to clear, s. */
  held = 0

  constructor(gate: Entity, side: number, radius: number, capacity: number) {
    this.gate = gate
    this.side = side
    this.radius = radius
    this.x = new Float64Array(capacity)
    this.y = new Float64Array(capacity)
    this.z = new Float64Array(capacity)
    this.row = new Uint8Array(capacity)
    this.owner = new Float64Array(capacity).fill(-1)
  }

  /** Counts free slots again, after one was taken or given up. */
  recount(): void {
    this.free = 0
    this.lowestFree = 255
    for (let i = 0; i < this.count; i++) {
      if (this.owner[i]! >= 0) continue
      this.free++
      if (this.row[i]! < this.lowestFree) this.lowestFree = this.row[i]!
    }
  }

  /** How many agents hold a slot or wait for one. */
  claimed(): number {
    let n = this.waiting.length
    for (let i = 0; i < this.count; i++) if (this.owner[i]! >= 0) n++
    return n
  }
}

const slotKey = (gate: Entity, side: number) => gate * 2 + (side > 0 ? 1 : 0)

const point = { x: 0, y: 0, z: 0 }
const extents = { x: 0, y: 0, z: 0 }

/**
 * Builds a gate side's slots: rows parallel to its face, `2.1·radius` apart and staggered, row 0
 * just outside its polygons and spanning its width plus `spread` each side, each row behind one
 * slot wider at each end. A candidate counts when it lies on (within half a radius of) a polygon
 * the walk filter passes and a navmesh raycast from the entry reaches it: on the entry's side, off
 * walls, in the open.
 */
export function buildSlots(
  rt: NavMeshRuntime,
  gate: NavGate,
  side: number,
  entry: ArrayLike<number>,
  radius: number,
  filter: string,
  settings: NavBreachValue,
): SlotSet {
  const spacing = 2.1 * radius
  const rowGap = spacing * 0.866
  const d0 = gate.depth / 2 + 0.1
  const tx = -gate.az
  const tz = gate.ax
  const rows = Math.max(1, Math.min(255, Math.floor(settings.rows)))
  let capacity = 0
  for (let k = 0; k < rows; k++)
    capacity += 2 * Math.floor((gate.halfWidth + settings.spread + k * spacing) / spacing) + 3
  const set = new SlotSet(gate.owner, side, radius, capacity)
  const walk = rt.walkFilter(filter)
  const q = rt.query
  extents.x = Math.max(1, radius * 4)
  extents.y = Math.max(2, rt.settings.agentHeight * 1.5)
  extents.z = extents.x
  point.x = entry[0]!
  point.y = entry[1]!
  point.z = entry[2]!
  // Raycasts start in front of the gate's middle: from the entry, on its edge, they skim it.
  point.x = gate.mx + gate.ax * side * (gate.depth / 2 + 0.5)
  point.z = gate.mz + gate.az * side * (gate.depth / 2 + 0.5)
  const start = q.findNearestPoly(point, { filter: walk, halfExtents: extents })
  if (!start.success || start.nearestRef === 0) return set
  const startRef = start.nearestRef
  const startPos = { ...start.nearestPoint }
  const near = { x: radius, y: extents.y, z: radius }
  const minGap = spacing
  for (let k = 0; k < rows; k++) {
    const half = gate.halfWidth + settings.spread + k * spacing
    const stagger = (k % 2) * (spacing / 2)
    const d = d0 + k * rowGap
    const cx = gate.mx + gate.ax * side * d
    const cz = gate.mz + gate.az * side * d
    // From the centre out to both ends: j = 0, −1, 1, −2, 2, …
    const m = Math.floor(half / spacing) + 1
    for (let i = 0; i <= 2 * m + 1; i++) {
      const j = i % 2 === 0 ? i / 2 : -(i + 1) / 2
      const t = j * spacing + stagger
      if (Math.abs(t) > half + 1e-6) continue
      point.x = cx + tx * t
      point.y = entry[1]!
      point.z = cz + tz * t
      const hit = q.findNearestPoly(point, { filter: walk, halfExtents: near })
      if (!hit.success || hit.nearestRef === 0) continue
      const p = hit.nearestPoint
      if ((p.x - point.x) ** 2 + (p.z - point.z) ** 2 > (radius * 0.5) ** 2) continue
      // Still outside the gate, on the entry's side.
      if (((p.x - gate.mx) * gate.ax + (p.z - gate.mz) * gate.az) * side < gate.depth / 2) continue
      let clash = false
      for (let s = 0; s < set.count && !clash; s++)
        clash = (set.x[s]! - p.x) ** 2 + (set.z[s]! - p.z) ** 2 < minGap * minGap
      if (clash) continue
      const ray = q.raycast(startRef, startPos, p, { filter: walk })
      if (ray.t < 1) continue
      const n = set.count++
      set.x[n] = p.x
      set.y[n] = p.y
      set.z[n] = p.z
      set.row[n] = k
    }
  }
  set.recount()
  return set
}

function assign(rec: AgentRecord, set: SlotSet, i: number): void {
  set.owner[i] = rec.entity
  set.recount()
  rec.slotBest = Infinity
  rec.slotStuck = 0
  rec.slots = set
  rec.slot = i
  rec.waiting = false
  rec.legEnd[0] = set.x[i]!
  rec.legEnd[1] = set.y[i]!
  rec.legEnd[2] = set.z[i]!
  rec.legMoved = true
}

/**
 * Claims a free slot, or joins the set's waiting list when none is free. At the front, the lowest
 * row's nearest; where the crowd stopped it, the nearest, so no claim sends it through the queue.
 * Ties go to the lower slot.
 */
function claim(rec: AgentRecord, set: SlotSet, front: boolean): void {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < set.count; i++) {
    if (set.owner[i]! >= 0) continue
    const d = (set.x[i]! - rec.px) ** 2 + (set.z[i]! - rec.pz) ** 2
    if (front && best >= 0 && set.row[i]! !== set.row[best]!) {
      if (set.row[i]! < set.row[best]!) {
        best = i
        bestD = d
      }
      continue
    }
    if (d < bestD) {
      best = i
      bestD = d
    }
  }
  if (best >= 0) {
    assign(rec, set, best)
    return
  }
  rec.slots = set
  rec.slot = -1
  rec.waiting = true
  set.waiting.push(rec.entity)
}

/**
 * Slot `freed` came free: the nearest agent from a row behind it (then the nearest waiting one)
 * moves up, and the slot it leaves is filled the same way.
 */
function fill(nav: NavState, set: SlotSet, freed: number): void {
  // An open gate's queue walks on; nobody moves up.
  if (set.open) return
  let best: AgentRecord | undefined
  let bestRow = 256
  let bestD = Infinity
  const fx = set.x[freed]!
  const fz = set.z[freed]!
  const row = set.row[freed]!
  for (let i = 0; i < set.count; i++) {
    const e = set.owner[i]!
    if (e < 0 || set.row[i]! <= row) continue
    const r = nav.agents.get(e as Entity)
    if (!r) continue
    const d = (r.px - fx) ** 2 + (r.pz - fz) ** 2
    if (
      set.row[i]! < bestRow ||
      (set.row[i] === bestRow && (d < bestD || (d === bestD && e < best!.entity)))
    ) {
      best = r
      bestRow = set.row[i]!
      bestD = d
    }
  }
  if (!best) {
    for (let i = 0; i < set.waiting.length; i++) {
      const r = nav.agents.get(set.waiting[i]!)
      if (!r) continue
      const d = (r.px - fx) ** 2 + (r.pz - fz) ** 2
      if (d < bestD || (d === bestD && r.entity < best!.entity)) {
        best = r
        bestD = d
      }
    }
  }
  if (!best) return
  const old = best.slot
  if (old >= 0) set.owner[old] = -1
  else set.waiting.splice(set.waiting.indexOf(best.entity), 1)
  set.recount()
  assign(best, set, freed)
  if (best.status === BLOCKED) best.status = MOVING
  if (old >= 0) fill(nav, set, old)
}

/** Gives up an agent's slot or place in line; the queue behind it moves up. */
export function releaseSlot(nav: NavState, rec: AgentRecord): void {
  const set = rec.slots
  if (!set) return
  rec.slots = null
  if (rec.slot >= 0) {
    const i = rec.slot
    rec.slot = -1
    if (set.owner[i] === rec.entity) {
      set.owner[i] = -1
      set.recount()
      fill(nav, set, i)
    }
  } else if (rec.waiting) {
    const i = set.waiting.indexOf(rec.entity)
    if (i >= 0) set.waiting.splice(i, 1)
  }
  rec.waiting = false
}

/**
 * A waiting agent takes a free slot next to it in a row ahead of its own (the lowest row, then the
 * nearest): the front fills as gaps open, and a hop that short doesn't cross the crowd.
 */
function moveUp(rec: AgentRecord, set: SlotSet, x: number, z: number): boolean {
  const row = set.row[rec.slot]!
  if (set.lowestFree >= row) return false
  const reach = 1.1 * 2.1 * set.radius
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < set.count; i++) {
    if (set.owner[i]! >= 0 || set.row[i]! >= row) continue
    const d = (set.x[i]! - x) ** 2 + (set.z[i]! - z) ** 2
    if (d > reach * reach) continue
    if (best < 0 || set.row[i]! < set.row[best]! || (set.row[i] === set.row[best] && d < bestD)) {
      best = i
      bestD = d
    }
  }
  if (best < 0) return false
  set.owner[rec.slot] = -1
  assign(rec, set, best)
  return true
}

/** Seconds without getting 5 cm closer to where it's going before the crowd counts as in its way. */
const STUCK = 0.5

/** Tracks whether an agent gets closer to legEnd; true once it hasn't for `STUCK` s. */
function stuck(rec: AgentRecord, x: number, z: number, dt: number): boolean {
  const d = Math.sqrt((rec.legEnd[0]! - x) ** 2 + (rec.legEnd[2]! - z) ** 2)
  if (d < rec.slotBest - 0.05) {
    rec.slotBest = d
    rec.slotStuck = 0
    return false
  }
  rec.slotStuck += dt
  return rec.slotStuck >= STUCK
}

/**
 * The crowd stopped an agent short of its slot (no closer for `STUCK` s): it waits where it is. It
 * keeps its slot within a slot's spacing of it, else takes the free slot nearest it within that,
 * else gives its slot up and waits in line without one. True when it holds a slot.
 */
function settle(rec: AgentRecord, set: SlotSet, x: number, z: number): boolean {
  const spacing = 2.1 * set.radius
  const d2 = (rec.legEnd[0]! - x) ** 2 + (rec.legEnd[2]! - z) ** 2
  if (d2 <= spacing * spacing) return true
  let best = -1
  let bestD = spacing * spacing
  for (let i = 0; i < set.count; i++) {
    if (set.owner[i]! >= 0) continue
    const di = (set.x[i]! - x) ** 2 + (set.z[i]! - z) ** 2
    if (di <= bestD) {
      best = i
      bestD = di
    }
  }
  set.owner[rec.slot] = -1
  if (best >= 0) {
    assign(rec, set, best)
    return true
  }
  set.recount()
  rec.slot = -1
  rec.waiting = true
  set.waiting.push(rec.entity)
  return false
}

/** How close an external agent must stand to its slot to be there, m. */
const EXTERNAL_REACH = 0.05

/** How long an agent walking on out of a queue shoves through it (no avoidance), s. */
const SHOVE = 3

/** How long the next in line waits for the last to clear before it goes anyway, s. */
const CLEAR = 2

/**
 * Whether an agent of an open gate's queue may walk on: the gate's whole queue, nearest its middle
 * (ex, ez) first, goes one at a time, each once the one ahead has gone two slots (or `CLEAR` s).
 */
function mayGo(
  nav: NavState,
  set: SlotSet,
  rec: AgentRecord,
  ex: number,
  ez: number,
  dt: number,
): boolean {
  if (!set.open) {
    set.open = true
    set.released = 0
    set.order.length = 0
    for (let i = 0; i < set.count; i++)
      if (set.owner[i]! >= 0) set.order.push(set.owner[i]! as Entity)
    for (const e of set.waiting) set.order.push(e)
    const d = (e: Entity) => {
      const r = nav.agents.get(e)
      return r ? (r.px - ex) ** 2 + (r.pz - ez) ** 2 : Infinity
    }
    set.order.sort((a, b) => d(a) - d(b) || a - b)
    set.held = 0
  }
  // Those who left the queue before their turn (despawned, stopped, sent elsewhere) are skipped.
  while (set.released < set.order.length) {
    const next = nav.agents.get(set.order[set.released]!)
    if (next?.slots === set) break
    set.released++
  }
  const i = set.order.indexOf(rec.entity)
  if (i < 0 || i < set.released) return true
  if (i > set.released) return false
  if (set.released > 0) {
    const last = nav.agents.get(set.order[set.released - 1]!)
    const gap = 2 * 2.1 * set.radius
    set.held += dt
    const gone = !last || (last.px - set.lastX) ** 2 + (last.pz - set.lastZ) ** 2 >= gap * gap
    if (!gone && set.held < CLEAR) return false
  }
  set.held = 0
  set.released++
  set.lastX = rec.px
  set.lastZ = rec.pz
  return true
}

/** The distance from (x, z) to the nearest slot of `set`, squared. */
function nearestSlot(set: SlotSet, x: number, z: number): number {
  let d = Infinity
  for (let i = 0; i < set.count; i++) {
    const di = (set.x[i]! - x) ** 2 + (set.z[i]! - z) ** 2
    if (di < d) d = di
  }
  return d
}

/** Its slot set was dropped: back to walking for the leg's entry until it claims another. */
function unslot(rec: AgentRecord): void {
  rec.slots = null
  rec.slot = -1
  rec.waiting = false
  if (rec.leg >= 0) {
    const o = rec.leg * 5
    rec.legEnd[0] = rec.entries[o]!
    rec.legEnd[1] = rec.entries[o + 1]!
    rec.legEnd[2] = rec.entries[o + 2]!
  }
  rec.legMoved = true
  rec.slotBest = Number.POSITIVE_INFINITY
  rec.slotStuck = 0
  if (rec.status === BLOCKED) rec.status = MOVING
}

/** Drops a slot set; its agents claim again from scratch. */
function dropSet(nav: NavState, rt: NavMeshRuntime, set: SlotSet): void {
  for (let i = 0; i < set.count; i++) {
    const r = set.owner[i]! >= 0 ? nav.agents.get(set.owner[i]! as Entity) : undefined
    if (r?.slots === set) unslot(r)
  }
  for (const e of set.waiting) {
    const r = nav.agents.get(e)
    if (r?.slots === set) unslot(r)
  }
  rt.slots.delete(slotKey(set.gate, set.side))
}

/** Drops the slot sets of gates whose tiles or shape changed since the last step. */
export function dropStaleSlots(nav: NavState, rt: NavMeshRuntime): void {
  if (rt.staleGates.size === 0) return
  for (const gate of rt.staleGates) {
    for (const side of [-1, 1]) {
      const set = rt.slots.get(slotKey(gate, side))
      if (set) dropSet(nav, rt, set)
    }
  }
  rt.staleGates.clear()
}

/**
 * Sets the leg starting at `rec.pathGates[from]`: it ends at the first gate from there whose
 * state the agent's filter breaches, or at the path's end.
 */
export function nextLeg(nav: NavState, rec: AgentRecord, from: number): void {
  rec.leg = -1
  for (let j = from; j < rec.pathGates.length; j++) {
    const gate = nav.gates.byOwner.get(rec.pathGates[j]!)
    if (gate && (gate.flags & rec.breach) !== 0) {
      rec.leg = j
      break
    }
  }
  if (rec.leg >= 0) {
    const o = rec.leg * 5
    rec.legEnd[0] = rec.entries[o]!
    rec.legEnd[1] = rec.entries[o + 1]!
    rec.legEnd[2] = rec.entries[o + 2]!
    rec.legCount = Math.max(1, rec.entries[o + 4]!)
  } else if (rec.count > 0) {
    const e = (rec.count - 1) * 3
    rec.legEnd[0] = rec.corners[e]!
    rec.legEnd[1] = rec.corners[e + 1]!
    rec.legEnd[2] = rec.corners[e + 2]!
    rec.legCount = rec.count
  } else rec.legCount = 0
  rec.legMoved = true
  rec.slotBest = Number.POSITIVE_INFINITY
  rec.slotStuck = 0
}

/**
 * Where the path enters each gate it crosses: the corner Detour adds where the path enters the
 * gate's polygons (`refs[i]` is the polygon entered at corner i), with the side it enters from.
 * A gate with no such corner enters from its own face on the start's side.
 */
export function gateEntries(
  nav: NavState,
  rt: NavMeshRuntime,
  rec: AgentRecord,
  refs: readonly number[],
): void {
  const n = rec.pathGates.length
  if (rec.entries.length < n * 5) rec.entries = new Float64Array(n * 10)
  rec.entries.fill(Number.NaN, 0, n * 5)
  const c = rec.corners
  for (let i = 0; i < rec.count && i < refs.length; i++) {
    const owner = rt.refGate.get(refs[i]!)
    if (owner === undefined) continue
    const j = rec.pathGates.indexOf(owner)
    if (j < 0 || !Number.isNaN(rec.entries[j * 5]!)) continue
    const gate = nav.gates.byOwner.get(owner)
    const o = j * 5
    rec.entries[o] = c[i * 3]!
    rec.entries[o + 1] = c[i * 3 + 1]!
    rec.entries[o + 2] = c[i * 3 + 2]!
    rec.entries[o + 3] = gate ? sideOf(gate, c[i * 3]!, c[i * 3 + 2]!) : 1
    rec.entries[o + 4] = i
  }
  for (let j = 0; j < n; j++) {
    const o = j * 5
    if (!Number.isNaN(rec.entries[o]!)) continue
    const gate = nav.gates.byOwner.get(rec.pathGates[j]!)
    const side = gate ? sideOf(gate, c[0]!, c[2]!) : 1
    const d = gate ? gate.depth / 2 : 0
    rec.entries[o] = gate ? gate.mx + gate.ax * side * d : c[0]!
    rec.entries[o + 1] = c[1]!
    rec.entries[o + 2] = gate ? gate.mz + gate.az * side * d : c[2]!
    rec.entries[o + 3] = side
    rec.entries[o + 4] = 1
  }
}

function sideOf(gate: NavGate, x: number, z: number): number {
  return (x - gate.mx) * gate.ax + (z - gate.mz) * gate.az < 0 ? -1 : 1
}

/**
 * One agent's breaching for this step, from its position (x, z): walks on when its leg's gate
 * passes its filter, claims a slot near the gate, and waits once at it (status blocked,
 * NavGateBlocked). Returns whether it's blocked.
 */
export function breachStep(
  world: World,
  nav: NavState,
  rt: NavMeshRuntime,
  rec: AgentRecord,
  filter: string,
  radius: number,
  stopping: number,
  x: number,
  y: number,
  z: number,
  dt: number,
): boolean {
  rec.px = x
  rec.pz = z
  const atLeg = rec.atLeg
  rec.atLeg = false
  if (rec.leg < 0) return false
  const owner = rec.pathGates[rec.leg]!
  const gate = nav.gates.byOwner.get(owner)
  // Gone: its tiles change, and the agent replans with them.
  if (!gate) return rec.status === BLOCKED
  const o = rec.leg * 5
  if ((gate.flags & rec.breach) === 0) {
    // Excluded now: it waits for its replan. Passable (opened, broken): it walks on, in turn.
    if ((gate.flags & rec.exclude) !== 0) return rec.status === BLOCKED
    if (rec.slots && !mayGo(nav, rec.slots, rec, gate.mx, gate.mz, dt))
      return rec.status === BLOCKED
    // Out of a queue it shoves through the agents still waiting: Detour's avoidance finds no way
    // between them, and collisions push them aside.
    if (rec.slots) rec.shove = SHOVE
    releaseSlot(nav, rec)
    nextLeg(nav, rec, rec.leg + 1)
    if (rec.status === BLOCKED) rec.status = MOVING
    return false
  }
  // Shut again: whoever is still queued waits as before.
  if (rec.slots?.open) rec.slots.open = false
  if (rec.slots === null) {
    const settings = world.tryResource(NavBreach) ?? DEFAULTS
    const side = rec.entries[o + 3]!
    const key = slotKey(owner, side)
    let set = rt.slots.get(key)
    // It claims at the front (within two slots of the entry), or where the crowd stops it within
    // `claim` of the gate or of its queue: arrivals settle at the back of a long one.
    const dx = rec.entries[o]! - x
    const dz = rec.entries[o + 2]! - z
    const d2 = dx * dx + dz * dz
    const front = 2 * 2.1 * radius
    const claim2 = settings.claim * settings.claim
    const near = d2 <= claim2 || (set !== undefined && nearestSlot(set, x, z) <= claim2)
    const atFront = d2 <= front * front
    // Nothing physical stops an external agent (0114): it claims on reaching the gate's queue.
    if (!atFront && !(near && (rec.external || stuck(rec, x, z, dt)))) return false
    // A larger agent than the set was spaced for: space it again, and everyone claims anew.
    if (set && radius > set.radius * 1.001) {
      dropSet(nav, rt, set)
      set = undefined
    }
    if (!set) {
      const entry = rec.entries.subarray(o, o + 3)
      set = buildSlots(rt, gate, side, entry, radius, filter, settings)
      rt.slots.set(key, set)
    }
    claim(rec, set, atFront || rec.external)
  }
  if (rec.status === BLOCKED) {
    // A gap opened next to it in a row ahead: take it (and arrive again).
    if (rec.slot >= 0 && moveUp(rec, rec.slots!, x, z)) {
      rec.status = MOVING
      return false
    }
    return true
  }
  const set = rec.slots!
  let there = rec.waiting || atLeg
  if (!there) {
    // At its slot within stoppingDistance; in a packed queue, where the crowd stops it (settle).
    // Nothing keeps external agents apart: they're there within 5 cm (or navAgentAt).
    const reach = rec.external ? EXTERNAL_REACH : stopping
    there = (rec.legEnd[0]! - x) ** 2 + (rec.legEnd[2]! - z) ** 2 <= reach * reach
    if (!there && !rec.external && stuck(rec, x, z, dt)) {
      settle(rec, set, x, z)
      there = true
    }
  }
  if (!there) return false
  if (rec.waiting) {
    // No slot: it holds where it stands until one frees.
    rec.legEnd[0] = x
    rec.legEnd[1] = y
    rec.legEnd[2] = z
  }
  rec.status = BLOCKED
  rec.legMoved = true
  // What to face: the gate's centre plane, within the gap, nearest the agent.
  const tx = -gate.az
  const tz = gate.ax
  let t = (x - gate.mx) * tx + (z - gate.mz) * tz
  if (t > gate.halfWidth) t = gate.halfWidth
  if (t < -gate.halfWidth) t = -gate.halfWidth
  world.send(NavGateBlocked, {
    entity: rec.entity,
    gate: owner,
    flags: gate.flags,
    row: rec.slot >= 0 ? set.row[rec.slot]! : NO_ROW,
    point: [gate.mx + tx * t, y, gate.mz + tz * t],
  })
  return true
}

const DEFAULTS: NavBreachValue = { claim: 4, spread: 0.5, rows: 8 }

/** The gate and slot row a blocked agent waits at, for NavAgentState (-1 when not blocked). */
export function blockedAt(rec: AgentRecord): number {
  return rec.status === BLOCKED && rec.leg >= 0 ? rec.pathGates[rec.leg]! : -1
}

export function blockedRow(rec: AgentRecord): number {
  if (rec.status !== BLOCKED || !rec.slots) return 0
  return rec.slot >= 0 ? rec.slots.row[rec.slot]! : NO_ROW
}

/**
 * Hands an agent to another mover (0114), such as 0115's movement tiers: nav takes it out of the
 * crowd and writes none of its drives, but still plans it, sets its legs (`AgentRecord.legEnd`,
 * the slot once it has one), claims its slot and sends its events. The mover walks the leg's
 * corners (`corners` up to `legCount`) and then to `legEnd`, and reports arrival by writing the
 * agent's Transform (or `navAgentAt`). `'crowd'` hands it back.
 */
export function setNavMover(world: World, entity: Entity, mover: 'crowd' | 'external'): void {
  const nav = world.resource(Nav)
  if (mover === 'external') nav.external.add(entity)
  else nav.external.delete(entity)
}

/**
 * An external mover says its agent stands at `legEnd` (0114), for a mover that can't get within
 * `stoppingDistance` of it (one that snaps to cells). Read on the agent's next step.
 */
export function navAgentAt(world: World, entity: Entity): void {
  const rec = world.tryResource(Nav)?.agents.get(entity)
  if (rec) rec.atLeg = true
}

/** An agent's runtime record (its path, leg and slot), or undefined before its first step. */
export function navAgentRecord(world: World, entity: Entity): AgentRecord | undefined {
  return world.tryResource(Nav)?.agents.get(entity)
}
