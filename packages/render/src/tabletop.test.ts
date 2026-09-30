import { type AssetRef, ChildOf, type Entity, t } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, cylinder, plane, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Culler } from './culling'
import { readBuffer } from './debug-views'
import { groundKey, Mesh3d, MeshMaterial } from './instances'
import { GroundLayer, RenderLayers } from './layers'
import { tabletopFalloff } from './lights'
import { defineMaterial } from './materials'
import { Outline } from './outline'
import { describeRender, Gpu, Graph, renderPlugin, Shaders } from './plugin'
import { worldToScreen } from './projection'
import { registerShaders } from './shaders'
import { forwardPlugin } from './standard'
import { RenderStats } from './stats'
import { OffscreenTarget } from './target'
import { pixel, renderView, settle } from './testing'
import { CameraMoved, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** An unlit flat color: bands are told apart by exact colors. */
const Flat = defineMaterial('test/TabletopFlat', {
  extends: 'none',
  fields: { color: t.color({ default: [1, 1, 1, 1] }) },
  shader: 'test::tabletop_flat',
  description: 'A flat color for the tabletop tests.',
})

const FLAT_SHADER = {
  'test::tabletop_flat': `
import shard::pbr::types::VertexOutput;
import shard::view::view;
import material::tabletop_flat::TabletopFlat;

override fn shade(in: VertexOutput) -> vec4f {
  return vec4f(TabletopFlat.color.rgb / view.exposure, 1.0);
}`,
}

async function tabletop(width = 96, height = 64, pixelRatio = 1) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  registerShaders(world.resource(Shaders), FLAT_SHADER)
  const target = new OffscreenTarget(gpu, { label: 'tabletop', width, height, pixelRatio })
  const ref = world.resource(RenderTargets).add(target, 'tabletop') as AssetRef<'RenderTarget'>
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const flat = (color: [number, number, number]) =>
    materials.add(new MaterialAsset({ color: [...color, 1] }, Flat))
  return { app, world, target, ref, meshes, materials, flat }
}

function camera(
  world: App['world'],
  ref: AssetRef<'RenderTarget'>,
  eye: [number, number, number],
  at: [number, number, number],
  extra: Record<string, unknown> = {},
): Entity {
  return world.spawn(
    [Camera3d, { target: ref, fovY: 40, clearColor: [0, 0, 0, 1], ...extra }],
    [Exposure, { ev100: 0 }],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: eye, rotation: lookAt(eye, at) }],
  )
}

const dominant = (p: ArrayLike<number>) =>
  p[0]! > p[1]! && p[0]! > p[2]! ? 'r' : p[1]! > p[2]! ? 'g' : p[2]! > 0 ? 'b' : 'k'

describe('ground bands', () => {
  it('stack coplanar bands in order at any angle, and walls hide them', async () => {
    const r = await tabletop()
    const { world, meshes, flat } = r
    const quad = meshes.add(plane({ size: 1 }))
    // An opaque floor, then three overlapping bands at the floor's height, spawned out of order.
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 20 })) }],
      [MeshMaterial, { material: flat([0.02, 0.02, 0.02]) }],
      Transform,
    )
    const band = (b: number, color: [number, number, number], scale: number) =>
      world.spawn(
        [Mesh3d, { mesh: quad }],
        [MeshMaterial, { material: flat(color) }],
        [GroundLayer, { band: b }],
        [Transform, { scale: [scale, 1, scale] }],
      )
    band(40, [0, 0, 1], 2)
    band(20, [1, 0, 0], 6)
    band(30, [0, 1, 0], 4)
    // A wall in front of the bands' near left corner, toward the oblique cameras.
    world.spawn(
      [Mesh3d, { mesh: meshes.add(box({ x: 3, y: 4, z: 0.2 })) }],
      [MeshMaterial, { material: flat([1, 1, 1]) }],
      [Transform, { translation: [-2, 2, 4] }],
    )
    for (const [name, eye] of [
      ['top-down', [0, 16, 0.0001]],
      ['55°', [0, 11.5, 8]],
      ['30°', [0, 7, 12]],
    ] as const) {
      const cam = camera(world, r.ref, [...eye], [0, 0, 0])
      await settle(r.app)
      const image = await renderView(r.app, `camera:${cam}`)
      // The centre shows the top band, a ring around it the middle one, then the bottom one.
      const at = (x: number) => dominant(pixel(image, x, Math.round(image.height * 0.45)))
      const cx = image.width / 2
      expect(at(cx), name).toBe('b')
      if (name === 'top-down') {
        // Every pixel of the centre is exactly one band's colour: nothing fights.
        for (let y = 29; y < 35; y++)
          for (let x = 45; x < 51; x++) expect(dominant(pixel(image, x, y)), `${x},${y}`).toBe('b')
        // 5.5 pixels a metre: green from 1 to 2 m out, red from 2 to 3 m.
        expect(dominant(pixel(image, 48 - 8, 32))).toBe('g')
        expect(dominant(pixel(image, 48 - 14, 32))).toBe('r')
      } else {
        // The wall stands between the camera and the bands' near left corner: it covers them
        // there, and the same spot on the right still shows the bottom band.
        const at = (p: [number, number, number]) => {
          const css = [0, 0]
          worldToScreen(world, cam, p, css)
          return pixel(image, Math.floor(css[0]!), Math.floor(css[1]!))
        }
        const hidden = at([-2, 0, 2.9])
        expect(Math.min(hidden[0]!, hidden[1]!, hidden[2]!), name).toBeGreaterThan(200)
        expect(dominant(at([2, 0, 2.9])), name).toBe('r')
      }
      world.despawn(cam)
    }
    const described = describeRender(world) as unknown as {
      ground: { bands: Record<string, number> }
    }
    expect(described.ground.bands).toEqual({ 20: 1, 30: 1, 40: 1 })
    expect(world.resource(Gpu).errors).toEqual([])
    await r.app.dispose()
    r.target.destroy()
  })
})

