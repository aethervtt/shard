import { ShardError } from '../../error'
import { spanCovers, spanName, TRACK, type TrackName, trackName } from '../profiler'

// A finished capture (0074): its frames and events, which frame each event belongs to, how events
// nest on each track, and from those the summary an agent reads and the Chrome trace a human opens.

export interface CaptureFrames {
  /** `Time.frame` of each frame, oldest first. */
  numbers: Float64Array
  /** When each started, on the profiler's clock (ms). */
  starts: Float64Array
  /** Each frame's CPU time: the `frame` span. */
  cpu: Float64Array
}

export interface CaptureEvents {
  ids: Uint16Array
  tracks: Uint8Array
  depths: Uint8Array
  starts: Float64Array
  durations: Float64Array
}

export interface CaptureInit {
  frames: CaptureFrames
  events: CaptureEvents
  mode: 'frames' | 'until'
  truncated: boolean
  /** The flight recorder's slow frame. */
  trigger: { frame: number; frameMs: number } | undefined
  /** The flight recorder gave up waiting for a slow frame. */
  timedOut: boolean
}

export interface Stats {
  p50: number
  p95: number
  max: number
}

/** One span over a capture (or a window of aggregates): per-frame p50/p95/max over frames it ran in. */
export interface SpanStats {
  span: string
  track: TrackName
  calls: number
  /** Total ms over the capture. */
  total: number
  p50: number
  p95: number
  max: number
}

export interface HeapStats {
  usedBytes: number
  totalBytes?: number
  limitBytes?: number
  /** Where it came from: `v8`, `measureUserAgentSpecificMemory`, `performance.memory`. */
  source: string
}

/** A function the sampling profiler saw most, by self time. */
export interface HotFunction {
  name: string
  url?: string
  line?: number
  selfMs: number
  /** Of every sample, 0–1. */
  share: number
}

export interface CaptureWarning {
  code: string
  message: string
  hint?: string
}

export interface CaptureSummary {
  frames: { count: number; cpu: Stats; gpu?: Stats; interval: Stats }
  clock: { resolutionMs: number; isolated: boolean; gpuQuantized: boolean }
  /** The 20 spans with the most time, `frame` and `gpu:frame` aside (those are `frames`). */
  top: SpanStats[]
  /** The 5 slowest frames, each with the spans most above their median in it. */
  worst: {
    frame: number
    cpuMs: number
    gpuMs?: number
    over: { span: string; ms: number; medianMs: number }[]
  }[]
  memory: { gpu: { bytes: number; byCategory: Record<string, number> }; heap?: HeapStats }
  truncated: boolean
  capture: {
    mode: 'frames' | 'until'
    /** First and last frame captured. */
    range: [number, number] | null
    trigger?: { frame: number; frameMs: number }
    timedOut?: true
  }
  /** The sampling profiler's hottest functions, when the capture sampled. */
  hottest?: HotFunction[]
  warnings: CaptureWarning[]
}

export interface SummaryExtras {
  clock: { resolutionMs: number; isolated: boolean; gpuQuantized: boolean }
  memory?: CaptureSummary['memory']
  hottest?: HotFunction[]
  warnings?: CaptureWarning[]
}

/** A sampled stretch of JavaScript for the trace's samples track. */
export interface TraceSample {
  name: string
  start: number
  ms: number
}

export interface TraceEvent {
  name: string
  cat?: string
  ph: 'X' | 'b' | 'e' | 'M' | 'i'
  ts?: number
  dur?: number
  pid: number
  tid: number
  id?: string
  s?: 'g' | 'p' | 't'
  args?: Record<string, unknown>
}

/** Chrome Trace Event JSON: Perfetto and `chrome://tracing` open it. */
export interface ChromeTrace {
  traceEvents: TraceEvent[]
  displayTimeUnit: 'ms'
  otherData: Record<string, unknown>
}

const EPSILON = 1e-3
const SAMPLES_TID = 255
const r3 = (ms: number) => Math.round(ms * 1000) / 1000

function percentileOf(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}

function statsOf(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: r3(percentileOf(sorted, 0.5)),
    p95: r3(percentileOf(sorted, 0.95)),
    max: r3(sorted[sorted.length - 1] ?? 0),
  }
}

function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort()
  return percentileOf(sorted, 0.5)
}

/** Tracks whose spans nest (one thread each): main, GPU and workers. Async and GC spans overlap. */
const nests = (track: number) => track !== TRACK.async && track !== TRACK.gc

function threadName(track: number): string {
  if (track === TRACK.main) return 'main'
  if (track === TRACK.gpu) return 'gpu (approximate: placed at submit)'
  if (track === TRACK.async) return 'async'
  if (track === TRACK.gc) return 'gc'
  return `worker ${track - TRACK.worker}`
}

