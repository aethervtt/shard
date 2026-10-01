import { assetServer } from '@aethervtt/shard-assets'
import { type AssetRef, defineSchema, ShardError, t, type World } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { type TextureAtlas, TextureAtlases } from './atlas'
import { type TileLayer, Tilemap, TilemapData, TilemapDatas, tileNames } from './tilemap'
import { layerChunks, readChunkRows, rectRows, TILE_FLAG_NAMES } from './tilemap-format'

// Chunk-level read and edit of tilemap data (0059), for agents: through the protocol, MCP
// (tilemap_read, tilemap_edit) and `shard tiles`. Cells are named by palette name in the rows
// syntax, so what an agent reads is what it writes back.

export interface TileRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ReadTilesOptions {
  /** Layer name (default: the first). */
  layer?: string
  /** Just this chunk ([cx, cy], in the data's chunkSize). */
  chunk?: readonly number[]
  /** Just this rect. */
  rect?: TileRect
}

export interface EditTilesOptions {
  layer?: string
  /** Cells to set: tile by palette name ('.' clears), flags as "fx+r90". */
  cells?: readonly { x: number; y: number; tile: string; flags?: string | number }[]
  /** A rect filled with one tile. */
  fill?: { rect: TileRect; tile: string }
  /** One chunk's cells replaced by rows, as readTiles gives them. */
  rows?: { chunk: readonly number[]; rows: readonly string[] }
}

function layerNamed(data: TilemapData, name: string | undefined): TileLayer {
  const layer = name ? data.layers.find((l) => l.name === name) : data.layers[0]
  if (!layer) {
    throw new ShardError('sprite/no-layer', `The tilemap has no layer ${JSON.stringify(name)}`, {
      hint: `Its layers: ${data.layers.map((l) => l.name).join(', ') || 'none'}.`,
    })
  }
  return layer
}

function checkRect(layer: TileLayer, r: TileRect, path: string): void {
  if (r.x + r.w > layer.width || r.y + r.h > layer.height) {
    throw new ShardError(
      'sprite/tile-out-of-range',
      `Rect ${r.x},${r.y} ${r.w}×${r.h} is outside the ${layer.width}×${layer.height} layer "${layer.name}"`,
      { path },
    )
  }
}

/** A chunk's cell rect, checked against the layer. */
function chunkRect(data: TilemapData, layer: TileLayer, chunk: readonly number[], path: string) {
  if (chunk.length !== 2) throw new ShardError('sprite/bad-chunk', 'A chunk is [cx, cy]', { path })
  const cs = data.chunkSize
  const x = chunk[0]! * cs
  const y = chunk[1]! * cs
  checkRect(layer, { x, y, w: 1, h: 1 }, path)
  return { x, y, w: Math.min(cs, layer.width - x), h: Math.min(cs, layer.height - y) }
}

/** Flag bits from "fx+r90" (or a number). */
function flagsOf(value: unknown, path: string): number {
  if (typeof value === 'number') return value
  if (!value) return 0
  let flags = 0
  for (const f of String(value).split('+')) {
    const bit = TILE_FLAG_NAMES[f as keyof typeof TILE_FLAG_NAMES]
    if (!bit) {
      throw new ShardError('sprite/bad-flag', `Unknown tile flag "${f}"`, {
        path,
        hint: 'Flags are fx, fy and r90, joined by +.',
      })
    }
    flags |= bit
  }
  return flags
}

/** A tile name as an id: "." or "" clears the cell. */
function idOf(data: TilemapData, name: string): number {
  return name === '.' || name === '' ? 0 : data.tileId(name)
}

/**
 * A layer's cells as rows: all non-empty chunks (keyed "cx,cy"), one chunk, or a rect. Version 1
 * maps name their tiles through the atlas.
 */
