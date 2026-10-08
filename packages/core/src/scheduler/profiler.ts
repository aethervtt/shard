import { ShardError } from '../error'
import { defineResource } from '../schema/resource'

// The profiler (0074). Spans are names interned into u16 ids on first use; after that a span is two
// clock reads, a push and a pop on a typed-array stack, and a ring write. Aggregates (last, average,
// max, p95 over a window of runs) are always on. A capture (`@aethervtt/shard-core/capture`) plugs
// in as the sink and gets every span as a timeline event; without one, nothing else happens.

/** A span name. `defineSpan` registers nothing: the first `begin` (or `record`) interns it. */
export interface SpanDef {
  readonly name: string
  /** The interned id, or -1 before first use. */
  id: number
}

/** A span by name, for code that times itself: `const ENCODE = defineSpan('terrain/encode')`. */
export function defineSpan(name: string): SpanDef {
  return { name, id: -1 }
}

/**
 * Timeline tracks. Workers are `TRACK.worker + n` for the pool's n-th thread, so track ids fit a
 * u8 with room for 251 workers.
 */
export const TRACK = { main: 0, gpu: 1, async: 2, gc: 3, worker: 4 } as const
export type TrackName = 'main' | 'gpu' | 'async' | 'gc' | 'worker'

export function trackName(track: number): TrackName {
  if (track === TRACK.main) return 'main'
  if (track === TRACK.gpu) return 'gpu'
  if (track === TRACK.async) return 'async'
  if (track === TRACK.gc) return 'gc'
  return 'worker'
}

/**
 * Whether a budget key covers a span (0074, 0075): the key equals the name, or is a prefix of it
 * ending at a `/`. `gpu:foliage` covers `gpu:foliage/place`, `render` covers `render/opaque`, and
 * `render/` does too. `render` doesn't cover `renderer/x`.
 */
export function spanCovers(key: string, name: string): boolean {
  if (name === key) return true
  const n = key.length
  if (n === 0 || name.length <= n || !name.startsWith(key)) return false
  return key.charCodeAt(n - 1) === SLASH || name.charCodeAt(n) === SLASH
}

const SLASH = 47
const MAX_SPANS = 65536
const MAX_DEPTH = 64
const ASYNC_SLOTS = 256

// Span names are interned once per process: a span's id is the same in every profiler, so a
// `SpanDef` caches it safely. Profilers allocate their rings per id on first use.
const spanNames: string[] = []
const spanTracks: number[] = []
const spanIds = new Map<string, number>()

/** The id of a span name, interning it on first use. */
export function internSpan(name: string, track: number = defaultTrack(name)): number {
  const known = spanIds.get(name)
  if (known !== undefined) return known
  const id = spanNames.length
  if (id >= MAX_SPANS) {
    throw new ShardError('perf/too-many-spans', `More than ${MAX_SPANS} span names`, {
      hint: 'Span names are fixed strings (e.g. "terrain/encode"), not per-entity or per-frame text.',
    })
  }
  spanNames.push(name)
  spanTracks.push(track)
  spanIds.set(name, id)
  return id
}

/** A span's name by id. */
export function spanName(id: number): string {
  return spanNames[id] ?? `span#${id}`
}

/** The track a span was first used on. */
export function spanTrack(id: number): number {
  return spanTracks[id] ?? TRACK.main
}

function defaultTrack(name: string): number {
  if (name.startsWith('gpu:')) return TRACK.gpu
  if (name.startsWith('worker/')) return TRACK.worker
  if (name === 'gc' || name.startsWith('gc/')) return TRACK.gc
  return TRACK.main
}

function idOf(span: SpanDef | string, track?: number): number {
  if (typeof span === 'string') return spanIds.get(span) ?? internSpan(span, track)
  let id = span.id
  if (id < 0) {
    id = internSpan(span.name, track)
    span.id = id
  }
  return id
}

/**
 * Where a capture receives the timeline. Called in the hot path: implementations write into
 * preallocated buffers.
 */
