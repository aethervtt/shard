import {
  defineResource,
  type Profiler,
  spanCount,
  spanCovers,
  spanId,
  spanName,
} from '@aethervtt/shard-core'

// Foliage that adapts to its slice (0075): GPU foliage (0045) thins its density and pulls in its
// range to keep its GPU time (every `gpu:foliage/*` span, by 0074's covers rule) inside a
// millisecond target, the way `TerrainBudget.triangles` steers 0043's LOD bias, and goes back to
// full detail when there's room. Nothing here allocates per frame.

/** The budget key foliage's GPU time is measured by: it covers `gpu:foliage/place`, `/cull`, `/draw`. */
export const FOLIAGE_SPAN_KEY = 'gpu:foliage'

export interface FoliageBudgetValue {
  /**
   * GPU milliseconds foliage may take a frame. 0 (the default): its `gpu:foliage` slice of the
   * app's scenario (`App.perfScenario`) on the detected machine, and with no scenario (or an
   * unknown machine) no target: foliage draws at full detail.
   */
  ms: number
  /** The least detail it thins to, as a share of the instances drawn at full detail. Default 0.1. */
  minDetail: number
  /** Read only: the target in force (ms), 0 when none. */
  target: number
  /** Read only: foliage's GPU time a frame, smoothed (ms). */
  measuredMs: number
  /**
   * Read only: the share of full detail drawn (minDetail to 1). Density is its square root and range
   * its fourth root, so instances drawn scale with it.
   */
  detail: number
}

export const FoliageBudget = defineResource<FoliageBudgetValue>('render/FoliageBudget', {
  description:
    "GPU foliage's time budget (0045, 0075): ms is the target (0: the scenario's gpu:foliage slice); detail is how much of full density and range it draws to stay inside it.",
  hostWritable: true,
  init: () => ({ ms: 0, minDetail: 0.1, target: 0, measuredMs: 0, detail: 1 }),
})

/** Weight of a new GPU time in the smoothed one. */
const SMOOTHING = 0.15
/** Detail falls this much a sample while over the target... */
const STEP_DOWN = 1.01
/** ...and rises this much while under `RECOVER` of it: the band between holds still. */
const STEP_UP = 1.005
const RECOVER = 0.85

/**
 * The controller: one GPU time a frame in, detail out. Smoothed (an exponential average), with
 * hysteresis (it moves only above the target, or under 85% of it) and asymmetric steps (down 1% a
 * sample, up 0.5%), so the lag of GPU timings (frames late) doesn't make it oscillate. Like
 * `TerrainBudget.triangles`' LOD bias (0043), slow on purpose: density and range change gradually.
 */
export class FoliageController {
  detail = 1
  /** Smoothed GPU time (ms); 0 before the first sample. */
  smoothed = 0
  private primed = false

  /** One frame's foliage GPU time against `target` (0: none, back to full detail at once). */
  sample(ms: number, target: number, minDetail: number): void {
    this.smoothed = this.primed ? this.smoothed + SMOOTHING * (ms - this.smoothed) : ms
    this.primed = true
    if (!(target > 0)) {
      this.detail = 1
      return
    }
    const floor = Math.min(1, Math.max(0.001, minDetail))
    if (this.smoothed > target) this.detail = Math.max(floor, this.detail / STEP_DOWN)
    else if (this.smoothed < target * RECOVER) this.detail = Math.min(1, this.detail * STEP_UP)
    if (this.detail < floor) this.detail = floor
  }

  /** No target: full detail, and the smoothing starts over. */
  reset(): void {
    this.detail = 1
    this.primed = false
    this.smoothed = 0
  }

  /** The share of instances kept by thinning (the cull's density factor). */
  get density(): number {
    return Math.sqrt(this.detail)
  }

  /** The share of each layer's range drawn. */
  get rangeScale(): number {
    return Math.sqrt(Math.sqrt(this.detail))
  }
}

/**
 * Reads the GPU time a budget key covers, one GPU frame at a time, without allocating: when
 * `gpu:frame` has a new sample, the covered spans that got one with it are summed. Span names are
 * matched by `spanCovers` as they're interned.
 */
export class CoveredGpuTime {
  readonly key: string
  /** The latest frame's covered time (ms), after `read` returned true. */
  ms = 0
  private ids = new Int32Array(8)
  private seen = new Float64Array(8)
  private count = 0
  private scanned = 0
  private frameId = -1
  private frameRuns = 0

  constructor(key: string) {
    this.key = key
  }

  /** True when a new GPU frame's timings landed since the last call; `ms` is then its covered time. */
  read(profiler: Profiler): boolean {
    if (spanCount() !== this.scanned) this.scan(profiler)
    if (this.frameId < 0) return false
    const runs = profiler.runsOf(this.frameId)
    if (runs === this.frameRuns) return false
    this.frameRuns = runs
    let ms = 0
    for (let i = 0; i < this.count; i++) {
      const id = this.ids[i]!
      const r = profiler.runsOf(id)
      if (r === this.seen[i]) continue
      this.seen[i] = r
      ms += profiler.lastOf(id)
    }
    this.ms = ms
    return true
  }

  /** New span names since the last scan: the ones the key covers join the list. */
  private scan(profiler: Profiler): void {
    const n = spanCount()
    for (let id = this.scanned; id < n; id++) {
      if (!spanCovers(this.key, spanName(id))) continue
      if (this.count === this.ids.length) {
        const ids = new Int32Array(this.count * 2)
        ids.set(this.ids)
        this.ids = ids
        const seen = new Float64Array(this.count * 2)
        seen.set(this.seen)
        this.seen = seen
      }
      this.ids[this.count] = id
      // What it ran before it was found isn't this frame's.
      this.seen[this.count] = profiler.runsOf(id)
      this.count++
    }
    this.scanned = n
    if (this.frameId < 0) this.frameId = spanId('gpu:frame')
  }
}
