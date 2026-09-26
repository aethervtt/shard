/** A call a generator module makes that can't be deterministic. */
export interface NondeterministicCall {
  file: string
  line: number
  column: number
  call: string
}

const DEFINES = /\.generator\s*\(|\bdefineGenerator\s*\(/
const CALLS = /\b(Math\.random|Date\.now|performance\.now)\s*\(/g

/**
 * Finds `Math.random()`, `Date.now()`, and `performance.now()` in modules that define generators
 * (`project.generator(` or `defineGenerator(`), for `shard check`. Comments are skipped.
 */
export function findNondeterminism(file: string, source: string): NondeterministicCall[] {
  if (!DEFINES.test(source)) return []
  // Blank out comments, keeping offsets (and line breaks) so positions stay right.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
  const out: NondeterministicCall[] = []
  CALLS.lastIndex = 0
  for (let m = CALLS.exec(code); m; m = CALLS.exec(code)) {
    const before = code.slice(0, m.index)
    const line = before.split('\n').length
    const column = m.index - before.lastIndexOf('\n')
    out.push({ file, line, column, call: `${m[1]}()` })
  }
  return out
}
