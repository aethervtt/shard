import {
  type AssetRef,
  defineResource,
  defineSystem,
  type Entity,
  onRemove,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import {
  type CameraData,
  ComputedVisibility,
  cameraOf,
  DataStore,
  dataEntry,
  Gpu,
  GpuAssetsResource,
  GroundLayer,
  type NodeContext,
  type NodeDescriptor,
  PICK_TARGETS,
  RenderPhase,
  type RenderView,
  Shaders,
  sceneColor,
} from '@aethervtt/shard-render'
import { LogResource, Time } from '@aethervtt/shard-runtime'
import { type Texture, Textures } from '@aethervtt/shard-texture'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { TextureAtlases } from './atlas'
import { layerBit, SpriteLighting } from './lighting'
import {
  describeLights2d,
  type LightView2d,
  lights2dGroup,
  lights2dLayout,
  litView,
} from './lights2d'
import { Sprite, Sprite2dSettings, SpriteSlot } from './sprite'
import { Tilemap, type TilemapData, TilemapDatas, unknownTiles } from './tilemap'

/** Floats per sprite record: affine rows (12), uv rect (4), size (2), anchor (2), color, flags, pad. */
export const SPRITE_FLOATS = 24
const SPRITE_BYTES = SPRITE_FLOATS * 4

const BLEND_ALPHA = 0
const BLEND_ADDITIVE = 1
const BLEND_OPAQUE = 2
const SPACE_WORLD = 0
const SPACE_SCREEN = 1

/** Sprites sharing a texture, blend, and space: one draw per contiguous run in sorted order. */
export interface SpriteBatch {
  index: number
  texture: Texture
  /** The normal map lit views sample (2D lighting), or null. */
  normal: Texture | null
  blend: number
  space: number
  count: number
}

/** A draw: `count` sprites of one batch from `first` in the sorted order. */
interface Run {
  batch: SpriteBatch
  first: number
  count: number
  layer: number
}

const f32 = Math.fround
const orderScratch = new Float32Array(1)
const orderBits = new Uint32Array(orderScratch.buffer)

/** Maps a float to a u32 that sorts in the same order (sign flip, then invert negatives). */
function orderable(v: number): number {
  orderScratch[0] = v
  const b = orderBits[0]!
  return (b & 0x80000000 ? ~b : b | 0x80000000) >>> 0
}

/**
 * Persistent sprite records: each Sprite entity owns a slot, rewritten when its components or
 * transform change and uploaded in coalesced runs. Draw order is a sorted slot list, rebuilt only
 * when a sort key or batch changes: layer, then depth (z, or −y), then batch, so sprites sharing
 * a layer and depth group into as few draws as their textures allow.
 */
export class SpriteStore {
  capacity = 0
  high = 0
  f32 = new Float32Array(0)
  u32 = new Uint32Array(0)
  /** Batch per slot, or -1 (hidden, freed, or waiting on an asset). */
  batchOf = new Int32Array(0)
  keyHi = new Uint32Array(0)
  keyLo = new Uint32Array(0)
  entities = new Float64Array(0)
  private readonly free: number[] = []
  private dirty = new Uint8Array(0)
  private dirtyLo = Number.POSITIVE_INFINITY
  private dirtyHi = -1
  /** Slots waiting for a texture or atlas to load. */
  readonly pending = new Set<number>()
  readonly batches: SpriteBatch[] = []
  private readonly byTexture = new Map<Texture, SpriteBatch[]>()
  order = new Uint32Array(0)
  orderCount = 0
  orderDirty = true
  readonly runs: Run[] = []
  runCount = 0
  /** Sprites per layer in the last sort. */
  readonly perLayer = new Map<number, number>()
  /** Bytes of sprite records uploaded this frame. */
  uploadedBytes = 0
  sorts = 0
  readonly records: DataStore
  readonly orderBuffer: DataStore
  private orderUploaded = true
  /** Hidden sprites per ECS table id, from the last visit. */
  readonly tableSeen: number[] = []
  private readonly gpu: GpuContext
  private generation: number

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.generation = gpu.generation
    // Storage on the full tier, data textures on baseline (0064).
    this.records = new DataStore(gpu, { label: 'sprites', size: SPRITE_BYTES * 256 })
    this.orderBuffer = new DataStore(gpu, { label: 'sprites/order', size: 1024 })
    this.grow(256)
  }

  get live(): number {
    return this.high - this.free.length
  }

  private grow(capacity: number): void {
    const f = new Float32Array(capacity * SPRITE_FLOATS)
    f.set(this.f32)
    this.f32 = f
    this.u32 = new Uint32Array(f.buffer)
    const grow32 = <T extends Int32Array | Uint32Array | Uint8Array | Float64Array>(
      a: T,
      make: (n: number) => T,
    ) => {
      const next = make(capacity)
      next.set(a as never)
      return next
    }
    this.batchOf = grow32(this.batchOf, (n) => new Int32Array(n).fill(-1))
    this.keyHi = grow32(this.keyHi, (n) => new Uint32Array(n))
    this.keyLo = grow32(this.keyLo, (n) => new Uint32Array(n))
    this.entities = grow32(this.entities, (n) => new Float64Array(n))
    this.dirty = grow32(this.dirty, (n) => new Uint8Array(n))
    this.capacity = capacity
  }

  alloc(entity: Entity): number {
    let slot = this.free.pop()
    if (slot === undefined) {
      if (this.high >= this.capacity) this.grow(this.capacity * 2)
      slot = this.high++
    }
    this.entities[slot] = entity
    this.batchOf[slot] = -1
    return slot
  }

  release(slot: number): void {
    this.assign(slot, -1)
    this.pending.delete(slot)
    this.free.push(slot)
  }

  markDirty(slot: number): void {
    if (this.dirty[slot]) return
    this.dirty[slot] = 1
    if (slot < this.dirtyLo) this.dirtyLo = slot
    if (slot > this.dirtyHi) this.dirtyHi = slot
  }

  /** The batch for a texture, normal map, blend, and space, made on first use. */
  batchFor(
    texture: Texture,
    blend: number,
    space: number,
    normal: Texture | null = null,
  ): SpriteBatch {
    let list = this.byTexture.get(texture)
    if (!list) {
      list = []
      this.byTexture.set(texture, list)
    }
    for (const b of list)
      if (b.blend === blend && b.space === space && b.normal === normal) return b
    const batch: SpriteBatch = {
      index: this.batches.length,
      texture,
      normal,
      blend,
      space,
      count: 0,
    }
    this.batches.push(batch)
    list.push(batch)
    return batch
  }

  assign(slot: number, batch: number): void {
    const old = this.batchOf[slot]!
    if (old === batch) return
    if (old >= 0) this.batches[old]!.count--
    if (batch >= 0) this.batches[batch]!.count++
    this.batchOf[slot] = batch
    this.orderDirty = true
  }

  setKey(slot: number, hi: number, lo: number): void {
    if (this.keyHi[slot] === hi && this.keyLo[slot] === lo) return
    this.keyHi[slot] = hi
    this.keyLo[slot] = lo
    if (this.batchOf[slot]! >= 0) this.orderDirty = true
  }

  // Radix sort scratch: two ping-pong index lists and a 16-bit histogram.
  private sortA = new Uint32Array(0)
  private sortB = new Uint32Array(0)
  private readonly counts = new Uint32Array(65536)

  /** Sorts drawable slots by (keyHi, keyLo): four 16-bit LSD radix passes. Then builds runs. */
  sort(): void {
    this.orderDirty = false
    this.sorts++
    let n = 0
    if (this.sortA.length < this.high) {
      this.sortA = new Uint32Array(this.capacity)
      this.sortB = new Uint32Array(this.capacity)
    }
    for (let s = 0; s < this.high; s++) if (this.batchOf[s]! >= 0) this.sortA[n++] = s
    let src = this.sortA
    let dst = this.sortB
    const counts = this.counts
    for (let pass = 0; pass < 4; pass++) {
      const keys = pass < 2 ? this.keyLo : this.keyHi
      const shift = (pass & 1) * 16
      counts.fill(0)
      for (let i = 0; i < n; i++) counts[(keys[src[i]!]! >>> shift) & 0xffff]!++
      let sum = 0
      for (let k = 0; k < 65536; k++) {
        const c = counts[k]!
        counts[k] = sum
        sum += c
      }
      for (let i = 0; i < n; i++) {
        const slot = src[i]!
        dst[counts[(keys[slot]! >>> shift) & 0xffff]!++] = slot
      }
      const t = src
      src = dst
      dst = t
    }
    if (this.order.length < n) this.order = new Uint32Array(Math.max(1024, n * 2))
    this.order.set(src.subarray(0, n))
    this.orderCount = n
    this.orderUploaded = false
    // Runs: consecutive slots of one batch.
    this.runCount = 0
    this.perLayer.clear()
    let current = -1
    for (let i = 0; i < n; i++) {
      const slot = this.order[i]!
      const b = this.batchOf[slot]!
      const layer = (this.keyHi[slot]! >>> 16) - 32768
      this.perLayer.set(layer, (this.perLayer.get(layer) ?? 0) + 1)
      if (b !== current || this.runs[this.runCount - 1]!.layer !== layer) {
        let run = this.runs[this.runCount]
        if (!run) {
          run = { batch: this.batches[b]!, first: i, count: 0, layer }
          this.runs.push(run)
        }
        run.batch = this.batches[b]!
        run.first = i
        run.count = 0
        run.layer = layer
        this.runCount++
        current = b
      }
      this.runs[this.runCount - 1]!.count++
    }
  }

  /** Uploads dirty records in coalesced runs, and the order when it changed. */
  upload(): void {
    if (this.generation !== this.gpu.generation) {
      this.generation = this.gpu.generation
      this.dirtyLo = 0
      this.dirtyHi = this.high - 1
      this.dirty.fill(1, 0, this.high)
      this.orderUploaded = false
    }
    // A grown GPU buffer starts empty: every live record has to go up again, not just dirty ones.
    if (this.records.ensureCapacity(this.capacity * SPRITE_BYTES) && this.high > 0) {
      this.dirtyLo = 0
      this.dirtyHi = this.high - 1
      this.dirty.fill(1, 0, this.high)
    }
    let bytes = 0
    let start = -1
    for (let s = this.dirtyLo; s <= this.dirtyHi + 1; s++) {
      if (s <= this.dirtyHi && this.dirty[s] === 1) {
        this.dirty[s] = 0
        if (start < 0) start = s
      } else if (start >= 0) {
        const n = s - start
        this.records.write(this.f32, start * SPRITE_BYTES, start * SPRITE_FLOATS, n * SPRITE_FLOATS)
        bytes += n * SPRITE_BYTES
        start = -1
      }
    }
    this.dirtyLo = Number.POSITIVE_INFINITY
    this.dirtyHi = -1
    if (!this.orderUploaded && this.orderCount > 0) {
      this.orderBuffer.write(this.order, 0, 0, this.orderCount)
      bytes += this.orderCount * 4
    }
    this.orderUploaded = true
    this.uploadedBytes = bytes
  }
}

