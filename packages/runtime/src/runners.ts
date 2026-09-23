import type { App } from './app'
import { AppControlResource } from './control'
import { LogResource } from './log'

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
}

/** Runs a frame per `requestAnimationFrame`. For the browser and Studio. */
export function animationFrameRunner(options: AnimationFrameOptions = {}): Runner {
  const maxDelta = options.maxDelta ?? 0.25
  return (app) =>
    new Promise<void>((resolve) => {
      let last: number | undefined
      let handle = 0
      const onVisibility = () => {
        // The browser pauses rAF while hidden; don't count that gap as one huge frame.
        if (document.hidden) last = undefined
      }
      const frame = (timestamp: number) => {
        const delta = last === undefined ? 0 : Math.min((timestamp - last) / 1000, maxDelta)
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
