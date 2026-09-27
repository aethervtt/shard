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
