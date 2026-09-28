/** `include` (and `passWithNoTests`) for a vitest config: only this CI runner's test files. */
export function testFiles(patterns?: string[]): { include: string[]; passWithNoTests?: boolean }
