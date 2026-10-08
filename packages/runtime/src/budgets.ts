import {
  defineResource,
  type Profiler,
  ProfilerResource,
  ShardError,
  spanCovers,
  spanId,
  spanName,
  spanStats,
  type World,
} from '@aethervtt/shard-core'
import { PerfProviders } from './perf'
import { PerfScenario } from './scenario'

// Performance budgets in a running app (0075): which named machine this is, from what the host
// exposes; budgets.json resolved for it; the scenario the app declares; and the profiler's
// aggregates against each budget (`perf.budgets`). Hosts hand the files over as data
// (`PerfBudgets`): the CLI reads them from the repo or project, `shard dev` serves them to its
// page, and an app without them has no budgets.

export type PerfTrack = 'gpu' | 'cpu'
export const PERF_TRACKS: readonly PerfTrack[] = ['gpu', 'cpu']

export interface PerfMachine {
  /** Part of the CPU model string (`node:os`). */
  cpu: string
  /** Part of the GPU adapter's vendor, architecture, device or description. */
  gpu: string
  backend?: string
  display?: [number, number]
  /** How GPU slices are checked: per-pass timestamps, or ablation where passes overlap. */
  passTiming?: 'ablation' | 'timestamps'
  note?: string
}

/** `bench/perf/machines.json`. */
export interface PerfMachinesFile {
  machines: Record<string, PerfMachine>
}

export interface PerfBudgetEntry {
  kind: 'target' | 'unit' | 'rate' | 'guard'
  per?: string
  in?: string
  margin?: number
  note?: string
  /** A number per machine name. */
  [machine: string]: unknown
}

export interface PerfScenarioEntry {
  what?: string
  resolution?: [number, number]
  renderScale?: number
  fps?: number
  /** The frame budget per track, per machine, in ms. */
  frame: Record<PerfTrack, Record<string, number>>
  /** Each track's slices as shares of the frame, `headroom` included; they sum to 1. */
  slices: Record<PerfTrack, Record<string, number>>
  /** Absolute slices in ms per machine, where hardware differs unevenly. */
  overrides?: Record<string, Partial<Record<PerfTrack, Record<string, number>>>>
  note?: string
}

/** `bench/perf/budgets.json`. */
export interface PerfBudgetsFile {
  spans: Record<string, PerfBudgetEntry>
  scenarios: Record<string, PerfScenarioEntry>
}

export interface PerfBudgetsData {
  machines: PerfMachinesFile
  budgets: PerfBudgetsFile
  /** Where they came from (a path or URL), for `perf.budgets`. */
  source?: string
  /** The CPU model, where the host knows it (Node: `os.cpus()[0].model`). Browsers don't. */
  cpu?: string
  /** A machine name that overrides detection (`SHARD_MACHINE`, `?machine=`). */
  machine?: string
}

/**
 * Budgets for the running app (0075), handed over by the host: the CLI loads `bench/perf/` from
 * the repo (or `perf/` in the project), `shard dev` serves them to its page. Absent: no budgets.
 */
export const PerfBudgets = defineResource<PerfBudgetsData>('runtime/PerfBudgets', {
  description:
    'budgets.json and machines.json (0075), as the host loaded them, with the CPU model and a machine override.',
})

export interface PerfAdapterInfo {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
}

export interface PerfWarning {
  code: string
  message: string
  hint?: string
}

export interface MachineDetection {
  /** The named machine, or null when this one can't be told (or isn't named). */
  machine: string | null
  source: 'detected' | 'override' | 'unknown'
  /** The machine that matched best, which unknown machines report against. */
  closest: string | null
  warnings: PerfWarning[]
}

const has = (text: string | undefined, part: string | undefined) =>
  !!part && (text ?? '').toLowerCase().includes(part.toLowerCase())

/** The graphics API an adapter's description names. */
export function backendOf(description = ''): string | undefined {
  const d = description.toLowerCase()
  if (d.includes('metal')) return 'metal'
  if (d.includes('d3d12')) return 'd3d12'
  if (d.includes('d3d11')) return 'd3d11'
  if (d.includes('vulkan')) return 'vulkan'
  if (d.includes('opengl')) return 'opengl'
  return undefined
}

/**
 * Which machine of machines.json this is (the rule `pnpm bench` uses, bench/perf/src/perf.mjs): a
 * machine matches when both its CPU and GPU strings do. A host that can't tell the CPU model (a
 * browser) never matches, and gets `perf/unknown-machine`; `override` names the machine instead.
 */
