import { AssetStore, defineAssetType, defineDataAsset } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineComponent,
  defineResource,
  defineSchema,
  type Entity,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Visibility } from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'
import {
  flagsFromBase64,
  layerChunks,
  readChunkRows,
  rowsCanName,
  type TileEncoding,
  tilesFromBase64,
  tilesToBase64,
  toBase64,
} from './tilemap-format'

/** Tile flag bits. */
export const TileFlags = { FlipX: 1, FlipY: 2, Rotate90: 4 } as const

export const TilemapDataSchema = defineSchema(
  'sprite/TilemapData',
  {
    version: t.u8({
      default: 1,
      min: 1,
      max: 2,
      description: '2: tiles are named through the palette. 1 (old files): atlas region + 1.',
    }),
    encoding: t.enum(['base64', 'rows'], {
      description:
        'rows: layers hold chunks of run-length rows (readable, one-line diffs). base64: tiles and flags as base64.',
    }),
    chunkSize: t.u16({
      default: 16,
      min: 1,
      max: 256,
      description: 'Tiles per chunk side in the rows encoding.',
    }),
    palette: t.list(t.string, {
      description: 'Version 2: atlas region names; tile id N is palette entry N − 1.',
    }),
    layers: t.list(
      t.struct({
        name: t.string({ description: 'Layer name, e.g. "ground".' }),
        width: t.u32({ min: 1, description: 'Tiles across.' }),
        height: t.u32({ min: 1, description: 'Tiles down.' }),
        tiles: t.string({
          description:
            'base64 encoding: width × height little-endian u16s, row by row from the top: palette index + 1 (version 1: atlas region + 1); 0 is empty.',
        }),
        flags: t.string({
          description:
            'base64 encoding: width × height bytes: 1 flip x, 2 flip y, 4 rotate 90°. Empty: none.',
        }),
        chunks: t.json({
          default: {},
          description:
            'rows encoding: "cx,cy" → rows from the top of the chunk, each space-separated runs of name[:fx+fy+r90][*count], "." empty. Chunks with no tiles are left out.',
        }),
        occludes: t.bool({
          description: 'Filled cells block 2D light (shadowed PointLight2d and SpotLight2d).',
        }),
      }),
      { description: 'Layers, drawn in order.' },
    ),
    animations: t.list(
      t.struct({
        tile: t.json({
          description:
            'The tile that animates, everywhere it appears: a palette name (v1: a tile id).',
        }),
        frames: t.list(t.json, { description: 'Tiles it cycles through (names; v1: ids).' }),
        frameTime: t.f32({
          default: 0.2,
          min: 0.001,
          unit: 's',
          description: 'Seconds per frame.',
        }),
      }),
      { description: 'Animated tiles: water, torches, conveyor belts.' },
    ),
  },
  {
    description:
      'Tile layers for a Tilemap: tiles named through a palette of atlas regions, per-tile flags, animated tiles. Saved as readable rows or compact base64.',
  },
)

/** The most edits a layer logs before renderers re-upload it whole. */
const MAX_EDITS = 4096

export class TileLayer {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly tiles: Uint16Array
  readonly flags: Uint8Array
  /** Tile indices (y · width + x) edited since `editBase`: renderers upload their chunks. */
  edits: number[] = []
  /** Bumps when the edit log overflows: renderers re-upload everything. */
  editBase = 0
  /** Filled cells block 2D light. */
  occludes = false

  constructor(
    name: string,
    width: number,
    height: number,
    tiles?: Uint16Array,
    flags?: Uint8Array,
  ) {
    this.name = name
    this.width = width
    this.height = height
    this.tiles = tiles ?? new Uint16Array(width * height)
    this.flags = flags ?? new Uint8Array(width * height)
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0
    return this.tiles[y * this.width + x]!
  }

  set(x: number, y: number, tile: number, flags = 0): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new ShardError(
        'sprite/tile-out-of-range',
        `Tile (${x}, ${y}) is outside the ${this.width}×${this.height} layer "${this.name}"`,
      )
    }
    const i = y * this.width + x
    if (this.tiles[i] === tile && this.flags[i] === flags) return
    this.tiles[i] = tile
    this.flags[i] = flags
    if (this.edits.length >= MAX_EDITS) {
      this.edits.length = 0
      this.editBase++
    } else {
      this.edits.push(i)
    }
  }
}