export class Capture {
  readonly mode: 'frames' | 'until'
  readonly truncated: boolean
  readonly trigger: { frame: number; frameMs: number } | undefined
  readonly timedOut: boolean
  readonly frames: CaptureFrames
  readonly events: CaptureEvents
  /** The frame (index into `frames`) each event belongs to, or -1 outside the window. */
  readonly frameOf: Int32Array
  /** The event each event nests in on its track, or -1. */
  readonly parent: Int32Array
  /** Each event's own time: its duration less the events nested directly in it. */
  readonly self: Float64Array

  constructor(init: CaptureInit) {
    this.mode = init.mode
    this.truncated = init.truncated
    this.trigger = init.trigger
    this.timedOut = init.timedOut
    this.frames = init.frames
    this.events = init.events
    const n = init.events.ids.length
    this.frameOf = new Int32Array(n)
    this.parent = new Int32Array(n).fill(-1)
    this.self = Float64Array.from(init.events.durations)
    this.attribute()
    this.nest()
  }

  get frameCount(): number {
    return this.frames.numbers.length
  }

  get eventCount(): number {
    return this.events.ids.length
  }

  /**
   * When frame `k` ends: the next one's start. The last frame lasts as long as its CPU time, or the
   * interval before it if that's longer, so GPU spans placed from its submit time stay in it.
   */
  frameEnd(k: number): number {
    const f = this.frames
    if (k + 1 < f.starts.length) return f.starts[k + 1]!
    const interval = k > 0 ? f.starts[k]! - f.starts[k - 1]! : 0
    return f.starts[k]! + Math.max(f.cpu[k] || 0, interval)
  }

  /**
   * Time `key` covers in each frame (0075's budget keys): every span the key covers
   * (`spanCovers`), with time covered twice counted once: a covered span nested in another covered
   * span adds nothing.
   */
  spanTime(key: string): Float64Array {
    const out = new Float64Array(this.frameCount)
    const covered = new Uint8Array(this.eventCount)
    const cache = new Map<number, boolean>()
    const covers = (id: number) => {
      let c = cache.get(id)
      if (c === undefined) {
        c = spanCovers(key, spanName(id))
        cache.set(id, c)
      }
      return c
    }
    const { ids, durations } = this.events
    for (let e = 0; e < this.eventCount; e++) covered[e] = covers(ids[e]!) ? 1 : 0
    for (let e = 0; e < this.eventCount; e++) {
      const f = this.frameOf[e]!
      if (f < 0 || !covered[e]) continue
      let p = this.parent[e]!
      let inside = false
      while (p >= 0) {
        if (covered[p]) {
          inside = true
          break
        }
        p = this.parent[p]!
      }
      if (!inside) out[f] = out[f]! + durations[e]!
    }
    return out
  }

