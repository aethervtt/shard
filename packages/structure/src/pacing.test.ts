import {
  type Entity,
  ProfilerResource,
  Rng,
  type World,
  worldHashRows,
} from '@aethervtt/shard-core'
import { budget, timingMode } from '@aethervtt/shard-core/test-env'
import {
  bakeNavigation,
  Nav,
  NavAgent,
  NavAgentState,
  NavCache,
  NavFilters,
  NavGateAhead,
  NavMesh,
  type NavMeshRuntime,
  NavWorkers,
  navPlugin,
  navReady,
} from '@aethervtt/shard-nav'
import { physics3dPlugin } from '@aethervtt/shard-physics'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, describe, expect, it } from 'vitest'
import { Opening, Wall } from './components'
import { structureNavPlugin } from './nav'
import { structurePhysicsPlugin } from './physics'
import { BACK_ROOM, building, ground, OUTSIDE } from './test-building'
import { town } from './town'

// Budgeted rebuilds and targeted replans (0112, part 3), headless.

const DT = 1 / 60
const MESH = { cellSize: 0.1, cellHeight: 0.1, tileSize: 64, agentRadius: 0.3, agentHeight: 1.8 }
const FILTERS = {
  survivor: { exclude: ['locked' as const] },
  zombie: { exclude: ['closed' as const, 'locked' as const], areas: { 11: 0 } },
}
/** The town at the spec's size where budgets are held (pnpm bench); smaller where only correctness is. */
const BENCH = timingMode === 'bench'
const BUILDINGS = BENCH ? 200 : 30
const AGENTS = BENCH ? 300 : 60

const workers = createNodeWorkers(3)
afterAll(() => workers.dispose())

async function headless(pool = false): Promise<App> {
  const app = new App().addPlugin(
    TransformPlugin,
    physics3dPlugin(),
    navPlugin,
    structurePhysicsPlugin,
    structureNavPlugin,
  )
  if (pool) app.world.insertResource(NavWorkers, workers)
  await app.init()
  app.world.insertResource(NavFilters, FILTERS)
  return app
}

function frames(app: App, n = 1): void {
  for (let i = 0; i < n; i++) app.update(DT)
}

const runtime = (world: World): NavMeshRuntime => [...world.resource(Nav).meshes.values()][0]!
const keys = (rt: NavMeshRuntime) =>
  new Map([...rt.tiles.values()].map((t) => [`${t.tx},${t.ty}`, t.key]))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Point = [number, number, number]

function agent(world: World, from: Point, to: Point, filter: string): Entity {
  return world.spawn(
    [NavAgent, { destination: to, filter, drive: 'transform', speed: 3, radius: 0.3 }],
    [Transform, { translation: from }],
  )
}

/** Agents walking between random points of the town. */
function walkers(world: World, n: number, bounds: number[], seed = 5): Entity[] {
  const rng = new Rng(seed)
  const point = (): Point => [
    bounds[0]! + 1 + rng.float() * (bounds[2]! - bounds[0]! - 2),
    0,
    bounds[1]! + 1 + rng.float() * (bounds[3]! - bounds[1]! - 2),
  ]
  const out: Entity[] = []
  for (let i = 0; i < n; i++)
    out.push(agent(world, point(), point(), i % 2 ? 'zombie' : 'survivor'))
  return out
}

