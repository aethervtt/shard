export {
  App,
  type AppDescription,
  type AppMethod,
  type AppOptions,
  type AppScope,
  type FrameDriver,
  type FramePresenter,
  type StartupTimings,
} from './app'
export {
  type BudgetMeasure,
  type BudgetsDescription,
  backendOf,
  coveredMs,
  type DescribeBudgetsOptions,
  describeBudgets,
  detectPerfMachine,
  type MachineDetection,
  measureSlices,
  PERF_TRACKS,
  type PerfAdapterInfo,
  type PerfBudgetEntry,
  type PerfBudgetState,
  PerfBudgets,
  type PerfBudgetsData,
  type PerfBudgetsFile,
  type PerfMachine,
  type PerfMachinesFile,
  type PerfScenarioEntry,
  type PerfTrack,
  type PerfWarning,
  perfBudgetState,
  type ResolvedPerfScenario,
  resolvePerfScenario,
  type ScenarioMeasure,
  type SliceMeasure,
  scenarioSliceMs,
} from './budgets'
export { AppControl, AppControlResource } from './control'
export { FrameDemand, FrameDemandState, type FrameMode, LOADING_DEMAND } from './demand'
export { COMMON_RATES, RefreshMeter, rateFromIntervals, snapRate } from './display'
export { Log, type LogEntry, type LogLevel, LogResource } from './log'
export {
  capturePerf,
  captureStamp,
  describePerf,
  gpuPassOverlap,
  isGpuPass,
  OVERLAP_RATIO,
  type PerfCaptureOptions,
  type PerfCaptureResult,
  type PerfDescribeOptions,
  type PerfHost,
  PerfHostResource,
  PerfProviders,
  type PerfProvidersData,
  type PerfSampler,
  type PerfSamples,
  perfBreakdown,
  perfMemory,
} from './perf'
export { definePlugin, type Plugin } from './plugin'
export {
  type AnimationFrameOptions,
  animationFrameRunner,
  type HeadlessOptions,
  headlessRunner,
  type Runner,
} from './runners'
export { PerfScenario, type PerfScenarioData } from './scenario'
export {
  defineState,
  inState,
  OnEnter,
  OnExit,
  type StateDef,
  type StateValue,
  setState,
} from './state'
export {
  DevMode,
  DisplayRate,
  type DisplayRateData,
  FixedTime,
  type FixedTimeData,
  GlobalRng,
  Time,
  type TimeData,
} from './time'
