import { type Entity, Update, type World } from '@aethervtt/shard-core'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  PartitionInstance,
  PartitionState,
  partitionPlugin,
  partitionSettled,
  StreamingBudget,
  StreamingSource,
} from '@aethervtt/shard-partition'
import {
  Camera3d,
  Cameras,
  DirectionalLight,
  DrawnByProxy,
  Exposure,
  forwardPlugin,
  Gpu,
  Instances,
  OcclusionCulling,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
} from '@aethervtt/shard-render'
import { expectScenario, measureScenario, settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { StructureSettings, structurePlugin } from '@aethervtt/shard-structure'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HlodSettings } from './components'
import { defineDressedTown, dressTown, streetAt } from './fixtures/dressed-town'
import { hlodPlugin } from './plugin'
import { describeHlod, Hlod, hlodSettled } from './runtime'

// town-hlod (0073): Risen's density (about 150 houses in the far ring's 84 cells at 320 m) walked
// at street level in third person, a sun with four on-change cascades, occlusion on the camera.
// Under `pnpm bench`: the frame and its slices against the scenario's budgets. Both tiers: the
// ring report hides each ring in turn and prints its slots, draws and CPU ms.

const bench = timingMode === 'bench'
const WIDTH = bench ? 1920 : 320
const HEIGHT = bench ? 1080 : 180
const FRAMES = bench ? 240 : 24
const TOWN = defineDressedTown('town-hlod', 320, { rows: 1, gap: 18 })

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
})

/** Median CPU ms of `frames` frames, the camera's draws, and the instance slots in use. */
async function sample(app: App, frames: number) {
  const world = app.world
  const ms: number[] = []
  for (let i = 0; i < frames; i++) {
    const t = performance.now()
    app.update(1 / 60)
    ms.push(performance.now() - t)
    await gpu.device.queue.onSubmittedWorkDone()
  }
  ms.sort((a, b) => a - b)
  const camera = [...world.query({ with: [Camera3d] }).entities()][0]!
  return {
    ms: ms[Math.floor(ms.length / 2)]!,
    draws: world.resource(Cameras).get(camera)?.draws.length ?? 0,
    slots: world.resource(Instances).drawableCount,
  }
}

/** Takes entities out of the frame entirely (no slots), as a proxy's cell is, or puts them back. */
function setGone(world: World, entities: Entity[], gone: boolean): void {
  for (const e of entities)
    if (world.isAlive(e) && world.has(e, DrawnByProxy) !== gone) {
      if (gone) world.add(e, DrawnByProxy, {})
      else world.remove(e, DrawnByProxy)
    }
}

