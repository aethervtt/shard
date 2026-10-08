import { ShardError } from '../../error'
import { type Profiler, type ProfilerSink, spanName as spanNameOf, TRACK } from '../profiler'
import { Capture } from './capture'

export interface CaptureOptions {
  /** Captures the next N frames. Default 300 when `until` isn't given. */
  frames?: number
  /**
   * The flight recorder: keeps a rolling window and stops `after` frames past the first frame whose
   * CPU time is over `frameMs`.
   */
  until?: { frameMs: number }
  /** Frames the flight recorder keeps before the slow one. Default 120. */
  before?: number
  /** Frames it records after the slow one. Default 30. */
  after?: number
  /** Seconds the flight recorder waits for a slow frame before giving up. Default 60. */
  timeout?: number
  /** Event buffer size: 16 bytes an event. Default 2²⁰ (16 MB). */
  events?: number
  /**
   * Also hands each span to this as it's recorded, e.g. `performance.measure` with DevTools track
   * data. It allocates: off unless asked for.
   */
  devtools?: (name: string, track: number, start: number, ms: number) => void
}

const WAITING = 0
const RECORDING = 1
const DRAINING = 2
const DONE = 3
/** Frames a capture keeps listening for the GPU timings of its last frames, which land late. */
const GPU_DRAIN_FRAMES = 4
const DEFAULT_EVENTS = 1 << 20

/**
 * A running capture (0074): the profiler's sink while it records. Events go into one preallocated
 * buffer of 16-byte records (start f64, duration f32, span id u16, track u8, depth u8), so recording
 * allocates nothing once it started.
 */
export class CaptureRecorder implements ProfilerSink {
  readonly mode: 'frames' | 'until'
  readonly capacity: number
  /** Resolves once the capture has every frame it wanted (or gave up waiting). */
  readonly done: Promise<Capture>
  private readonly profiler: Profiler
  private readonly starts: Float64Array
  private readonly durations: Float32Array
  private readonly ids: Uint16Array
  private readonly bytes: Uint8Array
  private cursor = 0
  private written = 0
  private readonly frameCap: number
  private readonly frameNumbers: Float64Array
  private readonly frameStarts: Float64Array
  private readonly frameCpu: Float64Array
  private readonly frameFirst: Float64Array
  private frameCount = 0
  private state = WAITING
  private readonly frames: number
  private readonly untilMs: number
  private readonly after: number
  private readonly timeoutMs: number
  private startedAt = Number.NaN
  private trigger = -1
  private triggerMs = 0
  private afterLeft = 0
  private drainLeft = 0
  private gpuSeen = false
  private firstNumber = Number.POSITIVE_INFINITY
  private lastNumber = Number.NEGATIVE_INFINITY
  private timedOut = false
  private truncatedFlag = false
  private stopping = false
  private readonly devtools: CaptureOptions['devtools']
  private resolveDone!: (capture: Capture) => void