export const Sprites = defineResource<SpriteStore>('sprite/Sprites', {
  description:
    'The sprite renderer: persistent sprite records, batches, and the sorted draw order.',
})

// --- extraction ------------------------------------------------------------------------------

const packScratch = new Uint8Array(4)
const packView = new Uint32Array(packScratch.buffer)
const halfScratch = new Float32Array(1)
const halfBits = new Uint32Array(halfScratch.buffer)

/** A float as IEEE half bits (round to nearest, clamped to the half range). */
function half(v: number): number {
  halfScratch[0] = v
  const x = halfBits[0]!
  const sign = (x >>> 16) & 0x8000
  const e = ((x >>> 23) & 0xff) - 127 + 15
  if (e <= 0) return sign
  if (e >= 31) return sign | 0x7bff
  return sign | (e << 10) | (((x >>> 13) & 0x3ff) + ((x >>> 12) & 1))
}
function packColor(c: ArrayLike<number>, o: number): number {
  for (let k = 0; k < 4; k++) packScratch[k] = Math.round(Math.min(1, Math.max(0, c[o + k]!)) * 255)
  return packView[0]!
}

interface Columns {
  texture: (AssetRef<'Texture'> | null)[]
  atlas: (AssetRef<'TextureAtlas'> | null)[]
  region: string[]
  color: Float32Array
  flipX: Uint8Array
  flipY: Uint8Array
  anchor: Float32Array
  size: Float32Array
  layer: Int16Array
  blend: Uint8Array
  space: Uint8Array
  lit: Uint8Array
  g: Float32Array
  visible: Uint8Array
  /** SpriteLighting, when the table has it. */
  normal: (AssetRef<'Texture'> | null)[] | undefined
  emissive: Float32Array | undefined
  normalStrength: Float32Array | undefined
}

function columns(table: Table): Columns {
  return {
    texture: table.column(Sprite, 'texture') as unknown as Columns['texture'],
    atlas: table.column(Sprite, 'atlas') as unknown as Columns['atlas'],
    region: table.column(Sprite, 'region') as unknown as string[],
    color: table.column(Sprite, 'color') as unknown as Float32Array,
    flipX: table.column(Sprite, 'flipX') as unknown as Uint8Array,
    flipY: table.column(Sprite, 'flipY') as unknown as Uint8Array,
    anchor: table.column(Sprite, 'anchor') as unknown as Float32Array,
    size: table.column(Sprite, 'size') as unknown as Float32Array,
    layer: table.column(Sprite, 'layer') as unknown as Int16Array,
    blend: table.column(Sprite, 'blend') as unknown as Uint8Array,
    space: table.column(Sprite, 'space') as unknown as Uint8Array,
    lit: table.column(Sprite, 'lit') as unknown as Uint8Array,
    g: table.column(GlobalTransform, 'matrix') as unknown as Float32Array,
    visible: table.column(ComputedVisibility, 'visible') as unknown as Uint8Array,
    normal: table.has(SpriteLighting)
      ? (table.column(SpriteLighting, 'normal') as unknown as Columns['normal'])
      : undefined,
    emissive: table.has(SpriteLighting)
      ? (table.column(SpriteLighting, 'emissive') as unknown as Float32Array)
      : undefined,
    normalStrength: table.has(SpriteLighting)
      ? (table.column(SpriteLighting, 'normalStrength') as unknown as Float32Array)
      : undefined,
  }
}

