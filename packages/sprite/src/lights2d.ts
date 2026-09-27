import {
  type AssetRef,
  type ComponentDef,
  defineResource,
  defineSystem,
  type Entity,
  findComponent,
  ProfilerResource,
  type Query,
  ShardError,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import {
  type CameraData,
  Cameras,
  ComputedVisibility,
  defineOverlay,
  Gpu,
  type NodeContext,
  type NodeDescriptor,
  RenderPhase,
  type RenderView,
  Shaders,
} from '@aethervtt/shard-render'
import { LogResource } from '@aethervtt/shard-runtime'
import { Textures } from '@aethervtt/shard-texture'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { TextureAtlases } from './atlas'
import { Lighting2d, LightOccluder2d, PointLight2d, SpotLight2d } from './lighting'
import {
  type ColliderValue,
  type OccluderShapeValue,
  occluderSegments,
  spriteOutline,
  tileChunkEdges,
  transformSegments,
} from './occluders'
import { Sprite, Sprite2dSettings } from './sprite'
import { type TileLayer, Tilemap, TilemapDatas } from './tilemap'

/** Floats per light record (see `Light2d` in lighting-shaders.ts). */
export const LIGHT2D_FLOATS = 16
/** Floats per occluder segment record (`Segment2d`). */
export const SEGMENT_FLOATS = 8
export const TILE_PIXELS = 16
export const TILE_MAX = 64
/** u32s per tile in the tile buffer: a count, then TILE_MAX light indices. */
export const TILE_STRIDE = TILE_MAX + 1
/** Angles per shadow row. */
export const SHADOW_RES = 1024
/** Coarse bins per shadow row (min and max of 32 angles each). */
export const COARSE_RES = 32
export const MAX_SHADOWED = 64
/** "Nothing in the way" in a shadow row (the largest f32). */
const FAR = 3.4028234663852886e38

// --- CPU references: the same math as the GPU, for tests, describe, and the overlay ------------

/**
 * A light's circle in pixels (y down), written to `out` at `o` (x, y, radius, 0). Returns whether it
 * reaches the view. Works for any camera: the radius is the larger of the projected x and y offsets.
 */
export function lightCircle(
  viewProj: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  z: number,
  r: number,
  out: Float32Array,
  o: number,
): boolean {
  const m = viewProj
  const w0 = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  if (w0 <= 1e-6) return false
  const cx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w0
  const cy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w0
  // Offsets by r along world x and y (orthographic: w stays put; perspective: close enough).
  const ax = (m[0]! * r) / w0
  const ay = (m[1]! * r) / w0
  const bx = (m[4]! * r) / w0
  const by = (m[5]! * r) / w0
  const hw = width / 2
  const hh = height / 2
  const rx = Math.sqrt(ax * ax * hw * hw + ay * ay * hh * hh)
  const ry = Math.sqrt(bx * bx * hw * hw + by * by * hh * hh)
  const px = (cx + 1) * hw
  const py = (1 - cy) * hh
  const rp = rx > ry ? rx : ry
  out[o] = px
  out[o + 1] = py
  out[o + 2] = rp
  out[o + 3] = 0
  return px + rp > 0 && px - rp < width && py + rp > 0 && py - rp < height
}

/** Bins light circles into 16×16-pixel tiles, like the GPU: a full count and up to 64 indices. */
export function binLightsCpu(
  circles: Float32Array,
  count: number,
  tilesX: number,
  tilesY: number,
): { counts: Uint32Array; indices: Uint32Array } {
  const counts = new Uint32Array(tilesX * tilesY)
  const indices = new Uint32Array(tilesX * tilesY * TILE_MAX)
  for (let t = 0; t < tilesX * tilesY; t++) {
    const lx = (t % tilesX) * TILE_PIXELS
    const ly = Math.floor(t / tilesX) * TILE_PIXELS
    let n = 0
    for (let i = 0; i < count; i++) {
      const cx = circles[i * 4]!
      const cy = circles[i * 4 + 1]!
      const r = circles[i * 4 + 2]!
      const qx = Math.min(Math.max(cx, lx), lx + TILE_PIXELS) - cx
      const qy = Math.min(Math.max(cy, ly), ly + TILE_PIXELS) - cy
      if (qx * qx + qy * qy > r * r) continue
      if (n < TILE_MAX) indices[t * TILE_MAX + n] = i
      n++
    }
    counts[t] = n
  }
  return { counts, indices }
}

/**
 * One light's shadow row on the CPU, like the GPU kernel: per angle bin, the nearest segment
 * distance plus its penetration. `segments` holds SEGMENT_FLOATS per segment.
 */
export function shadowRowCpu(
  lx: number,
  ly: number,
  radius: number,
  layers: number,
  segments: Float32Array,
  count: number,
  out: Float32Array,
): Float32Array {
  out.fill(FAR, 0, SHADOW_RES)
  const bits = new Uint32Array(segments.buffer, segments.byteOffset, segments.length)
  const step = (Math.PI * 2) / SHADOW_RES
  for (let s = 0; s < count; s++) {
    const o = s * SEGMENT_FLOATS
    if ((bits[o + 5]! & layers) >>> 0 === 0) continue
    const ax = segments[o]! - lx
    const ay = segments[o + 1]! - ly
    const ex = segments[o + 2]! - lx - ax
    const ey = segments[o + 3]! - ly - ay
    const len2 = ex * ex + ey * ey
    const t0 = len2 > 0 ? Math.min(1, Math.max(0, -(ax * ex + ay * ey) / len2)) : 0
    const nx = ax + ex * t0
    const ny = ay + ey * t0
    if (nx * nx + ny * ny >= radius * radius) continue
    const bx = ax + ex
    const by = ay + ey
    if (Math.abs(ax * by - ay * bx) < 1e-9) continue
    let start = Math.atan2(ay, ax)
    let span = Math.atan2(by, bx) - start
    if (span > Math.PI) span -= Math.PI * 2
    if (span < -Math.PI) span += Math.PI * 2
    if (span < 0) {
      start += span
      span = -span
    }
    const first = Math.floor((start + Math.PI) / step)
    const last = Math.min(Math.floor((start + span + Math.PI) / step), first + SHADOW_RES - 1)
    const pen = segments[o + 4]!
    for (let k = first; k <= last; k++) {
      const theta = Math.min(Math.max(-Math.PI + (k + 0.5) * step, start), start + span)
      const dx = Math.cos(theta)
      const dy = Math.sin(theta)
      const den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-12) continue
      const t = (ax * ey - ay * ex) / den
      if (t <= 0) continue
      const w = ((k % SHADOW_RES) + SHADOW_RES) % SHADOW_RES
      const v = Math.fround(t + pen)
      if (v < out[w]!) out[w] = v
    }
  }
  return out
}