describe('ground levels', () => {
  it('sort level first: a lower level never draws over an upper one, whatever its band', async () => {
    const r = await tabletop()
    const { world, meshes, flat } = r
    const quad = meshes.add(plane({ size: 1 }))
    const layer = (band: number, level: number, color: [number, number, number], scale: number) =>
      world.spawn(
        [Mesh3d, { mesh: quad }],
        [MeshMaterial, { material: flat(color) }],
        [GroundLayer, { band, level }],
        [Transform, { scale: [scale, 1, scale] }],
      )
    // A token on the ground level (band 40) under an upper level's lowest band (10), and the
    // ground level's fog (50) under both.
    layer(40, 0, [0, 0, 1], 2)
    layer(10, 1, [1, 0, 0], 4)
    layer(50, 0, [0, 1, 0], 6)
    const cam = camera(world, r.ref, [0, 16, 0.0001], [0, 0, 0])
    await settle(r.app)
    const image = await renderView(r.app, `camera:${cam}`)
    expect(dominant(pixel(image, 48, 32)), 'centre').toBe('r')
    expect(dominant(pixel(image, 48 - 14, 32)), 'ring').toBe('g')
    // Keys stay exact at the extremes.
    const keys = [
      groundKey(32767, 2147483647, -16),
      groundKey(-32768, -2147483648, -15),
      groundKey(32767, 2147483647, 14),
      groundKey(-32768, -2147483648, 15),
      groundKey(-32768, -2147483647, 15),
    ]
    for (let i = 1; i < keys.length; i++) expect(keys[i]!).toBeGreaterThan(keys[i - 1]!)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.app.dispose()
    r.target.destroy()
  })
})