/** Tile layers and animated tiles, shared by any number of Tilemaps. */
export class TilemapData {
  layers: TileLayer[]
  animations: { tile: number; frames: number[]; frameTime: number }[]
  /**
   * Atlas region names: tile id N draws the region named `palette[N - 1]` (0059). Undefined for
   * maps made before palettes, whose ids are atlas regions + 1.
   */
  palette: string[] | undefined
  /** How the map is saved: readable rows (the default) or compact base64. */
  encoding: TileEncoding = 'rows'
  /** Tiles per chunk side in the rows encoding. */
  chunkSize = 16
  /** Bumps when the layers are replaced (hot reload). */
  version = 0

  constructor(
    layers: TileLayer[] = [],
    animations: TilemapData['animations'] = [],
    palette?: string[],
  ) {
    this.layers = layers
    this.animations = animations
    this.palette = palette
  }

  /**
   * An empty map of `layers` layers, width × height tiles each. With a palette, tile ids name its
   * entries; without, they're atlas regions + 1.
   */
  static create(
    width: number,
    height: number,
    layers: string[] = ['main'],
    palette?: string[],
  ): TilemapData {
    return new TilemapData(
      layers.map((name) => new TileLayer(name, width, height)),
      [],
      palette ? [...palette] : undefined,
    )
  }

  /** The id of a palette name, adding it to the palette if it's new. Needs a palette. */
  tileId(name: string): number {
    if (!this.palette) {
      throw new ShardError('sprite/no-palette', 'This tilemap names no tiles (version 1)', {
        hint: 'Save it once with its atlas (tilemapToJson(data, { atlas })) to give it a palette.',
      })
    }
    let i = this.palette.indexOf(name)
    if (i === -1) {
      i = this.palette.length
      this.palette.push(name)
    }
    return i + 1
  }

  /** The name a tile id draws: through the palette, or the atlas for version 1 maps. */
  tileName(id: number, atlas?: { names: readonly string[] }): string | undefined {
    if (id === 0) return undefined
    return this.palette ? this.palette[id - 1] : atlas?.names[id - 1]
  }

  /** A map from its file's JSON (`$schema`, an editor's pointer, is ignored). */
  static fromJson(json: unknown): TilemapData {
    if (json && typeof json === 'object' && '$schema' in json) {
      const { $schema: _, ...body } = json as Record<string, unknown>
      json = body
    }
    const v = TilemapDataSchema.deserialize(json) as unknown as {
      version: number
      encoding: TileEncoding
      chunkSize: number
      palette: string[]
      layers: {
        name: string
        width: number
        height: number
        tiles: string
        flags: string
        chunks: unknown
        occludes: boolean
      }[]
      animations: { tile: unknown; frames: unknown[]; frameTime: number }[]
    }
    const named = v.version >= 2
    const palette = named ? [...v.palette] : undefined
    const index = new Map((palette ?? []).map((name, i) => [name, i]))
    const layers = v.layers.map((l, i) => {
      const n = l.width * l.height
      const path = `/layers/${i}`
      let tiles: Uint16Array
      let flags: Uint8Array
      if (named && v.encoding === 'rows') {
        tiles = new Uint16Array(n)
        flags = new Uint8Array(n)
        const grid = { width: l.width, height: l.height, tiles, flags }
        const chunks = (l.chunks ?? {}) as Record<string, unknown>
        if (typeof chunks !== 'object' || Array.isArray(chunks)) {
          throw new ShardError('sprite/invalid-tilemap', 'Expected chunks by "cx,cy"', {
            path: `${path}/chunks`,
          })
        }
        for (const [key, rows] of Object.entries(chunks)) {
          const m = /^(\d+),(\d+)$/.exec(key)
          const at = `${path}/chunks/${key}`
          if (!m) {
            throw new ShardError('sprite/invalid-tilemap', `Bad chunk key "${key}"`, {
              path: at,
              hint: 'Chunk keys are "cx,cy": the chunk column and row from the top left.',
            })
          }
          readChunkRows(grid, palette!, index, Number(m[1]), Number(m[2]), v.chunkSize, rows, at)
        }
      } else {
        tiles = tilesFromBase64(l.tiles, n, `${path}/tiles`, l.name)
        flags = flagsFromBase64(l.flags, n, `${path}/flags`, l.name)
        if (palette) {
          for (let k = 0; k < n; k++) {
            if (tiles[k]! > palette.length) {
              throw new ShardError(
                'sprite/invalid-tilemap',
                `Tile id ${tiles[k]} at (${k % l.width}, ${Math.floor(k / l.width)}) has no palette entry`,
                { path: `${path}/tiles` },
              )
            }
          }
        }
      }
      const layer = new TileLayer(l.name, l.width, l.height, tiles, flags)
      layer.occludes = l.occludes
      return layer
    })
    const idOf = (value: unknown, at: string): number => {
      if (!named) {
        if (typeof value !== 'number') {
          throw new ShardError('sprite/invalid-tilemap', 'Expected a tile id', { path: at })
        }
        return value
      }
      if (typeof value !== 'string') {
        throw new ShardError('sprite/invalid-tilemap', 'Expected a palette name', { path: at })
      }
      let p = index.get(value)
      if (p === undefined) {
        p = palette!.length
        palette!.push(value)
        index.set(value, p)
      }
      return p + 1
    }
    const animations = v.animations.map((a, i) => ({
      tile: idOf(a.tile, `/animations/${i}/tile`),
      frames: a.frames.map((f, k) => idOf(f, `/animations/${i}/frames/${k}`)),
      frameTime: a.frameTime,
    }))
    const data = new TilemapData(layers, animations, palette)
    data.encoding = named ? v.encoding : 'base64'
    data.chunkSize = v.chunkSize
    return data
  }

