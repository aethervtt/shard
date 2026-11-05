import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Entity,
  Last,
  PostUpdate,
  ProfilerResource,
  quat,
  type World,
} from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import { createGpuContext, type GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { FakeGl } from '@aethervtt/shard-gpu-webgl2/testing'
import { box, plane } from '@aethervtt/shard-mesh'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import {
  Camera3d,
  type CameraData,
  Cameras,
  type CapturedBuffer,
  type CapturedImage,
  captureBuffer,
  captureView,
  DirectionalLight,
  DrivesView,
  describeRender,
  Exposure,
  Fog,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  ProceduralSky,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { compareGolden, settle, watchBaseline } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import {
  type HeightfieldRender,
  Terrain,
  TerrainSources,
  TerrainWorld,
  terrainPlugin,
} from '@aethervtt/shard-terrain'
import { sourceAsset } from '@aethervtt/shard-terrain/testing'
import { Grid, lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WaterBodies } from './bodies'
import { INFO_SNAP, levelTexel } from './clipmap'
import { WaterBody, WaterSpline } from './components'
import { readWaterInfo } from './debug'
import { type WaterOpticsPreset, waterOptics } from './optics'
import { waterPlugin } from './plugin'
import { waterAt, waterSample } from './query'
import { WaterRender } from './render'
import { INFO_LEVELS, INFO_SIZE } from './shaders'

const here = dirname(fileURLToPath(import.meta.url))
let gpu: GpuContext
let compat: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
  compat = await createNodeGpuContext({ tier: 'baseline' })
  await loadNoiseKernel()
})
afterAll(async () => {
  for (const g of [gpu, compat]) {
    await g?.device.queue.onSubmittedWorkDone()
    g?.destroy()
  }
})

type Vec3 = [number, number, number]

interface SceneOptions {
  width?: number
  height?: number
  msaa?: 1 | 4
  eye: Vec3
  at: Vec3
  fovY?: number
  /** The ocean at y 0 (default true). */
  ocean?: boolean
  /** A red box floating above the water, its centre here. */
  floating?: Vec3
  /** A beach sloping out of the water along +z, crossing y 0 at this z. */
  beach?: number
  /** A heightfield basin under the origin, with a lake at y 4 in it. */
  lake?: boolean
  shadows?: boolean
  fog?: boolean
  /** The ocean's optics (default ocean) and how deep its bed is (default 4 m). */
  optics?: WaterOpticsPreset
  bed?: number
  /** The camera shows on the window (its target null) instead of an offscreen target. */
  window?: boolean
}

/** The bowl the lake sits in: −6 m at the middle, rising to +12 m 100 m out. */
function basin() {
  const n = 64
  const data = new Float32Array(n * n)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      data[y * n + x] = Math.min(1, Math.hypot(x - 31.5, y - 31.5) / 25) ** 1.5
  return {
    source: {
      size: [256, 256],
      spacing: 1,
      heightRange: [-20, 30],
      seed: 3,
      height: [
        {
          image: { path: 'bowl' },
          at: [128, 128],
          size: [256, 256],
          rotation: 0,
          range: [-6, 12],
          blend: 'add',
          falloff: 0,
        },
      ],
      layers: [{ name: 'grass' }],
      paint: [{ layer: 'grass' }],
    },
    heightmaps: { bowl: { width: n, height: n, data } },
  }
}

const circle = (r: number, n = 16) =>
  Array.from({ length: n }, (_, i) => ({
    position: [r * Math.cos((i / n) * 2 * Math.PI), 0, r * Math.sin((i / n) * 2 * Math.PI)] as Vec3,
    width: 0,
    depth: 0,
    flow: 0,
  }))

