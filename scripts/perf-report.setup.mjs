// Loaded into every test file by testFiles() when SHARD_PERF_REPORT is set (pnpm bench, spec 0075):
// records what each assertion against a budget key measured, so bench/perf/report.json has a
// measured value per key. Tests keep writing `expect(ms).toBeLessThan(budget('ui/layout'))`.
//
// budget(key) notes its call on globalThis.__shardBudget (packages/core/src/test-env.ts). The
// comparison matchers below are vitest's own, plus a check: when the value they compare against is
// the one the last budget() call returned, they append `{ key, opts, measured, limit }` to
// `<SHARD_PERF_REPORT>/<pid>.jsonl`, one file per worker.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'

const dir = process.env.SHARD_PERF_REPORT

/** Appends a record when `expected` is what the last budget() call returned. */
export function noteBudget(file, received, expected, state, pass) {
  const call = globalThis.__shardBudget
  if (!call || call.used || typeof received !== 'number') return false
  if (expected !== call.limit) return false
  call.used = true
  const record = {
    key: call.key,
    opts: call.opts,
    measured: received,
    limit: call.limit,
    reference: call.reference,
    kind: call.kind,
    // The test's own comparison (`<`, `<=`, …) decides the verdict, not the report.
    ...(pass === undefined ? {} : { pass }),
    test: state.currentTestName,
    file: state.testPath,
  }
  appendFileSync(file, `${JSON.stringify(record)}\n`)
  return true
}

const COMPARISONS = {
  toBeLessThan: ['<', (a, b) => a < b],
  toBeLessThanOrEqual: ['<=', (a, b) => a <= b],
  toBeGreaterThan: ['>', (a, b) => a > b],
  toBeGreaterThanOrEqual: ['>=', (a, b) => a >= b],
}

/** Comparison matchers that behave like vitest's and note budget comparisons in `file`. */
export function budgetMatchers(file, state = () => expect.getState()) {
  const matchers = {}
  for (const [name, [op, compare]] of Object.entries(COMPARISONS)) {
    matchers[name] = function (received, expected) {
      const pass = compare(received, expected)
      noteBudget(file, received, expected, state(), pass)
      return {
        pass,
        message: () =>
          `expected ${this.utils.printReceived(received)} ${this.isNot ? 'not ' : ''}to be ${op} ${this.utils.printExpected(expected)}`,
        actual: received,
        expected,
      }
    }
  }
  return matchers
}

if (dir) {
  mkdirSync(dir, { recursive: true })
  expect.extend(budgetMatchers(join(dir, `${process.pid}.jsonl`)))
}
