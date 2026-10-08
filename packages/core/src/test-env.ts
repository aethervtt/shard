/**
 * How strict tests are about time, in one place. Two tiers:
 *
 * - `pnpm bench` (`SHARD_BENCH`) checks performance: the exact budgets from the specs and
 *   "allocates nothing", one file at a time on a machine doing nothing else.
 * - `pnpm test`, locally and in CI (`SHARD_CI`), checks correctness only. Parallel files share the
 *   CPU and GPU, and CI renders on a software GPU, so wall-clock timings there say nothing about the
 *   engine: budgets are unlimited and allocation checks are off. Timeouts are 5× longer in CI.
 *
 * Write every timing assertion through `budget()`, `slack` or `allocationChecks`, and it lands in
 * the right tier.
 *
 * Budgets are data (spec 0075): `bench/perf/budgets.json` holds a number per key and named machine
 * (`bench/perf/machines.json`), and `budget(key)` reads it. Core can't read files, so the numbers
 * arrive resolved, as JSON in the `SHARD_BUDGETS` environment variable:
 *
 * - `pnpm bench` (`scripts/bench.mjs`) detects the machine, resolves every key for it, and passes
 *   the result (`ResolvedBudgets`) to the test processes. On an unknown machine it passes the
 *   closest machine's numbers with `enforce: false`: budgets stay unlimited, and the report
 *   (`bench/perf/report.json`) compares against them.
 * - `pnpm test` gets the keys with no machine from `testFiles()` (`scripts/test-shard.mjs`), so an
 *   unknown key fails there too (`perf/unknown-budget`) while every budget is unlimited.
 *
 * Under `pnpm bench`, `SHARD_PERF_REPORT` names a folder: each `budget(key)` call is noted on
 * `globalThis.__shardBudget`, and `scripts/perf-report.setup.mjs` records the value the next
 * comparison matcher (`toBeLessThan` and the like) checks against it.
 */

import { ShardError } from './error'

export type TimingMode = 'bench' | 'test' | 'ci'

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

export const timingMode: TimingMode = env.SHARD_BENCH ? 'bench' : env.SHARD_CI ? 'ci' : 'test'

/** The factor budgets are multiplied by (and rate floors divided by): 1 under `pnpm bench`, else ∞. */
export const slack = timingMode === 'bench' ? 1 : Number.POSITIVE_INFINITY

/** One key of `budgets.json`, resolved for a machine. `value` is null without one. */
export interface ResolvedSpan {
  kind: 'target' | 'unit' | 'rate' | 'guard'
  value: number | null
  /** Guards: the limit is `value × (1 + margin)`. */
  margin?: number
  /** Units and rates: what one item is ("prop", "point"). */
  per?: string
  /** What the number measures when it isn't ms: 'frames', 'ratio'. */
  in?: string
}

export type Track = 'gpu' | 'cpu'

export interface ResolvedScenario {
  /** The frame budget per track, in ms. */
  frame: Record<Track, number | null>
  /** Each slice in ms (its share of the frame, or the machine's override). */
  slices: Record<Track, Record<string, number | null>>
}

/** What `SHARD_BUDGETS` carries. */
export interface ResolvedBudgets {
  /** The machine the numbers are for; null outside `pnpm bench`. */
  machine: string | null
  /** False on an unknown machine and outside `pnpm bench`: every budget is unlimited. */
  enforce: boolean
  spans: Record<string, ResolvedSpan>
  scenarios: Record<string, ResolvedScenario>
}

export interface BudgetOptions {
  /** Unit costs: how many items the measurement covered (the budget is the unit cost × this). */
  count?: number
  /** Scenarios: a slice's budget instead of the whole frame's. */
  slice?: string
  /** Scenarios: 'gpu' or 'cpu'. Default: 'gpu' for a `gpu:` slice, else 'cpu'. */
  track?: Track
}

/** A key's number on the resolved machine, and the limit a test checks: ∞ (0 for rates) when off. */
export interface ResolvedLimit {
  /** What the test compares against. */
  limit: number
  /** The machine's number for the comparison (null without one), enforced or not. */
  reference: number | null
  kind: ResolvedSpan['kind'] | 'slice'
}

function unknownBudget(key: string, detail = ''): ShardError {
  return new ShardError('perf/unknown-budget', `No budget "${key}"${detail} in budgets.json`, {
    path: key,
    hint: 'Add it to bench/perf/budgets.json with a number for every machine and a note.',
  })
}

/**
 * The limit for `key` from resolved budgets: a span's number (a unit's times `count`, a guard's
 * plus its margin), or a scenario's frame or slice in ms. Unlimited unless `enforce`: ∞, or 0 for a
 * rate (a floor). Throws `perf/unknown-budget` for a key, scenario or slice budgets.json lacks.
 */
