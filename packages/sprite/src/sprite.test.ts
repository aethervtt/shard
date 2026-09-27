import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer, findAssetPreview } from '@aethervtt/shard-assets'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import {
  Camera3d,
  captureView,
  describeRender,
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  PixelPerfect,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { compareGolden, pngBytes, settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TextureAtlas, TextureAtlases } from './atlas'
import { SpriteAnimation, SpriteAnimationEvent, SpriteClip, SpriteClips } from './clip'
import { spritePlugin } from './plugin'
import { Sprites, Tilemaps } from './render'
import { Sprite } from './sprite'
import { setTile, Tilemap, TilemapData, TilemapDatas, tileAt } from './tilemap'
import './index'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))
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
  const target = new OffscreenTarget(gpu, { label: 'sprites', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'sprites')
  const camera = (height = 10, extra: unknown[] = []) =>
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
      ...(extra as []),
    )
  return { app, world: app.world, camera }
}

type World = Awaited<ReturnType<typeof scene>>['world']

/** A solid (or checkered) texture made in code. */
function solid(world: World, rgba: number[], size = 4, checker?: number[]) {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      data.set(checker && (x + y) % 2 ? checker : rgba, (y * size + x) * 4)
  return world.resource(Textures).add(Texture.create({ width: size, height: size, mips: [data] }))
}