/** Light flags of a sprite record: 1 lit, 2 has a normal map, light-layer band << 8. */
function lightFlags(lit: boolean, normal: boolean, layer: number): number {
  return (lit ? 1 : 0) | (normal ? 2 : 0) | ((31 - Math.clz32(layerBit(layer))) << 8)
}

/** Writes one sprite's record, batch, and sort key. Returns false when an asset isn't loaded. */
function extractSprite(
  world: World,
  store: SpriteStore,
  slot: number,
  c: Columns,
  i: number,
): boolean {
  const atlases = world.resource(TextureAtlases)
  const textures = world.resource(Textures)
  const settings = world.resource(Sprite2dSettings)
  const f = store.f32
  const o = slot * SPRITE_FLOATS
  let texture: Texture | undefined
  let rx = 0
  let ry = 0
  let rw = 0
  let rh = 0
  let ax = c.anchor[i * 2]!
  let ay = c.anchor[i * 2 + 1]!
  let normal: Texture | null = null
  const atlasRef = c.atlas[i]
  if (atlasRef && (atlasRef.guid || atlasRef.path) && c.region[i]) {
    const atlas = atlases.get(atlasRef)
    if (!atlas) return false
    const r = atlas.region(c.region[i]!)
    texture = textures.get(atlas.texture)
    if (!texture) return false
    if (atlas.normals) {
      normal = textures.get(atlas.normals) ?? null
      if (!normal) return false
    }
    if (r < 0) {
      store.assign(slot, -1)
      return true
    }
    rx = atlas.rects[r * 4]!
    ry = atlas.rects[r * 4 + 1]!
    rw = atlas.rects[r * 4 + 2]!
    rh = atlas.rects[r * 4 + 3]!
    const px = atlas.pivots[r * 2]!
    const py = atlas.pivots[r * 2 + 1]!
    if (px !== 0.5 || py !== 0.5) {
      ax = px
      ay = py
    }
  } else {
    const ref = c.texture[i]
    if (!ref || (!ref.guid && !ref.path)) {
      store.assign(slot, -1)
      return true
    }
    texture = textures.get(ref)
    if (!texture) return false
    rw = texture.width
    rh = texture.height
  }
  const normalRef = c.normal?.[i]
  if (normalRef && (normalRef.guid || normalRef.path)) {
    normal = textures.get(normalRef) ?? null
    if (!normal) return false
  }
  const tw = texture.width
  const th = texture.height
  let u0 = rx / tw
  let u1 = (rx + rw) / tw
  let v0 = ry / th
  let v1 = (ry + rh) / th
  if (c.flipX[i]) {
    const t = u0
    u0 = u1
    u1 = t
  }
  if (c.flipY[i]) {
    const t = v0
    v0 = v1
    v1 = t
  }
  const space = c.space[i]!
  let w = c.size[i * 2]!
  let h = c.size[i * 2 + 1]!
  if (w === 0 && h === 0) {
    const ppu = space === SPACE_SCREEN ? 1 : settings.pixelsPerUnit
    w = rw / ppu
    h = rh / ppu
  }
  const g = c.g
  for (let k = 0; k < 12; k++) f[o + k] = g[i * 12 + k]!
  f[o + 12] = u0
  f[o + 13] = v0
  f[o + 14] = u1
  f[o + 15] = v1
  f[o + 16] = w
  f[o + 17] = h
  f[o + 18] = ax
  f[o + 19] = ay
  store.u32[o + 20] = packColor(c.color, i * 4)
  store.u32[o + 21] = lightFlags(c.lit[i] !== 0, normal !== null, c.layer[i]!)
  // The entity, for the picking pass.
  store.u32[o + 22] = store.entities[slot]! % 0x100000000
  // Emissive and normal strength as two halves (2D lighting).
  store.u32[o + 23] =
    (half(c.emissive ? c.emissive[i]! : 0) |
      (half(c.normalStrength ? c.normalStrength[i]! : 1) << 16)) >>>
    0
  store.markDirty(slot)
  const blend = c.blend[i]!
  const batch = c.visible[i] ? store.batchFor(texture, blend, space, normal).index : -1
  store.assign(slot, batch)
  // Layer, then depth (z, or -y for top-down), then batch: sprites at one depth group by texture.
  const depth = settings.sort === 'y' ? -g[i * 12 + 7]! : g[i * 12 + 11]!
  const d = orderable(f32(depth))
  store.setKey(
    slot,
    (((c.layer[i]! + 32768) << 16) | (d >>> 16)) >>> 0,
    (((d & 0xffff) << 16) | (batch & 0xffff)) >>> 0,
  )
  return true
}

function tableChanged(table: Table, since: number): boolean {
  return (
    table.lastStructural > since ||
    table.lastChanged(Sprite) > since ||
    (table.has(SpriteLighting) && table.lastChanged(SpriteLighting) > since) ||
    table.lastChanged(GlobalTransform) > since ||
    table.lastChanged(ComputedVisibility) > since ||
    table.lastChanged(SpriteSlot) > since
  )
}

/**
 * Assigns sprite slots, rewrites the records of sprites whose components or transform changed,
 * retries sprites waiting on assets, re-sorts when a key changed, and uploads.
 */
export const prepareSprites = defineSystem({
  name: 'sprite/prepare',
  description: 'Writes changed sprites into the sprite buffer, sorts, and uploads.',
  setup: (world) => ({
    q: world.query({ with: [Sprite, GlobalTransform, ComputedVisibility, SpriteSlot] }),
    atlasVersions: new Map<unknown, number>(),
    textureVersions: new Map<Texture, number>(),
  }),
  run: ({ q, atlasVersions, textureVersions }, world, ctx) => {
    const store = world.resource(Sprites)
    const since = ctx.lastRunTick
    // An atlas or texture that changed (hot reload) re-extracts everything.
    let force = false
    for (const [guid, atlas] of world.resource(TextureAtlases).entries()) {
      if (atlasVersions.get(guid) !== atlas.version) {
        if (atlasVersions.has(guid)) force = true
        atlasVersions.set(guid, atlas.version)
      }
    }
    for (const batch of store.batches) {
      const v = textureVersions.get(batch.texture)
      if (v !== undefined && v !== batch.texture.version) force = true
      textureVersions.set(batch.texture, batch.texture.version)
    }
    for (const table of q.tables) {
      const n = table.count
      if (n === 0) continue
      if (!force && store.tableSeen[table.id] === 1 && !tableChanged(table, since)) continue
      store.tableSeen[table.id] = 1
      const slots = table.column(SpriteSlot, 'slot')
      const sChanged = table.changedTicks(Sprite)
      const gChanged = table.changedTicks(GlobalTransform)
      const vChanged = table.changedTicks(ComputedVisibility)
      const lChanged = table.has(SpriteLighting) ? table.changedTicks(SpriteLighting) : undefined
      const c = columns(table)
      for (let i = 0; i < n; i++) {
        let slot = slots[i]! - 1
        let fresh = false
        if (slot < 0) {
          slot = store.alloc(table.entities[i]!)
          slots[i] = slot + 1
          fresh = true
        }
        if (
          !fresh &&
          !force &&
          sChanged[i]! <= since &&
          gChanged[i]! <= since &&
          vChanged[i]! <= since &&
          (lChanged === undefined || lChanged[i]! <= since)
        )
          continue
        if (extractSprite(world, store, slot, c, i)) store.pending.delete(slot)
        else {
          store.assign(slot, -1)
          store.pending.add(slot)
        }
      }
    }
    // Sprites waiting on an asset: try again.
    if (store.pending.size > 0) {
      for (const slot of store.pending) {
        const entity = store.entities[slot]!
        if (!world.isAlive(entity)) {
          store.pending.delete(slot)
          continue
        }
        const table = world.entityTable(entity)
        if (extractSprite(world, store, slot, columns(table), world.entityRow(entity))) {
          store.pending.delete(slot)
        }
      }
    }
    if (store.orderDirty) store.sort()
    store.upload()
    syncTilemaps(world)
  },
})

