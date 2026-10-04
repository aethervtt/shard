import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetRef } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, plane } from '@aethervtt/shard-mesh'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Culler } from './culling'
import { Cutaway, CutawayView } from './cutaway'
import { captureShadowMap } from './debug-views'
import { forwardCorePlugin } from './forward'
import type { CapturedImage } from './graph'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight } from './lights'
import { pick } from './picking'
import { describeRender, Gpu, renderPlugin } from './plugin'
import { worldToScreen } from './projection'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'
import { RenderPath, Tonemapping } from './view'

// Cutaways (0070).

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const W = 96
const H = 96
/** World units across the top-down view (orthographic height). */
const SPAN = 12

interface Options {
  /** forwardCorePlugin alone: no cutawayPlugin. */
  core?: boolean
  /** Top-down orthographic (default), or a perspective view from 30° above the horizon. */
  view?: 'top' | '30'
  points?: [number, number, number][]
  radius?: number
  margin?: number
  edge?: number
  /** The floor is Cutaway too (the margin keeps it). */
  cutFloor?: boolean
  deferred?: boolean
  gpuCull?: boolean
}

/**
 * A green floor, a blue token on it at the origin, and a red roof 3 m up over all of it, tagged
 * Cutaway. One camera, with CutawayView points (the token's centre by default).
 */
async function scene(o: Options = {}) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    o.core ? forwardCorePlugin({ msaa: 1 }) : forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  if (o.gpuCull === false) world.resource(Culler).enabled = false
  const target = new OffscreenTarget(gpu, { label: 'cutaway', width: W, height: H })
  const ref = world.resource(RenderTargets).add(target, 'cutaway') as AssetRef<'RenderTarget'>
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const color = (c: [number, number, number]) =>
    materials.add(new MaterialAsset({ baseColor: [...c, 1], roughness: 1 }))
  const floor = world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 30 })) }],
    [MeshMaterial, { material: color([0.1, 0.8, 0.1]) }],
    Transform,
  )
  if (o.cutFloor) world.add(floor, Cutaway)
  const token = world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 0.6, y: 0.6, z: 0.6 })) }],
    [MeshMaterial, { material: color([0.1, 0.1, 0.9]) }],
    [Transform, { translation: [0, 0.3, 0] }],
  )
  const roof = world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 16 })) }],
    [MeshMaterial, { material: color([0.9, 0.1, 0.1]) }],
    [Transform, { translation: [0, 3, 0] }],
    Cutaway,
  )
  // Fill light, so what the roof shades still shows.
  Object.assign(world.resource(AmbientLight), { brightness: 1500 })
  const sun = world.spawn(
    [DirectionalLight, { illuminance: 20_000, shadows: true }],
    [Transform, { rotation: lookAt([-2, 8, 3], [0, 0, 0]) }],
  )
  const eye: [number, number, number] =
    o.view === '30' ? [0, 20 * Math.sin(Math.PI / 6), 20 * Math.cos(Math.PI / 6)] : [0, 20, 0.0001]
  const camera = world.spawn(
    [
      Camera3d,
      o.view === '30'
        ? { target: ref, fovY: 40 }
        : { target: ref, projection: 'orthographic', orthoHeight: SPAN, far: 100 },
    ],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0.3, 0]) }],
    [
      CutawayView,
      {
        points: o.points ?? [[0, 0.3, 0]],
        radius: o.radius ?? 2,
        margin: o.margin ?? 0.6,
        edge: o.edge ?? 0,
      },
    ],
  )
  if (o.deferred) world.add(camera, RenderPath, { mode: 'deferred' })
  await settle(app)
  return {
    app,
    world,
    camera,
    token,
    roof,
    floor,
    sun,
    view: `camera:${camera}`,
    async dispose() {
      await app.dispose()
      target.destroy()
    },
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

const isRed = (p: ArrayLike<number>) => p[0]! > p[1]! * 1.5 && p[0]! > p[2]! * 1.5
const isBlue = (p: ArrayLike<number>) => p[2]! > p[0]! * 1.5 && p[2]! > p[1]! * 1.2

/** The pixel a world point lands on. */
function at(s: Scene, image: CapturedImage, point: [number, number, number]) {
  const out = [0, 0]
  worldToScreen(s.world, s.camera, point, out)
  return pixel(image, Math.floor(out[0]!), Math.floor(out[1]!))
}

/** Pixels per metre in the top-down view. */
const PPM = H / SPAN

/** Of the pixels whose centres lie between r0 and r1 metres from the view's centre, the share that isn't roof. */
function openShare(image: CapturedImage, r0: number, r1: number): number {
  let open = 0
  let all = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const r = Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) / PPM
      if (r < r0 || r >= r1) continue
      all++
      if (!isRed(pixel(image, x, y))) open++
    }
  return open / all
}

