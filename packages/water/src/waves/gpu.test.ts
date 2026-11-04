import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import { createGpuContext, type GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { FakeGl } from '@aethervtt/shard-gpu-webgl2/testing'
import {
  Camera3d,
  Exposure,
  forwardPlugin,
  OffscreenTarget,
  ProceduralSky,
  RenderTargets,
  readTextureLayer,
  renderPlugin,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App, FixedTime, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WaterBody } from '../components'
import { waterOptics } from '../optics'
import { waterPlugin } from '../plugin'
import type { WaveGpu } from './gpu'
import { oceanWavesPlugin } from './plugin'
import { WaveRender } from './render-state'
import { seaAt, seaSample, WaveSets } from './sea'
import { OceanWaves } from './spectrum'

const here = dirname(fileURLToPath(import.meta.url))
let gpu: GpuContext
let compat: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(async () => {
  for (const g of [gpu, compat]) {
    await g?.device.queue.onSubmittedWorkDone()
    g?.destroy()
  }
})

async function sea(g: GpuContext, o: { speed?: number; resolution?: number } = {}) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu: g, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    waterPlugin(),
    oceanWavesPlugin(),
  )
  await app.init()
  const world = app.world
  world.resource(Wind).speed = o.speed ?? 15
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(g, { label: 'waves', width: 64, height: 40 }), 'waves')
  const eye: [number, number, number] = [0, 20, -60]
  world.spawn(
    [Camera3d, { target, fovY: 55, near: 0.1, far: 0 }],
    [Exposure, { ev100: 14 }],
    [ProceduralSky, { turbidity: 2.5 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }],
  )
  const ocean = world.spawn(
    [WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }],
    [OceanWaves, { seed: 3, fetch: 300, resolution: o.resolution ?? 256 }],
    Transform,
  )
  await settle(app, 60)
  return { app, world, ocean }
}

type Scene = Awaited<ReturnType<typeof sea>>

/** The GPU's displacement layers (one per cascade) as floats, after a frame at a fixed tick. */
async function readSea(s: Scene, tick: number) {
  const fixed = s.world.resource(FixedTime)
  fixed.tick = tick
  fixed.alpha = 0
  // Render without advancing time: the sea for this tick.
  s.app.runSchedule((await import('@aethervtt/shard-core')).PostUpdate)
  s.app.runSchedule((await import('@aethervtt/shard-core')).Last)
  const w = s.world.resource(WaveRender) as WaveGpu
  expect(w.tick).toBe(tick)
  const layers = []
  for (const l of w.layers)
    layers.push(
      (
        await readTextureLayer(
          s.app.world.resource((await import('@aethervtt/shard-render')).Gpu),
          w.output!,
          l.layer * 2,
        )
      ).data,
    )
  return { w, layers }
}