export interface ProfilerSink {
  /**
   * A span: `start` on the profiler's clock, `ms` long, `depth` on the main track's stack. `frame`
   * is the frame it belongs to when that isn't the one running (GPU timings land frames later), or
   * -1.
   */
  event(id: number, track: number, depth: number, start: number, ms: number, frame: number): void
  /** A frame starts (`frame` is `Time.frame` as it starts). */
  frameStart(frame: number, at: number): void
  /** The frame that started last ends: its CPU time is `ms`. */
  frameEnd(frame: number, ms: number): void
}

export interface SystemTiming {
  /** Most recent run, in ms. */
  last: number
  /** Mean over the window, in ms. */
  avg: number
  max: number
  /** Number of samples in the window. */
  samples: number
}

/** A span's aggregates over the window, as `perf.describe` reports them. */
export interface SpanAggregate extends SystemTiming {
  span: string
  track: TrackName
  /** 95th percentile over the window, in ms. */
  p95: number
  /** Under four steps of the clock: the numbers are mostly its resolution. */
  coarse?: true
}

export interface ProfilerSettingsData {
  /** Off: spans, records and captures do nothing. Default true. */
  enabled: boolean
  /** Runs each span's aggregates cover. Default 120. */
  window: number
}

export const ProfilerSettings = defineResource<ProfilerSettingsData>('core/ProfilerSettings', {
  description:
    'Turns the profiler (0074) on or off, and how many runs its aggregates cover. Off, spans cost a branch.',
  hostWritable: true,
  init: () => ({ enabled: true, window: 120 }),
})

/** The clock spans are timed with: its smallest step, and whether the page is isolated. */
export interface ClockInfo {
  resolutionMs: number
  /** False on a browser page that isn't cross-origin isolated (a coarsened clock). */
  isolated: boolean
}

export interface ProfilerOptions {
  /** The clock, in ms. Default `performance.now`. */
  now?: () => number
  /** Shared with `ProfilerSettings`, so toggling it there takes effect. */
  settings?: ProfilerSettingsData
}

interface Series {
  samples: Float64Array
  cursor: number
  count: number
}

const host = globalThis as {
  performance?: { now(): number }
  crossOriginIsolated?: boolean
  document?: unknown
}

function defaultNow(): number {
  return host.performance ? host.performance.now() : Date.now()
}

let measuredClock: ClockInfo | undefined

/**
 * The host clock's resolution: the smallest non-zero step `performance.now()` takes over a short
 * spin. Measured once. Pages that aren't cross-origin isolated report a coarsened clock.
 */
export function clockInfo(): ClockInfo {
  if (measuredClock) return measuredClock
  let resolution = Number.POSITIVE_INFINITY
  let prev = defaultNow()
  let steps = 0
  for (let i = 0; i < 2_000_000 && steps < 20; i++) {
    const t = defaultNow()
    if (t !== prev) {
      if (t - prev < resolution) resolution = t - prev
      prev = t
      steps++
    }
  }
  // A page states whether it's isolated; other hosts (Node, workers without the flag) don't coarsen.
  const isolated = host.document === undefined ? true : host.crossOriginIsolated === true
  measuredClock = {
    resolutionMs: Number.isFinite(resolution) ? Math.round(resolution * 1e6) / 1e6 : 0,
    isolated,
  }
  return measuredClock
}

/**
 * Spans and their aggregates (0074): per-system, per-schedule and per-frame CPU time, GPU passes,
 * worker jobs and async work, over the last `window` runs of each.
 */