export function readTiles(
  data: TilemapData,
  options: ReadTilesOptions = {},
  atlas?: { names: readonly string[] },
) {
  const layer = layerNamed(data, options.layer)
  const names = tileNames(data, atlas)
  const head = {
    layer: layer.name,
    width: layer.width,
    height: layer.height,
    chunkSize: data.chunkSize,
    encoding: data.encoding,
  }
  const rect = options.rect
  if (rect && rect.w > 0 && rect.h > 0) {
    checkRect(layer, rect, '/rect')
    return { ...head, rect, rows: rectRows(layer, names, rect.x, rect.y, rect.w, rect.h).rows }
  }
  if (options.chunk && options.chunk.length > 0) {
    const r = chunkRect(data, layer, options.chunk, '/chunk')
    return {
      ...head,
      chunk: [...options.chunk],
      rows: rectRows(layer, names, r.x, r.y, r.w, r.h).rows,
    }
  }
  return { ...head, chunks: layerChunks(layer, names, data.chunkSize) }
}

/**
 * Applies cell edits through TileLayer.set, so renderers re-upload only the touched chunks.
 * Returns how many cells changed. A version 1 map first gets a palette of the atlas's names.
 */
export function editTiles(
  data: TilemapData,
  options: EditTilesOptions,
  atlas?: { names: readonly string[] },
): number {
  const name = layerNamed(data, options.layer).name
  if (!data.palette) {
    data.copyFrom(TilemapData.fromJson(data.toJson({ atlas: { names: tileNames(data, atlas) } })))
  }
  // Looked up after: a migration replaces the layers.
  const layer = layerNamed(data, name)
  let changed = 0
  const set = (x: number, y: number, id: number, flags: number, path: string) => {
    if (x >= layer.width || y >= layer.height) {
      throw new ShardError(
        'sprite/tile-out-of-range',
        `Cell (${x}, ${y}) is outside the ${layer.width}×${layer.height} layer "${layer.name}"`,
        { path },
      )
    }
    const i = y * layer.width + x
    if (layer.tiles[i] === id && layer.flags[i] === flags) return
    layer.set(x, y, id, flags)
    changed++
  }
  const cells = options.cells ?? []
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k]!
    set(c.x, c.y, idOf(data, c.tile), flagsOf(c.flags, `/cells/${k}/flags`), `/cells/${k}`)
  }
  const fill = options.fill
  if (fill && fill.rect.w > 0 && fill.rect.h > 0) {
    checkRect(layer, fill.rect, '/fill/rect')
    const id = idOf(data, fill.tile)
    for (let y = fill.rect.y; y < fill.rect.y + fill.rect.h; y++)
      for (let x = fill.rect.x; x < fill.rect.x + fill.rect.w; x++) set(x, y, id, 0, '/fill')
  }
  const rows = options.rows
  if (rows && rows.chunk.length > 0) {
    const r = chunkRect(data, layer, rows.chunk, '/rows/chunk')
    // Parsed into a copy with the chunk cleared (rows replace it), then applied cell by cell, so
    // only real changes reach the edit log.
    const grid = {
      width: layer.width,
      height: layer.height,
      tiles: layer.tiles.slice(),
      flags: layer.flags.slice(),
    }
    for (let y = r.y; y < r.y + r.h; y++) {
      grid.tiles.fill(0, y * layer.width + r.x, y * layer.width + r.x + r.w)
      grid.flags.fill(0, y * layer.width + r.x, y * layer.width + r.x + r.w)
    }
    const palette = data.palette!
    const index = new Map(palette.map((n, i) => [n, i]))
    readChunkRows(
      grid,
      palette,
      index,
      rows.chunk[0]!,
      rows.chunk[1]!,
      data.chunkSize,
      rows.rows,
      '/rows/rows',
    )
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = y * layer.width + x
        set(x, y, grid.tiles[i]!, grid.flags[i]!, '/rows')
      }
  }
  return changed
}

