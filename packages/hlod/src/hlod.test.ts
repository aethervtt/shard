import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChildOf, Children, type Entity, Update, type World } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { buildGeneratorWorker } from '@aethervtt/shard-node'
import {
  PartitionInstance,
  PartitionState,
  partitionPlugin,
  partitionSettled,
  StreamingBudget,
  StreamingSource,
} from '@aethervtt/shard-partition'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { configureProcgenHost } from '@aethervtt/shard-procgen'
import {
  Camera3d,
  captureView,
  DirectionalLight,
  DrawnByProxy,
  Exposure,
  forwardPlugin,
  InstanceSlot,
  Instances,
  Mesh3d,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Visibility,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { structurePlugin, Wall, WindowPane } from '@aethervtt/shard-structure'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HlodProxy, HlodSettings } from './components'
import { defineDressedTown, dressTown, streetAt } from './fixtures/dressed-town'
import { hlodPlugin } from './plugin'
import { describeHlod, Hlod, hlodSettled } from './runtime'

const TOWN = defineDressedTown()
const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

async function townApp(width = 160, height = 90) {
  const app = new App({ fixedHz: 60, now: () => 0 }).addPlugin(
    TransformPlugin,
    ScenePlugin,
    partitionPlugin(),
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    structurePlugin,
    hlodPlugin(),
  )
  app.addSystems(Update, dressTown)
  await app.init()
  const world = app.world
  const streaming = world.resource(StreamingBudget)
  streaming.commit = 'deterministic'
  streaming.commitDelay = 2
  const target = new OffscreenTarget(gpu, { label: 'hlod', width, height })
  const ref = world.resource(RenderTargets).add(target, 'hlod')
  const camera = world.spawn(
    [Camera3d, { target: ref as never, fovY: 60 }],
    [Exposure, { ev100: 12 }],
    Transform,
  )
  world.spawn(
    [DirectionalLight, { illuminance: 20_000, shadows: true, shadowUpdate: 'on-change' }],
    [Transform, { rotation: lookAt([0, 0, 0], [-0.5, -0.7, 0.4]) }],
  )
  world.spawn([PartitionInstance, { partition: TOWN, seed: 7, secretSeed: 99 }])
  const start = streetAt(0, 0)
  const source = world.spawn(
    [Transform, { translation: [start[0], 1, start[2]] }],
    [StreamingSource, {}],
  )
  const look = (eye: [number, number, number], at: [number, number, number]) =>
    world.set(camera, Transform, { translation: eye, rotation: lookAt(eye, at) })
  look(start, [start[0] + 20, 1.5, start[2]])
  const steps = async (frames: number, each?: () => void) => {
    for (let i = 0; i < frames; i++) {
      await partitionSettled(world)
      await hlodSettled(world)
      app.update(1 / 60)
      each?.()
    }
  }
  return { app, world, camera, source, look, steps, target }
}

/** Loaded cells, with their level name, root and proxy record. */
function cells(world: World) {
  const rt = world.resource(PartitionState).instances.values().next().value!
  const state = world.resource(Hlod)
  return [...rt.cells.values()]
    .filter((c) => c.level >= 0)
    .map((cell) => ({
      cell,
      level: cell.grid.levels[cell.level]!.name,
      rec: [...state.cells.values()].find((r) => r.cell === cell),
    }))
}

/** Every Mesh3d under `e`, itself included. */
function meshesUnder(world: World, e: Entity, out: Entity[] = []): Entity[] {
  if (world.has(e, Mesh3d)) out.push(e)
  for (const c of world.tryGet(e, Children)?.entities ?? [])
    if (c !== null) meshesUnder(world, c, out)
  return out
}

const slotted = (world: World, e: Entity) => (world.tryGet(e, InstanceSlot)?.slot ?? 0) > 0

/**
 * Each loaded cell draws exactly once: covered (its meshes hold no slots, its proxy's do), or drawn
 * as itself (its proxy, if any, hidden). Returns how many are covered.
 */
function checkCoverage(world: World, frame: number): number {
  let covered = 0
  for (const { cell, rec } of cells(world)) {
    const tagged = world.has(cell.root, DrawnByProxy)
    const proxy = rec?.proxy ?? null
    const shown = proxy !== null && !world.has(proxy, DrawnByProxy)
    expect(tagged, `frame ${frame}, ${cell.key}: covered iff its proxy shows`).toBe(shown)
    if (tagged) {
      covered++
      expect(
        meshesUnder(world, cell.root).some((e) => slotted(world, e)),
        `${cell.key} twice`,
      ).toBe(false)
      expect(
        meshesUnder(world, proxy!).some((e) => slotted(world, e)),
        `${cell.key} not at all`,
      ).toBe(true)
    } else if (proxy !== null) {
      expect(
        meshesUnder(world, proxy).some((e) => slotted(world, e)),
        `${cell.key} twice`,
      ).toBe(false)
    }
  }
  return covered
}

