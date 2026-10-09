import { sha256Hex } from '@aethervtt/shard-assets'
import { ShardError } from '@aethervtt/shard-core'
import { loadNoiseKernel, NOISE_KERNEL_MODULE } from '@aethervtt/shard-noise'
import type { Workers } from '@aethervtt/shard-platform'
import {
  BAKE_VERSION,
  type BakedPage,
  type BlockResult,
  bakeBlock,
  type DecodedPage,
  deflate,
  encodePage,
  PAGE,
  pageBytes,
  pageNormal,
  parentPage,
  readPage,
  SIDE,
  type Stack,
} from './kernel'
import { PACK, type PackIndex, type PackStore, packOf, readIndex, writePack } from './pack'
import type { SourceRect, TerrainLayout, TerrainSource } from './source'
import { mainNoise } from './stack'

const WORKER = new URL('./worker.js', import.meta.url).href

/** What a bake remembers per block: its key, errors per level above the leaves, its height range. */
export interface BlockRecord {
  key: string
  /** Index L: the largest error of this block's level-L nodes (its share, above the block). 0 for leaves. */
  errors: number[]
  /** Quantized height range. */
  range: [number, number]
  /** Samples clipped by heightRange, and the unclipped extremes. */
  clipped: number
  lowest: number
  highest: number
  /** Milliseconds its last bake took. */
  ms: number
}

/** `manifest.json` next to the packs: enough to rebake incrementally and to stream. */
export interface BakeManifest {
  format: 1
  bakeVersion: number
  /** The grid and stored range the packs were made for; a change rebakes everything. */
  grid: {
    sizeX: number
    sizeZ: number
    spacing: number
    paintSpacing: number
    depth: number
    block: number
    heightRange: [number, number]
  }
  /** "bx,bz" → record. */
  blocks: Record<string, BlockRecord>
  /** Per depth (0 roots … depth leaves): the largest node error there. */
  depthErrors: number[]
  /** The source hash the packs match. */
  sourceHash: string
}

export interface OutOfRange {
  /** [x0, z0, x1, z1] metres. */
  rect: [number, number, number, number]
  samples: number
  lowest: number
  highest: number
}

export interface BakeReport {
  blocks: number
  rebaked: number
  /** Blocks this bake rebaked, as "bx,bz" (terrain.map's bake mode shades them). */
  dirtied: string[]
  /** Pages written (leaves and every rebuilt ancestor). */
  pages: number
  /** Pages above the blocks rebuilt from their children. */
  ancestors: number
  /** Pack bytes written. */
  bytes: number
  ms: number
  /** Mean milliseconds per rebaked block (pool time, not wall time). */
  msPerBlock: number
  outOfRange: OutOfRange[]
}

export interface BakeOptions {
  /** Blocks bake here; inline (on the calling thread) without one. */
  workers?: Workers
  /** Rebake every block. */
  force?: boolean
  /** Problems worth a warning (terrain/out-of-range, once per block). */
  warn?: (problem: ShardError) => void
  onProgress?: (done: number, total: number) => void
}

/** What a bake reads of a terrain source asset (TerrainSourceAsset). */
export interface BakeInput {
  source: TerrainSource
  layout: TerrainLayout
  deps: Record<string, { hash: string }>
  hash: string
}

const MANIFEST = 'manifest.json'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function readManifest(store: PackStore): Promise<BakeManifest | undefined> {
  const bytes = await store.read(MANIFEST)
  if (!bytes) return undefined
  try {
    const m = JSON.parse(decoder.decode(bytes)) as BakeManifest
    return m.format === 1 ? m : undefined
  } catch {
    return undefined
  }
}

function gridOf(input: BakeInput): BakeManifest['grid'] {
  const l = input.layout
  return {
    sizeX: l.sizeX,
    sizeZ: l.sizeZ,
    spacing: l.spacing,
    paintSpacing: l.paintSpacing,
    depth: l.depth,
    block: l.block,
    heightRange: input.source.heightRange,
  }
}

type Box = [number, number, number, number]