/** How lit a point is by a shadow row: the fragment shader's `shadow2d`, on the CPU. */
export function shadowFactorCpu(
  row: Float32Array,
  softness: number,
  d: number,
  toX: number,
  toY: number,
): number {
  const step = (Math.PI * 2) / SHADOW_RES
  const at = (k: number) => row[((k % SHADOW_RES) + SHADOW_RES) % SHADOW_RES]!
  const fb = (Math.atan2(toY, toX) + Math.PI) / step
  if (softness <= 0) return d <= at(Math.floor(fb)) ? 1 : 0
  const search = Math.min(softness / Math.max(d, 1e-3) / step, 32)
  let blockers = 0
  let sum = 0
  for (let i = 0; i < 8; i++) {
    const o = at(Math.floor(fb + ((i / 7) * 2 - 1) * search))
    if (o < d) {
      sum += o
      blockers++
    }
  }
  if (blockers === 0) return 1
  if (blockers === 8) return 0
  const blocker = sum / blockers
  const width = Math.min((softness * (d - blocker)) / Math.max(blocker, 1e-3) / d / step, 32)
  let lit = 0
  for (let i = 0; i < 24; i++) {
    const x = fb + ((i / 23) * 2 - 1) * width
    const k = Math.floor(x - 0.5)
    const a = d <= at(k) ? 1 : 0
    const b = d <= at(k + 1) ? 1 : 0
    lit += a + (b - a) * (x - 0.5 - k)
  }
  return lit / 24
}

// --- occluders ---------------------------------------------------------------------------------

/** One occluder entity's segments, cached in world space until it changes. */
interface OccluderRecord {
  entity: Entity
  local: number[]
  world: Float32Array
  /** minX, minY, maxX, maxY. */
  bounds: Float32Array
  penetration: number
  layers: number
  seen: number
}

/** One occluding tile layer: boundary edges per chunk, rebuilt only for edited chunks. */
interface TileOccluder {
  entity: Entity
  layerIndex: number
  layer: TileLayer
  chunkSize: number
  chunksX: number
  chunksY: number
  editBase: number
  cursor: number
  local: number[][]
  world: Float32Array[]
  bounds: Float32Array
  affine: Float32Array
  tileSize: [number, number]
  /** Light reaches three quarters of a tile into walls, so their faces toward it stay lit. */
  penetration: number
  seen: number
}

/** Occluders in world space, shared by every lit view. */
export class OccluderStore {
  readonly records: OccluderRecord[] = []
  readonly index = new Map<Entity, number>()
  readonly tiles = new Map<string, TileOccluder>()
  /** Bumps whenever any occluder's world segments change. */
  version = 0
  /** Tile chunks whose edges were rebuilt in the last update. */
  chunkRebuilds = 0
  frame = 0
  /** Errors already logged, per entity and code. */
  readonly logged = new Set<string>()

  /** Segments across all occluders (entities and tile chunks). */
  get segmentCount(): number {
    let n = 0
    for (const r of this.records) n += r.world.length / 4
    for (const t of this.tiles.values()) for (const w of t.world) n += w.length / 4
    return n
  }
}

let colliderDef: ComponentDef | null | undefined
function colliderOf(world: World, entity: Entity): ColliderValue | undefined {
  if (colliderDef === undefined) colliderDef = findComponent('physics/Collider') ?? null
  if (!colliderDef) return undefined
  return world.tryGet(entity, colliderDef) as ColliderValue | undefined
}

/** A sprite's outline in its local space, for `shape: 'sprite'` (undefined while assets load). */
function spriteShape(world: World, entity: Entity): number[] | undefined {
  const s = world.tryGet(entity, Sprite)
  if (!s) return undefined
  const textures = world.resource(Textures)
  const ppu = world.resource(Sprite2dSettings).pixelsPerUnit
  let outline: Float32Array | undefined
  let rw = 0
  let rh = 0
  let ax = s.anchor[0]!
  let ay = s.anchor[1]!
  const atlasRef = s.atlas as AssetRef<'TextureAtlas'> | null
  if (atlasRef && (atlasRef.guid || atlasRef.path) && s.region) {
    const atlas = world.resource(TextureAtlases).get(atlasRef)
    if (!atlas) return undefined
    const r = atlas.region(s.region)
    if (r < 0) return undefined
    rw = atlas.rects[r * 4 + 2]!
    rh = atlas.rects[r * 4 + 3]!
    outline = atlas.outlines[r]
    const px = atlas.pivots[r * 2]!
    const py = atlas.pivots[r * 2 + 1]!
    if (px !== 0.5 || py !== 0.5) {
      ax = px
      ay = py
    }
  } else {
    const ref = s.texture as AssetRef<'Texture'> | null
    const texture = ref ? textures.get(ref) : undefined
    if (!texture) return undefined
    rw = texture.width
    rh = texture.height
  }
  let w = s.size[0]!
  let h = s.size[1]!
  if (w === 0 && h === 0) {
    w = rw / ppu
    h = rh / ppu
  }
  return spriteOutline(outline, w, h, ax, ay, s.flipX, s.flipY)
}

function reportOnce(world: World, store: OccluderStore, entity: Entity, err: ShardError): void {
  const key = `${entity}|${err.code}`
  if (store.logged.has(key)) return
  store.logged.add(key)
  world.tryResource(LogResource)?.error(err)
}

/** Brings occluder entities and occluding tile layers up to date. */
/** The queries the lighting system reads, built once in its setup. */
interface LightQueries {
  cameras: Query
  points: Query
  spots: Query
  occluders: Query
  tilemaps: Query
}

