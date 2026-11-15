import { ShardError } from '@aethervtt/shard-core'
import { loadNoiseKernel, NOISE_KERNEL_MODULE } from '@aethervtt/shard-noise'
import type { Workers } from '@aethervtt/shard-platform'
import { procgenHost, runWorkerTask, workerTasksPooled } from '@aethervtt/shard-procgen'
import { NEAR_TASK } from './generator'
import {
  bakeNearPage,
  EDIT_KEY,
  EDIT_TILE,
  type KernelLayout,
  type NearPage,
  PAGE,
  type Stack,
} from './kernel'
import type { PackEntry } from './pack'
import { nodeKey } from './pages'
import type { TerrainLayout } from './source'
import { mainNoise } from './stack'

const WORKER = new URL('./worker.js', import.meta.url).href

/** A parent's estimated subtree error, per error measured against the next level (see the spec). */
export const NEAR_ERROR_FACTOR = 2

interface Job {
  key: number
  depth: number
  x: number
  z: number
  band: number
  priority: number
  generation: number
  resolve: (page: NearPage) => void
  reject: (err: unknown) => void
}

export interface NearStats {
  leaves: number
  parents: number
  /** Pool (or inline) milliseconds over the leaves and parents baked. */
  leafMs: number
  parentMs: number
  /** Leaves the main thread baked because one was due before its job landed. */
  bakedInline: number
  /** The most jobs waiting at once. */
  queuedPeak: number
}

/**
 * A near terrain's page source (spec 0119): page jobs queued by urgency, at most two per worker
 * running, on the generator worker module (stacks with generators) or terrain's worker (without),
 * inline when there's no pool. Remembers each baked page's index entry (its range and error) and
 * the per-depth error table; nothing else, since pages live in the PageStore's cache.
 */
export class NearBake {
  stack: Stack
  readonly layout: TerrainLayout
  readonly lo: number
  readonly hi: number
  workers: Workers | undefined
  private readonly entries = new Map<number, PackEntry>()
  private readonly queue: Job[] = []
  private running = 0
  /** Bumps when the stack changes: jobs from before resolve, and their pages are dropped. */
  generation = 0
  /** Per depth: the largest estimated node error of the pages baked there (−1 none yet). */
  readonly depthErrors: Float64Array
  /** Bumps when `depthErrors` grows (the runtime recaps its selection errors). */
  errorsVersion = 0
  /** Called when a page's entry is known (tree nodes take its range). */
  onEntry: ((depth: number, x: number, z: number) => void) | undefined
  /** Called once per page that came back with heights clipped by heightRange. */
  onClipped: ((depth: number, x: number, z: number, page: NearPage) => void) | undefined
  stats: NearStats = {
    leaves: 0,
    parents: 0,
    leafMs: 0,
    parentMs: 0,
    bakedInline: 0,
    queuedPeak: 0,
  }

  constructor(stack: Stack, layout: TerrainLayout, workers: Workers | undefined) {
    this.stack = stack
    this.layout = layout
    this.lo = stack.lo
    this.hi = stack.hi
    this.workers = workers
    this.depthErrors = new Float64Array(layout.depth + 1).fill(-1)
    this.depthErrors[layout.depth] = 0
  }

  /** A new stack (a source or generator change): entries and errors start again. */
  reset(stack: Stack): void {
    this.stack = stack
    this.generation++
    this.entries.clear()
    this.depthErrors.fill(-1)
    this.depthErrors[this.layout.depth] = 0
    this.errorsVersion++
    for (const job of this.queue.splice(0)) job.reject(stale())
  }

  /** A page's index entry, once it has baked. */
  entry(depth: number, x: number, z: number): PackEntry | undefined {
    return this.entries.get(nodeKey(depth, x, z))
  }

  get queued(): number {
    return this.queue.length
  }

  get active(): number {
    return this.running
  }