function rectBox(r: SourceRect, grow: number): Box {
  const a = (r.rotation * Math.PI) / 180
  const hw = r.size[0] / 2
  const hd = r.size[1] / 2
  const ex = Math.abs(Math.cos(a)) * hw + Math.abs(Math.sin(a)) * hd + grow
  const ez = Math.abs(Math.sin(a)) * hw + Math.abs(Math.cos(a)) * hd + grow
  return [r.at[0] - ex, r.at[1] - ez, r.at[0] + ex, r.at[1] + ez]
}

const overlaps = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

/**
 * Each block's key (spec 0071): SHA-256 of the bake version, the grid, the seed, and every layer
 * (height and paint) whose region plus falloff touches the block's samples, with its dependency's
 * hash and, for splines, its resolved centerline. Layers elsewhere don't change it.
 */
export async function blockKeys(input: BakeInput, stack: Stack): Promise<string[]> {
  const { source, layout } = input
  const base = JSON.stringify({
    v: BAKE_VERSION,
    grid: gridOf(input),
    seed: source.seed,
    layers: source.layers.map((l) => l.name),
  })
  // Per layer: its bounds (undefined: everywhere) and a digest.
  const parts: { box: Box | undefined; digest: string }[] = []
  const digest = async (value: unknown, extra: ArrayLike<number> | undefined) => {
    const text = JSON.stringify(value)
    const bytes = encoder.encode(text)
    if (!extra) return sha256Hex(bytes)
    const f = Float64Array.from(extra)
    const all = new Uint8Array(bytes.length + f.byteLength)
    all.set(bytes)
    all.set(new Uint8Array(f.buffer), bytes.length)
    return sha256Hex(all)
  }
  for (let i = 0; i < source.height.length; i++) {
    const l = source.height[i]!
    const s = stack.height[i]!
    if (l.kind === 'noise') {
      parts.push({
        box: l.region ? rectBox(l.region, l.falloff) : undefined,
        digest: await digest(['h', i, l, input.deps[l.noise.path]?.hash ?? ''], undefined),
      })
    } else if (l.kind === 'image') {
      parts.push({
        box: rectBox(l, l.falloff),
        digest: await digest(['h', i, l, input.deps[l.image.path]?.hash ?? ''], undefined),
      })
    } else {
      const sp = (
        s as {
          spline: { pts: Float64Array; minX: number; minZ: number; maxX: number; maxZ: number }
        }
      ).spline
      parts.push({
        box: [sp.minX, sp.minZ, sp.maxX, sp.maxZ],
        digest: await digest(['h', i, l, source.splines[l.spline]], sp.pts),
      })
    }
  }
  for (let i = 0; i < source.paint.length; i++) {
    const p = source.paint[i]!
    let box: Box | undefined
    const clip = (b: Box) => {
      box = box
        ? [
            Math.max(box[0], b[0]),
            Math.max(box[1], b[1]),
            Math.min(box[2], b[2]),
            Math.min(box[3], b[3]),
          ]
        : b
    }
    if (p.mask) clip(rectBox(p.mask, p.blend))
    const sp = stack.paint[i]!.spline
    if (sp) clip([sp.minX, sp.minZ, sp.maxX, sp.maxZ])
    parts.push({
      box,
      digest: await digest(
        [
          'p',
          i,
          p,
          p.noise ? (input.deps[p.noise.ref.path]?.hash ?? '') : '',
          p.mask ? (input.deps[p.mask.ref.path]?.hash ?? '') : '',
          p.spline ? source.splines[p.spline] : null,
        ],
        sp?.pts,
      ),
    })
  }
  // A block reads its samples plus the margin its normals reach (bakeBlock).
  const margin = (2 ** Math.min(layout.blockLevels, layout.depth) + 1) * layout.spacing
  const size = layout.block * layout.leafSize
  const keys: string[] = []
  for (let bz = 0; bz < layout.blocksZ; bz++) {
    for (let bx = 0; bx < layout.blocksX; bx++) {
      const box: Box = [
        bx * size - margin,
        bz * size - margin,
        Math.min(layout.sizeX, (bx + 1) * size) + margin,
        Math.min(layout.sizeZ, (bz + 1) * size) + margin,
      ]
      const touching = parts.filter((p) => !p.box || overlaps(p.box, box)).map((p) => p.digest)
      keys.push(await sha256Hex(encoder.encode(`${base}\n${touching.join('\n')}`)))
    }
  }
  return keys
}