export function detectPerfMachine(
  machines: PerfMachinesFile,
  o: { cpu?: string; adapter?: PerfAdapterInfo; override?: string } = {},
): MachineDetection {
  const names = Object.keys(machines.machines)
  const gpuText = o.adapter
    ? [o.adapter.vendor, o.adapter.architecture, o.adapter.device, o.adapter.description].join(' ')
    : ''
  const backend = backendOf(o.adapter?.description)
  let best: string | null = names[0] ?? null
  let bestScore = -1
  let detected: string | null = null
  for (const name of names) {
    const m = machines.machines[name]!
    const cpu = has(o.cpu, m.cpu)
    const gpu = has(gpuText, m.gpu)
    const score = (cpu ? 2 : 0) + (gpu ? 2 : 0) + (backend && backend === m.backend ? 1 : 0)
    if (score > bestScore) {
      bestScore = score
      best = name
    }
    if (cpu && gpu && detected === null) detected = name
  }
  const warnings: PerfWarning[] = []
  if (o.override) {
    if (!names.includes(o.override)) {
      warnings.push({
        code: 'perf/unknown-machine',
        message: `Machine "${o.override}" isn't in machines.json (${names.join(', ')})`,
      })
      return { machine: null, source: 'unknown', closest: best, warnings }
    }
    if (detected && detected !== o.override) {
      warnings.push({
        code: 'perf/machine-mismatch',
        message: `The override says "${o.override}", but this looks like "${detected}"`,
      })
    }
    return { machine: o.override, source: 'override', closest: o.override, warnings }
  }
  if (detected) return { machine: detected, source: 'detected', closest: detected, warnings }
  warnings.push({
    code: 'perf/unknown-machine',
    message: o.cpu
      ? `No machine in machines.json matches (CPU "${o.cpu}", GPU "${gpuText.trim() || 'unknown'}")`
      : `This host doesn't expose its CPU model, so it can't tell which machine it is (GPU "${gpuText.trim() || 'unknown'}")`,
    hint: 'Name it: PerfBudgets.machine (SHARD_MACHINE in Node, ?machine= on playground pages).',
  })
  return { machine: null, source: 'unknown', closest: best, warnings }
}

/** A scenario's frame and slices on one machine, in ms (null without a number). */
export interface ResolvedPerfScenario {
  frame: Record<PerfTrack, number | null>
  /** Each slice in ms: its share of the frame, or the machine's override. */
  slices: Record<PerfTrack, Record<string, number | null>>
  /** Each slice's share of the frame, as budgets.json states it. */
  shares: Record<PerfTrack, Record<string, number>>
}

/** A scenario of budgets.json on `machine` (null: shares only). */
export function resolvePerfScenario(
  scenario: PerfScenarioEntry,
  machine: string | null,
): ResolvedPerfScenario {
  const frame = { gpu: null, cpu: null } as Record<PerfTrack, number | null>
  const slices = { gpu: {}, cpu: {} } as Record<PerfTrack, Record<string, number | null>>
  const shares = { gpu: {}, cpu: {} } as Record<PerfTrack, Record<string, number>>
  for (const track of PERF_TRACKS) {
    const ms = machine !== null ? scenario.frame?.[track]?.[machine] : undefined
    frame[track] = typeof ms === 'number' ? ms : null
    const overrides = machine !== null ? scenario.overrides?.[machine]?.[track] : undefined
    for (const [slice, share] of Object.entries(scenario.slices?.[track] ?? {})) {
      shares[track][slice] = share
      const absolute = overrides?.[slice]
      slices[track][slice] =
        typeof absolute === 'number'
          ? absolute
          : frame[track] === null
            ? null
            : frame[track]! * share
    }
  }
  return { frame, slices, shares }
}

/** The detected machine and the app's budgets data, cached until either changes. */
export interface PerfBudgetState {
  data: PerfBudgetsData
  detection: MachineDetection
}

const stateCache = new WeakMap<
  World,
  { key: string; data: PerfBudgetsData; state: PerfBudgetState }
>()

/**
 * The app's budgets and which machine it runs on, or undefined without `PerfBudgets`. Cached per
 * world until the data, the override or the adapter changes; not for per-frame use.
 */
export function perfBudgetState(
  world: World,
  adapter?: PerfAdapterInfo,
): PerfBudgetState | undefined {
  const data = world.tryResource(PerfBudgets)
  if (!data?.budgets || !data.machines) return undefined
  adapter ??= world.tryResource(PerfProviders)?.adapter?.(world)
  const key = `${data.cpu ?? ''}|${data.machine ?? ''}|${adapter ? JSON.stringify(adapter) : ''}`
  const cached = stateCache.get(world)
  if (cached && cached.data === data && cached.key === key) return cached.state
  const detection = detectPerfMachine(data.machines, {
    cpu: data.cpu,
    adapter,
    override: data.machine,
  })
  const state = { data, detection }
  stateCache.set(world, { key, data, state })
  return state
}

