import { type Entity, t, type World } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { createGpuContext, type GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { FakeGl } from '@aethervtt/shard-gpu-webgl2/testing'
import { box, plane } from '@aethervtt/shard-mesh'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { ShaderData } from './globals'
import type { CapturedBuffer, CapturedImage } from './graph'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight } from './lights'
import { defineMaterial } from './materials'
import { captureBuffer, describeRender, renderPlugin, Shaders } from './plugin'
import { worldToScreen } from './projection'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { pixel, renderView, settle } from './testing'
import { Ink } from './toon'
import { RenderPath, Tonemapping } from './view'

// Refracting material types (0129): a box half under a wavy sheet of water that tints what's
// behind it by the distance through it, with a masked hole, in forward (with and without MSAA) and
// deferred views, on WebGPU and the baseline tier.

let gpu: GpuContext
let compat: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(async () => {
  for (const g of [gpu, compat]) {
    await g?.device.queue.onSubmittedWorkDone()
    g?.destroy()
  }
})

/**
 * Water as Stranded's ocean would read it: clear near the surface, its tint deeper down. The tint
 * comes from shard::shader_data (0127), which a game rewrites each frame.
 */
const ClearWater = defineMaterial('test/ClearWater', {
  fields: {
    absorption: t.f32({ default: 2, unit: '1/m' }),
    waves: t.f32({ default: 0.02, unit: 'm' }),
    /** A rectangle (x, z) with no water: a raft's deck. */
    maskMin: t.vec2({ default: [0, 0] }),
    maskMax: t.vec2({ default: [0, 0] }),
  },
  shader: 'test::clear_water',
  refraction: true,
})

const TINT: [number, number, number, number] = [0.05, 0.35, 0.6, 1]

const clearWater = (tint: number) => `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::shader_data::shader_data;
import shard::pbr::standard::standard_input;
import shard::mesh::vertex_world;
import shard::refraction::{ refraction_uv, refraction_color, refraction_thickness };
import material::clear_water::ClearWater;

override fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  let p = vertex_world(position);
  return position + vec3f(0.0, ClearWater.waves * sin(p.x * 3.0) * sin(p.z * 2.0), 0.0);
}

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let uv = refraction_uv(in.clip);
  let clear = exp(-refraction_thickness(uv, in.world_position) * ClearWater.absorption);
  p.base_color = shader_data[${tint}u].rgb * (1.0 - clear);
  p.emissive = refraction_color(uv, 0.0) * clear;
  let xz = in.world_position.xz;
  p.alpha = select(1.0, 0.0, all(xz > ClearWater.maskMin) && all(xz < ClearWater.maskMax));
  return p;
}`

type Vec3 = [number, number, number]

const EYE: Vec3 = [0, 2.5, 5]
const AT: Vec3 = [0, -0.3, 0]
const W = 160
const H = 120

interface Options {
  msaa?: 1 | 4
  deferred?: boolean
}

async function scene(g: GpuContext, o: Options = {}) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu: g, windowView: false }),
    forwardPlugin({ msaa: o.msaa ?? 1 }),
  )
  await app.init()
  const world = app.world
  const data = world.resource(ShaderData)
  const tint = data.reserve('test/water-tint', 1)
  const setTint = (rgba: readonly number[]) => data.values.set(rgba, tint * 4)
  setTint(TINT)
  world
    .resource(Shaders)
    .register('test::clear_water', clearWater(tint), 'shaders/clear_water.wesl')
  world.resource(AmbientLight).brightness = 1.5
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const gray = materials.add(new MaterialAsset({ baseColor: [0.6, 0.6, 0.6, 1], roughness: 1 }))
  const red = materials.add(new MaterialAsset({ baseColor: [0.85, 0.15, 0.1, 1], roughness: 1 }))
  const water = materials.add(
    new MaterialAsset(
      { alphaMode: 'mask', roughness: 1, maskMin: [0.2, 0.3], maskMax: [1.2, 1.2] },
      ClearWater,
    ),
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 30 })) }],
    [MeshMaterial, { material: gray }],
    [Transform, { translation: [0, -1.2, 0] }],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 1, y: 1, z: 1 })) }],
    [MeshMaterial, { material: red }],
    [Transform, {}],
  )
  const camera = (ink: boolean) => {
    const target = new OffscreenTarget(g, { label: 'refraction', width: W, height: H })
    const ref = world.resource(RenderTargets).add(target, `refraction-${Math.random()}`)
    const cam = world.spawn(
      [Camera3d, { target: ref as never, fovY: 50, clearColor: [0, 0, 0, 1] }],
      [Exposure, { ev100: 0 }],
      [Tonemapping, { curve: 'none', dither: false }],
      [Transform, { translation: EYE, rotation: lookAt(EYE, AT) }],
    )
    if (o.deferred) world.add(cam, RenderPath, { mode: 'deferred' })
    if (ink) world.add(cam, Ink, { width: 2, color: [0, 0, 0, 1] })
    return cam
  }
  const inked = camera(true)
  const plain = camera(false)
  // A 4 m sheet, finely divided so the waves bend it.
  const sheet = meshes.add(plane({ size: 4, subdivisions: 32 }))
  const addWater = () =>
    world.spawn([Mesh3d, { mesh: sheet }], [MeshMaterial, { material: water }], [Transform, {}])
  return { app, world, inked, plain, addWater, setTint }
}

