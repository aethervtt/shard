import { type Entity, ProfilerResource, Rng, type World } from '@aethervtt/shard-core'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import {
  bakeNavigation,
  Nav,
  NavAgent,
  NavBudget,
  NavFilters,
  NavFlowField,
  NavFlows,
  NavMesh,
  type NavMeshRuntime,
  NavTier,
  navMoverTier,
  navPlugin,
  navTiersPlugin,
} from '@aethervtt/shard-nav'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { structureNavPlugin } from './nav'
import { town } from './town'

// Movement tiers and flow fields (0115) on 0112's town, headless, as a game server runs them:
// players are positions, and tiers come from the distance to the nearest one.

const DT = 1 / 60
const MESH = { cellSize: 0.1, cellHeight: 0.1, tileSize: 64, agentRadius: 0.3, agentHeight: 1.8 }
const FILTERS = {
  survivor: { exclude: ['locked' as const] },
  zombie: { exclude: ['closed' as const, 'locked' as const], areas: { 11: 0 } },
}
/** The spec's size where budgets are held (pnpm bench); smaller where only correctness is. */
const BENCH = timingMode === 'bench'
const BUILDINGS = BENCH ? 200 : 30
const AGENTS = BENCH ? 1000 : 150
const HORDE = BENCH ? 200 : 40
const FRAMES = BENCH ? 600 : 300
/** Sim tiers by distance to the nearest player (characters' simNear and simMid). */
const NEAR = 30
const MID = 80
const SYSTEMS = ['nav/tiers', 'nav/flow', 'nav/agents', 'nav/steer']

type Point = [number, number, number]

async function server(): Promise<App> {
  const app = new App().addPlugin(TransformPlugin, navPlugin, navTiersPlugin, structureNavPlugin)
  await app.init()
  app.world.insertResource(NavFilters, FILTERS)
  return app
}

const runtime = (world: World): NavMeshRuntime => [...world.resource(Nav).meshes.values()][0]!

/** How far (x, z) is from the nearest polygon `filter` passes (∞: none within 1 m). */
function offMesh(rt: NavMeshRuntime, p: ArrayLike<number>, filter: string): number {
  const r = rt.query.findNearestPoly(
    { x: p[0]!, y: p[1]!, z: p[2]! },
    { halfExtents: { x: 1, y: 2, z: 1 }, filter: rt.queryFilter(filter) },
  )
  if (!r.success || r.nearestRef === 0) return Number.POSITIVE_INFINITY
  return Math.hypot(r.nearestPoint.x - p[0]!, r.nearestPoint.z - p[2]!)
}

/**
 * NavTier from the distance to the nearest player: crowd within 30 m (the nearest
 * NavBudget.crowd), steer within 80 m, coarse beyond. Returns the tier each agent got.
 */
function assignTiers(
  world: World,
  agents: Entity[],
  players: Point[],
  cap: number,
): Map<Entity, string> {
  const dist = agents.map((e) => {
    const p = world.get(e, Transform).translation
    let best = Number.POSITIVE_INFINITY
    for (const q of players) best = Math.min(best, Math.hypot(p[0] - q[0], p[2] - q[2]))
    return { e, d: best }
  })
  dist.sort((a, b) => a.d - b.d)
  const out = new Map<Entity, string>()
  let crowd = 0
  for (const { e, d } of dist) {
    const tier = d <= NEAR && crowd < cap ? 'crowd' : d <= MID ? 'steer' : 'coarse'
    if (tier === 'crowd') crowd++
    out.set(e, tier)
    if (world.get(e, NavTier).tier !== tier) world.set(e, NavTier, { tier: tier as 'crowd' })
  }
  return out
}

const xz = (p: Point): [number, number] => [p[0], p[2]]

const percentile = (v: number[], p: number) =>
  [...v].sort((a, b) => a - b)[Math.floor(v.length * p)]!