async function scene(g: GpuContext, o: SceneOptions) {
  const target = new OffscreenTarget(g, {
    label: 'water',
    width: o.width ?? 160,
    height: o.height ?? 96,
  })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu: g, windowView: false, ...(o.window ? { target } : {}) }),
    forwardPlugin({ msaa: o.msaa ?? 4 }),
  )
  if (o.lake) app.addPlugin(terrainPlugin())
  app.addPlugin(waterPlugin())
  await app.init()
  const world = app.world
  const targetRef = o.window ? null : world.resource(RenderTargets).add(target, 'water')
  world.resource(Wind).speed = 7
  world.spawn(
    [DirectionalLight, { illuminance: 80_000, shadows: o.shadows ?? true }],
    [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.6, 2.4, 0) as never }],
  )
  const camera = world.spawn(
    [Camera3d, { target: targetRef, fovY: o.fovY ?? 55, near: 0.1, far: 0 }],
    [Exposure, { ev100: 14 }],
    [Tonemapping, { curve: 'agx', dither: false }],
    [ProceduralSky, { turbidity: 2.5 }],
    ...(o.fog ? [[Fog, { density: 0.004, heightFalloff: 0 }] as const] : []),
    [Transform, { translation: o.eye, rotation: lookAt(o.eye, o.at) }],
  )
  const materials = world.resource(Materials)
  const meshes = world.resource(Meshes)
  const sand = materials.add(new MaterialAsset({ baseColor: [0.76, 0.66, 0.45, 1], roughness: 1 }))
  if (!o.lake) {
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 600 })) }],
      [MeshMaterial, { material: sand }],
      [Transform, { translation: [0, -(o.bed ?? 4), 0] }],
    )
  }
  if (o.beach !== undefined) {
    // 1 in 10: the beach rises 0.1 m a metre out of the water.
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 200 })) }],
      [MeshMaterial, { material: sand }],
      [
        Transform,
        {
          translation: [0, 0, o.beach],
          rotation: quat.fromEuler([0, 0, 0, 1], -Math.atan(0.1), 0, 0) as never,
        },
      ],
    )
  }
  let floating: Entity | undefined
  if (o.floating) {
    // Bright: if any of it leaked into the water, it would show through clear water.
    const lamp = materials.add(
      new MaterialAsset({
        baseColor: [0, 0, 0, 1],
        emissive: [1, 0.45, 0.05, 1],
        emissiveLuminance: 40_000,
      }),
    )
    floating = world.spawn(
      [Mesh3d, { mesh: meshes.add(box()) }],
      [MeshMaterial, { material: lamp }],
      [Transform, { translation: o.floating, scale: [2, 1, 2] }],
    )
  }
  let terrain: Entity | undefined
  if (o.lake) {
    const asset = sourceAsset(world, basin())
    const ref = world.initResource(TerrainSources).add(asset, 'basin.terrain.json')
    terrain = world.spawn(
      [Grid, { cellSize: 2000 }],
      [Terrain, { source: ref, errorPixels: 1 }],
      [Transform, { translation: [-128, 0, -128] }],
    )
    world.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('lake'), priority: 1 }],
      [WaterSpline, { points: circle(85) }],
      [Transform, { translation: [0, 4, 0] }],
    )
  }
  if (o.ocean !== false)
    world.spawn([WaterBody, { kind: 'ocean', optics: waterOptics(o.optics ?? 'ocean') }], Transform)
  return { app, world, camera, terrain, floating, view: `camera:${camera}` }
}

type Scene = Awaited<ReturnType<typeof scene>>

