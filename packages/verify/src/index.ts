// Browser verification (0062): the performance record format, perceptual image comparison,
// capture plans, and pass thresholds. Everything here is plain data and math: it runs in Node, in
// a browser, and in Aether's three.js pages alike. Instruments live in `./metrics`, the page API in
// `./page`, and the Playwright runner in `./node`.

export {
  compareImages,
  DEFAULT_TOLERANCE,
  deltaE2000,
  diffHeatmap,
  type ImageDiff,
  type RgbaImage,
  type Tolerance,
} from './compare'
export { type CheckFailure, checkExpectations, deepEqual, valueAt } from './expect'
export {
  type BrowserName,
  type CapturePlan,
  type CaptureScope,
  capturePlanJsonSchema,
  type Expectations,
  type Matcher,
  type PlanClient,
  type PlanConditions,
  type PlanScenario,
  type PlanShot,
  type PlanStep,
  parsePlan,
  shotId,
  type ThresholdRule,
  type Thresholds,
} from './plan'
export {
  type PerfDevice,
  type PerfRecord,
  parsePerfRecord,
  perfRecordJsonSchema,
  rendererName,
  validateJson,
} from './record'
export { type ReportShot, renderReport } from './report'
export {
  type Approval,
  type ApprovalsFile,
  addApproval,
  type CapturedShot,
  type CaptureManifest,
} from './run'
export { type Breach, checkThresholds, type PerfCheck } from './thresholds'
