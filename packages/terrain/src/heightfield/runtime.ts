import { assetServer } from '@aethervtt/shard-assets'
import { type AssetRef, type Entity, ShardError, type World } from '@aethervtt/shard-core'
import type { PlatformFileSystem, Workers } from '@aethervtt/shard-platform'
import { LogResource } from '@aethervtt/shard-runtime'
import { PlanetFrame } from '../frame'
import { TerrainWorld } from '../heights'
import { capErrors } from '../lod'
import { createSelection, NODE_BOUNDS, NODE_READY, QuadTree } from '../quadtree'
import { type BakeManifest, type BakeReport, bakeTerrain, editsDigest, readManifest } from './bake'
import { Terrain } from './component'
import { heightfieldEditorOf } from './editor'
import { TerrainEdits } from './edits'
import { dequantize, LEAF_SIDE, PAGE, type Stack } from './kernel'
import { fsPackStore, memoryPackStore, type PackStore } from './pack'
import { nodeKey, PageStore } from './pages'
import { stackFor, terrainCacheDir } from './project'
import { RootGrid } from './root-grid'
import type { TerrainLayout } from './source'
import { type TerrainSourceAsset, TerrainSources } from './source-asset'
import { mainNoise } from './stack'

/** GPU bytes a page takes in the pool: its texels and its control texels. */
export function pageGpuBytes(layout: TerrainLayout): number {
  return LEAF_SIDE * LEAF_SIDE * 4 + (layout.cells + 1) * (layout.cells + 1) * 4
}

/** Coarse levels kept loaded by default: the deepest whose pages, with every coarser level's, fit here. */
export const RESIDENT_BYTES = 8 * 1024 * 1024

export interface HeightfieldSettings {
  source: AssetRef | null
  errorPixels: number
  vertexPixels: number
  colliderRadius: number
  skirts: boolean
  residentDepth: number
}

/** Where a terrain is in getting ready to stream. */
export type BakeState = 'idle' | 'checking' | 'baking' | 'current' | 'failed'

/** Edits that are in, newest last (spec 0104): what caches of the ground (water's) refresh. */
export class EditLog {
  static readonly SIZE = 64
  /** Bumps per rectangle; `since(seq)` lists the ones after it. */
  seq = 0
  private readonly rects = new Float64Array(EditLog.SIZE * 4)

  /** Adds a rectangle, [x0, z0] to [x1, z1] metres in the terrain's frame. */
  push(x0: number, z0: number, x1: number, z1: number): void {
    const o = (this.seq % EditLog.SIZE) * 4
    this.rects[o] = x0
    this.rects[o + 1] = z0
    this.rects[o + 2] = x1
    this.rects[o + 3] = z1
    this.seq++
  }

  /**
   * Visits the rectangles after `seq`, oldest first. Returns false (visiting none) when more than
   * the log holds came after it: the caller refreshes everything.
   */
  since(seq: number, visit: (x0: number, z0: number, x1: number, z1: number) => void): boolean {
    if (this.seq - seq > EditLog.SIZE) return false
    for (let s = seq; s < this.seq; s++) {
      const o = (s % EditLog.SIZE) * 4
      visit(this.rects[o]!, this.rects[o + 1]!, this.rects[o + 2]!, this.rects[o + 3]!)
    }
    return true
  }
}

/**
 * Everything the terrain keeps per `Terrain` entity (spec 0071): its source and compiled stack,
 * its packs (baked on first use when missing or stale), the pages it has read, its quadtree over
 * the root grid with the per-depth errors from the bake, its frame, and its anchors. Colliders and
 * the render side keep their state in `parts`.
 */
export class HeightfieldRuntime {
  readonly entity: Entity
  settings: HeightfieldSettings | undefined
  tick = -1
  asset: TerrainSourceAsset | undefined
  private assetVersion = -1
  stack: Stack | undefined
  layout: TerrainLayout | undefined
  /** Bumps when what the pages hold changes (a source edit, after its rebake). */
  version = 0
  problem: ShardError | null = null
  waiting: string | null = null
  store: PackStore | undefined
  pages: PageStore | undefined
  manifest: BakeManifest | undefined
  bake: BakeState = 'idle'
  lastBake: BakeReport | undefined
  /** Blocks the last bake rebaked ("bx,bz"), for terrain.map's bake mode. */
  dirtied: string[] = []
  readonly grid = new RootGrid()
  readonly tree = new QuadTree(this.grid, 1024)
  readonly selection = createSelection()
  /** Per depth: the measured errors from the bake (selection's table, 0043's convention), and capped. */
  rawErrors: Float32Array = new Float32Array(2)
  errors: Float32Array = new Float32Array(2)
  lodBias = 1
  /** Coarse levels kept loaded; the pages of depths up to it are pinned. */
  residentDepth = 0
  /** Resident pages loaded: the GPU side can draw coarse ground. */
  streaming = false
  readonly frame = new PlanetFrame()
  anchorPos = new Float64Array(0)
  anchorRadius = new Float64Array(0)
  anchorEntity: Entity[] = []
  anchors = 0
  readonly parts = new Map<string, unknown>()
  /** The edit layers (spec 0104), for the current grid. */
  edits: TerrainEdits | undefined
  readonly editLog = new EditLog()
  /** The source hash the pages and manifest match. */
  private bakedHash = ''
  private generation = 0