/** Runs until the terrain streams, then settles. */
async function ready(s: Scene) {
  if (s.terrain !== undefined) {
    const start = performance.now()
    for (;;) {
      s.app.update(1 / 60)
      const rt = s.world.resource(TerrainWorld).heightfields.get(s.terrain)
      if (rt?.problem) throw rt.problem
      if (rt?.streaming) break
      if (performance.now() - start > 60_000) throw new Error('terrain never streamed')
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  await settle(s.app, 80)
  // The ground fills over a few frames; let it finish.
  for (let i = 0; i < 12; i++) s.app.update(1 / 60)
  await settle(s.app)
}

async function shot(s: Scene): Promise<CapturedImage> {
  const image = captureView(s.world, s.view)
  s.app.update(1 / 60)
  return image
}

async function buffer(s: Scene, name: string): Promise<CapturedBuffer> {
  const b = captureBuffer(s.world, s.view, name)
  s.app.update(1 / 60)
  return (await b) as CapturedBuffer
}

function problems(world: World) {
  return world
    .resource(LogResource)
    .tail(500, 'warn')
    .map((e) => `${e.code ?? ''} ${e.message}`)
}

function orderOf(s: Scene): string[] {
  return (describeRender(s.world) as { perView: Record<string, { order: string[] }> }).perView[
    s.view
  ]!.order
}

/** Where a pixel's ray meets the plane y = h: the point, its reversed-Z depth, and its distance. */
function onPlane(
  cam: CameraData,
  px: number,
  py: number,
  w: number,
  h: number,
  y: number,
  ox = 0.5,
  oy = 0.5,
) {
  const m = cam.invViewProj
  const ndc = [((px + ox) / w) * 2 - 1, 1 - ((py + oy) / h) * 2]
  const un = (z: number) => {
    const v = [0, 1, 2, 3].map(
      (r) => m[r]! * ndc[0]! + m[4 + r]! * ndc[1]! + m[8 + r]! * z + m[12 + r]!,
    )
    return [v[0]! / v[3]!, v[1]! / v[3]!, v[2]! / v[3]!]
  }
  const a = un(1)
  const b = un(0.5)
  const t = (y - a[1]!) / (b[1]! - a[1]!)
  if (!(t > 0)) return undefined
  const p = [a[0]! + (b[0]! - a[0]!) * t, y, a[2]! + (b[2]! - a[2]!) * t]
  const vp = cam.viewProj
  const clip = [0, 1, 2, 3].map(
    (r) => vp[r]! * p[0]! + vp[4 + r]! * p[1]! + vp[8 + r]! * p[2]! + vp[12 + r]!,
  )
  const e = cam.position
  return {
    point: p,
    depth: clip[2]! / clip[3]!,
    distance: Math.hypot(p[0]! - e[0]!, p[1]! - e[1]!, p[2]! - e[2]!),
  }
}

/**
 * Whether a depth lies within the plane's depths across the pixel: a resolved MSAA depth is one
 * sample's, not the centre's.
 */
function onPlaneInPixel(
  cam: CameraData,
  px: number,
  py: number,
  w: number,
  h: number,
  depth: number,
): boolean {
  let lo = Infinity
  let hi = -Infinity
  for (const [ox, oy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const d = onPlane(cam, px, py, w, h, 0, ox, oy)?.depth
    if (d === undefined) return false
    lo = Math.min(lo, d)
    hi = Math.max(hi, d)
  }
  return depth >= lo * (1 - 1e-4) && depth <= hi * (1 + 1e-4)
}

describe('the water pass (0097)', () => {
  it('adds no passes without a body', { timeout: timeout(60_000) }, async () => {
    const s = await scene(gpu, { eye: [0, 3, -30], at: [0, 0, 10], ocean: false })
    await ready(s)
    await shot(s)
    const order = orderOf(s)
    for (const node of ['water', 'water/info', 'water/depth', 'opaque-copy'])
      expect(order).not.toContain(node)
    s.world.spawn([WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }], Transform)
    await ready(s)
    await shot(s)
    expect(orderOf(s)).toEqual(expect.arrayContaining(['water/info', 'opaque-copy', 'water']))
    expect(problems(s.world)).toEqual([])
    await s.app.dispose()
  })

  it('never shows objects above the water in its refraction, at a grazing angle (golden)', {
    timeout: timeout(60_000),
  }, async () => {
    const view = {
      eye: [0, 1.4, -9] as Vec3,
      at: [0, 0.3, 4] as Vec3,
      shadows: false,
      optics: 'clear' as const,
      bed: 1,
    }
    const W = 480
    const H = 270
    // One app, three frames at the same wind time: without the box, and with it glowing in two
    // colors. The two box frames are the same geometry, so every filtering and rejection decision
    // is the same in both: a water pixel whose color differs between them sees the box's light.
    const s = await scene(gpu, { ...view, width: W, height: H, floating: [0, 0.6, 0], fog: true })
    await ready(s)
    const still = async <T>(p: Promise<T>) => {
      s.app.runSchedule(PostUpdate)
      s.app.runSchedule(Last)
      return p
    }
    const glow = (emissive: [number, number, number, number]) =>
      s.world
        .resource(Materials)
        .add(new MaterialAsset({ baseColor: [0, 0, 0, 1], emissive, emissiveLuminance: 40_000 }))
    const amber = s.world.get(s.floating!, MeshMaterial).material
    const cyan = glow([0.1, 0.8, 1, 1])
    await settle(s.app)
    const amberImage = await still(captureView(s.world, s.view))
    const boxDepth = (await still(captureBuffer(s.world, s.view, 'depth'))) as CapturedBuffer
    // The same pipeline: no settling (which would move the wind clock), just a frame to upload it.
    s.world.set(s.floating!, MeshMaterial, { material: cyan })
    await still(Promise.resolve())
    const cyanImage = await still(captureView(s.world, s.view))
    s.world.despawn(s.floating!)
    const plainDepth = (await still(captureBuffer(s.world, s.view, 'depth'))) as CapturedBuffer
    expect(amber).toBeDefined()
    expect(problems(s.world)).toEqual([])
    await s.app.dispose()
    expect(compareGolden(here, 'refraction-grazing', amberImage).mean).toBeLessThan(1.5)
    // The box's pixels (depth moved nearer), grown by a pixel for MSAA edges.
    const near = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++)
      if (boxDepth.data[i * 4]! > plainDepth.data[i * 4]! + 1e-6) near[i] = 1
    const grown = new Uint8Array(W * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && near[yy * W + xx]) grown[y * W + x] = 1
          }
    let water = 0
    let worst = 0
    let leaks = 0
    for (let i = 0; i < W * H; i++) {
      if (grown[i] || plainDepth.data[i * 4]! <= 0) continue
      water++
      let d = 0
      for (let c = 0; c < 3; c++)
        d = Math.max(d, Math.abs(amberImage.data[i * 4 + c]! - cyanImage.data[i * 4 + c]!))
      worst = Math.max(worst, d)
      if (d >= 3) leaks++
    }
    console.log(
      `refraction: ${water} water pixels around the box, worst change with its color ${worst}, ${leaks} pixels changed`,
    )
    expect(water).toBeGreaterThan(W * H * 0.3)
    expect(leaks).toBe(0)
  })

  it('fades into the shore with no edge, and writes its own depth for fog (golden)', {
    timeout: timeout(60_000),
  }, async () => {
    const W = 480
    const H = 270
    const view = { eye: [0, 4, 2] as Vec3, at: [0, 0, 11] as Vec3, beach: 10 }
    const images: CapturedImage[] = []
    const depths: CapturedBuffer[] = []
    let cam: CameraData | undefined
    for (const ocean of [false, true]) {
      const s = await scene(gpu, { ...view, width: W, height: H, ocean, shadows: false, fog: true })
      await ready(s)
      images.push(await shot(s))
      depths.push(await buffer(s, 'depth'))
      cam = s.world.resource(Cameras).get(s.camera)
      expect(problems(s.world)).toEqual([])
      await s.app.dispose()
    }
    const [dry, wet] = images as [CapturedImage, CapturedImage]
    expect(compareGolden(here, 'shore', wet).mean).toBeLessThan(1.5)
    // Over the beach: is the water there as thin as the ground says (no visible edge)?
    let thin = 0
    let thinDiff = 0
    let surfaced = 0
    const misses: string[] = []
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const i = py * W + px
        const hit = onPlane(cam!, px, py, W, H, 0)
        const ground = depths[0]!.data[i * 4]!
        if (!hit || ground <= 0 || ground >= hit.depth) continue
        // The water's depth replaced the ground's wherever it's in front: fog reads this.
        if (!onPlaneInPixel(cam!, px, py, W, H, depths[1]!.data[i * 4]!)) {
          misses.push(`(${px}, ${py}): ${depths[1]!.data[i * 4]} for ${hit.depth}`)
        }
        surfaced++
        // Water along this ray before the ground (reversed Z: distance ∝ 1 / depth).
        const thickness = hit.distance * (hit.depth / ground) - hit.distance
        if (thickness > 0.05) continue
        thin++
        for (let c = 0; c < 3; c++)
          thinDiff = Math.max(thinDiff, Math.abs(wet.data[i * 4 + c]! - dry.data[i * 4 + c]!))
      }
    }
    console.log(
      `shore: ${surfaced} water pixels, ${thin} under 5 cm of water, worst difference there ${thinDiff}`,
    )
    expect(misses.slice(0, 5)).toEqual([])
    expect(surfaced).toBeGreaterThan(W * H * 0.2)
    expect(thin).toBeGreaterThan(10)
    expect(thinDiff).toBeLessThan(8)
  })

  it('matches waterAt within 1 cm at 1 000 texels of the info texture, over a heightfield lake', {
    timeout: timeout(120_000),
  }, async () => {
    const s = await scene(gpu, { eye: [0, 30, -140], at: [0, 0, 0], lake: true })
    await ready(s)
    const levels = await readWaterInfo(s.world)
    expect(levels).toHaveLength(INFO_LEVELS)
    const clip = s.world.resource(WaterRender).clip
    let seed = 11
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    const sample = waterSample()
    let worst = 0
    let wet = 0
    let lake = 0
    let groundKnown = 0
    let groundWorst = 0
    const mismatches: string[] = []
    for (let k = 0; k < 1000; k++) {
      // Half around the lake at the finest level, the rest anywhere on any level.
      const l = k < 500 ? 0 : Math.floor(rand() * INFO_LEVELS)
      const t = levelTexel(l)
      let x: number
      let y: number
      if (k < 500) {
        const cx = Math.floor(-clip.corner(0, 0) / t)
        const cz = Math.floor(-clip.corner(0, 1) / t)
        x = Math.min(INFO_SIZE - 1, Math.max(0, cx - 30 + Math.floor(rand() * 60)))
        y = Math.min(INFO_SIZE - 1, Math.max(0, cz - 30 + Math.floor(rand() * 60)))
      } else {
        x = Math.floor(rand() * INFO_SIZE)
        y = Math.floor(rand() * INFO_SIZE)
      }
      const wx = clip.corner(l, 0) + (x + 0.5) * t
      const wz = clip.corner(l, 1) + (y + 0.5) * t
      const o = (y * INFO_SIZE + x) * 4
      const surface = levels[l]![o]!
      const ground = levels[l]![o + 1]!
      waterAt(s.world, [wx, 0, wz], sample)
      const gpuWet = surface > -1e8
      if (gpuWet !== (sample.body !== null)) {
        mismatches.push(`level ${l} (${wx}, ${wz}): gpu ${surface}, cpu ${sample.surfaceHeight}`)
        continue
      }
      if (gpuWet) {
        wet++
        if (sample.surfaceHeight === 4) lake++
        worst = Math.max(worst, Math.abs(surface - sample.surfaceHeight))
      }
      if (ground > -1e8) {
        groundKnown++
        groundWorst = Math.max(groundWorst, Math.abs(ground - sample.groundHeight))
      }
    }
    console.log(
      `info vs waterAt: ${wet} wet texels (${lake} lake), worst surface ${worst.toExponential(2)} m; ground at ${groundKnown}, worst ${groundWorst.toFixed(3)} m; ${mismatches.length} wet/dry mismatches`,
    )
    expect(mismatches).toEqual([])
    expect(lake).toBeGreaterThan(100)
    expect(wet - lake).toBeGreaterThan(100)
    expect(worst).toBeLessThan(0.01)
    expect(groundKnown).toBeGreaterThan(200)
    expect(s.world.resource(WaterBodies).count).toBe(2)
    expect(problems(s.world)).toEqual([])
    await s.app.dispose()
  })

  it('keeps terrain selection and the info clipmap on the window camera while a thumbnail renders', {
    timeout: timeout(120_000),
  }, async () => {
    const eye: Vec3 = [0, 30, -140]
    const s = await scene(gpu, { eye, at: [0, 0, 0], lake: true, window: true })
    // A game's thumbnail camera: offscreen, an earlier order, its own layer, 4 km away. With only
    // the required components, its table comes before the main camera's in a query.
    const thumbnails = new OffscreenTarget(gpu, { label: 'thumbnail', width: 32, height: 32 })
    const thumbnail = s.world.spawn(
      [
        Camera3d,
        {
          target: s.world.resource(RenderTargets).add(thumbnails, 'thumbnail'),
          order: -10,
          layers: 2,
        },
      ],
      Exposure,
      [Transform, { translation: [4000, 30, 0] }],
    )
    const drivenBy = () => {
      const rt = s.world.resource(TerrainWorld).heightfields.get(s.terrain!)!
      const terrain = (rt.parts.get('render') as HeightfieldRender).camera
      const clip = s.world.resource(WaterRender).clip
      const half = (INFO_SIZE / 2) * levelTexel(0)
      return {
        terrain: [terrain[0]!, terrain[2]!],
        // The centre of the finest level's window, which moves in steps of INFO_SNAP texels.
        water: [clip.corner(0, 0) + half, clip.corner(0, 1) + half],
      }
    }
    await ready(s)
    const near = (v: number[], x: number, z: number) =>
      Math.abs(v[0]! - x) <= INFO_SNAP * levelTexel(0) &&
      Math.abs(v[1]! - z) <= INFO_SNAP * levelTexel(0)
    let driven = drivenBy()
    expect(near(driven.terrain, eye[0], eye[2]), `terrain at ${driven.terrain}`).toBe(true)
    expect(near(driven.water, eye[0], eye[2]), `water at ${driven.water}`).toBe(true)
    // Showing layer 1 too, it still renders offscreen: the window camera keeps driving.
    s.world.set(thumbnail, Camera3d, { layers: 0xffff })
    for (let i = 0; i < 3; i++) s.app.update(1 / 60)
    driven = drivenBy()
    expect(near(driven.terrain, eye[0], eye[2]), `terrain at ${driven.terrain}`).toBe(true)
    expect(near(driven.water, eye[0], eye[2]), `water at ${driven.water}`).toBe(true)
    // A minimap that's a real view opts in with DrivesView, and its earlier order wins.
    s.world.add(thumbnail, DrivesView)
    for (let i = 0; i < 3; i++) s.app.update(1 / 60)
    driven = drivenBy()
    expect(near(driven.terrain, 4000, 0), `terrain at ${driven.terrain}`).toBe(true)
    expect(near(driven.water, 4000, 0), `water at ${driven.water}`).toBe(true)
    expect(problems(s.world)).toEqual([])
    await s.app.dispose()
  })

  it('shades a heightfield lake whose shore fades into the ground (golden), within gpu:water at 1080p', {
    timeout: timeout(120_000),
  }, async () => {
    const view = { eye: [0, 8.5, -80] as Vec3, at: [25, 2, -40] as Vec3, lake: true }
    const s = await scene(gpu, { ...view, width: 1920, height: 1080 })
    await ready(s)
    for (let i = 0; i < 30; i++) {
      s.app.update(1 / 60)
      await s.world.resource(Gpu).pipelines.whenIdle()
    }
    await new Promise((r) => setTimeout(r, 50))
    s.app.update(1 / 60)
    const gpuMs = s.world.resource(ProfilerResource).timing('gpu:water')?.avg ?? null
    console.log(`gpu:water at 1920×1080: ${gpuMs?.toFixed(3) ?? 'no timestamps'} ms`)
    if (gpuMs !== null) expect(gpuMs).toBeLessThan(budget('gpu:water'))
    await s.app.dispose()
    const small = await scene(gpu, { ...view, width: 240, height: 135 })
    await ready(small)
    expect(compareGolden(here, 'lake-shore', await shot(small)).mean).toBeLessThan(1.5)
    expect(problems(small.world)).toEqual([])
    await small.app.dispose()
  })
})