type Scene = Awaited<ReturnType<typeof scene>>

const screen = new Float32Array(3)

function at(world: World, cam: Entity, p: Vec3): [number, number] {
  worldToScreen(world, cam, p, screen)
  return [Math.round(screen[0]! - 0.5), Math.round(screen[1]! - 0.5)]
}

/** The view's HDR color (pre-exposed) at a world point's pixel. */
function hdrAt(s: Scene, image: CapturedBuffer, p: Vec3): [number, number, number] {
  const [x, y] = at(s.world, s.plain, p)
  const o = (y * image.width + x) * 4
  return [image.data[o]!, image.data[o + 1]!, image.data[o + 2]!]
}

async function hdr(s: Scene): Promise<CapturedBuffer> {
  await settle(s.app)
  const pending = captureBuffer(s.world, `camera:${s.plain}`, 'hdr')
  s.app.update(1 / 60)
  return pending
}

const dark = (image: CapturedImage, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
  const [r, g, b] = pixel(image, x, y)
  return Math.max(r!, g!, b!) < 25
}

/** Whether a pixel within a pixel of a world point's projection is ink. */
function inkNear(s: Scene, image: CapturedImage, p: Vec3): boolean {
  const [cx, cy] = at(s.world, s.inked, p)
  for (let y = cy - 1; y <= cy + 1; y++)
    for (let x = cx - 1; x <= cx + 1; x++) if (dark(image, x, y)) return true
  return false
}

const blueShare = (c: number[]) => c[2]! / (c[0]! + c[1]! + c[2]!)

const orderOf = (s: Scene, cam: Entity) =>
  (describeRender(s.world) as { perView: Record<string, { order: string[] }> }).perView[
    `camera:${cam}`
  ]!.order

const problems = (world: World) =>
  world
    .resource(LogResource)
    .tail(500, 'warn')
    .map((e) => `${e.code ?? ''} ${e.message}`)

/** Points on the box's front face (z = 0.5): above the water, just under it, deep, masked. */
const ABOVE: Vec3 = [-0.25, 0.25, 0.5]
const SHALLOW: Vec3 = [-0.25, -0.1, 0.5]
const DEEP: Vec3 = [-0.25, -0.42, 0.5]
const MASKED: Vec3 = [0.35, -0.3, 0.5]
/** Edges of the box under the water: its left side, its bottom; one above it. */
const LEFT_UNDER: Vec3 = [-0.5, -0.3, 0.5]
const BOTTOM_UNDER: Vec3 = [-0.1, -0.5, 0.5]
const LEFT_ABOVE: Vec3 = [-0.5, 0.3, 0.5]
/** The sheet's near edge, against the floor 1.2 m below; open water. */
const NEAR_EDGE: Vec3 = [-1.2, 0, 2]
const OPEN: Vec3[] = [
  [1.3, 0, -1],
  [-1.3, 0, 0],
]

const NODES = ['opaque-copy', 'refraction', 'refraction-deferred', 'refraction/prepass']

