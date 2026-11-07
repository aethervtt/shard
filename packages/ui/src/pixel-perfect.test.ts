import { ChildOf } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { inputPlugin } from '@aethervtt/shard-input'
import { box, plane } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  type CapturedImage,
  captureView,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  PixelPerfect,
  pick,
  RenderTargets,
  renderPlugin,
  screenToPlane,
  screenToRay,
  Tonemapping,
  worldToScreen,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UiAnchor, UiLayout, UiNode, UiRoot, UiStyle } from './components'
import { uiPlugin } from './plugin'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

// 10 units tall at 7 texels per unit is 70 texels: scale 4 on 310 pixels, so the image is 77 texels
// (11 units) tall, 125 wide, letterboxed 1.5 pixels left and right and 1 top and bottom.
const W = 503
const H = 310
const RATIO = 2
const EYE: [number, number, number] = [0.3, 9, 9.2]
const BOX: [number, number, number] = [2.5, 0.5, -1]

/** A floor, a red box on it, an isometric orthographic camera, and a HUD pinned to the camera. */
async function scene(pixelPerfect: boolean) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    inputPlugin(),
    uiPlugin,
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'pp', width: W, height: H, pixelRatio: RATIO })
  const ref = world.resource(RenderTargets).add(target, 'pp')
  world.resource(AmbientLight).brightness = 2000
  const material = (color: number[]) =>
    world.resource(Materials).add(new MaterialAsset({ baseColor: color, roughness: 1 }))
  const floor = world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 40 })) }],
    [MeshMaterial, { material: material([0.3, 0.32, 0.35, 1]) }],
    Transform,
  )
  const crate = world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 1, y: 1, z: 1 })) }],
    [MeshMaterial, { material: material([0.9, 0.05, 0.05, 1]) }],
    [Transform, { translation: BOX }],
  )
  const camera = world.spawn(
    [
      Camera3d,
      {
        target: ref as never,
        projection: 'orthographic',
        orthoHeight: 10,
        far: 100,
        clearColor: [0.05, 0.05, 0.08, 1],
      },
    ],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: EYE, rotation: lookAt(EYE, [0, 0, 0]) as never }],
  )
  if (pixelPerfect) world.add(camera, PixelPerfect, { pixelsPerUnit: 7 })
  const root = world.spawn([UiRoot, { camera }], [UiNode, { width: '100%', height: '100%' }])
  // A settings button in the top right corner, and a name tag over the crate.
  const button = world.spawn(
    [UiNode, { position: 'absolute', right: 12, top: 12, width: 64, height: 28 }],
    [ChildOf, { parent: root }],
    [
      UiStyle,
      {
        background: [0.9, 0.85, 0.3, 1],
        borderColor: [0.1, 0.2, 0.6, 1],
        borderWidth: 3,
        radius: [8, 8, 8, 8],
      },
    ],
  )
  const tag = world.spawn(
    [UiNode, { width: 10, height: 10 }],
    [ChildOf, { parent: root }],
    [UiStyle, { background: [0.2, 0.9, 0.3, 1] }],
    [UiAnchor, { target: crate }],
  )
  return { app, world, camera, button, tag, crate, floor }
}

async function shoot(app: App, view: string): Promise<CapturedImage> {
  await settle(app)
  const shot = captureView(app.world, view)
  app.update(1 / 60)
  return shot
}

/** Centroid of the pixels `match` picks, in target pixels. */
function centroid(image: CapturedImage, match: (r: number, g: number, b: number) => boolean) {
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const o = (y * image.width + x) * 4
      if (!match(image.data[o]!, image.data[o + 1]!, image.data[o + 2]!)) continue
      sx += x + 0.5
      sy += y + 0.5
      n++
    }
  }
  return { x: sx / n, y: sy / n, n }
}

const red = (r: number, g: number, b: number) => r > 120 && g < 60 && b < 60