  /**
   * The map as version 2 JSON, in its encoding (or `options.encoding`). A version 1 map needs its
   * atlas to name its tiles; its palette lists them in first use order. A map with a palette keeps
   * it in order, so an edit that uses a known tile changes one row.
   */
  toJson(options: { encoding?: TileEncoding; atlas?: { names: readonly string[] } } = {}) {
    const encoding = options.encoding ?? this.encoding
    let palette: string[]
    let remap: ((id: number) => number) | undefined
    if (this.palette) palette = this.palette
    else {
      const atlas = options.atlas
      if (!atlas) {
        throw new ShardError(
          'sprite/tilemap-needs-atlas',
          'Saving a version 1 tilemap needs its atlas',
          {
            hint: 'Its tiles are atlas regions: pass the atlas so they can be named (the palette).',
          },
        )
      }
      palette = []
      const byRegion = new Map<number, number>()
      const use = (id: number) => {
        if (id === 0) return 0
        let p = byRegion.get(id)
        if (p === undefined) {
          const name = atlas.names[id - 1]
          if (name === undefined) {
            throw new ShardError(
              'sprite/unknown-tile',
              `Tile ${id} is past the atlas's ${atlas.names.length} regions`,
            )
          }
          p = palette.length
          palette.push(name)
          byRegion.set(id, p)
        }
        return p + 1
      }
      for (const l of this.layers) for (let k = 0; k < l.tiles.length; k++) use(l.tiles[k]!)
      for (const a of this.animations) {
        use(a.tile)
        for (const f of a.frames) use(f)
      }
      remap = use
    }
    if (encoding === 'rows') {
      for (const name of palette) {
        if (!rowsCanName(name)) {
          throw new ShardError(
            'sprite/unencodable-tile',
            `Tile "${name}" can't be written in rows`,
            {
              hint: 'Region names in rows have no spaces, ":", "*" or "+". Save with encoding base64.',
            },
          )
        }
      }
    }
    const idsOf = (l: TileLayer): Uint16Array => {
      if (!remap) return l.tiles
      const out = new Uint16Array(l.tiles.length)
      for (let k = 0; k < out.length; k++) out[k] = remap(l.tiles[k]!)
      return out
    }
    const name = (id: number) => palette[(remap ? remap(id) : id) - 1]!
    return {
      version: 2,
      encoding,
      ...(encoding === 'rows' ? { chunkSize: this.chunkSize } : {}),
      palette: [...palette],
      layers: this.layers.map((l) => {
        const tiles = idsOf(l)
        const head = { name: l.name, width: l.width, height: l.height }
        const cells =
          encoding === 'rows'
            ? {
                chunks: layerChunks(
                  { width: l.width, height: l.height, tiles, flags: l.flags },
                  palette,
                  this.chunkSize,
                ),
              }
            : {
                tiles: tilesToBase64(tiles),
                flags: l.flags.some((f) => f !== 0) ? toBase64(l.flags) : '',
              }
        return { ...head, ...cells, ...(l.occludes ? { occludes: true } : {}) }
      }),
      animations: this.animations.map((a) => ({
        tile: name(a.tile),
        frames: a.frames.map(name),
        frameTime: a.frameTime,
      })),
    }
  }

