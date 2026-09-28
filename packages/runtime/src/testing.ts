/**
 * A stand-in for the browser's frame loop, so `animationFrameRunner` runs headless in tests: it
 * installs `requestAnimationFrame`, `cancelAnimationFrame`, and (when there's none) a visible
 * `document` on globalThis. Frames only run when the test ticks.
 */
export interface FakeFrames {
  /** Animation frames requested so far. */
  readonly requested: number
  /** Callbacks waiting for the next frame. */
  readonly pending: number
  /** The timestamp the last tick passed, in ms. */
  readonly now: number
  /** `visibilitychange` listeners on the fake document. */
  readonly listeners: number
  /** Advances the clock by `ms` (default one 60 Hz refresh) and runs what was waiting. */
  tick(ms?: number): number
  /** Ticks until nothing waits or `max` frames ran; returns the frames run. */
  runUntilIdle(max?: number, ms?: number): number
  /** Puts the real globals back. */
  restore(): void
}

export function fakeAnimationFrames(): FakeFrames {
  const g = globalThis as Record<string, unknown>
  const saved = {
    raf: g.requestAnimationFrame,
    caf: g.cancelAnimationFrame,
    document: g.document,
  }
  let waiting = new Map<number, (t: number) => void>()
  let nextId = 1
  let requested = 0
  let now = 0
  let listeners = 0
  g.requestAnimationFrame = (fn: (t: number) => void) => {
    const id = nextId++
    requested++
    waiting.set(id, fn)
    return id
  }
  g.cancelAnimationFrame = (id: number) => {
    waiting.delete(id)
  }
  if (saved.document === undefined) {
    g.document = {
      hidden: false,
      addEventListener: () => void listeners++,
      removeEventListener: () => void listeners--,
    }
  }
  const tick = (ms = 1000 / 60) => {
    now += ms
    const run = waiting
    waiting = new Map()
    for (const fn of run.values()) fn(now)
    return run.size
  }
  return {
    get requested() {
      return requested
    },
    get pending() {
      return waiting.size
    },
    get now() {
      return now
    },
    get listeners() {
      return listeners
    },
    tick,
    runUntilIdle(max = 10_000, ms?: number) {
      let frames = 0
      while (waiting.size > 0 && frames < max) frames += tick(ms)
      return frames
    },
    restore() {
      g.requestAnimationFrame = saved.raf
      g.cancelAnimationFrame = saved.caf
      g.document = saved.document
    },
  }
}