describe('UI on a PixelPerfect camera', () => {
  it('draws at display resolution over the upscaled image: the same size and pixels as on a plain camera', {
    timeout: timeout(60_000),
  }, async () => {
    const plain = await scene(false)
    const crisp = await scene(true)
    // The tag hides the crate's middle: leave only the button.
    plain.world.despawn(plain.tag)
    crisp.world.despawn(crisp.tag)
    const a = await shoot(plain.app, `camera:${plain.camera}`)
    const b = await shoot(crisp.app, `pixel-perfect:${crisp.camera}`)
    for (const s of [plain, crisp]) {
      expect(s.world.resource(Gpu).errors).toEqual([])
      expect(s.world.resource(LogResource).errors()).toEqual([])
    }
    const la = plain.world.get(plain.button, UiLayout)
    const lb = crisp.world.get(crisp.button, UiLayout)
    expect([lb.x, lb.y, lb.width, lb.height]).toEqual([la.x, la.y, la.width, la.height])
    expect(lb.x + lb.width).toBe(W - 12)
    // Every pixel of the button (border, rounded corners, fill) matches the plain camera's.
    let differ = 0
    for (let y = Math.floor(lb.y); y < Math.ceil(lb.y + lb.height); y++) {
      for (let x = Math.floor(lb.x); x < Math.ceil(lb.x + lb.width); x++) {
        const o = (y * W + x) * 4
        for (let k = 0; k < 3; k++) if (Math.abs(a.data[o + k]! - b.data[o + k]!) > 2) differ++
      }
    }
    expect(differ).toBe(0)
    // Its 3-pixel border is 3 pixels: not a 4×4-texel block.
    const mid = Math.round(lb.y + lb.height / 2)
    const redAt = (x: number) => b.data[(mid * W + x) * 4]!
    const left = Math.round(lb.x)
    expect([redAt(left), redAt(left + 1), redAt(left + 2)].every((v) => v < 150)).toBe(true)
    expect(redAt(left + 3)).toBeGreaterThan(200)
  })

  it('places an anchored node over its target, letterbox, fitted height, and snapping included', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, camera, tag } = await scene(true)
    // Where the crate is drawn, without the tag over it.
    world.set(tag, UiStyle, { opacity: 0 })
    const image = await shoot(app, `pixel-perfect:${camera}`)
    const drawn = centroid(image, red)
    expect(drawn.n).toBeGreaterThan(100)
    const l = world.get(tag, UiLayout)
    // The tag's center (pivot 0.5) sits on the crate's middle: within a texel (4 pixels).
    expect(Math.abs(l.x + 5 - drawn.x)).toBeLessThan(2)
    expect(Math.abs(l.y + 5 - drawn.y)).toBeLessThan(2)
    // worldToScreen agrees, in CSS pixels.
    const css = [0, 0]
    expect(worldToScreen(world, camera, BOX, css)).toBe(true)
    expect(Math.abs(css[0]! * RATIO - drawn.x)).toBeLessThan(2)
    expect(Math.abs(css[1]! * RATIO - drawn.y)).toBeLessThan(2)
  })

  it('picks what is under the cursor through the letterboxed image', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, camera, crate, floor, tag } = await scene(true)
    world.despawn(tag)
    const image = await shoot(app, `pixel-perfect:${camera}`)
    const drawn = centroid(image, red)
    // GPU picking takes target pixels.
    const onCrate = pick(world, camera, drawn.x, drawn.y)
    const onFloor = pick(world, camera, 60, H - 40)
    await settle(app, 4)
    expect((await onCrate)?.entity).toBe(crate)
    const floorHit = await onFloor
    expect(floorHit?.entity).toBe(floor)
    // The ray under the crate's middle (CSS pixels) passes through the crate's center.
    const origin = [0, 0, 0]
    const dir = [0, 0, 0]
    screenToRay(world, camera, drawn.x / RATIO, drawn.y / RATIO, origin, dir)
    const to = [BOX[0] - origin[0]!, BOX[1] - origin[1]!, BOX[2] - origin[2]!]
    const along = to[0]! * dir[0]! + to[1]! * dir[1]! + to[2]! * dir[2]!
    const miss = Math.hypot(
      to[0]! - along * dir[0]!,
      to[1]! - along * dir[1]!,
      to[2]! - along * dir[2]!,
    )
    expect(miss).toBeLessThan(0.15)
    // The floor point under a pixel is where the GPU found the floor, within a texel.
    const hit = [0, 0, 0]
    expect(screenToPlane(world, camera, 60 / RATIO, (H - 40) / RATIO, 0, hit)).toBe(true)
    const p = floorHit!.position
    expect(Math.hypot(hit[0]! - p[0], hit[2]! - p[2])).toBeLessThan(0.3)
  })
})