  constructor(entity: Entity) {
    this.entity = entity
    this.grid.onInit = (tree, n, depth, x, z) => this.initNode(tree, n, depth, x, z)
  }

  /** Whether colliders and height queries can run: the source and its assets are loaded. */
  get ready(): boolean {
    return this.problem === null && this.stack !== undefined && this.layout !== undefined
  }

  get lo(): number {
    return this.asset?.source.heightRange[0] ?? 0
  }

  get hi(): number {
    return this.asset?.source.heightRange[1] ?? 1
  }

  /** Vertex spacing at a depth (m). */
  spacing(depth: number): number {
    const l = this.layout
    return l ? l.rootSize / 2 ** depth / PAGE : 1
  }

  /** Metres a node at `depth` covers. */
  nodeSize(depth: number): number {
    return (this.layout?.rootSize ?? 1) / 2 ** depth
  }

  /** New tree nodes take what's known of their page: its exact height range. */
  private initNode(tree: QuadTree, n: number, depth: number, x: number, z: number): void {
    const e = this.pages?.entry(depth, x, z)
    if (!e) return
    tree.minH[n] = dequantize(e.min, this.lo, this.hi)
    tree.maxH[n] = dequantize(e.max, this.lo, this.hi)
    tree.flags[n]! |= NODE_BOUNDS
    const ready = this.parts.get('ready') as ((key: number) => number) | undefined
    if (ready) {
      const slot = ready(nodeKey(depth, x, z))
      if (slot >= 0) {
        tree.flags[n]! |= NODE_READY
        tree.slot[n] = slot
      }
    }
  }

  /**
   * Brings the runtime up to date with its component and source: reads settings, resolves and
   * compiles the source, and (in the background) checks its packs, bakes them if they're missing
   * or stale, and loads the coarse levels.
   */
  refresh(world: World, env: { fs: PlatformFileSystem | undefined; workers: Workers | undefined }) {
    const table = world.entityTable(this.entity)
    const tick = table.changedTicks(Terrain)[world.entityRow(this.entity)]!
    let settingsChanged = false
    if (tick !== this.tick || !this.settings) {
      this.tick = tick
      const v = world.get(this.entity, Terrain)
      this.settings = {
        source: v.source,
        errorPixels: v.errorPixels,
        vertexPixels: v.vertexPixels,
        colliderRadius: v.colliderRadius,
        skirts: v.skirts,
        residentDepth: v.residentDepth,
      }
      settingsChanged = true
    }
    const ref = this.settings.source
    if (!ref || (ref.guid === undefined && ref.path === undefined)) {
      this.waiting = 'a source (Terrain.source)'
      return
    }
    const asset = resolve(world, ref)
    if (!asset) {
      this.waiting = `terrain source ${ref.path ?? ref.guid}`
      return
    }
    if (asset !== this.asset || asset.version !== this.assetVersion) {
      try {
        this.stack = stackFor(world, asset)
      } catch (err) {
        const e = err as ShardError
        if (e.code === 'terrain/not-ready') {
          this.waiting = e.path ?? 'its assets'
          return
        }
        this.report(world, e)
        return
      }
      const layoutChanged = JSON.stringify(asset.layout) !== JSON.stringify(this.layout)
      this.asset = asset
      this.assetVersion = asset.version
      this.problem = null
      this.waiting = null
      if (layoutChanged) {
        this.layout = asset.layout
        this.grid.configure(asset.layout.rootsX, asset.layout.rootsZ, asset.layout.rootSize)
        this.tree.resetRoots(this.lo, this.hi)
        this.store = env.fs
          ? fsPackStore(env.fs, terrainCacheDir(guidOf(world, ref) ?? 'memory'))
          : memoryPackStore()
        this.pages = new PageStore(this.store, asset.layout, this.lo, this.hi, env.workers)
        this.manifest = undefined
        this.streaming = false
        this.bakedHash = ''
        this.rawErrors = new Float32Array(asset.layout.depth + 2)
        this.errors = new Float32Array(asset.layout.depth + 2)
        // Until the bake says, a node's error is its spacing's: selection works, coarsely.
        for (let d = 0; d <= asset.layout.depth; d++) this.rawErrors[d] = this.spacing(d) * 8
        settingsChanged = true
        // Edits are for a grid: a new one starts without them.
        this.edits = this.createEdits(world)
      }
      // The edit layers ride on every compiled stack.
      this.stack.edits.sculpt = this.edits!.sculpt
      this.stack.edits.paint = this.edits!.paint
      // Saved edits waiting for the source go in ahead of the bake, which bakes them.
      const saved = world.tryResource(TerrainWorld)?.pendingEdits
      const data = saved?.get(this.entity)
      if (data) {
        saved!.delete(this.entity)
        this.loadingEdits = true
        try {
          this.edits!.load(data)
        } catch (err) {
          this.report(world, err as ShardError)
        } finally {
          this.loadingEdits = false
        }
      }
      void this.prepare(world, env)
    }
    if (settingsChanged) this.capErrors()
  }

