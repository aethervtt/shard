import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { inputPlugin } from '@aethervtt/shard-input'
import { box } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  captureView,
  describeRender,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  pick,
  RenderTargets,
  renderPlugin,
  setOverlays,
  Tonemapping,
} from '@aethervtt/shard-render'
import { compareGolden, pixel, settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import {
  findEntityByPath,
  loadScene,
  registerPrefab,
  ScenePlugin,
  updateInstances,
} from '@aethervtt/shard-scene'
import { Fonts } from '@aethervtt/shard-text'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UiDefaults, UiImage, UiLayout } from './components'
import { describeUi } from './methods'
import { uiPlugin } from './plugin'
import { UiRenderer } from './render'
import { interFont } from './testing'

const here = dirname(fileURLToPath(import.meta.url))
let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const W = 480
const H = 270

/** A HUD, as a prefab: scanner panel (wrapped text, a fuel bar, a scrolled list) and a waypoint card. */
const HUD = {
  version: 1,
  root: {
    name: 'hud',
    components: {
      'ui/UiRoot': { referenceSize: [W, H] },
      'ui/UiNode': { padding: [14, 14, 14, 14], justify: 'space-between', alignItems: 'start' },
    },
    children: [
      {
        name: 'scanner',
        components: {
          'ui/UiNode': { width: 190, direction: 'column', padding: [10, 12, 10, 12], gap: [0, 8] },
          'ui/UiStyle': {
            background: [0.02, 0.04, 0.08, 0.85],
            borderColor: '#5dade2',
            borderWidth: 2,
            radius: [12, 12, 12, 12],
          },
        },
        children: [
          {
            name: 'title',
            components: { 'ui/UiText': { text: 'SCANNER', size: 18, color: '#f5cb5c' } },
          },
          {
            name: 'body',
            components: {
              'ui/UiText': { text: 'Carbon 42%. Ferrite dust detected near the ridge.', size: 13 },
            },
          },
          {
            name: 'fuel',
            components: {
              'ui/UiNode': { height: 10 },
              'ui/UiStyle': { background: [0.1, 0.1, 0.12, 1], radius: [5, 5, 5, 5] },
            },
            children: [
              {
                name: 'fill',
                components: {
                  'ui/UiNode': { width: '70%' },
                  'ui/UiStyle': { background: '#e67e22', radius: [5, 5, 5, 5] },
                },
              },
            ],
          },
          {
            name: 'list',
            components: {
              'ui/UiNode': { height: 50, overflow: 'scroll', direction: 'column', scroll: [0, 12] },
              'ui/UiStyle': { background: [0.05, 0.08, 0.12, 1], radius: [4, 4, 4, 4] },
            },
            children: [0, 1, 2, 3, 4].map((i) => ({
              name: `item${i}`,
              components: {
                'ui/UiNode': { height: 18, shrink: 0, padding: [0, 6, 0, 6] },
                'ui/UiText': { text: `Sample ${i + 1}`, size: 12, color: '#aed6f1' },
              },
            })),
          },
        ],
      },
      {
        name: 'waypoint',
        components: {
          'ui/UiNode': { width: 150, height: 90, justify: 'center', alignItems: 'center' },
          'ui/UiImage': { slice: [8, 8, 8, 8] },
        },
        children: [
          {
            name: 'label',
            components: { 'ui/UiText': { text: 'Waypoint', size: 16, align: 'center' } },
          },
        ],
      },
    ],
  },
}

/** A 24×24 frame: an 8 px light border with dark corners around a dark blue middle. */
function frameTexture(): Texture {
  const size = 24
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y)
      const corner = (x < 8 || x >= 16) && (y < 8 || y >= 16)
      const o = (y * size + x) * 4
      const c =
        edge < 3
          ? [230, 240, 255, 255]
          : corner
            ? [60, 90, 140, 255]
            : edge < 8
              ? [120, 160, 220, 255]
              : [20, 30, 60, 230]
      data.set(c, o)
    }
  }
  return Texture.create({ width: size, height: size, mips: [data] })
}

