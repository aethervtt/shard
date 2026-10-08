import { ProfilerResource, TRACK, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'

const MAX_PASSES = 96

/** Pass groups timed as one span (see readback). */
const SPANS: readonly (readonly [string, (name: string) => boolean])[] = [
  ['gpu:span/post', (n) => n.startsWith('post/') || n === 'tonemap'],
  ['gpu:span/ssao', (n) => n === 'ssao' || n.startsWith('ssao/')],
]
const READBACK_BUFFERS = 3
/** Chrome quantizes timestamps to 100 µs unless WebGPU developer features are on. */
const QUANTUM_NS = 100_000n
/** Pass timings seen before deciding the clock is quantized. */
const QUANTIZED_AFTER = 32

interface Readback {
  buffer: GPUBuffer
  busy: boolean
  names: string[]
  /** The frame it timed and when that frame was submitted, on the profiler's clock (0074). */
  frame: number
  submitAt: number
}

/** `gpu:<node>`, made once per node name. */
const gpuNames = new Map<string, string>()
function gpuName(node: string): string {
  let name = gpuNames.get(node)
  if (name === undefined) {
    name = `gpu:${node}`
    gpuNames.set(node, name)
  }
  return name
}

/**
 * Per-pass GPU timings with `timestamp-query`. Each render/compute pass writes begin and end
 * timestamps; results are copied to a small ring of readback buffers and recorded into the profiler
 * as `gpu:<node>` a frame or two later. Without the feature, everything here is a no-op.
 */
export class GpuTimer {
  readonly enabled: boolean
  /** The latest frame's GPU span in ms (first pass start to last pass end), once one landed. */
  frameMs = 0
  /** Frames measured so far: changes when `frameMs` does. */
  frameSamples = 0
  /**
   * Every pass time so far was a whole number of 100 µs: the browser quantizes timestamps
   * (0074's `gpuQuantized`). Decided after a few dozen passes.
   */
  quantized = false
  private passTimes = 0
  private unquantized = false
  /** Each query slot's stamps at the last readback: a slot that still holds them is left over. */
  private readonly lastStamps = new BigUint64Array(MAX_PASSES * 2)
  private querySet: GPUQuerySet | undefined
  private resolveBuffer: GPUBuffer | undefined
  private readonly readbacks: Readback[] = []
  private names: string[] = []
  private generation = -1
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.enabled = gpu.features.has('timestamp-query')
  }

  /** Destroys the query set; buffers are released with the rest of the app's (0052). */
  destroy(): void {
    this.querySet?.destroy()
    this.querySet = undefined
    this.generation = this.gpu.generation
  }

  beginFrame(): void {
    this.names = []
    if (!this.enabled || this.generation === this.gpu.generation) return
    this.generation = this.gpu.generation
    this.lastStamps.fill(0n)
    const device = this.gpu.device
    this.querySet = device.createQuerySet({
      label: 'gpu-timer',
      type: 'timestamp',
      count: MAX_PASSES * 2,
    })
    this.resolveBuffer = device.createBuffer({
      label: 'gpu-timer/resolve',
      size: MAX_PASSES * 2 * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    })
    this.readbacks.length = 0
    for (let i = 0; i < READBACK_BUFFERS; i++) {
      this.readbacks.push({
        buffer: device.createBuffer({
          label: `gpu-timer/readback-${i}`,
          size: MAX_PASSES * 2 * 8,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        busy: false,
        names: [],
        frame: 0,
        submitAt: 0,
      })
    }
  }

  /** Timestamp writes for the next pass, or undefined when timing is off or full. */
  allocate(name: string): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled || !this.querySet || this.names.length >= MAX_PASSES) return undefined
    const i = this.names.length
    this.names.push(name)
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: i * 2,
      endOfPassWriteIndex: i * 2 + 1,
    }
  }

  private pendingCopy: Readback | undefined

  /** Pass `i`'s slot still holds the stamps it had at the last readback: the GPU skipped it. */
  private stale(times: BigUint64Array, i: number): boolean {
    const last = this.lastStamps
    return times[i * 2] === last[i * 2] && times[i * 2 + 1] === last[i * 2 + 1]
  }

  resolve(encoder: GPUCommandEncoder): void {
    this.pendingCopy = undefined
    if (!this.enabled || this.names.length === 0) return
    const target = this.readbacks.find((r) => !r.busy)
    if (!target) return // all readbacks in flight: skip timing this frame
    const count = this.names.length * 2
    encoder.resolveQuerySet(this.querySet!, 0, count, this.resolveBuffer!, 0)
    encoder.copyBufferToBuffer(this.resolveBuffer!, 0, target.buffer, 0, count * 8)
    target.busy = true
    target.names = this.names
    this.pendingCopy = target
  }

  /**
   * Call after submit. Records timings when the copy lands: aggregates per name, and (during a
   * capture) GPU-track spans placed from this frame's submit time, since WebGPU's clock isn't the
   * CPU's (0074).
   */
  readback(world: World): void {
    const profiler = world.tryResource(ProfilerResource)
    if (profiler) profiler.gpu.status = this.enabled ? 'available' : 'unavailable'
    const target = this.pendingCopy
    if (!target) return
    this.pendingCopy = undefined
    target.frame = profiler?.frame ?? 0
    target.submitAt = profiler ? profiler.now() : 0
    const generation = this.generation
    target.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        if (generation !== this.gpu.generation) return
        const times = new BigUint64Array(target.buffer.getMappedRange())
        const totals = new Map<string, number>()
        // Tile-based GPUs skip empty passes, stamps included: their slots keep an old frame's
        // values, so a slot whose stamps are the ones it held at the last readback is such a slot.
        // Compared slot by slot, not against the latest end seen: Dawn's Metal clock steps back
        // by seconds while it calibrates, and a stamp from before the step would hide every later
        // one. (A fixed age, such as a second, also drops real passes on a GPU that slow: a
        // software renderer's frame can take seconds.)
        const count = target.names.length * 2
        let first = 0n
        let lastEnd = 0n
        for (let i = 0; i < target.names.length; i++) {
          const begin = times[i * 2]!
          const end = times[i * 2 + 1]!
          // Some backends leave a pass's stamps at zero (or out of order) on its first frames.
          if (begin === 0n || end < begin || this.stale(times, i)) continue
          const name = target.names[i]!
          totals.set(name, (totals.get(name) ?? 0) + Number(end - begin) / 1e6)
          if (first === 0n || begin < first) first = begin
          if (end > lastEnd) lastEnd = end
          if (end > begin) {
            if ((end - begin) % QUANTUM_NS !== 0n) this.unquantized = true
            this.passTimes++
          }
        }
        if (this.passTimes >= QUANTIZED_AFTER) this.quantized = !this.unquantized
        if (profiler) profiler.gpu.quantized = this.quantized
        for (const [name, ms] of totals) profiler?.sample(gpuName(name), ms)
        // The timeline: each pass where it ran relative to the frame's first, from its submit.
        const at = (stamp: bigint) => target.submitAt + Number(stamp - first) / 1e6
        if (profiler?.capturing && first !== 0n) {
          for (let i = 0; i < target.names.length; i++) {
            const begin = times[i * 2]!
            const end = times[i * 2 + 1]!
            if (begin === 0n || end < begin || this.stale(times, i)) continue
            const ms = Number(end - begin) / 1e6
            profiler.event(gpuName(target.names[i]!), TRACK.gpu, at(begin), ms, target.frame)
          }
        }
        // Spans of pass groups, for the same reason: post-processing from its first pass to the
        // tonemap (and FXAA), and SSAO's passes.
        for (let g = 0; g < SPANS.length; g++) {
          const [label, match] = SPANS[g]!
          let a = 0n
          let b = 0n
          for (let i = 0; i < target.names.length; i++) {
            const begin = times[i * 2]!
            const end = times[i * 2 + 1]!
            if (begin === 0n || end < begin || this.stale(times, i) || !match(target.names[i]!))
              continue
            if (a === 0n || begin < a) a = begin
            if (end > b) b = end
          }
          if (b > a) profiler?.record(label, Number(b - a) / 1e6, TRACK.gpu, at(a), target.frame)
        }
        // The whole frame, first pass start to last pass end: reliable even where passes overlap
        // (tile-based GPUs), which makes per-pass times add up to more than the frame. A frame
        // inside one tick of a coarse clock (WARP's is 65 µs; browsers quantize to 100 µs) is 0 ms,
        // not unmeasured: dropping those would leave only the frames that crossed a tick.
        if (first !== 0n) {
          this.frameMs = Number(lastEnd - first) / 1e6
          this.frameSamples++
          profiler?.record('gpu:frame', this.frameMs, TRACK.gpu, target.submitAt, target.frame)
        }
        for (let k = 0; k < count; k++) this.lastStamps[k] = times[k]!
        target.buffer.unmap()
        target.busy = false
      },
      () => {
        target.busy = false
      },
    )
  }
}
