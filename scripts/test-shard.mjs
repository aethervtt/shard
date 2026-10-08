// Splits the test suite across CI runners. With SHARD_TEST_SHARD=<index>/<count> (1-based), each
// package's vitest config includes only the test files assigned to that runner; without it,
// everything runs.
//
// The slow files in test-weights.json (`files`, `windows` on Windows, and `browser` for the
// browser job, SHARD_BROWSER_TESTS) are spread so every
// runner gets about the same time (longest first, each to the least-loaded runner). Every other
// file goes by a hash of its path.
// A file's runner depends only on its own path and test-weights.json, never on which other files
// exist, so turbo's cached result for a package stays valid for the files it ran.

import { globSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

function parse(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(spec)
  const index = m ? Number(m[1]) : 0
  const count = m ? Number(m[2]) : 0
  if (!m || index < 1 || index > count) {
    throw new Error(`SHARD_TEST_SHARD must be <index>/<count>, 1-based (got "${spec}")`)
  }
  return { index, count }
}

/**
 * Runner (1-based) of each weighted file. Windows renders on WARP, which is slow in different
 * places than Linux's lavapipe, so it has its own table. So does the browser job: its files run
 * in Chromium only there (elsewhere they skip in moments), on runners of their own.
 */
function weighted(count) {
  const weights = JSON.parse(readFileSync(join(repo, 'scripts/test-weights.json'), 'utf8'))
  const files =
    process.env.SHARD_BROWSER_TESTS && weights.browser
      ? weights.browser
      : process.platform === 'win32' && weights.windows
        ? weights.windows
        : weights.files
  const load = new Array(count).fill(0)
  const out = new Map()
  const sorted = Object.entries(files).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  for (const [file, seconds] of sorted) {
    let best = 0
    for (let i = 1; i < count; i++) if (load[i] < load[best]) best = i
    load[best] += seconds
    out.set(file, best + 1)
  }
  return out
}

function hashed(path, count) {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193)
  return ((h >>> 0) % count) + 1
}

/**
 * `include` and `passWithNoTests` for a package's vitest config: `patterns` as is, or only this
 * runner's files when SHARD_TEST_SHARD is set. Runs in the package directory (turbo and pnpm do).
 * In CI (SHARD_CI) it also sets `retry: 1`, so one hiccup on a shared runner doesn't fail the run;
 * a test that needs the retry often belongs in TODO.md. With SHARD_WGSL_LOG, a setup file records
 * the shader variants the tests link (scripts/wgsl-identity.mjs).
 */
export function testFiles(patterns = ['src/**/*.test.ts']) {
  // SHARD_WGSL_LOG (wgsl-identity.mjs): record every shader variant the tests link.
  const extra = {
    ...(process.env.SHARD_CI ? { retry: 1 } : {}),
    ...(process.env.SHARD_WGSL_LOG
      ? { setupFiles: [join(repo, 'scripts/wgsl-log.setup.mjs')] }
      : {}),
  }
  const spec = process.env.SHARD_TEST_SHARD
  if (!spec) return { include: patterns, ...extra }
  const { index, count } = parse(spec)
  const assigned = weighted(count)
  const pkg = relative(repo, process.cwd())
  // `/`-separated: vitest reads `include` as globs, where Windows' `\` escapes and matches nothing.
  const mine = globSync(patterns, { cwd: process.cwd() })
    .map((file) => file.split('\\').join('/'))
    .filter((file) => {
      const path = `${pkg}/${file}`.split('\\').join('/')
      return (assigned.get(path) ?? hashed(path, count)) === index
    })
  // A package can have no files on a runner; vitest fails on an empty include unless told not to.
  return {
    include: mine.length > 0 ? mine.sort() : ['<none on this runner>'],
    passWithNoTests: true,
    ...extra,
  }
}
