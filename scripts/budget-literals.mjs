// Lists the `budget(<number>)` calls left in tests (spec 0075): every time budget belongs in
// bench/perf/budgets.json, read by key with `budget('ui/layout')`. Counts calls in files that
// import `budget` from test-env whose first argument isn't a string literal. The goal is zero.
//
//   node scripts/budget-literals.mjs           print them and the count
//   node scripts/budget-literals.mjs --check   also exit 1 when any is left
//   node scripts/budget-literals.mjs --json    { count, calls: [{ file, line, text }] }

import { globSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

const IMPORTS_BUDGET = /import\s*\{[^}]*\bbudget\b[^}]*\}\s*from\s*['"][^'"]*test-env['"]/
const CALL = /(?<![\w.])budget\(\s*([^\s)])/g

/** The calls in one file's source whose first argument isn't a string. */
export function literalCalls(source) {
  if (!IMPORTS_BUDGET.test(source)) return []
  const out = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(CALL)) {
      if (!`'"\``.includes(m[1])) out.push({ line: i + 1, text: lines[i].trim() })
    }
  }
  return out
}

export function findLiteralCalls(root = repo) {
  const files = globSync(['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'examples/*/**/*.ts'], {
    cwd: root,
  })
    // test-env's own tests call budget(ms) on purpose: it keeps working.
    .filter((path) => !/node_modules|core[\\/]src[\\/]test-env/.test(path))
    .sort()
  const calls = []
  for (const file of files) {
    for (const call of literalCalls(readFileSync(join(root, file), 'utf8'))) {
      calls.push({ file: relative(root, join(root, file)).split('\\').join('/'), ...call })
    }
  }
  return calls
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = new Set(process.argv.slice(2))
  const calls = findLiteralCalls()
  if (args.has('--json')) console.log(JSON.stringify({ count: calls.length, calls }, null, 2))
  else {
    for (const c of calls) console.log(`${c.file}:${c.line}  ${c.text}`)
    console.log(`${calls.length} budget() call${calls.length === 1 ? '' : 's'} with a number left`)
  }
  if (args.has('--check') && calls.length > 0) process.exit(1)
}