/**
 * A scenario slice in ms on the detected machine, or undefined (no budgets, no scenario, no such
 * slice, or an unknown machine). What 0045's foliage defaults its target to.
 */
export function scenarioSliceMs(
  world: World,
  scenario: string,
  track: PerfTrack,
  slice: string,
  adapter?: PerfAdapterInfo,
): number | undefined {
  const state = perfBudgetState(world, adapter)
  const entry = state?.data.budgets.scenarios[scenario]
  if (!state || !entry || state.detection.machine === null) return undefined
  const ms = resolvePerfScenario(entry, state.detection.machine).slices[track][slice]
  return ms ?? undefined
}

/**
 * Time a key covers in an average frame, from the profiler's aggregates: the averages of every span
 * the key covers (`spanCovers`), a span inside another covered span (its `parentOf` chain) counted
 * once, as `Capture.spanTime` does. A span that doesn't run every frame counts its average run.
 */
export function coveredMs(profiler: Profiler, key: string): number | undefined {
  let ms = 0
  let any = false
  for (const name of profiler.names()) {
    if (!spanCovers(key, name)) continue
    const timing = profiler.timing(name)
    if (!timing) continue
    any = true
    // Inside another span the key covers (a render/<node> in render/execute-graph): counted there.
    let parent = profiler.parentOf(spanId(name))
    let inside = false
    for (let depth = 0; parent >= 0 && depth < 64; depth++) {
      if (spanCovers(key, spanName(parent))) {
        inside = true
        break
      }
      parent = profiler.parentOf(parent)
    }
    if (!inside) ms += timing.avg
  }
  return any ? ms : undefined
}

export interface SliceMeasure {
  slice: string
  track: PerfTrack
  /** Its share of the frame in budgets.json. */
  share: number
  /** Its budget on this machine (ms), or null. */
  budgetMs: number | null
  /** Measured: the covered spans' average, and its share of the measured frame. */
  measuredMs: number | null
  measuredShare: number | null
  verdict: 'over' | 'pass' | 'unmeasured'
}

/**
 * Each slice of a scenario against the profiler's aggregates: measured shares of the frame (`frame`
 * for CPU, `gpu:frame` for GPU) next to the budget's. `headroom` is what the slices leave: the frame
 * less every slice.
 */
export function measureSlices(
  profiler: Profiler,
  scenario: PerfScenarioEntry,
  machine: string | null,
): {
  frame: Record<PerfTrack, { budgetMs: number | null; measuredMs: number | null }>
  slices: SliceMeasure[]
} {
  const resolved = resolvePerfScenario(scenario, machine)
  const r3 = (ms: number) => Math.round(ms * 1000) / 1000
  const frame = {} as Record<PerfTrack, { budgetMs: number | null; measuredMs: number | null }>
  const slices: SliceMeasure[] = []
  for (const track of PERF_TRACKS) {
    const frameMs = profiler.timing(track === 'gpu' ? 'gpu:frame' : 'frame')?.avg ?? null
    frame[track] = {
      budgetMs: resolved.frame[track],
      measuredMs: frameMs === null ? null : r3(frameMs),
    }
    let used = 0
    const keys = Object.keys(resolved.shares[track])
    for (const slice of keys) {
      if (slice === 'headroom') continue
      const ms = coveredMs(profiler, slice) ?? null
      if (ms !== null) used += ms
      slices.push(sliceMeasure(slice, track, resolved, ms, frameMs))
    }
    if ('headroom' in resolved.shares[track]) {
      const left = frameMs === null ? null : Math.max(0, frameMs - used)
      // Headroom is a floor: it's over when the slices leave less than it.
      const m = sliceMeasure('headroom', track, resolved, left, frameMs)
      m.verdict =
        m.measuredShare === null ? 'unmeasured' : m.measuredShare < m.share ? 'over' : 'pass'
      slices.push(m)
    }
  }
  return { frame, slices }
}

function sliceMeasure(
  slice: string,
  track: PerfTrack,
  resolved: ResolvedPerfScenario,
  ms: number | null,
  frameMs: number | null,
): SliceMeasure {
  const share = resolved.shares[track][slice]!
  const measuredShare = ms !== null && frameMs !== null && frameMs > 0 ? ms / frameMs : null
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return {
    slice,
    track,
    share,
    budgetMs: resolved.slices[track][slice] ?? null,
    measuredMs: ms === null ? null : r3(ms),
    measuredShare: measuredShare === null ? null : r3(measuredShare),
    verdict: measuredShare === null ? 'unmeasured' : measuredShare > share ? 'over' : 'pass',
  }
}

export interface BudgetMeasure {
  key: string
  kind: PerfBudgetEntry['kind']
  per?: string
  in?: string
  /** The machine's number (null on an unknown machine). */
  budget: number | null
  /** What a measurement is compared with: a guard's plus its margin. */
  limit: number | null
  /** The span's p95 over the profiler's window, where a span by this name ran. */
  measured: number | null
  verdict: 'over' | 'pass' | 'unmeasured' | 'unbudgeted'
}

