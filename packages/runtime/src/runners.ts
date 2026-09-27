import type { App } from './app'
import { AppControlResource } from './control'
import { RefreshMeter, rateFromIntervals } from './display'
import { LogResource } from './log'
import { DisplayRate } from './time'

/** Drives an initialized app. The app doesn't know which runner it has. */
export type Runner = (app: App) => void | Promise<void>

export interface HeadlessOptions {
  frames: number
  /** Seconds per frame. Default 1/60. A fixed delta makes runs reproducible. */
  delta?: number
}

/** Runs N frames as fast as possible with a fixed delta. For the CLI and tests. */
export function headlessRunner(options: HeadlessOptions): Runner {
  const delta = options.delta ?? 1 / 60
  return (app) => {
    for (let i = 0; i < options.frames; i++) app.update(delta)
  }
}

export interface AnimationFrameOptions {
  /** Longest delta passed to update, in seconds, e.g. after the tab was hidden. Default 0.25. */
  maxDelta?: number
  /** Stops the loop when aborted. */
  signal?: AbortSignal
  /**
   * Time a few idle frames before the first update to measure the display's refresh rate into
   * DisplayRate (about 12 refreshes: 0.1 s at 120 Hz). Default true.
   */
  measureRefresh?: boolean
}

/** Idle frame intervals the startup probe times. */
const PROBE_INTERVALS = 12

/** Resolves with the display's rate from idle rAF intervals, or 0 if the page is hidden. */
function probeRefresh(): Promise<number> {
  return new Promise((resolve) => {
    if (document.hidden) return resolve(0)
    const intervals = new Float64Array(PROBE_INTERVALS)
    let last = -1
    let n = 0
    const tick = (t: number) => {
      if (document.hidden) return resolve(0)
      if (last >= 0) intervals[n++] = t - last
      last = t
      if (n < PROBE_INTERVALS) requestAnimationFrame(tick)
      else resolve(rateFromIntervals(intervals))
    }
    requestAnimationFrame(tick)
  })
}

/** Runs a frame per `requestAnimationFrame`. For the browser and Studio. */
export function animationFrameRunner(options: AnimationFrameOptions = {}): Runner {
  const maxDelta = options.maxDelta ?? 0.25
  return async (app) => {
    const display = app.world.tryResource(DisplayRate)
    if (display && options.measureRefresh !== false) {
      const hz = await probeRefresh()
      if (hz > 0) {
        display.hz = hz
        display.periodMs = 1000 / hz
        display.source = 'measured'
      }
    }
    const meter = new RefreshMeter(display?.periodMs ?? 1000 / 60)
    return new Promise<void>((resolve) => {
      let last: number | undefined
      let handle = 0
      const onVisibility = () => {
        // The browser pauses rAF while hidden; don't count that gap as one huge frame.
        if (document.hidden) last = undefined
      }
      const frame = (timestamp: number) => {
        const delta = last === undefined ? 0 : Math.min((timestamp - last) / 1000, maxDelta)
        if (display && last !== undefined) {
          const hz = meter.sample(timestamp - last)
          if (hz > 0) {
            display.hz = hz
            display.periodMs = 1000 / hz
            display.source = 'measured'
          }
        }
        last = timestamp
        const control = app.world.resource(AppControlResource)
        try {
          if (!control.paused) app.update(delta)
          else if (control.pendingSteps > 0) {
            app.update(1 / app.fixedHz)
            control.stepped()
          }
        } catch (err) {
          // Keep the page alive and inspectable: log the error and pause instead of dying.
          app.world.resource(LogResource).error(err)
          control.paused = true
          control.pausedByError = true
          control.abort(err)
          console.error(err)
        }
        handle = requestAnimationFrame(frame)
      }
      document.addEventListener('visibilitychange', onVisibility)
      options.signal?.addEventListener('abort', () => {
        cancelAnimationFrame(handle)
        document.removeEventListener('visibilitychange', onVisibility)
        resolve()
      })
      handle = requestAnimationFrame(frame)
    })
  }
}
