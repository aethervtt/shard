import type { Workers } from '@aethervtt/shard-platform'
import {
  bakeLeaf,
  type DecodedPage,
  LEAF_SIDE,
  leafNormals,
  type NoiseAccess,
  pageTexels,
  readPage,
  SIDE,
  type Stack,
} from './kernel'
import {
  PACK_INDEX_BYTES,
  type PackEntry,
  type PackIndex,
  type PackStore,
  packOf,
  readIndex,
} from './pack'
import type { TerrainLayout } from './source'

const WORKER = new URL('./worker.js', import.meta.url).href

/** A node's number: depth, then z, then x (exact in an f64 up to 2^20 nodes a side). */
export function nodeKey(depth: number, x: number, z: number): number {
  return depth * 2 ** 40 + z * 2 ** 20 + x
}

export function keyDepth(key: number): number {
  return Math.floor(key / 2 ** 40)
}

export function keyX(key: number): number {
  return key % 2 ** 20
}

export function keyZ(key: number): number {
  return Math.floor(key / 2 ** 20) % 2 ** 20
}

/** A page as streaming and queries use it. */
export interface LoadedPage {
  key: number
  depth: number
  x: number
  z: number
  leaf: boolean
  /** u16 heights: LEAF_SIDE² with a border for leaves, SIDE² for parents. */
  heights: Uint16Array
  /** Normals, x then z planes (SIDE² each). */
  normals: Uint8Array
  control: Uint8Array
  /** RGBA8 texels for the GPU pool (LEAF_SIDE²), until uploaded. */
  texels: Uint8Array | undefined
  /** Quantized height range of the node's subtree, and its geometric error. */
  min: number
  max: number
  error: number
}

/**
 * A terrain's pages at runtime (spec 0071): pack indexes, reads through the store's ranged reads,
 * inflate on the worker pool, and a CPU cache of decoded pages (least recently used out, coarse
 * levels pinned). Colliders, height queries and the GPU pool all read through it.
 */
export class PageStore {
  store: PackStore
  readonly layout: TerrainLayout
  readonly lo: number
  readonly hi: number
  workers: Workers | undefined
  /** Extra milliseconds before every read resolves (tests: a slow disk). */
  delayMs = 0
  /** Pages kept decoded on the CPU, besides pinned ones. */
  capacity = 512
  private readonly indexes = new Map<string, PackIndex | null>()
  private readonly pendingIndexes = new Map<string, Promise<PackIndex | null>>()
  private readonly inflight = new Map<number, Promise<LoadedPage | undefined>>()
  /** Decoded pages by key, in use order (Map insertion order: oldest first). */
  private readonly cache = new Map<number, LoadedPage>()
  private readonly pinned = new Set<number>()
  stats = { reads: 0, bytesRead: 0, inflated: 0, bakedInline: 0 }

  constructor(store: PackStore, layout: TerrainLayout, lo: number, hi: number, workers?: Workers) {
    this.store = store
    this.layout = layout
    this.lo = lo
    this.hi = hi
    this.workers = workers
  }

  /** Nodes per side at a depth. */
  nodesAt(depth: number): [number, number] {
    const level = this.layout.depth - depth
    return [this.layout.leavesX >> level, this.layout.leavesZ >> level]
  }

  /** A node's index entry, if its pack's index is loaded. */
  entry(depth: number, x: number, z: number): PackEntry | undefined {
    const { path, slot } = packOf(depth, x, z)
    const index = this.indexes.get(path)
    const e = index?.entries[slot]
    return e && e.length > 0 ? e : undefined
  }

  /** Loads the index of the pack holding a node. */
  index(depth: number, x: number, z: number): Promise<PackIndex | null> {
    const { path } = packOf(depth, x, z)
    const have = this.indexes.get(path)
    if (have !== undefined) return Promise.resolve(have)
    let p = this.pendingIndexes.get(path)
    if (!p) {
      p = this.store.readRange(path, 0, PACK_INDEX_BYTES).then(
        (bytes) => {
          const index = bytes.length >= PACK_INDEX_BYTES ? readIndex(path, bytes) : null
          this.indexes.set(path, index)
          this.pendingIndexes.delete(path)
          return index
        },
        () => {
          this.indexes.set(path, null)
          this.pendingIndexes.delete(path)
          return null
        },
      )
      this.pendingIndexes.set(path, p)
    }
    return p
  }

  /** Whether a node's pack index is loaded (or known missing). */
  hasIndex(depth: number, x: number, z: number): boolean {
    return this.indexes.has(packOf(depth, x, z).path)
  }

  /** A decoded page in the CPU cache (marked used), or undefined. */
  get(key: number): LoadedPage | undefined {
    const p = this.cache.get(key)
    if (p && !this.pinned.has(key)) {
      this.cache.delete(key)
      this.cache.set(key, p)
    }
    return p
  }

