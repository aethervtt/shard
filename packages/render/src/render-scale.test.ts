import type { Entity } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane } from '@aethervtt/shard-mesh'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight } from './lights'
import { pick } from './picking'
import { captureBuffer, describeRender, Gpu, Graph, renderPlugin } from './plugin'
import { Antialiasing } from './post'
import {
  type FrameTimings,
  RenderScale,
  RenderScaleController,
  type RenderScaleValue,
  scaledSize,
} from './render-scale'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { renderView, settle } from './testing'
import { Cameras, RenderPath, ViewSettings } from './view'

// --- controller ----------------------------------------------------------------------------------

function settings(overrides: Partial<RenderScaleValue> = {}): RenderScaleValue {
  return {
    mode: 'auto',
    scale: 1,
    min: 0.5,
    max: 1,
    targetMs: 16,
    maxHz: 144,
    budgetMs: 16,
    sharpen: 0.25,
    windowViews: 1,
    signal: 'none',
    measuredMs: 0,
    ...overrides,
  }
}

/** A GPU whose frame costs `ms(scale)`: each call is one frame with a fresh timestamp sample. */
function gpuRun(
  s: RenderScaleValue,
  ms: (scale: number, frame: number) => number,
  frames: number,
  displayMs = 1000 / 60,
) {
  const c = new RenderScaleController()
  const timings = { enabled: true, frameMs: 0, frameSamples: 0 }
  const seen: number[] = []
  for (let i = 0; i < frames; i++) {
    timings.frameMs = ms(s.scale, i)
    timings.frameSamples++
    c.update(s, displayMs / 1000, timings, false, displayMs)
    if (seen.at(-1) !== s.scale) seen.push(s.scale)
  }
  return seen
}

/** Frame interval only: vsync at 60 Hz, so a frame is a whole number of 16.7 ms intervals. */
function frameRun(s: RenderScaleValue, ms: (scale: number) => number, frames: number) {
  const c = new RenderScaleController()
  const timings: FrameTimings = { enabled: false, frameMs: 0, frameSamples: 0 }
  const seen: number[] = []
  for (let i = 0; i < frames; i++) {
    const dt = Math.ceil(ms(s.scale) / 16.7 - 1e-3) * 16.7
    c.update(s, dt / 1000, timings, false)
    if (seen.at(-1) !== s.scale) seen.push(s.scale)
  }
  return seen
}

