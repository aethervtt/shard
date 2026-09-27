import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer, findAssetPreview } from '@aethervtt/shard-assets'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import {
  Camera3d,
  captureView,
  describeRender,
  forwardPlugin,
  Gpu,
  Graph,
  OffscreenTarget,
  RenderTargets,
  readBuffer,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { compareGolden, pngBytes, settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TextureAtlases } from './atlas'
import { Lighting2d, LightOccluder2d, PointLight2d, SpotLight2d, SpriteLighting } from './lighting'
import {
  binLightsCpu,
  LIGHT2D_FLOATS,
  Lights2d,
  lightCircle,
  SEGMENT_FLOATS,
  SHADOW_RES,
  shadowFactorCpu,
  shadowRowCpu,
  TILE_MAX,
  TILE_STRIDE,
} from './lights2d'
import { spritePlugin } from './plugin'
import { Sprites } from './render'
import { Sprite } from './sprite'
import { setTile, Tilemap, TilemapData, TilemapDatas } from './tilemap'
import './index'

const here = dirname(fileURLToPath(import.meta.url))

describe('2D lighting on the CPU', () => {
  it('projects light circles into pixels and culls those off screen', () => {
    // An orthographic view 10 units tall over 100 × 100 pixels, centered on the origin.
    const vp = new Float32Array([0.2, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, -0.01, 0, 0, 0, 0.5, 1])
    const out = new Float32Array(4)
    expect(lightCircle(vp, 100, 100, 0, 0, 0, 2, out, 0)).toBe(true)
    expect([...out.subarray(0, 3)].map((v) => Math.round(v * 1000) / 1000)).toEqual([50, 50, 20])
    expect(lightCircle(vp, 100, 100, 4, 4, 0, 1, out, 0)).toBe(true)
    expect([out[0], out[1]].map((v) => Math.round(v!))).toEqual([90, 10])
    // 3 units past the right edge with a radius of 2: culled.
    expect(lightCircle(vp, 100, 100, 8, 0, 0, 2, out, 0)).toBe(false)
  })

  it('bins lights into 16-pixel tiles with a full count past the cap', () => {
    const circles = new Float32Array(4 * 70)
    // One light covering everything, one in the top-left tile only, then 68 over tile (2, 2).
    circles.set([32, 32, 100, 0, 4, 4, 3, 0])
    for (let i = 2; i < 70; i++) circles.set([40, 40, 4, 0], i * 4)
    const { counts, indices } = binLightsCpu(circles, 70, 4, 4)
    expect(counts[0]).toBe(2)
    expect([indices[0], indices[1]]).toEqual([0, 1])
    expect(counts[1]).toBe(1)
    expect(counts[2 * 4 + 2]).toBe(69)
    expect(indices[(2 * 4 + 2) * TILE_MAX + TILE_MAX - 1]).toBe(TILE_MAX)
  })

  it('shadows what is behind a segment, with penetration, and widens soft penumbras with distance', () => {
    // A vertical wall from (2, -1) to (2, 1) in front of a light at the origin.
    const segs = new Float32Array(SEGMENT_FLOATS)
    segs.set([2, -1, 2, 1, 0.1])
    new Uint32Array(segs.buffer)[5] = 0xffffffff
    const row = shadowRowCpu(0, 0, 10, 0xffffffff, segs, 1, new Float32Array(SHADOW_RES))
    // Straight ahead: 2 units plus the penetration.
    const ahead = row[SHADOW_RES / 2]!
    expect(ahead).toBeCloseTo(2.1, 4)
    // Behind the wall is dark; in front and to the side are lit.
    expect(shadowFactorCpu(row, 0, 5, 1, 0)).toBe(0)
    expect(shadowFactorCpu(row, 0, 1.5, 1, 0)).toBe(1)
    expect(shadowFactorCpu(row, 0, 5, 0, 1)).toBe(1)
    // The wall's own face (2.05 from the light) stays lit.
    expect(shadowFactorCpu(row, 0, 2.05, 1, 0)).toBe(1)
    // A different layer passes through.
    expect(shadowRowCpu(0, 0, 10, 0, segs, 1, new Float32Array(SHADOW_RES))[SHADOW_RES / 2]).toBe(
      3.4028234663852886e38,
    )
    // Soft: count partly lit samples across the shadow's edge at two distances.
    const penumbra = (d: number) => {
      let n = 0
      for (let k = -400; k <= 400; k++) {
        const y = (k / 400) * d
        const f = shadowFactorCpu(row, 0.5, Math.hypot(d, y), d, y)
        if (f > 0.05 && f < 0.95) n++
      }
      return (n / 800) * 2 * d
    }
    expect(penumbra(8)).toBeGreaterThan(penumbra(3) * 1.5)
  })
})

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

async function scene(width = 96, height = 96, root?: string) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    spritePlugin,
  )
  await app.init()
  if (root) {
    const report = await assetServer(app.world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
      .scan()
    if (report.failed.length) throw new Error(JSON.stringify(report.failed))
  }
  const target = new OffscreenTarget(gpu, { label: 'lights2d', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'lights2d')
  const camera = (height = 10, lighting?: Record<string, unknown>) =>
    app.world.spawn(
      [
        Camera3d,
        {
          projection: 'orthographic',
          orthoHeight: height,
          target: targetRef as never,
          clearColor: [0, 0, 0, 1],
        },
      ],
      [Tonemapping, { curve: 'none', dither: false }],
      [Transform, { translation: [0, 0, 100] }],
      ...((lighting ? [[Lighting2d, lighting]] : []) as []),
    )
  return { app, world: app.world, camera }
}

type World = Awaited<ReturnType<typeof scene>>['world']

function solid(world: World, rgba: number[], size = 4) {
  const data = new Uint8Array(size * size * 4)
  for (let p = 0; p < size * size; p++) data.set(rgba, p * 4)
  return world.resource(Textures).add(Texture.create({ width: size, height: size, mips: [data] }))
}

/** A hemisphere normal map: normals tilt outward toward the edge (+Y up). */
function dome(world: World, size = 32) {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) / size) * 2 - 1
      const ny = 1 - ((y + 0.5) / size) * 2
      const r2 = Math.min(0.95, nx * nx + ny * ny)
      const l = Math.hypot(nx, ny) || 1
      const s = Math.sqrt(r2)
      const n = [(nx / l) * s, (ny / l) * s, Math.sqrt(1 - r2)]
      data.set([...n.map((v) => Math.round((v * 0.5 + 0.5) * 255)), 255], (y * size + x) * 4)
    }
  }
  return world
    .resource(Textures)
    .add(Texture.create({ width: size, height: size, usage: 'normal', mips: [data] }))
}

