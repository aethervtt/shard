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
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { UiDefaults, UiImage, UiInteraction, UiLayout, UiRoot } from './components'
import { describeUi } from './methods'
import { uiPlugin } from './plugin'
import { UiRenderer } from './render'
import { interFont, mouse } from './testing'
import { UiThemeAsset, UiThemes } from './theme'

const here = dirname(fileURLToPath(import.meta.url))
let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** The baseline tier (0064) on a compatibility device: goldens marked for it hold there too. */
let compat: GpuContext | undefined
const TIERS = ['full', 'baseline'] as const

/** Runs the rest of this test on `tier`'s device (`gpu` is swapped back when it finishes). */
async function onTier(tier: (typeof TIERS)[number]): Promise<void> {
  if (tier === 'full') return
  compat ??= await createNodeGpuContext({ tier: 'baseline' })
  const saved = gpu
  gpu = compat
  onTestFinished(() => {
    gpu = saved
  })
}
afterAll(() => compat?.destroy())

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

/** The look of a duel HUD (0094): cut and slanted panels, gradients, shadows, glows, outlined text. */
const EFFECTS = {
  version: 1,
  root: {
    name: 'fx',
    components: { 'ui/UiRoot': { referenceSize: [W, H] }, 'ui/UiNode': {} },
    children: [
      {
        name: 'banner',
        components: {
          'ui/UiNode': {
            position: 'absolute',
            left: 40,
            top: 20,
            width: 200,
            height: 30,
            padding: [0, 0, 0, 12],
            alignItems: 'center',
          },
          'ui/UiStyle': {
            background: '#1e4fa3',
            gradient: 'linear',
            gradientAngle: 90,
            gradientColor: '#0b1d3f',
            cut: [0, 0, 20, 0],
            cutHeight: [0, 0, 30, 0],
          },
        },
        children: [
          {
            name: 'name',
            components: { 'ui/UiText': { text: 'PATRICK', size: 18, textShadowOffset: [1, 2] } },
          },
        ],
      },
      {
        name: 'panel',
        components: {
          'ui/UiNode': {
            position: 'absolute',
            left: 40,
            top: 54,
            width: 300,
            height: 70,
            padding: [0, 0, 0, 24],
            alignItems: 'center',
          },
          'ui/UiStyle': {
            background: [0.03, 0.035, 0.05, 0.92],
            gradient: 'linear',
            gradientColor: '#3b82f6',
            gradientRange: [0.92, 0.92],
            borderColor: [0.5, 0.55, 0.65, 0.6],
            borderWidth: 1,
            cut: [0, 0, 30, 0],
            cutHeight: [0, 0, 70, 0],
            shadowOffset: [6, 8],
            shadowBlur: 10,
          },
        },
        children: [
          {
            name: 'lp',
            components: {
              'ui/UiText': {
                text: '8000',
                size: 48,
                color: '#fff5d6',
                outlineWidth: 1.5,
                textShadowOffset: [2, 3],
                textShadowSoftness: 0.3,
              },
            },
          },
        ],
      },
      {
        name: 'stats',
        components: {
          'ui/UiNode': { position: 'absolute', left: 40, top: 134, width: 260, height: 26 },
          'ui/UiStyle': {
            background: [0, 0, 0, 0.8],
            gradient: 'linear',
            gradientAngle: 90,
            gradientColor: [0, 0, 0, 0],
          },
        },
      },
      {
        name: 'medallion',
        components: {
          'ui/UiNode': {
            position: 'absolute',
            left: 370,
            top: 24,
            width: 80,
            height: 80,
            justify: 'center',
            alignItems: 'center',
          },
          'ui/UiStyle': {
            background: '#f5d76e',
            gradient: 'radial',
            gradientColor: '#8a5a12',
            gradientRange: [0.7, 1],
            radius: [40, 40, 40, 40],
          },
        },
        children: [
          {
            name: 'face',
            components: {
              'ui/UiNode': { width: 60, height: 60 },
              'ui/UiStyle': {
                background: '#1d4ed8',
                gradient: 'radial',
                gradientColor: '#0b1d3f',
                radius: [30, 30, 30, 30],
                borderColor: '#f5d76e',
                borderWidth: 1.5,
              },
            },
          },
        ],
      },
      {
        name: 'diamond',
        components: {
          'ui/UiNode': { position: 'absolute', left: 398, top: 126, width: 24, height: 24 },
          'ui/UiStyle': {
            background: '#fff5d6',
            cut: [12, 12, 12, 12],
            glowColor: [1, 0.75, 0.2, 0.9],
            glowBlur: 10,
          },
        },
      },
      {
        name: 'backdrop',
        components: {
          'ui/UiNode': { position: 'absolute', left: 30, top: 176, width: 310, height: 84 },
          'ui/UiStyle': { background: [0.7, 0.72, 0.75, 1] },
        },
      },
      ...[
        ['glass', 50, { shadowOffset: [10, 10], shadowBlur: 4 }],
        ['plain-glass', 190, {}],
      ].map(([name, left, extra]) => ({
        name,
        components: {
          'ui/UiNode': { position: 'absolute', left, top: 190, width: 80, height: 40 },
          'ui/UiStyle': { background: [0.1, 0.2, 0.4, 0.5], ...(extra as object) },
        },
      })),
      ...[
        ['orb', 360, { glowColor: [1, 0.8, 0.3, 0.8], glowBlur: 8 }],
        ['plain-orb', 420, {}],
      ].map(([name, left, extra]) => ({
        name,
        components: {
          'ui/UiNode': { position: 'absolute', left, top: 200, width: 40, height: 40 },
          'ui/UiStyle': {
            background: [0.1, 0.1, 0.1, 0.5],
            radius: [20, 20, 20, 20],
            ...(extra as object),
          },
        },
      })),
    ],
  },
}