  private sameAs(other: TilemapData): boolean {
    if (
      this.encoding !== other.encoding ||
      this.chunkSize !== other.chunkSize ||
      this.layers.length !== other.layers.length ||
      JSON.stringify(this.palette) !== JSON.stringify(other.palette) ||
      JSON.stringify(this.animations) !== JSON.stringify(other.animations)
    )
      return false
    for (let i = 0; i < this.layers.length; i++) {
      const a = this.layers[i]!
      const b = other.layers[i]!
      if (a.name !== b.name || a.width !== b.width || a.height !== b.height) return false
      if (a.occludes !== b.occludes) return false
      for (let k = 0; k < a.tiles.length; k++) {
        if (a.tiles[k] !== b.tiles[k] || a.flags[k] !== b.flags[k]) return false
      }
    }
    return true
  }

  /** The largest tile index any layer uses (for validating against an atlas). */
  maxTile(): number {
    let max = 0
    for (const l of this.layers)
      for (let k = 0; k < l.tiles.length; k++) max = Math.max(max, l.tiles[k]!)
    return max
  }

  /** Takes another map's content (hot reload). Identical content (a save reloading) changes nothing. */
  copyFrom(other: TilemapData): void {
    if (this.sameAs(other)) return
    this.layers = other.layers
    this.animations = other.animations
    this.palette = other.palette
    this.encoding = other.encoding
    this.chunkSize = other.chunkSize
    this.version++
  }
}

/** The palette itself when the map has one; else the atlas's names (version 1 ids are regions + 1). */
export function tileNames(
  data: TilemapData,
  atlas?: { names: readonly string[] },
): readonly string[] {
  if (data.palette) return data.palette
  if (atlas) return atlas.names
  throw new ShardError('sprite/tilemap-needs-atlas', 'This tilemap names no tiles (version 1)', {
    hint: 'Give a Tilemap using it an atlas, or save it once with one (tilemapToText(data, { atlas })).',
  })
}

/** A tilemap file's text: its JSON, two-space indented, a newline at the end. */
export function tilemapToText(
  data: TilemapData,
  options: {
    encoding?: TileEncoding
    atlas?: { names: readonly string[] }
    /** The file's `$schema`, written first. */
    schema?: string
  } = {},
): string {
  const json = data.toJson(options)
  return `${JSON.stringify(options.schema === undefined ? json : { $schema: options.schema, ...json }, null, 2)}\n`
}

export class TilemapDataStore extends AssetStore<TilemapData, 'TilemapData'> {
  constructor() {
    super('TilemapData')
  }
}

export const TilemapDatas = defineResource<TilemapDataStore>('sprite/TilemapDatas', {
  description: 'Loaded tilemap data by guid.',
  init: () => new TilemapDataStore(),
})

export const TilemapDataAssetType = defineAssetType<TilemapData>('TilemapData', {
  store: TilemapDatas,
  load: (artifact) => TilemapData.fromJson(artifact.json),
  update: (existing, next) => existing.copyFrom(next),
})

/** `*.tilemap.json`: tile layers for a Tilemap. */
export const TilemapDataImporter = defineDataAsset('TilemapData', TilemapDataSchema, {
  extension: 'tilemap',
})