function updateOccluders(world: World, store: OccluderStore, since: number, q: LightQueries): void {
  const frame = ++store.frame
  store.chunkRebuilds = 0
  if (colliderDef === undefined) colliderDef = findComponent('physics/Collider') ?? null
  for (const table of q.occluders.tables) {
    const n = table.count
    if (n === 0) continue
    const g = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
    const oChanged = table.changedTicks(LightOccluder2d)
    const gChanged = table.changedTicks(GlobalTransform)
    const sChanged = table.has(Sprite) ? table.changedTicks(Sprite) : undefined
    const colliderChanged =
      colliderDef && table.has(colliderDef) ? table.changedTicks(colliderDef) : undefined
    for (let i = 0; i < n; i++) {
      const entity = table.entities[i]!
      let at = store.index.get(entity)
      let rec = at === undefined ? undefined : store.records[at]
      const shapeChanged =
        !rec ||
        oChanged[i]! > since ||
        (sChanged !== undefined && sChanged[i]! > since) ||
        (colliderChanged !== undefined && colliderChanged[i]! > since) ||
        rec.local.length === 0
      if (rec) rec.seen = frame
      if (!shapeChanged && gChanged[i]! <= since) continue
      if (shapeChanged) {
        const value = world.get(entity, LightOccluder2d) as unknown as OccluderShapeValue & {
          lightPenetration: number
          layers: number
        }
        let local: number[] = []
        try {
          if (value.shape === 'sprite') {
            const outline = spriteShape(world, entity)
            // Still loading: try again next frame.
            local = outline ? occluderSegments(value, { outline }) : []
          } else {
            local = occluderSegments(value, { collider: colliderOf(world, entity) })
          }
        } catch (err) {
          if (!(err instanceof ShardError)) throw err
          reportOnce(world, store, entity, err)
        }
        if (!rec) {
          rec = {
            entity,
            local,
            world: new Float32Array(local.length),
            bounds: new Float32Array(4),
            penetration: value.lightPenetration,
            layers: value.layers >>> 0,
            seen: frame,
          }
          at = store.records.length
          store.records.push(rec)
          store.index.set(entity, at)
        }
        rec.local = local
        rec.penetration = value.lightPenetration
        rec.layers = value.layers >>> 0
        if (rec.world.length !== local.length) rec.world = new Float32Array(local.length)
      }
      if (!rec) continue
      transformSegments(rec.local, g, i * 12, 1, 1, rec.world, 0, rec.bounds)
      store.version++
    }
  }
  // Removed occluders.
  for (let k = store.records.length - 1; k >= 0; k--) {
    const rec = store.records[k]!
    if (rec.seen === frame) continue
    const last = store.records.pop()!
    store.index.delete(rec.entity)
    if (last !== rec) {
      store.records[k] = last
      store.index.set(last.entity, k)
    }
    store.version++
  }
  updateTileOccluders(world, store, frame, q.tilemaps)
}

function updateTileOccluders(world: World, store: OccluderStore, frame: number, maps: Query): void {
  const datas = world.resource(TilemapDatas)
  for (const table of maps.tables) {
    const g = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
    const dataCol = table.column(Tilemap, 'data')
    const tileSize = table.column(Tilemap, 'tileSize') as unknown as Float32Array
    const chunkSize = table.column(Tilemap, 'chunkSize')
    for (let i = 0; i < table.count; i++) {
      const data = datas.get(dataCol[i] as AssetRef<'TilemapData'>)
      if (!data) continue
      const entity = table.entities[i]!
      const cs = chunkSize[i]!
      for (let li = 0; li < data.layers.length; li++) {
        const layer = data.layers[li]!
        if (!layer.occludes) continue
        const key = `${entity}/${li}`
        let t = store.tiles.get(key)
        if (!t || t.layer !== layer || t.chunkSize !== cs) {
          const chunksX = Math.ceil(layer.width / cs)
          const chunksY = Math.ceil(layer.height / cs)
          t = {
            entity,
            layerIndex: li,
            layer,
            chunkSize: cs,
            chunksX,
            chunksY,
            editBase: layer.editBase - 1,
            cursor: 0,
            local: new Array(chunksX * chunksY),
            world: new Array(chunksX * chunksY),
            bounds: new Float32Array(chunksX * chunksY * 4),
            affine: new Float32Array(12),
            tileSize: [0, 0],
            penetration: 0,
            seen: frame,
          }
          store.tiles.set(key, t)
        }
        t.seen = frame
        const chunks = t.chunksX * t.chunksY
        let moved = t.tileSize[0] !== tileSize[i * 2] || t.tileSize[1] !== tileSize[i * 2 + 1]
        for (let k = 0; k < 12; k++) {
          if (t.affine[k] !== g[i * 12 + k]) moved = true
        }
        const rebuild = new Uint8Array(chunks)
        let any = false
        if (t.editBase !== layer.editBase) {
          rebuild.fill(1)
          any = true
          t.editBase = layer.editBase
          t.cursor = layer.edits.length
        } else if (t.cursor < layer.edits.length) {
          for (let k = t.cursor; k < layer.edits.length; k++) {
            const e = layer.edits[k]!
            const x = e % layer.width
            const y = Math.floor(e / layer.width)
            rebuild[Math.floor(y / cs) * t.chunksX + Math.floor(x / cs)] = 1
            any = true
          }
          t.cursor = layer.edits.length
        }
        if (!any && !moved) continue
        if (moved) {
          t.affine.set(g.subarray(i * 12, i * 12 + 12))
          t.tileSize = [tileSize[i * 2]!, tileSize[i * 2 + 1]!]
          t.penetration = 0.75 * Math.min(Math.abs(t.tileSize[0]), Math.abs(t.tileSize[1]))
        }
        for (let c = 0; c < chunks; c++) {
          if (rebuild[c]) {
            const edges: number[] = []
            tileChunkEdges(layer, cs, c, edges)
            t.local[c] = edges
            store.chunkRebuilds++
          }
          if (!rebuild[c] && !moved) continue
          const local = t.local[c] ?? []
          let w = t.world[c]
          if (!w || w.length !== local.length) w = t.world[c] = new Float32Array(local.length)
          transformSegments(local, t.affine, 0, t.tileSize[0], t.tileSize[1], w, 0, boundsScratch)
          t.bounds.set(boundsScratch, c * 4)
        }
        store.version++
      }
    }
  }
  for (const [key, t] of store.tiles) {
    if (t.seen !== frame) {
      store.tiles.delete(key)
      store.version++
    }
  }
}
const boundsScratch = new Float32Array(4)

// --- per-view lights ---------------------------------------------------------------------------

