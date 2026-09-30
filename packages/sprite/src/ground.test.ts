import { type AssetRef, type Entity, Rng } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  cameraOf,
  captureView,
  DirectionalLight,
  forwardPlugin,
  Gpu,
  GroundLayer,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  type PickHit,
  PointLight,
  pick,
  RenderTargets,
  renderPlugin,
  Tonemapping,
  Views,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TextureAtlas, TextureAtlases } from './atlas'
import { GroundTiles, syncGroundTiles, TileChunk, tilemapOnGround } from './ground'
import { spritePlugin } from './plugin'
import { setTile, Tilemap, TilemapData, TilemapDatas } from './tilemap'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const W = 192
const H = 128
const COLORS: Record<string, [number, number, number]> = {
  grass: [60, 170, 60],
  stone: [128, 128, 128],
  water: [40, 90, 200],
  sand: [220, 200, 120],
}

async function scene() {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    spritePlugin,
  )
  await app.init()
  return app
}

type World = Awaited<ReturnType<typeof scene>>['world']

/** An atlas of 8×8 solid regions, laid out as `layout` says: [name, x, y] in region order. */
function atlasOf(world: World, width: number, height: number, layout: [string, number, number][]) {
  const pixels = new Uint8Array(width * height * 4)
  for (const [name, rx, ry] of layout) {
    const [r, g, b] = COLORS[name]!
    for (let y = ry; y < ry + 8; y++)
      for (let x = rx; x < rx + 8; x++) pixels.set([r, g, b, 255], (y * width + x) * 4)
  }
  const texture = world.resource(Textures).add(Texture.create({ width, height, mips: [pixels] }))
  return world.resource(TextureAtlases).add(
    new TextureAtlas(
      texture as AssetRef<'Texture'>,
      layout.map(([name, x, y]) => ({ name, rect: [x, y, 8, 8] })),
    ),
  ) as AssetRef<'TextureAtlas'>
}

/** A 12×8 map, 1 m tiles, centered on the origin: a filled ground layer and a sparse detail one. */
function mapOf() {
  const data = TilemapData.create(12, 8, ['ground', 'detail'], [])
  const random = new Rng(59)
  const names = ['water', 'grass', 'sand', 'stone']
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 12; x++) {
      data.layers[0]!.set(x, y, data.tileId(names[random.int(0, 3)]!))
      if (random.float() < 0.2) data.layers[1]!.set(x, y, data.tileId('stone'))
    }
  return data
}

function spawnMap(
  world: World,
  data: TilemapData,
  atlas: AssetRef<'TextureAtlas'>,
  lit: '3d' | 'none',
  chunkSize = 4,
) {
  const ref = world.resource(TilemapDatas).add(data)
  const ground = tilemapOnGround()
  return world.spawn(
    [Tilemap, { atlas, data: ref, tileSize: [1, 1], chunkSize, lit }],
    [GroundLayer, { band: 10 }],
    [Transform, { translation: [-6, 0, -4], rotation: ground.rotation }],
  )
}

function cameras(world: World) {
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(gpu, { label: 'ground', width: W, height: H }), 'ground')
  const flat = [Tonemapping, { curve: 'none', dither: false }] as const
  // Map: straight down, 8 m tall (the map's height). Tabletop: 45° down from the south.
  const map = world.spawn(
    [
      Camera3d,
      {
        projection: 'orthographic',
        orthoHeight: 8,
        target: target as never,
        clearColor: [0, 0, 0, 1],
      },
    ],
    [...flat],
    [Transform, { translation: [0, 50, 0], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] }],
  )
  const tabletop = world.spawn(
    [Camera3d, { target: target as never, clearColor: [0, 0, 0, 1], active: false }],
    [...flat],
    [Transform, { translation: [0, 9, 9], rotation: lookAt([0, 9, 9], [0, 0, 0]) }],
  )
  return { map, tabletop }
}

/** Pixel of a world point in a camera's view. */
function toPixel(world: World, camera: Entity, p: [number, number, number]): [number, number] {
  const view = world.resource(Views).list.find((v) => v.name === `camera:${camera}`)!
  const m = cameraOf(view)!.viewProjNoJitter
  const [x, y, z] = p
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w
  return [Math.floor((nx * 0.5 + 0.5) * W), Math.floor((0.5 - ny * 0.5) * H)]
}

async function pickAll(
  app: App,
  camera: Entity,
  pixels: [number, number][],
): Promise<(PickHit | undefined)[]> {
  const world = app.world
  let done = false
  const all = Promise.all(pixels.map(([x, y]) => pick(world, camera, x, y))).finally(() => {
    done = true
  })
  for (let i = 0; i < 60 && !done; i++) {
    app.update(1 / 60)
    await world.resource(Gpu).pipelines.whenIdle()
    await new Promise((r) => setTimeout(r, 0))
  }
  return all
}