describe('render scale controller', () => {
  it('drops toward the budget in one step when the GPU runs over, snapped to 0.05', () => {
    // 30 ms at native: cost ∝ scale², so the budget (16 ms) needs about 0.73.
    const s = settings()
    gpuRun(s, (k) => 30 * k * k, 600)
    expect(s.signal).toBe('gpu')
    expect(s.scale).toBeLessThan(0.75)
    expect(s.scale).toBeGreaterThanOrEqual(0.6)
    expect(Math.round(s.scale * 20)).toBe(s.scale * 20)
    expect(30 * s.scale * s.scale).toBeLessThan(16)
  })

  it('rises back to native on sustained headroom, and never past max', () => {
    const s = settings({ scale: 0.5 })
    const seen = gpuRun(s, (k) => 6 * k * k, 1200)
    expect(s.scale).toBe(1)
    expect(Math.max(...seen)).toBe(1)
    // At most 0.1 at a time on the way up.
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]! - seen[i - 1]!).toBeLessThanOrEqual(0.1 + 1e-9)
  })

  it('respects min on a GPU that can never make the budget', () => {
    const s = settings({ min: 0.6 })
    gpuRun(s, () => 80, 600)
    expect(s.scale).toBe(0.6)
  })

  it('holds a scale that fits the budget', () => {
    const s = settings({ scale: 0.8 })
    // 0.8 → 12.8 ms: under budget, but not under 60% of it, so no reason to move.
    const seen = gpuRun(s, (k) => 20 * k * k, 600)
    expect(seen).toEqual([0.8])
  })

  it('leaves fixed mode and views off the window alone', () => {
    const fixed = settings({ mode: 'fixed', scale: 0.7 })
    gpuRun(fixed, () => 100, 300)
    expect(fixed.scale).toBe(0.7)
    expect(fixed.signal).toBe('none')
    const offscreen = settings({ windowViews: 0 })
    gpuRun(offscreen, () => 100, 300)
    expect(offscreen.scale).toBe(1)
  })

  it('ignores frames that compile pipelines or hitch', () => {
    const s = settings()
    const c = new RenderScaleController()
    const timings = { enabled: true, frameMs: 100, frameSamples: 0 }
    for (let i = 0; i < 300; i++) {
      timings.frameSamples++
      c.update(s, 1 / 60, timings, true)
    }
    for (let i = 0; i < 300; i++)
      c.update(s, 0.5, { enabled: false, frameMs: 0, frameSamples: 0 }, false)
    expect(s.scale).toBe(1)
  })

  it('on the frame interval, drops when GPU-bound and settles under budget', () => {
    // GPU-bound: 30 ms at native misses vsync (33 ms frames); 0.8 still does (19 ms), 0.7 makes it.
    const s = settings({ targetMs: 16.7 })
    frameRun(s, (k) => 30 * k * k, 1200)
    expect(s.signal).toBe('frame')
    expect(30 * s.scale * s.scale).toBeLessThanOrEqual(16.7)
    expect(s.scale).toBeGreaterThanOrEqual(0.6)
  })

  it('on the frame interval, undoes a drop that did not help (CPU-bound)', () => {
    const s = settings({ targetMs: 16.7 })
    const seen = frameRun(s, () => 25, 1800)
    // One dip to find out, then it stays native.
    expect(seen).toEqual([1, 0.9, 0.8, 0.7, 1])
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0.7)
    expect(s.scale).toBe(1)
  })

  it('holds one display refresh by default: 120 Hz gets 8.3 ms', () => {
    // The playground planet 1 km up: 9 ms of GPU at native misses every other 120 Hz refresh.
    const s = settings({ targetMs: 0 })
    gpuRun(s, (k) => 9 * k * k, 1200, 1000 / 120)
    expect(s.budgetMs).toBeCloseTo(8.33, 2)
    expect(9 * s.scale * s.scale).toBeLessThan(8.33 * 0.95)
    expect(s.scale).toBeGreaterThanOrEqual(0.85)
  })

  it('rises back once the view gets cheaper, and caps the rate it chases at maxHz', () => {
    // 9 ms for 10 s (drops), then a cheaper view at 6 ms native (rises all the way back).
    const s = settings({ targetMs: 0 })
    gpuRun(s, (k, f) => (f < 1200 ? 9 : 6) * k * k, 3600, 1000 / 120)
    expect(s.scale).toBe(1)
    const fast = settings({ targetMs: 0 })
    gpuRun(fast, () => 1, 10, 1000 / 240)
    expect(fast.budgetMs).toBeCloseTo(1000 / 144, 5)
  })

  it('sizes in whole pixels, at least one', () => {
    expect(scaledSize(3456, 0.75)).toBe(2592)
    expect(scaledSize(1, 0.5)).toBe(1)
    expect(scaledSize(100, 0.1)).toBe(25) // clamped to 0.25
  })
})

// --- renderer ------------------------------------------------------------------------------------

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

async function scene(scale: number, extra: unknown[] = [], renderScale = true) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1, renderScale: { mode: 'fixed', scale } }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, {
    label: 'window-like',
    width: 160,
    height: 96,
    renderScale,
  })
  const targetRef = world.resource(RenderTargets).add(target, 'window-like')
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  world.resource(AmbientLight).brightness = 1500
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 40 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.5, 0.5, 0.5, 1] })) },
    ],
    Transform,
  )
  const box = world.spawn(
    [Mesh3d, { mesh: meshes.add(cube({ size: 2 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.8, 0.2, 0.1, 1] })) },
    ],
    [Transform, { translation: [0, 1, 0] }],
  )
  world.spawn([DirectionalLight, { illuminance: 10_000 }], [Transform, { translation: [0, 5, 0] }])
  const eye: [number, number, number] = [0, 3, 7]
  const cam = world.spawn(
    [Camera3d, { target: targetRef as never, fovY: 45 }],
    [Exposure, { ev100: 12 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 1, 0]) }],
    ...(extra as []),
  )
  return { app, world, cam, box }
}

const meanDiff = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