describe('the water pass on the baseline tier (0064)', () => {
  for (const msaa of [4, 1] as const) {
    it(`draws, and writes its depth where fog reads it, with MSAA ${msaa}`, {
      timeout: timeout(60_000),
    }, async () => {
      const W = 160
      const H = 96
      const watch = watchBaseline(compat)
      const s = await scene(compat, {
        eye: [0, 2.5, -8],
        at: [0, 0, 12],
        beach: 10,
        width: W,
        height: H,
        msaa,
        fog: true,
      })
      await ready(s)
      const image = await shot(s)
      const depth = await buffer(s, 'depth')
      const cam = s.world.resource(Cameras).get(s.camera)!
      let checked = 0
      const misses: string[] = []
      for (let py = H / 2; py < H; py += 7) {
        for (let px = 3; px < W; px += 11) {
          const hit = onPlane(cam, px, py, W, H, 0)
          if (!hit) continue
          // Over the beach's dry part the ground is in front; elsewhere the water is.
          const z = depth.data[(py * W + px) * 4]!
          if (z > hit.depth * 1.05) continue
          if (!onPlaneInPixel(cam, px, py, W, H, z))
            misses.push(`(${px}, ${py}): ${z} for ${hit.depth}`)
          checked++
        }
      }
      expect(misses.slice(0, 5)).toEqual([])
      expect(checked).toBeGreaterThan(20)
      const order = orderOf(s)
      expect(order).toEqual(expect.arrayContaining(['opaque-copy', 'water']))
      // Dawn's compatibility adapter may not multisample rgba16float (hdrSampleCount 1); the
      // prepass path is the WebGL2 test's below.
      expect(order.includes('water/depth')).toBe(cam.msaa > 1)
      expect(watch.computePasses).toBe(0)
      expect(watch.renderStorage).toEqual([])
      expect(compareGolden(here, `baseline-shore-x${msaa}`, image).mean).toBeLessThan(1.5)
      expect(problems(s.world)).toEqual([])
      await s.app.dispose()
    })
  }
})

