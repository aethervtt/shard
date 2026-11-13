import { type Entity, ProfilerResource, type World, worldHashRows } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow, timingMode } from '@aethervtt/shard-core/test-env'
import {
  bakeNavigation,
  buildSlots,
  findPath,
  GATE_CLOSED,
  GATE_LOCKED,
  Nav,
  NavAgent,
  NavAgentState,
  NavBudget,
  NavFilters,
  type NavFiltersValue,
  type NavFilterValue,
  NavFlowField,
  NavGateBlocked,
  type NavGateBlockedData,
  NavMesh,
  type NavMeshRuntime,
  NavTier,
  navAgentRecord,
  navPlugin,
  navReady,
  navTiersPlugin,
  setNavMover,
} from '@aethervtt/shard-nav'
import { CharacterController, Physics, physics3dPlugin } from '@aethervtt/shard-physics'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { breachHouse } from './breach-house'
import { Cutout, Floor, Opening, Wall } from './components'
import { structureNavPlugin } from './nav'
import { structurePhysicsPlugin } from './physics'
import { town } from './town'

// Breaching (0114), headless: filters that plan through shut gates, agents that wait at them in
// slots and walk on when they open, windows, Breach spans, and agents no crowd moves.

const DT = 1 / 60
const MESH = { cellSize: 0.1, cellHeight: 0.1, tileSize: 64, agentRadius: 0.3, agentHeight: 1.8 }
const R = 0.3
const ZOMBIE: NavFilterValue = { breach: ['closed', 'locked'] }
const FILTERS: NavFiltersValue = {
  survivor: { exclude: ['locked', 'custom'] },
  zombie: { breach: ['closed', 'locked'] },
}

type Point = [number, number, number]

async function headless(filters: NavFiltersValue = FILTERS): Promise<App> {
  const app = new App().addPlugin(
    TransformPlugin,
    physics3dPlugin(),
    navPlugin,
    structurePhysicsPlugin,
    structureNavPlugin,
  )
  await app.init()
  app.world.insertResource(NavFilters, filters)
  return app
}

function frames(app: App, n = 1): void {
  for (let i = 0; i < n; i++) app.update(DT)
}

/** A house's navmesh, baked. */
async function bake(app: App): Promise<NavMeshRuntime> {
  app.world.spawn([NavMesh, MESH])
  // One frame first: structure pushes its shapes and gates to nav in its systems.
  frames(app)
  await bakeNavigation(app.world)
  frames(app)
  return [...app.world.resource(Nav).meshes.values()][0]!
}

function zombie(
  world: World,
  from: Point,
  to: Point | Entity,
  options: { filter?: string; drive?: 'transform' | 'character' } = {},
): Entity {
  const drive = options.drive ?? 'transform'
  const goal = typeof to === 'number' ? { target: to } : { destination: to }
  const value = { ...goal, filter: options.filter ?? 'zombie', drive, speed: 3, radius: R }
  if (drive === 'character') {
    return world.spawn(
      [NavAgent, value],
      [CharacterController, { radius: R }],
      [Transform, { translation: [from[0], 0.92, from[2]] }],
    )
  }
  return world.spawn([NavAgent, value], [Transform, { translation: from }])
}

const status = (world: World, e: Entity) => world.get(e, NavAgentState).status
const at = (world: World, e: Entity) => world.get(e, Transform).translation

/** Runs frames until `done` or `limit`, collecting NavGateBlocked. */
function run(
  app: App,
  limit: number,
  done: () => boolean,
  events: NavGateBlockedData[] = [],
): NavGateBlockedData[] {
  const reader = app.world.reader(NavGateBlocked)
  for (let i = 0; i < limit && !done(); i++) {
    frames(app)
    for (const e of reader.read()) events.push(e)
  }
  return events
}

/** Inside a door gate's footprint: the gap, `gateMargin` (0.6 m) past each 0.2 m wall's face. */
function inFrontDoorGate(p: ArrayLike<number>, x0 = 0, z0 = 0): boolean {
  return p[0]! > x0 + 1.5 && p[0]! < x0 + 2.5 && Math.abs(p[2]! - z0) < 0.7
}

/** 30 destinations in a grid in the west room, clear of the walls. */
function westRoomGrid(x0 = 0, z0 = 0): Point[] {
  const out: Point[] = []
  for (let j = 0; j < 5; j++)
    for (let i = 0; i < 6; i++) out.push([x0 + 0.6 + i * 0.76, 0, z0 + 0.8 + j * 1.1])
  return out
}