async function check(g: GpuContext, o: Options) {
  const s = await scene(g, o)
  const dry = await hdr(s)
  const dryInk = await renderView(s.app, `camera:${s.inked}`)
  // Without a refracting draw, none of it runs.
  for (const node of NODES) expect(orderOf(s, s.inked)).not.toContain(node)
  s.addWater()
  const wet = await hdr(s)
  const image = await renderView(s.app, `camera:${s.inked}`)
  const order = orderOf(s, s.inked)
  expect(order).toContain('opaque-copy')
  expect(order).toContain(o.deferred ? 'refraction-deferred' : 'refraction')
  // Forward views add the surface to the prepass ink reads; deferred ones write gbuffer1.
  expect(order.includes('refraction/prepass')).toBe(!o.deferred)

  // Above the water and in the masked hole: the box as it was.
  for (const p of [ABOVE, MASKED]) {
    const a = hdrAt(s, wet, p)
    const b = hdrAt(s, dry, p)
    for (let k = 0; k < 3; k++) expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(0.03 * b[0]! + 1e-3)
  }
  // Under it: the box mixed with the water's tint, more so deeper.
  const shallow = hdrAt(s, wet, SHALLOW)
  const deep = hdrAt(s, wet, DEEP)
  const box = hdrAt(s, dry, SHALLOW)
  expect(blueShare(shallow)).toBeGreaterThan(blueShare(box) + 0.05)
  expect(blueShare(deep)).toBeGreaterThan(blueShare(shallow) + 0.1)
  expect(shallow[0]).toBeLessThan(box[0])
  expect(deep[0]).toBeLessThan(shallow[0] * 0.8)
  // The box still shows near the surface: more of its red than of the tint.
  expect(shallow[0]).toBeGreaterThan(shallow[2])

  // Ink: the sheet's edge and the box above the water are outlined; open water and the box's
  // edges under it aren't, though they are without the water.
  // The tint is read from shader_data in the refraction pass: a red one takes the blue out.
  s.setTint([0.6, 0.05, 0.05, 1])
  expect(blueShare(hdrAt(s, await hdr(s), DEEP))).toBeLessThan(blueShare(deep) - 0.1)
  s.setTint(TINT)

  expect(inkNear(s, image, NEAR_EDGE)).toBe(true)
  expect(inkNear(s, image, LEFT_ABOVE)).toBe(true)
  for (const p of OPEN) expect(inkNear(s, image, p)).toBe(false)
  for (const p of [LEFT_UNDER, BOTTOM_UNDER]) {
    expect(inkNear(s, dryInk, p)).toBe(true)
    expect(inkNear(s, image, p)).toBe(false)
  }
  expect(problems(s.world)).toEqual([])
  await s.app.dispose()
}

describe('refracting material types (0129)', () => {
  for (const msaa of [1, 4] as const) {
    it(`tint what's behind them by depth, mask, and ink only their own edges (forward, MSAA ${msaa})`, {
      timeout: timeout(120_000),
    }, async () => {
      await check(gpu, { msaa })
    })
  }

  it('do the same in a deferred view', { timeout: timeout(120_000) }, async () => {
    await check(gpu, { deferred: true })
  })

  it('reject a blend mode, and draw nothing blended', () => {
    expect(() => defineMaterial('test/BlendedWater', { refraction: true, blend: 'alpha' })).toThrow(
      expect.objectContaining({ code: 'render/refraction-blend' }),
    )
    expect(ClearWater.blendOf({ alphaMode: 'alpha' })).toBe('opaque')
    expect(ClearWater.blendOf({ alphaMode: 'mask' })).toBe('mask')
    expect(ClearWater.deferrable({ alphaMode: 'opaque' })).toBe(false)
  })
})

describe('refracting material types on the baseline tier (0129, 0064)', () => {
  for (const msaa of [1, 4] as const) {
    it(`tint, mask and ink as on WebGPU (MSAA ${msaa})`, {
      timeout: timeout(120_000),
    }, async () => {
      await check(compat, { msaa })
    })
  }

  it('translate with naga, and draw into the depth prepass with MSAA, on WebGL2', {
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
      const s = await scene(gl, { msaa: 4 })
      s.addWater()
      await settle(s.app)
      s.app.update(1 / 60)
      const order = orderOf(s, s.inked)
      for (const node of ['depth-prepass', 'opaque-copy', 'refraction', 'refraction/prepass'])
        expect(order).toContain(node)
      expect(order.includes('refraction/depth')).toBe(true)
      // The copy reads the depth prepass before the surface is drawn into it.
      expect(order.indexOf('opaque-copy')).toBeLessThan(order.indexOf('refraction/depth'))
      expect(gl.errors.map((e) => e.message)).toEqual([])
      expect(problems(s.world)).toEqual([])
      await s.app.dispose()
    } finally {
      gl.destroy()
    }
  })
})
