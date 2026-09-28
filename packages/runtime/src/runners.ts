import type { App } from './app'
import { AppControlResource } from './control'
import { FrameDemand } from './demand'
import { RefreshMeter, rateFromIntervals } from './display'
import { LogResource } from './log'
import { DisplayRate } from './time'
import type { ResourceWriteCheck } from './write-check'

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
  /** Stops the loop when aborted. `app.dispose()` stops it too. */
  signal?: AbortSignal
  /**
   * Time a few idle frames before the first update to measure the display's refresh rate into
   * DisplayRate (about 12 refreshes: 0.1 s at 120 Hz). Default true.
   */
  measureRefresh?: boolean
  /**
   * continuous (default): a frame every display refresh. on-demand: a frame only when something
   * changed (0052): a world write, a FrameDemand holder or timer, input, a surface resize, queued
   * steps, or `app.requestFrame()`. Idle, it requests no animation frames at all.
   */
  mode?: 'continuous' | 'on-demand'
  /**
   * On-demand, for dev builds: every second while idle, compare the plain-object resources marked
   * `hostWritable` with their values when the app went idle, and log
   * `runtime/unmarked-resource-write` for one that changed without waking it. Default false.
   */
  checkResourceWrites?: boolean
}

/** Idle frame intervals the startup probe times. */
const PROBE_INTERVALS = 12

interface Probe {
  handle: number
  stopped: boolean
}

/** Resolves with the display's rate from idle rAF intervals, or 0 if hidden or stopped. */
function probeRefresh(probe: Probe): Promise<number> {
  return new Promise((resolve) => {
    if (document.hidden) return resolve(0)
    const intervals = new Float64Array(PROBE_INTERVALS)
    let last = -1
    let n = 0
    const tick = (t: number) => {
      if (probe.stopped || document.hidden) return resolve(0)
      if (last >= 0) intervals[n++] = t - last
      last = t
      if (n < PROBE_INTERVALS) probe.handle = requestAnimationFrame(tick)
      else resolve(rateFromIntervals(intervals))
    }
    probe.handle = requestAnimationFrame(tick)
  })
}

/**
 * Runs frames on `requestAnimationFrame`, for the browser and Studio: one per display refresh, or
 * in `mode: 'on-demand'` only while something needs them (0052).
 */
export function animationFrameRunner(options: AnimationFrameOptions = {}): Runner {
  const maxDelta = options.maxDelta ?? 0.25
  const onDemand = options.mode === 'on-demand'
  return async (app) => {
    const world = app.world
    const demand = world.resource(FrameDemand)
    const control = world.resource(AppControlResource)
    const display = world.tryResource(DisplayRate)
    const probe: Probe = { handle: 0, stopped: false }
    let handle = 0
    /** A frame is requested and hasn't run yet. */
    let pending = false
    /** No frame has run since the loop last went quiet: the next one is a wake-up. */
    let idle = true
    let last: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let writes: ResourceWriteCheck | undefined
    let finish = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })

    const schedule = () => {
      if (pending || probe.stopped) return
      pending = true
      handle = requestAnimationFrame(frame)
    }
    const onTimer = () => {
      timer = undefined
      schedule()
    }
    const armTimer = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      const due = demand.dueIn()
      if (due !== Number.POSITIVE_INFINITY) timer = setTimeout(onTimer, due)
    }
    const goIdle = () => {
      idle = true
      world.asleep = true
      armTimer()
      writes?.start()
    }
    const onVisibility = () => {
      // The browser pauses rAF while hidden; don't count that gap as one huge frame.
      if (document.hidden) last = undefined
    }
    const stop = () => {
      if (probe.stopped) return
      probe.stopped = true
      cancelAnimationFrame(probe.handle)
      if (pending) cancelAnimationFrame(handle)
      pending = false
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      writes?.stop()
      document.removeEventListener('visibilitychange', onVisibility)
      options.signal?.removeEventListener('abort', stop)
      if (onDemand) {
        world.onWake = undefined
        world.asleep = false
        demand.onDemand = undefined
      }
      demand.mode = 'manual'
      finish()
    }

    const meter = new RefreshMeter(display?.periodMs ?? 1000 / 60)
    const frame = (timestamp: number) => {
      pending = false
      if (probe.stopped) return
      const woke = idle
      idle = false
      writes?.stop()
      let delta = last === undefined ? 0 : Math.min((timestamp - last) / 1000, maxDelta)
      if (onDemand) {
        world.asleep = false
        demand.takeDue()
        if (woke && last !== undefined) {
          // Waking from idle: one fixed step, and none of the idle time owed to FixedUpdate.
          delta = 1 / app.fixedHz
          app.resetFixedTime()
        }
      }
      if (display && last !== undefined && !woke) {
        const hz = meter.sample(timestamp - last)
        if (hz > 0) {
          display.hz = hz
          display.periodMs = 1000 / hz
          display.source = 'measured'
        }
      }
      last = timestamp
      try {
        if (!control.paused) app.update(delta)
        else if (control.pendingSteps > 0) {
          app.update(1 / app.fixedHz)
          control.stepped()
        }
      } catch (err) {
        // Keep the page alive and inspectable: log the error and pause instead of dying.
        world.resource(LogResource).error(err)
        control.paused = true
        control.pausedByError = true
        control.abort(err)
        console.error(err)
      }
      if (probe.stopped) return // disposed during the frame
      if (!onDemand || demand.active || control.pendingSteps > 0) schedule()
      if (!pending) goIdle()
    }

    options.signal?.addEventListener('abort', stop)
    app.attachDriver({ requestFrame: onDemand ? schedule : () => {}, stop })
    demand.mode = onDemand ? 'on-demand' : 'continuous'
    if (options.signal?.aborted) stop()
    if (display && options.measureRefresh !== false && !probe.stopped) {
      const hz = await probeRefresh(probe)
      if (hz > 0) {
        display.hz = hz
        display.periodMs = 1000 / hz
        display.source = 'measured'
        meter.periodMs = display.periodMs
      }
    }
    if (onDemand && options.checkResourceWrites) {
      const { ResourceWriteCheck } = await import('./write-check')
      writes = new ResourceWriteCheck(world, world.tryResource(LogResource), () => idle && !pending)
    }
    if (probe.stopped) return
    if (onDemand) {
      world.onWake = schedule
      demand.onDemand = () => {
        if (!idle || probe.stopped) return
        if (demand.active) schedule()
        else armTimer()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    schedule()
    return finished
  }
}