/** 30 points on a half circle `radius` south of (x, z). */
function arc(x: number, z: number, radius: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i < 30; i++) {
    const a = Math.PI * (1.15 + (0.7 * i) / 29)
    out.push([x + Math.cos(a) * radius, 0, z + Math.sin(a) * radius])
  }
  return out
}

/**
 * What Detour's A* charges for a path: from the middle of the edge it enters each polygon by to the
 * middle of the edge it leaves by, at that polygon's area cost. Breach costs compare in this, which
 * round large ground polygons is longer than the path walked.
 */
function plannerCost(world: World, rt: NavMeshRuntime, from: Point, to: Point, filter: string) {
  const polys: number[] = []
  const path = findPath(world, from, to, { filter, polys })
  const f = rt.queryFilter(filter)
  const cost = (ref: number) => f.getAreaCost(rt.navMesh.getPolyArea(ref).area)
  const edges = (ref: number) => {
    const { tile, poly } = rt.navMesh.getTileAndPolyByRefUnsafe(ref)
    const out: number[][] = []
    for (let j = 0; j < poly.vertCount(); j++) {
      const a = poly.verts(j) * 3
      const b = poly.verts((j + 1) % poly.vertCount()) * 3
      out.push([tile.verts(a), tile.verts(a + 2), tile.verts(b), tile.verts(b + 2)])
    }
    return out
  }
  // The middle of the stretch of edge two polygons share (tile borders split edges differently).
  const portal = (a: number, b: number): [number, number] => {
    for (const [ax, az, bx, bz] of edges(a)) {
      const len = Math.hypot(bx! - ax!, bz! - az!)
      const ux = (bx! - ax!) / len
      const uz = (bz! - az!) / len
      for (const [cx, cz, dx, dz] of edges(b)) {
        const off = (x: number, z: number) => Math.abs((x - ax!) * uz - (z - az!) * ux)
        if (off(cx!, cz!) > 0.02 || off(dx!, dz!) > 0.02) continue
        const t0 = (cx! - ax!) * ux + (cz! - az!) * uz
        const t1 = (dx! - ax!) * ux + (dz! - az!) * uz
        const lo = Math.max(0, Math.min(t0, t1))
        const hi = Math.min(len, Math.max(t0, t1))
        if (hi - lo < 1e-3) continue
        const t = (lo + hi) / 2
        return [ax! + ux * t, az! + uz * t]
      }
    }
    throw new Error(`no portal between ${a} and ${b}`)
  }
  let x = path.corners[0]!
  let z = path.corners[2]!
  let total = 0
  for (let i = 0; i + 1 < polys.length; i++) {
    const [mx, mz] = portal(polys[i]!, polys[i + 1]!)
    total += Math.hypot(mx - x, mz - z) * cost(polys[i]!)
    x = mx
    z = mz
  }
  const e = (path.count - 1) * 3
  total +=
    Math.hypot(path.corners[e]! - x, path.corners[e + 2]! - z) * cost(polys[polys.length - 1]!)
  return total
}

function closest(world: World, agents: Entity[]): number {
  let min = Infinity
  for (let i = 0; i < agents.length; i++) {
    const a = at(world, agents[i]!)
    for (let j = i + 1; j < agents.length; j++) {
      const b = at(world, agents[j]!)
      min = Math.min(min, Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!))
    }
  }
  return min
}