/** Frees a sprite's slot when the Sprite goes away (including on despawn). */
export function observeSpriteRemovals(world: World): void {
  world.observe(onRemove(Sprite), ({ entity, world }) => {
    if (!world.has(entity, SpriteSlot)) return
    const store = world.tryResource(Sprites)
    const value = world.get(entity, SpriteSlot)
    if (store && value && value.slot > 0) store.release(value.slot - 1)
    world.entityTable(entity).column(SpriteSlot, 'slot')[world.entityRow(entity)] = 0
  })
}

// --- tilemaps ----------------------------------------------------------------------------------

interface LayerGpu {
  buffer: DataStore
  chunksX: number
  chunksY: number
  cursor: number
  base: number
  params: GpuBuffer
}

interface TilemapGpu {
  entity: Entity
  data: unknown
  version: number
  chunkSize: number
  layers: LayerGpu[]
  regions: DataStore
  regionKey: string
  remap: DataStore
  remapData: Uint32Array
  /** Tile id → atlas region + 1, before animation. */
  baseRemap: Uint32Array
  layer: number
  tileSize: [number, number]
  affine: Float32Array
  /** World bounds per chunk per layer (minX, minY, minZ, maxX, maxY, maxZ). */
  bounds: Float32Array[]
  atlas: AssetRef<'TextureAtlas'> | null
  texture: Texture | undefined
  /** The atlas's normal map (2D lighting), or null. */
  normal: Texture | null
  lit: boolean
}

/** Tilemaps on the GPU, and chunk uploads in the last frame (for describe and tests). */
export class TilemapStore {
  readonly maps = new Map<Entity, TilemapGpu>()
  chunkUploads = 0
  /** Per view: chunks drawn, chunks in total. */
  readonly drawn = new Map<string, { visible: number; total: number; draws: number }>()
}

export const Tilemaps = defineResource<TilemapStore>('sprite/Tilemaps', {
  description: 'Tilemaps on the GPU: chunked tile buffers, and what was drawn per view.',
  init: () => new TilemapStore(),
})

const paramScratch = new Float32Array(20)
const paramU32 = new Uint32Array(paramScratch.buffer)

function uploadChunk(
  layer: LayerGpu,
  src: { tiles: Uint16Array; flags: Uint8Array; width: number; height: number },
  cs: number,
  chunk: number,
  scratch: Uint32Array,
): void {
  const cx = chunk % layer.chunksX
  const cy = Math.floor(chunk / layer.chunksX)
  for (let ly = 0; ly < cs; ly++) {
    const y = cy * cs + ly
    for (let lx = 0; lx < cs; lx++) {
      const x = cx * cs + lx
      const inside = x < src.width && y < src.height
      const i = y * src.width + x
      scratch[ly * cs + lx] = inside ? (src.tiles[i]! | (src.flags[i]! << 16)) >>> 0 : 0
    }
  }
  layer.buffer.write(scratch, chunk * cs * cs * 4, 0, cs * cs)
}

let chunkScratch = new Uint32Array(1024)