describe('budgeted rebuilds and replans', () => {
  it('replans only the agents a shut door or a new wall affects, and tells a survivor at a shut door', async () => {
    const app = await headless()
    const world = app.world
    ground(world)
    const { door, sideDoor } = building(world, true)
    world.set(door, Opening, { state: 'open' })
    world.set(sideDoor!, Opening, { state: 'open' })
    world.spawn([NavMesh, MESH])
    // One frame first: structure pushes its shapes and gates to nav in its systems.
    frames(app)
    await bakeNavigation(world)
    const nav = world.resource(Nav)
    // A zombie going in by the front door, and one walking up the far west side, away from it.
    const zombie = agent(world, OUTSIDE, BACK_ROOM, 'zombie')
    const bystander = agent(world, [-5, 0, -5], [-5, 0, 11], 'zombie')
    frames(app, 30)
    const record = (e: Entity) => nav.agents.get(e)!
    expect(record(zombie).pathGates).toContain(door)
    expect(record(bystander).pathGates).toEqual([])

    // The front door shuts: the zombie replans within two frames, the bystander doesn't.
    world.set(door, Opening, { state: 'closed' })
    frames(app, 2)
    expect(record(zombie).replans).toBe(1)
    expect(record(bystander).replans).toBe(0)
    expect(record(zombie).pathGates).toContain(sideDoor)
    frames(app, 600)
    expect(world.get(zombie, NavAgentState).status).toBe('arrived')

    // A wall across the bystander's way replans it, and nobody else.
    const before = record(zombie).replans
    world.set(bystander, NavAgent, { destination: [-5, 0, -5] })
    frames(app, 5)
    const base = record(bystander).replans
    world.spawn([Wall, { a: [-6, 4], b: [-3.5, 4] }])
    for (let i = 0; i < 10 && !navReady(world); i++) frames(app)
    frames(app, 2)
    expect(record(bystander).replans).toBeGreaterThan(base)
    expect(record(zombie).replans).toBe(before)

    // A survivor walking in by the shut front door is told once, at the door.
    const reader = world.reader(NavGateAhead)
    reader.read()
    const survivor = agent(world, OUTSIDE, BACK_ROOM, 'survivor')
    const told: Entity[] = []
    for (let i = 0; i < 120; i++) {
      frames(app)
      for (const e of reader.read()) if (e.entity === survivor) told.push(e.gate)
    }
    expect(told).toEqual([door])
  })

  it('keeps every frame of a burst of wall edits within budget, and lands every tile', async () => {
    const app = await headless(true)
    const world = app.world
    const t = town(world, { buildings: BUILDINGS })
    world.spawn([NavMesh, MESH])
    // One frame first: structure pushes its shapes and gates to nav in its systems.
    frames(app)
    await bakeNavigation(world)
    walkers(world, AGENTS, t.bounds)
    frames(app, 30)
    const rt = runtime(world)
    const profiler = world.resource(ProfilerResource)
    const tileMs: number[] = []
    const unobserve = workers.observe?.((job) => {
      if (job.kind === 'nav/tile') tileMs.push(job.ms)
    })
    // 50 walls edited in one tick.
    const walls = t.buildings.flatMap((b) => [b.left, b.right]).slice(0, 50)
    for (const [i, wall] of walls.entries())
      world.set(wall, Wall, { thickness: i % 2 ? 0.24 : 0.22 })
    const SPANS = [
      'structure/sync-fixed',
      'structure/physics',
      'structure/nav-fixed',
      'structure/sync',
      'structure/nav',
      'physics/sync-in',
      'nav/bake',
    ]
    const frameMs: number[] = []
    const agentMs: number[] = []
    let n = 0
    for (; n < 600; n++) {
      frames(app)
      let ms = 0
      for (const span of SPANS) ms += profiler.timing(span)?.last ?? 0
      frameMs.push(ms)
      agentMs.push(profiler.timing('nav/agents')?.last ?? 0)
      if (navReady(world) && rt.jobs.length === 0) break
      await sleep(DT * 1000)
    }
    unobserve?.()
    expect(navReady(world)).toBe(true)
    expect(Math.max(...frameMs)).toBeLessThan(budget('structure/edit-burst'))
    expect(n + 1).toBeLessThanOrEqual(budget('nav/burst-frames'))
    if (tileMs.length > 0) expect(Math.max(...tileMs)).toBeLessThan(budget('nav/tile'))
    agentMs.sort((a, b) => a - b)
    expect(agentMs[Math.floor(agentMs.length * 0.95)]!).toBeLessThan(budget('nav/town-agents'))

    // The navmesh is the one a fresh bake of the result makes.
    const fresh = await headless()
    const t2 = town(fresh.world, { buildings: BUILDINGS })
    const walls2 = t2.buildings.flatMap((b) => [b.left, b.right]).slice(0, 50)
    for (const [i, wall] of walls2.entries())
      fresh.world.set(wall, Wall, { thickness: i % 2 ? 0.24 : 0.22 })
    fresh.world.spawn([NavMesh, MESH])
    frames(fresh)
    await bakeNavigation(fresh.world)
    expect(keys(rt)).toEqual(keys(runtime(fresh.world)))
  })

  it('bakes the town cold on the pool within budget, and warm from its cache without Recast', async () => {
    const cold = await headless(true)
    town(cold.world, { buildings: BUILDINGS })
    cold.world.spawn([NavMesh, MESH])
    const t0 = performance.now()
    frames(cold)
    await bakeNavigation(cold.world)
    const coldMs = performance.now() - t0
    expect(runtime(cold.world).stats.totalBuilt).toBeGreaterThan(0)
    expect(coldMs).toBeLessThan(budget('structure/town-cold'))

    const warm = await headless(true)
    const cache = warm.world.initResource(NavCache)
    for (const [key, bytes] of cold.world.resource(NavCache).tiles) cache.tiles.set(key, bytes)
    town(warm.world, { buildings: BUILDINGS })
    warm.world.spawn([NavMesh, MESH])
    const t1 = performance.now()
    frames(warm)
    await bakeNavigation(warm.world)
    const warmMs = performance.now() - t1
    expect(runtime(warm.world).stats.totalBuilt).toBe(0)
    expect(keys(runtime(warm.world))).toEqual(keys(runtime(cold.world)))
    expect(warmMs).toBeLessThan(budget('structure/town-warm'))
  })

  it('runs the same with the same edits: inline frame for frame, on the pool tile for tile', async () => {
    const run = async (pool: boolean) => {
      const app = await headless(pool)
      const world = app.world
      const t = town(world, { buildings: 12, seed: 7 })
      world.spawn([NavMesh, MESH])
      frames(app)
      await bakeNavigation(world)
      walkers(world, 20, t.bounds, 11)
      for (let frame = 0; frame < 240; frame++) {
        if (frame === 20) world.despawn(t.buildings[3]!.back)
        if (frame === 40) world.set(t.buildings[5]!.doors[0]!, Opening, { state: 'locked' })
        if (frame === 60) world.spawn([Wall, { a: [3, 3], b: [3, 10] }])
        frames(app)
        if (pool) await sleep(2)
      }
      for (let i = 0; i < 100 && !navReady(world); i++) {
        frames(app)
        await sleep(5)
      }
      const rt = runtime(world)
      return {
        hash: worldHashRows(world).join('\n'),
        tiles: new Map([...rt.tiles.values()].map((x) => [x.key, x.bytes?.join(',') ?? null])),
      }
    }
    const a = await run(false)
    const b = await run(false)
    expect(b.hash).toBe(a.hash)
    const pooled = await run(true)
    expect(pooled.tiles).toEqual(a.tiles)
  })
})
