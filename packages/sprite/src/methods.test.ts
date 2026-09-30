import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import type { AssetRef } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import {
  Camera3d,
  forwardPlugin,
  Gpu,
  GroundLayer,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TextureAtlas, TextureAtlases } from './atlas'
import { GroundTiles, tilemapOnGround } from './ground'
import { spritePlugin } from './plugin'
import { Tilemaps } from './render'
import { Tilemap, TilemapData, TilemapDatas, tilemapToText } from './tilemap'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const NAMES = ['grass', 'stone', 'water', 'sand']

/** A project folder with one 32×24 rows-encoded map, loaded by a sprite-pass and a ground Tilemap. */
async function project() {
  const root = mkdtempSync(join(tmpdir(), 'shard-tiles-'))
  roots.push(root)
  mkdirSync(join(root, 'assets'), { recursive: true })
  const data = TilemapData.create(32, 24, ['ground', 'detail'], [])
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 32; x++) data.layers[0]!.set(x, y, data.tileId(NAMES[(x + y) % 3]!))
  data.layers[1]!.set(4, 4, data.tileId('sand'))
  writeFileSync(
    join(root, 'assets/map.tilemap.json'),
    tilemapToText(data, { schema: '../.shard/schemas/tilemap.schema.json' }),
  )

  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    spritePlugin,
  )
  await app.init()
  const world = app.world
  const server = assetServer(world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  const report = await server.scan()
  if (report.failed.length) throw new Error(JSON.stringify(report.failed))
  const ref = server.resolve('assets/map.tilemap.json') as AssetRef<'TilemapData'>
  await server.load(ref)
  const pixels = new Uint8Array(32 * 8 * 4).fill(255)
  const texture = world
    .resource(Textures)
    .add(Texture.create({ width: 32, height: 8, mips: [pixels] }))
  const atlas = world.resource(TextureAtlases).add(
    new TextureAtlas(
      texture as AssetRef<'Texture'>,
      NAMES.map((name, i) => ({ name, rect: [i * 8, 0, 8, 8] })),
    ),
  ) as AssetRef<'TextureAtlas'>
  // The same data drawn twice: in the sprite pass, and on the ground.
  world.spawn(
    [Tilemap, { atlas, data: ref, chunkSize: 8 }],
    [Transform, { translation: [-16, 12, 0] }],
  )
  world.spawn(
    [Tilemap, { atlas, data: ref, chunkSize: 8 }],
    [GroundLayer, { band: 10 }],
    [Transform, { rotation: tilemapOnGround().rotation }],
  )
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(gpu, { label: 'tiles', width: 64, height: 64 }), 'tiles')
  world.spawn(
    [Camera3d, { projection: 'orthographic', orthoHeight: 40, target: target as never }],
    [Transform, { translation: [0, 0, 50] }],
  )
  await settle(app)
  const call = async (name: string, params: Record<string, unknown>) => {
    const method = app.methods.find((m) => m.name === name)!
    return (await method.handler(
      { app, world },
      method.params.deserialize(params) as never,
    )) as never
  }
  const data2 = world.resource(TilemapDatas).get(ref)!
  return { root, app, world, server, call, data: data2 }
}