/** The GPU sea's height over world (x, z): every cascade, bilinear, undisplaced point found the way waterAt does. */
function gpuHeight(w: WaveGpu, layers: Float32Array[], x: number, z: number): number {
  const n = w.n
  const sample = (c: number, px: number, pz: number, k: number) => {
    const length = w.layers[c]!.set.sea.cascades[w.layers[c]!.cascade]!.length
    const u = ((px / length) * n) % n
    const v = ((pz / length) * n) % n
    const i0 = Math.floor(u)
    const j0 = Math.floor(v)
    const fu = u - i0
    const fv = v - j0
    const at = (i: number, j: number) =>
      layers[c]![((((j % n) + n) % n) * n + (((i % n) + n) % n)) * 4 + k]!
    return (
      (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) +
      (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv
    )
  }
  let ux = x
  let uz = z
  for (let it = 0; it < 6; it++) {
    let dx = 0
    let dz = 0
    for (let c = 0; c < layers.length; c++) {
      dx += sample(c, ux, uz, 0)
      dz += sample(c, ux, uz, 2)
    }
    ux = x - dx
    uz = z - dz
  }
  let h = 0
  for (let c = 0; c < layers.length; c++) h += sample(c, ux, uz, 1)
  return h
}

function problems(s: Scene) {
  return s.world
    .resource(LogResource)
    .tail(200, 'warn')
    .map((e) => `${e.code ?? ''} ${e.message}`)
}

describe('ocean waves on the GPU (0098)', () => {
  it('match the CPU evaluator within 5% of Hs RMS at 1 000 points', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await sea(gpu)
    const { w, layers } = await readSea(s, 3_600)
    const set = s.world.resource(WaveSets).sets.get(s.ocean)!
    const out = seaSample()
    let seed = 5
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    let sq = 0
    let gpuSq = 0
    for (let i = 0; i < 1000; i++) {
      const x = -400 + rand() * 800
      const z = -400 + rand() * 800
      const cpu = seaAt(set, x, z, w.time, w.tick, Number.POSITIVE_INFINITY, out).height
      const g = gpuHeight(w, layers, x, z)
      sq += (cpu - g) ** 2
      gpuSq += g * g
    }
    const rms = Math.sqrt(sq / 1000)
    const hs = set.sea.hs
    console.log(
      `CPU vs GPU: RMS ${rms.toFixed(3)} m, Hs ${hs.toFixed(2)} m (${((rms / hs) * 100).toFixed(1)}%), GPU Hs ${(4 * Math.sqrt(gpuSq / 1000)).toFixed(2)} m`,
    )
    expect(rms).toBeLessThan(0.05 * hs)
    expect(problems(s)).toEqual([])
    await s.app.dispose()
  })

  it('is the same sea in two apps at the same tick (two clients)', {
    timeout: timeout(60_000),
  }, async () => {
    const seas: Float32Array[][] = []
    for (let k = 0; k < 2; k++) {
      const s = await sea(gpu)
      // The second app ran a different number of frames before: only the tick matters.
      for (let i = 0; i < k * 37; i++) s.app.update(1 / 60)
      seas.push((await readSea(s, 4_321)).layers)
      await s.app.dispose()
    }
    let worst = 0
    for (let c = 0; c < seas[0]!.length; c++)
      for (let i = 1; i < seas[0]![c]!.length; i += 4)
        worst = Math.max(worst, Math.abs(seas[0]![c]![i]! - seas[1]![c]![i]!))
    console.log(`two apps at tick 4321: worst height difference ${worst} m`)
    expect(worst).toBeLessThan(0.001)
  })

  it('agree between WebGPU and the baseline tier within 1 mm RMS', {
    timeout: timeout(60_000),
  }, async () => {
    const heights: Float32Array[][] = []
    for (const g of [gpu, compat]) {
      const s = await sea(g)
      const { layers } = await readSea(s, 1_234)
      heights.push(layers)
      expect(problems(s)).toEqual([])
      await s.app.dispose()
    }
    let sq = 0
    let n = 0
    for (let c = 0; c < heights[0]!.length; c++) {
      const a = heights[0]![c]!
      const b = heights[1]![c]!
      for (let i = 1; i < a.length; i += 4) {
        sq += (a[i]! - b[i]!) ** 2
        n++
      }
    }
    const rms = Math.sqrt(sq / n)
    console.log(`WebGPU vs baseline: height RMS ${(rms * 1000).toFixed(3)} mm over ${n} texels`)
    expect(rms).toBeLessThan(0.001)
  })
})

describe('ocean waves on WebGL2 (0064)', () => {
  it('translate every wave kernel with naga', { timeout: timeout(60_000) }, async () => {
    const fake = new FakeGl()
    const gl = await createGpuContext({
      backend: 'webgl2',
      webgl2: { context: fake.context, persist: false },
    })
    try {
      const s = await sea(gl, { resolution: 128 })
      expect(gl.errors).toEqual([])
      expect(problems(s)).toEqual([])
      await s.app.dispose()
    } finally {
      gl.destroy()
    }
  })
})

