import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quat, Rng, t } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { cube, plane, sphere } from '@shard/mesh'
import { App, LogResource } from '@shard/runtime'
import { Texture, Textures, toHalf } from '@shard/texture'
import { lookAt, Transform, TransformPlugin } from '@shard/transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { setDebugView } from './debug-views'
import { captureGBuffer, GBUFFER_CHANNELS } from './deferred'
import { EnvironmentMap } from './environment'
import { forwardPlugin } from './forward'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight, PointLight } from './lights'
import { defineMaterial } from './materials'
import { captureBuffer, describeRender, Gpu, renderPlugin, Shaders } from './plugin'
import { OffscreenTarget } from './target'
import { compareGolden, renderView, settle } from './testing'
import { RenderPath, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))
const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

async function scene(width: number, height: number, msaa: 1 | 4 = 1) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'deferred-target', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'deferred-target')
  return { app, world: app.world, targetRef }
}

type World = Awaited<ReturnType<typeof scene>>['world']

/** A gradient sky environment made in code. */
function sky(world: World) {
  const w = 64
  const h = 32
  const f = new Float32Array(w * h * 4)
  for (let j = 0; j < h; j++) {
    const y = Math.cos(((j + 0.5) / h) * Math.PI)
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4
      f.set(y < 0 ? [0.1, 0.08, 0.06, 1] : [0.3 + 0.2 * y, 0.4 + 0.3 * y, 0.7 + 0.3 * y, 1], o)
    }
  }
  return world.resource(Textures).add(
    Texture.create({
      width: w,
      height: h,
      format: 'rgba16float',
      usage: 'hdr',
      mips: [new Uint8Array(toHalf(f).buffer)],
    }),
  )
}

/** Directional light with shadows, 64 point lights, IBL, and mixed materials. */
function fixture(world: World) {
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const mat = (v: Record<string, unknown>) => materials.add(new MaterialAsset(v))
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 30 })) }],
    [MeshMaterial, { material: mat({ baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.7 }) }],
    Transform,
  )
  const ball = meshes.add(sphere({ radius: 0.5, segments: 32 }))
  const box = meshes.add(cube({ size: 0.8 }))
  const looks = [
    { baseColor: [0.8, 0.2, 0.2, 1], roughness: 0.3 },
    { baseColor: [0.9, 0.8, 0.5, 1], metallic: 1, roughness: 0.2 },
    { baseColor: [0.2, 0.6, 0.3, 1], roughness: 0.9 },
    { baseColor: [0.1, 0.1, 0.1, 1], emissive: [0.3, 0.6, 1, 1], emissiveLuminance: 3000 },
  ].map(mat)
  for (let i = 0; i < 12; i++) {
    world.spawn(
      [Mesh3d, { mesh: i % 2 ? ball : box }],
      [MeshMaterial, { material: looks[i % 4]! }],
      [
        Transform,
        {
          translation: [(i % 4) * 1.6 - 2.4, 0.5, Math.floor(i / 4) * 1.6 - 2.4],
          rotation: q(0, i, 0),
        },
      ],
    )
  }
  world.spawn(
    [DirectionalLight, { illuminance: 2000, shadows: true }],
    [Transform, { rotation: q(-0.9, 0.6, 0) }],
  )
  const rng = new Rng(5)
  for (let i = 0; i < 64; i++) {
    world.spawn(
      [PointLight, { intensity: 300, range: 3, color: [rng.float(), rng.float(), rng.float(), 1] }],
      [Transform, { translation: [rng.range(-5, 5), rng.range(0.2, 1.5), rng.range(-5, 5)] }],
    )
  }
  return sky(world)
}

function camera(world: World, targetRef: unknown, mode: 'forward' | 'deferred', env: unknown) {
  return world.spawn(
    [Camera3d, { target: targetRef as never, fovY: 50 }],
    [Exposure, { ev100: 9 }],
    [RenderPath, { mode }],
    [EnvironmentMap, { texture: env as never, intensity: 200 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: [0, 5, 7], rotation: lookAt([0, 5, 7], [0, 0, 0]) }],
  )
}

const meanDiff = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