export interface DescribeBudgetsOptions {
  /** A scenario to measure; default the app's (`PerfScenario`). */
  scenario?: string
  /** The GPU adapter, for detection. Default: the render plugin's (`PerfProviders.adapter`). */
  adapter?: PerfAdapterInfo
}

/** A scenario's frame and slices against the profiler's aggregates, over budget first. */
export interface ScenarioMeasure {
  name: string
  what?: string
  resolution?: [number, number]
  renderScale?: number
  fps?: number
  frame: Record<PerfTrack, { budgetMs: number | null; measuredMs: number | null }>
  slices: SliceMeasure[]
}

/** What `perf.budgets` returns. */
export interface BudgetsDescription {
  /** The named machine, or null when this host can't tell (`closest` is then what numbers use). */
  machine: string | null
  source: MachineDetection['source']
  closest?: string | null
  /** Where the budgets came from. */
  from?: string
  /** The scenario measured (the app's, or the one asked for); null without one. */
  scenario: ScenarioMeasure | null
  warnings: PerfWarning[]
  budgets: BudgetMeasure[]
}

/**
 * `perf.budgets` (0075): the detected machine, every budget resolved for it, and the latest
 * measurements against each from the profiler's aggregates (span keys by their p95; the scenario's
 * slices as shares of the frame), over budget first.
 */
export function describeBudgets(
  world: World,
  options: DescribeBudgetsOptions = {},
): BudgetsDescription {
  const state = perfBudgetState(world, options.adapter)
  const scenarioName = options.scenario ?? world.tryResource(PerfScenario)?.name ?? null
  if (!state) {
    return {
      machine: null,
      source: 'unknown',
      scenario: null,
      warnings: [
        {
          code: 'perf/no-budgets',
          message: 'This app has no budgets: the host gave it no budgets.json',
          hint: 'The CLI loads bench/perf/budgets.json from the repo (or perf/budgets.json in the project); shard dev serves it to its page.',
        },
      ],
      budgets: [],
    }
  }
  const { data, detection } = state
  const machine = detection.machine
  const on = machine ?? detection.closest
  const profiler = world.resource(ProfilerResource)
  const budgets: BudgetMeasure[] = []
  for (const [key, entry] of Object.entries(data.budgets.spans ?? {})) {
    const value = on !== null && typeof entry[on] === 'number' ? (entry[on] as number) : null
    const limit =
      value === null ? null : entry.kind === 'guard' ? value * (1 + (entry.margin ?? 0)) : value
    // Units and rates are per item: an aggregate of the whole span says nothing about them.
    const stats =
      entry.kind === 'unit' || entry.kind === 'rate' || entry.in
        ? undefined
        : spanStats(profiler, key)
    const measured = stats ? Math.round(stats.p95 * 1000) / 1000 : null
    budgets.push({
      key,
      kind: entry.kind,
      ...(entry.per ? { per: entry.per } : {}),
      ...(entry.in ? { in: entry.in } : {}),
      budget: value,
      limit,
      measured,
      verdict:
        measured === null
          ? 'unmeasured'
          : limit === null || machine === null
            ? 'unbudgeted'
            : measured > limit
              ? 'over'
              : 'pass',
    })
  }
  const rank = { over: 0, pass: 1, unbudgeted: 2, unmeasured: 3 }
  budgets.sort((a, b) => rank[a.verdict] - rank[b.verdict] || (a.key < b.key ? -1 : 1))
  let scenario: ScenarioMeasure | null = null
  if (scenarioName !== null) {
    const entry = data.budgets.scenarios[scenarioName]
    if (!entry) {
      throw new ShardError('perf/unknown-budget', `No scenario "${scenarioName}" in budgets.json`, {
        path: scenarioName,
        hint: `Scenarios: ${Object.keys(data.budgets.scenarios).join(', ')}.`,
      })
    }
    const measured = measureSlices(profiler, entry, machine ?? detection.closest)
    const order = { over: 0, pass: 1, unmeasured: 2 }
    measured.slices.sort((a, b) => order[a.verdict] - order[b.verdict])
    scenario = {
      name: scenarioName,
      what: entry.what,
      resolution: entry.resolution,
      renderScale: entry.renderScale,
      fps: entry.fps,
      frame: measured.frame,
      slices: measured.slices,
    }
  }
  return {
    machine,
    source: detection.source,
    ...(machine === null ? { closest: detection.closest } : {}),
    ...(data.source ? { from: data.source } : {}),
    scenario,
    warnings: detection.warnings,
    budgets,
  }
}