describe('movement tiers on the town', () => {
  it(
    'steps 1,000 agents for 4 players within the server tick, horde on a flow field without findPath',
    async () => {
      const app = await server()
      const world = app.world
      const t = town(world, { buildings: BUILDINGS })
      world.spawn([NavMesh, MESH])
      app.update(DT)
      await bakeNavigation(world)
      const [x0, z0, x1, z1] = t.bounds
      const w = x1 - x0
      const d = z1 - z0
      // Players in the town's west half; the horde and its noise in the east.
      const players: Point[] = [
        [x0 + w * 0.15, 0, z0 + d * 0.2],
        [x0 + w * 0.15, 0, z0 + d * 0.8],
        [x0 + w * 0.35, 0, z0 + d * 0.35],
        [x0 + w * 0.3, 0, z0 + d * 0.65],
      ]
      // Lots are 20 m with their buildings 4 m in: the first 3 m of a lot is street.
      const street = (x: number, z: number): Point => [
        x0 + Math.floor((x - x0) / 20) * 20 + 0.5 + rng.float() * 2.5,
        0,
        z0 + Math.floor((z - z0) / 20) * 20 + 0.5 + rng.float() * 2.5,
      ]
      const rng = new Rng(3)
      const noise = street(x0 + w * 0.92, z0 + d * 0.5)
      const flow = world.spawn([NavFlowField, { goal: noise, filter: 'zombie' }])
      const point = (fx0: number, fx1: number): Point => [
        x0 + 1 + (fx0 + rng.float() * (fx1 - fx0)) * (w - 2),
        0,
        z0 + 1 + rng.float() * (d - 2),
      ]
      const agents: Entity[] = []
      const horde: Entity[] = []
      for (let i = 0; i < AGENTS; i++) {
        const isHorde = i < HORDE
        const value = isHorde
          ? { flow, filter: 'zombie', drive: 'transform' as const, speed: 2, radius: 0.3 }
          : {
              destination: point(0, 1),
              filter: i % 2 ? 'zombie' : 'survivor',
              drive: 'transform' as const,
              speed: 3,
              radius: 0.3,
            }
        const e = world.spawn(
          [NavAgent, value],
          [NavTier, { tier: 'coarse' }],
          [Transform, { translation: isHorde ? street(...xz(point(0.62, 0.8))) : point(0, 1) }],
        )
        agents.push(e)
        if (isHorde) horde.push(e)
      }
      const cap = world.initResource(NavBudget).crowd ?? 128
      const nav = world.resource(Nav)
      const profiler = world.resource(ProfilerResource)
      const tickMs: number[] = []
      let crowdMax = 0
      let hordePathsBelowCrowd = 0
      let worstOff = 0
      let tiers = assignTiers(world, agents, players, cap)
      const startDist = horde.map((e) => {
        const p = world.get(e, Transform).translation
        return Math.hypot(p[0] - noise[0], p[2] - noise[2])
      })
      for (let f = 0; f < FRAMES; f++) {
        tiers = assignTiers(world, agents, players, cap)
        const before = horde.map(
          (e) => [navMoverTier(world, e), nav.agents.get(e)?.paths ?? 0] as const,
        )
        app.update(DT)
        let ms = 0
        for (const span of SYSTEMS) ms += profiler.timing(span)?.last ?? 0
        if (f >= 30) tickMs.push(ms)
        horde.forEach((e, i) => {
          const [tier, paths] = before[i]!
          const now = nav.agents.get(e)!
          if (tier !== 'crowd' && navMoverTier(world, e) !== 'crowd' && now.paths > paths)
            hordePathsBelowCrowd += now.paths - paths
        })
        let crowd = 0
        for (const e of agents) {
          const mover = navMoverTier(world, e)
          if (mover === 'crowd') {
            crowd++
            // Nobody the players' distances put below the crowd is in it.
            expect(tiers.get(e)).toBe('crowd')
          }
        }
        crowdMax = Math.max(crowdMax, crowd)
        if (f % 30 === 0) {
          const rt = runtime(world)
          for (const e of agents) {
            const rec = nav.agents.get(e)!
            worstOff = Math.max(
              worstOff,
              offMesh(rt, world.get(e, Transform).translation, rec.filter),
            )
          }
        }
      }
      const endDist = horde.map((e) => {
        const p = world.get(e, Transform).translation
        return Math.hypot(p[0] - noise[0], p[2] - noise[2])
      })
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
      const field = world.resource(NavFlows).fields.get(flow)!
      const p95 = percentile(tickMs, 0.95)
      const counts = { crowd: 0, steer: 0, coarse: 0 }
      for (const e of agents) counts[navMoverTier(world, e)]++
      console.info(
        `server tick, ${AGENTS} agents on ${BUILDINGS} buildings: ${SYSTEMS.join(' + ')} p95 ${p95.toFixed(3)} ms, median ${percentile(tickMs, 0.5).toFixed(3)} ms, worst ${Math.max(...tickMs).toFixed(3)} ms; tiers at the end ${JSON.stringify(counts)}, crowd at most ${crowdMax}; horde findPath below the crowd ${hordePathsBelowCrowd}, fallbacks ${field.fallbacks}; horde to the noise ${mean(startDist).toFixed(1)} → ${mean(endDist).toFixed(1)} m; worst off the navmesh ${worstOff.toFixed(3)} m`,
      )
      expect(crowdMax).toBeLessThanOrEqual(cap)
      expect(hordePathsBelowCrowd).toBe(0)
      expect(worstOff).toBeLessThanOrEqual(0.1)
      // At 2 m/s, through streets and round each other: at least 40% of the way straight there.
      expect(mean(startDist) - mean(endDist)).toBeGreaterThan(0.4 * 2 * FRAMES * DT)
      expect(p95).toBeLessThan(budget('characters/server-tick'))
    },
    timeout(120_000),
  )

  it(
    'builds a 300 m field on the town within budget, in slices of flowMs',
    async () => {
      const app = await server()
      const world = app.world
      const t = town(world, { buildings: BUILDINGS })
      world.spawn([NavMesh, MESH])
      app.update(DT)
      await bakeNavigation(world)
      const [x0, z0, x1, z1] = t.bounds
      const goal: Point = [(x0 + x1) / 2, 0, (z0 + z1) / 2]
      const flow = world.spawn([NavFlowField, { goal, range: 300, filter: 'zombie' }])
      app.update(DT)
      const f = world.resource(NavFlows).fields.get(flow)!
      let frames = 1
      while (f.builds < 1 && frames < 20_000) {
        app.update(DT)
        frames++
      }
      expect(f.builds).toBe(1)
      const cold = {
        ms: f.lastMs,
        slices: f.lastSlices,
        reads: f.graph!.reads,
        readMs: f.graph!.readMs,
      }
      // The goal moves 3 m: a rebuild over the polygons already read.
      world.set(flow, NavFlowField, { goal: [goal[0] + 3, 0, goal[2]] })
      while (f.builds < 2 && frames < 40_000) {
        app.update(DT)
        frames++
      }
      expect(f.builds).toBe(2)
      const flowMs = world.initResource(NavBudget).flowMs ?? 1
      console.info(
        `flow field build, ${BUILDINGS} buildings, ${f.cur!.reached} polygons: first ${cold.ms.toFixed(2)} ms in ${cold.slices} slices (${cold.reads} tiles read in ${cold.readMs.toFixed(2)} ms), rebuild ${f.lastMs.toFixed(2)} ms in ${f.lastSlices} slices, at flowMs ${flowMs}`,
      )
      expect(f.cur!.reached).toBeGreaterThan(1000)
      expect(cold.slices).toBeGreaterThan(1)
      expect(f.lastMs).toBeLessThan(budget('nav/flow-build'))
    },
    timeout(120_000),
  )
})