/** One lit view: its lights, shadow rows, occluder segments, and GPU buffers. */
export class LightView2d {
  readonly name: string
  camera: Entity = 0 as Entity
  lights = new Float32Array(LIGHT2D_FLOATS * 64)
  lightBits = new Uint32Array(this.lights.buffer)
  circles = new Float32Array(4 * 64)
  entities = new Float64Array(64)
  count = 0
  /** Light index per shadow row. */
  readonly shadowed = new Uint32Array(MAX_SHADOWED)
  shadowedCount = 0
  segments = new Float32Array(SEGMENT_FLOATS * 256)
  segmentBits = new Uint32Array(this.segments.buffer)
  segmentCount = 0
  tilesX = 1
  tilesY = 1
  readonly uniformData = new Float32Array(12)
  readonly uniformBits = new Uint32Array(this.uniformData.buffer)
  /** Stats for describe. */
  visible = 0
  culled = 0
  dropped = 0
  demoted = 0
  uploadedBytes = 0
  frame = 0
  private segmentKey = -1
  gpu: ViewGpu | undefined

  constructor(name: string) {
    this.name = name
  }

  ensureLights(n: number): void {
    if (this.entities.length >= n) return
    const lights = new Float32Array(n * LIGHT2D_FLOATS)
    lights.set(this.lights)
    this.lights = lights
    this.lightBits = new Uint32Array(lights.buffer)
    const circles = new Float32Array(n * 4)
    circles.set(this.circles)
    this.circles = circles
    const entities = new Float64Array(n)
    entities.set(this.entities)
    this.entities = entities
  }

  ensureSegments(n: number): void {
    if (this.segments.length >= n * SEGMENT_FLOATS) return
    let size = this.segments.length
    while (size < n * SEGMENT_FLOATS) size *= 2
    const s = new Float32Array(size)
    s.set(this.segments)
    this.segments = s
    this.segmentBits = new Uint32Array(s.buffer)
  }

  /** Uploads what changed. Segments go up only when the selection or an occluder changed. */
  upload(gpu: GpuContext, segmentKey: number): void {
    let g = this.gpu
    if (!g || g.generation !== gpu.generation) g = this.gpu = createViewGpu(gpu, this.name)
    let bytes = 0
    this.uniformBits[4] = this.count
    this.uniformBits[5] = this.tilesX
    this.uniformBits[6] = this.tilesY
    this.uniformBits[7] = this.shadowedCount
    this.uniformBits[8] = this.segmentCount
    g.uniform.write(this.uniformData)
    bytes += 48
    if (this.count > 0) {
      g.lights.write(this.lights, 0, 0, this.count * LIGHT2D_FLOATS)
      g.circles.write(this.circles, 0, 0, this.count * 4)
      bytes += this.count * (LIGHT2D_FLOATS + 4) * 4
    }
    if (this.shadowedCount > 0) {
      g.shadowed.write(this.shadowed, 0, 0, this.shadowedCount)
      bytes += this.shadowedCount * 4
    }
    g.tiles.ensureCapacity(this.tilesX * this.tilesY * TILE_STRIDE * 4)
    g.shadowMap.ensureCapacity(Math.max(1, this.shadowedCount) * SHADOW_RES * 4)
    g.shadowCoarse.ensureCapacity(Math.max(1, this.shadowedCount) * COARSE_RES * 8)
    if (segmentKey !== this.segmentKey && this.segmentCount > 0) {
      g.segments.write(this.segments, 0, 0, this.segmentCount * SEGMENT_FLOATS)
      bytes += this.segmentCount * SEGMENT_FLOATS * 4
    }
    this.segmentKey = segmentKey
    this.uploadedBytes = bytes
  }
}

interface ViewGpu {
  generation: number
  uniform: GpuBuffer
  lights: GpuBuffer
  circles: GpuBuffer
  tiles: GpuBuffer
  shadowMap: GpuBuffer
  shadowCoarse: GpuBuffer
  segments: GpuBuffer
  shadowed: GpuBuffer
  computeGroup?: { key: string; group: GPUBindGroup }
  renderGroup?: { key: string; group: GPUBindGroup }
}

function createViewGpu(gpu: GpuContext, name: string): ViewGpu {
  // COPY_SRC: tests and debug tools read the tiles and shadow rows back.
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  const buffer = (label: string, size: number, usage: number = storage) =>
    new GpuBuffer(gpu, { label: `${name}/lights2d/${label}`, usage, size })
  return {
    generation: gpu.generation,
    uniform: buffer('view', 48, GPUBufferUsage.UNIFORM),
    lights: buffer('lights', LIGHT2D_FLOATS * 4 * 64),
    circles: buffer('circles', 16 * 64),
    tiles: buffer('tiles', TILE_STRIDE * 4 * 1024),
    shadowMap: buffer('shadow-map', SHADOW_RES * 4 * 4),
    shadowCoarse: buffer('shadow-coarse', COARSE_RES * 8 * 4),
    segments: buffer('segments', SEGMENT_FLOATS * 4 * 256),
    shadowed: buffer('shadowed', MAX_SHADOWED * 4),
  }
}

/** 2D lighting state: lit views and the occluders they share. */
export class Lights2dStore {
  readonly views = new Map<string, LightView2d>()
  readonly occluders = new OccluderStore()
  /** Budget warnings already logged, per view and code. */
  readonly warned = new Set<string>()
}

export const Lights2d = defineResource<Lights2dStore>('sprite/Lights2d', {
  description:
    'The 2D lighting state: lights, shadow rows, and occluder segments per lit view, and the occluders in world space.',
  init: () => new Lights2dStore(),
})

// Scratch for sorting lights by distance to the view center (insertion sort, no allocation).
let sortKeys = new Float64Array(256)
let sortIdx = new Uint32Array(256)
let stage = new Float32Array(256 * LIGHT2D_FLOATS)
let stageCircles = new Float32Array(256 * 4)
let stageShadows = new Uint8Array(256)
let stageEntities = new Float64Array(256)

function growStage(n: number): void {
  if (sortKeys.length >= n) return
  const size = Math.max(n, sortKeys.length * 2)
  const grow = <T extends Float32Array | Float64Array | Uint32Array | Uint8Array>(
    a: T,
    make: (k: number) => T,
    per: number,
  ): T => {
    const b = make(size * per)
    b.set(a as never)
    return b
  }
  sortKeys = grow(sortKeys, (k) => new Float64Array(k), 1)
  sortIdx = grow(sortIdx, (k) => new Uint32Array(k), 1)
  stage = grow(stage, (k) => new Float32Array(k), LIGHT2D_FLOATS)
  stageCircles = grow(stageCircles, (k) => new Float32Array(k), 4)
  stageShadows = grow(stageShadows, (k) => new Uint8Array(k), 1)
  stageEntities = grow(stageEntities, (k) => new Float64Array(k), 1)
  stageU32 = new Uint32Array(stage.buffer)
}