describe('breaching', () => {
  for (const drive of ['transform', 'character'] as const) {
    for (const broken of [{ movement: 'none' }, { state: 'open' }] as const) {
      it(`waits at a closed front door and walks in once it's ${Object.values(broken)[0]} (${drive})`, async () => {
        const app = await headless()
        const world = app.world
        const h = breachHouse(world)
        await bake(app)
        const path = findPath(world, h.south, h.westRoom, { filter: 'zombie' })
        expect(path.status).toBe('complete')
        expect(path.breach).toBe(h.door)

        const survivor = world.spawn([Transform, { translation: h.westRoom }])
        const z = zombie(world, h.south, survivor, { drive })
        let entered = false
        const events = run(app, 900, () => status(world, z) === 'blocked')
        expect(status(world, z)).toBe('blocked')
        expect(events).toHaveLength(1)
        const e = events[0]!
        expect(e).toMatchObject({ entity: z, gate: h.door, flags: GATE_CLOSED, row: 0 })
        expect(world.get(z, NavAgentState).gate).toBe(h.door)
        // Its centre stands within gateMargin + 0.1 + stoppingDistance of the door's face (z = −0.1)…
        expect(Math.abs(at(world, z)[2]! + 0.1)).toBeLessThanOrEqual(0.6 + 0.1 + 0.2 + 1e-3)
        // …facing a point in the gap.
        expect(e.point[0]).toBeGreaterThanOrEqual(1.5)
        expect(e.point[0]).toBeLessThanOrEqual(2.5)
        expect(Math.abs(e.point[2])).toBeLessThan(1e-3)
        for (let i = 0; i < 600; i++) {
          frames(app)
          if (inFrontDoorGate(at(world, z))) entered = true
        }
        expect(entered).toBe(false)
        expect(status(world, z)).toBe('blocked')

        // Broken (or opened): it walks on the next frame, with no replan, and reaches the survivor.
        const nav = world.resource(Nav)
        const replans = nav.replans
        world.set(h.door, Opening, broken)
        frames(app)
        expect(status(world, z)).toBe('moving')
        run(app, 900, () => status(world, z) === 'arrived')
        expect(status(world, z)).toBe('arrived')
        expect(nav.replans).toBe(replans)
        expect(navAgentRecord(world, z)!.replans).toBe(0)
      })
    }
  }

  it('walks round to an open back door when bashing costs more, and bashes when it costs less', async () => {
    const app = await headless()
    const world = app.world
    const h = breachHouse(world, { backDoor: true })
    const rt = await bake(app)
    // D: the back door's route minus the front door's, as the planner costs them, for a filter
    // that walks through either.
    const route = (shut: Entity) => {
      world.set(shut, Opening, { state: 'locked' })
      world.set(shut === h.door ? h.backDoor! : h.door, Opening, { state: 'open' })
      frames(app)
      expect(findPath(world, h.south, h.westRoom, { filter: 'survivor' }).status).toBe('complete')
      return plannerCost(world, rt, h.south, h.westRoom, 'survivor')
    }
    const d = route(h.door) - route(h.backDoor!)
    expect(d).toBeGreaterThan(8)
    world.set(h.door, Opening, { state: 'closed' })
    world.set(h.backDoor!, Opening, { state: 'open' })
    world.insertResource(NavFilters, {
      ...FILTERS,
      dear: { ...ZOMBIE, breachCost: d + 4 },
      cheap: { ...ZOMBIE, breachCost: d - 4 },
    })
    frames(app)
    expect(findPath(world, h.south, h.westRoom, { filter: 'dear' }).breach).toBe(-1)
    expect(findPath(world, h.south, h.westRoom, { filter: 'cheap' }).breach).toBe(h.door)

    const round = zombie(world, h.south, h.westRoom, { filter: 'dear' })
    const bash = zombie(world, [h.south[0] + 1.5, 0, h.south[2]], h.westRoom, { filter: 'cheap' })
    const events = run(
      app,
      1800,
      () => status(world, round) === 'arrived' && status(world, bash) === 'blocked',
    )
    expect(status(world, round)).toBe('arrived')
    expect(status(world, bash)).toBe('blocked')
    expect(events.map((e) => [e.entity, e.gate])).toEqual([[bash, h.door]])
  })

  it('breaches a window, climbs it once broken, and avoids a barricaded one', async () => {
    const app = await headless()
    const world = app.world
    const h = breachHouse(world, { window: true })
    world.set(h.door, Opening, { state: 'locked' })
    world.insertResource(NavFilters, {
      ...FILTERS,
      climber: { ...ZOMBIE, breachCost: { 10: 200, 11: 5 } },
      careful: { ...ZOMBIE, exclude: ['custom'], breachCost: { 10: 200, 11: 5 } },
    })
    await bake(app)
    expect(findPath(world, h.eastSide, h.eastRoom, { filter: 'climber' }).breach).toBe(h.window)

    const z = zombie(world, h.eastSide, h.eastRoom, { filter: 'climber' })
    const events = run(app, 900, () => status(world, z) === 'blocked')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ entity: z, gate: h.window, flags: GATE_LOCKED, row: 0 })
    world.set(h.window!, Opening, { movement: 'none' })
    run(app, 900, () => status(world, z) === 'arrived')
    expect(status(world, z)).toBe('arrived')
    expect(navAgentRecord(world, z)!.replans).toBe(0)
    expect(at(world, z)[0]).toBeLessThan(10)

    // Boarded up, it's `custom` too: a filter that excludes that goes for the door instead.
    world.set(h.window!, Opening, { barricaded: true })
    frames(app)
    expect(findPath(world, h.eastSide, h.eastRoom, { filter: 'careful' }).breach).toBe(h.door)
  })

  it('breaches a Breach span, waits at it, and replans when the wall is split there', async () => {
    const filters = { ...FILTERS, smasher: { ...ZOMBIE, breachCost: { 10: 200, 8: 10 } } }
    const colliders = async (breach: boolean) => {
      const app = await headless(filters)
      const h = breachHouse(app.world, { breach })
      frames(app, 2)
      const set = app.world.resource(Physics).statics.get(h.west)!
      return set.colliders.length
    }
    expect(await colliders(true)).toBe(await colliders(false))

    const app = await headless(filters)
    const world = app.world
    const h = breachHouse(world, { breach: true })
    world.set(h.door, Opening, { state: 'locked' })
    await bake(app)
    expect(findPath(world, h.westSide, h.westRoom, { filter: 'smasher' }).breach).toBe(h.breach)
    expect(findPath(world, h.westSide, h.westRoom, { filter: 'survivor' }).status).toBe('partial')

    const z = zombie(world, h.westSide, h.westRoom, { filter: 'smasher' })
    const events = run(app, 900, () => status(world, z) === 'blocked')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ gate: h.breach, flags: GATE_CLOSED | GATE_LOCKED, row: 0 })
    // Its centre stays outside the wall's gate (x < −0.7).
    for (let i = 0; i < 300; i++) {
      frames(app)
      expect(at(world, z)[0]).toBeLessThan(-0.6)
    }

    // The game breaks it: the wall splits around the span.
    world.despawn(h.west)
    world.spawn([Wall, { a: [0, 6], b: [0, 3.75], height: 3 }])
    world.spawn([Wall, { a: [0, 2.25], b: [0, 0], height: 3 }])
    run(app, 900, () => status(world, z) === 'arrived')
    expect(status(world, z)).toBe('arrived')
    expect(navAgentRecord(world, z)!.replans).toBeGreaterThan(0)

    // Without a Breach the same wall is unbreachable: with the door barricaded (a state this
    // filter excludes), there's no way in, and nothing to wait at.
    const plain = await headless({
      smasher: { ...ZOMBIE, exclude: ['custom'], breachCost: { 10: 200, 8: 10 } },
    })
    const h2 = breachHouse(plain.world)
    plain.world.set(h2.door, Opening, { state: 'locked', barricaded: true })
    await bake(plain)
    const p = findPath(plain.world, h2.westSide, h2.westRoom, { filter: 'smasher' })
    expect(p.status).toBe('partial')
    expect(p.breach).toBe(-1)
    const z2 = zombie(plain.world, h2.westSide, h2.westRoom, { filter: 'smasher' })
    expect(run(plain, 300, () => false).filter((e) => e.entity === z2)).toEqual([])
    expect(status(plain.world, z2)).toBe('unreachable')
  })

  it('queues 30 zombies at one door in slots, then lets them all in with no replan', async () => {
    const horde = async (frames_: number) => {
      const app = await headless()
      const world = app.world
      const h = breachHouse(world)
      await bake(app)
      // One destination at the back of the west room: arrived agents don't wall off the door.
      const agents = arc(2, -0.1, 15).map((p) => zombie(world, p, [2.5, 0, 5.4]))
      const events = run(app, frames_, () => agents.every((e) => status(world, e) === 'blocked'))
      return { app, world, h, agents, events }
    }
    const { app, world, h, agents, events } = await horde(1200)
    expect(agents.map((e) => status(world, e))).toEqual(agents.map(() => 'blocked'))
    expect(closest(world, agents)).toBeGreaterThanOrEqual(1.9 * R)
    const rt = [...world.resource(Nav).meshes.values()][0]!
    const set = [...rt.slots.values()][0]!
    let front = 0
    for (let i = 0; i < set.count; i++) if (set.row[i] === 0) front++
    expect(agents.filter((e) => world.get(e, NavAgentState).row === 0)).toHaveLength(front)
    // Everyone holds a slot or waits in line for one.
    expect(agents.filter((e) => navAgentRecord(world, e)!.slot < 0)).toHaveLength(
      set.waiting.length,
    )
    for (const e of agents) {
      const p = at(world, e)
      expect(Math.hypot(p[0]! - 2, p[2]!)).toBeLessThan(6)
    }
    // One event each, plus one each time someone moved up a row.
    expect(new Set(events.map((e) => e.entity)).size).toBe(30)

    const nav = world.resource(Nav)
    const replans = nav.replans
    world.set(h.door, Opening, { state: 'open' })
    frames(app)
    // They walk on one at a time, nearest the door first.
    expect(agents.filter((e) => status(world, e) === 'moving')).toHaveLength(1)
    // All of them walk in (past the wall's inner face), with no replan.
    const inside = () => agents.every((e) => at(world, e)[2]! > 0.5)
    run(app, 2400, inside)
    expect(inside()).toBe(true)
    expect(nav.replans).toBe(replans)

    // The same run again gives the same world.
    const a = await horde(600)
    const b = await horde(600)
    expect(worldHashRows(a.world)).toEqual(worldHashRows(b.world))
  }, 120_000)

  it('queues 30 zombies no crowd moves, each told once', async () => {
    const app = await headless()
    const world = app.world
    const h = breachHouse(world)
    await bake(app)
    const goals = westRoomGrid()
    const agents = arc(2, -0.1, 15).map((p, i) => zombie(world, p, goals[i]!))
    for (const e of agents) setNavMover(world, e, 'external')
    // The test's mover: along the leg's corners, then to legEnd, at 3 m/s; nothing else.
    const walk = new Map<Entity, { next: number; leg: number; legCount: number }>()
    const mover = () => {
      for (const e of agents) {
        const rec = navAgentRecord(world, e)
        if (!rec || rec.count === 0) continue
        let m = walk.get(e)
        if (!m || rec.sinceRepath === 0) {
          m = { next: 1, leg: rec.leg, legCount: rec.legCount }
          walk.set(e, m)
        }
        if (rec.leg !== m.leg) {
          // The gate opened: on from the corner where the last leg entered it.
          m.next = Math.max(m.next, m.legCount)
          m.leg = rec.leg
        }
        m.legCount = rec.legCount
        const s = status(world, e)
        if (s === 'blocked' || s === 'arrived') continue
        const p = at(world, e)
        let left = 3 * DT
        const pos: Point = [p[0]!, p[1]!, p[2]!]
        while (left > 0) {
          const t =
            m.next < rec.legCount
              ? [
                  rec.corners[m.next * 3]!,
                  rec.corners[m.next * 3 + 1]!,
                  rec.corners[m.next * 3 + 2]!,
                ]
              : [rec.legEnd[0]!, rec.legEnd[1]!, rec.legEnd[2]!]
          const d = Math.hypot(t[0]! - pos[0], t[2]! - pos[2])
          if (d <= left) {
            pos[0] = t[0]!
            pos[1] = t[1]!
            pos[2] = t[2]!
            left -= d
            if (m.next < rec.legCount) m.next++
            else break
          } else {
            pos[0] += ((t[0]! - pos[0]) / d) * left
            pos[2] += ((t[2]! - pos[2]) / d) * left
            left = 0
          }
        }
        world.set(e, Transform, { translation: pos })
      }
    }
    const events: NavGateBlockedData[] = []
    const reader = world.reader(NavGateBlocked)
    for (let i = 0; i < 1200 && !agents.every((e) => status(world, e) === 'blocked'); i++) {
      frames(app)
      for (const e of reader.read()) events.push(e)
      mover()
    }
    expect(agents.map((e) => status(world, e))).toEqual(agents.map(() => 'blocked'))
    const slots = agents.map((e) => navAgentRecord(world, e)!.slot)
    expect(slots.every((s) => s >= 0)).toBe(true)
    expect(new Set(slots).size).toBe(30)
    expect(closest(world, agents)).toBeGreaterThanOrEqual(1.9 * R)
    expect(events.map((e) => e.entity).sort()).toEqual([...agents].sort())
    expect(agents.every((e) => navAgentRecord(world, e)!.crowdIndex === -1)).toBe(true)
    expect([...world.resource(Nav).meshes.values()][0]!.crowd).toBeNull()

    const nav = world.resource(Nav)
    const replans = nav.replans
    world.set(h.door, Opening, { state: 'open' })
    frames(app)
    // One at a time, nearest the door first.
    expect(agents.filter((e) => status(world, e) === 'moving')).toHaveLength(1)
    for (let i = 0; i < 2400 && !agents.every((e) => status(world, e) === 'arrived'); i++) {
      frames(app)
      mover()
    }
    expect(agents.map((e) => status(world, e))).toEqual(agents.map(() => 'arrived'))
    expect(nav.replans).toBe(replans)
  }, 60_000)

  // 0115's criterion: a horde on a flow field, all in steer (no crowd), queues at a shut door its
  // filter breaches, then walks on along the field without a findPath call.
  // At the default flowMs the field lands before the horde moves; at 0.05 ms a frame it lands while
  // they walk, so some open their leg at the door late (what a slow CI machine does).
  it.each([1, 0.05])(
    'queues a flow-field horde in steer at a shut door, then lets it in with no findPath (flowMs %s)',
    async (flowMs) => {
      const app = new App().addPlugin(
        TransformPlugin,
        physics3dPlugin(),
        navPlugin,
        navTiersPlugin,
        structurePhysicsPlugin,
        structureNavPlugin,
      )
      await app.init()
      const world = app.world
      world.insertResource(NavFilters, FILTERS)
      world.initResource(NavBudget).flowMs = flowMs
      const h = breachHouse(world)
      await bake(app)
      const flow = world.spawn([NavFlowField, { goal: h.westRoom, filter: 'zombie', range: 40 }])
      const agents = arc(2, -0.1, 15).map((p) =>
        world.spawn(
          [NavAgent, { flow, filter: 'zombie', drive: 'transform', speed: 3, radius: R }],
          [NavTier, { tier: 'steer' }],
          [Transform, { translation: p }],
        ),
      )
      const gate = world.resource(Nav).gates.byOwner.get(h.door)!
      const inGate = (e: Entity) => {
        const p = at(world, e)
        return insideConvex(gate.points!, p[0]!, p[2]!)
      }
      let entered = 0
      const events: NavGateBlockedData[] = []
      const reader = world.reader(NavGateBlocked)
      for (let i = 0; i < 1800 && !agents.every((e) => status(world, e) === 'blocked'); i++) {
        frames(app)
        for (const e of reader.read()) events.push(e)
        for (const e of agents) if (inGate(e)) entered++
      }
      expect(agents.map((e) => status(world, e))).toEqual(agents.map(() => 'blocked'))
      expect(entered).toBe(0)
      const slots = agents.map((e) => navAgentRecord(world, e)!.slot)
      expect(new Set(slots).size).toBe(30)
      expect(new Set(events.map((e) => e.entity)).size).toBe(30)
      expect(agents.every((e) => navAgentRecord(world, e)!.crowdIndex === -1)).toBe(true)
      // The door opens: on along the field, no findPath for any of them.
      world.set(h.door, Opening, { state: 'open' })
      // One goal for 30: they arrive as a crowd in the room around it, not all on it.
      const inRoom = (e: Entity) => {
        const p = at(world, e)
        return p[0]! > 0.2 && p[0]! < 4.8 && p[2]! > 0.2 && p[2]! < 5.8
      }
      for (let i = 0; i < 3600 && !agents.every(inRoom); i++) frames(app)
      expect(agents.filter((e) => !inRoom(e))).toEqual([])
      expect(agents.reduce((n, e) => n + navAgentRecord(world, e)!.paths, 0)).toBe(0)
    },
    120_000,
  )

  it('replans only the agents whose paths cross a gate that changed, and builds no tile', async () => {
    const app = await headless({
      ...FILTERS,
      weak: { breach: ['closed'], exclude: ['locked'] },
    })
    const world = app.world
    world.spawn([
      Floor,
      {
        points: [
          [-20, -20],
          [60, -20],
          [60, 26],
          [-20, 26],
        ],
      },
    ])
    const a = breachHouse(world, { ground: false })
    // Off the tile grid's corners: a 1 m door whose gap sits on one doesn't pass (0112).
    const b = breachHouse(world, { ground: false, at: [31, 0] })
    world.set(b.door, Opening, { state: 'open' })
    const rt = await bake(app)
    const built = rt.stats.totalBuilt
    const nav = world.resource(Nav)
    const goals = westRoomGrid()
    const atA = arc(2, -0.1, 12).map((p, i) => zombie(world, p, goals[i]!))
    const weak = arc(2, -0.1, 14)
      .slice(0, 6)
      .map((p, i) => zombie(world, p, goals[i + 24]!, { filter: 'weak' }))
    const goalsB = westRoomGrid(31)
    const toB = arc(33, -0.1, 16)
      .slice(0, 20)
      .map((p, i) => zombie(world, p, goalsB[i]!))
    const survivors: Entity[] = []
    for (let i = 0; i < 20; i++)
      survivors.push(
        zombie(world, [-15 + (i % 5), 0, -15 + Math.floor(i / 5)], [-15 + (i % 5), 0, 20], {
          filter: 'survivor',
        }),
      )
    run(app, 1200, () => [...atA, ...weak].every((e) => status(world, e) === 'blocked'))
    expect([...atA, ...weak].every((e) => status(world, e) === 'blocked')).toBe(true)
    const crossingB = toB.filter((e) => navAgentRecord(world, e)!.pathGates.includes(b.door))
    expect(crossingB.length).toBeGreaterThan(0)
    const replans = (e: Entity) => navAgentRecord(world, e)!.replans

    // B shuts: exactly the zombies whose paths cross it replan.
    const everyone = [...atA, ...weak, ...toB, ...survivors]
    const base = new Map(everyone.map((e) => [e, replans(e)]))
    world.set(b.door, Opening, { state: 'closed' })
    frames(app, Math.ceil(crossingB.length / 6) + 1)
    const replanned = everyone.filter((e) => replans(e) > base.get(e)!)
    expect(replanned.sort()).toEqual([...crossingB].sort())

    // A locks: the weak zombies (which can't breach a lock) replan, nobody else.
    const before = nav.replans
    world.set(a.door, Opening, { state: 'locked' })
    frames(app, Math.ceil(weak.length / 6) + 1)
    expect(weak.every((e) => replans(e) === base.get(e)! + 1)).toBe(true)
    expect(nav.replans - before).toBe(weak.length)

    // A opens: the zombies waiting there walk on, in turn, and none of them replans (the weak
    // ones, unreachable since the lock, replan on any change).
    const waiting = new Map(atA.map((e) => [e, replans(e)]))
    world.set(a.door, Opening, { state: 'open' })
    frames(app)
    expect(atA.some((e) => status(world, e) === 'moving')).toBe(true)
    frames(app, 900)
    expect(atA.filter((e) => status(world, e) === 'blocked').length).toBeLessThan(atA.length / 2)
    expect(atA.every((e) => replans(e) === waiting.get(e))).toBe(true)
    expect(rt.stats.totalBuilt).toBe(built)
  }, 60_000)

  it('keeps every filter off an open hatch, breaching or not', async () => {
    const app = await headless({ ...FILTERS, smasher: { breach: ['closed', 'locked', 'custom'] } })
    const world = app.world
    breachHouse(world)
    const deck = world.spawn([
      Floor,
      {
        points: [
          [14, 10],
          [18, 10],
          [18, 14],
          [14, 14],
        ],
        elevation: 0.2,
      },
    ])
    const hatch = world.spawn([
      Cutout,
      {
        host: deck,
        kind: 'hatch',
        points: [
          [15.5, 11.5],
          [16.5, 11.5],
          [16.5, 12.5],
          [15.5, 12.5],
        ],
      },
    ])
    await bake(app)
    world.set(hatch, Cutout, { state: 'open' })
    frames(app)
    for (const filter of [undefined, 'survivor', 'zombie', 'smasher']) {
      const p = findPath(world, [14.5, 0.2, 12], [17.5, 0.2, 12], { filter })
      expect(p.status).toBe('complete')
      expect(p.length).toBeGreaterThan(3.2)
      expect(p.breach).toBe(-1)
    }
  })

  it('keeps tile keys and bytes through breaching filters and door toggles', async () => {
    const app = await headless({ survivor: { exclude: ['locked'] } })
    const world = app.world
    const h = breachHouse(world, { backDoor: true, window: true, breach: true })
    const rt = await bake(app)
    const tiles = () => [...rt.tiles.values()].map((t) => `${t.key}:${t.bytes?.join(',')}`)
    const before = tiles()
    const built = rt.stats.totalBuilt
    world.insertResource(NavFilters, FILTERS)
    for (const state of ['locked', 'open', 'closed'] as const) {
      world.set(h.door, Opening, { state })
      world.set(h.backDoor!, Opening, { state })
      frames(app, 2)
    }
    expect(navReady(world)).toBe(true)
    expect(tiles()).toEqual(before)
    expect(rt.stats.totalBuilt).toBe(built)
  })
})