export class Profiler {
  readonly settings: ProfilerSettingsData
  /** The clock, in ms. */
  now: () => number
  /** Receives every span while a capture runs. */
  sink: ProfilerSink | undefined
  /** Gets `perf/span-mismatch` and similar warnings; the app logs them. */
  onWarning: ((warning: ShardError) => void) | undefined
  /** `Time.frame` of the frame running now (or that ran last). */
  frame = 0
  /** The last span `end` measured, in ms. */
  lastMs = 0
  /** What the renderer said about GPU timing: `unavailable` without timestamp queries. */
  gpu: { status: 'unknown' | 'available' | 'unavailable'; quantized: boolean } = {
    status: 'unknown',
    quantized: false,
  }
  private windowSize: number
  private series: (Series | undefined)[] = []
  private readonly stackIds = new Int32Array(MAX_DEPTH)
  private readonly stackStarts = new Float64Array(MAX_DEPTH)
  private depth = 0
  private frameStartAt = 0
  private warned = new Uint8Array(256)
  private readonly asyncIds = new Int32Array(ASYNC_SLOTS).fill(-1)
  private readonly asyncKeys: (number | string | undefined)[] = new Array(ASYNC_SLOTS)
  private readonly asyncStarts = new Float64Array(ASYNC_SLOTS)
  private asyncCount = 0
  private readonly frameSpan = defineSpan('frame')

  constructor(options: ProfilerOptions | number = {}) {
    const o =
      typeof options === 'number' ? { settings: { enabled: true, window: options } } : options
    this.settings = o.settings ?? { enabled: true, window: 120 }
    this.now = o.now ?? defaultNow
    this.windowSize = Math.max(1, this.settings.window | 0)
  }

  get window(): number {
    return this.windowSize
  }

  get enabled(): boolean {
    return this.settings.enabled
  }

  /** The clock's resolution and isolation (measured once, on first use). */
  get clock(): ClockInfo {
    return clockInfo()
  }

  // --- spans -------------------------------------------------------------------

  /** Starts a span on the main track. Returns a token for `end`; -1 when the profiler is off. */
  begin(span: SpanDef): number {
    if (!this.settings.enabled) return -1
    const id = span.id >= 0 ? span.id : idOf(span, TRACK.main)
    const d = this.depth
    if (d >= MAX_DEPTH) {
      this.warn(id, WARN_DEPTH)
      return -1
    }
    this.stackIds[d] = id
    this.depth = d + 1
    this.stackStarts[d] = this.now()
    return d * MAX_SPANS + id
  }

  /** Ends the span `begin` returned `token` for, recording it. */
  end(token: number): void {
    if (token < 0) return
    const at = this.now()
    const d = (token / MAX_SPANS) | 0
    const id = token - d * MAX_SPANS
    if (d !== this.depth - 1 || this.stackIds[d] !== id) {
      this.warn(id, WARN_ORDER)
      // Inner spans left open end with it; an end for a span not on the stack is dropped.
      if (d >= this.depth || this.stackIds[d] !== id) return
    }
    this.depth = d
    const start = this.stackStarts[d]!
    const ms = at - start
    this.lastMs = ms
    this.push(id, ms)
    const sink = this.sink
    if (sink !== undefined) sink.event(id, TRACK.main, d, start, ms, -1)
  }

  /** Drops the span `token` and everything begun inside it, recording nothing (an exception unwound it). */
  cancel(token: number): void {
    if (token < 0) return
    const d = (token / MAX_SPANS) | 0
    if (d < this.depth) this.depth = d
  }

  /**
   * Time measured elsewhere (a GPU pass, a worker job): its aggregate, and a timeline event on
   * `track` that ended now, or started at `start`. `frame`: the frame it belongs to, when it lands
   * later (GPU timings).
   */
  record(span: SpanDef | string, ms: number, track?: number, start?: number, frame = -1): void {
    if (!this.settings.enabled) return
    const id = idOf(span, track)
    this.push(id, ms)
    const sink = this.sink
    if (sink !== undefined) {
      const t = track ?? spanTracks[id]!
      sink.event(id, t, t === TRACK.main ? this.depth : 0, start ?? this.now() - ms, ms, frame)
    }
  }

  /** Only the aggregate (`render/<node>` sums its views into one sample a frame). */
  sample(span: SpanDef | string, ms: number): void {
    if (!this.settings.enabled) return
    this.push(idOf(span), ms)
  }

  /** Only the timeline event, when a capture runs. */
  event(span: SpanDef | string, track: number, start: number, ms: number, frame = -1): void {
    const sink = this.sink
    if (sink === undefined || !this.settings.enabled) return
    sink.event(idOf(span, track), track, track === TRACK.main ? this.depth : 0, start, ms, frame)
  }

