import type { Entity, World } from '@aethervtt/shard-core'
import { Collider } from '@aethervtt/shard-physics'
import type { App } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import {
  NavAgent,
  NavAgentState,
  NavBudget,
  NavFilters,
  NavFlowField,
  NavMesh,
  NavSource,
  NavTier,
} from './components'
import type { FlowField } from './flow'
import { NavFlows } from './flow-state'
import { describeNav } from './methods'
import type { NavMeshRuntime } from './navmesh'
import { findPath } from './query'
import { GATE_CLOSED, GATE_LOCKED } from './recast'
import { Nav } from './state'
import { navMoverTier } from './steer-state'
import { box, frames, navApp, shape, slab } from './test-level'
import { navTiersPlugin } from './tiers-plugin'

// Flow fields (0115): a Dijkstra over navmesh polygons from a goal, which many agents follow
// without a findPath each.

const DT = 1 / 60
const FLOOR = 1 as Entity
const WALL = 2 as Entity
const NEAR_DOOR = 3 as Entity
const FAR_DOOR = 4 as Entity
type Point = [number, number, number]

/**
 * Two rooms on a 40 × 20 m floor, split at x = 0 by a 0.2 m wall with two 1 m doorways: the near
 * one over z ∈ [4.5, 5.5] and the far one over z ∈ [14.5, 15.5], each a door gate (0112). 0.1 m
 * cells and a 0.3 m agent, as structure's town.
 */
async function rooms(): Promise<{ app: App; world: World; rt: NavMeshRuntime }> {
  const app = await navApp(navTiersPlugin)
  const world = app.world
  world.spawn([
    NavMesh,
    { cellSize: 0.1, cellHeight: 0.1, tileSize: 64, agentRadius: 0.3, agentHeight: 1.8 },
  ])
  world.insertResource(NavFilters, { zombie: { exclude: ['locked'] } })
  const nav = world.resource(Nav)
  nav.shapes.set(FLOOR, shape(box(-20, -0.2, 0, 20, 0, 20)))
  nav.shapes.set(
    WALL,
    shape(
      box(-0.1, 0, 0, 0.1, 3, 4.5),
      box(-0.1, 0, 5.5, 0.1, 3, 14.5),
      box(-0.1, 0, 15.5, 0.1, 3, 20),
    ),
  )
  for (const [door, z] of [
    [NEAR_DOOR, 4.5],
    [FAR_DOOR, 14.5],
  ] as const) {
    nav.gates.set(door, {
      points: [
        [-0.4, z],
        [0.4, z],
        [0.4, z + 1],
        [-0.4, z + 1],
      ],
      yMin: -0.5,
      yMax: 0.5,
      area: 10,
    })
  }
  frames(app, 3)
  return { app, world, rt: [...nav.meshes.values()][0]! }
}

function fieldOf(world: World, e: Entity): FlowField {
  return world.resource(NavFlows).fields.get(e)!
}

/** Steps until the field has landed `builds` builds. */
function untilBuilt(app: App, f: FlowField, builds = 1, max = 600): number {
  let n = 0
  while (f.builds < builds && n < max) {
    app.update(DT)
    n++
  }
  return n
}

function follower(
  world: World,
  flow: Entity,
  at: Point,
  tier: 'crowd' | 'steer' | 'coarse',
  filter = '',
) {
  return world.spawn(
    [NavAgent, { flow, filter, speed: 3, radius: 0.3, drive: 'transform' }],
    [NavTier, { tier }],
    [Transform, { translation: at }],
  )
}

const paths = (world: World, agents: Entity[]) =>
  agents.reduce((n, e) => n + world.resource(Nav).agents.get(e)!.paths, 0)