describe('sprites', () => {
  it('sort by layer, then depth (golden image of overlapping sprites)', async () => {
    const { app, world, camera } = await scene(96, 96)
    const red = solid(world, [255, 40, 40, 255])
    const green = solid(world, [40, 255, 40, 255])
    const blue = solid(world, [40, 80, 255, 200])
    // Spawned in the opposite of their draw order: layer beats depth, depth beats spawn order.
    world.spawn(
      [Sprite, { texture: blue, size: [4, 4], layer: 2 }],
      [Transform, { translation: [1.5, 1.5, -5] }],
    )
    world.spawn(
      [Sprite, { texture: green, size: [4, 4], layer: 1 }],
      [Transform, { translation: [0, 0, 3] }],
    )
    world.spawn(
      [Sprite, { texture: red, size: [4, 4], layer: 1 }],
      [Transform, { translation: [-1.5, -1.5, 1] }],
    )
    const cam = camera(10)
    await settle(app)
    const shot = captureView(world, `camera:${cam}`)
    app.update(1 / 60)
    const image = await shot
    expect(compareGolden(here, 'sprites-sorted', image).mean).toBeLessThan(1.5)
    const at = (x: number, y: number) => [
      ...image.data.slice((y * 96 + x) * 4, (y * 96 + x) * 4 + 3),
    ]
    // Green (z 3) over red (z 1) in layer 1; translucent blue (layer 2) over both.
    expect(at(40, 52)[1]).toBeGreaterThan(200) // green over red
    const overlap = at(48, 44)
    expect(overlap[2]).toBeGreaterThan(overlap[0]!) // blue on top
    expect(world.resource(LogResource).errors()).toEqual([])
  })

  it('keeps drawing earlier sprites after the record buffer grows', async () => {
    const { app, world, camera } = await scene(32, 32)
    const red = solid(world, [255, 40, 40, 255])
    world.spawn([Sprite, { texture: red, size: [4, 4] }], [Transform, {}])
    const cam = camera(10)
    const center = async () => {
      await settle(app)
      const shot = captureView(world, `camera:${cam}`)
      app.update(1 / 60)
      const image = await shot
      return [...image.data.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 3)]
    }
    const before = await center()
    expect(before[0]).toBeGreaterThan(200)
    // Offscreen sprites past the first 256 records: the GPU buffer is replaced.
    for (let i = 0; i < 600; i++) {
      world.spawn(
        [Sprite, { texture: red, size: [0.1, 0.1] }],
        [Transform, { translation: [100 + i, 0, 0] }],
      )
    }
    expect(await center()).toEqual(before)
  })

  it('draws 100k sprites from 4 atlases in at most 8 draw calls; a static set uploads nothing', async () => {
    const { app, world, camera } = await scene(64, 64)
    const atlases = world.resource(TextureAtlases)
    const refs = [0, 1, 2, 3].map((k) => {
      const texture = solid(world, [60 * k, 255 - 50 * k, 128, 255], 16)
      return atlases.add(
        new TextureAtlas(texture as never, [
          { name: 'a', rect: [0, 0, 8, 8] },
          { name: 'b', rect: [8, 0, 8, 8] },
        ]),
      )
    })
    for (let i = 0; i < 100_000; i++) {
      const k = i % 4
      world.spawn(
        [Sprite, { atlas: refs[k]!, region: i % 3 ? 'a' : 'b', size: [0.1, 0.1], layer: k }],
        [
          Transform,
          {
            translation: [
              ((i * 7919) % 1000) / 50 - 10,
              ((i * 104729) % 1000) / 50 - 10,
              (i % 17) * 0.1,
            ],
          },
        ],
      )
    }
    camera(20)
    await settle(app, 4)
    const store = world.resource(Sprites)
    expect(store.orderCount).toBe(100_000)
    expect(store.runCount).toBeLessThanOrEqual(8)
    const sorts = store.sorts
    app.update(1 / 60)
    app.update(1 / 60)
    expect(store.uploadedBytes).toBe(0)
    expect(store.sorts).toBe(sorts)
    const d = describeRender(world).sprites as {
      drawCalls: number
      perLayer: Record<string, number>
    }
    expect(d.drawCalls).toBeLessThanOrEqual(8)
    expect(Object.values(d.perLayer)).toEqual([25_000, 25_000, 25_000, 25_000])
  }, 60_000)

  it('packs a folder of 50 images without overlaps, with extruded edges that stop bleeding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-sprites-'))
    roots.push(root)
    mkdirSync(join(root, 'assets/sprites/icons'), { recursive: true })
    const colors: number[][] = []
    for (let i = 0; i < 50; i++) {
      const w = 6 + ((i * 7) % 19)
      const h = 6 + ((i * 11) % 23)
      const c = [(i * 67) % 256, (i * 131 + 80) % 256, (i * 29 + 160) % 256, 255]
      colors.push(c)
      const data = new Uint8Array(w * h * 4)
      for (let p = 0; p < w * h; p++) data.set(c, p * 4)
      writeFileSync(
        join(root, `assets/sprites/icons/icon${String(i).padStart(2, '0')}.png`),
        pngBytes(data, w, h),
      )
    }
    writeFileSync(
      join(root, 'assets/sprites/icons.atlas-pack.json'),
      JSON.stringify({ padding: 2, extrude: 1 }),
    )
    const { app, world, camera } = await scene(160, 160, root)
    const server = assetServer(world)
    await server.whenSettled(['assets/sprites/icons.atlas-pack.json'])
    const ref = server.resolve('assets/sprites/icons.atlas-pack.json') as never
    const atlas = world.resource(TextureAtlases).get(ref)!
    expect(atlas.count).toBe(50)
    // No two regions (with their padding) overlap.
    for (let a = 0; a < 50; a++) {
      for (let b = a + 1; b < 50; b++) {
        const [ax, ay, aw, ah] = atlas.rects.subarray(a * 4, a * 4 + 4)
        const [bx, by, bw, bh] = atlas.rects.subarray(b * 4, b * 4 + 4)
        const apart =
          ax! + aw! + 2 <= bx! ||
          bx! + bw! + 2 <= ax! ||
          ay! + ah! + 2 <= by! ||
          by! + bh! + 2 <= ay!
        expect(apart, `${atlas.names[a]} / ${atlas.names[b]}`).toBe(true)
      }
    }
    // Every sprite scaled up ~3.4× with bilinear filtering: its edge pixels are its own color.
    for (let i = 0; i < 50; i++) {
      const x = (i % 10) * 1.6 - 7.2
      const y = 7.2 - Math.floor(i / 10) * 3
      world.spawn(
        [Sprite, { atlas: ref, region: `icon${String(i).padStart(2, '0')}`, size: [1.3, 2.4] }],
        [Transform, { translation: [x, y, 0] }],
      )
    }
    const cam = camera(18)
    await settle(app)
    const shot = captureView(world, `camera:${cam}`)
    app.update(1 / 60)
    const image = await shot
    expect(compareGolden(here, 'atlas-packed-scaled', image).mean).toBeLessThan(1.5)
    // Each sprite's corner pixels are its own color: nothing from outside its region bled in.
    const ppx = 160 / 18
    let worst = 0
    for (let i = 0; i < 50; i++) {
      const cx = ((i % 10) * 1.6 - 7.2 + 9) * ppx
      const cy = (9 - (7.2 - Math.floor(i / 10) * 3)) * ppx
      const hw = 0.65 * ppx
      const hh = 1.2 * ppx
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        // The outermost pixel whose center the sprite covers: its sample sits within a third of
        // a texel of the edge, where filtering reaches the neighbor texel.
        const ex = cx + sx! * hw
        const ey = cy + sy! * hh
        const px = sx! < 0 ? Math.ceil(ex - 0.5) : Math.floor(ex - 0.5)
        const py = sy! < 0 ? Math.ceil(ey - 0.5) : Math.floor(ey - 0.5)
        const o = (py * 160 + px) * 4
        for (let k = 0; k < 3; k++) {
          worst = Math.max(worst, Math.abs(image.data[o + k]! - colors[i]![k]!))
        }
      }
    }
    expect(worst).toBeLessThan(6)
    // asset.preview: the texture with its regions outlined (magenta) and numbered.
    const preview = await findAssetPreview('TextureAtlas')!(
      world,
      'assets/sprites/icons.atlas-pack.json',
      256,
      256,
    )
    let outlined = 0
    for (let p = 0; p < preview.data.length; p += 4) {
      if (preview.data[p] === 255 && preview.data[p + 1] === 0 && preview.data[p + 2] === 180)
        outlined++
    }
    expect(Math.max(preview.width, preview.height)).toBe(256)
    expect(outlined).toBeGreaterThan(50 * 20)
    // A clip over the packed atlas previews its frames in a row.
    writeFileSync(
      join(root, 'assets/sprites/blink.clip.json'),
      JSON.stringify({
        atlas: { path: 'assets/sprites/icons.atlas-pack.json' },
        frames: [{ region: 'icon00' }, { region: 'icon01' }, { region: 'icon02' }],
      }),
    )
    await server.scan()
    await server.whenSettled(['assets/sprites/blink.clip.json'])
    const strip = await findAssetPreview('SpriteClip')!(
      world,
      'assets/sprites/blink.clip.json',
      300,
      100,
    )
    expect(strip.width).toBeGreaterThan(strip.height)
    const clip = world
      .resource(SpriteClips)
      .get(server.resolve('assets/sprites/blink.clip.json') as never)!
    expect(clip.regions).toEqual(['icon00', 'icon01', 'icon02'])
  }, 60_000)

  it('plays a SpriteClip at its frame durations and sends its events', async () => {
    const { app, world } = await scene(16, 16)
    const texture = solid(world, [255, 255, 255, 255], 8)
    const atlas = world.resource(TextureAtlases).add(
      new TextureAtlas(
        texture as never,
        ['f0', 'f1', 'f2'].map((name, i) => ({ name, rect: [i * 2, 0, 2, 2] })),
      ),
    )
    const clip = world.resource(SpriteClips).add(
      new SpriteClip(
        atlas as never,
        [
          { region: 'f0', duration: 0.1 },
          { region: 'f1', duration: 0.2 },
          { region: 'f2', duration: 0.1 },
        ],
        'loop',
        [
          { frame: 1, name: 'step' },
          { frame: 2, name: 'land' },
        ],
      ),
    )
    const e = world.spawn([Sprite, {}], [SpriteAnimation, { clip }], Transform)
    const reader = world.reader(SpriteAnimationEvent)
    const frames: string[] = []
    const events: string[] = []
    for (let i = 0; i < 20; i++) {
      app.update(0.05)
      frames.push(world.get(e, Sprite)!.region)
      for (const ev of reader.read()) events.push(`${ev.name}@${ev.frame}`)
    }
    // 0.05 s steps over 0.1 / 0.2 / 0.1 s frames, looping every 0.4 s.
    expect(frames.slice(0, 9)).toEqual(['f0', 'f1', 'f1', 'f1', 'f1', 'f2', 'f2', 'f0', 'f0'])
    expect(events.slice(0, 4)).toEqual(['step@1', 'land@2', 'step@1', 'land@2'])
    // Once clips stop on their last frame.
    const once = world.resource(SpriteClips).add(
      new SpriteClip(
        atlas as never,
        [
          { region: 'f0', duration: 0.1 },
          { region: 'f2', duration: 0.1 },
        ],
        'once',
      ),
    )
    world.set(e, SpriteAnimation, { clip: once, time: 0, playing: true })
    for (let i = 0; i < 10; i++) app.update(0.05)
    expect(world.get(e, Sprite)!.region).toBe('f2')
    expect(world.get(e, SpriteAnimation)!.playing).toBe(false)
  })

  it('draws only the visible chunks of a 1024×1024 tilemap, and an edit re-uploads one chunk', async () => {
    const { app, world, camera } = await scene(64, 64)
    const texture = solid(world, [200, 200, 200, 255], 16, [60, 60, 60, 255])
    const atlas = world.resource(TextureAtlases).add(
      new TextureAtlas(texture as never, [
        { name: 'grass', rect: [0, 0, 8, 8] },
        { name: 'rock', rect: [8, 0, 8, 8] },
      ]),
    )
    const data = TilemapData.create(1024, 1024)
    for (let i = 0; i < data.layers[0]!.tiles.length; i++)
      data.layers[0]!.tiles[i] = i % 7 === 0 ? 2 : 1
    const ref = world.resource(TilemapDatas).add(data)
    const map = world.spawn(
      [Tilemap, { atlas, data: ref, tileSize: [1, 1], chunkSize: 32 }],
      [Transform, { translation: [-16, 16, 0] }],
    )
    const cam = camera(40)
    await settle(app)
    const tilemaps = world.resource(Tilemaps)
    const drawn = tilemaps.drawn.get(`camera:${cam}`)!
    expect(drawn.total).toBe(32 * 32)
    // A 40-unit view over 32-tile chunks: a handful of chunks, not a thousand.
    expect(drawn.visible).toBeGreaterThan(0)
    expect(drawn.visible).toBeLessThanOrEqual(9)
    expect(drawn.draws).toBe(1)
    setTile(world, map, 5, 5, 2)
    expect(tileAt(world, map, 5, 5)).toBe(2)
    app.update(1 / 60)
    expect(tilemaps.chunkUploads).toBe(1)
    app.update(1 / 60)
    expect(tilemaps.chunkUploads).toBe(0)
    expect(world.resource(Gpu).errors).toEqual([])
  })

  it('renders pixel art crisply at an integer scale with a PixelPerfect camera (golden image)', async () => {
    const { app, world, camera } = await scene(100, 70)
    // An 8×8 checker, 1 unit wide at 8 texels per unit: each texel a whole-pixel block.
    const texture = solid(world, [255, 200, 40, 255], 8, [40, 60, 200, 255])
    world.spawn([Sprite, { texture, size: [1, 1] }], [Transform, { translation: [0.3, 0.1, 0] }])
    // 2 units tall at 8 texels per unit: 16 texels, scaled 4× into 70 pixels.
    const cam = camera(2, [[PixelPerfect, { pixelsPerUnit: 8 }]])
    await settle(app)
    const shot = captureView(world, `pixel-perfect:${cam}`)
    app.update(1 / 60)
    const image = await shot
    expect(compareGolden(here, 'pixel-perfect', image).mean).toBeLessThan(1.5)
    // Every 4×4 block of the letterboxed image is one color: no filtering, no half texels.
    const scale = 4
    const ox = Math.floor((100 - Math.floor(100 / scale) * scale) / 2)
    const oy = Math.floor((70 - Math.floor(70 / scale) * scale) / 2)
    let mixed = 0
    for (let by = 0; by < Math.floor(70 / scale); by++) {
      for (let bx = 0; bx < Math.floor(100 / scale); bx++) {
        const first = (oy + by * scale) * 100 + ox + bx * scale
        for (let j = 0; j < scale; j++) {
          for (let i = 0; i < scale; i++) {
            const p = (oy + by * scale + j) * 100 + ox + bx * scale + i
            if (image.data[p * 4] !== image.data[first * 4]) mixed++
          }
        }
      }
    }
    expect(mixed).toBe(0)
  })
})
