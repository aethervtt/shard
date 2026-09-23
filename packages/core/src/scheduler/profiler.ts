import { defineResource } from '../schema/resource'

export interface SystemTiming {
  /** Most recent run, in ms. */
  last: number
  /** Mean over the window, in ms. */
  avg: number
  max: number
  /** Number of samples in the window. */
  samples: number
}

interface Series {
  readonly samples: Float64Array
  cursor: number
  count: number
}

/** Per-system CPU time over the last `window` runs, in a ring buffer. */
export class Profiler {
  readonly window: number
  private readonly series = new Map<string, Series>()

  constructor(window = 120) {
    this.window = window
  }

  record(name: string, ms: number): void {
    let series = this.series.get(name)
    if (!series) {
      series = { samples: new Float64Array(this.window), cursor: 0, count: 0 }
      this.series.set(name, series)
    }
    series.samples[series.cursor] = ms
    series.cursor = (series.cursor + 1) % this.window
    if (series.count < this.window) series.count++
  }

  timing(name: string): SystemTiming | undefined {
    const series = this.series.get(name)
    if (!series || series.count === 0) return undefined
    let sum = 0
    let max = 0
    for (let i = 0; i < series.count; i++) {
      const v = series.samples[i]!
      sum += v
      if (v > max) max = v
    }
    const last = series.samples[(series.cursor - 1 + this.window) % this.window]!
    return { last, avg: sum / series.count, max, samples: series.count }
  }

  all(): Record<string, SystemTiming> {
    const out: Record<string, SystemTiming> = {}
    for (const name of this.series.keys()) out[name] = this.timing(name)!
    return out
  }
}

export const ProfilerResource = defineResource<Profiler>('core/Profiler', {
  description: 'Per-system CPU timings over recent frames.',
  init: () => new Profiler(),
})