export const Tilemap = defineComponent(
  'sprite/Tilemap',
  {
    atlas: t.handle('TextureAtlas', { description: 'Tile N draws region N − 1.' }),
    data: t.handle('TilemapData', { description: 'The tile layers.' }),
    tileSize: t.vec2({
      default: [1, 1],
      min: 0,
      unit: 'm',
      description: 'World size of one tile.',
    }),
    chunkSize: t.u16({
      default: 32,
      min: 4,
      max: 256,
      description: 'Tiles per chunk side: chunks are the unit of culling and re-upload.',
    }),
    layer: t.i16({
      description: 'Draw-order band, like Sprite.layer (tilemaps draw first in a band).',
    }),
    lit: t.enum(['2d', '3d', 'none'], {
      description:
        '2d: lit by 2D lights under a Lighting2d camera. 3d: lit by 3D lights and shadows like a floor. none: drawn as the atlas is. On the ground (with a GroundLayer) there are no 2D lights: 2d and 3d both light it like a floor.',
    }),
  },
  {
    description:
      "Tile layers drawn over the entity's XY plane: tile (x, y) covers [x, x+1] × [−y−1, −y] tile sizes, rows going down from the top. With a GroundLayer (0059), they draw in the ground phase among the tabletop's bands (lay them flat with tilemapOnGround).",
    requires: [Transform, Visibility],
    version: 2,
    // Version 1: lit was a flag for 2D lighting.
    migrate: (_from, json) => {
      const v = { ...(json as Record<string, unknown>) }
      if (typeof v.lit === 'boolean') v.lit = v.lit ? '2d' : 'none'
      return v
    },
  },
)

function layerOf(world: World, tilemap: Entity, layer: number | string) {
  const value = world.get(tilemap, Tilemap)
  if (!value) {
    throw new ShardError('sprite/not-a-tilemap', `Entity ${tilemap} has no Tilemap`)
  }
  const data = world.resource(TilemapDatas).get(value.data as AssetRef<'TilemapData'>)
  if (!data) {
    throw new ShardError('sprite/tilemap-not-loaded', `Tilemap ${tilemap} has no loaded data`, {
      hint: 'Wait for its TilemapData asset, or create one with TilemapData.create.',
    })
  }
  const l =
    typeof layer === 'number' ? data.layers[layer] : data.layers.find((x) => x.name === layer)
  if (!l) {
    throw new ShardError(
      'sprite/no-layer',
      `Tilemap ${tilemap} has no layer ${JSON.stringify(layer)}`,
    )
  }
  return l
}

/** Sets a tile (atlas region + 1, 0 to clear) and its flags. Only its chunk re-uploads. */
export function setTile(
  world: World,
  tilemap: Entity,
  x: number,
  y: number,
  tile: number,
  options: { layer?: number | string; flags?: number } = {},
): void {
  layerOf(world, tilemap, options.layer ?? 0).set(x, y, tile, options.flags ?? 0)
}

/** The tile at (x, y): atlas region + 1, or 0 for empty or outside the map. */
export function tileAt(
  world: World,
  tilemap: Entity,
  x: number,
  y: number,
  layer: number | string = 0,
): number {
  return layerOf(world, tilemap, layer).get(x, y)
}

/**
 * Palette names the atlas has no region for (0059), each as `sprite/unknown-tile` naming the
 * name, the first layer and cell that use it, and a JSON pointer to where that cell is saved: its
 * row in the rows encoding, or the layer's tiles in base64. Version 1 maps name no tiles: none.
 */
export function unknownTiles(
  data: TilemapData,
  atlas: { region(name: string): number },
): ShardError[] {
  const out: ShardError[] = []
  if (!data.palette) return out
  for (let i = 0; i < data.palette.length; i++) {
    const name = data.palette[i]!
    if (atlas.region(name) !== -1) continue
    const id = i + 1
    let where: { layer: number; x: number; y: number } | undefined
    for (let li = 0; li < data.layers.length && !where; li++) {
      const l = data.layers[li]!
      const at = l.tiles.indexOf(id)
      if (at !== -1) where = { layer: li, x: at % l.width, y: Math.floor(at / l.width) }
    }
    if (!where) continue
    const l = data.layers[where.layer]!
    const cs = data.chunkSize
    const path =
      data.encoding === 'rows'
        ? `/layers/${where.layer}/chunks/${Math.floor(where.x / cs)},${Math.floor(where.y / cs)}/${where.y % cs}`
        : `/layers/${where.layer}/tiles`
    out.push(
      new ShardError(
        'sprite/unknown-tile',
        `Layer "${l.name}", cell (${where.x}, ${where.y}): tile "${name}" isn't a region of the atlas`,
        {
          path,
          hint: 'Rename it to a region the atlas has, or add the region to the atlas.',
        },
      ),
    )
  }
  return out
}