async function shot(app: App, view: string) {
  await settle(app)
  const s = captureView(app.world, view)
  app.update(1 / 60)
  return s
}

const at = (image: { width: number; data: Uint8Array }, x: number, y: number) => [
  ...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
]
const lum = (p: number[]) => (p[0]! + p[1]! + p[2]!) / 3
const toLinear = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const toSrgb = (v: number) =>
  Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055))

describe('2D lighting', () => {
  it('costs nothing without a Lighting2d camera: same pixels, no pass, no uploads', async () => {
    const { app, world, camera } = await scene(32, 32)
    const tex = solid(world, [200, 150, 100, 255])
    world.spawn([Sprite, { texture: tex, size: [20, 20] }], [Transform, {}])
    world.spawn([PointLight2d, { intensity: 3, shadows: true }], [Transform, {}])
    world.spawn([LightOccluder2d, { shape: 'box' }], [Transform, { translation: [1, 0, 0] }])
    const cam = camera(10)
    const image = await shot(app, `camera:${cam}`)
    expect(at(image, 16, 16)).toEqual([200, 150, 100])
    expect(world.tryResource(Lights2d)?.views.size ?? 0).toBe(0)
    const graph = world.resource(Graph).describe()
    expect(graph.perView[`camera:${cam}`]!.order).not.toContain('sprites/lights2d')
    expect((describeRender(world).sprites as { lighting?: unknown }).lighting).toBeUndefined()
    // Same draw count as a scene without the light and occluder.
    expect(world.resource(Sprites).runCount).toBe(1)
  })

  it('shows a sprite at its texture color under a light of intensity 1, and at ambient at its radius', async () => {
    const { app, world, camera } = await scene(100, 100)
    const albedo = [200, 150, 100]
    const tex = solid(world, [...albedo, 255])
    world.spawn([Sprite, { texture: tex, size: [10, 10] }], [Transform, {}])
    world.spawn(
      [PointLight2d, { radius: 3, intensity: 1 }],
      [Transform, { translation: [-2, 0, 0] }],
    )
    // A spot at the top right aiming +X, and a light on layers the sprite isn't in.
    world.spawn(
      [SpotLight2d, { radius: 3, innerAngle: 10, outerAngle: 20 }],
      [Transform, { translation: [1, 3, 0] }],
    )
    world.spawn(
      [PointLight2d, { radius: 3, layers: 0x80000000 }],
      [Transform, { translation: [2.5, -2.5, 0] }],
    )
    const cam = camera(10, { ambient: [0.25, 0.25, 0.25, 1] })
    const image = await shot(app, `camera:${cam}`)
    // Center of the light: albedo × (ambient + 1). With ambient 0.25 that's 1.25×, so compare
    // against the ambient-free value by subtracting the ambient share.
    const center = at(image, 30, 50)
    const expected = albedo.map((v) => toSrgb(toLinear(v) * 1.25))
    for (let k = 0; k < 3; k++) expect(Math.abs(center[k]! - expected[k]!)).toBeLessThanOrEqual(1)
    // At and past the radius: ambient only.
    const ambient = albedo.map((v) => toSrgb(toLinear(v) * 0.25))
    const far = at(image, 30 + 31, 50)
    for (let k = 0; k < 3; k++) expect(Math.abs(far[k]! - ambient[k]!)).toBeLessThanOrEqual(1)
    // The spot lights ahead of it, not behind; the masked light lights nothing.
    expect(lum(at(image, 70, 20))).toBeGreaterThan(lum(ambient) + 20)
    expect(Math.abs(lum(at(image, 50, 20)) - lum(ambient))).toBeLessThanOrEqual(1)
    expect(Math.abs(lum(at(image, 75, 75)) - lum(ambient))).toBeLessThanOrEqual(1)
    expect(world.resource(LogResource).errors()).toEqual([])

    // Ambient off: the light's center shows the texture color exactly (within one level).
    world.set(cam, Lighting2d, { ambient: [0, 0, 0, 1] })
    const dark = await shot(app, `camera:${cam}`)
    const c2 = at(dark, 30, 50)
    for (let k = 0; k < 3; k++) expect(Math.abs(c2[k]! - albedo[k]!)).toBeLessThanOrEqual(1)
    expect(at(dark, 30 + 31, 50)).toEqual([0, 0, 0])
  })

  it('lights a normal-mapped sprite from the side, and a flipped one from the same side (golden image)', async () => {
    const { app, world, camera } = await scene(128, 64)
    const tex = solid(world, [220, 220, 220, 255])
    const normal = dome(world)
    for (const [x, flipX] of [
      [-2.5, false],
      [2.5, true],
    ] as const) {
      world.spawn(
        [Sprite, { texture: tex, size: [4, 4], flipX }],
        [SpriteLighting, { normal }],
        [Transform, { translation: [x, 0, 0] }],
      )
    }
    world.spawn(
      [PointLight2d, { radius: 40, height: 0.3, falloff: 1, intensity: 1.5 }],
      [Transform, { translation: [-14, 0, 0] }],
    )
    const cam = camera(8, { ambient: [0.05, 0.05, 0.05, 1] })
    const image = await shot(app, `camera:${cam}`)
    expect(compareGolden(here, 'lights2d-normals', image).mean).toBeLessThan(1.5)
    // 8 pixels per unit: sprite centers at x = 44 and 84, each 32 wide.
    for (const cx of [44, 84]) {
      const left = lum(at(image, cx - 10, 32))
      const right = lum(at(image, cx + 10, 32))
      expect(left, `sprite at ${cx}`).toBeGreaterThan(right + 40)
    }
    expect(world.resource(Gpu).errors).toEqual([])
  })

  it('casts hard and soft shadows from a box, keeping its lit face lit (golden images)', async () => {
    const results: Record<string, Awaited<ReturnType<typeof shot>>> = {}
    for (const softness of [0, 0.8]) {
      const { app, world, camera } = await scene(160, 96)
      const floor = solid(world, [180, 180, 180, 255])
      const wall = solid(world, [120, 90, 70, 255])
      world.spawn(
        [Sprite, { texture: floor, size: [20, 12] }],
        [Transform, { translation: [0, 0, -1] }],
      )
      world.spawn(
        [Sprite, { texture: wall, size: [1, 1] }],
        [LightOccluder2d, { shape: 'box', size: [1, 1], lightPenetration: 0.25 }],
        [Transform, { translation: [-2, 0, 0] }],
      )
      world.spawn(
        [PointLight2d, { radius: 14, falloff: 0.5, intensity: 1, shadows: true, softness }],
        [Transform, { translation: [-5, 0, 0] }],
      )
      const cam = camera(6, { ambient: [0.1, 0.1, 0.1, 1] })
      const image = await shot(app, `camera:${cam}`)
      results[softness] = image
      expect(
        compareGolden(here, softness ? 'lights2d-shadow-soft' : 'lights2d-shadow-hard', image).mean,
      ).toBeLessThan(1.5)
      const lights = describeRender(world).sprites as {
        lighting: { views: Record<string, { shadowed: number; segments: number }> }
      }
      expect(lights.lighting.views[`camera:${cam}`]!.shadowed).toBe(1)
      expect(lights.lighting.views[`camera:${cam}`]!.segments).toBe(4)
      expect(world.resource(LogResource).errors()).toEqual([])
    }
    const hard = results[0]!
    // 16 px per unit; the view spans x ∈ [-5, 5], y ∈ [-3, 3]. Wall at x ∈ [-2.5, -1.5], y ∈
    // [-0.5, 0.5]: the shadow's edge rises to y = 1 at x = 0 and y = 1.9 at x = 4.5.
    const px = (x: number) => Math.round((x + 5) * 16)
    const py = (y: number) => Math.round((3 - y) * 16)
    const behind = lum(at(hard, px(2), py(0)))
    const beside = lum(at(hard, px(-1), py(2.6)))
    expect(beside).toBeGreaterThan(behind + 40)
    // The wall's face toward the light is lit; its far side is in its own shadow.
    expect(lum(at(hard, px(-2.4), py(0)))).toBeGreaterThan(lum(at(hard, px(-1.6), py(0))) + 20)
    // Soft penumbras widen away from the occluder: count partly lit pixels down a column.
    const penumbra = (image: typeof hard, x: number) => {
      const lit = lum(at(image, px(x), py(2.9)))
      const dark = lum(at(image, px(x), py(0)))
      let n = 0
      for (let y = 0; y < 96; y++) {
        const v = lum(at(image, px(x), y))
        if (v > dark + (lit - dark) * 0.1 && v < dark + (lit - dark) * 0.9) n++
      }
      return n
    }
    const soft = results[0.8]!
    expect(penumbra(soft, 4.5)).toBeGreaterThan(penumbra(soft, 0))
    expect(penumbra(soft, 0)).toBeGreaterThan(penumbra(hard, 0))
  })

  it('bins and shadows on the GPU exactly like the CPU references', async () => {
    const { app, world, camera } = await scene(160, 96)
    const tex = solid(world, [128, 128, 128, 255])
    world.spawn([Sprite, { texture: tex, size: [20, 12] }], [Transform, {}])
    for (let i = 0; i < 40; i++) {
      world.spawn(
        [PointLight2d, { radius: 0.5 + (i % 5) * 0.6, shadows: i % 4 === 0 }],
        [Transform, { translation: [((i * 37) % 100) / 10 - 5, ((i * 53) % 60) / 10 - 3, 0] }],
      )
    }
    for (let i = 0; i < 12; i++) {
      world.spawn(
        [LightOccluder2d, { shape: i % 2 ? 'circle' : 'box', size: [0.4, 0.3] }],
        [Transform, { translation: [((i * 71) % 90) / 10 - 4.5, ((i * 29) % 50) / 10 - 2.5, 0] }],
      )
    }
    const cam = camera(6, {})
    await settle(app)
    const view = world.resource(Lights2d).views.get(`camera:${cam}`)!
    expect(view.count).toBe(40)
    expect(view.shadowedCount).toBe(10)
    expect(view.segmentCount).toBeGreaterThan(20)
    const tiles = view.tilesX * view.tilesY
    const gpuTiles = new Uint32Array(
      await readBuffer(gpu, view.gpu!.tiles.buffer, tiles * TILE_STRIDE * 4),
    )
    const cpu = binLightsCpu(view.circles, view.count, view.tilesX, view.tilesY)
    let mismatches = 0
    for (let t = 0; t < tiles; t++) {
      if (gpuTiles[t * TILE_STRIDE] !== cpu.counts[t]) mismatches++
      const n = Math.min(TILE_MAX, cpu.counts[t]!)
      for (let k = 0; k < n; k++)
        if (gpuTiles[t * TILE_STRIDE + 1 + k] !== cpu.indices[t * TILE_MAX + k]) mismatches++
    }
    expect(mismatches).toBe(0)
    const rows = new Float32Array(
      await readBuffer(gpu, view.gpu!.shadowMap.buffer, view.shadowedCount * SHADOW_RES * 4),
    )
    const row = new Float32Array(SHADOW_RES)
    let off = 0
    let occluded = 0
    for (let r = 0; r < view.shadowedCount; r++) {
      const o = view.shadowed[r]! * LIGHT2D_FLOATS
      shadowRowCpu(
        view.lights[o]!,
        view.lights[o + 1]!,
        view.lights[o + 3]!,
        view.lightBits[o + 14]!,
        view.segments,
        view.segmentCount,
        row,
      )
      for (let k = 0; k < SHADOW_RES; k++) {
        const g = rows[r * SHADOW_RES + k]!
        if (row[k]! < 1e30) occluded++
        if (Math.abs(g - row[k]!) > 1e-3 * Math.max(1, row[k]!)) off++
      }
    }
    expect(occluded).toBeGreaterThan(100)
    // atan2 and cos differ by an ulp between GPU and CPU: a bin at a segment's very end may flip.
    expect(off / (view.shadowedCount * SHADOW_RES)).toBeLessThan(0.002)
  })

  it('warns once when lights exceed the budgets, keeping the nearest', async () => {
    const { app, world, camera } = await scene(64, 64)
    const tex = solid(world, [128, 128, 128, 255])
    world.spawn([Sprite, { texture: tex, size: [10, 10] }], [Transform, {}])
    for (let i = 0; i < 10; i++) {
      world.spawn(
        [PointLight2d, { radius: 1, shadows: true }],
        [Transform, { translation: [i * 0.4 - 1.8, 0, 0] }],
      )
    }
    const cam = camera(10, { maxLights: 6, maxShadowed: 2 })
    await settle(app)
    app.update(1 / 60)
    const d = (
      describeRender(world).sprites as {
        lighting: { views: Record<string, Record<string, number>> }
      }
    ).lighting.views[`camera:${cam}`]!
    expect(d.lights).toBe(6)
    expect(d.dropped).toBe(4)
    expect(d.shadowed).toBe(2)
    expect(d.demoted).toBe(4)
    const warnings = world
      .resource(LogResource)
      .tail(100, 'warn')
      .map((e) => e.code)
    expect(warnings.filter((c) => c === 'sprite/too-many-lights')).toHaveLength(1)
    expect(warnings.filter((c) => c === 'sprite/too-many-shadowed-lights')).toHaveLength(1)
    // The kept lights are the ones nearest the view center (x = 0).
    const view = world.resource(Lights2d).views.get(`camera:${cam}`)!
    for (let k = 0; k < view.count; k++) {
      expect(Math.abs(view.lights[k * LIGHT2D_FLOATS]!)).toBeLessThan(1.5)
    }
  })

  it('logs an invalid occluder once and keeps rendering', async () => {
    const { app, world, camera } = await scene(32, 32)
    world.spawn([PointLight2d, { shadows: true }], [Transform, {}])
    world.spawn(
      [
        LightOccluder2d,
        {
          shape: 'polygon',
          points: [
            [0, 0],
            [1, 1],
            [1, 0],
            [0, 1],
          ],
        },
      ],
      [Transform, {}],
    )
    world.spawn([LightOccluder2d, { shape: 'collider' }], [Transform, {}])
    camera(10, {})
    await settle(app)
    const errors = world.resource(LogResource).errors()
    expect(errors.map((e) => e.code)).toEqual([
      'sprite/invalid-occluder',
      'sprite/invalid-occluder',
    ])
    expect(errors[0]!.message).toMatch(/self-intersecting/)
  })

  it('occludes with a tilemap layer, rebuilding only an edited chunk', async () => {
    const { app, world, camera } = await scene(96, 96)
    const tex = solid(world, [160, 160, 160, 255], 16)
    const atlas = world
      .resource(TextureAtlases)
      .add(
        new (await import('./atlas')).TextureAtlas(tex as never, [
          { name: 'wall', rect: [0, 0, 8, 8] },
        ]),
      )
    const data = TilemapData.create(256, 256, ['walls'])
    const layer = data.layers[0]!
    layer.occludes = true
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) if (y % 32 < 2 || x % 32 < 2) layer.tiles[y * 256 + x] = 1
    const ref = world.resource(TilemapDatas).add(data)
    const map = world.spawn(
      [Tilemap, { atlas, data: ref, tileSize: [0.25, 0.25], chunkSize: 32 }],
      [Transform, { translation: [-4, 4, 0] }],
    )
    world.spawn(
      [PointLight2d, { radius: 6, shadows: true }],
      [Transform, { translation: [-2, 2, 0] }],
    )
    const cam = camera(8, {})
    await settle(app)
    const occ = world.resource(Lights2d).occluders
    expect(occ.tiles.size).toBe(1)
    const total = occ.segmentCount
    expect(total).toBeGreaterThan(0)
    // Far fewer than one edge per filled cell side.
    let filled = 0
    for (let i = 0; i < layer.tiles.length; i++) if (layer.tiles[i]) filled++
    expect(total / (filled * 4)).toBeLessThan(0.05)
    app.update(1 / 60)
    expect(occ.chunkRebuilds).toBe(0)
    setTile(world, map, 40, 40, 1, { layer: 'walls' })
    app.update(1 / 60)
    expect(occ.chunkRebuilds).toBe(1)
    const view = world.resource(Lights2d).views.get(`camera:${cam}`)!
    expect(view.segmentCount).toBeGreaterThan(0)
    expect(view.segmentCount).toBeLessThan(occ.segmentCount)
    expect(world.resource(Gpu).errors).toEqual([])
  })

  it('packs normal-map companions and alpha outlines, and previews them side by side', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-lights2d-'))
    roots.push(root)
    mkdirSync(join(root, 'assets/props'), { recursive: true })
    const size = 24
    const disc = new Uint8Array(size * size * 4)
    const flatUp = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = Math.hypot(x + 0.5 - 12, y + 0.5 - 12) < 10
        disc.set([200, 120, 60, inside ? 255 : 0], (y * size + x) * 4)
        // Normals tilted toward +Y (up): green high.
        flatUp.set([128, 220, 200, 255], (y * size + x) * 4)
      }
    }
    writeFileSync(join(root, 'assets/props/rock.png'), pngBytes(disc, size, size))
    writeFileSync(join(root, 'assets/props/rock_n.png'), pngBytes(flatUp, size, size))
    writeFileSync(join(root, 'assets/props/crate.png'), pngBytes(disc, size, size))
    writeFileSync(
      join(root, 'assets/props.atlas-pack.json'),
      JSON.stringify({ outlines: true, normalMap: 'directx' }),
    )
    const { world } = await scene(32, 32, root)
    const server = assetServer(world)
    await server.whenSettled(['assets/props.atlas-pack.json'])
    const refAtlas = server.resolve('assets/props.atlas-pack.json') as never
    const atlas = world.resource(TextureAtlases).get(refAtlas)!
    expect(atlas.normals).not.toBeNull()
    const rock = atlas.region('rock')
    const outline = atlas.outlines[rock]!
    expect(outline.length / 2).toBeGreaterThanOrEqual(8)
    expect(outline.length / 2).toBeLessThanOrEqual(32)
    for (let k = 0; k < outline.length; k += 2) {
      const r = Math.hypot(outline[k]! * size - 12, outline[k + 1]! * size - 12)
      expect(Math.abs(r - 10)).toBeLessThan(1)
    }
    const normals = world.resource(Textures).get(atlas.normals!)!
    expect(normals.usage).toBe('normal')
    const preview = await findAssetPreview('TextureAtlas')!(
      world,
      'assets/props.atlas-pack.json',
      512,
      256,
    )
    expect(preview.width).toBeGreaterThan(preview.height * 1.8)
    // A companion that doesn't match its image fails the import with texture/normal-map-mismatch.
    writeFileSync(
      join(root, 'assets/props/crate_n.png'),
      pngBytes(flatUp.subarray(0, 16 * 16 * 4), 16, 16),
    )
    const report = await server.scan()
    const failed = JSON.stringify(report.failed)
    expect(failed).toMatch(/normal-map-mismatch/)
  })
})