  /** Loading saved edits ahead of a bake: the bake bakes them, so nothing is queued. */
  private loadingEdits = false

  /** Edit layers for the current grid, reporting their changes to the editor's queue. */
  private createEdits(world: World): TerrainEdits {
    const edits = new TerrainEdits({
      layout: this.layout!,
      stack: () => this.stack!,
      noise: mainNoise,
      layers: () => this.asset?.source.layers.map((l) => l.name) ?? [],
      bounds: (x0, z0, x1, z1) => this.groundBounds(x0, z0, x1, z1),
    })
    edits.onChange = (change, cause) => {
      if (this.loadingEdits) return
      heightfieldEditorOf(this).changed(change, cause, world.tryResource(TerrainWorld)?.frame ?? 0)
    }
    return edits
  }

  /** The ground's height range over a rectangle of metres, from the root pages' ranges. */
  groundBounds(x0: number, z0: number, x1: number, z1: number): [number, number] {
    const l = this.layout
    if (!l || !this.pages) return [this.lo, this.hi]
    let lo = Infinity
    let hi = -Infinity
    const s = l.rootSize
    for (
      let z = Math.max(0, Math.floor(z0 / s));
      z <= Math.min(l.rootsZ - 1, Math.floor(z1 / s));
      z++
    ) {
      for (
        let x = Math.max(0, Math.floor(x0 / s));
        x <= Math.min(l.rootsX - 1, Math.floor(x1 / s));
        x++
      ) {
        const e = this.pages.entry(0, x, z)
        if (!e) return [this.lo, this.hi]
        lo = Math.min(lo, dequantize(e.min, this.lo, this.hi))
        hi = Math.max(hi, dequantize(e.max, this.lo, this.hi))
      }
    }
    return lo <= hi ? [lo, hi] : [this.lo, this.hi]
  }

  private report(world: World, err: ShardError): void {
    this.problem = err
    this.waiting = null
    world.tryResource(LogResource)?.error(err)
  }

  /** Errors capped by vertex spacing (`vertexPixels`), as planets have them. */
  capErrors(): void {
    const s = this.settings
    if (!s) return
    this.errors = capErrors(
      this.rawErrors,
      (d) => this.spacing(d),
      s.errorPixels,
      s.vertexPixels,
      this.errors.length === this.rawErrors.length ? this.errors : undefined,
    )
  }

