import { InstancePart } from '@aethervtt/shard-scene'
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
import { Contents, Door, defineTown } from './fixtures/town'
import { CellBound, Dynamic, storedDelta } from './index'

const TOWN = defineTown({ name: 'stream-town', props: 2 })

describe('single-player streaming', () => {
  it('loads the cells around a source at their levels, and unloads them behind it', async () => {
    const app = await townApp()
    const world = app.world
    spawnTown(world, TOWN)
    const player = spawnSource(world, 32, 32)
    await steps(app, 6)
    const cells = loadedCells(world)
    // In the simulate ring (160 m, which also covers the full level in single player): full.
    expect(cells['0:0,0']).toBe('full')
    expect(cells['0:2,0']).toBe('full')
    // 3 cells east is 160 m to its near edge: full; 4 cells is 224 m: far.
    expect(cells['0:4,0']).toBe('far')
    expect(cells['0:9,0']).toBeUndefined()
    // Walk 1 km east: the start unloads, the new place loads.
    moveTo(world, player, 1032, 32)
    await steps(app, 6)
    await steps(app, 200)
    const after = loadedCells(world)
    expect(after['0:0,0']).toBeUndefined()
    expect(after['0:16,0']).toBe('full')
    app.dispose()
  })

  it('does not unload or change levels when walking back and forth over a border', async () => {
    const app = await townApp()
    const world = app.world
    spawnTown(world, TOWN)
    const player = spawnSource(world, 64, 32)
    await steps(app, 8)
    const before = loadedCells(world)
    const swaps: string[] = []
    for (let i = 0; i < 60 * 60; i += 30) {
      moveTo(world, player, 64 + (i % 60 === 0 ? 10 : -10), 32)
      await steps(app, 30)
      const now = loadedCells(world)
      for (const [k, v] of Object.entries(before)) if (now[k] !== v) swaps.push(`${k}:${now[k]}`)
    }
    expect(swaps).toEqual([])
    app.dispose()
  })

  it('keeps removed, moved and added entities, and changed fields, across an unload', async () => {
    const app = await townApp()
    const world = app.world
    spawnTown(world, TOWN)
    const player = spawnSource(world, 32, 32)
    await steps(app, 6)
    const cell = cellOf(world, '0:0,0')!
    const crate = cell.entities.get('b0/crate')!
    const prop = cell.entities.get('b1/prop-0')!
    const door = cell.entities.get('b2/door')!
    world.despawn(crate)
    world.add(prop, Transform, { translation: [5, 0, 5] })
    world.add(door, Door, { open: true })
    const item = world.spawn([Transform, { translation: [10, 0, 12] }], [CellBound, {}])
    const zombie = world.spawn(
      [Transform, { translation: [20, 0, 20] }],
      [CellBound, {}],
      [Dynamic, {}],
    )
    await steps(app, 2)
    const delta = storedDelta(world, TOWN, '0:0,0')!
    expect(delta.entries.get('b0/crate')).toBe(null)
    expect(delta.entries.get('b2/door')).toEqual({ 'test/Door': { open: true } })
    expect([...delta.entries.keys()].filter((k) => k.startsWith('+'))).toHaveLength(1)
    expect(world.get(zombie, CellBound).key).toBeGreaterThan(0)

    moveTo(world, player, 2032, 32)
    await steps(app, 220)
    expect(loadedCells(world)['0:0,0']).toBeUndefined()
    expect(world.isAlive(item)).toBe(false)
    expect(world.isAlive(zombie)).toBe(false)
    expect(storedDelta(world, TOWN, '0:0,0')!.dormant).toHaveLength(1)

    moveTo(world, player, 32, 32)
    await steps(app, 220)
    const back = cellOf(world, '0:0,0')!
    expect(back.level).toBe(0)
    expect(back.entities.has('b0/crate')).toBe(false)
    expect(world.get(back.entities.get('b1/prop-0')!, Transform).translation).toEqual([5, 0, 5])
    expect(world.get(back.entities.get('b2/door')!, Door).open).toBe(true)
    expect(back.added.size).toBe(1)
    const bound = world.query({ with: [CellBound, Dynamic] })
    let zombies = 0
    for (const t of bound.tables) zombies += t.count
    expect(zombies).toBe(1)
    // Crates got their secret contents on this side (single player is its own server).
    const crate1 = back.entities.get('b1/crate')!
    expect(world.get(crate1, Contents).items.length).toBeGreaterThan(0)
    expect(world.has(crate1, InstancePart)).toBe(true)
    app.dispose()
  })
})
