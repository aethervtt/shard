// Checks that a change leaves the WGSL WebGPU runs byte-identical (0064's "no cost on WebGPU"):
// runs every package's tests, recording each shader variant they link, then either writes the
// record or compares it with one made before the change.
//
//   node scripts/wgsl-identity.mjs record <file.json>   # before
//   node scripts/wgsl-identity.mjs check <file.json>    # after: fails on any variant that changed
//
// A variant is its root module, defines and overrides; baseline-tier variants carry the BASELINE
// define, so they're new keys and never compared. Extra arguments go to turbo (e.g. --filter).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [mode, file, ...rest] = process.argv.slice(2)
if ((mode !== 'record' && mode !== 'check') || !file) {
  console.error('Usage: node scripts/wgsl-identity.mjs record|check <file.json> [turbo args]')
  process.exit(3)
}

const dir = mkdtempSync(join(tmpdir(), 'shard-wgsl-'))
const result = spawnSync(
  'pnpm',
  ['exec', 'turbo', 'run', 'test', '--force', '--continue', ...rest],
  {
    stdio: 'inherit',
    // pnpm is a .cmd shim on Windows, which only a shell can start.
    shell: process.platform === 'win32',
    env: { ...process.env, SHARD_WGSL_LOG: dir },
  },
)
if (result.status !== 0) console.warn('Some tests failed; the record covers what ran.')

const variants = {}
const unstable = new Set()
for (const name of readdirSync(dir)) {
  for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
    if (!line) continue
    const [key, hash] = line.split('\t')
    if (variants[key] && variants[key] !== hash) unstable.add(key)
    variants[key] = hash
  }
}
rmSync(dir, { recursive: true, force: true })
// Tests that register different code under one module path (fixtures, hot reload) link one key to
// several codes: those say nothing about the engine, and aren't compared.
for (const key of unstable) delete variants[key]
const sorted = Object.fromEntries(Object.entries(variants).sort(([a], [b]) => (a < b ? -1 : 1)))
if (unstable.size > 0)
  console.log(`${unstable.size} variant(s) differ within the run (test fixtures); not compared.`)

if (mode === 'record') {
  writeFileSync(file, `${JSON.stringify(sorted, null, 1)}\n`)
  console.log(`Recorded ${Object.keys(sorted).length} variants to ${file}.`)
  process.exit(0)
}

const before = JSON.parse(readFileSync(file, 'utf8'))
const changed = []
const missing = []
for (const [key, hash] of Object.entries(before)) {
  if (unstable.has(key)) continue
  if (!(key in sorted)) missing.push(key)
  else if (sorted[key] !== hash) changed.push(key)
}
const added = Object.keys(sorted).filter((key) => !(key in before))
console.log(
  `${Object.keys(before).length} recorded, ${Object.keys(sorted).length} now: ${changed.length} changed, ${missing.length} not linked this run, ${added.length} new.`,
)
for (const key of missing) console.log(`  not linked: ${key}`)
for (const key of changed) console.error(`  CHANGED: ${key}`)
process.exit(changed.length > 0 ? 1 : 0)