/** Uploads tilemap chunks that changed (whole layers on first sight or reload), and region UVs. */
function syncTilemaps(world: World): void {
  const gpu = world.resource(Gpu)
  const tilemaps = world.resource(Tilemaps)
  const datas = world.resource(TilemapDatas)
  const atlases = world.resource(TextureAtlases)
  const textures = world.resource(Textures)
  const time = world.resource(Time).elapsed
  tilemaps.chunkUploads = 0
  const seen = new Set<Entity>()
  for (const [entity, value, g] of queryTilemaps(world)) {
    seen.add(entity)
    const data = datas.get(value.data as AssetRef<'TilemapData'>)
    const atlas = atlases.get(value.atlas as AssetRef<'TextureAtlas'>)
    const texture = atlas ? textures.get(atlas.texture) : undefined
    if (!data || !atlas || !texture) continue
    const normal = atlas.normals ? (textures.get(atlas.normals) ?? null) : null
    if (atlas.normals && !normal) continue
    const cs = value.chunkSize
    let map = tilemaps.maps.get(entity)
    if (!map || map.data !== data || map.version !== data.version || map.chunkSize !== cs) {
      map = {
        entity,
        data,
        version: data.version,
        chunkSize: cs,
        layers: data.layers.map((l, i) => {
          const chunksX = Math.ceil(l.width / cs)
          const chunksY = Math.ceil(l.height / cs)
          return {
            buffer: new DataStore(gpu, {
              label: `tilemap/${entity}/${i}`,
              size: Math.max(16, chunksX * chunksY * cs * cs * 4),
            }),
            chunksX,
            chunksY,
            cursor: 0,
            base: -1,
            params: new GpuBuffer(gpu, {
              label: `tilemap/${entity}/${i}/params`,
              usage: GPUBufferUsage.UNIFORM,
              size: 80,
            }),
          }
        }),
        regions:
          map?.regions ?? new DataStore(gpu, { label: `tilemap/${entity}/regions`, size: 256 }),
        regionKey: '',
        remap: map?.remap ?? new DataStore(gpu, { label: `tilemap/${entity}/remap`, size: 256 }),
        remapData: new Uint32Array(0),
        baseRemap: new Uint32Array(0),
        layer: 0,
        tileSize: [1, 1],
        affine: new Float32Array(12),
        bounds: [],
        atlas: null,
        texture: undefined,
        normal: null,
        lit: true,
      }
      tilemaps.maps.set(entity, map)
    }
    map.layer = value.layer
    map.tileSize = [value.tileSize[0]!, value.tileSize[1]!]
    map.affine.set(g)
    map.atlas = value.atlas as AssetRef<'TextureAtlas'>
    map.texture = texture
    map.normal = normal
    map.lit = value.lit
    if (chunkScratch.length < cs * cs) chunkScratch = new Uint32Array(cs * cs)
    // Tiles: whole layers when new (or the edit log overflowed), else the chunks edits touched.
    data.layers.forEach((l, li) => {
      const layer = map!.layers[li]!
      if (layer.base !== l.editBase) {
        for (let chunk = 0; chunk < layer.chunksX * layer.chunksY; chunk++) {
          uploadChunk(layer, l, cs, chunk, chunkScratch)
        }
        tilemaps.chunkUploads += layer.chunksX * layer.chunksY
        layer.base = l.editBase
        layer.cursor = l.edits.length
      } else if (layer.cursor < l.edits.length) {
        const chunks = new Set<number>()
        for (let k = layer.cursor; k < l.edits.length; k++) {
          const t = l.edits[k]!
          const x = t % l.width
          const y = Math.floor(t / l.width)
          chunks.add(Math.floor(y / cs) * layer.chunksX + Math.floor(x / cs))
        }
        for (const chunk of chunks) uploadChunk(layer, l, cs, chunk, chunkScratch)
        tilemaps.chunkUploads += chunks.size
        layer.cursor = l.edits.length
      }
      paramScratch.set(g, 0)
      paramScratch[12] = map!.tileSize[0]
      paramScratch[13] = map!.tileSize[1]
      paramScratch[14] = l.width
      paramScratch[15] = l.height
      paramU32[16] = cs
      paramU32[17] = layer.chunksX
      paramU32[18] = lightFlags(map!.lit, normal !== null, value.layer)
      paramU32[19] = 0
      layer.params.write(paramScratch)
      // World bounds of each chunk, for culling (the map is planar: four corners suffice).
      const n = layer.chunksX * layer.chunksY
      let b = map!.bounds[li]
      if (!b || b.length !== n * 6) {
        b = new Float32Array(n * 6)
        map!.bounds[li] = b
      }
      for (let chunk = 0; chunk < n; chunk++) {
        const cx = chunk % layer.chunksX
        const cy = Math.floor(chunk / layer.chunksX)
        const x0 = cx * cs * map!.tileSize[0]
        const x1 = Math.min((cx + 1) * cs, l.width) * map!.tileSize[0]
        const y0 = -Math.min((cy + 1) * cs, l.height) * map!.tileSize[1]
        const y1 = -cy * cs * map!.tileSize[1]
        chunkBounds(g, x0, y0, x1, y1, b, chunk * 6)
      }
    })
    // Region UVs, for this atlas and texture size; tile ids resolved against the atlas (0059).
    const key = `${atlas.version}/${texture.width}x${texture.height}/${atlas.count}/${data.version}/${data.palette?.length ?? -1}`
    if (map.regionKey !== key) {
      const uv = new Float32Array(Math.max(4, atlas.count * 4))
      for (let r = 0; r < atlas.count; r++) {
        uv[r * 4] = atlas.rects[r * 4]! / texture.width
        uv[r * 4 + 1] = atlas.rects[r * 4 + 1]! / texture.height
        uv[r * 4 + 2] = (atlas.rects[r * 4]! + atlas.rects[r * 4 + 2]!) / texture.width
        uv[r * 4 + 3] = (atlas.rects[r * 4 + 1]! + atlas.rects[r * 4 + 3]!) / texture.height
      }
      map.regions.write(uv)
      map.regionKey = key
      // Tile id → atlas region + 1 (0: draws nothing): through the palette's names, or the id
      // itself for version 1 maps. Animated tiles are pointed at their current frame below.
      map.baseRemap = resolveTiles(world, data, atlas)
      map.remapData = map.baseRemap.slice()
      map.remap.write(map.remapData)
    }
    // Animated tiles: point each at its current frame.
    if (data.animations.length > 0) {
      let changed = false
      for (const a of data.animations) {
        if (a.frames.length === 0 || a.tile >= map.remapData.length) continue
        const id = a.frames[Math.floor(time / a.frameTime) % a.frames.length]!
        const frame = map.baseRemap[Math.min(id, map.baseRemap.length - 1)]!
        if (map.remapData[a.tile] !== frame) {
          map.remapData[a.tile] = frame
          changed = true
        }
      }
      if (changed) map.remap.write(map.remapData)
    }
  }
  for (const entity of tilemaps.maps.keys()) if (!seen.has(entity)) tilemaps.maps.delete(entity)
}

/** Palette sizes already checked for unknown names, per tilemap data. */
const unknownChecked = new WeakMap<TilemapData, number>()

/**
 * Tile id → atlas region + 1 for a map (0059): each palette name looked up in the atlas once, so a
 * re-packed atlas draws the same map. Version 1 ids are regions + 1 already (clamped to the atlas).
 * A name the atlas lacks draws nothing and is reported once (`sprite/unknown-tile`, see unknownTiles).
 */
export function resolveTiles(
  world: World,
  data: TilemapData,
  atlas: { count: number; region(name: string): number },
): Uint32Array {
  if (!data.palette) {
    const out = new Uint32Array(atlas.count + 1)
    for (let t = 0; t < out.length; t++) out[t] = t
    return out
  }
  const out = new Uint32Array(data.palette.length + 1)
  let unknown = false
  for (let i = 0; i < data.palette.length; i++) {
    const region = atlas.region(data.palette[i]!)
    out[i + 1] = region + 1
    if (region === -1) unknown = true
  }
  if (unknown && unknownChecked.get(data) !== data.palette.length) {
    unknownChecked.set(data, data.palette.length)
    const log = world.tryResource(LogResource)
    for (const error of unknownTiles(data, atlas)) log?.error(error)
  }
  return out
}

function chunkBounds(
  g: ArrayLike<number>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: Float32Array,
  o: number,
): void {
  out[o] = out[o + 1] = out[o + 2] = Number.POSITIVE_INFINITY
  out[o + 3] = out[o + 4] = out[o + 5] = Number.NEGATIVE_INFINITY
  for (let k = 0; k < 4; k++) {
    const x = k & 1 ? x1 : x0
    const y = k & 2 ? y1 : y0
    for (let a = 0; a < 3; a++) {
      const v = g[a * 4]! * x + g[a * 4 + 1]! * y + g[a * 4 + 3]!
      if (v < out[o + a]!) out[o + a] = v
      if (v > out[o + 3 + a]!) out[o + 3 + a] = v
    }
  }
}

/** Whether a box is at least partly inside a frustum (six inward planes). */
function boxInFrustum(planes: Float32Array, b: Float32Array, o: number): boolean {
  for (let p = 0; p < 6; p++) {
    const nx = planes[p * 4]!
    const ny = planes[p * 4 + 1]!
    const nz = planes[p * 4 + 2]!
    const x = nx >= 0 ? b[o + 3]! : b[o]!
    const y = ny >= 0 ? b[o + 4]! : b[o + 1]!
    const z = nz >= 0 ? b[o + 5]! : b[o + 2]!
    if (nx * x + ny * y + nz * z + planes[p * 4 + 3]! < 0) return false
  }
  return true
}