async function hudScene(world3d = false, prefab: object = HUD) {
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
  registerPrefab(world, 'prefabs/hud.prefab.json', prefab)
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
  const waypoint = findEntityByPath(world, 'hud/waypoint')
  if (waypoint)
    world.set(waypoint, UiImage, { texture: world.resource(Textures).add(frameTexture()) })
  return { app, world, camera }
}

describe('UI rendering', () => {
  for (const tier of TIERS)
    it(`renders a HUD prefab: rounded bordered panels, nine-slice image, wrapped text, clipped scroll (golden, ${tier} tier)`, {
      timeout: timeout(60_000),
    }, async () => {
      await onTier(tier)
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

  for (const tier of TIERS)
    it(`renders effects: gradients, cut corners, shadows, glows, outlined text (golden, ${tier} tier)`, {
      timeout: timeout(60_000),
    }, async () => {
      await onTier(tier)
      const { app, world, camera } = await hudScene(false, EFFECTS)
      await settle(app)
      const shot = captureView(world, `camera:${camera}`)
      app.update(1 / 60)
      const image = await shot
      expect(world.resource(Gpu).errors).toEqual([])
      expect(world.resource(LogResource).errors()).toEqual([])
      expect(compareGolden(here, 'effects', image).mean).toBeLessThan(1.5)
      const at = (path: string) => world.get(findEntityByPath(world, `hud/${path}`)!, UiLayout)
      const px = (x: number, y: number) => pixel(image, Math.round(x), Math.round(y))
      const sum = (c: number[]) => c[0]! + c[1]! + c[2]!
      const clear = pixel(image, 2, 2)
      // The banner's slanted end: its bottom-right corner is cut away, just inside is its fill.
      const banner = at('banner')
      expect(px(banner.x + banner.width - 3, banner.y + banner.height - 3)).toEqual(clear)
      const fill = px(banner.x + banner.width - 26, banner.y + banner.height - 3)
      // (The gradient's dark navy end: far less red than the gray behind.)
      expect(fill[0]!).toBeLessThan(clear[0]! - 30)
      // Its linear gradient runs left (lighter blue) to right (darker).
      const left = px(banner.x + 4, banner.y + 4)
      const right = px(banner.x + banner.width - 40, banner.y + 4)
      expect(left[2]!).toBeGreaterThan(right[2]! + 30)
      // The panel's accent stripe at the bottom is blue, its body dark; the stripe follows the cut.
      const panel = at('panel')
      const stripe = px(panel.x + 100, panel.y + panel.height - 2)
      const body = px(panel.x + 100, panel.y + 30)
      expect(stripe[2]!).toBeGreaterThan(200)
      expect(body[2]!).toBeLessThan(stripe[2]! - 100)
      expect(px(panel.x + panel.width - 4, panel.y + panel.height - 2)).not.toEqual(stripe)
      // Its drop shadow darkens the clear color below and right of it.
      const below = px(panel.x + 150, panel.y + panel.height + 6)
      expect(sum(below)).toBeLessThan(sum(clear) - 10)
      // The stats row fades out to the right.
      const stats = at('stats')
      expect(sum(px(stats.x + 4, stats.y + 13))).toBeLessThan(sum(px(stats.x + 250, stats.y + 13)))
      // A shadow under a translucent box: outside it darkens, under the box it doesn't show.
      const glass = at('glass')
      const plain = at('plain-glass')
      const backdrop = px(plain.x + plain.width + 20, plain.y + 20)
      expect(sum(px(glass.x + glass.width + 5, glass.y + 25))).toBeLessThan(sum(backdrop) - 40)
      expect(px(glass.x + glass.width - 5, glass.y + glass.height - 5)).toEqual(
        px(plain.x + plain.width - 5, plain.y + plain.height - 5),
      )
      // A glow brightens around the node, and isn't drawn under it.
      const orb = at('orb')
      const plainOrb = at('plain-orb')
      expect(sum(px(orb.x - 3, orb.y + 20))).toBeGreaterThan(sum(clear) + 30)
      expect(px(plainOrb.x - 3, plainOrb.y + 20)).toEqual(clear)
      expect(px(orb.x + 20, orb.y + 20)).toEqual(px(plainOrb.x + 20, plainOrb.y + 20))
      // The diamond: its corners are cut to the edge midpoints, its center is filled.
      const diamond = at('diamond')
      expect(sum(px(diamond.x + 12, diamond.y + 12))).toBeGreaterThan(600)
      expect(sum(px(diamond.x + 1, diamond.y + 1))).toBeLessThan(500)
    })

  it('a theme state variant adds a glow when the button is hovered', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, camera } = await hudScene(false, {
      version: 1,
      root: {
        name: 'menu',
        components: { 'ui/UiRoot': { referenceSize: [W, H] }, 'ui/UiNode': {} },
        children: [
          {
            name: 'play',
            components: {
              'ui/UiNode': {
                position: 'absolute',
                left: 200,
                top: 110,
                width: 80,
                height: 40,
                style: 'button',
              },
              'ui/UiButton': {},
            },
          },
        ],
      },
    })
    const theme = UiThemeAsset.fromJson({
      styles: {
        button: { background: '#203040', cut: [8, 0, 8, 0] },
        'button:hovered': { glowColor: [0.4, 0.8, 1, 1], glowBlur: 8 },
      },
    })
    world.set(findEntityByPath(world, 'hud')!, UiRoot, {
      theme: world.resource(UiThemes).add(theme) as never,
    })
    await settle(app)
    const capture = async () => {
      const shot = captureView(world, `camera:${camera}`)
      app.update(1 / 60)
      return shot
    }
    const before = await capture()
    const quads = world.resource(UiRenderer).count
    mouse(world, 240, 130)
    app.update(1 / 60)
    const after = await capture()
    expect(world.get(findEntityByPath(world, 'hud/play')!, UiInteraction).state).toBe('hovered')
    expect(world.resource(UiRenderer).count).toBe(quads + 1)
    const near = (image: typeof before) => pixel(image, 197, 130)
    expect(near(after)[2]!).toBeGreaterThan(near(before)[2]! + 40)
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
