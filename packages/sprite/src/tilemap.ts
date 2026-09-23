import { AssetStore, defineAssetType, defineDataAsset } from '@shard/assets'
import {
  type AssetRef,
  defineComponent,
  defineResource,
  defineSchema,
  type Entity,
  ShardError,
  t,
  type World,
} from '@shard/core'
import { Visibility } from '@shard/render'
import { Transform } from '@shard/transform'

/** Tile flag bits. */
export const TileFlags = { FlipX: 1, FlipY: 2, Rotate90: 4 } as const

export const TilemapDataSchema = defineSchema(
  'sprite/TilemapData',
  {
    layers: t.list(
      t.struct({
        name: t.string({ description: 'Layer name, e.g. "ground".' }),
        width: t.u32({ min: 1, description: 'Tiles across.' }),
        height: t.u32({ min: 1, description: 'Tiles down.' }),
        tiles: t.string({
          description:
            'Base64 of width × height little-endian u16s, row by row from the top: atlas region + 1 (0 is empty).',
        }),
        flags: t.string({
          description:
            'Base64 of width × height bytes: 1 flip x, 2 flip y, 4 rotate 90°. Empty: none.',
        }),
      }),
      { description: 'Layers, drawn in order.' },
    ),
    animations: t.list(
      t.struct({
        tile: t.u16({ min: 1, description: 'The tile that animates, everywhere it appears.' }),
        frames: t.list(t.u16, { description: 'Tiles it cycles through.' }),
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
      'Tile layers for a Tilemap: indices into its atlas, per-tile flags, animated tiles.',
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
  /** Bumps when the layers are replaced (hot reload). */
  version = 0

  constructor(layers: TileLayer[] = [], animations: TilemapData['animations'] = []) {
    this.layers = layers
    this.animations = animations
  }

  /** An empty map of `layers` layers, width × height tiles each. */
  static create(width: number, height: number, layers: string[] = ['main']): TilemapData {
    return new TilemapData(layers.map((name) => new TileLayer(name, width, height)))
  }

  static fromJson(json: unknown): TilemapData {
    const v = TilemapDataSchema.deserialize(json) as unknown as {
      layers: { name: string; width: number; height: number; tiles: string; flags: string }[]
      animations: TilemapData['animations']
    }
    const layers = v.layers.map((l, i) => {
      const n = l.width * l.height
      const tileBytes = fromBase64(l.tiles)
      if (tileBytes.length !== n * 2) {
        throw new ShardError(
          'sprite/invalid-tilemap',
          `Layer "${l.name}" has ${tileBytes.length / 2} tiles; ${l.width}×${l.height} needs ${n}`,
          { path: `/layers/${i}/tiles` },
        )
      }
      const tiles = new Uint16Array(n)
      const view = new DataView(tileBytes.buffer, tileBytes.byteOffset, tileBytes.byteLength)
      for (let k = 0; k < n; k++) tiles[k] = view.getUint16(k * 2, true)
      let flags: Uint8Array | undefined
      if (l.flags) {
        flags = fromBase64(l.flags)
        if (flags.length !== n) {
          throw new ShardError(
            'sprite/invalid-tilemap',
            `Layer "${l.name}" has ${flags.length} flag bytes; ${l.width}×${l.height} needs ${n}`,
            { path: `/layers/${i}/flags` },
          )
        }
      }
      return new TileLayer(l.name, l.width, l.height, tiles, flags)
    })
    return new TilemapData(layers, v.animations)
  }

  toJson() {
    return {
      layers: this.layers.map((l) => {
        const bytes = new Uint8Array(l.tiles.length * 2)
        const view = new DataView(bytes.buffer)
        for (let k = 0; k < l.tiles.length; k++) view.setUint16(k * 2, l.tiles[k]!, true)
        return {
          name: l.name,
          width: l.width,
          height: l.height,
          tiles: toBase64(bytes),
          flags: l.flags.some((f) => f !== 0) ? toBase64(l.flags) : '',
        }
      }),
      animations: this.animations,
    }
  }

  /** The largest tile index any layer uses (for validating against an atlas). */
  maxTile(): number {
    let max = 0
    for (const l of this.layers)
      for (let k = 0; k < l.tiles.length; k++) max = Math.max(max, l.tiles[k]!)
    return max
  }

  copyFrom(other: TilemapData): void {
    this.layers = other.layers
    this.animations = other.animations
    this.version++
  }
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
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
  },
  {
    description:
      "Tile layers drawn over the entity's XY plane: tile (x, y) covers [x, x+1] × [−y−1, −y] tile sizes, rows going down from the top.",
    requires: [Transform, Visibility],
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
