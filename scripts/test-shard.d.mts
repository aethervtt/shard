/**
 * `include` (and `passWithNoTests`) for a vitest config: only this CI runner's test files. In CI,
 * `retry: 1` too.
 */
export function testFiles(patterns?: string[]): {
  include: string[]
  passWithNoTests?: boolean
  retry?: number
}