  /** The summary (0074): frame stats, the top spans, and the worst frames with what grew in them. */
  summary(extras: SummaryExtras): CaptureSummary {
    const F = this.frameCount
    const { ids, tracks, durations } = this.events
    const totals = new Map<number, Float64Array>()
    const selfs = new Map<number, Float64Array>()
    const ran = new Map<number, Uint8Array>()
    const calls = new Map<number, number>()
    const trackOf = new Map<number, number>()
    for (let e = 0; e < this.eventCount; e++) {
      const f = this.frameOf[e]!
      if (f < 0) continue
      const id = ids[e]!
      let total = totals.get(id)
      if (!total) {
        total = new Float64Array(F)
        totals.set(id, total)
        selfs.set(id, new Float64Array(F))
        ran.set(id, new Uint8Array(F))
        trackOf.set(id, tracks[e]!)
      }
      total[f] = total[f]! + durations[e]!
      const self = selfs.get(id)!
      self[f] = self[f]! + this.self[e]!
      ran.get(id)![f] = 1
      calls.set(id, (calls.get(id) ?? 0) + 1)
    }
    const nameOf = new Map([...totals.keys()].map((id) => [id, spanName(id)]))
    const excluded = (id: number) => nameOf.get(id) === 'frame' || nameOf.get(id) === 'gpu:frame'

    const cpu: number[] = []
    for (let k = 0; k < F; k++)
      if (!Number.isNaN(this.frames.cpu[k]!)) cpu.push(this.frames.cpu[k]!)
    const interval: number[] = []
    for (let k = 1; k < F; k++) interval.push(this.frames.starts[k]! - this.frames.starts[k - 1]!)
    let gpuFrame: Float64Array | undefined
    let gpuRan: Uint8Array | undefined
    for (const [id, name] of nameOf) {
      if (name === 'gpu:frame') {
        gpuFrame = totals.get(id)
        gpuRan = ran.get(id)
      }
    }
    const gpu: number[] = []
    if (gpuFrame && gpuRan) for (let k = 0; k < F; k++) if (gpuRan[k]) gpu.push(gpuFrame[k]!)

    const top: SpanStats[] = []
    for (const [id, total] of totals) {
      if (excluded(id)) continue
      const r = ran.get(id)!
      const perFrame: number[] = []
      let sum = 0
      for (let k = 0; k < F; k++) {
        sum += total[k]!
        if (r[k]) perFrame.push(total[k]!)
      }
      top.push({
        span: nameOf.get(id)!,
        track: trackName(trackOf.get(id)!),
        calls: calls.get(id)!,
        total: r3(sum),
        ...statsOf(perFrame),
      })
    }
    top.sort((a, b) => b.total - a.total || (a.span < b.span ? -1 : 1))
    top.length = Math.min(top.length, 20)

    const medianSelf = new Map<number, number>()
    const medianTotal = new Map<number, number>()
    for (const [id, total] of totals) {
      medianSelf.set(id, median(selfs.get(id)!))
      medianTotal.set(id, median(total))
    }
    const order: number[] = []
    for (let k = 0; k < F; k++) if (!Number.isNaN(this.frames.cpu[k]!)) order.push(k)
    order.sort((a, b) => this.frames.cpu[b]! - this.frames.cpu[a]! || a - b)
    const worst = order.slice(0, 5).map((k) => {
      const over: { span: string; ms: number; medianMs: number; excess: number }[] = []
      for (const [id, self] of selfs) {
        if (excluded(id)) continue
        const excess = self[k]! - medianSelf.get(id)!
        if (excess <= 0.01) continue
        over.push({
          span: nameOf.get(id)!,
          ms: r3(totals.get(id)![k]!),
          medianMs: r3(medianTotal.get(id)!),
          excess,
        })
      }
      over.sort((a, b) => b.excess - a.excess || (a.span < b.span ? -1 : 1))
      const entry: CaptureSummary['worst'][number] = {
        frame: this.frames.numbers[k]!,
        cpuMs: r3(this.frames.cpu[k]!),
        over: over.slice(0, 5).map(({ span, ms, medianMs }) => ({ span, ms, medianMs })),
      }
      if (gpuFrame && gpuRan?.[k]) entry.gpuMs = r3(gpuFrame[k]!)
      return entry
    })

    const warnings = [...(extras.warnings ?? [])]
    const warn = (error: ShardError) => warnings.push(error.toJSON())
    if (!extras.clock.isolated) {
      warn(
        new ShardError(
          'perf/clock-coarse',
          `The page isn't cross-origin isolated: its clock steps ${extras.clock.resolutionMs} ms, so short spans read as 0 or one step`,
          {
            hint: 'Serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless (shard dev and the playground do).',
          },
        ),
      )
    }
    if (this.truncated) {
      warn(
        new ShardError(
          'perf/capture-truncated',
          'The event buffer filled: the capture stopped early',
          {
            hint: 'Capture fewer frames, or pass a larger "events".',
          },
        ),
      )
    }
    if (this.timedOut) {
      warn(
        new ShardError(
          'perf/no-slow-frame',
          'No frame went over the flight recorder\'s "frameMs" before it timed out',
          { hint: 'Lower "until.frameMs", or raise "timeout".' },
        ),
      )
    }
    const summary: CaptureSummary = {
      frames: {
        count: F,
        cpu: statsOf(cpu),
        interval: statsOf(interval),
      },
      clock: extras.clock,
      top,
      worst,
      memory: extras.memory ?? { gpu: { bytes: 0, byCategory: {} } },
      truncated: this.truncated,
      capture: {
        mode: this.mode,
        range: F > 0 ? [this.frames.numbers[0]!, this.frames.numbers[F - 1]!] : null,
      },
      warnings,
    }
    if (gpu.length > 0) summary.frames.gpu = statsOf(gpu)
    if (this.trigger) summary.capture.trigger = this.trigger
    if (this.timedOut) summary.capture.timedOut = true
    if (extras.hottest) summary.hottest = extras.hottest
    return summary
  }