describe('the water pass on WebGL2 (0064)', () => {
  it('translates every water shader with naga, and draws the surface into the depth prepass with MSAA', {
    timeout: timeout(60_000),
  }, async () => {
    // The shim over a fake context: nothing rasterizes, but every pipeline links through naga's
    // GLSL ES 3.00 and every draw's state is recorded.
    const fake = new FakeGl()
    const gl = await createGpuContext({
      backend: 'webgl2',
      webgl2: { context: fake.context, persist: false },
    })
    try {
      const s = await scene(gl, {
        eye: [0, 2.5, -8],
        at: [0, 0, 12],
        beach: 10,
        msaa: 4,
        fog: true,
      })
      await ready(s)
      await shot(s)
      const cam = s.world.resource(Cameras).get(s.camera)!
      expect(cam.msaa).toBe(4)
      const order = orderOf(s)
      for (const node of ['depth-prepass', 'opaque-copy', 'water/info', 'water', 'water/depth'])
        expect(order).toContain(node)
      // The copy reads the prepass, then the surface writes over it.
      expect(order.indexOf('depth-prepass')).toBeLessThan(order.indexOf('opaque-copy'))
      expect(order.indexOf('opaque-copy')).toBeLessThan(order.indexOf('water/depth'))
      expect(gl.errors).toEqual([])
      expect(problems(s.world)).toEqual([])
      await s.app.dispose()
    } finally {
      gl.destroy()
    }
  })
})

export async function sceneForLook(g: GpuContext, o: SceneOptions) {
  const s = await scene(g, o)
  await ready(s)
  return s
}
