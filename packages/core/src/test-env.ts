/**
 * How strict tests are about time, in one place.
 *
 * - `pnpm bench` (`SHARD_BENCH`) holds the exact budgets from the specs, one file at a time.
 * - `pnpm test` allows 3×, for a machine busy running test files in parallel.
 * - CI (`SHARD_CI`) checks correctness only. Shared runners render with a software GPU, so their
 *   timings say nothing about the engine; budgets are unlimited there and timeouts are 5× longer.
 */

export type TimingMode = 'bench' | 'test' | 'ci'

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

export const timingMode: TimingMode = env.SHARD_BENCH ? 'bench' : env.SHARD_CI ? 'ci' : 'test'

/** The factor budgets are multiplied by (and rate floors divided by) in this mode. */
export const slack =
  timingMode === 'bench' ? 1 : timingMode === 'test' ? 3 : Number.POSITIVE_INFINITY

/** A time budget in ms: exact under `pnpm bench`, 3× in `pnpm test`, unlimited in CI. */
export function budget(ms: number): number {
  return ms * slack
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
 * Whether "allocates nothing" checks run. They hold under `pnpm bench` and `pnpm test`; CI turns them
 * off with the time budgets, since when V8 optimizes (and so whether a call boxes its result) depends
 * on the runner's CPU and timing.
 */
export const allocationChecks = timingMode !== 'ci'
