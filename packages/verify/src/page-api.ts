import type { RecordMeta } from './metrics/metrics'
import type { PlanConditions } from './plan'
import type { PerfRecord } from './record'

/** `window.__shardCapture`: what `shard capture` drives (0062). Types only: Node imports it too. */
export interface CapturePage {
  apply(state: Record<string, unknown>): Promise<void>
  /** Resolves once every app has nothing loading and its last frame is presented. */
  idle(timeoutMs?: number): Promise<void>
  /** Runs a host step; with `trace`, stamps it and reports the latency to the frame showing it. */
  step(
    name: string,
    args?: unknown,
    trace?: boolean,
  ): Promise<{ result: unknown; latencyMs?: number }>
  probe(): Promise<unknown>
  conditions(conditions: PlanConditions): Promise<void>
  /** A PNG of a canvas's own pixels, alpha kept, as base64. */
  snapshot(selector: string): Promise<{ png: string; width: number; height: number }>
  /** Starts a new measurement window on every app. */
  reset(): void
  /** The first app's record (the one with metrics). */
  record(meta: RecordMeta): PerfRecord
}

declare global {
  interface Window {
    __shardCapture?: CapturePage
    __shardReady?: boolean
  }
}