/** Resolves picks, running frames until they land. */
async function resolve<T>(app: App, picks: Promise<T>[]): Promise<T[]> {
  let done = false
  const all = Promise.all(picks).finally(() => {
    done = true
  })
  for (let i = 0; i < 60 && !done; i++) {
    app.update(1 / 60)
    await app.world.resource(Gpu).pipelines.whenIdle()
    await new Promise((r) => setTimeout(r, 0))
  }
  return all
}

describe('cutaways', () => {
  it('opens a disc of radius over the token from above, keeping a Cutaway floor under it', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene({ cutFloor: true })
    const image = await renderView(s.app, s.view)
    expect(s.world.resource(Gpu).errors).toEqual([])
    expect(isBlue(at(s, image, [0, 0.6, 0]))).toBe(true)
    // Inside the radius the floor shows (the margin keeps it: it's behind the point); outside, roof.
    const floor = at(s, image, [1.4, 0, 0.3])
    expect(floor[1]!).toBeGreaterThan(floor[0]! * 1.5)
    expect(isRed(at(s, image, [2.6, 3, 0]))).toBe(true)
    expect(isRed(at(s, image, [0, 3, -2.6]))).toBe(true)
    // The hole's area is π r².
    let open = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!isRed(pixel(image, x, y))) open++
    const expected = Math.PI * (2 * PPM) ** 2
    expect(Math.abs(open - expected) / expected).toBeLessThan(0.1)
    expect(compareGolden(here, 'cutaway-top', image).mean).toBeLessThan(1.5)
    await s.dispose()
  })

  it('opens a hole along the line of sight at 30°', { timeout: timeout(60_000) }, async () => {
    const s = await scene({ view: '30' })
    const image = await renderView(s.app, s.view)
    expect(s.world.resource(Gpu).errors).toEqual([])
    // The roof between the camera and the token is gone: the token shows.
    expect(isBlue(at(s, image, [0, 0.5, 0.3]))).toBe(true)
    // Roof away from the line of sight stays.
    expect(isRed(at(s, image, [-4, 3, 0]))).toBe(true)
    expect(isRed(at(s, image, [4, 3, 0]))).toBe(true)
    expect(compareGolden(here, 'cutaway-30', image).mean).toBeLessThan(1.5)
    // Without reveal points the roof hides the token.
    s.world.set(s.camera, CutawayView, { points: [] })
    await settle(s.app, 4)
    const whole = await renderView(s.app, s.view)
    expect(isRed(at(s, whole, [0, 0.5, 0.3]))).toBe(true)
    await s.dispose()
  })

  for (const gpuCull of [true, false]) {
    it(`the shadow map is the same cut or whole: the room keeps the roof's shade (${gpuCull ? 'GPU' : 'CPU'} culling)`, {
      timeout: timeout(60_000),
    }, async () => {
      const s = await scene({ gpuCull })
      const cut = await captureShadowMap(s.world, s.sun, 0, s.camera)
      s.world.set(s.camera, CutawayView, { points: [] })
      await settle(s.app, 4)
      const whole = await captureShadowMap(s.world, s.sun, 0, s.camera)
      expect(Buffer.from(cut.data).equals(Buffer.from(whole.data))).toBe(true)
      // And the floor seen through the hole is in the roof's shadow: darker than the lit floor.
      s.world.set(s.camera, CutawayView, { points: [[0, 0.3, 0]] })
      s.world.set(s.roof, Transform, { translation: [0, 3, 0], scale: [0.5, 1, 0.5] })
      await settle(s.app, 4)
      const image = await renderView(s.app, s.view)
      const shaded = at(s, image, [1.2, 0, 1.2])
      const lit = at(s, image, [5.5, 0, 5.5])
      expect(shaded[1]!).toBeLessThan(lit[1]! * 0.8)
      await s.dispose()
    })
  }

  it('picks through the hole: the token, not the roof', { timeout: timeout(60_000) }, async () => {
    const s = await scene({ view: '30' })
    const tokenAt = [0, 0]
    worldToScreen(s.world, s.camera, [0, 0.5, 0.3], tokenAt)
    const roofAt = [0, 0]
    worldToScreen(s.world, s.camera, [-4, 3, 0], roofAt)
    const [through, beside] = await resolve(s.app, [
      pick(s.world, s.camera, tokenAt[0]!, tokenAt[1]!),
      pick(s.world, s.camera, roofAt[0]!, roofAt[1]!),
    ])
    expect(through?.entity).toBe(s.token)
    expect(beside?.entity).toBe(s.roof)
    expect(s.world.resource(Gpu).errors).toEqual([])
    await s.dispose()
  })

  it('cuts in deferred views too (the G-buffer, and the prepass that feeds it)', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene({ deferred: true })
    const image = await renderView(s.app, s.view)
    expect(s.world.resource(Gpu).errors).toEqual([])
    expect(isBlue(at(s, image, [0, 0.6, 0]))).toBe(true)
    expect(isRed(at(s, image, [2.6, 3, 0]))).toBe(true)
    await s.dispose()
  })

  it('dithers the rim: the cut share falls monotonically across the edge band', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene({ radius: 3, edge: 1.5, points: [[0, 0.3, 0]] })
    const image = await renderView(s.app, s.view)
    // The band runs from radius - edge (all cut) to radius (none).
    expect(openShare(image, 0.8, 1.4)).toBe(1)
    const shares: number[] = []
    for (let r = 1.5; r < 3; r += 0.25) shares.push(openShare(image, r, r + 0.25))
    for (let i = 1; i < shares.length; i++) expect(shares[i]!).toBeLessThanOrEqual(shares[i - 1]!)
    expect(shares[0]!).toBeGreaterThan(0.75)
    expect(shares[shares.length - 1]!).toBeLessThan(0.25)
    expect(openShare(image, 3.1, 4)).toBe(0)
    await s.dispose()
  })

  it('describes each camera, and warns once past 16 points', {
    timeout: timeout(60_000),
  }, async () => {
    const points: [number, number, number][] = []
    for (let i = 0; i < 18; i++) points.push([i - 9, 0.3, 0])
    const s = await scene({ points })
    for (let i = 0; i < 3; i++) s.app.update(1 / 60)
    const described = describeRender(s.world).cutaways as Record<
      string,
      { points: number[][]; ignored: number; radius: number }
    >
    expect(described[s.view]!.points.length).toBe(16)
    expect(described[s.view]!.ignored).toBe(2)
    const warned = s.world
      .resource(LogResource)
      .tail(200, 'warn')
      .filter((e) => e.code === 'render/too-many-reveal-points')
    expect(warned.length).toBe(1)
    expect(warned[0]!.message).toContain(String(s.camera))
    await s.dispose()
  })

  it('without cutawayPlugin: logs render/feature-missing once and draws whole', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene({ core: true })
    for (let i = 0; i < 3; i++) s.app.update(1 / 60)
    const image = await renderView(s.app, s.view)
    expect(s.world.resource(Gpu).errors).toEqual([])
    expect(isRed(at(s, image, [0, 3, 0]))).toBe(true)
    const missing = s.world
      .resource(LogResource)
      .tail(200, 'warn')
      .filter((e) => e.code === 'render/feature-missing' && e.message.includes('Cutaway'))
    expect(missing.length).toBe(1)
    expect(missing[0]!.hint).toContain('cutawayPlugin')
    await s.dispose()
  })

  it('a camera without CutawayView, or with no points, draws the plain variants', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene()
    s.world.remove(s.camera, CutawayView)
    await settle(s.app, 4)
    const image = await renderView(s.app, s.view)
    expect(isRed(at(s, image, [0, 3, 0]))).toBe(true)
    expect(s.world.resource(Gpu).errors).toEqual([])
    await s.dispose()
  })
})
