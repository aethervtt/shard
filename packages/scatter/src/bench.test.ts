import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerformanceObserver } from 'node:perf_hooks'
import { assetServer } from '@aethervtt/shard-assets'
import type { AssetRef } from '@aethervtt/shard-core'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { procgenPlugin } from '@aethervtt/shard-procgen'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  FoliageLayers,
  ForwardStateResource,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { planetHeightAt, TerrainAnchor } from '@aethervtt/shard-terrain'
import { placeCamera, settleTerrain } from '@aethervtt/shard-terrain/testing'
import { lookAt, placeInGrid, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prop, ScatterSurface } from './components'
import { scatterPlugin } from './plugin'
import { Scatter } from './runtime'
import { ScatterSet } from './set'
import { scatterPlanet, settleScatter, TEST_RADIUS } from './testing'

// Spec 0045's budgets: prop spawning while walking, 20 000 live props, 2M foliage blades. Times
// hold only under `pnpm bench`; `pnpm test` checks the counts and that nothing scales per instance,
// at small sizes and a few frames (CI renders on a software GPU).

const bench = timingMode === 'bench'
/** Frames a timed loop runs, and the view size: full under `pnpm bench`. */
const FRAMES = bench ? 120 : 4
const WIDTH = bench ? 960 : 320
const HEIGHT = bench ? 540 : 180

const roots: string[] = []
let gpu: GpuContext

beforeAll(async () => {
  await loadNoiseKernel()
  gpu = await createNodeGpuContext()
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
}, timeout(60_000))

const sorted = (a: number[]) => [...a].sort((x, y) => x - y)
const pct = (a: number[], p: number) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))]!

function platform() {
  const root = mkdtempSync(join(tmpdir(), 'shard-scatter-bench-'))
  roots.push(root)
  return createNodePlatform({ root, logTo: () => {} })
}

/** GC pauses land in whatever runs when they strike: they're the VM's, not scatter's. */
function gcClock() {
  const gcs: [number, number][] = []
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push([e.startTime, e.startTime + e.duration])
  })
  observer.observe({ entryTypes: ['gc'] })
  return {
    within(from: number, to: number) {
      for (const e of observer.takeRecords()) gcs.push([e.startTime, e.startTime + e.duration])
      let ms = 0
      for (const [a, b] of gcs) ms += Math.max(0, Math.min(b, to) - Math.max(a, from))
      return ms
    },
    stop: () => observer.disconnect(),
  }
}

function direction(angle: number): number[] {
  const d = [Math.cos(angle) * 0.3, 0.9, Math.sin(angle) * 0.3]
  const l = Math.hypot(d[0]!, d[1]!, d[2]!)
  return d.map((x) => x / l)
}