  /** Bakes a page, queued by `band` then `priority` (higher first). */
  request(depth: number, x: number, z: number, band: number, priority: number): Promise<NearPage> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        key: nodeKey(depth, x, z),
        depth,
        x,
        z,
        band,
        priority,
        generation: this.generation,
        resolve,
        reject,
      })
      if (this.queue.length > this.stats.queuedPeak) this.stats.queuedPeak = this.queue.length
      this.pump()
    })
  }

  /** Raises a queued page's urgency (a collider tile now due, say). */
  promote(key: number, band: number, priority: number): void {
    for (const job of this.queue) {
      if (job.key !== key) continue
      if (band > job.band || (band === job.band && priority > job.priority)) {
        job.band = band
        job.priority = priority
      }
    }
  }

  /** Bakes a leaf on this thread now (the same bytes as its job), for a tile due this frame. */
  bakeNow(depth: number, x: number, z: number): NearPage {
    const page = bakeNearPage(mainNoise(), this.stack, this.layout, depth, x, z)
    if (depth === this.layout.depth) this.stats.bakedInline++
    this.record(depth, x, z, page)
    return page
  }

  /** Jobs running at once: two per worker of the pool they run on, one inline. */
  private slots(): number {
    const pool =
      this.stack.generators.length > 0
        ? workerTasksPooled()
          ? procgenHost().workers
          : undefined
        : this.workers
    return pool && pool.size > 0 ? pool.size * 2 : 1
  }

  private pump(): void {
    while (this.running < this.slots() && this.queue.length > 0) {
      let best = 0
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i]!
        const b = this.queue[best]!
        if (a.band > b.band || (a.band === b.band && a.priority > b.priority)) best = i
      }
      const job = this.queue[best]!
      this.queue[best] = this.queue[this.queue.length - 1]!
      this.queue.pop()
      this.running++
      void this.run(job).finally(() => {
        this.running--
        this.pump()
      })
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const stack = pageStack(this.stack, this.layout, job.depth, job.x, job.z)
      const layout = this.layout as KernelLayout
      let page: NearPage
      if (stack.generators.length > 0) {
        const kernel = await loadNoiseKernel()
        page = await runWorkerTask<NearPage>(
          NEAR_TASK,
          [kernel.module, kernel.simd, stack, layout, job.depth, job.x, job.z],
          { kind: 'terrain/near-page' },
        )
      } else if (this.workers && this.workers.size > 0) {
        const kernel = await loadNoiseKernel()
        page = await this.workers.run<NearPage>(
          WORKER,
          'nearPage',
          [NOISE_KERNEL_MODULE, kernel.module, stack, layout, job.depth, job.x, job.z],
          { kind: 'terrain/near-page' },
        )
      } else {
        await Promise.resolve()
        page = bakeNearPage(mainNoise(), stack, layout, job.depth, job.x, job.z)
      }
      if (job.generation !== this.generation) {
        job.reject(stale())
        return
      }
      this.record(job.depth, job.x, job.z, page)
      if (job.depth === this.layout.depth) {
        this.stats.leaves++
        this.stats.leafMs += page.ms
      } else {
        this.stats.parents++
        this.stats.parentMs += page.ms
      }
      job.resolve(page)
    } catch (err) {
      job.reject(err)
    }
  }

  /** A baked page's entry, its share of the error table, and its range padded by its error. */
  private record(depth: number, x: number, z: number, page: NearPage): void {
    const error = depth === this.layout.depth ? 0 : page.error * NEAR_ERROR_FACTOR
    let min = page.min
    let max = page.max
    if (error > 0) {
      const pad = Math.ceil((error / (this.hi - this.lo)) * 65535)
      min = Math.max(0, min - pad)
      max = Math.min(65535, max + pad)
    }
    this.entries.set(nodeKey(depth, x, z), { offset: 0, length: 1, min, max, error })
    if (error > this.depthErrors[depth]!) {
      this.depthErrors[depth] = error
      this.errorsVersion++
    }
    if (page.clipped > 0) this.onClipped?.(depth, x, z, page)
    this.onEntry?.(depth, x, z)
  }

  /**
   * The selection's per-depth errors (0071's convention: index d is how far depth d's detail is
   * from depth d − 1's surface), from the measured depths; a depth nothing has baked at yet takes
   * half the one above.
   */
  selectionErrors(out: Float32Array): Float32Array {
    const D = this.layout.depth
    const e = new Float64Array(D + 1)
    for (let d = 0; d < D; d++) {
      const m = this.depthErrors[d]!
      e[d] = m >= 0 ? m : d > 0 ? e[d - 1]! / 2 : this.layout.rootSize / PAGE
    }
    for (let d = 1; d <= D + 1; d++) out[d] = e[d - 1]!
    out[0] = out[1]! * 2
    for (let d = D; d >= 0; d--) out[d] = Math.max(out[d]!, out[d + 1]!)
    return out
  }
}

function stale(): ShardError {
  return new ShardError('terrain/stale-page', 'The terrain changed while this page was baking', {
    hint: 'Nothing to do: the page bakes again from the new stack when it is wanted.',
  })
}

/** Edit tile keys of a map inside a range of tile coordinates. */
function trimTiles<T>(
  tiles: ReadonlyMap<number, T> | null,
  t0x: number,
  t0z: number,
  t1x: number,
  t1z: number,
): Map<number, T> | null {
  if (!tiles || tiles.size === 0) return null
  const out = new Map<number, T>()
  for (const [key, tile] of tiles) {
    const tx = key % EDIT_KEY
    const tz = Math.floor(key / EDIT_KEY)
    if (tx >= t0x && tx <= t1x && tz >= t0z && tz <= t1z) out.set(key, tile)
  }
  return out.size > 0 ? out : null
}

/** The stack a page job posts: its edit layers (0104) cut to the tiles the page reads. */
export function pageStack(
  stack: Stack,
  layout: TerrainLayout,
  depth: number,
  x: number,
  z: number,
): Stack {
  const e = stack.edits
  if (!e.sculpt?.size && !e.paint?.size) return stack
  const s = 2 ** (layout.depth - depth)
  const t = (v: number) => Math.floor(Math.max(0, v) / EDIT_TILE)
  // Leaf samples the page reads, with its border (and a parent's finer margin, at most s).
  const i0 = x * PAGE * s - s - 1
  const j0 = z * PAGE * s - s - 1
  const i1 = (x + 1) * PAGE * s + s + 1
  const j1 = (z + 1) * PAGE * s + s + 1
  const k = layout.paintStep
  return {
    ...stack,
    edits: {
      at: e.at,
      paintAt: e.paintAt,
      sculpt: trimTiles(e.sculpt, t(i0), t(j0), t(i1), t(j1)),
      paint: trimTiles(e.paint, t(i0 / k), t(j0 / k), t(i1 / k), t(j1 / k)),
    },
  }
}