describe('a wind change on the GPU (0098)', () => {
  it('crossfades over 120 ticks with no tick where any texel moves a tenth of its shortest wave', {
    timeout: timeout(120_000),
  }, async () => {
    const s = await sea(gpu, { speed: 6, resolution: 128 })
    const fixed = s.world.resource(FixedTime)
    const r = await import('@aethervtt/shard-render')
    const core = await import('@aethervtt/shard-core')
    const read = async () => {
      const w = s.world.resource(WaveRender) as WaveGpu
      const out: Float32Array[] = []
      for (const l of w.layers)
        out.push((await readTextureLayer(s.world.resource(r.Gpu), w.output!, l.layer * 2)).data)
      return out
    }
    const w = s.world.resource(WaveRender) as WaveGpu
    let before: Float32Array[] | undefined
    let first: Float32Array[] | undefined
    const worst = [0, 0, 0]
    for (let tick = 590; tick <= 730; tick++) {
      fixed.tick = tick
      fixed.alpha = 0
      if (tick === 600) s.world.resource(Wind).speed = 18
      s.app.runSchedule(core.PostUpdate)
      s.app.runSchedule(core.Last)
      const now = await read()
      first ??= now
      if (before) {
        for (let c = 0; c < now.length; c++) {
          for (let i = 0; i < now[c]!.length; i += 4) {
            const d = Math.hypot(
              now[c]![i]! - before[c]![i]!,
              now[c]![i + 1]! - before[c]![i + 1]!,
              now[c]![i + 2]! - before[c]![i + 2]!,
            )
            worst[c] = Math.max(worst[c]!, d)
          }
        }
      }
      before = now
    }
    const set = s.world.resource(WaveSets).sets.get(s.ocean)!
    expect(set.old).toBeUndefined()
    expect(set.fadeStart).toBe(600)
    // The whole change, against the most any tick moved.
    let total = 0
    for (let i = 0; i < first![0]!.length; i += 4)
      total = Math.max(total, Math.abs(before![0]![i + 1]! - first![0]![i + 1]!))
    const limits = set.sea.cascades.map((c) => (2 * Math.PI) / c.kMax / 10)
    console.log(
      `crossfade: most a texel moved in a tick ${worst.map((v) => v.toFixed(3)).join(', ')} m; a tenth of the shortest waves ${limits.map((v) => v.toFixed(3)).join(', ')} m; the height changed up to ${total.toFixed(2)} m overall`,
    )
    for (let c = 0; c < limits.length; c++) expect(worst[c]).toBeLessThan(limits[c]!)
    expect(total).toBeGreaterThan(10 * limits[0]!)
    expect(w.layers.length).toBe(3)
    expect(problems(s)).toEqual([])
    await s.app.dispose()
  })

  it('computes 3 cascades at 256² within gpu:water-waves', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await sea(gpu)
    for (let i = 0; i < 60; i++) s.app.update(1 / 60)
    await new Promise((r) => setTimeout(r, 50))
    s.app.update(1 / 60)
    const ms =
      s.world
        .resource((await import('@aethervtt/shard-core')).ProfilerResource)
        .timing('gpu:water-waves')?.avg ?? null
    console.log(`gpu:water-waves, 3 cascades at 256²: ${ms?.toFixed(3) ?? 'no timestamps'} ms`)
    if (ms !== null)
      expect(ms).toBeLessThan(
        (await import('@aethervtt/shard-core/test-env')).budget('gpu:water-waves'),
      )
    await s.app.dispose()
  })
})