function insertionSort(idx: Uint32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const v = idx[i]!
    const key = sortKeys[v]!
    let j = i - 1
    while (j >= 0 && sortKeys[idx[j]!]! > key) {
      idx[j + 1] = idx[j]!
      j--
    }
    idx[j + 1] = v
  }
}

let stageU32 = new Uint32Array(stage.buffer)
const DEG = Math.PI / 180

/** Writes the visible lights of one table into the stage. Returns the new stage count. */
function stageLights(
  table: Table,
  spot: boolean,
  cam: CameraData,
  n: number,
  view: LightView2d,
): number {
  const def = spot ? SpotLight2d : PointLight2d
  const g = table.column(GlobalTransform, 'matrix') as unknown as Float32Array
  const vis = table.column(ComputedVisibility, 'visible')
  const color = table.column(def, 'color') as unknown as Float32Array
  const intensity = table.column(def, 'intensity')
  const radius = table.column(def, 'radius')
  const falloff = table.column(def, 'falloff')
  const height = table.column(def, 'height')
  const shadows = table.column(def, 'shadows')
  const softness = table.column(def, 'softness')
  const layers = table.column(def, 'layers')
  const inner = spot ? table.column(SpotLight2d, 'innerAngle') : undefined
  const outer = spot ? table.column(SpotLight2d, 'outerAngle') : undefined
  const cx = cam.position[0]!
  const cy = cam.position[1]!
  for (let i = 0; i < table.count; i++) {
    if (!vis[i] || layers[i] === 0) continue
    const r = radius[i]!
    const s = intensity[i]!
    if (r <= 0 || s <= 0) continue
    const x = g[i * 12 + 3]!
    const y = g[i * 12 + 7]!
    if (n >= sortKeys.length) growStage(n + 1)
    if (
      !lightCircle(
        cam.viewProj,
        cam.width,
        cam.height,
        x,
        y,
        g[i * 12 + 11]!,
        r,
        stageCircles,
        n * 4,
      )
    ) {
      view.culled++
      continue
    }
    const o = n * LIGHT2D_FLOATS
    stage[o] = x
    stage[o + 1] = y
    stage[o + 2] = height[i]!
    stage[o + 3] = r
    stage[o + 4] = color[i * 4]! * s
    stage[o + 5] = color[i * 4 + 1]! * s
    stage[o + 6] = color[i * 4 + 2]! * s
    stage[o + 7] = falloff[i]!
    if (spot) {
      // The entity's +X in world XY.
      const dx = g[i * 12]!
      const dy = g[i * 12 + 4]!
      const l = Math.sqrt(dx * dx + dy * dy) || 1
      stage[o + 8] = dx / l
      stage[o + 9] = dy / l
      const a0 = Math.min(inner![i]!, outer![i]!)
      stage[o + 10] = Math.cos(a0 * DEG)
      stage[o + 11] = Math.cos(outer![i]! * DEG)
    } else {
      stage[o + 8] = 1
      stage[o + 9] = 0
      stage[o + 10] = -1
      stage[o + 11] = -2
    }
    stageU32[o + 12] = 0xffffffff // row, set below (as i32 -1)
    stage[o + 13] = softness[i]!
    stageU32[o + 14] = layers[i]! >>> 0
    stage[o + 15] = 1 / (r * r)
    stageShadows[n] = shadows[i] ? 1 : 0
    stageEntities[n] = table.entities[i]!
    const ddx = x - cx
    const ddy = y - cy
    sortKeys[n] = ddx * ddx + ddy * ddy
    n++
  }
  return n
}

function warnOnce(
  world: World,
  store: Lights2dStore,
  view: string,
  code: string,
  message: string,
  hint: string,
): void {
  const key = `${view}|${code}`
  if (store.warned.has(key)) return
  store.warned.add(key)
  world.tryResource(LogResource)?.log('warn', message, { code, hint })
}

/** Fills a lit view's lights, shadow rows, and occluder segments. */
function extractView(
  world: World,
  q: LightQueries,
  store: Lights2dStore,
  view: LightView2d,
  cam: CameraData,
  ambient: ArrayLike<number>,
  ambientAt: number,
  ambientIntensity: number,
  maxLights: number,
  maxShadowed: number,
): number {
  view.visible = view.culled = view.dropped = view.demoted = 0
  let n = 0
  for (const table of q.points.tables)
    if (table.count > 0) n = stageLights(table, false, cam, n, view)
  for (const table of q.spots.tables)
    if (table.count > 0) n = stageLights(table, true, cam, n, view)
  view.visible = n
  growStage(n * 2 + 1)
  for (let i = 0; i < n; i++) sortIdx[i] = i
  // Over budget: the lights nearest the view center win.
  if (n > maxLights) {
    insertionSort(sortIdx, n)
    view.dropped = n - maxLights
    warnOnce(
      world,
      store,
      view.name,
      'sprite/too-many-lights',
      `${n} 2D lights reach ${view.name}; only the nearest ${maxLights} (Lighting2d.maxLights) light it`,
      'Raise Lighting2d.maxLights, or shrink or remove distant lights.',
    )
  }
  const count = Math.min(n, maxLights)
  view.ensureLights(count)
  view.count = count
  const lights = view.lights
  const circles = view.circles
  for (let k = 0; k < count; k++) {
    const s = sortIdx[k]!
    for (let f = 0; f < LIGHT2D_FLOATS; f++)
      lights[k * LIGHT2D_FLOATS + f] = stage[s * LIGHT2D_FLOATS + f]!
    for (let f = 0; f < 4; f++) circles[k * 4 + f] = stageCircles[s * 4 + f]!
    view.entities[k] = stageEntities[s]!
  }
  // Shadow rows: the nearest shadowed lights.
  let shadowedN = 0
  for (let k = 0; k < count; k++) if (stageShadows[sortIdx[k]!]) sortIdx[n + shadowedN++] = k
  // Sort them by distance (light k's key is its stage index's), in the scratch past the stage.
  for (let a = 1; a < shadowedN; a++) {
    const v = sortIdx[n + a]!
    const key = sortKeys[sortIdx[v]!]!
    let b = a - 1
    while (b >= 0 && sortKeys[sortIdx[sortIdx[n + b]!]!]! > key) {
      sortIdx[n + b + 1] = sortIdx[n + b]!
      b--
    }
    sortIdx[n + b + 1] = v
  }
  const shadowCount = Math.min(shadowedN, maxShadowed, MAX_SHADOWED)
  view.demoted = shadowedN - shadowCount
  if (view.demoted > 0) {
    warnOnce(
      world,
      store,
      view.name,
      'sprite/too-many-shadowed-lights',
      `${shadowedN} shadowed 2D lights reach ${view.name}; the farthest ${view.demoted} render without shadows (Lighting2d.maxShadowed ${maxShadowed})`,
      'Raise Lighting2d.maxShadowed (at most 64), or turn shadows off on minor lights.',
    )
  }
  const bits = view.lightBits
  for (let k = 0; k < count; k++) bits[k * LIGHT2D_FLOATS + 12] = 0xffffffff
  for (let r = 0; r < shadowCount; r++) {
    const k = sortIdx[n + r]!
    view.shadowed[r] = k
    bits[k * LIGHT2D_FLOATS + 12] = r
  }
  view.shadowedCount = shadowCount
  view.tilesX = Math.max(1, Math.ceil(cam.width / TILE_PIXELS))
  view.tilesY = Math.max(1, Math.ceil(cam.height / TILE_PIXELS))
  view.uniformData[0] = ambient[ambientAt]! * ambientIntensity
  view.uniformData[1] = ambient[ambientAt + 1]! * ambientIntensity
  view.uniformData[2] = ambient[ambientAt + 2]! * ambientIntensity
  view.uniformData[3] = 0
  return selectSegments(store.occluders, view)
}