describe('scatter budgets (spec 0045)', () => {
  it('walks 1 km on a planet with prop spawning and despawning under 1 ms a frame', {
    timeout: timeout(300_000),
  }, async () => {
    const host = platform()
    const p = await scatterPlanet(undefined, host, { workers: true })
    const anchor = p.world.spawn([TerrainAnchor, { radius: 60 }], Transform)
    const start = direction(3 * 0.157)
    const east = [start[2]!, 0, -start[0]!]
    const el = Math.hypot(east[0]!, east[1]!, east[2]!)
    const put = (metres: number) => {
      const s = metres / TEST_RADIUS
      const d = start.map((x, k) => x + (east[k]! / el) * s)
      const l = Math.hypot(d[0]!, d[1]!, d[2]!)
      const n = d.map((x) => x / l)
      const h = planetHeightAt(p.world, p.planet, n)
      placeInGrid(
        p.world,
        anchor,
        p.planet,
        n.map((x) => x * (TEST_RADIUS + h + 1)),
      )
    }
    put(0)
    await settleScatter(p)
    const ss = p.world.resource(Scatter).surfaces.get(p.planet)!
    // A brisk walk (6 m/s); `pnpm test` walks 150 m, the bench the whole kilometre.
    const SPEED = 6
    const metres = timingMode === 'bench' ? 1000 : 150
    const frames = Math.round((metres / SPEED) * 60)
    const gc = gcClock()
    const perFrame: number[] = []
    let spawned = 0
    for (let f = 0; f < frames; f++) {
      put((f * SPEED) / 60)
      const from = performance.now()
      p.app.update(1 / 60)
      perFrame.push(Math.max(0, ss.spawnMs - gc.within(from, performance.now())))
      spawned += ss.spawnedLast
      // Pool results arrive between frames.
      if (f % 10 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    gc.stop()
    let live = 0
    for (const t of p.world.query({ with: [Prop] }).tables) live += t.count
    expect(spawned).toBeGreaterThan(100)
    expect(live).toBeGreaterThan(1000)
    expect(Math.max(...perFrame)).toBeLessThan(budget('scatter/spawn-frame'))
    await p.app.dispose()
    host.workers?.dispose()
  })

  it('keeps 20 000 props live within range under 16.6 ms a frame', {
    timeout: timeout(300_000),
  }, async () => {
    const host = platform()
    // Pebbles everywhere on top of the biomes' sets: well over 20 000 props around the camera.
    const p = await scatterPlanet(gpu, host, {
      width: WIDTH,
      height: HEIGHT,
      workers: true,
      planetSet: {
        rules: [
          {
            name: 'pebbles',
            items: [{ generator: 'shard/Rock', params: { radius: 0.25, detail: 2 }, variants: 4 }],
            density: 0.05,
            spacing: 1.5,
            align: 1,
            scale: [0.6, 1.6],
            sink: 0.2,
            range: 400,
          },
        ],
      },
    })
    const w = p.world
    const d = direction(18 * 0.157)
    const h = planetHeightAt(w, p.planet, d)
    const eye = d.map((x) => x * (TEST_RADIUS + h + 1.7))
    const t = [d[2]!, 0, -d[0]!]
    placeCamera(
      p,
      eye,
      eye.map((x, k) => x + t[k]! * 20 - d[k]! * 3),
    )
    await settleTerrain(p)
    await settleScatter(p, 2000)
    await settleTerrain(p)
    let live = 0
    for (const table of w.query({ with: [Prop] }).tables) live += table.count
    expect(live).toBeGreaterThanOrEqual(20_000)
    const times: number[] = []
    for (let f = 0; f < FRAMES + 60; f++) {
      const t0 = performance.now()
      p.app.update(1 / 60)
      const t1 = performance.now()
      await gpu.device.queue.onSubmittedWorkDone()
      const t2 = performance.now()
      // A real loop overlaps CPU and GPU: a frame takes the longer of the two.
      if (f >= 60 || !bench) times.push(Math.max(t1 - t0, t2 - t1))
    }
    expect(w.resource(Gpu).errors).toEqual([])
    expect(pct(times, 0.95)).toBeLessThan(budget('scatter/props-frame'))
    await p.app.dispose()
    host.workers?.dispose()
  })

  it('draws 2M grass blades within 60 m of a view, with no CPU work per instance', {
    timeout: timeout(300_000),
  }, async () => {
    if (!gpu.features.has('indirect-first-instance')) return
    const host = platform()
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin({ msaa: 1 }),
      ScenePlugin,
      procgenPlugin(),
      scatterPlugin(),
    )
    await app.init()
    await assetServer(app.world).configure({ platform: host }).scan()
    const w = app.world
    const target = new OffscreenTarget(gpu, { label: 'blades', width: WIDTH, height: HEIGHT })
    const ref = w.resource(RenderTargets).add(target, 'blades') as AssetRef<'RenderTarget'>
    const set = w.initResource(ScatterSet.store).add(
      ScatterSet.deserialize({
        rules: [
          {
            name: 'grass',
            kind: 'foliage',
            items: [{ generator: 'shard/GrassClump', params: { blades: 64 }, variants: 3 }],
            density: 30,
            align: 0.3,
            range: 60,
          },
        ],
      } as never),
      'meadow',
    )
    w.spawn(
      [Mesh3d, { mesh: w.resource(Meshes).add(plane({ size: 1, subdivisions: 2 })) }],
      [
        MeshMaterial,
        {
          material: w
            .resource(Materials)
            .add(new MaterialAsset({ baseColor: [0.3, 0.25, 0.2, 1] })),
        },
      ],
      [ScatterSurface, { set }],
      [Transform, { scale: [400, 400, 400] }],
    )
    Object.assign(w.resource(AmbientLight), { brightness: 2500 })
    w.spawn(
      [DirectionalLight, { illuminance: 30_000, shadows: true }],
      [Transform, { rotation: lookAt([-2, 8, 3], [0, 0, 0]) }],
    )
    // Looking down the meadow from head height: half the view is grass out to 60 m.
    const eye: [number, number, number] = [0, 1.7, 0]
    w.spawn(
      [Camera3d, { target: ref, fovY: 70 }],
      [Exposure, { ev100: 13 }],
      [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, -10]) }],
    )
    for (let i = 0; i < 600; i++) {
      app.update(1 / 60)
      await new Promise((r) => setTimeout(r, 1))
      const layers = [...w.resource(FoliageLayers).layers]
      if (layers.length > 0 && layers.every((l) => l.chunkCount > 0 && l.pending.length === 0))
        break
    }
    await settle(app)
    // The vegetation material compiled (a failure would draw through the standard fallback).
    expect(w.resource(ForwardStateResource).pipelines.failures()).toEqual([])
    const layer = [...w.resource(FoliageLayers).layers][0]!
    const view = [...layer.views.keys()][0]!
    // Blades drawn: each level's clumps times its blades (64, then 40 and 20 farther out).
    const { drawn } = layer.visibleByDrawable(view)
    const BLADES = [64, 40, 20]
    let blades = 0
    for (const [d, n] of drawn.entries()) blades += n * BLADES[d % 3]!
    expect(blades).toBeGreaterThan(2_000_000)
    // CPU: the scatter system's time doesn't grow with instances (it touches chunks, not blades).
    const ss = [...w.resource(Scatter).surfaces.values()][0]!
    const cpu: number[] = []
    const gpuWith: number[] = []
    for (let f = 0; f < FRAMES; f++) {
      app.update(1 / 60)
      const t1 = performance.now()
      await gpu.device.queue.onSubmittedWorkDone()
      if (f >= FRAMES / 6) {
        cpu.push(ss.ms)
        gpuWith.push(performance.now() - t1)
      }
    }
    expect(pct(cpu, 0.95)).toBeLessThan(budget('scatter/foliage-cpu'))
    // GPU: the same frames without the layer, to isolate what the grass costs.
    const layers = w.resource(FoliageLayers).layers
    layers.delete(layer)
    const gpuWithout: number[] = []
    for (let f = 0; f < FRAMES; f++) {
      app.update(1 / 60)
      const t1 = performance.now()
      await gpu.device.queue.onSubmittedWorkDone()
      if (f >= FRAMES / 6) gpuWithout.push(performance.now() - t1)
    }
    layers.add(layer)
    expect(pct(gpuWith, 0.5) - pct(gpuWithout, 0.5)).toBeLessThan(budget('gpu:foliage'))
    await app.dispose()
    target.destroy()
  })
})