function* queryTilemaps(world: World): Generator<
  [
    Entity,
    {
      atlas: unknown
      data: unknown
      tileSize: number[]
      chunkSize: number
      layer: number
      lit: boolean
    },
    Float32Array,
  ]
> {
  // Tilemaps with a GroundLayer draw in the ground phase instead (0059, ground.ts).
  for (const table of world.query({
    with: [Tilemap, GlobalTransform, ComputedVisibility],
    without: [GroundLayer],
  }).tables) {
    const g = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
    const vis = table.column(ComputedVisibility, 'visible')
    const atlas = table.column(Tilemap, 'atlas')
    const data = table.column(Tilemap, 'data')
    const tileSize = table.column(Tilemap, 'tileSize') as unknown as Float32Array
    const chunkSize = table.column(Tilemap, 'chunkSize')
    const layer = table.column(Tilemap, 'layer')
    const lit = table.column(Tilemap, 'lit')
    for (let i = 0; i < table.count; i++) {
      if (!vis[i]) continue
      yield [
        table.entities[i]!,
        {
          atlas: atlas[i],
          data: data[i],
          tileSize: [tileSize[i * 2]!, tileSize[i * 2 + 1]!],
          chunkSize: chunkSize[i]!,
          layer: layer[i]!,
          // Enum index: 0 is '2d', the only mode the sprite pass lights.
          lit: lit[i] === 0,
        },
        g.subarray(i * 12, i * 12 + 12),
      ]
    }
  }
}

// --- drawing -----------------------------------------------------------------------------------

interface DrawCaches {
  generation: number
  layouts?: {
    view: GPUBindGroupLayout
    sprites: GPUBindGroupLayout
    tilemap: GPUBindGroupLayout
    texture: GPUBindGroupLayout
    /** Lit views: the texture group plus a normal map. */
    litTexture: GPUBindGroupLayout
  }
  /** A 1×1 flat normal for lit batches without a normal map. */
  flatNormal?: GPUTextureView
  pipelines: Map<string, GPURenderPipeline>
  groups: Map<string, { key: string; group: GPUBindGroup }>
  views: Map<string, { uniform: GpuBuffer; chunks: DataStore }>
  batchParams: Map<SpriteBatch, GpuBuffer>
  samplers?: { linear: GPUSampler; nearest: GPUSampler }
}

/** Pipelines, bind groups, and buffers of the sprite passes, per world. */
export const SpriteDrawCaches = defineResource<DrawCaches>('sprite/DrawCaches', {
  description: 'GPU objects of the sprite and tilemap passes.',
  init: () => ({
    generation: -1,
    pipelines: new Map(),
    groups: new Map(),
    views: new Map(),
    batchParams: new Map(),
  }),
})

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(o: object): number {
  let id = ids.get(o)
  if (id === undefined) {
    id = nextId++
    ids.set(o, id)
  }
  return id
}

/** A DataStore's bind group key: which store, and which GPU object it has now. */
function dataKey(d: DataStore): string {
  return `${idOf(d)}:${d.version}`
}

function check(ctx: NodeContext): DrawCaches {
  const gpu = ctx.gpu
  const caches = ctx.world.initResource(SpriteDrawCaches)
  if (caches.generation !== gpu.generation) {
    caches.generation = gpu.generation
    caches.layouts = undefined
    caches.pipelines.clear()
    caches.groups.clear()
    caches.views.clear()
    caches.batchParams.clear()
    caches.samplers = undefined
    caches.flatNormal = undefined
  }
  if (!caches.layouts) {
    const V = GPUShaderStage.VERTEX
    const F = GPUShaderStage.FRAGMENT
    // Storage on the full tier, a data texture on baseline (0064).
    const storage = (binding: number) => dataEntry(gpu, binding, V)
    caches.layouts = {
      view: gpu.layouts.bindGroupLayout({
        label: 'sprites/view',
        entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform' } }],
      }),
      sprites: gpu.layouts.bindGroupLayout({
        label: 'sprites/records',
        entries: [storage(0), storage(1)],
      }),
      tilemap: gpu.layouts.bindGroupLayout({
        label: 'tilemap',
        entries: [
          storage(0),
          storage(1),
          storage(2),
          storage(3),
          { binding: 4, visibility: V, buffer: { type: 'uniform' } },
        ],
      }),
      texture: gpu.layouts.bindGroupLayout({
        label: 'sprites/texture',
        entries: [
          { binding: 0, visibility: F, texture: { sampleType: 'float' } },
          { binding: 1, visibility: F, sampler: { type: 'filtering' } },
          { binding: 2, visibility: F, buffer: { type: 'uniform' } },
        ],
      }),
      litTexture: gpu.layouts.bindGroupLayout({
        label: 'sprites/texture-lit',
        entries: [
          { binding: 0, visibility: F, texture: { sampleType: 'float' } },
          { binding: 1, visibility: F, sampler: { type: 'filtering' } },
          { binding: 2, visibility: F, buffer: { type: 'uniform' } },
          { binding: 3, visibility: F, texture: { sampleType: 'float' } },
        ],
      }),
    }
  }
  if (!caches.flatNormal) {
    const t = gpu.device.createTexture({
      label: 'sprites/flat-normal',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    gpu.device.queue.writeTexture({ texture: t }, new Uint8Array([128, 128, 255, 255]), {}, [1, 1])
    caches.flatNormal = t.createView()
  }
  caches.samplers ??= {
    linear: gpu.device.createSampler({
      label: 'sprites/linear',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    }),
    nearest: gpu.device.createSampler({
      label: 'sprites/nearest',
      magFilter: 'nearest',
      minFilter: 'nearest',
    }),
  }
  return caches
}

const PREMULTIPLIED_ALPHA: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}
const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
}

function pipeline(
  ctx: NodeContext,
  kind: 'sprite' | 'tilemap',
  blend: number,
  screen: boolean,
  format: GPUTextureFormat,
  msaa: number,
  pick = false,
  lit = false,
): GPURenderPipeline | undefined {
  const gpu = ctx.gpu
  const c = check(ctx)
  const key = `${kind}/${blend}/${screen ? 's' : 'w'}/${format}/${msaa}${pick ? '/pick' : ''}${lit ? '/lit' : ''}`
  const cached = c.pipelines.get(key)
  if (cached) return cached
  const module = ctx.world.resource(Shaders).module(gpu, {
    root: kind === 'sprite' ? 'shard::sprite' : 'shard::tilemap',
    defines: lit
      ? { SCREEN: screen, SRGB_TARGET: format.endsWith('-srgb'), LIT: true }
      : { SCREEN: screen, SRGB_TARGET: format.endsWith('-srgb') },
  })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const l = c.layouts!
  const p = gpu.pipelines.render({
    label: key,
    layout: gpu.layouts.pipelineLayout({
      label: lit ? `${kind}/lit` : kind,
      bindGroupLayouts: lit
        ? [l.view, kind === 'sprite' ? l.sprites : l.tilemap, l.litTexture, lights2dLayout(gpu)]
        : [l.view, kind === 'sprite' ? l.sprites : l.tilemap, l.texture],
    }),
    vertex: { module, entryPoint: 'vs' },
    fragment: pick
      ? { module, entryPoint: 'fs_pick', targets: PICK_TARGETS }
      : {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format,
              blend:
                blend === BLEND_OPAQUE
                  ? undefined
                  : blend === BLEND_ADDITIVE
                    ? ADDITIVE
                    : PREMULTIPLIED_ALPHA,
            },
          ],
        },
    primitive: { topology: 'triangle-list' },
    depthStencil: screen
      ? undefined
      : {
          format: 'depth32float',
          depthWriteEnabled: pick || blend === BLEND_OPAQUE,
          depthCompare: 'greater-equal',
        },
    multisample: { count: msaa },
  })
  if (p) c.pipelines.set(key, p)
  return p
}