  /**
   * Chrome Trace Event JSON: an `X` event per span, `b`/`e` pairs for async spans, a thread per
   * track, and the frame in each event's `args`. Times are µs from the first frame's start.
   */
  trace(
    extras: { samples?: readonly TraceSample[]; otherData?: Record<string, unknown> } = {},
  ): ChromeTrace {
    const { ids, tracks, starts, durations } = this.events
    const origin = this.frameCount > 0 ? this.frames.starts[0]! : 0
    const us = (ms: number) => Math.round((ms - origin) * 1e6) / 1000
    const dus = (ms: number) => Math.round(ms * 1e6) / 1000
    const order: number[] = []
    const used = new Set<number>()
    for (let e = 0; e < this.eventCount; e++) {
      if (this.frameOf[e]! < 0) continue
      order.push(e)
      used.add(tracks[e]!)
    }
    order.sort(
      (a, b) =>
        tracks[a]! - tracks[b]! ||
        starts[a]! - starts[b]! ||
        durations[b]! - durations[a]! ||
        a - b,
    )
    const events: TraceEvent[] = [
      { name: 'process_name', ph: 'M', pid: 1, tid: 0, args: { name: 'Shard' } },
    ]
    const threads = [...used].sort((a, b) => a - b)
    if (extras.samples?.length) threads.push(SAMPLES_TID - 1)
    for (const track of threads) {
      const tid = track + 1
      const name = tid === SAMPLES_TID ? 'js samples' : threadName(track)
      events.push({ name: 'thread_name', ph: 'M', pid: 1, tid, args: { name } })
      events.push({ name: 'thread_sort_index', ph: 'M', pid: 1, tid, args: { sort_index: tid } })
    }
    for (const e of order) {
      const track = tracks[e]!
      const name = spanName(ids[e]!)
      const frame = this.frames.numbers[this.frameOf[e]!]!
      const cat = trackName(track)
      if (track === TRACK.async) {
        const id = `0x${e.toString(16)}`
        events.push({
          name,
          cat,
          ph: 'b',
          ts: us(starts[e]!),
          pid: 1,
          tid: track + 1,
          id,
          args: { frame },
        })
        events.push({
          name,
          cat,
          ph: 'e',
          ts: us(starts[e]! + durations[e]!),
          pid: 1,
          tid: track + 1,
          id,
          args: { frame },
        })
        continue
      }
      events.push({
        name,
        cat,
        ph: 'X',
        ts: us(starts[e]!),
        dur: dus(durations[e]!),
        pid: 1,
        tid: track + 1,
        args: { frame },
      })
    }
    for (const s of extras.samples ?? []) {
      events.push({
        name: s.name,
        cat: 'samples',
        ph: 'X',
        ts: us(s.start),
        dur: dus(s.ms),
        pid: 1,
        tid: SAMPLES_TID,
      })
    }
    return {
      traceEvents: events,
      displayTimeUnit: 'ms',
      otherData: {
        producer: 'shard profiler (0074)',
        gpuTrack:
          "Approximate: WebGPU's clock isn't the CPU's, so each frame's GPU passes are placed from its submit time.",
        frames:
          this.frameCount > 0
            ? [this.frames.numbers[0], this.frames.numbers[this.frameCount - 1]]
            : [],
        ...extras.otherData,
      },
    }
  }

  // --- internals ---------------------------------------------------------------

  /** Each event's frame: the last frame that started at or before it, within the window. */
  private attribute(): void {
    const starts = this.frames.starts
    const F = starts.length
    const lastEnd = F > 0 ? this.frameEnd(F - 1) : 0
    const evStarts = this.events.starts
    for (let e = 0; e < this.eventCount; e++) {
      const t = evStarts[e]!
      if (F === 0 || t < starts[0]! - EPSILON || t > lastEnd + EPSILON) {
        this.frameOf[e] = -1
        continue
      }
      let lo = 0
      let hi = F - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid]! <= t + EPSILON) lo = mid
        else hi = mid - 1
      }
      this.frameOf[e] = lo
    }
  }

  /** Nesting by containment on each track that nests, and each event's self time. */
  private nest(): void {
    const { tracks, starts, durations, depths } = this.events
    const order: number[] = []
    for (let e = 0; e < this.eventCount; e++) if (nests(tracks[e]!)) order.push(e)
    order.sort(
      (a, b) =>
        tracks[a]! - tracks[b]! ||
        starts[a]! - starts[b]! ||
        durations[b]! - durations[a]! ||
        depths[a]! - depths[b]! ||
        a - b,
    )
    const stack: number[] = []
    let track = -1
    for (const e of order) {
      if (tracks[e]! !== track) {
        track = tracks[e]!
        stack.length = 0
      }
      const start = starts[e]!
      const end = start + durations[e]!
      while (stack.length > 0) {
        const p = stack[stack.length - 1]!
        if (start >= starts[p]! - EPSILON && end <= starts[p]! + durations[p]! + EPSILON) break
        stack.pop()
      }
      if (stack.length > 0) {
        const p = stack[stack.length - 1]!
        this.parent[e] = p
        this.self[p] = this.self[p]! - durations[e]!
      }
      stack.push(e)
    }
    for (let e = 0; e < this.eventCount; e++) if (this.self[e]! < 0) this.self[e] = 0
  }
}