/** Reads and decodes pages from a store's packs, caching indexes and pages for one bake. */
class PageReader {
  private indexes = new Map<string, Promise<PackIndex | undefined>>()
  private pages = new Map<string, Promise<DecodedPage | null>>()
  private readonly store: PackStore
  private readonly layout: TerrainLayout
  /** Pages this bake made, by "level/x/z". */
  private readonly fresh: Map<string, BakedPage>
  /** Whether the stored packs match this grid (else they're ignored). */
  private readonly usePacks: boolean

  constructor(
    store: PackStore,
    layout: TerrainLayout,
    fresh: Map<string, BakedPage>,
    usePacks: boolean,
  ) {
    this.store = store
    this.layout = layout
    this.fresh = fresh
    this.usePacks = usePacks
  }

  index(path: string): Promise<PackIndex | undefined> {
    let p = this.indexes.get(path)
    if (!p) {
      p = this.usePacks
        ? this.store.read(path).then((bytes) => (bytes ? readIndex(path, bytes) : undefined))
        : Promise.resolve(undefined)
      this.indexes.set(path, p)
    }
    return p
  }

  /** Index entry and bytes of a stored page, or undefined. */
  async stored(level: number, x: number, z: number) {
    const depth = this.layout.depth - level
    const { path, slot } = packOf(depth, x, z)
    const index = await this.index(path)
    const e = index?.entries[slot]
    if (!e || e.length === 0) return undefined
    const bytes = await this.store.read(path)
    return { entry: e, data: bytes!.subarray(e.offset, e.offset + e.length) }
  }

  /** A node's decoded page (fresh first), or null past the terrain's edge or where none is stored. */
  page(level: number, x: number, z: number): Promise<DecodedPage | null> {
    const key = `${level}/${x}/${z}`
    let p = this.pages.get(key)
    if (!p) {
      p = (async () => {
        const n = this.nodes(level)
        if (x < 0 || z < 0 || x >= n[0] || z >= n[1]) return null
        const f = this.fresh.get(key)
        const data = f ? f.data : (await this.stored(level, x, z))?.data
        return data ? readPage(data, level === 0, this.layout.cells) : null
      })()
      this.pages.set(key, p)
    }
    return p
  }

  /** Height range of a node (fresh first). */
  async range(level: number, x: number, z: number): Promise<[number, number] | undefined> {
    const f = this.fresh.get(`${level}/${x}/${z}`)
    if (f) return [f.min, f.max]
    const s = await this.stored(level, x, z)
    return s ? [s.entry.min, s.entry.max] : undefined
  }

  nodes(level: number): [number, number] {
    return [this.layout.leavesX >> level, this.layout.leavesZ >> level]
  }
}

/**
 * Bakes a terrain source into page packs (spec 0071), incrementally: blocks whose key changed are
 * rebaked (on the pool when there is one), every ancestor of a rebaked block is rebuilt from its
 * children, and only the packs holding changed pages are rewritten. A changed grid rebakes it all.
 */
