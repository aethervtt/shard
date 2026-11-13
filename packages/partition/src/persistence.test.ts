import type { ComponentDef, Entity, World } from '@aethervtt/shard-core'
import { Replicated } from '@aethervtt/shard-net'
import { type NetHarness, netHarness } from '@aethervtt/shard-net/testing'
import { defineGenerator } from '@aethervtt/shard-procgen'
import { LogResource } from '@aethervtt/shard-runtime'
import { captureGame, loadGame, type SaveFile } from '@aethervtt/shard-save'
import { Transform } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cellOf,
  configureCommits,
  loadedCells,
  moveTo,
  spawnSource,
  spawnTown,
  steps,
  townApp,
  townPlugins,
} from './fixtures/apps'
import { Door, defineTown, Hinge } from './fixtures/town'
import {
  CellBound,
  cellParams,
  Dynamic,
  defineDeltaMigration,
  definePartition,
  dormantEntities,
  partitionSettled,
  storedDelta,
} from './index'
import { partitionNet, partitionNetPlugin } from './net'

const harnesses: NetHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose()
})

async function server(): Promise<NetHarness> {
  const h = await netHarness({
    clients: 0,
    plugins: () => townPlugins(),
    server: () => [partitionNetPlugin()],
    net: partitionNet(),
  })
  configureCommits(h.server.world, {})
  harnesses.push(h)
  return h
}

async function run(h: NetHarness, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await partitionSettled(h.server.world)
    h.step(1)
  }
}

function count(world: World, defs: ComponentDef[]): number {
  let n = 0
  for (const table of world.query({ with: defs }).tables) n += table.count
  return n
}

const SAVED = defineTown({ name: 'save-town', props: 2 })

describe('deltas through saves', () => {
  it('a restored server streams back every change, loaded and unloaded cells alike', async () => {
    const a = await server()
    const w = a.server.world
    spawnTown(w, SAVED, 11, 5)
    const source = spawnSource(w, 32, 32)
    await run(a, 8)
    // Changes in cell 0,0, which will be unloaded when we save.
    const home = cellOf(w, '0:0,0')!
    w.despawn(home.entities.get('b0/crate')!)
    w.add(home.entities.get('b1/door')!, Door, { open: true })
    w.spawn([Transform, { translation: [12, 0, 12] }], [CellBound, {}])
    w.spawn([Transform, { translation: [20, 0, 20] }], [CellBound, {}], [Replicated, {}])
    await run(a, 2)
    moveTo(w, source, 2032, 32)
    await run(a, 240)
    expect(loadedCells(w)['0:0,0']).toBeUndefined()
    // Changes in cell 31,0, loaded when we save.
    const away = cellOf(w, '0:31,0')!
    w.despawn(away.entities.get('b2/n')!)
    w.spawn([Transform, { translation: [2010, 0, 20] }], [CellBound, {}], [Replicated, {}])
    await run(a, 2)
    const file = JSON.parse(JSON.stringify(captureGame(w))) as SaveFile
    expect(Object.keys(file.sections ?? {})).toEqual(['partition'])

    const b = await server()
    const v = b.server.world
    await loadGame(v, file)
    await run(b, 8)
    const restored = cellOf(v, '0:31,0')!
    expect(restored.entities.has('b2/n')).toBe(false)
    expect(count(v, [CellBound, Replicated])).toBe(1)
    // Back home: the crate stays gone, the door open, the item and the zombie back.
    const src = v.query({ with: [Transform] })
    let mover: Entity | undefined
    for (const table of src.tables) {
      for (let r = 0; r < table.count; r++) {
        const e = table.entities[r]!
        if (v.has(e, (await import('./index')).StreamingSource)) mover = e
      }
    }
    moveTo(v, mover!, 32, 32)
    await run(b, 240)
    const back = cellOf(v, '0:0,0')!
    expect(back.entities.has('b0/crate')).toBe(false)
    expect(v.get(back.entities.get('b1/door')!, Door).open).toBe(true)
    expect(back.added.size).toBe(1)
    expect(count(v, [CellBound, Replicated])).toBe(1)
  })
})

describe('references in a cell', () => {
  const TOWN = defineTown({ name: 'ref-town', props: 1 })

  it('keeps an added door’s links to a built wall and a generated wall across an unload', async () => {
    const app = await townApp()
    const world = app.world
    spawnTown(world, TOWN)
    const player = spawnSource(world, 32, 32)
    await steps(app, 6)
    const generated = cellOf(world, '0:0,0')!.entities.get('b0/n')!
    const built = world.spawn(
      [Transform, { translation: [10, 1, 10] }],
      [CellBound, {}],
      [Door, {}],
    )
    await steps(app, 2)
    world.spawn(
      [Transform, { translation: [11, 1, 10] }],
      [CellBound, {}],
      [Hinge, { wall: built, frame: generated }],
    )
    await steps(app, 2)
    moveTo(world, player, 2032, 32)
    await steps(app, 220)
    expect(loadedCells(world)['0:0,0']).toBeUndefined()
    moveTo(world, player, 32, 32)
    await steps(app, 220)
    const cell = cellOf(world, '0:0,0')!
    let hinge: Entity | undefined
    for (const e of cell.added.values()) if (world.has(e, Hinge)) hinge = e
    const links = world.get(hinge!, Hinge)
    expect(links.frame).toBe(cell.entities.get('b0/n'))
    expect(links.wall).not.toBeNull()
    expect(world.has(links.wall!, Door)).toBe(true)
    expect([...cell.added.values()]).toContain(links.wall)
    app.dispose()
  })
})