describe('render layers', () => {
  for (const gpuCull of [false, true]) {
    it(`draw each view's visuals only, and switching views rebuilds nothing (${gpuCull ? 'GPU' : 'CPU'} culling)`, async () => {
      const r = await tabletop()
      const { world, meshes, flat } = r
      world.resource(Culler).enabled = gpuCull
      const MAP = 1
      const TABLETOP = 2
      const discMesh = meshes.add(cylinder({ radius: 0.5, height: 0.05 }))
      const standeeMesh = meshes.add(box({ x: 0.1, y: 1.5, z: 1 }))
      const disc = flat([1, 0, 0])
      const standee = flat([0, 0, 1])
      // A token: the logical Transform on a root, a flat disc for the Map and a standee for the
      // Tabletop as children.
      for (let i = 0; i < 5; i++) {
        const token = world.spawn([Transform, { translation: [i * 1.5 - 3, 0, 0] }])
        world.spawn(
          [Mesh3d, { mesh: discMesh }],
          [MeshMaterial, { material: disc }],
          [RenderLayers, { mask: MAP }],
          [GroundLayer, { band: 40 }],
          [ChildOf, { parent: token }],
        )
        world.spawn(
          [Mesh3d, { mesh: standeeMesh }],
          [MeshMaterial, { material: standee }],
          [RenderLayers, { mask: TABLETOP }],
          [Transform, { translation: [0, 0.75, 0] }],
          [ChildOf, { parent: token }],
        )
      }
      const map = camera(world, r.ref, [0, 12, 0.001], [0, 0, 0], {
        projection: 'orthographic',
        orthoHeight: 8,
        layers: MAP,
      })
      const table = camera(world, r.ref, [0, 5, 8], [0, 0, 0], { layers: TABLETOP, active: false })
      await settle(r.app)
      for (let i = 0; i < 4; i++) r.app.update(1 / 60)
      const stats = world.resource(RenderStats)
      const mapStats = stats.get(`camera:${map}`)!
      // The discs are ground draws; no standee is visible.
      const ground = (
        describeRender(world) as unknown as {
          ground: { views: Record<string, { instances: number }> }
        }
      ).ground.views
      expect(ground[`camera:${map}`]!.instances).toBe(5)
      if (!gpuCull) expect(mapStats.visible).toBe(5)
      world.set(map, Camera3d, { active: false })
      world.set(table, Camera3d, { active: true })
      r.app.update(1 / 60)
      r.app.update(1 / 60)
      expect(stats.lastFrame.meshesRebuilt).toBe(0)
      expect(stats.lastFrame.bytes.instances).toBe(0)
      const tableGround = (
        describeRender(world) as unknown as {
          ground: { views: Record<string, { instances: number }> }
        }
      ).ground.views[`camera:${table}`]!
      expect(tableGround.instances).toBe(0)
      if (!gpuCull) expect(stats.get(`camera:${table}`)!.visible).toBe(5)
      expect(world.resource(Gpu).errors).toEqual([])
      await r.app.dispose()
      r.target.destroy()
    })
  }
})

describe('outlines', () => {
  it('are not in the graph without an Outline, and measure their width with one', async () => {
    for (const ratio of [1, 2]) {
      const r = await tabletop(96 * ratio, 64 * ratio, ratio)
      const { world, meshes, flat } = r
      world.spawn(
        [Mesh3d, { mesh: meshes.add(plane({ size: 20 })) }],
        [MeshMaterial, { material: flat([0, 0, 0]) }],
        Transform,
      )
      const target = world.spawn(
        [Mesh3d, { mesh: meshes.add(box({ x: 2, y: 0.5, z: 2 })) }],
        [MeshMaterial, { material: flat([0.1, 0.1, 0.1]) }],
        [Transform, { translation: [0, 0.25, 0] }],
      )
      const cam = camera(world, r.ref, [0, 10, 0.0001], [0, 0, 0], {
        projection: 'orthographic',
        orthoHeight: 8,
      })
      await settle(r.app)
      r.app.update(1 / 60)
      const inGraph = () =>
        world.resource(Graph).describe().perView[`camera:${cam}`]?.order.includes('post/outline') ??
        false
      expect(inGraph()).toBe(false)
      world.add(target, Outline, { color: [0, 1, 0, 1], width: 4, occluded: 'show' })
      await settle(r.app)
      const image = await renderView(r.app, `camera:${cam}`)
      expect(inGraph()).toBe(true)
      // Along the middle row: the box spans 2 m of 8 (a quarter of the height in pixels), and
      // the ring sits outside it on both sides.
      const y = Math.round(image.height / 2)
      let ring = 0
      for (let x = 0; x < image.width / 2; x++) {
        const p = pixel(image, x, y)
        if (p[1]! > 60 && p[0]! < 40) ring++
      }
      expect(Math.abs(ring / ratio - 4), `ratio ${ratio}: ring ${ring}`).toBeLessThanOrEqual(1)
      world.remove(target, Outline)
      r.app.update(1 / 60)
      r.app.update(1 / 60)
      expect(inGraph()).toBe(false)
      expect(world.resource(Gpu).errors).toEqual([])
      await r.app.dispose()
      r.target.destroy()
    }
  })
})