/** A loaded tilemap data asset, and the atlas of a Tilemap drawing it (for version 1 names). */
export function findTilemapData(
  world: World,
  asset: string,
): { data: TilemapData; guid: string | undefined; atlas: TextureAtlas | undefined } {
  const server = assetServer(world)
  const entry = server.entry(asset)
  const data = server.item(asset)
  if (!(data instanceof TilemapData)) {
    throw new ShardError(
      'sprite/unknown-tilemap',
      entry
        ? `${asset} is a ${entry.type}, not loaded TilemapData`
        : `No tilemap data "${asset}" is loaded`,
      { hint: 'Name a *.tilemap.json asset by path or guid that a Tilemap in the world uses.' },
    )
  }
  const store = world.resource(TilemapDatas)
  let atlas: TextureAtlas | undefined
  for (const table of world.query({ with: [Tilemap] }).tables) {
    const dataRefs = table.column(Tilemap, 'data')
    const atlasRefs = table.column(Tilemap, 'atlas')
    for (let row = 0; row < table.count && !atlas; row++) {
      if (store.get(dataRefs[row] as AssetRef<'TilemapData'> | null) !== data) continue
      atlas = world
        .tryResource(TextureAtlases)
        ?.get(atlasRefs[row] as AssetRef<'TextureAtlas'> | null)
    }
  }
  return { data, guid: entry?.guid, atlas }
}

const Rect = t.struct({
  x: t.u32({ description: 'Left column.' }),
  y: t.u32({ description: 'Top row.' }),
  w: t.u32({ description: 'Width in cells (0: no rect).' }),
  h: t.u32({ description: 'Height in cells.' }),
})

export const tilemapMethods: AppMethod[] = [
  {
    name: 'tilemap.read',
    description:
      "A tilemap layer's cells as rows (0059): runs of name[:flags][*count], '.' empty, flags fx/fy/r90 joined by +. The whole layer by chunk, one chunk, or a rect.",
    params: defineSchema('sprite/TilemapReadParams', {
      asset: t.string({ required: true, description: 'The TilemapData asset: path or guid.' }),
      layer: t.string({ description: 'Layer name (default: the first).' }),
      chunk: t.list(t.u32(), { description: '[cx, cy]: just this chunk.' }),
      rect: Rect,
    }),
    handler: ({ world }, p) => {
      const { data, atlas } = findTilemapData(world, p.asset as string)
      return {
        asset: p.asset,
        ...readTiles(
          data,
          {
            layer: (p.layer as string) || undefined,
            chunk: p.chunk as number[],
            rect: p.rect as TileRect,
          },
          atlas,
        ),
      }
    },
  },
  {
    name: 'tilemap.edit',
    description:
      "Edits a tilemap layer's cells by tile name (0059): cells, a filled rect, or a chunk's rows. Applies to the live world (only the touched chunks re-upload); save writes the asset file in its own encoding. Returns the changed cell count.",
    params: defineSchema('sprite/TilemapEditParams', {
      asset: t.string({ required: true, description: 'The TilemapData asset: path or guid.' }),
      layer: t.string({ description: 'Layer name (default: the first).' }),
      cells: t.list(
        t.struct({
          x: t.u32(),
          y: t.u32(),
          tile: t.string({ description: "Palette name; '.' clears the cell." }),
          flags: t.string({ description: 'fx, fy and r90, joined by +.' }),
        }),
        { description: 'Cells to set.' },
      ),
      fill: t.struct(
        { rect: Rect, tile: t.string({ description: "Palette name; '.' clears." }) },
        { description: 'A rect to fill with one tile.' },
      ),
      rows: t.struct(
        {
          chunk: t.list(t.u32(), { description: '[cx, cy]' }),
          rows: t.list(t.string(), { description: 'The chunk rows, from the top.' }),
        },
        { description: "Replaces one chunk's cells with rows, as tilemap.read returns them." },
      ),
      save: t.bool({ description: 'Also write the asset file, keeping its encoding.' }),
    }),
    handler: async ({ world }, p) => {
      const { data, guid, atlas } = findTilemapData(world, p.asset as string)
      const changed = editTiles(
        data,
        {
          layer: (p.layer as string) || undefined,
          cells: p.cells as EditTilesOptions['cells'],
          fill: p.fill as EditTilesOptions['fill'],
          rows: p.rows as EditTilesOptions['rows'],
        },
        atlas,
      )
      const saved = p.save
        ? await assetServer(world).writeSource(guid ?? (p.asset as string), data.toJson())
        : null
      return { changed, saved }
    },
  },
]