  /**
   * Checks the packs against the source; bakes them when missing or stale (into the project's
   * cache where the file service writes, else in memory); then reads the manifest's errors and
   * loads the coarse levels. A later edit runs it again; pages already drawn are replaced in place.
   */
  private async prepare(
    world: World,
    env: { fs: PlatformFileSystem | undefined; workers: Workers | undefined },
  ): Promise<void> {
    const generation = ++this.generation
    const asset = this.asset!
    const stack = this.stack!
    const pages = this.pages!
    let store = this.store!
    this.bake = 'checking'
    try {
      // With edits, the packs are of the source and these edits (0104).
      const digest = await editsDigest(stack.edits)
      const hash = digest ? `${asset.hash}:${digest}` : asset.hash
      let manifest = await readManifest(store)
      if (manifest?.sourceHash !== hash) {
        if (!store.writable) {
          // A read-only host (a static web build) without current packs bakes in memory.
          store = memoryPackStore()
          this.store = store
          pages.store = store
        }
        this.bake = 'baking'
        const input = { source: asset.source, layout: asset.layout, deps: asset.deps, hash }
        const report = await bakeTerrain(input, stack, store, {
          ...(env.workers ? { workers: env.workers } : {}),
          warn: (problem) =>
            world.tryResource(LogResource)?.warn(problem.message, { code: problem.code }),
        })
        if (generation !== this.generation) return
        this.lastBake = report
        this.dirtied = report.dirtied
        manifest = await readManifest(store)
      }
      if (generation !== this.generation) return
      if (!manifest)
        throw new ShardError('terrain/bake-failed', 'The terrain bake wrote no manifest', {
          hint: 'Check the project cache is writable (.shard/cache/terrain), then run `shard terrain bake --force`.',
        })
      const rebaked = this.bakedHash !== '' && this.bakedHash !== manifest.sourceHash
      this.manifest = manifest
      this.bakedHash = manifest.sourceHash
      if (rebaked) {
        pages.clear()
        this.version++
      }
      // Selection's errors: errors[d] is how far depth d's detail is from depth d − 1's surface.
      const D = this.layout!.depth
      const raw = new Float32Array(D + 2)
      for (let d = 1; d <= D + 1; d++) raw[d] = manifest.depthErrors[d - 1] ?? 0
      raw[0] = raw[1]! * 2
      for (let d = D; d >= 0; d--) raw[d] = Math.max(raw[d]!, raw[d + 1]!)
      this.rawErrors = raw
      this.capErrors()
      // Coarse levels, pinned.
      const per = pageGpuBytes(this.layout!)
      let resident = this.settings!.residentDepth
      if (resident < 0) {
        resident = 0
        let bytes = 0
        for (let d = 0; d <= D; d++) {
          const [nx, nz] = pages.nodesAt(d)
          bytes += nx * nz * per
          if (bytes > RESIDENT_BYTES) break
          resident = d
        }
      }
      this.residentDepth = Math.min(D, resident)
      const loads: Promise<unknown>[] = []
      for (let d = 0; d <= this.residentDepth; d++) {
        const [nx, nz] = pages.nodesAt(d)
        for (let z = 0; z < nz; z++) {
          for (let x = 0; x < nx; x++) {
            pages.pin(nodeKey(d, x, z))
            loads.push(pages.load(d, x, z))
          }
        }
      }
      await Promise.all(loads)
      if (generation !== this.generation) return
      // Known ranges for the nodes already in the tree.
      for (let n = 0; n < this.tree.count; n++) this.refreshBounds(n)
      this.bake = 'current'
      this.streaming = true
    } catch (err) {
      if (generation !== this.generation) return
      this.bake = 'failed'
      this.report(
        world,
        err instanceof ShardError ? err : new ShardError('terrain/bake-failed', String(err)),
      )
    }
  }

  private readonly g = new Float64Array(2)

  /** A tree node's height range from its pack entry, when known. */
  refreshBounds(n: number): void {
    this.grid.globalOf(this.tree, n, this.g)
    const e = this.pages?.entry(this.tree.depth[n]!, this.g[0]!, this.g[1]!)
    if (!e) return
    this.tree.setHeights(
      n,
      dequantize(e.min, this.lo, this.hi),
      dequantize(e.max, this.lo, this.hi),
    )
  }

  /** The tree node for a page, if the tree has one at that depth. */
  nodeOf(depth: number, x: number, z: number): number {
    const l = this.layout
    if (!l) return -1
    const rx = x >> depth
    const rz = z >> depth
    if (rx >= l.rootsX || rz >= l.rootsZ) return -1
    const mask = 2 ** depth - 1
    const n = this.tree.find(rz * l.rootsX + rx, depth, x & mask, z & mask)
    return this.tree.depth[n] === depth ? n : -1
  }
}

function guidOf(world: World, ref: AssetRef): string | undefined {
  if (ref.guid !== undefined) return ref.guid
  return world.tryResource(TerrainSources) ? assetServer(world).entry(ref)?.guid : undefined
}

/** The loaded source a handle names, or undefined while it loads (the load starts here). */
function resolve(world: World, ref: AssetRef): TerrainSourceAsset | undefined {
  const store = world.initResource(TerrainSources)
  if (ref.guid !== undefined) {
    const v = store.get(ref)
    if (v) return v
  }
  const server = assetServer(world)
  const entry = server.entry(ref)
  if (!entry) return undefined
  if (entry.state !== 'failed') void server.request(entry.guid).catch(() => {})
  return store.get({ guid: entry.guid })
}