async function capture(app: App, camera: Entity) {
  const shot = captureView(app.world, `camera:${camera}`)
  app.update(1 / 60)
  return shot
}

function setActive(world: World, camera: Entity, active: boolean) {
  world.set(camera, Camera3d, { ...world.get(camera, Camera3d), active } as never)
}

/** The topmost filled layer's tile at a cell, as a pick should name it. */
function expected(data: TilemapData, x: number, y: number) {
  const top = data.layers[1]!.get(x, y) !== 0 ? 1 : 0
  const layer = data.layers[top]!
  return { layer: layer.name, tile: data.tileName(layer.get(x, y)) }
}

describe('tilemaps on the ground (spec 0059)', () => {
  it('draw on the ground; a re-packed atlas renders the same pixels and picks the same names in both views, over 100 random cells', {
    timeout: 120_000,
  }, async () => {
    const app = await scene()
    const world = app.world
    const packed = atlasOf(world, 16, 16, [
      ['grass', 0, 0],
      ['stone', 8, 0],
      ['water', 0, 8],
      ['sand', 8, 8],
    ])
    // The same art re-packed: another texture, another region order.
    const repacked = atlasOf(world, 32, 8, [
      ['sand', 0, 0],
      ['water', 8, 0],
      ['stone', 16, 0],
      ['grass', 24, 0],
    ])
    const data = mapOf()
    const tilemap = spawnMap(world, data, packed, 'none')
    const { map, tabletop } = cameras(world)
    await settle(app)
    expect(world.resource(Gpu).errors).toEqual([])

    // Drawn where the map lies: each cell's center pixel is its top tile's color.
    const before = await capture(app, map)
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 12; x++) {
        const [px, py] = toPixel(world, map, [-6 + x + 0.5, 0, -4 + y + 0.5])
        const o = (py * W + px) * 4
        const got = [before.data[o]!, before.data[o + 1]!, before.data[o + 2]!]
        let nearest = ''
        let best = Number.POSITIVE_INFINITY
        for (const [name, c] of Object.entries(COLORS)) {
          const d = Math.abs(c[0] - got[0]!) + Math.abs(c[1] - got[1]!) + Math.abs(c[2] - got[2]!)
          if (d < best) {
            best = d
            nearest = name
          }
        }
        expect(nearest, `cell ${x},${y}`).toBe(expected(data, x, y).tile)
      }

    const random = new Rng(100)
    const cells: [number, number][] = []
    for (let i = 0; i < 100; i++) cells.push([random.int(0, 11), random.int(0, 7)])
    const pickCells = async (camera: Entity) => {
      const hits = await pickAll(
        app,
        camera,
        cells.map(([x, y]) => toPixel(world, camera, [-6 + x + 0.5, 0, -4 + y + 0.5])),
      )
      return hits.map((h, i) => {
        const [x, y] = cells[i]!
        expect(h?.detail, `cell ${x},${y}`).toMatchObject({ kind: 'tile', x, y, tilemap })
        expect(world.get(h!.entity, TileChunk).tilemap).toBe(tilemap)
        const want = expected(data, x, y)
        expect(h!.detail, `cell ${x},${y}`).toMatchObject(want)
        return h!.detail!.tile
      })
    }
    const mapNames = await pickCells(map)
    setActive(world, map, false)
    setActive(world, tabletop, true)
    await settle(app)
    const tabletopBefore = await capture(app, tabletop)
    const tabletopNames = await pickCells(tabletop)

    // Re-pack: same pixels in both views, same names.
    world.set(tilemap, Tilemap, {
      atlas: repacked,
      data: world.get(tilemap, Tilemap).data,
      tileSize: [1, 1],
      chunkSize: 4,
      lit: 'none',
    } as never)
    await settle(app)
    const tabletopAfter = await capture(app, tabletop)
    expect(Buffer.compare(Buffer.from(tabletopAfter.data), Buffer.from(tabletopBefore.data))).toBe(
      0,
    )
    expect(await pickCells(tabletop)).toEqual(tabletopNames)
    setActive(world, tabletop, false)
    setActive(world, map, true)
    await settle(app)
    const after = await capture(app, map)
    expect(Buffer.compare(Buffer.from(after.data), Buffer.from(before.data))).toBe(0)
    expect(await pickCells(map)).toEqual(mapNames)
    expect(world.resource(Gpu).errors).toEqual([])
  })

  it('rebuild only the chunks an edit touches', async () => {
    const app = await scene()
    const world = app.world
    const atlas = atlasOf(world, 16, 16, [
      ['grass', 0, 0],
      ['stone', 8, 0],
      ['water', 0, 8],
      ['sand', 8, 8],
    ])
    const data = mapOf()
    const tilemap = spawnMap(world, data, atlas, 'none')
    const { map } = cameras(world)
    await settle(app)
    const state = world.resource(GroundTiles)
    app.update(1 / 60)
    expect(state.chunkUploads).toBe(0)
    // 10 cells in 3 chunks of the ground layer (4×4 chunks: 3 across, 2 down).
    const cells: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 3],
      [0, 3],
      [5, 0],
      [6, 2],
      [7, 3],
      [8, 5],
      [11, 7],
    ]
    const water = data.tileId('water')
    for (const [x, y] of cells) setTile(world, tilemap, x, y, water)
    app.update(1 / 60)
    const chunks = new Set(cells.map(([x, y]) => Math.floor(y / 4) * 3 + Math.floor(x / 4)))
    expect(state.chunkUploads).toBe(chunks.size)
    app.update(1 / 60)
    expect(state.chunkUploads).toBe(0)
    // Removing the ground layer removes the chunks.
    world.remove(tilemap, GroundLayer)
    app.update(1 / 60)
    expect(world.query({ with: [TileChunk] }).count()).toBe(0)
    expect(state.maps.size).toBe(0)
    // A tile the map hadn't named yet: the palette grows, and the cell draws that tile.
    world.despawn(tilemap)
    const fresh = TilemapData.create(12, 8, ['ground'], [])
    const grass = fresh.tileId('grass')
    for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) fresh.layers[0]!.set(x, y, grass)
    const other = spawnMap(world, fresh, atlas, 'none')
    await settle(app)
    setTile(world, other, 5, 3, fresh.tileId('sand'))
    app.update(1 / 60)
    expect(state.chunkUploads).toBe(1)
    const image = await capture(app, map)
    const [px, py] = toPixel(world, map, [-6 + 5.5, 0, -4 + 3.5])
    const o = (py * W + px) * 4
    expect([image.data[o], image.data[o + 1], image.data[o + 2]]).toEqual(COLORS.sand)
    // Despawning the tilemap takes its chunks with it.
    world.despawn(other)
    app.update(1 / 60)
    expect(world.query({ with: [TileChunk] }).count()).toBe(0)
    expect(state.maps.size).toBe(0)
  })

  it('rebuild only the chunks holding an animated tile when its frame turns', async () => {
    const app = await scene()
    const world = app.world
    const atlas = atlasOf(world, 16, 16, [
      ['grass', 0, 0],
      ['stone', 8, 0],
      ['water', 0, 8],
      ['sand', 8, 8],
    ])
    const data = TilemapData.create(12, 8, ['ground'], [])
    const grass = data.tileId('grass')
    const water = data.tileId('water')
    const sand = data.tileId('sand')
    for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) data.layers[0]!.set(x, y, grass)
    // Water in two of the six 4×4 chunks, cycling water → sand every half second.
    data.layers[0]!.set(1, 1, water)
    data.layers[0]!.set(9, 6, water)
    data.animations = [{ tile: water, frames: [water, sand], frameTime: 0.5 }]
    spawnMap(world, data, atlas, 'none')
    cameras(world)
    await settle(app)
    const state = world.resource(GroundTiles)
    app.update(0.1)
    expect(state.chunkUploads).toBe(0)
    let turned = 0
    for (let i = 0; i < 10; i++) {
      app.update(0.1)
      if (state.chunkUploads > 0) {
        expect(state.chunkUploads).toBe(2)
        turned++
      }
    }
    // A second of frames at 0.5 s a frame: two turns.
    expect(turned).toBe(2)
  })

  it('a frame with nothing edited reads 100 ground maps quickly, allocating nothing', {
    timeout: 60_000,
  }, async () => {
    const app = await scene()
    const world = app.world
    const atlas = atlasOf(world, 16, 16, [
      ['grass', 0, 0],
      ['stone', 8, 0],
      ['water', 0, 8],
      ['sand', 8, 8],
    ])
    for (let i = 0; i < 100; i++) spawnMap(world, mapOf(), atlas, 'none')
    cameras(world)
    await settle(app)
    // Run the system alone, so the GC count is its own.
    const system = syncGroundTiles.setup!(world)
    const run = () => syncGroundTiles.run(system, world, undefined as never)
    for (let i = 0; i < 200; i++)
      run() // let V8 optimize
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const times = new Float64Array(300)
    const gcs = gcWindow()
    for (let f = 0; f < times.length; f++) {
      const t0 = performance.now()
      run()
      times[f] = performance.now() - t0
    }
    const collections = await gcs.end()
    expect(world.resource(GroundTiles).chunkUploads).toBe(0)
    expect(world.resource(GroundTiles).maps.size).toBe(100)
    const sorted = [...times].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]!
    console.log(
      `ground tiles, 100 maps unchanged: ${median.toFixed(4)} ms median; GC events: ${collections}`,
    )
    if (allocationChecks) expect(collections).toBe(0)
    expect(median).toBeLessThan(budget(0.05))
  })

  it("lit: '3d' is lit by a tabletop point light and receives a prop's shadow; lit: 'none' is neither", {
    timeout: 60_000,
  }, async () => {
    const shade = async (lit: '3d' | 'none') => {
      const app = await scene()
      const world = app.world
      world.resource(AmbientLight).brightness = 200
      const atlas = atlasOf(world, 16, 16, [
        ['grass', 0, 0],
        ['stone', 8, 0],
        ['water', 0, 8],
        ['sand', 8, 8],
      ])
      const data = TilemapData.create(12, 8, ['ground'], [])
      const stone = data.tileId('stone')
      for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) data.layers[0]!.set(x, y, stone)
      spawnMap(world, data, atlas, lit)
      // Sun from the east, so a raised box's shadow falls west of it, where the camera sees it.
      world.spawn(
        [DirectionalLight, { illuminance: 3000, shadows: true }],
        [Transform, { rotation: lookAt([5, 10, 0], [0, 0, 0]) }],
      )
      // A tabletop light over the west half, and a box (the prop) over the east half.
      world.spawn(
        [PointLight, { intensity: 160_000, range: 5, bright: 2, falloff: 'tabletop' }],
        [Transform, { translation: [-3.5, 1, 0] }],
      )
      const material = world
        .resource(Materials)
        .add(new MaterialAsset({ baseColor: [1, 1, 1, 1] })) as AssetRef<'Material'>
      world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 1, y: 1, z: 1 })) }],
        [MeshMaterial, { material }],
        [Transform, { translation: [3.5, 3, -1.5] }],
      )
      const { map } = cameras(world)
      await settle(app)
      const image = await capture(app, map)
      const lum = (p: [number, number, number]) => {
        const [x, y] = toPixel(world, map, p)
        const o = (y * W + x) * 4
        return image.data[o]! + image.data[o + 1]! + image.data[o + 2]!
      }
      expect(world.resource(Gpu).errors).toEqual([])
      // Under the light; far from it; in the box's shadow (x 1.25–2.75 below a box at x 3–4).
      return { near: lum([-3.5, 0, 1.5]), far: lum([0.5, 0, 2.5]), shadow: lum([2, 0, -1.5]) }
    }
    const lit = await shade('3d')
    expect(lit.near).toBeGreaterThan(lit.far * 1.3)
    expect(lit.shadow).toBeLessThan(lit.far * 0.8)
    const flat = await shade('none')
    expect(Math.abs(flat.near - flat.far)).toBeLessThanOrEqual(3)
  })

  it('report a palette name the atlas lacks once, as sprite/unknown-tile, and draw nothing for it', async () => {
    const app = await scene()
    const world = app.world
    const atlas = atlasOf(world, 16, 16, [['grass', 0, 0]])
    const data = TilemapData.create(4, 4, ['ground'], [])
    data.layers[0]!.set(1, 2, data.tileId('grass'))
    data.layers[0]!.set(3, 1, data.tileId('lava'))
    spawnMap(world, data, atlas, 'none')
    cameras(world)
    await settle(app)
    app.update(1 / 60)
    const unknown = world
      .resource(LogResource)
      .tail(50, 'error')
      .filter((e) => e.code === 'sprite/unknown-tile')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.message).toContain('"lava"')
    expect(unknown[0]!.message).toContain('"ground"')
    expect(unknown[0]!.message).toContain('(3, 1)')
    expect(unknown[0]!.path).toBe('/layers/0/chunks/0,0/1')
    // Only the grass quad is built: one chunk, four vertices.
    const chunks: number[] = []
    world.query({ with: [TileChunk, Mesh3d] }).each((e) => {
      const mesh = world.resource(Meshes).get(world.get(e, Mesh3d).mesh as never)
      chunks.push(mesh!.vertexCount)
    })
    expect(chunks).toEqual([4])
    expect(world.resource(Gpu).errors).toEqual([])
  })
})