async function hudScene(world3d = false) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    inputPlugin(),
    ScenePlugin,
    uiPlugin,
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'ui', width: W, height: H })
  const targetRef = world.resource(RenderTargets).add(target, 'ui')
  world.resource(UiDefaults).font = world.resource(Fonts).add(interFont())
  const camera = world.spawn(
    [Camera3d, { target: targetRef as never, clearColor: [0.08, 0.1, 0.14, 1] }],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: [0, 0, 5] }],
  )
  if (world3d) {
    const material = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [0.4, 0.4, 0.4, 1] }))
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 40, y: 40, z: 0.1 })) }],
      [MeshMaterial, { material }],
      Transform,
    )
  }
  registerPrefab(world, 'prefabs/hud.prefab.json', HUD)
  loadScene(world, {
    version: 1,
    entities: [
      {
        name: 'hud',
        components: { 'scene/PrefabInstance': { prefab: { path: 'prefabs/hud.prefab.json' } } },
      },
    ],
  })
  updateInstances(world)
  const waypoint = findEntityByPath(world, 'hud/waypoint')!
  world.set(waypoint, UiImage, { texture: world.resource(Textures).add(frameTexture()) })
  return { app, world, camera }
}

describe('UI rendering', () => {
  it('renders a HUD prefab: rounded bordered panels, nine-slice image, wrapped text, clipped scroll (golden)', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, camera } = await hudScene()
    await settle(app)
    const shot = captureView(world, `camera:${camera}`)
    app.update(1 / 60)
    const image = await shot
    expect(world.resource(Gpu).errors).toEqual([])
    expect(world.resource(LogResource).errors()).toEqual([])
    expect(compareGolden(here, 'hud', image).mean).toBeLessThan(1.5)
    // The body wrapped, and the list clips its third item mid-way.
    const body = world.get(findEntityByPath(world, 'hud/scanner/body')!, UiLayout)
    expect(body.height).toBeGreaterThan(13 * 1.2 * 1.5)
    const item3 = world.get(findEntityByPath(world, 'hud/scanner/list/item3')!, UiLayout)
    expect(item3.clip[3]).toBeGreaterThan(0)
    expect(item3.clip[3]).toBeLessThan(item3.height)
    // Rounded corner: the panel's very corner pixel is background, its border is blue.
    const panel = world.get(findEntityByPath(world, 'hud/scanner')!, UiLayout)
    const corner = pixel(image, Math.round(panel.x), Math.round(panel.y))
    expect(corner).toEqual(pixel(image, 2, 2))
    const edge = pixel(image, Math.round(panel.x + panel.width / 2), Math.round(panel.y) + 1)
    expect(edge[2]).toBeGreaterThan(150)
  })

  it('uploads nothing on an unchanged frame', { timeout: timeout(60_000) }, async () => {
    const { app, world } = await hudScene()
    await settle(app)
    app.update(1 / 60)
    const render = describeRender(world).ui as {
      uploadedBytes: number
      quads: number
      drawCalls: number
    }
    expect(render.quads).toBeGreaterThan(50)
    expect(render.uploadedBytes).toBe(0)
    expect(world.resource(UiRenderer).rebuilds).toBe(0)
    expect(describeUi(world).frame).toMatchObject({ layouts: 0, render: { uploadedBytes: 0 } })
    // A text change rebuilds once.
    world.set(
      findEntityByPath(world, 'hud/scanner/title')!,
      (await import('./components')).UiText,
      {
        text: 'SCANNING',
      },
    )
    app.update(1 / 60)
    expect(world.resource(UiRenderer).rebuilds).toBe(1)
    app.update(1 / 60)
    expect(world.resource(UiRenderer).rebuilds).toBe(0)
  })

  it('world picks under the HUD hit the UI, not the world', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, camera } = await hudScene(true)
    await settle(app)
    const panel = world.get(findEntityByPath(world, 'hud/scanner')!, UiLayout)
    const onPanel = pick(world, camera, panel.x + 20, panel.y + 20)
    const offPanel = pick(world, camera, W / 2, H - 10)
    await settle(app, 4)
    expect(await onPanel).toBeUndefined()
    expect((await offPanel)?.entity).toBeDefined()
  })

  it('draws the ui-layout overlay', { timeout: timeout(60_000) }, async () => {
    const { app, world } = await hudScene()
    await settle(app)
    const before = world.resource(UiRenderer).count
    setOverlays(world, { 'ui-layout': true })
    app.update(1 / 60)
    expect(world.resource(UiRenderer).count).toBeGreaterThan(before + 10)
  })
})
