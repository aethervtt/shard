/** Refresh rates displays ship with. A measurement within 4% of one snaps to it. */
export const COMMON_RATES = [24, 30, 48, 50, 60, 72, 75, 85, 90, 100, 120, 144, 165, 180, 240, 360]

/** The nearest common rate within 4%, else the measurement rounded to a whole Hz. */
export function snapRate(hz: number): number {
  let best = Math.round(hz)
  let error = 0.04
  for (const rate of COMMON_RATES) {
    const e = Math.abs(hz - rate) / rate
    if (e < error) {
      error = e
      best = rate
    }
  }
  return best
}

/** The refresh rate a run of frame intervals (ms) shows: their median, snapped. */
export function rateFromIntervals(intervals: ArrayLike<number>): number {
  const sorted = Array.from(intervals).sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]!
  return snapRate(1000 / median)
}

/** Consecutive fast intervals that prove the display is faster than measured. */
const RUN = 20

/**
 * Watches frame intervals after the startup probe. An app that can't keep up only ever shows
 * slower intervals than the display's, so only faster ones count: a run of them (the window moved
 * to a faster screen, or ProMotion left its idle rate) raises the rate. Allocates nothing.
 */
export class RefreshMeter {
  periodMs: number
  private readonly run = new Float64Array(RUN)
  private count = 0

  constructor(periodMs: number) {
    this.periodMs = periodMs
  }

  /** One frame interval in ms. Returns the new rate in Hz when it rose, else 0. */
  sample(intervalMs: number): number {
    if (intervalMs < 2 || intervalMs > this.periodMs * 0.85) {
      this.count = 0
      return 0
    }
    this.run[this.count++] = intervalMs
    if (this.count < RUN) return 0
    this.count = 0
    this.run.sort()
    const hz = snapRate(1000 / this.run[RUN >> 1]!)
    if (1000 / hz >= this.periodMs * 0.95) return 0
    this.periodMs = 1000 / hz
    return hz
  }
}