/** Whether a box (minX, minY, maxX, maxY at `o`) reaches any shadowed light of the view. */
function reachesShadowed(view: LightView2d, b: Float32Array, o: number, layers: number): boolean {
  for (let r = 0; r < view.shadowedCount; r++) {
    const lo = view.shadowed[r]! * LIGHT2D_FLOATS
    if ((view.lightBits[lo + 14]! & layers) >>> 0 === 0) continue
    const x = view.lights[lo]!
    const y = view.lights[lo + 1]!
    const rad = view.lights[lo + 3]!
    const qx = Math.min(Math.max(x, b[o]!), b[o + 2]!) - x
    const qy = Math.min(Math.max(y, b[o + 1]!), b[o + 3]!) - y
    if (qx * qx + qy * qy < rad * rad) return true
  }
  return false
}

function pushSegments(view: LightView2d, src: Float32Array, pen: number, layers: number): void {
  const n = src.length / 4
  view.ensureSegments(view.segmentCount + n)
  const f = view.segments
  const u = view.segmentBits
  for (let s = 0; s < n; s++) {
    const o = (view.segmentCount + s) * SEGMENT_FLOATS
    f[o] = src[s * 4]!
    f[o + 1] = src[s * 4 + 1]!
    f[o + 2] = src[s * 4 + 2]!
    f[o + 3] = src[s * 4 + 3]!
    f[o + 4] = pen
    u[o + 5] = layers
    u[o + 6] = 0
    u[o + 7] = 0
  }
  view.segmentCount += n
}

/**
 * Copies the occluder segments that reach a shadowed light into the view. Returns a key that
 * changes when the selection or any occluder does, so unchanged segments aren't re-uploaded.
 */
function selectSegments(occ: OccluderStore, view: LightView2d): number {
  view.segmentCount = 0
  if (view.shadowedCount === 0) return 0
  let key = occ.version * 31 + 7
  for (let k = 0; k < occ.records.length; k++) {
    const rec = occ.records[k]!
    if (rec.world.length === 0 || !reachesShadowed(view, rec.bounds, 0, rec.layers)) continue
    pushSegments(view, rec.world, rec.penetration, rec.layers)
    key = (key * 33 + k + 1) % 2147483647
  }
  for (const t of occ.tiles.values()) {
    for (let c = 0; c < t.world.length; c++) {
      const w = t.world[c]
      if (!w || w.length === 0 || !reachesShadowed(view, t.bounds, c * 4, 0xffffffff)) continue
      pushSegments(view, w, t.penetration, 0xffffffff)
      key = (key * 33 + c + 1) % 2147483647
    }
  }
  return (key * 33 + view.segmentCount) % 2147483647
}

/**
 * Per lit camera (Lighting2d): extracts visible lights (circle vs view), picks shadow rows,
 * selects the occluder segments that reach them, and uploads. Does nothing without a lit camera.
 */
export const prepareLights2d = defineSystem({
  name: 'sprite/lights2d',
  description: 'Extracts 2D lights and occluders for each Lighting2d camera, and uploads them.',
  setup: (world): LightQueries => ({
    cameras: world.query({ with: [Lighting2d] }),
    points: world.query({ with: [PointLight2d, GlobalTransform, ComputedVisibility] }),
    spots: world.query({ with: [SpotLight2d, GlobalTransform, ComputedVisibility] }),
    occluders: world.query({ with: [LightOccluder2d, GlobalTransform] }),
    tilemaps: world.query({ with: [Tilemap, GlobalTransform] }),
  }),
  run: (q, world, ctx) => {
    let any = false
    for (const table of q.cameras.tables) if (table.count > 0) any = true
    const store = world.tryResource(Lights2d)
    if (!any) {
      if (store && store.views.size > 0) store.views.clear()
      return
    }
    const lights = store ?? world.initResource(Lights2d)
    const gpu = world.tryResource(Gpu)
    updateOccluders(world, lights.occluders, ctx.lastRunTick, q)
    const cameras = world.resource(Cameras)
    const frame = lights.occluders.frame
    for (const table of q.cameras.tables) {
      const ambient = table.column(Lighting2d, 'ambient') as unknown as Float32Array
      const ambientIntensity = table.column(Lighting2d, 'ambientIntensity')
      const maxLights = table.column(Lighting2d, 'maxLights')
      const maxShadowed = table.column(Lighting2d, 'maxShadowed')
      for (let i = 0; i < table.count; i++) {
        const entity = table.entities[i]!
        const cam = cameras.get(entity)
        if (!cam) continue
        const name = `camera:${entity}`
        let view = lights.views.get(name)
        if (!view) {
          view = new LightView2d(name)
          lights.views.set(name, view)
        }
        view.camera = entity
        view.frame = frame
        const key = extractView(
          world,
          q,
          lights,
          view,
          cam,
          ambient,
          i * 4,
          ambientIntensity[i]!,
          maxLights[i]!,
          maxShadowed[i]!,
        )
        if (gpu) view.upload(gpu, key)
      }
    }
    for (const [name, view] of lights.views) if (view.frame !== frame) lights.views.delete(name)
  },
})

// --- GPU ---------------------------------------------------------------------------------------