  constructor(profiler: Profiler, options: CaptureOptions = {}) {
    this.profiler = profiler
    this.mode = options.until ? 'until' : 'frames'
    this.capacity = Math.max(16, options.events ?? DEFAULT_EVENTS)
    const buffer = new ArrayBuffer(this.capacity * 16)
    this.starts = new Float64Array(buffer)
    this.durations = new Float32Array(buffer)
    this.ids = new Uint16Array(buffer)
    this.bytes = new Uint8Array(buffer)
    this.frames = Math.max(1, options.frames ?? 300)
    this.untilMs = options.until?.frameMs ?? Number.POSITIVE_INFINITY
    const before = Math.max(0, options.before ?? 120)
    this.after = Math.max(0, options.after ?? 30)
    this.timeoutMs = (options.timeout ?? 60) * 1000
    this.frameCap = this.mode === 'frames' ? this.frames : before + 1 + this.after
    this.frameNumbers = new Float64Array(this.frameCap)
    this.frameStarts = new Float64Array(this.frameCap)
    this.frameCpu = new Float64Array(this.frameCap)
    this.frameFirst = new Float64Array(this.frameCap)
    this.devtools = options.devtools
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })
  }

  /** Starts listening: from the next frame on. Throws `perf/capture-running` if one already is. */
  start(): this {
    if (this.profiler.sink !== undefined) {
      throw new ShardError('perf/capture-running', 'A capture is already running on this app', {
        hint: 'Wait for it to finish (perf.capture resolves when it does), then capture again.',
      })
    }
    if (!this.profiler.enabled) {
      throw new ShardError('perf/disabled', 'The profiler is off (ProfilerSettings.enabled)', {
        hint: 'Turn it on with resource.set core/ProfilerSettings { enabled: true }.',
      })
    }
    this.profiler.sink = this
    this.startedAt = this.profiler.now()
    return this
  }

  /** Ends the capture now with what it has. */
  stop(): void {
    if (this.state === DONE) return
    this.finish()
  }

  get running(): boolean {
    return this.state !== DONE
  }

  // --- the sink ----------------------------------------------------------------

  event(id: number, track: number, depth: number, start: number, ms: number, frame: number): void {
    const state = this.state
    if (state !== RECORDING && (state !== DRAINING || track !== TRACK.gpu)) return
    // Late timings (GPU) of frames from before the capture, or after it while draining.
    if (frame >= 0 && (frame < this.firstNumber || (state === DRAINING && frame > this.lastNumber)))
      return
    if (this.mode === 'frames' && this.written >= this.capacity) {
      this.truncatedFlag = true
      this.stopping = true
      return
    }
    const i = this.cursor
    this.starts[i * 2] = start
    this.durations[i * 4 + 2] = ms
    this.ids[i * 8 + 6] = id
    this.bytes[i * 16 + 14] = track
    this.bytes[i * 16 + 15] = depth > 255 ? 255 : depth
    this.cursor = i + 1 === this.capacity ? 0 : i + 1
    this.written++
    if (track === TRACK.gpu) this.gpuSeen = true
    if (this.devtools !== undefined) this.devtools(spanNameOf(id), track, start, ms)
  }

  frameStart(frame: number, at: number): void {
    if (this.state === WAITING) {
      this.state = RECORDING
      this.firstNumber = frame
    }
    if (this.state !== RECORDING) return
    const slot = this.frameCount % this.frameCap
    this.frameNumbers[slot] = frame
    this.frameStarts[slot] = at
    this.frameCpu[slot] = Number.NaN
    this.frameFirst[slot] = this.written
  }

  frameEnd(_frame: number, ms: number): void {
    if (this.state === DRAINING) {
      if (--this.drainLeft <= 0) this.complete()
      return
    }
    if (this.state !== RECORDING) return
    this.frameCpu[this.frameCount % this.frameCap] = ms
    this.frameCount++
    if (this.stopping) {
      this.finish()
      return
    }
    if (this.mode === 'frames') {
      if (this.frameCount >= this.frames) this.finish()
      return
    }
    if (this.trigger < 0) {
      if (ms > this.untilMs) {
        this.trigger = this.frameNumbers[(this.frameCount - 1) % this.frameCap]!
        this.triggerMs = ms
        this.afterLeft = this.after
        if (this.afterLeft === 0) this.finish()
      } else if (this.profiler.now() - this.startedAt > this.timeoutMs) {
        this.timedOut = true
        this.finish()
      }
      return
    }
    if (--this.afterLeft <= 0) this.finish()
  }

  // --- finishing ---------------------------------------------------------------

  private finish(): void {
    if (this.frameCount > 0)
      this.lastNumber = this.frameNumbers[(this.frameCount - 1) % this.frameCap]!
    if (this.gpuSeen && this.state === RECORDING) {
      this.state = DRAINING
      this.drainLeft = GPU_DRAIN_FRAMES
      return
    }
    this.complete()
  }

  private complete(): void {
    if (this.state === DONE) return
    this.state = DONE
    if (this.profiler.sink === this) this.profiler.sink = undefined
    this.resolveDone(this.result())
  }

  /** The recorded frames and events, in order. */
  private result(): Capture {
    const frames = Math.min(this.frameCount, this.frameCap)
    const firstFrame = this.frameCount - frames
    // The oldest event still in the buffer; frames whose events were overwritten drop out.
    const oldest = Math.max(0, this.written - this.capacity)
    let skip = 0
    while (skip < frames && this.frameFirst[(firstFrame + skip) % this.frameCap]! < oldest) skip++
    const kept = frames - skip
    const frameNumbers = new Float64Array(kept)
    const frameStarts = new Float64Array(kept)
    const frameCpu = new Float64Array(kept)
    for (let k = 0; k < kept; k++) {
      const slot = (firstFrame + skip + k) % this.frameCap
      frameNumbers[k] = this.frameNumbers[slot]!
      frameStarts[k] = this.frameStarts[slot]!
      frameCpu[k] = this.frameCpu[slot]!
    }
    const firstEvent =
      kept > 0 ? this.frameFirst[(firstFrame + skip) % this.frameCap]! : this.written
    const count = this.written - Math.max(firstEvent, oldest)
    const ids = new Uint16Array(count)
    const tracks = new Uint8Array(count)
    const depths = new Uint8Array(count)
    const starts = new Float64Array(count)
    const durations = new Float64Array(count)
    for (let k = 0; k < count; k++) {
      const n = this.written - count + k
      const i = n % this.capacity
      ids[k] = this.ids[i * 8 + 6]!
      tracks[k] = this.bytes[i * 16 + 14]!
      depths[k] = this.bytes[i * 16 + 15]!
      starts[k] = this.starts[i * 2]!
      durations[k] = this.durations[i * 4 + 2]!
    }
    return new Capture({
      frames: { numbers: frameNumbers, starts: frameStarts, cpu: frameCpu },
      events: { ids, tracks, depths, starts, durations },
      mode: this.mode,
      truncated: this.truncatedFlag,
      trigger: this.trigger < 0 ? undefined : { frame: this.trigger, frameMs: this.triggerMs },
      timedOut: this.timedOut,
    })
  }
}

/** Starts a capture on `profiler`: resolves with the capture once it has its frames. */
export function startCapture(profiler: Profiler, options: CaptureOptions = {}): CaptureRecorder {
  return new CaptureRecorder(profiler, options).start()
}
