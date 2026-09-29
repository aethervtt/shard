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
 */

export type TimingMode = 'bench' | 'test' | 'ci'

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

export const timingMode: TimingMode = env.SHARD_BENCH ? 'bench' : env.SHARD_CI ? 'ci' : 'test'

/** The factor budgets are multiplied by (and rate floors divided by): 1 under `pnpm bench`, else ∞. */
export const slack = timingMode === 'bench' ? 1 : Number.POSITIVE_INFINITY

/** A time budget in ms: exact under `pnpm bench`, unlimited in `pnpm test` and CI. */
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
 * Whether "allocates nothing" checks run: under `pnpm bench` only. When V8 optimizes (and so whether
 * a call boxes its result) depends on the CPU and on what else is running.
 */
export const allocationChecks = timingMode === 'bench'
