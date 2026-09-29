/**
 * Timestamped samples in a fixed ring: pushing never allocates, so a frame can record into it. The
 * oldest samples fall off once it's full.
 */
export class SampleRing {
  private readonly times: Float64Array
  private readonly values: Float64Array
  private next = 0
  private count = 0

  constructor(capacity: number) {
    this.times = new Float64Array(capacity)
    this.values = new Float64Array(capacity)
  }

  get size(): number {
    return this.count
  }

  push(time: number, value: number): void {
    this.times[this.next] = time
    this.values[this.next] = value
    this.next = (this.next + 1) % this.times.length
    if (this.count < this.times.length) this.count++
  }

  clear(): void {
    this.next = 0
    this.count = 0
  }

  /** The values of samples at or after `since`, oldest first. Allocates: not for frames. */
  since(since: number): Float64Array {
    const capacity = this.times.length
    const start = (this.next - this.count + capacity) % capacity
    const out: number[] = []
    for (let i = 0; i < this.count; i++) {
      const at = (start + i) % capacity
      if (this.times[at]! >= since) out.push(this.values[at]!)
    }
    return Float64Array.from(out)
  }
}

/** Nearest-rank percentile (`p` in 0..1) of `values`, which it sorts in place. 0 when empty. */
export function percentile(values: Float64Array, p: number): number {
  if (values.length === 0) return 0
  values.sort()
  const rank = Math.max(1, Math.ceil(p * values.length))
  return values[rank - 1]!
}

/** p50, p95 and p99 of `values` (sorted in place). */
export function distribution(values: Float64Array): { p50: number; p95: number; p99: number } {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  }
}

/** Rounds to 0.01: records stay readable, and the rounding is far below any budget. */
export function round(value: number): number {
  return Math.round(value * 100) / 100
}