export function resolveLimit(
  budgets: ResolvedBudgets | undefined,
  key: string,
  opts: BudgetOptions = {},
  enforce = true,
): ResolvedLimit {
  if (!budgets) {
    if (enforce) {
      throw new ShardError('perf/no-budgets', `No budgets to resolve "${key}" against`, {
        hint: 'pnpm bench passes them in SHARD_BUDGETS; run tests through it or through testFiles().',
      })
    }
    return { limit: Number.POSITIVE_INFINITY, reference: null, kind: 'target' }
  }
  const on = enforce && budgets.enforce
  const span = budgets.spans[key]
  if (span) {
    let reference = span.value
    if (reference !== null && span.kind === 'unit') reference *= opts.count ?? 1
    if (reference !== null && span.kind === 'guard') reference *= 1 + (span.margin ?? 0)
    const off = span.kind === 'rate' ? 0 : Number.POSITIVE_INFINITY
    return { limit: on && reference !== null ? reference : off, reference, kind: span.kind }
  }
  const scenario = budgets.scenarios[key]
  if (!scenario) throw unknownBudget(key)
  const track: Track = opts.track ?? (opts.slice?.startsWith('gpu:') ? 'gpu' : 'cpu')
  const slices = scenario.slices[track]
  if (opts.slice !== undefined && !(opts.slice in slices)) {
    throw unknownBudget(key, ` slice "${opts.slice}" (${track})`)
  }
  const reference = opts.slice !== undefined ? slices[opts.slice]! : scenario.frame[track]
  return {
    limit: on && reference !== null ? reference : Number.POSITIVE_INFINITY,
    reference,
    kind: 'slice',
  }
}

let resolved: ResolvedBudgets | undefined
let parsed = false

function budgets(): ResolvedBudgets | undefined {
  if (!parsed) {
    parsed = true
    if (env.SHARD_BUDGETS) resolved = JSON.parse(env.SHARD_BUDGETS) as ResolvedBudgets
  }
  return resolved
}

/** The last `budget(key)` call, for `scripts/perf-report.setup.mjs` (under `pnpm bench` only). */
export interface BudgetCall extends ResolvedLimit {
  key: string
  opts: BudgetOptions
  used: boolean
}

/**
 * A time budget from `bench/perf/budgets.json`: the detected machine's number under `pnpm bench`,
 * unlimited in `pnpm test`, CI, and on an unknown machine (∞; 0 for a rate, which is a floor).
 * `{ count }` scales a unit cost; `{ slice, track }` reads a scenario's slice. An unknown key throws
 * `perf/unknown-budget`.
 *
 * `budget(ms)`, a literal, still works (exact under `pnpm bench`): `scripts/budget-literals.mjs`
 * lists those calls, and the goal is none.
 */
export function budget(key: string, opts?: BudgetOptions): number
export function budget(ms: number): number
export function budget(key: string | number, opts: BudgetOptions = {}): number {
  if (typeof key === 'number') return key * slack
  const bench = timingMode === 'bench'
  const data = budgets()
  const result = resolveLimit(data, key, opts, bench)
  if (bench && env.SHARD_PERF_REPORT) {
    const call: BudgetCall = { key, opts, used: false, ...result }
    ;(globalThis as { __shardBudget?: BudgetCall }).__shardBudget = call
  }
  return result.limit
}

/** A test or hook timeout in ms: 5× in CI, unchanged everywhere else. */
export function timeout(ms: number): number {
  return timingMode === 'ci' ? ms * 5 : ms
}

interface GcObserver {
  observe(options: { entryTypes: string[] }): void
  disconnect(): void
}

const host = globalThis as unknown as {
  PerformanceObserver: new (
    callback: (list: { getEntries(): { startTime: number }[] }) => void,
  ) => GcObserver
  performance: { now(): number }
  setTimeout(fn: () => void, ms: number): unknown
}

/**
 * Counts the garbage collections that start between now and `end()`, for "allocates nothing"
 * checks. GC entries are delivered asynchronously, so `end()` waits for them, but it only counts
 * the ones that started inside the window: what the test runner allocates while we wait isn't the
 * code under test. Collect garbage (`gc()`, with `--expose-gc`) before opening the window.
 */
export function gcWindow(): { end(): Promise<number> } {
  const starts: number[] = []
  const observer = new host.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) starts.push(entry.startTime)
  })
  observer.observe({ entryTypes: ['gc'] })
  const from = host.performance.now()
  return {
    async end() {
      const to = host.performance.now()
      await new Promise<void>((resolve) => host.setTimeout(resolve, 50))
      observer.disconnect()
      let count = 0
      for (const start of starts) if (start >= from && start <= to) count++
      return count
    },
  }
}

/**
 * Whether "allocates nothing" checks run: under `pnpm bench` only. When V8 optimizes (and so whether
 * a call boxes its result) depends on the CPU and on what else is running.
 */
export const allocationChecks = timingMode === 'bench'