  /** Whether a read for this page is under way. */
  loading(key: number): boolean {
    return this.inflight.has(key)
  }

  /** Keeps a page decoded for the store's life (coarse levels). */
  pin(key: number): void {
    this.pinned.add(key)
  }

  /**
   * Reads, inflates and decodes a page (once, however many ask), into the CPU cache. Undefined
   * past the terrain's edge or when the pack doesn't have it.
   */
  load(depth: number, x: number, z: number): Promise<LoadedPage | undefined> {
    const key = nodeKey(depth, x, z)
    const cached = this.cache.get(key)
    if (cached) return Promise.resolve(cached)
    let p = this.inflight.get(key)
    if (p) return p
    p = this.read(depth, x, z, key).finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async read(depth: number, x: number, z: number, key: number) {
    const [nx, nz] = this.nodesAt(depth)
    if (x < 0 || z < 0 || x >= nx || z >= nz) return undefined
    await this.index(depth, x, z)
    const e = this.entry(depth, x, z)
    if (!e) return undefined
    const { path } = packOf(depth, x, z)
    const packed = await this.store.readRange(path, e.offset, e.length)
    this.stats.reads++
    this.stats.bytesRead += packed.length
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    const leaf = depth === this.layout.depth
    const decoded =
      this.workers && this.workers.size > 0
        ? await this.workers.run<{
            heights: Uint16Array
            normals: Uint8Array
            control: Uint8Array
            texels: Uint8Array
          }>(
            WORKER,
            'loadPage',
            [packed, leaf, this.layout.cells, this.lo, this.hi, this.layout.spacing],
            {
              kind: 'terrain/inflate',
            },
          )
        : decodeInline(packed, leaf, this.layout.cells, this.lo, this.hi, this.layout.spacing)
    this.stats.inflated++
    const page: LoadedPage = {
      key,
      depth,
      x,
      z,
      leaf,
      heights: decoded.heights,
      normals: decoded.normals,
      control: decoded.control,
      texels: decoded.texels,
      min: e.min,
      max: e.max,
      error: e.error,
    }
    this.put(page)
    return page
  }

  /** Adds a page to the CPU cache, dropping the least recently used unpinned ones over capacity. */
  put(page: LoadedPage): void {
    this.cache.delete(page.key)
    this.cache.set(page.key, page)
    let over = this.cache.size - this.pinned.size - this.capacity
    if (over <= 0) return
    for (const key of this.cache.keys()) {
      if (over <= 0) break
      if (this.pinned.has(key)) continue
      this.cache.delete(key)
      over--
    }
  }

  /**
   * A leaf page now: from the cache, else baked on this thread from the stack (exactly the pack's
   * bytes, spec 0071). Colliders use it on the frame a tile is due, so when a read lands never
   * changes the world.
   */
  leafNow(noise: NoiseAccess, stack: Stack, x: number, z: number): LoadedPage {
    const depth = this.layout.depth
    const key = nodeKey(depth, x, z)
    const cached = this.get(key)
    if (cached) return cached
    const baked = bakeLeaf(noise, stack, this.layout, x, z)
    this.stats.bakedInline++
    const page: LoadedPage = {
      key,
      depth,
      x,
      z,
      leaf: true,
      heights: baked.page.heights,
      normals: leafNormals(
        baked.page.heights,
        this.lo,
        this.hi,
        this.layout.spacing,
        new Uint8Array(SIDE * SIDE * 2),
      ),
      control: baked.page.control,
      texels: undefined,
      min: baked.min,
      max: baked.max,
      error: 0,
    }
    this.put(page)
    return page
  }

  /** Every decoded page (pinned and cached). */
  pages(): IterableIterator<LoadedPage> {
    return this.cache.values()
  }

  get cached(): number {
    return this.cache.size
  }

  get pendingReads(): number {
    return this.inflight.size
  }

  /** Forgets every index and page (after a rebake). Reads under way finish into the new cache. */
  clear(): void {
    this.indexes.clear()
    this.cache.clear()
    this.pinned.clear()
  }
}

function decodeInline(
  packed: Uint8Array,
  leaf: boolean,
  cells: number,
  lo: number,
  hi: number,
  spacing: number,
) {
  const page: DecodedPage = readPage(packed, leaf, cells)
  const normals =
    page.normals ?? leafNormals(page.heights, lo, hi, spacing, new Uint8Array(SIDE * SIDE * 2))
  const texels = pageTexels(
    { heights: page.heights, normals, control: page.control },
    leaf,
    lo,
    hi,
    spacing,
    new Uint8Array(LEAF_SIDE * LEAF_SIDE * 4),
  )
  return { heights: page.heights, normals, control: page.control, texels }
}