export async function bakeTerrain(
  input: BakeInput,
  stack: Stack,
  store: PackStore,
  options: BakeOptions = {},
): Promise<BakeReport> {
  const t0 = performance.now()
  const { layout } = input
  const D = layout.depth
  const lmax = Math.min(layout.blockLevels, D)
  const previous = await readManifest(store)
  const grid = gridOf(input)
  const compatible =
    !options.force &&
    previous !== undefined &&
    previous.bakeVersion === BAKE_VERSION &&
    JSON.stringify(previous.grid) === JSON.stringify(grid)
  const keys = await blockKeys(input, stack)
  const blocks: Record<string, BlockRecord> = {}
  const stale: [number, number][] = []
  for (let bz = 0; bz < layout.blocksZ; bz++) {
    for (let bx = 0; bx < layout.blocksX; bx++) {
      const id = `${bx},${bz}`
      const key = keys[bz * layout.blocksX + bx]!
      const old = compatible ? previous!.blocks[id] : undefined
      if (old && old.key === key) blocks[id] = old
      else stale.push([bx, bz])
    }
  }
  // Packs written by an earlier bake must still be there for the blocks it says are current.
  const fresh = new Map<string, BakedPage>()
  const reader = new PageReader(store, layout, fresh, compatible)
  if (compatible) {
    for (let bz = 0; bz < layout.blocksZ; bz++) {
      for (let bx = 0; bx < layout.blocksX; bx++) {
        const id = `${bx},${bz}`
        if (!blocks[id]) continue
        const { path } = packOf(D, bx * layout.block, bz * layout.block)
        if (!(await reader.index(path))) {
          delete blocks[id]
          stale.push([bx, bz])
        }
      }
    }
  }
  // Rebake stale blocks.
  const kernel = await loadNoiseKernel()
  const workers = options.workers && options.workers.size > 0 ? options.workers : undefined
  let done = 0
  let poolMs = 0
  const outOfRange: OutOfRange[] = []
  const blockSize = layout.block * layout.leafSize
  await Promise.all(
    stale.map(async ([bx, bz]) => {
      const result: BlockResult = workers
        ? await workers.run<BlockResult>(
            WORKER,
            'bakeBlock',
            [NOISE_KERNEL_MODULE, kernel.module, stack, layout, bx, bz],
            { kind: 'terrain/bake-block' },
          )
        : bakeBlock(mainNoise(), stack, layout, bx, bz)
      poolMs += result.ms
      const errors = new Array<number>(D + 1).fill(0)
      for (const p of result.pages) {
        fresh.set(`${p.level}/${p.x}/${p.z}`, p)
        if (p.level > 0) errors[p.level] = Math.max(errors[p.level]!, p.error)
      }
      result.above.forEach((e, i) => {
        errors[lmax + 1 + i] = e
      })
      blocks[`${bx},${bz}`] = {
        key: keys[bz * layout.blocksX + bx]!,
        errors,
        range: result.range,
        clipped: result.clipped,
        lowest: result.lowest,
        highest: result.highest,
        ms: result.ms,
      }
      if (result.clipped > 0) {
        const rect: OutOfRange['rect'] = [
          bx * blockSize,
          bz * blockSize,
          Math.min(layout.sizeX, (bx + 1) * blockSize),
          Math.min(layout.sizeZ, (bz + 1) * blockSize),
        ]
        outOfRange.push({
          rect,
          samples: result.clipped,
          lowest: result.lowest,
          highest: result.highest,
        })
        options.warn?.(
          new ShardError(
            'terrain/out-of-range',
            `${result.clipped} heights in [${rect.join(', ')}] fall outside heightRange [${input.source.heightRange.join(', ')}] (from ${result.lowest.toFixed(1)} to ${result.highest.toFixed(1)} m) and were clipped`,
            {
              path: '/heightRange',
              hint: 'Widen heightRange to cover them (heights are 16-bit over it), or lower the layers that push past it.',
            },
          ),
        )
      }
      options.onProgress?.(++done, stale.length)
    }),
  )
  // Levels above the blocks: every ancestor of a rebaked block, from its children.
  let ancestors = 0
  const normals = new WeakMap<DecodedPage, Float32Array>()
  const v = new Float64Array(3)
  /** A page's normals as unit vectors, unpacked once. */
  const unpacked = (page: DecodedPage) => {
    let n = normals.get(page)
    if (!n) {
      n = new Float32Array(SIDE * SIDE * 3)
      for (let k = 0; k < SIDE * SIDE; k++) {
        pageNormal(page, k % SIDE, Math.floor(k / SIDE), v)
        n[k * 3] = v[0]!
        n[k * 3 + 1] = v[1]!
        n[k * 3 + 2] = v[2]!
      }
      normals.set(page, n)
    }
    return n
  }
  for (let L = lmax + 1; L <= D; L++) {
    const dirty = new Set<string>()
    for (const [bx, bz] of stale)
      dirty.add(`${(bx * layout.block) >> L},${(bz * layout.block) >> L}`)
    for (const id of [...dirty].sort()) {
      const [X, Z] = id.split(',').map(Number) as [number, number]
      // Children and the ring of their neighbors (for normals at the page's edges): ring[(r + 1)
      // × 4 + c + 1] is the child-level page at (2X + c, 2Z + r), c and r from −1 to 2.
      const ring: (DecodedPage | null)[] = new Array(16).fill(null)
      await Promise.all(
        ring.map(async (_, k) => {
          ring[k] = await reader.page(L - 1, 2 * X + (k % 4) - 1, 2 * Z + Math.floor(k / 4) - 1)
        }),
      )
      const children = [ring[5]!, ring[6]!, ring[9]!, ring[10]!]
      const normalAt = (gi: number, gj: number, out: Float64Array) => {
        let c = gi < 0 ? -1 : gi > 2 * PAGE ? 2 : gi === 2 * PAGE ? 1 : Math.floor(gi / PAGE)
        let r = gj < 0 ? -1 : gj > 2 * PAGE ? 2 : gj === 2 * PAGE ? 1 : Math.floor(gj / PAGE)
        let page = ring[(r + 1) * 4 + c + 1]
        if (!page) {
          // Past the terrain's edge: the nearest texel inside.
          gi = Math.min(2 * PAGE, Math.max(0, gi))
          gj = Math.min(2 * PAGE, Math.max(0, gj))
          c = gi === 2 * PAGE ? 1 : Math.floor(gi / PAGE)
          r = gj === 2 * PAGE ? 1 : Math.floor(gj / PAGE)
          page = ring[(r + 1) * 4 + c + 1]
        }
        if (!page) {
          out[0] = 0
          out[1] = 1
          out[2] = 0
          return
        }
        const n = unpacked(page)
        const o = ((gj - r * PAGE) * SIDE + gi - c * PAGE) * 3
        out[0] = n[o]!
        out[1] = n[o + 1]!
        out[2] = n[o + 2]!
      }
      const parent = parentPage(children, layout.cells, normalAt)
      let min = 65535
      let max = 0
      for (let c = 0; c < 4; c++) {
        const range = await reader.range(L - 1, 2 * X + (c & 1), 2 * Z + (c >> 1))
        if (!range) continue
        min = Math.min(min, range[0])
        max = Math.max(max, range[1])
      }
      // Exact error: the worst of every block under it.
      let error = 0
      const span = 2 ** L / layout.block
      for (let bz = Z * span; bz < Math.min(layout.blocksZ, (Z + 1) * span); bz++)
        for (let bx = X * span; bx < Math.min(layout.blocksX, (X + 1) * span); bx++)
          error = Math.max(error, blocks[`${bx},${bz}`]?.errors[L] ?? 0)
      fresh.set(`${L}/${X}/${Z}`, {
        level: L,
        x: X,
        z: Z,
        data: deflate(encodePage(parent, false, layout.cells)),
        min,
        max,
        error,
      })
      ancestors++
    }
  }
  // Rewrite the packs holding fresh pages.
  const packs = new Map<string, { depth: number; gx: number; gz: number }>()
  for (const p of fresh.values()) {
    const depth = D - p.level
    const { path } = packOf(depth, p.x, p.z)
    packs.set(path, { depth, gx: Math.floor(p.x / PACK), gz: Math.floor(p.z / PACK) })
  }
  let bytes = 0
  for (const [path, { depth, gx, gz }] of [...packs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const level = D - depth
    const pages: Parameters<typeof writePack>[3][number][] = []
    for (let slot = 0; slot < PACK * PACK; slot++) {
      const x = gx * PACK + (slot % PACK)
      const z = gz * PACK + Math.floor(slot / PACK)
      const f = fresh.get(`${level}/${x}/${z}`)
      if (f) pages.push(f)
      else {
        const s = await reader.stored(level, x, z)
        pages.push(s ? { data: s.data, ...s.entry } : null)
      }
    }
    const pack = writePack(depth, gx, gz, pages)
    await store.write(path, pack)
    bytes += pack.length
  }
  const depthErrors = new Array<number>(D + 1).fill(0)
  for (const record of Object.values(blocks)) {
    for (let L = 1; L <= D; L++)
      depthErrors[D - L] = Math.max(depthErrors[D - L]!, record.errors[L] ?? 0)
  }
  const sorted: Record<string, BlockRecord> = {}
  for (let bz = 0; bz < layout.blocksZ; bz++) {
    for (let bx = 0; bx < layout.blocksX; bx++) {
      const record = blocks[`${bx},${bz}`]
      if (record) sorted[`${bx},${bz}`] = record
    }
  }
  const manifest: BakeManifest = {
    format: 1,
    bakeVersion: BAKE_VERSION,
    grid,
    blocks: sorted,
    depthErrors,
    sourceHash: input.hash,
  }
  await store.write(MANIFEST, encoder.encode(`${JSON.stringify(manifest)}\n`))
  return {
    blocks: layout.blocksX * layout.blocksZ,
    rebaked: stale.length,
    dirtied: stale.map(([x, z]) => `${x},${z}`),
    pages: fresh.size,
    ancestors,
    bytes,
    ms: performance.now() - t0,
    msPerBlock: stale.length > 0 ? poolMs / stale.length : 0,
    outOfRange,
  }
}

export interface TerrainStats {
  baked: boolean
  /** The packs match the source. */
  current: boolean
  size: [number, number]
  spacing: number
  roots: number
  depth: number
  blocks: number
  pages: number
  /** Page bytes before deflate, and every file's bytes on disk. */
  rawBytes: number
  bytesOnDisk: number
  /** Per leaf sample. */
  bytesPerSample: number
  diskBytesPerSample: number
  msPerBlock: number
  slowestBlockMs: number
}

/** What `shard terrain stats` prints: size on disk, pages, bytes per sample, time per block. */
export async function terrainStats(
  input: BakeInput,
  store: PackStore,
  manifest: BakeManifest | undefined,
): Promise<TerrainStats> {
  const { layout } = input
  let pages = 0
  let rawBytes = 0
  if (manifest) {
    for (let depth = 0; depth <= layout.depth; depth++) {
      const level = layout.depth - depth
      const nx = layout.leavesX >> level
      const nz = layout.leavesZ >> level
      for (let gz = 0; gz < Math.ceil(nz / PACK); gz++) {
        for (let gx = 0; gx < Math.ceil(nx / PACK); gx++) {
          const path = `d${depth}/${gx}_${gz}.pack`
          const bytes = await store.read(path)
          if (!bytes) continue
          for (const e of readIndex(path, bytes).entries) {
            if (e.length === 0) continue
            pages++
            rawBytes += pageBytes(level === 0, layout.cells)
          }
        }
      }
    }
  }
  const samples = (layout.sizeX / layout.spacing) * (layout.sizeZ / layout.spacing)
  const bytesOnDisk = await store.size()
  const times = Object.values(manifest?.blocks ?? {}).map((b) => b.ms)
  return {
    baked: manifest !== undefined,
    current: manifest?.sourceHash === input.hash,
    size: [layout.sizeX, layout.sizeZ],
    spacing: layout.spacing,
    roots: layout.rootsX * layout.rootsZ,
    depth: layout.depth,
    blocks: layout.blocksX * layout.blocksZ,
    pages,
    rawBytes,
    bytesOnDisk,
    bytesPerSample: rawBytes / samples,
    diskBytesPerSample: bytesOnDisk / samples,
    msPerBlock: times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    slowestBlockMs: times.length > 0 ? Math.max(...times) : 0,
  }
}

/**
 * SHA-256 over every pack (path and bytes, sorted by path; not the manifest, which records
 * timings): equal hashes mean byte-identical bakes, as Node's and Chrome's must be (0071).
 */
export async function packHash(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const paths = [...files.keys()].filter((p) => p !== MANIFEST).sort()
  let size = 0
  for (const p of paths) size += p.length + files.get(p)!.length
  const all = new Uint8Array(size)
  let o = 0
  for (const p of paths) {
    all.set(encoder.encode(p), o)
    o += p.length
    all.set(files.get(p)!, o)
    o += files.get(p)!.length
  }
  return sha256Hex(all)
}
