import { describe, expect, it } from 'vitest'
import { TilemapData, tilemapToText } from './tilemap'

// The authored tilemap format (0059): rows and base64 load to the same tiles, round trips are
// byte-identical, and a one-tile edit is a one-line diff.

const NAMES = ['grass', 'stone', 'water', 'sand', 'lava']

/** A seeded 48×32, two-layer map with a palette, flags, gaps and an animation. */
function sample(): TilemapData {
  const data = TilemapData.create(48, 32, ['ground', 'props'], NAMES)
  let s = 12345
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  for (const layer of data.layers) {
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 48; x++) {
        // Runs of the same tile (like real maps), some empty, some flipped.
        const band = Math.floor((x + y * 3) / 7) % 6
        const tile = layer.name === 'props' && rnd() < 0.8 ? 0 : band === 5 ? 0 : band + 1
        const flags = rnd() < 0.1 ? [1, 2, 4, 5, 7][Math.floor(rnd() * 5)]! : 0
        layer.set(x, y, tile, tile ? flags : 0)
      }
    }
  }
  data.animations.push({ tile: 3, frames: [3, 4], frameTime: 0.25 })
  return data
}

describe('tilemap format (0059)', () => {
  it('round-trips a 48×32 map base64 → rows → base64 byte-identically', () => {
    const base64 = tilemapToText(sample(), { encoding: 'base64' })
    const rows = tilemapToText(TilemapData.fromJson(JSON.parse(base64)), { encoding: 'rows' })
    expect(rows).toContain('"encoding": "rows"')
    const back = tilemapToText(TilemapData.fromJson(JSON.parse(rows)), { encoding: 'base64' })
    expect(back).toBe(base64)
    // And rows → rows is stable too.
    expect(tilemapToText(TilemapData.fromJson(JSON.parse(rows)))).toBe(rows)
  })

  it('migrates version 1 (atlas region ids) to version 2 with a palette, then round-trips', () => {
    const atlas = { names: ['unused', ...NAMES] }
    // Version 1: ids are atlas regions + 1, so shift the sample's palette ids by one region.
    const v2 = sample()
    const v1Json = JSON.parse(tilemapToText(v2, { encoding: 'base64' }))
    const v1 = {
      layers: v2.layers.map((l, i) => {
        const tiles = new Uint16Array(l.tiles.length)
        for (let k = 0; k < tiles.length; k++) tiles[k] = l.tiles[k] ? l.tiles[k]! + 1 : 0
        const bytes = new Uint8Array(tiles.buffer)
        return {
          name: l.name,
          width: l.width,
          height: l.height,
          tiles: Buffer.from(bytes).toString('base64'),
          flags: v1Json.layers[i].flags,
        }
      }),
      animations: [{ tile: 4, frames: [4, 5], frameTime: 0.25 }],
    }
    const loaded = TilemapData.fromJson(v1)
    expect(loaded.palette).toBeUndefined()
    expect(() => tilemapToText(loaded)).toThrow(
      expect.objectContaining({ code: 'sprite/tilemap-needs-atlas' }),
    )
    const migrated = tilemapToText(loaded, { encoding: 'base64', atlas })
    const json = JSON.parse(migrated)
    expect(json.version).toBe(2)
    // Palette in first-use order: every name the map uses, nothing it doesn't.
    expect([...json.palette].sort()).toEqual([...NAMES].sort())
    const again = TilemapData.fromJson(json)
    for (let l = 0; l < 2; l++) {
      for (let k = 0; k < 48 * 32; k++) {
        expect(again.tileName(again.layers[l]!.tiles[k]!)).toBe(
          v2.tileName(v2.layers[l]!.tiles[k]!),
        )
      }
    }
    const rows = tilemapToText(again, { encoding: 'rows' })
    expect(tilemapToText(TilemapData.fromJson(JSON.parse(rows)), { encoding: 'base64' })).toBe(
      migrated,
    )
  })

  it('changes exactly one line of the rows file when one tile changes', () => {
    const data = TilemapData.fromJson(JSON.parse(tilemapToText(sample(), { encoding: 'rows' })))
    const before = tilemapToText(data).split('\n')
    data.layers[0]!.set(20, 9, data.tileId('lava'), 1)
    const after = tilemapToText(data).split('\n')
    expect(after.length).toBe(before.length)
    const changed = after.filter((line, i) => line !== before[i])
    expect(changed).toHaveLength(1)
    expect(changed[0]).toContain('lava:fx')
  })

  it('reads runs, flags and empty cells, and leaves empty chunks out', () => {
    const text = JSON.stringify({
      version: 2,
      encoding: 'rows',
      chunkSize: 4,
      palette: ['a', 'b'],
      layers: [
        {
          name: 'g',
          width: 6,
          height: 5,
          chunks: {
            '0,0': ['a*4', 'b:fx+r90 . a*2', '', '.*4'],
            '1,1': ['b*2'],
          },
        },
      ],
    })
    const data = TilemapData.fromJson(JSON.parse(text))
    const layer = data.layers[0]!
    expect([...layer.tiles.subarray(0, 6)]).toEqual([1, 1, 1, 1, 0, 0])
    expect(layer.get(0, 1)).toBe(2)
    expect(layer.flags[6]).toBe(1 | 4)
    expect(layer.get(1, 1)).toBe(0)
    expect(layer.get(4, 4)).toBe(2)
    const out = JSON.parse(tilemapToText(data))
    expect(Object.keys(out.layers[0].chunks)).toEqual(['0,0', '1,1'])
    expect(out.layers[0].chunks['0,0']).toEqual(['a*4', 'b:fx+r90 . a*2', '.*4', '.*4'])
  })

  it('names the chunk and row of a malformed rows file', () => {
    const bad = (rows: unknown) =>
      JSON.stringify({
        version: 2,
        encoding: 'rows',
        chunkSize: 4,
        palette: [],
        layers: [{ name: 'g', width: 4, height: 4, chunks: { '0,0': rows } }],
      })
    const code = (json: string) => {
      try {
        TilemapData.fromJson(JSON.parse(json))
      } catch (err) {
        return [(err as { code: string }).code, (err as { path: string }).path]
      }
      return undefined
    }
    expect(code(bad(['a*5']))).toEqual(['sprite/invalid-tilemap', '/layers/0/chunks/0,0/0'])
    expect(code(bad(['a:zz*4']))).toEqual(['sprite/invalid-tilemap', '/layers/0/chunks/0,0/0'])
    expect(code(bad(['a', 'a*4']))).toEqual(['sprite/invalid-tilemap', '/layers/0/chunks/0,0/0'])
    expect(code(bad(['a*4', 'a*4', 'a*4', 'a*4', 'a*4']))).toEqual([
      'sprite/invalid-tilemap',
      '/layers/0/chunks/0,0',
    ])
  })
})
