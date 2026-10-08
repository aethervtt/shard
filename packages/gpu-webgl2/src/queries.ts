import type { Webgl2Device } from './device'
import type { Webgl2Buffer } from './resources'

// Timestamps on WebGL2 (0074), where EXT_disjoint_timer_query_webgl2 exists. WebGL2 has no
// timestamps worth having, but it can time a span: a pass's `timestampWrites` becomes a
// TIME_ELAPSED query around the pass (passes don't overlap, so queries don't nest). Results arrive
// frames later, as WebGPU readbacks do: `resolveQuerySet` leaves the queries on the destination
// buffer, copies carry them along, and mapping the buffer waits for them and writes them in. A
// pair's begin and end are written back to back, pass after pass, on one timeline that continues
// across frames (`device.timerAt`, from 1 ns) as a GPU clock does, so GpuTimer's "end − begin" is
// each pass's elapsed time, the frame's first-to-last span is their sum, and a later frame's
// stamps are never mistaken for an earlier frame's left over in its slots. A
// disjoint operation (GPU_DISJOINT_EXT) makes the results meaningless: they're written as zeros,
// which GpuTimer skips.

export const TIME_ELAPSED_EXT = 0x88bf
export const GPU_DISJOINT_EXT = 0x8fbb
const QUERY_RESULT = 0x8866
const QUERY_RESULT_AVAILABLE = 0x8867
/** How long a map waits for query results before giving up on them (they read as zeros). */
const WAIT_MS = 2000

/** Queries resolved into a buffer, waiting for results: pair k's begin/end at `offset + 16k`. */
export interface QueryRead {
  offset: number
  queries: (WebGLQuery | null)[]
}

export class Webgl2QuerySet {
  readonly type: GPUQueryType = 'timestamp'
  readonly count: number
  label: string
  /** The query recording each pair this frame (one per pass), until resolved. */
  private readonly pairs: (WebGLQuery | null)[]
  private readonly device: Webgl2Device
  private destroyed = false

  constructor(device: Webgl2Device, descriptor: GPUQuerySetDescriptor) {
    this.device = device
    this.count = descriptor.count
    this.label = descriptor.label ?? ''
    this.pairs = new Array(Math.ceil(descriptor.count / 2)).fill(null)
  }

  /** @internal Replay: starts timing pair `pair` (a pass with timestamp writes begins). */
  begin(pair: number): void {
    if (this.destroyed) return
    const query = this.device.queries.take()
    if (!query) return
    this.device.gl.beginQuery(TIME_ELAPSED_EXT, query)
    this.pairs[pair] = query
  }

  /** @internal Replay: the timed pass ended. */
  end(): void {
    this.device.gl.endQuery(TIME_ELAPSED_EXT)
  }

  /** @internal Replay: hands queries `first` to `first + count` to `buffer` at `offset`. */
  resolve(first: number, count: number, buffer: Webgl2Buffer, offset: number): void {
    const from = first >> 1
    const to = (first + count + 1) >> 1
    const queries: (WebGLQuery | null)[] = []
    for (let p = from; p < to; p++) {
      queries.push(this.pairs[p] ?? null)
      this.pairs[p] = null
    }
    buffer.queryReads.push({ offset, queries })
  }

  destroy(): void {
    this.destroyed = true
    for (let p = 0; p < this.pairs.length; p++) {
      const q = this.pairs[p]
      if (q) this.device.queries.give(q)
      this.pairs[p] = null
    }
  }
}

/** Query objects, reused: a frame times a few dozen passes, every frame. */
export class QueryPool {
  private readonly free: WebGLQuery[] = []
  private readonly gl: WebGL2RenderingContext

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  take(): WebGLQuery | null {
    return this.free.pop() ?? this.gl.createQuery()
  }

  give(query: WebGLQuery): void {
    this.free.push(query)
  }

  /** Forgets the pool (the context was lost: its queries went with it). */
  clear(): void {
    this.free.length = 0
  }
}

const waitTick = () => new Promise<void>((resolve) => setTimeout(resolve, 4))

/**
 * Waits for `buffer`'s pending query results and writes them into `bytes` (the mapped range, which
 * starts at `mapOffset`), then returns the queries to the pool.
 */
export async function finishQueryReads(
  device: Webgl2Device,
  buffer: Webgl2Buffer,
  bytes: Uint8Array,
  mapOffset: number,
): Promise<void> {
  const reads = buffer.queryReads.splice(0)
  if (reads.length === 0) return
  const gl = device.gl
  const deadline = performance.now() + WAIT_MS
  const ready = () =>
    reads.every((r) =>
      r.queries.every((q) => !q || gl.getQueryParameter(q, QUERY_RESULT_AVAILABLE) === true),
    )
  while (!device.isLost && !ready() && performance.now() < deadline) await waitTick()
  const lost = device.isLost
  const disjoint = !lost && gl.getParameter(GPU_DISJOINT_EXT) === true
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (const read of reads) {
    let at = device.timerAt
    for (let k = 0; k < read.queries.length; k++) {
      const q = read.queries[k]
      const pos = read.offset - mapOffset + k * 16
      let begin = 0n
      let end = 0n
      if (q && !lost && !disjoint && gl.getQueryParameter(q, QUERY_RESULT_AVAILABLE) === true) {
        const elapsed = BigInt(gl.getQueryParameter(q, QUERY_RESULT) as number)
        begin = at
        end = at + elapsed
        at = end
        device.timerAt = end
      }
      if (pos >= 0 && pos + 16 <= bytes.byteLength) {
        view.setBigUint64(pos, begin, true)
        view.setBigUint64(pos + 8, end, true)
      }
      if (q && !lost) device.queries.give(q)
    }
  }
}