describe('moving between cells', () => {
  const TOWN = defineTown({ name: 'move-town', props: 1 })

  it('re-homes a zombie that crosses a border, and puts one to sleep in a cell nobody simulates', async () => {
    const app = await townApp()
    const world = app.world
    spawnTown(world, TOWN)
    const player = spawnSource(world, 64, 32)
    await steps(app, 6)
    const zombie = world.spawn(
      [Transform, { translation: [60, 0, 20] }],
      [CellBound, {}],
      [Dynamic, {}],
    )
    await steps(app, 2)
    expect(world.get(zombie, CellBound).x).toBe(0)
    world.add(zombie, Transform, { translation: [70, 0, 20] })
    await steps(app, 2)
    expect(world.get(zombie, CellBound).x).toBe(1)
    // Cell 0 unloads behind the player; the zombie, now in cell 1, stays.
    moveTo(world, player, 300, 32)
    await steps(app, 240)
    expect(loadedCells(world)['0:0,0']).not.toBe('full')
    expect(loadedCells(world)['0:1,0']).toBe('full')
    expect(world.isAlive(zombie)).toBe(true)
    // Into cell -4, drawn at far level but not simulated: asleep in its delta.
    world.add(zombie, Transform, { translation: [-200, 0, 20] })
    await steps(app, 2)
    expect(world.isAlive(zombie)).toBe(false)
    expect(dormantEntities(world, TOWN, 0, -4, 0)).toHaveLength(1)
    moveTo(world, player, -200, 32)
    await steps(app, 240)
    expect(loadedCells(world)['0:-4,0']).toBe('full')
    expect(dormantEntities(world, TOWN, 0, -4, 0)).toHaveLength(0)
    let awake = 0
    for (const table of world.query({ with: [CellBound, Dynamic] }).tables) awake += table.count
    expect(awake).toBe(1)
    app.dispose()
  })
})

describe('generator versions', () => {
  const make = (version: number, crate: string) =>
    defineGenerator('test/Versioned', {
      params: { ...cellParams(['full']) },
      output: 'entities',
      version,
      deterministicMath: true,
      run: (_ctx, p) => [
        {
          name: 'wall',
          components: { 'core/Transform': { translation: [p.x * 64, 0, p.z * 64] } },
        },
        {
          name: crate,
          components: { 'core/Transform': { translation: [p.x * 64 + 4, 0, p.z * 64] } },
        },
        ...(version === 1 ? [{ name: 'gone', components: { 'core/Transform': {} } }] : []),
      ],
    })

  it('applies an old delta by path, keeps stale ops, and migrates once', async () => {
    make(1, 'crate')
    const define = () =>
      definePartition('versions', {
        grids: [
          {
            name: 'g',
            cellSize: 64,
            generator: 'test/Versioned',
            levels: [{ name: 'full', range: 64 }],
            simulate: 64,
          },
        ],
      })
    define()
    const first = await townApp()
    let world = first.world
    spawnTown(world, 'versions')
    spawnSource(world, 32, 32)
    await steps(first, 6)
    const cell = cellOf(world, '0:0,0')!
    world.add(cell.entities.get('wall')!, Transform, { translation: [1, 2, 3] })
    world.add(cell.entities.get('crate')!, Transform, { translation: [9, 9, 9] })
    world.despawn(cell.entities.get('gone')!)
    await steps(first, 2)
    const file = JSON.parse(JSON.stringify(captureGame(world))) as SaveFile
    first.dispose()

    // A new server build: version 2 renames the crate and drops `gone`; the migration renames
    // the crate's op.
    make(2, 'chest')
    define()
    let migrations = 0
    defineDeltaMigration('test/Versioned', (overrides, from, to) => {
      migrations++
      expect([from, to]).toEqual([1, 2])
      const out = { ...overrides }
      if (out.crate !== undefined) {
        out.chest = out.crate
        delete out.crate
      }
      return out
    })
    const second = await townApp()
    world = second.world
    const warnings: string[] = []
    world.resource(LogResource).subscribe((e) => {
      if (e.code) warnings.push(e.code)
    })
    await loadGame(world, file)
    await steps(second, 6)
    const again = cellOf(world, '0:0,0')!
    expect(world.get(again.entities.get('wall')!, Transform).translation).toEqual([1, 2, 3])
    expect(world.get(again.entities.get('chest')!, Transform).translation).toEqual([9, 9, 9])
    expect(migrations).toBe(1)
    // `gone` no longer exists: the op is kept, and reported.
    const delta = storedDelta(world, 'versions', '0:0,0')!
    expect(delta.version).toBe(2)
    expect(delta.entries.get('gone')).toBe(null)
    expect(warnings).toContain('partition/stale-delta')
    second.dispose()
  })
})
