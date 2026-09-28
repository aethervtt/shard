// Splits the test suite across CI runners. With SHARD_TEST_SHARD=<index>/<count> (1-based), each
// package's vitest config includes only the test files assigned to that runner; without it,
// everything runs.
//
// The slow files in test-weights.json are spread so every runner gets about the same time
// (longest first, each to the least-loaded runner). Every other file goes by a hash of its path.
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

/** Runner (1-based) of each weighted file. */
function weighted(count) {
  const { files } = JSON.parse(readFileSync(join(repo, 'scripts/test-weights.json'), 'utf8'))
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
 */
export function testFiles(patterns = ['src/**/*.test.ts']) {
  const spec = process.env.SHARD_TEST_SHARD
  if (!spec) return { include: patterns }
  const { index, count } = parse(spec)
  const assigned = weighted(count)
  const pkg = relative(repo, process.cwd())
  const mine = globSync(patterns, { cwd: process.cwd() }).filter((file) => {
    const path = `${pkg}/${file}`.split('\\').join('/')
    return (assigned.get(path) ?? hashed(path, count)) === index
  })
  // A package can have no files on a runner; vitest fails on an empty include unless told not to.
  return {
    include: mine.length > 0 ? mine.sort() : ['<none on this runner>'],
    passWithNoTests: true,
  }
}