const viewScratch = new Float32Array(24)
/** Visible tilemap chunks of the view being drawn. */
let chunkList = new Uint32Array(256)

/** Per-view uniform: view-projection, viewport, pixel snap. */
function viewGroup(ctx: NodeContext, cam: CameraData): GPUBindGroup {
  const gpu = ctx.gpu
  const c = check(ctx)
  let v = c.views.get(ctx.view.name)
  if (!v) {
    v = {
      uniform: new GpuBuffer(gpu, {
        label: `${ctx.view.name}/sprites`,
        usage: GPUBufferUsage.UNIFORM,
        size: 96,
      }),
      chunks: new DataStore(gpu, { label: `${ctx.view.name}/tilemap-chunks`, size: 1024 }),
    }
    c.views.set(ctx.view.name, v)
  }
  viewScratch.set(cam.viewProj, 0)
  // Only screen space reads the viewport, and it draws after the upscale: display size (0051).
  viewScratch[16] = cam.displayWidth
  viewScratch[17] = cam.displayHeight
  viewScratch[18] = 1 / cam.displayWidth
  viewScratch[19] = 1 / cam.displayHeight
  viewScratch[20] = cam.pixelPerfect?.snap ? cam.pixelPerfect.pixelsPerUnit : 0
  viewScratch[21] = viewScratch[22] = viewScratch[23] = 0
  v.uniform.write(viewScratch)
  const uniform = v.uniform
  return group(ctx, `${ctx.view.name}/view`, `${idOf(uniform.buffer)}`, c.layouts!.view, () => [
    { binding: 0, resource: { buffer: uniform.buffer } },
  ])
}

function group(
  ctx: NodeContext,
  slot: string,
  key: string,
  layout: GPUBindGroupLayout,
  entries: () => GPUBindGroupEntry[],
): GPUBindGroup {
  const gpu = ctx.gpu
  const c = check(ctx)
  let g = c.groups.get(slot)
  if (!g || g.key !== key) {
    g = { key, group: gpu.device.createBindGroup({ label: slot, layout, entries: entries() }) }
    c.groups.set(slot, g)
  }
  return g.group
}

const batchScratch = new Uint32Array(4)

function textureGroup(
  ctx: NodeContext,
  texture: Texture,
  blend: number,
  nearest: boolean,
  owner: object,
  normal?: Texture | null,
): GPUBindGroup | undefined {
  const gpu = ctx.gpu
  const c = check(ctx)
  const gt = ctx.world.resource(GpuAssetsResource).texture(texture)
  if (!gt) return undefined
  let params = c.batchParams.get(owner as SpriteBatch)
  if (!params) {
    params = new GpuBuffer(gpu, { label: 'sprites/batch', usage: GPUBufferUsage.UNIFORM, size: 16 })
    c.batchParams.set(owner as SpriteBatch, params)
  }
  batchScratch[0] = texture.premultiplied ? 1 : 0
  batchScratch[1] = blend
  params.write(batchScratch)
  const view = texture.usage === 'color' ? gt.srgb : gt.linear
  const sampler = nearest ? c.samplers!.nearest : c.samplers!.linear
  const buffer = params
  if (normal !== undefined) {
    // Lit: the texture group plus the normal map (flat when the batch has none).
    const gn = normal ? ctx.world.resource(GpuAssetsResource).texture(normal) : undefined
    if (normal && !gn) return undefined
    const nview = gn ? gn.linear : c.flatNormal!
    return group(
      ctx,
      `tex-lit/${idOf(owner)}/${nearest ? 'n' : 'l'}`,
      `${idOf(gt.texture)}/${idOf(buffer.buffer)}/${idOf(nview)}`,
      c.layouts!.litTexture,
      () => [
        { binding: 0, resource: view },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: buffer.buffer } },
        { binding: 3, resource: nview },
      ],
    )
  }
  return group(
    ctx,
    `tex/${idOf(owner)}/${nearest ? 'n' : 'l'}`,
    `${idOf(gt.texture)}/${idOf(buffer.buffer)}`,
    c.layouts!.texture,
    () => [
      { binding: 0, resource: view },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: buffer.buffer } },
    ],
  )
}

