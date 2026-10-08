// Captures (0074): loaded with `import('@aethervtt/shard-core/capture')`, so builds that never
// capture don't carry them.

export {
  Capture,
  type CaptureEvents,
  type CaptureFrames,
  type CaptureInit,
  type CaptureSummary,
  type CaptureWarning,
  type ChromeTrace,
  type HeapStats,
  type HotFunction,
  type SpanStats,
  type Stats,
  type SummaryExtras,
  type TraceEvent,
  type TraceSample,
} from './capture'
export { type CaptureOptions, CaptureRecorder, startCapture } from './recorder'
export {
  type CpuProfile,
  hottestFromCpuProfile,
  hottestFromSelfProfile,
  type SelfProfileTrace,
  samplesFromSelfProfile,
} from './samples'