describe('HLOD proxies for streamed cells (0073)', () => {
  it('covers every far cell with its proxy, drops their slots, and draws each cell once a frame across the full/far boundary for 60 s', {
    timeout: timeout(600_000),
  }, async () => {
    const { app, world, source, steps } = await townApp()
    await steps(240)
    const far = cells(world).filter((c) => c.level === 'far')
    const full = cells(world).filter((c) => c.level === 'full')
    expect(far.length).toBeGreaterThan(40)
    expect(full.length).toBeGreaterThan(4)
    expect(far.every((c) => world.has(c.cell.root, DrawnByProxy))).toBe(true)
    expect(full.some((c) => world.has(c.cell.root, DrawnByProxy))).toBe(false)
    const d = describeHlod(world)
    expect(d.levels.far!.covered).toBe(far.length)
    const proxied = world.resource(Instances).drawableCount
    // The same view drawn without proxies holds every far cell's meshes in slots.
    world.resource(HlodSettings).enabled = false
    await steps(3)
    const plain = world.resource(Instances).drawableCount
    expect(far.some((c) => world.has(c.cell.root, DrawnByProxy))).toBe(false)
    expect(proxied).toBeLessThan(plain / 2)
    world.resource(HlodSettings).enabled = true
    await steps(3)
    expect(far.every((c) => world.has(c.cell.root, DrawnByProxy))).toBe(true)

    // Back and forth across the boundary: ±48 m along the street, 60 s, cells swapping levels.
    const start = streetAt(0, 0)
    let swaps = 0
    let last = new Map(cells(world).map((c) => [c.cell.key, c.level]))
    for (let f = 0; f < 3600; f++) {
      const x = start[0] + 48 * Math.sin((f / 600) * Math.PI * 2)
      world.set(source, Transform, { translation: [x, 1, start[2]] })
      await steps(1)
      checkCoverage(world, f)
      const now = new Map(cells(world).map((c) => [c.cell.key, c.level]))
      for (const [k, level] of now) if (last.has(k) && last.get(k) !== level) swaps++
      last = now
    }
    expect(swaps, 'cells swapped levels during the walk').toBeGreaterThan(10)
    await app.dispose()
  })

  it('builds proxies on the worker pool, the same as inline', {
    timeout: timeout(300_000),
  }, async () => {
    const triangles = async () => {
      const { app, world, steps } = await townApp()
      await steps(240)
      const out: Record<string, number> = {}
      for (const rec of world.resource(Hlod).cells.values())
        if (rec.proxy !== null) out[rec.cell.key] = world.get(rec.proxy, HlodProxy).triangles
      await app.dispose()
      return out
    }
    const inline = await triangles()
    const out = mkdtempSync(join(tmpdir(), 'shard-hlod-worker-'))
    const workers = createNodeWorkers(2)
    let jobs = 0
    const run = workers.run.bind(workers)
    workers.run = ((module: string, fn: string, args: readonly unknown[], o?: never) => {
      if (fn === 'buildProxy') jobs++
      return run(module, fn, args, o)
    }) as typeof workers.run
    try {
      const bundle = await buildGeneratorWorker({
        root: join(here, '..'),
        entry: 'src/fixtures/dressed-town.ts',
        outDir: out,
      })
      configureProcgenHost({ workers, workerModule: bundle.url })
      const pooled = await triangles()
      expect(jobs).toBeGreaterThan(40)
      expect(pooled).toEqual(inline)
    } finally {
      configureProcgenHost({ workers: undefined, workerModule: undefined })
      await workers.dispose?.()
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('rebuilds only the proxy of a far cell whose wall breaks, and its old proxy draws until then', {
    timeout: timeout(300_000),
  }, async () => {
    const { app, world, steps } = await townApp()
    await steps(240)
    const state = world.resource(Hlod)
    const far = cells(world).filter((c) => c.level === 'far' && c.rec?.proxy != null)
    const target = far[0]!
    const walls = world
      .query({ with: [Wall] })
      .entities()
      .filter((e) => {
        for (
          let at: Entity | null | undefined = e;
          at != null;
          at = world.tryGet(at, ChildOf)?.parent as Entity | null | undefined
        )
          if (at === target.cell.root) return true
        return false
      })
    expect(walls.length).toBeGreaterThan(0)
    const before = new Map(far.map((c) => [c.cell.key, c.rec!.proxy]))
    const triangles = world.get(target.rec!.proxy!, HlodProxy).triangles
    const built = state.built
    // What a client does when a delta removes the wall: the generated entity goes.
    world.despawn(walls[0]!)
    let frames = 0
    while (state.built === built || target.rec!.next !== undefined) {
      await steps(1)
      frames++
      expect(world.has(target.cell.root, DrawnByProxy), `covered on frame ${frames}`).toBe(true)
      expect(frames).toBeLessThan(120)
    }
    expect(state.built - built, 'exactly one proxy rebuilt').toBe(1)
    expect(world.get(target.rec!.proxy!, HlodProxy).triangles).toBeLessThan(triangles)
    for (const c of far)
      if (c !== target)
        expect(c.rec!.proxy, `${c.cell.key} kept its proxy`).toBe(before.get(c.cell.key))
    // Settle frames, a gather, the build (inline here) and a frame to place it.
    expect(frames).toBeLessThanOrEqual(world.resource(HlodSettings).settleFrames + 4)
    expect((frames * 1000) / 60, 'ms from the delta to the new proxy').toBeLessThanOrEqual(
      budget('hlod/rebuild-latency'),
    )
    await app.dispose()
  })

  it('swaps a cell for its proxy with only its windows changing, shadows included', {
    timeout: timeout(300_000),
  }, async () => {
    const { app, world, look, steps } = await townApp(320, 180)
    // From the street, over the near cells, at houses 100–200 m away: far cells.
    look([0, 10, 6], [150, 2, 26])
    await steps(240)
    const shot = async () => {
      await steps(4)
      await settle(app, 8)
      const p = captureView(world, `camera:${[...world.query({ with: [Camera3d] }).entities()][0]}`)
      app.update(1 / 60)
      return (await p)!.data
    }
    const proxied = await shot()
    world.resource(HlodSettings).enabled = false
    const shells = await shot()
    // Window pixels: where the shells' glass panes draw.
    const panes = world.query({ with: [WindowPane] }).entities()
    for (const e of panes) world.add(e, Visibility, { mode: 'hidden' })
    const bare = await shot()
    const w = 320
    const h = 180
    if (process.env.HLOD_SHOTS) {
      const { Gpu, Cameras } = await import('@aethervtt/shard-render')
      console.log('gpu errors', world.resource(Gpu).errors.slice(0, 5))
      const cam = [...world.query({ with: [Camera3d] }).entities()][0]!
      console.log(
        'draws',
        world.resource(Cameras).get(cam)?.draws.length,
        'hlod',
        JSON.stringify(describeHlod(world)),
      )
      const { encodePng } = await import('../../verify/src/node/png')
      const { writeFileSync } = await import('node:fs')
      for (const [n, d] of [
        ['proxied', proxied],
        ['shells', shells],
        ['bare', bare],
      ] as const)
        writeFileSync(`${process.env.HLOD_SHOTS}/${n}.png`, encodePng(d, w, h))
    }
    const differs = (a: Uint8Array, b: Uint8Array, i: number) =>
      Math.abs(a[i * 4]! - b[i * 4]!) +
        Math.abs(a[i * 4 + 1]! - b[i * 4 + 1]!) +
        Math.abs(a[i * 4 + 2]! - b[i * 4 + 2]!) >
      6
    const windows = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) if (differs(shells, bare, i)) windows[i] = 1
    let windowPixels = 0
    let changed = 0
    let outside = 0
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (windows[i]) windowPixels++
        if (!differs(proxied, shells, i)) continue
        changed++
        let near = false
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const j = (y + dy) * w + (x + dx)
            if (j >= 0 && j < w * h && windows[j]) near = true
          }
        if (!near) outside++
      }
    expect(windowPixels, 'windows in view').toBeGreaterThan(20)
    expect(changed, 'the swap changes something: windows go dark').toBeGreaterThan(0)
    // Everything but windows (walls, roofs, trim, yards, and the shadows on the ground) matches.
    expect(outside / (w * h), `${outside} pixels changed outside windows`).toBeLessThanOrEqual(
      0.005,
    )
    await app.dispose()
  })
})
