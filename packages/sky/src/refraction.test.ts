import { t, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, plane } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  type CapturedBuffer,
  captureBuffer,
  defineMaterial,
  describeRender,
  Exposure,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Shaders,
  SkyOcclusion,
  Tonemapping,
  worldToScreen,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setTimeOfDay } from './clock'
import { Clouds, Sky } from './components'
import { skyPlugin } from './plugin'

// Cloud shadows (0131) and refracting materials (0129) both add to the view group: with the sky
// installed, a refracting draw used to fail its layout (both took binding 19).

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
})

/** Glass that shows what's behind it, untinted. */
const Glass = defineMaterial('test/SkyGlass', {
  fields: { unused: t.f32({ default: 0 }) },
  shader: 'test::sky_glass',
  refraction: true,
})

const GLASS = `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import shard::refraction::{ refraction_uv, refraction_color };

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  p.base_color = vec3f(0.0);
  p.emissive = refraction_color(refraction_uv(in.clip), 0.0);
  return p;
}`

type Vec3 = [number, number, number]
const EYE: Vec3 = [0, 2.5, 5]
const AT: Vec3 = [0, -0.3, 0]

async function scene() {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin(),
    skyPlugin,
  )
  await app.init()
  const world = app.world
  world.resource(Shaders).register('test::sky_glass', GLASS, 'shaders/sky_glass.wesl')
  setTimeOfDay(world, 11)
  world.spawn([Sky, { mode: 'volumetric' }], [Clouds, { coverage: 0.5, quality: 'low' }])
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const gray = materials.add(new MaterialAsset({ baseColor: [0.6, 0.6, 0.6, 1], roughness: 1 }))
  const red = materials.add(new MaterialAsset({ baseColor: [0.85, 0.1, 0.1, 1], roughness: 1 }))
  const glass = materials.add(new MaterialAsset({ roughness: 1 }, Glass))
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
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 4 })) }],
    [MeshMaterial, { material: glass }],
    [Transform, {}],
  )
  const target = new OffscreenTarget(gpu, { label: 'sky-refraction', width: 160, height: 120 })
  const ref = world.resource(RenderTargets).add(target, 'sky-refraction')
  const camera = world.spawn(
    [Camera3d, { target: ref as never, fovY: 50, clearColor: [0, 0, 0, 1] }],
    [Exposure, { ev100: 14 }],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: EYE, rotation: lookAt(EYE, AT) }],
  )
  return { app, world, camera }
}

const screen = new Float32Array(3)

function hdrAt(world: World, cam: number, image: CapturedBuffer, p: Vec3): number[] {
  worldToScreen(world, cam as never, p, screen)
  const x = Math.round(screen[0]! - 0.5)
  const y = Math.round(screen[1]! - 0.5)
  const o = (y * image.width + x) * 4
  return [image.data[o]!, image.data[o + 1]!, image.data[o + 2]!]
}

describe('refraction with the sky (0129, 0131)', () => {
  it('draws a refracting material in a view with cloud shadows on', async () => {
    const { app, world, camera } = await scene()
    expect(world.resource(SkyOcclusion).enabled).toBe(true)
    await settle(app, 80)
    const pending = captureBuffer(world, `camera:${camera}`, 'hdr')
    app.update(1 / 60)
    const image = await pending
    const order = (describeRender(world) as { perView: Record<string, { order: string[] }> })
      .perView[`camera:${camera}`]!.order
    expect(order).toContain('refraction')
    const errors = world
      .resource(LogResource)
      .tail(500, 'error')
      .map((e) => `${e.code ?? ''} ${e.message}`)
    expect(errors).toEqual([])
    // The box under the glass, seen through it: red, not black (a skipped draw) or the floor.
    const [r, g, b] = hdrAt(world, camera, image, [-0.25, -0.3, 0.5])
    expect(r!).toBeGreaterThan(0)
    expect(r! / (r! + g! + b!)).toBeGreaterThan(0.5)
  }, 60_000)
})
