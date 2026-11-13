import { PerformanceObserver } from 'node:perf_hooks'
import type { Entity, World } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import { Nav, NavMesh, navPlugin, navReadyIn } from '@aethervtt/shard-nav'
import type { App } from '@aethervtt/shard-runtime'
import { Opening, Wall } from '@aethervtt/shard-structure'
import { StructureNav, structureNavPlugin } from '@aethervtt/shard-structure/nav'
import { StructureColliders, structurePhysicsPlugin } from '@aethervtt/shard-structure/physics'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import {
  cellOf,
  loadedCells,
  moveTo,
  spawnSource,
  spawnTown,
  steps,
  townApp,
} from './fixtures/apps'
import { defineStructureTown } from './fixtures/structure-town'
import { CellBound, PartitionState } from './index'

// Streaming real structure (0113 with 0112): full cells bring colliders and nav, far cells are
// structure/Backdrop shells with neither, and a player-built door keeps its wall across an unload.

const TOWN = defineStructureTown()

async function structureApp(): Promise<App> {
  const app = await townApp({
    physics: true,
    extra: [navPlugin, structurePhysicsPlugin, structureNavPlugin],
  })
  app.world.spawn([
    NavMesh,
    {
      cellSize: 0.2,
      cellHeight: 0.1,
      tileSize: 64,
      agentRadius: 0.3,
      agentHeight: 1.8,
      maxTiles: 2048,
    },
  ])
  return app
}

/** Worst main-thread frame with GC pauses subtracted, as in 0042. */
function frameTimer(app: App): number[] {
  const times: number[] = []
  const gcs: [number, number][] = []
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push([e.startTime, e.startTime + e.duration])
  })
  observer.observe({ entryTypes: ['gc'] })
  const update = app.update.bind(app)
  app.update = (delta: number, fixed?: number) => {
    const start = performance.now()
    update(delta, fixed)
    const end = performance.now()
    for (const e of observer.takeRecords()) gcs.push([e.startTime, e.startTime + e.duration])
    let gc = 0
    for (const [a, b] of gcs) gc += Math.max(0, Math.min(b, end) - Math.max(a, start))
    times.push(end - start - gc)
  }
  return times
}

function cellBounds(key: string): [number, number, number, number] {
  const [x, z] = key.slice(2).split(',').map(Number) as [number, number]
  return [x * 64, z * 64, x * 64 + 64, z * 64 + 64]
}

/** Whether a cell's walls own colliders and nav shapes. */
function solidity(world: World, key: string) {
  const cell = cellOf(world, key)!
  const colliders = world.resource(StructureColliders).owners
  const shapes = world.resource(StructureNav).shapes
  let walls = 0
  let solid = 0
  let shaped = 0
  for (const [path, e] of cell.entities) {
    if (!path.endsWith('/front') && !path.endsWith('/back')) continue
    walls++
    if (colliders.has(e)) solid++
    if (shapes.has(e)) shaped++
  }
  return { walls, solid, shaped }
}

describe('streaming structure', () => {
  it(
    'gives full cells colliders and nav, far cells neither, and walks within the frame budget',
    async () => {
      const app = await structureApp()
      const world = app.world
      spawnTown(world, TOWN)
      const player = spawnSource(world, 32, 32)
      await steps(app, 8)
      // Let the first navmesh land.
      for (let i = 0; i < 300 && !navReadyIn(world, 0, 0, 64, 64); i++) await steps(app, 1)
      expect(navReadyIn(world, 0, 0, 64, 64)).toBe(true)
      const cells = loadedCells(world)
      expect(cells['0:0,0']).toBe('full')
      expect(cells['0:3,0']).toBe('far')
      expect(solidity(world, '0:0,0')).toMatchObject({ walls: 8, solid: 8, shaped: 8 })
      expect(solidity(world, '0:3,0')).toMatchObject({ walls: 8, solid: 0, shaped: 0 })
      const rt = [...world.resource(Nav).meshes.values()][0]!
      const generation = rt.generation

      const frames = frameTimer(app)
      const streaming: number[] = []
      let x = 32
      let swaps = 0
      let last = loadedCells(world)
      for (let i = 0; i < 1024; i++) {
        x += 0.5
        moveTo(world, player, x, 32)
        await steps(app, 1)
        streaming.push(world.resource(PartitionState).instances.values().next().value!.ms)
        const now = loadedCells(world)
        for (const [k, v] of Object.entries(now)) if (last[k] && last[k] !== v) swaps++
        last = now
      }
      expect(swaps).toBeGreaterThan(4)
      // Every full cell is solid and every far cell isn't, wherever the walk ended.
      for (const [key, level] of Object.entries(loadedCells(world))) {
        const s = solidity(world, key)
        if (level === 'full') expect(s.solid).toBe(s.walls)
        else expect(s.solid + s.shaped).toBe(0)
      }
      // The player's cell becomes walkable, and the navmesh never had to grow.
      const here = `0:${Math.floor(x / 64)},0`
      for (let i = 0; i < 300 && !navReadyIn(world, ...cellBounds(here)); i++) await steps(app, 1)
      expect(navReadyIn(world, ...cellBounds(here))).toBe(true)
      expect(rt.generation).toBe(generation)
      expect(Math.max(...frames)).toBeLessThanOrEqual(budget('partition/structure-walk-frame'))
      const sorted = [...streaming].sort((a, b) => a - b)
      expect(sorted[Math.floor(sorted.length * 0.95)]).toBeLessThanOrEqual(
        budget('partition/stream'),
      )
      if (process.env.SHARD_PERF_LOG) {
        const f = [...frames].sort((a, b) => a - b)
        console.log(
          JSON.stringify({
            worst: f.at(-1),
            p95: f[Math.floor(f.length * 0.95)],
            stream: sorted[Math.floor(sorted.length * 0.95)],
            swaps,
            tiles: rt.tiles.size,
          }),
        )
      }
      app.dispose()
    },
    timeout(240_000),
  )

  it('keeps a player-built wall’s door, with its collider and nav gate, across an unload', async () => {
    const app = await structureApp()
    const world = app.world
    spawnTown(world, TOWN)
    const player = spawnSource(world, 32, 32)
    await steps(app, 8)
    // A wall across the yard with a door in it, both built at runtime.
    const wall = world.spawn(
      [Transform, { translation: [30, 0, 58] }],
      [CellBound, {}],
      [Wall, { a: [20, 58], b: [40, 58], height: 3, thickness: 0.2 }],
    )
    await steps(app, 2)
    world.spawn(
      [Transform, { translation: [25, 0, 58] }],
      [CellBound, {}],
      [Opening, { wall, kind: 'door', offset: 4, width: 1, height: 2.1 }],
    )
    await steps(app, 4)
    moveTo(world, player, 2032, 32)
    await steps(app, 220)
    expect(loadedCells(world)['0:0,0']).toBeUndefined()
    moveTo(world, player, 32, 32)
    await steps(app, 220)
    const cell = cellOf(world, '0:0,0')!
    let door: Entity | undefined
    let built: Entity | undefined
    for (const e of cell.added.values()) {
      if (world.has(e, Opening)) door = e
      if (world.has(e, Wall)) built = e
    }
    expect(world.get(door!, Opening).wall).toBe(built)
    expect(world.resource(StructureColliders).owners.has(built!)).toBe(true)
    expect(world.resource(StructureColliders).owners.has(door!)).toBe(true)
    expect(world.resource(StructureNav).gates.has(door!)).toBe(true)
    app.dispose()
  })
})