interface Lights2dGpu {
  generation: number
  compute: GPUBindGroupLayout
  render: GPUBindGroupLayout
  pipelines: Map<string, GPUComputePipeline>
}

const gpuState = new WeakMap<GpuContext, Lights2dGpu>()

function layoutsOf(gpu: GpuContext): Lights2dGpu {
  let s = gpuState.get(gpu)
  if (s && s.generation === gpu.generation) return s
  const C = GPUShaderStage.COMPUTE
  const F = GPUShaderStage.FRAGMENT
  const read = { type: 'read-only-storage' as const }
  const write = { type: 'storage' as const }
  s = {
    generation: gpu.generation,
    compute: gpu.layouts.bindGroupLayout({
      label: 'lights2d/compute',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: read },
        { binding: 2, visibility: C, buffer: read },
        { binding: 3, visibility: C, buffer: write },
        { binding: 4, visibility: C, buffer: write },
        { binding: 5, visibility: C, buffer: read },
        { binding: 6, visibility: C, buffer: read },
        { binding: 7, visibility: C, buffer: write },
      ],
    }),
    render: gpu.layouts.bindGroupLayout({
      label: 'lights2d/shade',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, buffer: read },
        { binding: 2, visibility: F, buffer: read },
        { binding: 3, visibility: F, buffer: read },
        { binding: 4, visibility: F, buffer: read },
      ],
    }),
    pipelines: new Map(),
  }
  gpuState.set(gpu, s)
  return s
}

/** The bind group layout lit sprite and tilemap pipelines take at group 3. */
export function lights2dLayout(gpu: GpuContext): GPUBindGroupLayout {
  return layoutsOf(gpu).render
}

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

/** A lit view's light state, or undefined when the view isn't lit. */
export function litView(world: World, view: string): LightView2d | undefined {
  const v = world.tryResource(Lights2d)?.views.get(view)
  return v?.gpu ? v : undefined
}

/** The group-3 bind group of a lit view's sprite and tilemap draws. */
export function lights2dGroup(gpu: GpuContext, view: LightView2d): GPUBindGroup {
  const g = view.gpu!
  const key = `${idOf(g.uniform.buffer)}/${idOf(g.lights.buffer)}/${idOf(g.tiles.buffer)}/${idOf(g.shadowMap.buffer)}/${idOf(g.shadowCoarse.buffer)}`
  if (!g.renderGroup || g.renderGroup.key !== key) {
    g.renderGroup = {
      key,
      group: gpu.device.createBindGroup({
        label: `${view.name}/lights2d/shade`,
        layout: layoutsOf(gpu).render,
        entries: [
          { binding: 0, resource: { buffer: g.uniform.buffer } },
          { binding: 1, resource: { buffer: g.lights.buffer } },
          { binding: 2, resource: { buffer: g.tiles.buffer } },
          { binding: 3, resource: { buffer: g.shadowMap.buffer } },
          { binding: 4, resource: { buffer: g.shadowCoarse.buffer } },
        ],
      }),
    }
  }
  return g.renderGroup.group
}

function computePipeline(ctx: NodeContext, entry: string): GPUComputePipeline | undefined {
  const gpu = ctx.gpu
  const s = layoutsOf(gpu)
  const cached = s.pipelines.get(entry)
  if (cached) return cached
  const module = ctx.world
    .resource(Shaders)
    .module(gpu, { root: 'shard::sprite::light2d::compute' })
  if (!module) {
    gpu.pipelines.skipped++
    return undefined
  }
  const p = gpu.pipelines.compute({
    label: `lights2d/${entry}`,
    layout: gpu.layouts.pipelineLayout({ label: 'lights2d', bindGroupLayouts: [s.compute] }),
    compute: { module, entryPoint: entry },
  })
  if (p) s.pipelines.set(entry, p)
  return p
}

/**
 * Bins lights into screen tiles, fills the shadow rows, and reduces them to coarse min/max bins,
 * in one compute pass per lit view.
 */
export function lights2dNode(world: World): NodeDescriptor {
  return {
    kind: 'compute',
    phase: RenderPhase.Sprites - 10,
    enabled: (view: RenderView) => litView(world, view.name) !== undefined,
    writes: ['lights2d'],
    run: (ctx) => {
      const view = litView(ctx.world, ctx.view.name)
      if (!view) return
      const bin = computePipeline(ctx, 'bin')
      const clear = computePipeline(ctx, 'clear')
      const shadows = computePipeline(ctx, 'shadows')
      const coarse = computePipeline(ctx, 'coarse')
      if (!bin || !clear || !shadows || !coarse) return
      const g = view.gpu!
      const key = `${idOf(g.uniform.buffer)}/${idOf(g.lights.buffer)}/${idOf(g.circles.buffer)}/${idOf(g.tiles.buffer)}/${idOf(g.shadowMap.buffer)}/${idOf(g.segments.buffer)}/${idOf(g.shadowed.buffer)}/${idOf(g.shadowCoarse.buffer)}`
      if (!g.computeGroup || g.computeGroup.key !== key) {
        g.computeGroup = {
          key,
          group: ctx.gpu.device.createBindGroup({
            label: `${view.name}/lights2d`,
            layout: layoutsOf(ctx.gpu).compute,
            entries: [
              { binding: 0, resource: { buffer: g.uniform.buffer } },
              { binding: 1, resource: { buffer: g.lights.buffer } },
              { binding: 2, resource: { buffer: g.circles.buffer } },
              { binding: 3, resource: { buffer: g.tiles.buffer } },
              { binding: 4, resource: { buffer: g.shadowMap.buffer } },
              { binding: 5, resource: { buffer: g.segments.buffer } },
              { binding: 6, resource: { buffer: g.shadowed.buffer } },
              { binding: 7, resource: { buffer: g.shadowCoarse.buffer } },
            ],
          }),
        }
      }
      const pass = ctx.computePass!
      pass.setBindGroup(0, g.computeGroup.group)
      pass.setPipeline(bin)
      pass.dispatchWorkgroups(Math.ceil((view.tilesX * view.tilesY) / 64))
      if (view.shadowedCount > 0) {
        pass.setPipeline(clear)
        pass.dispatchWorkgroups(Math.ceil((view.shadowedCount * SHADOW_RES) / 64))
        if (view.segmentCount > 0) {
          pass.setPipeline(shadows)
          pass.dispatchWorkgroups(Math.ceil(view.segmentCount / 64), view.shadowedCount)
        }
        pass.setPipeline(coarse)
        pass.dispatchWorkgroups(Math.ceil((view.shadowedCount * COARSE_RES) / 64))
      }
    },
  }
}