describe('2D lighting performance', () => {
  it('lights 20k sprites with 250 lights (64 shadowed) and 2000 segments at 1080p in under 2.5 ms', {
    timeout: timeout(120_000),
  }, async () => {
    const { app, world, camera } = await scene(1920, 1080)
    const tex = solid(world, [180, 160, 140, 255], 8)
    const normal = dome(world, 16)
    let seed = 1
    const rand = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let i = 0; i < 20_000; i++) {
      world.spawn(
        [Sprite, { texture: tex, size: [0.3, 0.3] }],
        [SpriteLighting, { normal }],
        [Transform, { translation: [rand() * 32 - 16, rand() * 18 - 9, rand()] }],
      )
    }
    for (let i = 0; i < 500; i++) {
      // 500 boxes: 2000 segments.
      world.spawn(
        [LightOccluder2d, { shape: 'box', size: [0.3, 0.3] }],
        [Transform, { translation: [rand() * 32 - 16, rand() * 18 - 9, 0] }],
      )
    }
    for (let i = 0; i < 250; i++) {
      world.spawn(
        [
          PointLight2d,
          {
            radius: 1 + rand(),
            shadows: i < 64,
            softness: 0.1,
            color: [rand(), rand(), rand(), 1],
          },
        ],
        [Transform, { translation: [rand() * 32 - 16, rand() * 18 - 9, 0] }],
      )
    }
    const cam = camera(18, {})
    await settle(app)
    const view = world.resource(Lights2d).views.get(`camera:${cam}`)!
    expect(view.count).toBe(250)
    expect(view.shadowedCount).toBe(64)
    // Frames submitted back to back: once the GPU is the bottleneck, time per frame is GPU time.
    const frames = async (batches: number, n = 20) => {
      const times: number[] = []
      for (let b = 0; b < batches; b++) {
        await gpu.device.queue.onSubmittedWorkDone()
        const t0 = performance.now()
        for (let i = 0; i < n; i++) app.update(1 / 60)
        await gpu.device.queue.onSubmittedWorkDone()
        times.push((performance.now() - t0) / n)
      }
      times.sort((a, b) => a - b)
      return times[Math.floor(batches / 2)]!
    }
    await frames(1)
    const lit = await frames(5)
    world.remove(cam, Lighting2d)
    await settle(app, 4)
    await frames(1)
    const unlit = await frames(5)
    // 18-pixel sprites at 1080p (3× coverage), lights 60–120 pixels in radius: about 3.6 lights
    // and one shadowed light per pixel.
    expect(lit).toBeLessThan(budget(1000 / 60))
    expect(lit - unlit).toBeLessThan(budget(2.5))
    expect(world.resource(Gpu).errors).toEqual([])
  })
})