describe('scenario: town-hlod (0073)', () => {
  it('scenario: town-hlod walks the far ring drawn by proxies; every slice covers spans that ran', {
    timeout: timeout(900_000),
  }, async () => {
    // The real clock: spans time the frame.
    const app = new App({ fixedHz: 60 }).addPlugin(
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
    const target = new OffscreenTarget(gpu, { label: 'town-hlod', width: WIDTH, height: HEIGHT })
    const ref = world.resource(RenderTargets).add(target, 'town-hlod')
    const camera = world.spawn(
      [Camera3d, { target: ref as never, fovY: 60, far: 400 }],
      [Exposure, { ev100: 12 }],
      [OcclusionCulling, {}],
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
    // Third person: 3 m behind and 1.5 m over the player, looking down the street.
    const place = (x: number) => {
      const eye: [number, number, number] = [x - 3, 2.6, start[2]]
      world.set(camera, Transform, {
        translation: eye,
        rotation: lookAt(eye, [x + 20, 1.6, start[2] + 4]),
      })
      world.set(source, Transform, { translation: [x, 1, start[2]] })
    }
    const steps = async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        await partitionSettled(world)
        await hlodSettled(world)
        app.update(1 / 60)
      }
    }
    place(start[0])
    await steps(240)
    await settle(app)
    const rt = world.resource(PartitionState).instances.values().next().value!
    const loaded = [...rt.cells.values()].filter((c) => c.level >= 0)
    const far = loaded.filter((c) => c.grid.levels[c.level]!.name === 'far')
    const full = loaded.filter((c) => c.grid.levels[c.level]!.name === 'full')
    const houses = (cells: typeof loaded) =>
      cells.reduce((n, c) => n + [...c.entities.keys()].filter((p) => /^h\d+$/.test(p)).length, 0)
    expect(describeHlod(world).levels.far!.covered).toBe(far.length)

    const run = await measureScenario(world, 'town-hlod', {
      frames: FRAMES,
      step: async (i) => {
        // A run along the street, 6 m/s: cells commit and swap levels as the player goes.
        place(start[0] + i * 0.1)
        await partitionSettled(world)
        await hlodSettled(world)
        app.update(1 / 60)
        await gpu.device.queue.onSubmittedWorkDone()
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
      ablation: { frames: 20, rounds: 2 },
    })
    expect(world.resource(Gpu).errors).toEqual([])
    expectScenario(run, expect)
    // HLOD's own share of the main thread, and its builds (inline here: the time a worker takes).
    const select = run.capture.spanTime('hlod/select')
    const sorted = [...select].sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
    const builds = [...world.resource(Hlod).buildMs].sort((a, b) => a - b)
    const build95 = builds[Math.floor(builds.length * 0.95)] ?? 0
    expect(p95, 'hlod/select p95').toBeLessThanOrEqual(budget('hlod/frame'))
    expect(sorted.at(-1) ?? 0, 'hlod/select worst').toBeLessThanOrEqual(budget('hlod/frame-max'))
    expect(build95, 'a proxy build, p95').toBeLessThanOrEqual(budget('hlod/build'))

    // Per ring, standing at the start: everything, then without the far ring's proxies, then
    // without the full ring's cells too. What's gone holds no slots, so its whole cost goes.
    place(start[0])
    await steps(240)
    await settle(app)
    const state = world.resource(Hlod)
    const proxies = [...state.cells.values()]
      .filter((r) => r.covered && r.proxy !== null)
      .map((r) => r.proxy!)
    const fullRoots = [...rt.cells.values()]
      .filter((c) => c.level >= 0 && c.grid.levels[c.level]!.name === 'full')
      .map((c) => c.root)
    state.paused = true
    const all = await sample(app, 30)
    setGone(world, proxies, true)
    const noFar = await sample(app, 30)
    setGone(world, fullRoots, true)
    const none = await sample(app, 30)
    setGone(world, proxies, false)
    setGone(world, fullRoots, false)
    state.paused = false
    // The same view the way it drew before: far cells as shells, structure as chunk meshes.
    world.resource(HlodSettings).enabled = false
    world.resource(StructureSettings).cameraRegions = false
    await steps(4)
    await settle(app)
    const before = await sample(app, 30)
    world.resource(HlodSettings).enabled = true
    world.resource(StructureSettings).cameraRegions = true
    const ring = (a: typeof all, b: typeof all) => ({
      slots: a.slots - b.slots,
      draws: a.draws - b.draws,
      ms: Math.round((a.ms - b.ms) * 100) / 100,
    })
    console.info(
      `town-hlod at ${WIDTH}x${HEIGHT}: ${full.length} full cells (${houses(full)} houses), ${far.length} far (${houses(far)} houses)\n` +
        `  frame p95 CPU ${run.frame.cpuP95.toFixed(2)} ms${run.gpuTimed ? `, GPU ${run.frame.gpuP95.toFixed(2)} ms` : ''}\n` +
        `  hlod/select p95 ${p95.toFixed(3)} ms, worst ${(sorted.at(-1) ?? 0).toFixed(3)} ms; builds ${builds.length}, p95 ${build95.toFixed(2)} ms, max ${(builds.at(-1) ?? 0).toFixed(2)} ms\n` +
        `  whole: ${all.slots} slots, ${all.draws} draws, ${all.ms.toFixed(2)} ms median\n` +
        `  before (shells, chunk meshes): ${before.slots} slots, ${before.draws} draws, ${before.ms.toFixed(2)} ms median\n` +
        `  full ring: ${JSON.stringify(ring(noFar, none))}\n` +
        `  far ring (proxies): ${JSON.stringify(ring(all, noFar))}\n` +
        `  the rest (player, sky, fixed costs): ${none.slots} slots, ${none.ms.toFixed(2)} ms\n` +
        run.slices.map((s) => `  ${s.track} ${s.key}: p95 ${s.p95.toFixed(3)} ms`).join('\n'),
    )
    expect(far.length).toBeGreaterThan(60)
    await app.dispose()
    target.destroy()
  })
})