describe('flow fields', () => {
  it('leads every polygon to the goal about as far as findPath does', async () => {
    const { app, world, rt } = await rooms()
    const goal: Point = [10, 0, 5]
    const flow = world.spawn([NavFlowField, { goal }])
    frames(app, 1)
    const f = fieldOf(world, flow)
    untilBuilt(app, f)
    const d = f.cur!
    const g = f.graph!
    // Every polygon reached walks to the goal's polygon without a loop.
    let reached = 0
    for (let n = 0; n < g.nodes; n++) {
      if (!d.has(n)) continue
      reached++
      let k = n
      let steps = 0
      while (d.next[k]! >= 0 && steps <= g.nodes) {
        k = d.next[k]!
        steps++
      }
      expect(k).toBe(d.goalNode)
    }
    expect(reached).toBe(d.reached)
    expect(reached).toBeGreaterThan(20)
    // Field cost against findPath's length from points across both rooms.
    const ratios: number[] = []
    for (let i = 0; i < 60; i++) {
      const p: Point = [-19 + ((i * 7.3) % 38), 0, 0.6 + ((i * 3.7) % 18.8)]
      if (Math.abs(p[0]) < 0.6) continue
      const r = rt.query.findNearestPoly(
        { x: p[0], y: 0, z: p[2] },
        { halfExtents: { x: 0.5, y: 1, z: 0.5 } },
      )
      if (!r.success || r.nearestRef === 0) continue
      const n = g.node(r.nearestRef)
      expect(d.has(n)).toBe(true)
      const at = r.nearestPoint
      const cost = d.costAt(n, at.x, at.z)
      const path = findPath(world, [at.x, at.y, at.z], goal)
      expect(path.status).toBe('complete')
      expect(Math.abs(cost - path.length)).toBeLessThan(0.05 * path.length + 0.1)
      if (path.length >= 2) ratios.push(cost / path.length)
    }
    ratios.sort((a, b) => a - b)
    // Within 5% (plus 0.1 m) of findPath's either way: Detour's own corridor isn't always the
    // shortest, and its lengths count height.
    console.info(
      `flow field vs findPath: ${ratios[0]!.toFixed(3)}–${ratios.at(-1)!.toFixed(3)}, median ${ratios[ratios.length >> 1]!.toFixed(3)} (${ratios.length} points, ${reached} polygons)`,
    )
  })

  it('reroutes followers through the other door when one locks, with no findPath call', async () => {
    const { app, world } = await rooms()
    const goal: Point = [10, 0, 5]
    const flow = world.spawn([NavFlowField, { goal, filter: 'zombie' }])
    frames(app, 1)
    const f = fieldOf(world, flow)
    untilBuilt(app, f)
    const agents: Entity[] = []
    for (let i = 0; i < 20; i++)
      agents.push(
        follower(
          world,
          flow,
          [-15 + (i % 5) * 1.5, 0, 2 + Math.floor(i / 5) * 1.5],
          i % 2 ? 'steer' : 'coarse',
          'zombie',
        ),
      )
    frames(app, 30)
    const builds = f.builds
    // The near door locks before anyone reaches it.
    world.resource(Nav).gates.setFlags(NEAR_DOOR, GATE_CLOSED | GATE_LOCKED)
    const crossed = new Map<Entity, number>()
    const last = new Map(agents.map((e) => [e, world.get(e, Transform).translation[0]]))
    for (let i = 0; i < 60 * 30; i++) {
      app.update(DT)
      for (const e of agents) {
        const p = world.get(e, Transform).translation
        if (last.get(e)! < 0 && p[0] >= 0 && !crossed.has(e)) crossed.set(e, p[2])
        last.set(e, p[0])
      }
    }
    expect(f.builds).toBeGreaterThan(builds)
    expect(crossed.size).toBe(agents.length)
    for (const z of crossed.values()) expect(z).toBeGreaterThan(14)
    for (const e of agents) {
      const p = world.get(e, Transform).translation
      expect(Math.hypot(p[0] - goal[0], p[2] - goal[2])).toBeLessThan(4)
    }
    expect(paths(world, agents)).toBe(0)
  })

  it('leads 200 steer and coarse agents with no findPath call', async () => {
    const app = await navApp(navTiersPlugin)
    const world = app.world
    slab(world, 0, 0, 40, 40, 0)
    for (let i = 0; i < 12; i++) {
      world.spawn(
        [NavSource, {}],
        [Collider, { shape: 'cuboid', halfExtents: [1.5, 1, 1.5] }],
        [Transform, { translation: [-24 + (i % 4) * 16, 1, -16 + Math.floor(i / 4) * 16] }],
      )
    }
    world.spawn([NavMesh, { tileSize: 64 }])
    frames(app, 2)
    const goal: Point = [0, 0, 0]
    const flow = world.spawn([NavFlowField, { goal }])
    const agents: Entity[] = []
    for (let i = 0; i < 200; i++) {
      const a = (i / 200) * Math.PI * 2
      const r = 33 + (i % 5) * 1.5
      agents.push(
        follower(world, flow, [Math.cos(a) * r, 0, Math.sin(a) * r], i % 3 ? 'coarse' : 'steer'),
      )
    }
    const start = agents.map((e) => Math.hypot(...world.get(e, Transform).translation))
    frames(app, 60 * 15)
    const end = agents.map((e) => {
      const p = world.get(e, Transform).translation
      return Math.hypot(p[0], p[2])
    })
    expect(paths(world, agents)).toBe(0)
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
    expect(mean(end)).toBeLessThan(mean(start) * 0.3)
    expect(Math.max(...end)).toBeLessThan(15)
    const d = describeNav(world)
    expect(d.flows[0]?.agents).toBe(200)
    expect(d.agents.filter((a) => a.tier !== 'crowd')).toHaveLength(200)
  })

  it('builds in slices, and agents follow the old field until the new one lands', async () => {
    const { app, world } = await rooms()
    world.insertResource(NavBudget, { ...world.initResource(NavBudget), flowMs: 0.02 })
    const flow = world.spawn([NavFlowField, { goal: [10, 0, 5] }])
    app.update(DT)
    const f = fieldOf(world, flow)
    const n = untilBuilt(app, f) + 1
    expect(n).toBeGreaterThan(1)
    expect(f.lastSlices).toBeGreaterThan(1)
    const agent = follower(world, flow, [-10, 0, 5], 'steer')
    frames(app, 10)
    const first = f.cur
    world.set(flow, NavFlowField, { goal: [10, 0, 15] })
    app.update(DT)
    // Building toward the new goal; agents still have the old field.
    expect(f.building).not.toBeNull()
    expect(f.cur).toBe(first)
    const p0 = world.get(agent, Transform).translation[0]
    app.update(DT)
    expect(world.get(agent, Transform).translation[0]).toBeGreaterThan(p0)
    untilBuilt(app, f, 2)
    expect(f.cur).not.toBe(first)
    expect(f.cur!.goal[2]).toBeCloseTo(15, 0)
  })

  it('crowd followers path normally, and followers outside the field fall back to findPath', async () => {
    const { app, world } = await rooms()
    const goal: Point = [10, 0, 5]
    const flow = world.spawn([NavFlowField, { goal, range: 12 }])
    frames(app, 1)
    untilBuilt(app, fieldOf(world, flow))
    const crowd = follower(world, flow, [5, 0, 3], 'crowd')
    const outside = follower(world, flow, [-15, 0, 5], 'steer')
    frames(app, 2)
    const nav = world.resource(Nav)
    expect(nav.agents.get(crowd)!.crowdIndex).toBeGreaterThanOrEqual(0)
    expect(nav.agents.get(crowd)!.paths).toBeGreaterThan(0)
    expect(nav.agents.get(outside)!.paths).toBe(1)
    expect(navMoverTier(world, outside)).toBe('steer')
    for (let i = 0; i < 60 * 15; i++) app.update(DT)
    expect(world.get(crowd, NavAgentState).status).toBe('arrived')
    const p = world.get(outside, Transform).translation
    expect(Math.hypot(p[0] - goal[0], p[2] - goal[2])).toBeLessThan(1)
    // It took the field once inside it, so the one path was all it needed.
    expect(nav.agents.get(outside)!.paths).toBe(1)
  })
})
