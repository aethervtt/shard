import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { DefaultEnvironment } from './environment'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight } from './lights'
import { renderPlugin } from './plugin'
import { Fog } from './post'
import { worldToScreen } from './projection'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { pixel, renderView, settle } from './testing'
import { Ink, Toon } from './toon'
import { Tonemapping } from './view'
import { FogVolume, VolumetricFog } from './volumetric-fog'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

type Vec3 = [number, number, number]
const W = 160
const H = 120
const EYE: Vec3 = [0, 1.6, 0]

interface Look {
  toon: boolean
  ink: boolean
  volumetric: boolean
  atmosphere?: boolean
  distance?: number
  density?: number
  mist?: number
  msaa?: 1 | 4
}

/** A red box 30 m away on grey ground, in thick fog, and how its pixels read. */
async function render(o: Look) {
  const BOX: Vec3 = [0, 1, -(o.distance ?? 30)]
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: o.msaa ?? 1 }),
  )
  await app.init()
  const world = app.world
  world.resource(AmbientLight).brightness = 2000
  if (o.atmosphere) world.resource(DefaultEnvironment).sky = { turbidity: 2.2 }
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const grey = materials.add(new MaterialAsset({ baseColor: [0.4, 0.4, 0.4, 1], roughness: 1 }))
  const red = materials.add(new MaterialAsset({ baseColor: [0.8, 0.05, 0.05, 1], roughness: 1 }))
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 400 })) }],
    [MeshMaterial, { material: grey }],
    [Transform, {}],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 4, y: 2, z: 2 })) }],
    [MeshMaterial, { material: red }],
    [Transform, { translation: BOX }],
  )
  world.spawn(
    [DirectionalLight, { illuminance: 20000, shadows: false }],
    [Transform, { rotation: lookAt([0, 0, 0], [0.3, -1, -0.4]) }],
  )
  const target = new OffscreenTarget(gpu, { label: 'fog-toon', width: W, height: H })
  const ref = world.resource(RenderTargets).add(target, `fog-toon-${Math.random()}`)
  const cam = world.spawn(
    [Camera3d, { target: ref as never, fovY: 30, clearColor: [0.02, 0.02, 0.05, 1] }],
    [Exposure, { ev100: 13 }],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: EYE, rotation: lookAt(EYE, BOX) }],
    [Fog, { density: o.density ?? 0.12, heightFalloff: 0, color: [0.8, 0.84, 0.9, 1] }],
  )
  if (o.mist) {
    world.spawn(
      [Transform, { translation: [0, 2.5, 0], scale: [140, 7, 140] }],
      [FogVolume, { shape: 'box', density: o.mist, edge: 0.35 }],
    )
  }
  if (o.volumetric) world.add(cam, VolumetricFog, { distance: 96 })
  if (o.toon) world.add(cam, Toon, { bands: 3 })
  if (o.ink) world.add(cam, Ink, { width: 2, color: [0, 0, 0, 1] })
  await settle(app, 60)
  const image = await renderView(app, `camera:${cam}`)
  const at = (x: number, y: number) => pixel(image, x, y).slice(0, 3) as Vec3
  const s = new Float32Array(3)
  worldToScreen(world, cam, BOX, s)
  const cx = Math.round(s[0]! - 0.5)
  const cy = Math.round(s[1]! - 0.5)
  // The box's middle, and the darkest pixel on a ring around its outline.
  const center = at(cx, cy)
  let darkest = Number.POSITIVE_INFINITY
  for (let y = cy - 24; y <= cy + 24; y++)
    for (let x = cx - 30; x <= cx + 30; x++) {
      const [r, g, b] = at(x, y)
      darkest = Math.min(darkest, 0.2126 * r + 0.7152 * g + 0.0722 * b)
    }
  const sky = at(cx, 4)
  await app.dispose()
  return { center, darkest, sky }
}

/** How red a color is: red over the mean of green and blue (the box is red, the fog grey-blue). */
const redness = (c: Vec3) => c[0] / Math.max(1e-6, (c[1] + c[2]) / 2)
const luma = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

// Fog on a camera with Toon and Ink (0108, 0132): the fog covers toon-shaded surfaces as it does
// any other, and ink lines fade into it with what they outline instead of drawing over it.
describe('fog on Toon and Ink cameras', () => {
  for (const volumetric of [false, true]) {
    it(`hides a box 30 m into thick fog, its outline too (${volumetric ? 'volumetric' : 'height'} fog)`, async () => {
      const r = await render({ toon: true, ink: true, volumetric, atmosphere: true })
      // Mostly fog: barely redder than the grey-blue fog (a clear box reads about 14).
      expect(redness(r.center)).toBeLessThan(1.3)
      // No line at full strength (black) around it: at most a faint darkening of the fog.
      expect(r.darkest).toBeGreaterThan(0.8 * luma(r.center))
    }, 60_000)
  }
})
