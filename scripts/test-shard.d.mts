/**
 * `include` (and `passWithNoTests`) for a vitest config: only this CI runner's test files. In CI,
 * `retry: 1` too. `env.SHARD_BUDGETS` carries the resolved time budgets (spec 0075).
 */
export function testFiles(patterns?: string[]): {
  include: string[]
  passWithNoTests?: boolean
  retry?: number
  setupFiles?: string[]
  env: { SHARD_BUDGETS: string }
}