describe('deferred rendering', () => {
  it('renders the same fixture as forward, within 2 levels', async () => {
    const shots: Uint8Array[] = []
    for (const mode of ['forward', 'deferred'] as const) {
      const { app, world, targetRef } = await scene(160, 100)
      const env = fixture(world)
      const cam = camera(world, targetRef, mode, env)
      const image = await renderView(app, `camera:${cam}`)
      shots.push(image.data)
      if (mode === 'deferred') {
        expect(compareGolden(here, 'deferred-fixture', image).mean).toBeLessThan(1.5)
        const d = describeRender(world).deferred as {
          views: Record<string, { path: string; deferredMeshes: number; gbufferBytes: number }>
        }
        const v = d.views[`camera:${cam}`]!
        expect(v.path).toBe('deferred')
        expect(v.deferredMeshes).toBe(13)
        expect(v.gbufferBytes).toBeGreaterThan(160 * 100 * 16)
      }
    }
    expect(meanDiff(shots[0]!, shots[1]!)).toBeLessThan(2)
  })

  it('draws transparent and custom-lit materials forward in a deferred view, in depth order', async () => {
    const Glow = defineMaterial('test/DeferredGlow', {
      extends: 'none',
      fields: { luminance: t.f32({ default: 800 }) },
      shader: 'project::glow',
    })
    const { app, world, targetRef } = await scene(128, 80)
    world.resource(Shaders).register(
      'project::glow',
      `import shard::pbr::types::VertexOutput;
import material::deferred_glow::DeferredGlow;
override fn shade(in: VertexOutput) -> vec4f {
  return vec4f(vec3f(1.0, 0.4, 0.1) * DeferredGlow.luminance, 1.0);
}`,
      'shaders/glow.wesl',
    )
    const env = fixture(world)
    const materials = world.resource(Materials)
    const glass = materials.add(
      new MaterialAsset({ baseColor: [0.3, 0.6, 1, 0.4], alphaMode: 'alpha', roughness: 0.1 }),
    )
    const glow = materials.add(new MaterialAsset({}, Glow))
    // The glow cube sits behind the glass pane; a lit cube stands in front of both.
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1 })) }],
      [MeshMaterial, { material: glow }],
      [Transform, { translation: [0, 1, -1.5] }],
    )
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 3 })) }],
      [MeshMaterial, { material: glass }],
      [Transform, { translation: [0, 1.2, 0], rotation: q(Math.PI / 2, 0, 0) }],
    )
    const cam = camera(world, targetRef, 'deferred', env)
    const image = await renderView(app, `camera:${cam}`)
    expect(compareGolden(here, 'deferred-forward-mix', image).mean).toBeLessThan(1.5)
    const d = describeRender(world).deferred as {
      views: Record<string, { forwardMeshes: number; forwardReasons: Record<string, number> }>
    }
    const reasons = d.views[`camera:${cam}`]!.forwardReasons
    expect(reasons['custom lighting (test/DeferredGlow)']).toBe(1)
    expect(reasons.transparent).toBe(1)
  })

  it('captures every G-buffer channel and depth (golden images)', async () => {
    const { app, world, targetRef } = await scene(96, 60)
    const env = fixture(world)
    const cam = camera(world, targetRef, 'deferred', env)
    app.update(1 / 60)
    for (const channel of GBUFFER_CHANNELS) {
      setDebugView(world, cam, channel)
      await settle(app)
      const shot = captureGBuffer(world, cam, channel)
      app.update(1 / 60)
      const image = await shot
      expect(compareGolden(here, `gbuffer-${channel}`, image).mean, channel).toBeLessThan(1.5)
    }
    setDebugView(world, cam, 'none')
    const shot = captureBuffer(world, `camera:${cam}`, 'depth')
    app.update(1 / 60)
    const depth = await shot
    const bytes = new Uint8Array(depth.width * depth.height * 4)
    let max = 0
    for (let i = 0; i < depth.data.length; i += 4) max = Math.max(max, depth.data[i]!)
    for (let i = 0; i < depth.data.length; i += 4) {
      bytes[i] = bytes[i + 1] = bytes[i + 2] = Math.round((depth.data[i]! / max) * 255)
      bytes[i + 3] = 255
    }
    expect(
      compareGolden(here, 'gbuffer-depth', {
        width: depth.width,
        height: depth.height,
        data: bytes,
      }).mean,
    ).toBeLessThan(1.5)
  })

  it('shows G-buffer channels of a forward view too', async () => {
    const { app, world, targetRef } = await scene(48, 30, 4)
    const env = fixture(world)
    const cam = camera(world, targetRef, 'forward', env)
    app.update(1 / 60)
    setDebugView(world, cam, 'normal')
    await settle(app)
    const shot = captureGBuffer(world, cam, 'normal')
    app.update(1 / 60)
    const image = await shot

    // Normals of the floor (+Y) come out as (0.5, 1, 0.5): mostly green.
    const o = (25 * 48 + 24) * 4
    expect(image.data[o + 1]!).toBeGreaterThan(200)
  })

  it('switches RenderPath at runtime, the next frame, without errors', async () => {
    const { app, world, targetRef } = await scene(64, 40, 4)
    const env = fixture(world)
    const cam = camera(world, targetRef, 'forward', env)
    await settle(app)
    const order = () =>
      (describeRender(world).perView as Record<string, { order: string[] }>)[`camera:${cam}`]!.order
    expect(order()).toContain('forward-opaque')
    world.set(cam, RenderPath, { mode: 'deferred' })
    app.update(1 / 60)
    expect(order()).toContain('deferred-lighting')
    expect(order()).not.toContain('forward-opaque')
    world.set(cam, RenderPath, { mode: 'forward' })
    app.update(1 / 60)
    expect(order()).toContain('forward-opaque')
    await gpu.pipelines.whenIdle()
    expect(world.resource(Gpu).errors).toEqual([])
    expect(world.resource(LogResource).errors()).toEqual([])
  })
})