// --- describe and overlay ----------------------------------------------------------------------

/** One lit view in `render.describe` → `sprites.lighting.views`. */
export interface LightViewStats {
  /** Lights uploaded (at most maxLights). */
  lights: number
  /** Lights that reached the view, before the maxLights budget. */
  visible: number
  /** Lights outside the view. */
  culled: number
  /** Lights over maxLights. */
  dropped: number
  shadowed: number
  /** Shadowed lights over maxShadowed, drawn without shadows. */
  demoted: number
  /** Occluder segments uploaded for the shadowed lights. */
  segments: number
  tiles: number
  /** Tiles whose lights hit the 64-light cap. */
  tilesAtCap: number
  maxLightsPerTile: number
  uploadedBytes: number
  /** GPU time (timestamp queries), when the device has them. */
  gpuMs: { binAndShadows: number | undefined; sprites: number | undefined }
  /** The lit lights, in upload order. */
  entities: number[]
}

/** `render.describe` → `sprites.lighting`: per lit view, what's lit, culled, and over budget. */
export function describeLights2d(world: World) {
  const store = world.tryResource(Lights2d)
  if (!store || store.views.size === 0) return undefined
  const profiler = world.tryResource(ProfilerResource)
  const views: Record<string, LightViewStats> = {}
  for (const [name, v] of store.views) {
    const bins = binLightsCpu(v.circles, v.count, v.tilesX, v.tilesY)
    let atCap = 0
    let maxPerTile = 0
    for (let t = 0; t < bins.counts.length; t++) {
      if (bins.counts[t]! >= TILE_MAX) atCap++
      if (bins.counts[t]! > maxPerTile) maxPerTile = bins.counts[t]!
    }
    views[name] = {
      lights: v.count,
      visible: v.visible,
      culled: v.culled,
      dropped: v.dropped,
      shadowed: v.shadowedCount,
      demoted: v.demoted,
      segments: v.segmentCount,
      tiles: v.tilesX * v.tilesY,
      tilesAtCap: atCap,
      maxLightsPerTile: maxPerTile,
      uploadedBytes: v.uploadedBytes,
      gpuMs: {
        binAndShadows: profiler?.timing('gpu:sprites/lights2d')?.avg,
        sprites: profiler?.timing('gpu:sprites')?.avg,
      },
      entities: Array.from(v.entities.subarray(0, v.count)),
    }
  }
  return {
    occluders: store.occluders.records.length,
    tileLayers: store.occluders.tiles.size,
    segments: store.occluders.segmentCount,
    chunkRebuilds: store.occluders.chunkRebuilds,
    views,
  }
}

const ringScratch = new Float32Array(SHADOW_RES)
const pa = new Float32Array(3)
const pb = new Float32Array(3)
const lightColor = new Float32Array(4)
const OCCLUDER_COLOR = [1, 0.35, 0.2, 1]
const RING_COLOR = [1, 1, 1, 0.8]

defineOverlay({
  name: 'lights2d',
  description:
    "2D lights: each light's radius (and cone), its shadow row as a ring, and occluder segments, from the first lit view.",
  draw(world, g, passes) {
    const store = world.tryResource(Lights2d)
    if (!store) return
    const opts = { depthTest: false }
    for (const rec of store.occluders.records) {
      if (!passes(rec.entity)) continue
      for (let s = 0; s < rec.world.length; s += 4) {
        pa[0] = rec.world[s]!
        pa[1] = rec.world[s + 1]!
        pb[0] = rec.world[s + 2]!
        pb[1] = rec.world[s + 3]!
        g.line(pa, pb, OCCLUDER_COLOR, opts)
      }
    }
    for (const t of store.occluders.tiles.values()) {
      if (!passes(t.entity)) continue
      for (const w of t.world) {
        if (!w) continue
        for (let s = 0; s < w.length; s += 4) {
          pa[0] = w[s]!
          pa[1] = w[s + 1]!
          pb[0] = w[s + 2]!
          pb[1] = w[s + 3]!
          g.line(pa, pb, OCCLUDER_COLOR, opts)
        }
      }
    }
    const view = store.views.values().next().value
    if (!view) return
    for (let k = 0; k < view.count; k++) {
      const entity = view.entities[k]! as Entity
      if (!passes(entity)) continue
      const o = k * LIGHT2D_FLOATS
      const x = view.lights[o]!
      const y = view.lights[o + 1]!
      const r = view.lights[o + 3]!
      const m = Math.max(view.lights[o + 4]!, view.lights[o + 5]!, view.lights[o + 6]!, 1e-6)
      lightColor[0] = view.lights[o + 4]! / m
      lightColor[1] = view.lights[o + 5]! / m
      lightColor[2] = view.lights[o + 6]! / m
      lightColor[3] = 1
      pa[0] = x
      pa[1] = y
      pa[2] = 0
      g.circle(pa, r, 2, lightColor, opts)
      if (view.lights[o + 11]! > -1.5) {
        // The cone's outer edges.
        const base = Math.atan2(view.lights[o + 9]!, view.lights[o + 8]!)
        const half = Math.acos(view.lights[o + 11]!)
        for (const sgn of [-1, 1]) {
          pb[0] = x + Math.cos(base + sgn * half) * r
          pb[1] = y + Math.sin(base + sgn * half) * r
          g.line(pa, pb, lightColor, opts)
        }
      }
      const row = view.lightBits[o + 12]! | 0
      if (row < 0) continue
      shadowRowCpu(x, y, r, view.lightBits[o + 14]!, view.segments, view.segmentCount, ringScratch)
      // The shadow row as a ring: the lit distance per angle, capped at the radius.
      const steps = 256
      const per = SHADOW_RES / steps
      for (let a = 0; a < steps; a++) {
        const d0 = Math.min(r, ringScratch[a * per]!)
        const d1 = Math.min(r, ringScratch[((a + 1) % steps) * per]!)
        const t0 = -Math.PI + ((a * per + 0.5) / SHADOW_RES) * Math.PI * 2
        const t1 = -Math.PI + ((((a + 1) % steps) * per + 0.5) / SHADOW_RES) * Math.PI * 2
        pa[0] = x + Math.cos(t0) * d0
        pa[1] = y + Math.sin(t0) * d0
        pb[0] = x + Math.cos(t1) * d1
        pb[1] = y + Math.sin(t1) * d1
        g.line(pa, pb, RING_COLOR, opts)
      }
    }
  },
})