async function render(scale: number, extra: unknown[] = [], renderScale = true) {
  const s = await scene(scale, extra, renderScale)
  const image = await renderView(s.app, `camera:${s.cam}`)
  expect(s.world.resource(Gpu).errors).toEqual([])
  expect(s.world.resource(LogResource).errors()).toEqual([])
  const order = s.world.resource(Graph).describe().perView[`camera:${s.cam}`]!.order
  return { ...s, image, order }
}

describe('render scale', () => {
  it('renders the scene at the render resolution and upscales onto the full target', async () => {
    const native = await render(1)
    const half = await render(0.5)
    expect(native.order).not.toContain('post/upscale')
    expect(half.order).toContain('post/upscale')
    expect([half.image.width, half.image.height]).toEqual([160, 96])
    const hdr = captureBuffer(half.world, `camera:${half.cam}`, 'hdr')
    half.app.update(1 / 60)
    const buffer = await hdr
    expect([buffer.width, buffer.height]).toEqual([80, 48])
    // The same picture, only softer.
    expect(meanDiff(native.image.data, half.image.data)).toBeLessThan(6)
  })

  it('runs exactly the old graph at scale 1 and on targets that do not follow the scale', async () => {
    const off = await render(0.5, [], false)
    const native = await render(1)
    expect(off.order).toEqual(native.order)
    expect(meanDiff(off.image.data, native.image.data)).toBe(0)
  })

  it('upscales after FXAA, and in deferred views', async () => {
    const fxaa = await render(0.5, [[Antialiasing, { mode: 'fxaa' }]])
    expect(fxaa.order.indexOf('post/fxaa')).toBeLessThan(fxaa.order.indexOf('post/upscale'))
    const deferred = await render(0.5, [[RenderPath, { mode: 'deferred' }]])
    expect(deferred.order).toContain('post/upscale')
    const native = await render(1, [[RenderPath, { mode: 'deferred' }]])
    expect(meanDiff(native.image.data, deferred.image.data)).toBeLessThan(6)
  })

  it('picks in target pixels', async () => {
    const { app, world, cam, box } = await scene(0.5)
    await settle(app)
    const hit = pick(world, cam as Entity, 80, 40)
    app.update(1 / 60)
    await settle(app, 4)
    expect((await hit)?.entity).toBe(box)
  })

  it('describes the scale and each view’s render size', async () => {
    const { app, world, cam } = await scene(0.75)
    await settle(app)
    const d = describeRender(world) as ReturnType<typeof describeRender> & {
      renderScale: { mode: string; scale: number; views: Record<string, unknown> }
    }
    expect(d.renderScale.mode).toBe('fixed')
    expect(d.renderScale.scale).toBe(0.75)
    expect(d.renderScale.views[`camera:${cam}`]).toEqual({ render: [120, 72], display: [160, 96] })
    const view = d.views.find((v) => v.name === `camera:${cam}`)!
    expect(view.size).toEqual([160, 96])
    expect(view.renderSize).toEqual([120, 72])
    expect(world.resource(RenderScale).windowViews).toBe(1)
  })
})

describe('default MSAA and display density', () => {
  async function msaaOf(pixelRatio: number, extra: unknown[] = [], maxPixelRatio?: number) {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin(),
    )
    await app.init()
    const world = app.world
    if (maxPixelRatio !== undefined) world.resource(ViewSettings).msaaMaxPixelRatio = maxPixelRatio
    const target = new OffscreenTarget(gpu, { label: 'dense', width: 64, height: 64, pixelRatio })
    const ref = world.resource(RenderTargets).add(target, 'dense')
    const cam = world.spawn(
      [Camera3d, { target: ref as never }],
      Exposure,
      Transform,
      ...(extra as []),
    )
    app.update(1 / 60)
    const data = world.resource(Cameras).get(cam)!
    return { msaa: data.msaa, pixelRatio: data.pixelRatio }
  }

  it('skips the default 4× MSAA on a 2× display, keeps it at 1×', async () => {
    expect(await msaaOf(1)).toEqual({ msaa: 4, pixelRatio: 1 })
    expect(await msaaOf(2)).toEqual({ msaa: 1, pixelRatio: 2 })
  })

  it('lets an Antialiasing component or msaaMaxPixelRatio 0 keep MSAA', async () => {
    expect((await msaaOf(2, [[Antialiasing, { mode: 'msaa' }]])).msaa).toBe(4)
    expect((await msaaOf(2, [], 0)).msaa).toBe(4)
  })
})
