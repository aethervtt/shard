import { ProfilerResource, type World } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'

const MAX_PASSES = 96
/** Stamps this much older than a frame's last pass end are left over from an earlier frame. */
const STALE_NS = 1_000_000_000n

/** Pass groups timed as one span (see readback). */
const SPANS: readonly (readonly [string, (name: string) => boolean])[] = [
  ['gpu:span/post', (n) => n.startsWith('post/') || n === 'tonemap'],
  ['gpu:span/ssao', (n) => n === 'ssao' || n.startsWith('ssao/')],
]
const READBACK_BUFFERS = 3

interface Readback {
  buffer: GPUBuffer
  busy: boolean
  names: string[]
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

  /** Call after submit. Records timings when the copy lands. */
  readback(world: World): void {
    const target = this.pendingCopy
    if (!target) return
    this.pendingCopy = undefined
    const generation = this.generation
    target.buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        if (generation !== this.gpu.generation) return
        const times = new BigUint64Array(target.buffer.getMappedRange())
        const profiler = world.tryResource(ProfilerResource)
        const totals = new Map<string, number>()
        // Tile-based GPUs skip empty passes, stamps included: their slots keep an old frame's
        // values. Anything that began over a second before the frame's last end is such a slot.
        let latest = 0n
        for (let i = 0; i < target.names.length; i++) {
          const end = times[i * 2 + 1]!
          if (end > latest) latest = end
        }
        const stale = latest - STALE_NS
        let first = 0n
        let last = 0n
        for (let i = 0; i < target.names.length; i++) {
          const begin = times[i * 2]!
          const end = times[i * 2 + 1]!
          // Some backends leave a pass's stamps at zero (or out of order) on its first frames.
          if (begin === 0n || end < begin || begin < stale) continue
          const name = target.names[i]!
          totals.set(name, (totals.get(name) ?? 0) + Number(end - begin) / 1e6)
          if (first === 0n || begin < first) first = begin
          if (end > last) last = end
        }
        for (const [name, ms] of totals) profiler?.record(`gpu:${name}`, ms)
        // Spans of pass groups, for the same reason: post-processing from its first pass to the
        // tonemap (and FXAA), and SSAO's passes.
        for (let g = 0; g < SPANS.length; g++) {
          const [label, match] = SPANS[g]!
          let a = 0n
          let b = 0n
          for (let i = 0; i < target.names.length; i++) {
            const begin = times[i * 2]!
            const end = times[i * 2 + 1]!
            if (begin === 0n || end < begin || begin < stale || !match(target.names[i]!)) continue
            if (a === 0n || begin < a) a = begin
            if (end > b) b = end
          }
          if (b > a) profiler?.record(label, Number(b - a) / 1e6)
        }
        // The whole frame, first pass start to last pass end: reliable even where passes overlap
        // (tile-based GPUs), which makes per-pass times add up to more than the frame.
        if (last > first) {
          this.frameMs = Number(last - first) / 1e6
          this.frameSamples++
          profiler?.record('gpu:frame', this.frameMs)
        }
        target.buffer.unmap()
        target.busy = false
      },
      () => {
        target.busy = false
      },
    )
  }
}
