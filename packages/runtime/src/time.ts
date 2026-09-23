import { defineResource, type Rng } from '@shard/core'

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
}

export const Time = defineResource<TimeData>('core/Time', {
  description: 'Frame time. Read delta in Update systems.',
})

export const FixedTime = defineResource<FixedTimeData>('core/FixedTime', {
  description: 'Fixed-step time. Read step in FixedUpdate systems; alpha for interpolation.',
})

export const GlobalRng = defineResource<Rng>('core/GlobalRng', {
  description: 'The app root random stream, seeded from AppOptions.seed. Fork it per system.',
})