describe('tilemap.read and tilemap.edit (spec 0059)', () => {
  it('edit 10 cells: only their chunks re-upload, in the sprite pass and on the ground', async () => {
    const { app, world, call } = await project()
    app.update(1 / 60)
    const sprite = world.resource(Tilemaps)
    const ground = world.resource(GroundTiles)
    expect(sprite.chunkUploads).toBe(0)
    expect(ground.chunkUploads).toBe(0)
    const cells: [number, number][] = [
      [0, 0],
      [7, 7],
      [8, 0],
      [9, 1],
      [20, 3],
      [31, 23],
      [30, 22],
      [16, 16],
      [2, 17],
      [5, 5],
    ]
    const r = (await call('tilemap.edit', {
      asset: 'assets/map.tilemap.json',
      layer: 'ground',
      cells: cells.map(([x, y]) => ({ x, y, tile: 'water', flags: 'fx' })),
    })) as { changed: number; saved: string | null }
    expect(r).toEqual({ changed: 10, saved: null })
    app.update(1 / 60)
    const chunks = new Set(cells.map(([x, y]) => `${Math.floor(x / 8)},${Math.floor(y / 8)}`))
    expect(chunks.size).toBe(6)
    expect(sprite.chunkUploads).toBe(chunks.size)
    expect(ground.chunkUploads).toBe(chunks.size)
    app.update(1 / 60)
    expect(sprite.chunkUploads).toBe(0)
    expect(ground.chunkUploads).toBe(0)
    // The same edit again changes nothing and uploads nothing.
    const again = (await call('tilemap.edit', {
      asset: 'assets/map.tilemap.json',
      layer: 'ground',
      cells: cells.map(([x, y]) => ({ x, y, tile: 'water', flags: 'fx' })),
    })) as { changed: number }
    expect(again.changed).toBe(0)
    app.update(1 / 60)
    expect(sprite.chunkUploads + ground.chunkUploads).toBe(0)
    expect(world.resource(Gpu).errors).toEqual([])
  })

  it('read a layer by chunk, one chunk, or a rect, in the rows syntax; rows edit a chunk', async () => {
    const { call, data } = await project()
    const all = (await call('tilemap.read', { asset: 'assets/map.tilemap.json' })) as {
      layer: string
      chunks: Record<string, string[]>
      encoding: string
    }
    expect(all.layer).toBe('ground')
    expect(all.encoding).toBe('rows')
    // 16-cell chunks (the file's chunkSize) over 32×24: 2 across, 2 down.
    expect(Object.keys(all.chunks)).toEqual(['0,0', '1,0', '0,1', '1,1'])
    expect(all.chunks['0,0']![0]).toBe(
      'grass stone water grass stone water grass stone water grass stone water grass stone water grass',
    )
    const rect = (await call('tilemap.read', {
      asset: 'assets/map.tilemap.json',
      layer: 'detail',
      rect: { x: 3, y: 4, w: 3, h: 2 },
    })) as { rows: string[] }
    expect(rect.rows).toEqual(['. sand .', '.*3'])
    const chunk = (await call('tilemap.read', {
      asset: 'assets/map.tilemap.json',
      layer: 'detail',
      chunk: [1, 1],
    })) as { rows: string[] }
    expect(chunk.rows).toEqual(Array(8).fill('.*16'))

    const edited = (await call('tilemap.edit', {
      asset: 'assets/map.tilemap.json',
      layer: 'detail',
      rows: { chunk: [0, 0], rows: ['stone*2 lava:r90 .*13'] },
    })) as { changed: number }
    // Two stones, one lava, and the sand at (4, 4) cleared: rows replace the chunk.
    expect(edited.changed).toBe(4)
    expect(data.palette).toContain('lava')
    const detail = data.layers[1]!
    expect([detail.get(0, 0), detail.get(1, 0)]).toEqual([
      data.tileId('stone'),
      data.tileId('stone'),
    ])
    expect(detail.flags[2]).toBe(4)
    expect(detail.get(4, 4)).toBe(0)

    const fill = (await call('tilemap.edit', {
      asset: 'assets/map.tilemap.json',
      layer: 'detail',
      fill: { rect: { x: 10, y: 10, w: 3, h: 2 }, tile: 'water' },
    })) as { changed: number }
    expect(fill.changed).toBe(6)
    await expect(
      call('tilemap.read', { asset: 'assets/map.tilemap.json', layer: 'roof' }),
    ).rejects.toMatchObject({ code: 'sprite/no-layer' })
    await expect(
      call('tilemap.edit', {
        asset: 'assets/map.tilemap.json',
        cells: [{ x: 40, y: 0, tile: 'water' }],
      }),
    ).rejects.toMatchObject({ code: 'sprite/tile-out-of-range', path: '/cells/0' })
    await expect(call('tilemap.read', { asset: 'assets/none.tilemap.json' })).rejects.toMatchObject(
      { code: 'sprite/unknown-tilemap' },
    )
  })

  it('save writes the file in its encoding (one line for one tile), and reloading it rebuilds nothing', async () => {
    const { root, app, world, server, call } = await project()
    const file = join(root, 'assets/map.tilemap.json')
    const before = readFileSync(file, 'utf8').split('\n')
    const r = (await call('tilemap.edit', {
      asset: 'assets/map.tilemap.json',
      cells: [{ x: 20, y: 5, tile: 'sand' }],
      save: true,
    })) as { changed: number; saved: string }
    expect(r).toEqual({ changed: 1, saved: 'assets/map.tilemap.json' })
    const after = readFileSync(file, 'utf8').split('\n')
    expect(after.length).toBe(before.length)
    // One line: row 5 of chunk "1,0", with the sand in it.
    const changed = after.filter((line, i) => line !== before[i])
    expect(changed).toEqual([
      '          "grass stone water grass sand water grass stone water grass stone water grass stone water grass",',
    ])
    app.update(1 / 60)
    // The watcher's reimport of what we wrote: same content, so no chunk rebuilds.
    await server.scan()
    app.update(1 / 60)
    expect(world.resource(Tilemaps).chunkUploads).toBe(0)
    expect(world.resource(GroundTiles).chunkUploads).toBe(0)
    // A base64 file stays base64.
    const data = world
      .resource(TilemapDatas)
      .get(server.resolve('assets/map.tilemap.json') as never)!
    const base64 = TilemapData.fromJson(JSON.parse(readFileSync(file, 'utf8')))
    base64.encoding = 'base64'
    writeFileSync(file, tilemapToText(base64))
    await server.scan()
    expect(data.encoding).toBe('base64')
    await call('tilemap.edit', {
      asset: 'assets/map.tilemap.json',
      cells: [{ x: 0, y: 0, tile: 'sand' }],
      save: true,
    })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.encoding).toBe('base64')
    expect(typeof saved.layers[0].tiles).toBe('string')
    expect(TilemapData.fromJson(saved).layers[0]!.get(0, 0)).toBe(data.tileId('sand'))
  })

  it('a version 1 map edits by name through its atlas, and saves as version 2', async () => {
    const { world, call } = await project()
    const v1 = new TilemapData([], [])
    v1.layers = TilemapData.create(4, 2).layers
    v1.layers[0]!.tiles.set([1, 2, 3, 4, 4, 3, 2, 1])
    const ref = world.resource(TilemapDatas).add(v1)
    const atlas = world.resource(TextureAtlases).add(
      new TextureAtlas(
        null,
        NAMES.map((name, i) => ({ name, rect: [i * 8, 0, 8, 8] })),
      ),
    )
    world.spawn([Tilemap, { atlas, data: ref }], Transform)
    const read = (await call('tilemap.read', { asset: ref.guid! })) as {
      chunks: Record<string, string[]>
    }
    expect(read.chunks['0,0']).toEqual(['grass stone water sand', 'sand water stone grass'])
    const edit = (await call('tilemap.edit', {
      asset: ref.guid!,
      cells: [{ x: 0, y: 0, tile: 'sand' }],
    })) as { changed: number }
    expect(edit.changed).toBe(1)
    expect(v1.palette).toEqual(['grass', 'stone', 'water', 'sand'])
    expect(v1.toJson()).toMatchObject({ version: 2, palette: ['grass', 'stone', 'water', 'sand'] })
  })
})