  /** Whether a capture is listening (callers skip work that only feeds the timeline). */
  get capturing(): boolean {
    return this.sink !== undefined
  }

  /**
   * Work that starts in one frame and ends in another (an asset load, a page fetch): an async span,
   * matched to its `endAsync` by span and key.
   */
  beginAsync(span: SpanDef, key: number | string): void {
    if (!this.settings.enabled) return
    const id = span.id >= 0 ? span.id : idOf(span, TRACK.async)
    if (this.asyncCount >= ASYNC_SLOTS) {
      this.warn(id, WARN_ASYNC)
      return
    }
    for (let i = 0; i < ASYNC_SLOTS; i++) {
      if (this.asyncIds[i] !== -1) continue
      this.asyncIds[i] = id
      this.asyncKeys[i] = key
      this.asyncStarts[i] = this.now()
      this.asyncCount++
      return
    }
  }

  endAsync(span: SpanDef, key: number | string): void {
    if (!this.settings.enabled || span.id < 0 || this.asyncCount === 0) return
    const id = span.id
    for (let i = 0; i < ASYNC_SLOTS; i++) {
      if (this.asyncIds[i] !== id || this.asyncKeys[i] !== key) continue
      const start = this.asyncStarts[i]!
      const ms = this.now() - start
      this.asyncIds[i] = -1
      this.asyncKeys[i] = undefined
      this.asyncCount--
      this.push(id, ms)
      const sink = this.sink
      if (sink !== undefined) sink.event(id, TRACK.async, 0, start, ms, -1)
      return
    }
  }

  // --- frames ------------------------------------------------------------------

  /**
   * A frame starts: spans left open from before are dropped (and reported once), and the `frame`
   * span begins. Returns its token for `endFrame`.
   */
  beginFrame(frame: number): number {
    if (!this.settings.enabled) return -1
    if (this.depth > 0) {
      const id = this.stackIds[this.depth - 1]!
      this.warn(id, WARN_OPEN_AT_START)
      this.depth = 0
    }
    if (this.settings.window !== this.windowSize) this.resize()
    this.frame = frame
    const token = this.begin(this.frameSpan)
    this.frameStartAt = this.stackStarts[0]!
    const sink = this.sink
    if (sink !== undefined) sink.frameStart(frame, this.frameStartAt)
    return token
  }

  endFrame(token: number): void {
    if (token < 0) return
    if (this.depth > 1) {
      const id = this.stackIds[this.depth - 1]!
      this.warn(id, WARN_OPEN_AT_END)
      this.depth = 1
    }
    this.end(token)
    const sink = this.sink
    if (sink !== undefined) sink.frameEnd(this.frame, this.lastMs)
  }

  // --- reading -----------------------------------------------------------------

  timing(name: string): SystemTiming | undefined {
    const id = spanIds.get(name)
    const series = id === undefined ? undefined : this.series[id]
    if (!series || series.count === 0) return undefined
    let sum = 0
    let max = 0
    for (let i = 0; i < series.count; i++) {
      const v = series.samples[i]!
      sum += v
      if (v > max) max = v
    }
    const last = series.samples[(series.cursor - 1 + this.windowSize) % this.windowSize]!
    return { last, avg: sum / series.count, max, samples: series.count }
  }

