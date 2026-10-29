import { defineResource, type Rng } from '@aethervtt/shard-core'

export interface TimeData {
  /** Seconds since the previous frame. */
  delta: number
  /** Seconds since the app started. */
  elapsed: number
  /** Frames completed, starting at 0 during the first frame. */
  frame: number
}

export interface FixedTimeData {
  /** The fixed step in seconds (1 / hz). */
  readonly step: number
  /** Simulated seconds advanced by FixedUpdate. */
  elapsed: number
  /** Leftover accumulated time as a fraction of a step, for interpolating rendering. */
  alpha: number
  /** FixedUpdate runs in the current frame. */
  steps: number
  /**
   * FixedUpdate runs completed since the app started: the step running now is `tick` (0-based).
   * Networking (0086) puts ticks on the wire instead of seconds.
   */
  tick: number
  /**
   * Multiplies fixed-step accumulation (default 1). Networking (0088) nudges it a few percent so a
   * client stays the right number of ticks ahead of its server.
   */
  rate: number
}

export const Time = defineResource<TimeData>('core/Time', {
  description: 'Frame time. Read delta in Update systems.',
})

export const FixedTime = defineResource<FixedTimeData>('core/FixedTime', {
  description: 'Fixed-step time. Read step in FixedUpdate systems; alpha for interpolation.',
})

export interface DisplayRateData {
  /** Refresh rate of the display the app runs on, in Hz. */
  hz: number
  /** One refresh, in ms. */
  periodMs: number
  /**
   * measured: the frame runner timed it (at startup, raised later if frames come faster).
   * assumed: 60 Hz, for headless runs and before a measurement.
   */
  source: 'measured' | 'assumed'
}

export const DisplayRate = defineResource<DisplayRateData>('core/DisplayRate', {
  description:
    "The display's refresh rate, measured by the frame runner (60 Hz assumed headless). Frame budgets that should match the screen read periodMs.",
})

export const GlobalRng = defineResource<Rng>('core/GlobalRng', {
  description: 'The app root random stream, seeded from AppOptions.seed. Fork it per system.',
})

/** Whether this is a development build (`new App({ dev: true })`). */
export const DevMode = defineResource<{ enabled: boolean }>('runtime/DevMode', {
  description: 'Development build: loud fallbacks and dev-only checks.',
  init: () => ({ enabled: false }),
})
