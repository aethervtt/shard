import type { Entity, World } from '@aethervtt/shard-core'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { LogResource } from '@aethervtt/shard-runtime'
import { afterAll, describe, expect, it } from 'vitest'
import { bakeNavigation, navReady, whenNavReady } from './bake'
import { NavBudget, NavMesh, NavWorkers } from './components'
import type { NavMeshRuntime } from './navmesh'
import { Nav } from './state'
import { box, frames, navApp, shape } from './test-level'

// Tile builds paced by NavBudget (0112): inline a few a frame, or on the worker pool.

const workers = createNodeWorkers(2)
afterAll(() => workers.dispose())

const FLOOR = 1 as Entity
const CRATES = 2 as Entity

/** A 40 × 40 m floor (49 tiles of 6.4 m) with crates on it, on 0.1 m cells. */
async function yard(pool?: typeof workers) {
  const app = await navApp()
  const world = app.world
  if (pool) world.insertResource(NavWorkers, pool)
  world.spawn([
    NavMesh,
    { cellSize: 0.1, cellHeight: 0.1, tileSize: 64, agentRadius: 0.3, agentHeight: 1.8 },
  ])
  const nav = world.resource(Nav)
  nav.shapes.set(FLOOR, shape(box(0, -0.2, 0, 40, 0, 40)))
  nav.shapes.set(CRATES, shape(box(5, 0, 5, 6, 1, 6), box(30, 0, 12, 31, 1, 13)))
  return { app, world, nav }
}

const runtime = (world: World): NavMeshRuntime => [...world.resource(Nav).meshes.values()][0]!
const keys = (rt: NavMeshRuntime) =>
  new Map([...rt.tiles.values()].map((t) => [`${t.tx},${t.ty}`, t.key]))
const bytes = (rt: NavMeshRuntime) =>
  new Map([...rt.tiles.values()].map((t) => [`${t.tx},${t.ty}`, t.bytes?.join(',') ?? null]))

/** Frames until every tile is in, letting pool jobs finish between them. Returns the frames run. */
async function settle(app: Awaited<ReturnType<typeof navApp>>, limit = 200): Promise<number> {
  for (let n = 1; n <= limit; n++) {
    frames(app, 1)
    if (navReady(app.world)) return n
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('navmesh never settled')
}

describe('budgeted tile builds', () => {
  it('builds on the pool the same tiles, byte for byte, as inline', async () => {
    const inline = await yard()
    await bakeNavigation(inline.world)
    const pooled = await yard(workers)
    await bakeNavigation(pooled.world)
    expect(runtime(pooled.world).stats.totalBuilt).toBe(runtime(inline.world).stats.totalBuilt)
    expect(keys(runtime(pooled.world))).toEqual(keys(runtime(inline.world)))
    expect(bytes(runtime(pooled.world))).toEqual(bytes(runtime(inline.world)))
  })

  it('builds at most NavBudget.tiles a frame inline after the first bake, and lands them all', async () => {
    const { app, world, nav } = await yard()
    world.insertResource(NavBudget, { ms: 2, tiles: 2, workers: true, replans: 32 })
    frames(app, 2)
    const rt = runtime(world)
    expect(navReady(world)).toBe(true)
    // A long wall across the yard dirties a row of tiles.
    nav.shapes.set(3 as Entity, shape(box(1, 0, 20, 39, 3, 20.2)))
    const before = rt.stats.totalBuilt
    const perFrame: number[] = []
    for (let i = 0; i < 20 && !navReady(world); i++) {
      frames(app, 1)
      perFrame.push(rt.stats.built)
    }
    expect(navReady(world)).toBe(true)
    expect(Math.max(...perFrame)).toBeLessThanOrEqual(2)
    expect(perFrame.length).toBeGreaterThan(2)
    const fresh = await yard()
    fresh.nav.shapes.set(3 as Entity, shape(box(1, 0, 20, 39, 3, 20.2)))
    await bakeNavigation(fresh.world)
    expect(keys(rt)).toEqual(keys(runtime(fresh.world)))
    expect(rt.stats.totalBuilt - before).toBeGreaterThan(2)
  })

  it('lands pool tiles a few frames after an edit, and drops a stale one', async () => {
    const { app, world, nav } = await yard(workers)
    await bakeNavigation(world)
    const rt = runtime(world)
    nav.shapes.set(3 as Entity, shape(box(10, 0, 10, 11, 1, 11)))
    frames(app, 1)
    expect(rt.jobs.length).toBeGreaterThan(0)
    // Moved again before the first jobs come back: theirs are stale.
    nav.shapes.set(3 as Entity, shape(box(12, 0, 10, 13, 1, 11)))
    const n = await settle(app)
    expect(n).toBeLessThan(20)
    const fresh = await yard()
    fresh.nav.shapes.set(3 as Entity, shape(box(12, 0, 10, 13, 1, 11)))
    await bakeNavigation(fresh.world)
    expect(keys(rt)).toEqual(keys(runtime(fresh.world)))
  })

  it('resolves whenNavReady once the first bake is in', async () => {
    const { app, world } = await yard(workers)
    let ready = false
    const done = whenNavReady(world).then(() => {
      ready = true
    })
    expect(ready).toBe(false)
    await settle(app)
    await done
    expect(ready).toBe(true)
  })

  it('builds inline when the pool can’t run its jobs', async () => {
    const broken = {
      size: 2,
      run: () => Promise.reject(new Error('Cannot find package recast-navigation')),
      dispose() {},
    }
    const { app, world } = await yard(broken as unknown as typeof workers)
    await settle(app)
    expect(world.resource(Nav).poolFailed).toBe(true)
    expect(runtime(world).tiles.size).toBeGreaterThan(0)
    const codes = world
      .resource(LogResource)
      .tail(20, 'warn')
      .map((e) => e.code)
    expect(codes).toContain('nav/workers-unavailable')
  })
})
