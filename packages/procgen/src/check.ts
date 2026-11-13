/** A call a generator module makes that can't be deterministic. */
export interface NondeterministicCall {
  file: string
  line: number
  column: number
  call: string
  /** Why it's flagged and what to use instead, when it isn't the clock or Math.random. */
  message?: string
}

const MESH = '@aethervtt/shard-mesh'

/**
 * The `Math` functions engines compute differently in the last bits, which a `deterministicMath`
 * generator can't call, and what to use instead.
 */
export const NONDETERMINISTIC_MATH: Readonly<Record<string, string>> = {
  sin: `Use dsin(x) from ${MESH}.`,
  cos: `Use dcos(x) from ${MESH}.`,
  tan: `Use dsin(x) / dcos(x), or sinCos(x, out), from ${MESH}.`,
  asin: `Use datan2(x, Math.sqrt(1 - x * x)) from ${MESH}.`,
  acos: `Use datan2(Math.sqrt(1 - x * x), x) from ${MESH}.`,
  atan: `Use datan2(x, 1) from ${MESH}.`,
  atan2: `Use datan2(y, x) from ${MESH}.`,
  sinh: `Use (dexp(x) - dexp(-x)) / 2 (dexp from ${MESH}).`,
  cosh: `Use (dexp(x) + dexp(-x)) / 2 (dexp from ${MESH}).`,
  tanh: `Use 1 - 2 / (dexp(2 * x) + 1) (dexp from ${MESH}).`,
  asinh: `Use dlog(x + Math.sqrt(x * x + 1)) (dlog from ${MESH}).`,
  acosh: `Use dlog(x + Math.sqrt(x * x - 1)) (dlog from ${MESH}).`,
  atanh: `Use 0.5 * dlog((1 + x) / (1 - x)) (dlog from ${MESH}).`,
  exp: `Use dexp(x) from ${MESH}.`,
  expm1: `Use dexp(x) - 1 (dexp from ${MESH}).`,
  log: `Use dlog(x) from ${MESH}.`,
  log1p: `Use dlog(1 + x) (dlog from ${MESH}).`,
  log2: `Use dlog(x) / Math.LN2 (dlog from ${MESH}).`,
  log10: `Use dlog(x) / Math.LN10 (dlog from ${MESH}).`,
  pow: `Use dpow(x, y) from ${MESH}.`,
  cbrt: `Use Math.sign(x) * dpow(Math.abs(x), 1 / 3) (dpow from ${MESH}).`,
  hypot: 'Use Math.sqrt(x * x + y * y).',
}

const DEFINES = /\.generator\s*\(|\bdefineGenerator\s*\(/
const DETERMINISTIC = /\bdeterministicMath\s*:\s*true\b/
const CALLS = /\b(Math\.random|Date\.now|performance\.now)\s*\(/g
const MATH = new RegExp(`\\bMath\\.(${Object.keys(NONDETERMINISTIC_MATH).join('|')})\\b`, 'g')
const POWER = /\*\*=?/g
/** Exponents every engine computes exactly or with one rounding: x ** 0, x ** 1, x ** 2. */
const EXACT_EXPONENT = /^\s*[012](?![\w.])/
/** `2 ** n` with an integer literal n, an exact power of two. */
const POWER_OF_TWO = /(?:^|[^\w.$])2\s*$/
const INTEGER = /^\s*\d+(?![\w.])/

/**
 * Finds `Math.random()`, `Date.now()`, and `performance.now()` in modules that define generators
 * (`project.generator(` or `defineGenerator(`), for `shard check`. Comments and strings are
 * skipped. In a module whose generator has `deterministicMath: true`, it also finds the
 * transcendental `Math` functions (`NONDETERMINISTIC_MATH`) and `**`, which the runtime guard
 * can't trap. `**` is left alone when the result is exact or one rounding in every engine: an
 * exponent of 0, 1, or 2, or `2 ** n` for an integer literal n.
 */
export function findNondeterminism(file: string, source: string): NondeterministicCall[] {
  if (!DEFINES.test(source)) return []
  const code = blankText(source)
  const found: { index: number; call: string; message?: string }[] = []
  CALLS.lastIndex = 0
  for (let m = CALLS.exec(code); m; m = CALLS.exec(code)) {
    found.push({ index: m.index, call: `${m[1]}()` })
  }
  if (DETERMINISTIC.test(code)) {
    MATH.lastIndex = 0
    for (let m = MATH.exec(code); m; m = MATH.exec(code)) {
      found.push({
        index: m.index,
        call: `Math.${m[1]}()`,
        message: `Math.${m[1]}() in a module with a deterministicMath generator: engines differ in its last bits. ${NONDETERMINISTIC_MATH[m[1]!]}`,
      })
    }
    POWER.lastIndex = 0
    for (let m = POWER.exec(code); m; m = POWER.exec(code)) {
      const after = code.slice(m.index + m[0].length)
      if (EXACT_EXPONENT.test(after)) continue
      if (m[0] === '**' && INTEGER.test(after) && POWER_OF_TWO.test(code.slice(0, m.index))) {
        continue
      }
      found.push({
        index: m.index,
        call: m[0],
        message: `${m[0]} in a module with a deterministicMath generator: engines differ in the last bits of most powers. Use dpow(x, y) from ${MESH} (exact for integer powers that are representable), or x * x.`,
      })
    }
  }
  found.sort((a, b) => a.index - b.index)
  const out: NondeterministicCall[] = []
  for (const f of found) {
    const before = code.slice(0, f.index)
    const line = before.split('\n').length
    const column = f.index - before.lastIndexOf('\n')
    const call: NondeterministicCall = { file, line, column, call: f.call }
    if (f.message) call.message = f.message
    out.push(call)
  }
  return out
}

/**
 * The source with comments and the text of strings and template literals blanked out (template
 * `${…}` expressions are kept), at the same offsets and with the same line breaks. Regex literals
 * aren't recognized: one holding a quote can blank the rest of its line.
 */
function blankText(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '
  }
  // Open template literals, each with the brace depth of the `${` that entered its expression.
  const templates: number[] = []
  let depth = 0
  let i = 0
  const n = source.length
  // Scans template text from i (after the backtick or the closing brace) to its end or a `${`.
  const templateText = () => {
    const start = i
    while (i < n) {
      const c = source[i]!
      if (c === '\\') i += 2
      else if (c === '`') {
        blank(start, i)
        i++
        return
      } else if (c === '$' && source[i + 1] === '{') {
        blank(start, i)
        i += 2
        templates.push(depth)
        depth++
        return
      } else i++
    }
    blank(start, n)
  }
  while (i < n) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? n : end)
      i = end === -1 ? n : end
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      blank(i, end === -1 ? n : end + 2)
      i = end === -1 ? n : end + 2
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1
      blank(i + 1, Math.min(j, n))
      i = j + 1
    } else if (c === '`') {
      i++
      templateText()
    } else if (c === '{') {
      depth++
      i++
    } else if (c === '}') {
      depth--
      i++
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop()
        templateText()
      }
    } else i++
  }
  return out.join('')
}