/** Sprite runs and tilemap layers of a space, in layer order (tilemaps first within a layer). */
function drawSpace(ctx: NodeContext, space: number): void {
  const cam = cameraOf(ctx.view)
  if (!cam) return
  const store = ctx.world.tryResource(Sprites)
  const tilemaps = ctx.world.resource(Tilemaps)
  const pass = ctx.renderPass!
  const c = check(ctx)
  const format = space === SPACE_SCREEN ? ctx.texture('view-target').format : 'rgba16float'
  const msaa = space === SPACE_SCREEN ? 1 : cam.msaa
  const nearest = cam.pixelPerfect !== undefined
  // Views of a Lighting2d camera draw world sprites and tiles through the lit variants.
  const lights: LightView2d | undefined =
    space === SPACE_WORLD ? litView(ctx.world, ctx.view.name) : undefined
  const lit = lights !== undefined
  pass.setBindGroup(0, viewGroup(ctx, cam))
  if (lights) pass.setBindGroup(3, lights2dGroup(ctx.gpu, lights))
  // Tilemaps (world space only): visible chunks into this view's list.
  const drawn = { visible: 0, total: 0, draws: 0 }
  const maps: TilemapGpu[] = []
  if (space === SPACE_WORLD) for (const m of tilemaps.maps.values()) maps.push(m)
  maps.sort((a, b) => a.layer - b.layer)
  const v = c.views.get(ctx.view.name)!
  let chunkCount = 0
  const tileDraws: { map: TilemapGpu; layer: number; first: number; count: number }[] = []
  for (const m of maps) {
    m.layers.forEach((layer, li) => {
      const bounds = m.bounds[li]
      if (!bounds) return
      const first = chunkCount
      const n = layer.chunksX * layer.chunksY
      drawn.total += n
      for (let chunk = 0; chunk < n; chunk++) {
        if (!boxInFrustum(cam.frustum, bounds, chunk * 6)) continue
        if (chunkCount >= chunkList.length) {
          const grown = new Uint32Array(chunkList.length * 2)
          grown.set(chunkList)
          chunkList = grown
        }
        chunkList[chunkCount++] = chunk
      }
      if (chunkCount > first)
        tileDraws.push({ map: m, layer: li, first, count: chunkCount - first })
    })
  }
  drawn.visible = chunkCount
  if (chunkCount > 0) v.chunks.write(chunkList, 0, 0, chunkCount)
  let t = 0
  let r = 0
  const runs = store ? store.runs : []
  const runCount = store ? store.runCount : 0
  // Merge by layer band: tilemaps of a band, then the sprites of that band.
  while (t < tileDraws.length || r < runCount) {
    const tl = t < tileDraws.length ? tileDraws[t]!.map.layer : Number.POSITIVE_INFINITY
    const rl = r < runCount ? runs[r]!.layer : Number.POSITIVE_INFINITY
    if (tl <= rl) {
      const d = tileDraws[t++]!
      const p = pipeline(ctx, 'tilemap', BLEND_ALPHA, false, format, msaa, false, lit)
      const tex =
        d.map.texture &&
        textureGroup(
          ctx,
          d.map.texture,
          BLEND_ALPHA,
          nearest,
          d.map.layers[d.layer]!,
          lit ? d.map.normal : undefined,
        )
      if (!p || !tex) continue
      const layer = d.map.layers[d.layer]!
      const cs = d.map.chunkSize
      pass.setPipeline(p)
      pass.setBindGroup(
        1,
        group(
          ctx,
          `${ctx.view.name}/tilemap/${d.map.entity}/${d.layer}`,
          `${dataKey(layer.buffer)}/${dataKey(v.chunks)}/${dataKey(d.map.regions)}/${dataKey(d.map.remap)}/${idOf(layer.params.buffer)}`,
          c.layouts!.tilemap,
          () => [
            { binding: 0, resource: layer.buffer.resource() },
            { binding: 1, resource: v.chunks.resource() },
            { binding: 2, resource: d.map.regions.resource() },
            { binding: 3, resource: d.map.remap.resource() },
            { binding: 4, resource: { buffer: layer.params.buffer } },
          ],
        ),
      )
      pass.setBindGroup(2, tex)
      pass.draw(6, d.count * cs * cs, 0, d.first * cs * cs)
      drawn.draws++
    } else {
      const run = runs[r++]!
      if (run.batch.space !== space) continue
      // Unlit views ignore normal maps: runs that differ only by one draw as one.
      let count = run.count
      while (r < runCount) {
        const next = runs[r]!
        const b = next.batch
        if (
          next.layer !== run.layer ||
          next.first !== run.first + count ||
          b.texture !== run.batch.texture ||
          b.blend !== run.batch.blend ||
          b.space !== space ||
          (lit && b.normal !== run.batch.normal)
        )
          break
        count += next.count
        r++
      }
      const p = pipeline(
        ctx,
        'sprite',
        run.batch.blend,
        space === SPACE_SCREEN,
        format,
        msaa,
        false,
        lit,
      )
      const tex = textureGroup(
        ctx,
        run.batch.texture,
        run.batch.blend,
        nearest,
        run.batch,
        lit ? run.batch.normal : undefined,
      )
      if (!p || !tex || !store) continue
      pass.setPipeline(p)
      pass.setBindGroup(
        1,
        group(
          ctx,
          'sprites/records',
          `${dataKey(store.records)}/${dataKey(store.orderBuffer)}`,
          c.layouts!.sprites,
          () => [
            { binding: 0, resource: store.records.resource() },
            { binding: 1, resource: store.orderBuffer.resource() },
          ],
        ),
      )
      pass.setBindGroup(2, tex)
      pass.draw(6, count, 0, run.first)
      drawn.draws++
    }
  }
  const key = space === SPACE_SCREEN ? `${ctx.view.name}/screen` : ctx.view.name
  tilemaps.drawn.set(key, drawn)
}

/** World sprites into the picking pass (a PickDrawer): texels under half opacity don't pick. */
export function drawSpritePicks(ctx: NodeContext, cam: CameraData): void {
  const store = ctx.world.tryResource(Sprites)
  if (!store || store.runCount === 0) return
  const pass = ctx.renderPass!
  const c = check(ctx)
  pass.setBindGroup(0, viewGroup(ctx, cam))
  for (let r = 0; r < store.runCount; r++) {
    const run = store.runs[r]!
    if (run.batch.space !== SPACE_WORLD) continue
    const p = pipeline(ctx, 'sprite', run.batch.blend, false, 'rgba16float', 1, true)
    const tex = textureGroup(
      ctx,
      run.batch.texture,
      run.batch.blend,
      cam.pixelPerfect !== undefined,
      run.batch,
    )
    if (!p || !tex) continue
    pass.setPipeline(p)
    pass.setBindGroup(
      1,
      group(
        ctx,
        'sprites/records',
        `${dataKey(store.records)}/${dataKey(store.orderBuffer)}`,
        c.layouts!.sprites,
        () => [
          { binding: 0, resource: store.records.resource() },
          { binding: 1, resource: store.orderBuffer.resource() },
        ],
      ),
    )
    pass.setBindGroup(2, tex)
    pass.draw(6, run.count, 0, run.first)
  }
}

function hasSpace(world: World, space: number): boolean {
  const store = world.tryResource(Sprites)
  if (store) for (const b of store.batches) if (b.space === space && b.count > 0) return true
  return space === SPACE_WORLD && world.resource(Tilemaps).maps.size > 0
}

/** World sprites and tilemaps: after opaque 3D and the sky, before transparent 3D. */
export function spriteNode(world: World): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Sprites,
    enabled: (view: RenderView) => cameraOf(view) !== undefined && hasSpace(world, SPACE_WORLD),
    reads: ['culled', 'lights2d'],
    writes: ['scene-color', 'scene-depth', 'hdr'],
    color: (view: RenderView) => sceneColor(view),
    depth: { resource: 'scene-depth' },
    run: (ctx) => drawSpace(ctx, SPACE_WORLD),
  }
}

/** Screen sprites: over the finished image, after tonemapping and anti-aliasing. */
export function overlayNode(world: World): NodeDescriptor {
  return {
    kind: 'render',
    phase: RenderPhase.Overlay,
    enabled: (view: RenderView) => cameraOf(view) !== undefined && hasSpace(world, SPACE_SCREEN),
    writes: ['view-target'],
    color: [{ resource: 'view-target' }],
    run: (ctx) => drawSpace(ctx, SPACE_SCREEN),
  }
}

/** The sprites section of `render.describe`. */
export function describeSprites(world: World) {
  const store = world.tryResource(Sprites)
  const tilemaps = world.tryResource(Tilemaps)
  if (!store) return undefined
  return {
    sprites: store.live,
    drawn: store.orderCount,
    pending: store.pending.size,
    batches: store.batches.filter((b) => b.count > 0).length,
    drawCalls: store.runCount,
    perLayer: Object.fromEntries([...store.perLayer].sort((a, b) => a[0] - b[0])),
    uploadedBytes: store.uploadedBytes,
    sorts: store.sorts,
    lighting: describeLights2d(world),
    tilemaps: tilemaps
      ? {
          maps: tilemaps.maps.size,
          chunkUploads: tilemaps.chunkUploads,
          views: Object.fromEntries(tilemaps.drawn),
        }
      : undefined,
  }
}