describe('tabletop falloff', () => {
  it('is 1 at bright, 0.5 halfway to range and 0 at range, on the CPU and in WGSL', async () => {
    expect(tabletopFalloff(4, 4, 10)).toBe(1)
    expect(tabletopFalloff(2, 4, 10)).toBe(1)
    expect(tabletopFalloff(7, 4, 10)).toBeCloseTo(0.5, 9)
    expect(tabletopFalloff(10, 4, 10)).toBe(0)
    const r = await tabletop()
    const shaders = r.world.resource(Shaders)
    registerShaders(shaders, {
      'test::falloff': `
import shard::pbr::lights::{ Light, light_falloff };
@group(0) @binding(0) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(1) fn main() {
  var light: Light;
  light.range = 10.0;
  light.bright = 4.0;
  light.falloff = 1.0;
  out[0] = light_falloff(light, 4.0, 16.0);
  out[1] = light_falloff(light, 7.0, 49.0);
  out[2] = light_falloff(light, 10.0, 100.0);
  light.falloff = 0.0;
  out[3] = light_falloff(light, 2.0, 4.0);
}`,
    })
    let module = shaders.module(gpu, { root: 'test::falloff' })
    for (let i = 0; i < 100 && !module; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      module = shaders.module(gpu, { root: 'test::falloff' })
    }
    const pipeline = gpu.device.createComputePipeline({
      label: 'test/falloff',
      layout: 'auto',
      compute: { module: module!, entryPoint: 'main' },
    })
    const buffer = gpu.device.createBuffer({
      label: 'test/falloff',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const encoder = gpu.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      gpu.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer } }],
      }),
    )
    pass.dispatchWorkgroups(1)
    pass.end()
    gpu.device.queue.submit([encoder.finish()])
    const out = new Float32Array(await readBuffer(gpu, buffer, 16))
    expect(out[0]).toBe(1)
    expect(out[1]).toBeCloseTo(0.5, 6)
    expect(out[2]).toBe(0)
    // Physical: inverse square, windowed.
    const ratio = 0.2
    expect(out[3]).toBeCloseTo((1 - ratio ** 4) ** 2 / 4, 6)
    buffer.destroy()
    await r.app.dispose()
    r.target.destroy()
  })
})

describe('projection helpers', () => {
  for (const orthographic of [false, true]) {
    it(`worldToScreen agrees with the GPU within 0.5 px (${orthographic ? 'orthographic' : 'perspective'})`, async () => {
      const r = await tabletop(160, 120, 2)
      const { world, meshes, flat } = r
      const dot = meshes.add(sphere({ radius: 0.12, segments: 24 }))
      const points: [number, number, number][] = [
        [0, 0, 0],
        [-2.3, 0.4, 1.1],
        [1.7, -0.3, -1.4],
      ]
      for (const p of points)
        world.spawn(
          [Mesh3d, { mesh: dot }],
          [MeshMaterial, { material: flat([1, 1, 1]) }],
          [Transform, { translation: p }],
        )
      const cam = camera(
        world,
        r.ref,
        [1.5, 4, 6],
        [0, 0, 0],
        orthographic ? { projection: 'orthographic', orthoHeight: 6 } : {},
      )
      const moved = world.reader(CameraMoved)
      r.app.update(1 / 60)
      // Its first frame counts as a move.
      expect(moved.read().filter((m) => m.camera === cam)).toHaveLength(1)
      await settle(r.app)
      const image = await renderView(r.app, `camera:${cam}`)
      for (const p of points) {
        const css = [0, 0]
        expect(worldToScreen(world, cam, p, css)).toBe(true)
        // The GPU's: the centroid of the dot's pixels, in target pixels.
        const cx = css[0]! * 2
        const cy = css[1]! * 2
        let sx = 0
        let sy = 0
        let n = 0
        for (let y = Math.max(0, Math.floor(cy) - 12); y < Math.min(image.height, cy + 12); y++) {
          for (let x = Math.max(0, Math.floor(cx) - 12); x < Math.min(image.width, cx + 12); x++) {
            const v = pixel(image, x, y)[0]!
            if (v > 128) {
              sx += x + 0.5
              sy += y + 0.5
              n++
            }
          }
        }
        expect(n).toBeGreaterThan(4)
        expect(Math.abs(sx / n - cx)).toBeLessThan(0.5)
        expect(Math.abs(sy / n - cy)).toBeLessThan(0.5)
      }
      // A still camera sends nothing more; moving it sends one.
      r.app.update(1 / 60)
      moved.read()
      r.app.update(1 / 60)
      expect(moved.read().length).toBe(0)
      world.set(cam, Transform, {
        translation: [1.6, 4, 6],
        rotation: lookAt([1.6, 4, 6], [0, 0, 0]),
      })
      r.app.update(1 / 60)
      expect(moved.read().filter((m) => m.camera === cam)).toHaveLength(1)
      expect(world.resource(Gpu).errors).toEqual([])
      await r.app.dispose()
      r.target.destroy()
    })
  }
})