/** The town at the spec's size where budgets are held (pnpm bench); smaller where only correctness is. */
const BENCH = timingMode === 'bench'
const BUILDINGS = BENCH ? 200 : 30
const HOUSES = BENCH ? 50 : 10

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!

async function countGc(fn: () => void): Promise<number> {
  globalThis.gc?.()
  await new Promise((r) => setTimeout(r, 200))
  const gcs = gcWindow()
  fn()
  return gcs.end()
}

describe('breaching budgets', () => {
  it("plans a breach and builds a door's slots on the town within budget", async () => {
    const app = await headless()
    const world = app.world
    const t = town(world, { buildings: BUILDINGS })
    const rt = await bake(app)
    // A building in the third row, from 40 m south of its front door to its back room.
    const b =
      t.buildings[Math.min(t.buildings.length - 1, Math.ceil(Math.sqrt(BUILDINGS)) * 2 + 1)]!
    const [x0, z0, x1, z1] = b.bounds
    const door = world.resource(Nav).gates.byOwner.get(b.doors[0]!)!
    const from: Point = [door.mx, 0, z0 - 42]
    const to: Point = [x1 - 1, 0, (z0 + z1) / 2]
    expect(x0).toBeLessThan(x1)
    const first = findPath(world, from, to, { filter: 'zombie' })
    expect(first.status).toBe('complete')
    // In by one of its doors or windows (they cost the same 20 m to breach).
    expect([...b.doors, ...b.windows]).toContain(first.breach)
    const plans: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      findPath(world, from, to, { filter: 'zombie' })
      plans.push(performance.now() - t0)
    }
    expect(median(plans)).toBeLessThan(budget('nav/breach-path'))

    const entry = [door.mx, 0.1, door.mz - door.az * (door.depth / 2)]
    const side = door.az > 0 ? -1 : 1
    const builds: number[] = []
    let slots = 0
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      slots = buildSlots(rt, door, side, entry, R, 'zombie', {
        claim: 4,
        spread: 0.5,
        rows: 8,
      }).count
      builds.push(performance.now() - t0)
    }
    expect(slots).toBeGreaterThanOrEqual(30)
    expect(median(builds)).toBeLessThan(budget('nav/gate-slots'))
  })

  it('settles and releases a horde at a door within budget, allocating nothing while it waits', async () => {
    const app = await headless()
    const world = app.world
    const h = breachHouse(world)
    await bake(app)
    const profiler = world.resource(ProfilerResource)
    const agents = arc(2, -0.1, 15).map((p) => zombie(world, p, [2.5, 0, 5.4]))
    const settle: number[] = []
    for (let i = 0; i < 1200 && !agents.every((e) => status(world, e) === 'blocked'); i++) {
      frames(app)
      settle.push(profiler.timing('nav/agents')?.last ?? 0)
    }
    expect(agents.every((e) => status(world, e) === 'blocked')).toBe(true)
    expect(p95(settle)).toBeLessThan(budget('nav/breach-agents'))

    frames(app, 30)
    const gc = await countGc(() => frames(app, 120))
    if (allocationChecks) expect(gc).toBe(0)

    // The door opens (the first in line walks on) and shuts again (it comes back), five times.
    const SPANS = [
      'structure/sync-fixed',
      'structure/nav-fixed',
      'nav/agents',
      'structure/sync',
      'structure/nav',
      'nav/bake',
    ]
    const opens: number[] = []
    for (let k = 0; k < 5; k++) {
      world.set(h.door, Opening, { state: 'open' })
      frames(app)
      let ms = 0
      for (const span of SPANS) ms += profiler.timing(span)?.last ?? 0
      opens.push(ms)
      expect(agents.filter((e) => status(world, e) === 'moving').length).toBeGreaterThan(0)
      world.set(h.door, Opening, { state: 'closed' })
      frames(app, 60)
    }
    expect(median(opens)).toBeLessThan(budget('nav/breach-open'))
  }, 60_000)

  it('keeps 300 agents within budget while zombies breach houses across the town', async () => {
    const app = await headless()
    const world = app.world
    const t = town(world, { buildings: BUILDINGS })
    await bake(app)
    const profiler = world.resource(ProfilerResource)
    // Three zombies at each of the first houses, after a survivor in its back room.
    for (const b of t.buildings.slice(0, HOUSES)) {
      const [, z0, x1, z1] = b.bounds
      const survivor = world.spawn([Transform, { translation: [x1 - 1, 0, (z0 + z1) / 2] }])
      for (let i = 0; i < 3; i++) zombie(world, [b.bounds[0] + 1 + i * 2, 0, z0 - 3], survivor)
    }
    // As many survivors again, walking across the town.
    const [bx0, bz0, bx1, bz1] = t.bounds
    for (let i = 0; i < HOUSES * 3; i++) {
      const x = bx0 + 2 + ((i * 7.3) % (bx1 - bx0 - 4))
      zombie(world, [x, 0, bz0 + 1], [x, 0, bz1 - 1], { filter: 'survivor' })
    }
    const times: number[] = []
    for (let i = 0; i < 600; i++) {
      frames(app)
      times.push(profiler.timing('nav/agents')?.last ?? 0)
    }
    expect(p95(times)).toBeLessThan(budget('nav/town-agents'))
  }, 120_000)
})

/** Whether (x, z) lies inside a convex polygon of (x, z) pairs. */
function insideConvex(points: Float64Array, x: number, z: number): boolean {
  const n = points.length / 2
  let sign = 0
  for (let i = 0; i < n; i++) {
    const ax = points[i * 2]!
    const az = points[i * 2 + 1]!
    const bx = points[((i + 1) % n) * 2]!
    const bz = points[((i + 1) % n) * 2 + 1]!
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax)
    if (cross === 0) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}