describe('ocean waves in the picture (0098)', () => {
  async function shore(
    g: GpuContext,
    o: {
      eye: [number, number, number]
      at: [number, number, number]
      beach: boolean
      width: number
      height: number
    },
  ) {
    const core = await import('@aethervtt/shard-core')
    const terrain = await import('@aethervtt/shard-terrain')
    const testing = await import('@aethervtt/shard-terrain/testing')
    const noise = await import('@aethervtt/shard-noise')
    await noise.loadNoiseKernel()
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu: g, windowView: false }),
      forwardPlugin({ msaa: 4 }),
    )
    if (o.beach) app.addPlugin(terrain.terrainPlugin())
    app.addPlugin(waterPlugin(), oceanWavesPlugin())
    await app.init()
    const world = app.world
    world.resource(Wind).speed = 10
    world.resource(Wind).direction = [1, 0, 0]
    const target = world
      .resource(RenderTargets)
      .add(new OffscreenTarget(g, { label: 'shore', width: o.width, height: o.height }), 'shore')
    const r = await import('@aethervtt/shard-render')
    world.spawn(
      [r.DirectionalLight, { illuminance: 90_000, shadows: false }],
      [Transform, { rotation: core.quat.fromEuler([0, 0, 0, 1], -0.5, 2.4, 0) as never }],
    )
    world.spawn(
      [Camera3d, { target, fovY: 55, near: 0.1, far: 0 }],
      [Exposure, { ev100: 14 }],
      [r.Tonemapping, { curve: 'agx', dither: false }],
      [ProceduralSky, { turbidity: 2.5 }],
      [Transform, { translation: o.eye, rotation: lookAt(o.eye, o.at) }],
    )
    let terrainEntity: number | undefined
    if (o.beach) {
      // A beach rising along +x: 12 m down at x 0, 4 m up at x 256 (1 in 16).
      const n = 64
      const data = new Float32Array(n * n)
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = x / (n - 1)
      const asset = testing.sourceAsset(world, {
        source: {
          size: [256, 256],
          spacing: 1,
          heightRange: [-20, 20],
          seed: 1,
          height: [
            {
              image: { path: 'ramp' },
              at: [128, 128],
              size: [256, 256],
              rotation: 0,
              range: [-12, 4],
              blend: 'add',
              falloff: 0,
            },
          ],
          layers: [{ name: 'sand' }],
          paint: [{ layer: 'sand' }],
        },
        heightmaps: { ramp: { width: n, height: n, data } },
      })
      const ref = world.initResource(terrain.TerrainSources).add(asset, 'ramp.terrain.json')
      terrainEntity = world.spawn(
        [(await import('@aethervtt/shard-transform')).Grid, { cellSize: 2000 }],
        [terrain.Terrain, { source: ref }],
        [Transform, { translation: [-128, 0, -128] }],
      )
    }
    const ocean = world.spawn(
      [WaterBody, { kind: 'ocean', optics: waterOptics('coastal') }],
      [OceanWaves, { seed: 7, fetch: 60 }],
      Transform,
    )
    if (terrainEntity !== undefined) {
      const start = performance.now()
      while (
        !world.resource(terrain.TerrainWorld).heightfields.get(terrainEntity as never)?.streaming
      ) {
        app.update(1 / 60)
        await new Promise((res) => setTimeout(res, 5))
        if (performance.now() - start > 60_000) throw new Error('terrain never streamed')
      }
    }
    await settle(app, 80)
    // Let foam build: a few seconds of sea.
    for (let i = 0; i < 240; i++) app.update(1 / 60)
    await settle(app)
    return { app, world, ocean }
  }

  it('shows no tiling from 200 m up (golden)', { timeout: timeout(60_000) }, async () => {
    const s = await shore(gpu, {
      eye: [0, 200, 0],
      at: [300, 0, 400],
      beach: false,
      width: 320,
      height: 180,
    })
    const shot = (await import('@aethervtt/shard-render')).captureView(
      s.world,
      `camera:${[...s.world.query({ with: [Camera3d] }).tables].flatMap((t) => [...t.entities.slice(0, t.count)])[0]}`,
    )
    s.app.update(1 / 60)
    const image = await shot
    expect(
      (await import('@aethervtt/shard-render/testing')).compareGolden(
        here,
        'waves-from-200m',
        image,
      ).mean,
    ).toBeLessThan(1.5)
    expect(s.world.resource(LogResource).tail(50, 'warn')).toEqual([])
    await s.app.dispose()
  })

  it('waves shrink toward a sloping beach, with foam along it (golden)', {
    timeout: timeout(120_000),
  }, async () => {
    const s = await shore(gpu, {
      eye: [30, 3.5, -22],
      at: [66, 0, 6],
      beach: true,
      width: Number(process.env.BEACH_W ?? 320),
      height: Number(process.env.BEACH_H ?? 180),
    })
    // The CPU sea at points 10 m, 3 m and 1 m deep, over 60 s: smaller in the shallows.
    const fixed = s.world.resource(FixedTime)
    const sample = (await import('../query')).waterSample()
    const at = (await import('../query')).waterAt
    const spread: number[] = []
    // The ground is −12 m at x −128 and 4 m at x 128: 10, 3 and 1 m deep here.
    for (const x of [-96, 16, 48]) {
      let sum = 0
      let sum2 = 0
      for (let tick = 0; tick < 3600; tick += 6) {
        fixed.tick = tick
        at(s.world, [x, -50, 0], sample)
        sum += sample.surfaceHeight
        sum2 += sample.surfaceHeight ** 2
      }
      spread.push(Math.sqrt(sum2 / 600 - (sum / 600) ** 2))
      expect(sample.groundHeight).toBeGreaterThan(-13)
    }
    console.log(
      `waves' RMS height 10, 3 and 1 m deep: ${spread.map((v) => v.toFixed(3)).join(', ')} m`,
    )
    expect(spread[1]!).toBeLessThan(spread[0]! * 0.8)
    expect(spread[2]!).toBeLessThan(spread[1]!)
    const r = await import('@aethervtt/shard-render')
    const shot = r.captureView(
      s.world,
      `camera:${[...s.world.query({ with: [Camera3d] }).tables].flatMap((t) => [...t.entities.slice(0, t.count)])[0]}`,
    )
    s.app.update(1 / 60)
    expect(
      (await import('@aethervtt/shard-render/testing')).compareGolden(
        here,
        'waves-beach',
        await shot,
      ).mean,
    ).toBeLessThan(1.5)
    expect(s.world.resource(LogResource).tail(50, 'warn')).toEqual([])
    await s.app.dispose()
  })
})