  /** A span's aggregates with its p95 and track, or undefined if it never ran. */
  stats(name: string): SpanAggregate | undefined {
    const timing = this.timing(name)
    if (!timing) return undefined
    const id = spanIds.get(name)!
    const series = this.series[id]!
    const sorted = Array.from(series.samples.subarray(0, series.count)).sort((a, b) => a - b)
    const out: SpanAggregate = {
      span: name,
      track: trackName(spanTracks[id]!),
      ...timing,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]!,
    }
    const resolution = this.clock.resolutionMs
    if (out.track !== 'gpu' && resolution > 0 && timing.avg < 4 * resolution) out.coarse = true
    return out
  }

  /** Every span that ran, by name. */
  all(): Record<string, SystemTiming> {
    const out: Record<string, SystemTiming> = {}
    for (let id = 0; id < this.series.length; id++) {
      if (!this.series[id]?.count) continue
      const name = spanNames[id]!
      out[name] = this.timing(name)!
    }
    return out
  }

  /** Names of every span with samples. */
  names(): string[] {
    const out: string[] = []
    for (let id = 0; id < this.series.length; id++)
      if (this.series[id]?.count) out.push(spanNames[id]!)
    return out
  }

  /** Forgets every aggregate (`perf.reset`). */
  reset(): void {
    for (const series of this.series) {
      if (!series) continue
      series.count = 0
      series.cursor = 0
    }
  }

  // --- internals ---------------------------------------------------------------

  private push(id: number, ms: number): void {
    let series = this.series[id]
    if (series === undefined) series = this.createSeries(id)
    series.samples[series.cursor] = ms
    series.cursor = series.cursor + 1 === this.windowSize ? 0 : series.cursor + 1
    if (series.count < this.windowSize) series.count++
  }

  private createSeries(id: number): Series {
    while (this.series.length <= id) this.series.push(undefined)
    const series: Series = { samples: new Float64Array(this.windowSize), cursor: 0, count: 0 }
    this.series[id] = series
    return series
  }

  private resize(): void {
    this.windowSize = Math.max(1, this.settings.window | 0)
    for (let id = 0; id < this.series.length; id++) {
      if (this.series[id])
        this.series[id] = { samples: new Float64Array(this.windowSize), cursor: 0, count: 0 }
    }
  }

  /** Reports a problem once per span name. */
  private warn(id: number, kind: number): void {
    if (id >= this.warned.length) {
      const grown = new Uint8Array(Math.max(id + 1, this.warned.length * 2))
      grown.set(this.warned)
      this.warned = grown
    }
    if (this.warned[id]) return
    this.warned[id] = 1
    this.onWarning?.(warningOf(kind, spanName(id)))
  }
}

const WARN_ORDER = 0
const WARN_OPEN_AT_START = 1
const WARN_OPEN_AT_END = 2
const WARN_DEPTH = 3
const WARN_ASYNC = 4
const BALANCE_HINT = 'Every profiler.begin(span) needs one profiler.end(token), in the same frame.'

/** Built only when reported, so a span ending out of order every frame allocates once. */
function warningOf(kind: number, name: string): ShardError {
  switch (kind) {
    case WARN_ORDER:
      return new ShardError(
        'perf/span-mismatch',
        `Span "${name}" ended out of order: spans end in the reverse order they began`,
        {
          hint: 'Every profiler.begin(span) needs one profiler.end(token), in the same frame.',
          path: name,
        },
      )
    case WARN_OPEN_AT_START:
      return new ShardError(
        'perf/span-mismatch',
        `Span "${name}" was still open when a frame began`,
        {
          hint: BALANCE_HINT,
          path: name,
        },
      )
    case WARN_OPEN_AT_END:
      return new ShardError(
        'perf/span-mismatch',
        `Span "${name}" was still open when its frame ended`,
        {
          hint: BALANCE_HINT,
          path: name,
        },
      )
    case WARN_DEPTH:
      return new ShardError(
        'perf/span-overflow',
        `Spans nest deeper than ${MAX_DEPTH} at "${name}"`,
        {
          hint: 'A span that begins in a loop needs its end inside the loop too.',
          path: name,
        },
      )
    default:
      return new ShardError(
        'perf/async-overflow',
        `More than ${ASYNC_SLOTS} async spans are open`,
        {
          hint: 'Every beginAsync(span, key) needs an endAsync(span, key), even when the work fails.',
          path: name,
        },
      )
  }
}

export const ProfilerResource = defineResource<Profiler>('core/Profiler', {
  description: 'Span timings (0074): systems, schedules, frames, render passes, GPU and workers.',
  init: () => new Profiler(),
})
