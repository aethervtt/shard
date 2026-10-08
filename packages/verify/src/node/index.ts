// Node side of 0062: the Playwright capture runner and the file work of compare, approve, and
// perf-check. Browser pages use `@aethervtt/shard-verify/page` and `/metrics` instead.

export {
  browserLaunch,
  type CaptureOptions,
  type CaptureRun,
  clientUrl,
  ISOLATION_HEADERS,
  runCapture,
} from './capture'
export {
  approveShot,
  type CompareResult,
  type CompareRun,
  compareRun,
  perfCheck,
  readManifest,
  readPlan,
  readRecords,
} from './files'
export { decodePng, encodePng, sha256 } from './png'
