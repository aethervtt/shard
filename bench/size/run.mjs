// Builds each size fixture with Vite (production, minified) and reports what a browser downloads:
// min, gzip and brotli bytes per chunk, and which packages each chunk carries.
//
//   pnpm size            print the table and write report.json
//   pnpm size --json     print the report as JSON
//   pnpm size --check    fail if a fixture's brotli size is over budgets.json by more than 2%
//                        (--budgets <file> checks against another file), if it bundles a
//                        package its budget forbids, or if baseline-only code reaches a chunk
//                        a WebGPU session loads
//
// Chunks are `entry`, `lazy`, or `fallback`: lazy chunks holding only the baseline tier's code
// (0064), which a WebGPU session never loads. `js` counts entry and lazy chunks; `fallback` apart.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../..')
const args = new Set(process.argv.slice(2))

const FIXTURES = {
  'renderer-min': join(here, 'fixtures/renderer-min'),
  'three-min': join(here, 'fixtures/three-min'),
  'physics-track': join(here, 'fixtures/physics-track'),
  'dice-worker': join(here, 'fixtures/dice-worker'),
  full: join(repo, 'apps/playground'),
}

/** The package a module belongs to: a workspace package by its directory, or an npm package. */
function packageOf(id) {
  const path = id.replace(/^\0/, '').split('?')[0]
  const npm = path.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/)
  if (npm) return npm[1]
  const workspace = path.match(/\/(packages|apps)\/([^/]+)\//)
  if (workspace)
    return workspace[1] === 'packages' ? `@aethervtt/shard-${workspace[2]}` : `apps/${workspace[2]}`
  const rel = relative(repo, path)
  return rel.startsWith('bench/') ? 'fixture' : rel.split('/')[0] || 'other'
}

/** Code only the baseline tier loads (0064): any package's `src/baseline/`, and the WebGL2 backend. */
function baselineOnly(id) {
  const path = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/')
  return /\/packages\/[^/]+\/src\/baseline\//.test(path) || /\/packages\/gpu-webgl2\//.test(path)
}

function sizes(bytes) {
  return {
    min: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }).length,
  }
}

async function measure(name, root) {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      sourcemap: false,
      reportCompressedSize: false,
      target: 'es2023',
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output)
  const chunks = []
  for (const out of outputs) {
    const isChunk = out.type === 'chunk'
    const bytes = Buffer.from(isChunk ? out.code : out.source)
    if (!isChunk && !/\.(wasm|js)$/.test(out.fileName)) continue
    const kind = isChunk
      ? out.isEntry
        ? 'entry'
        : 'lazy'
      : out.fileName.endsWith('.wasm')
        ? 'wasm'
        : 'asset'
    const packages = {}
    let fallback = false
    const baseline = []
    if (isChunk) {
      const ids = out.moduleIds ?? Object.keys(out.modules ?? {})
      for (const id of ids) {
        const rendered = out.modules?.[id]?.renderedLength ?? 0
        const pkg = packageOf(id)
        packages[pkg] = (packages[pkg] ?? 0) + rendered
        if (baselineOnly(id) && rendered > 0) baseline.push(id)
      }
      // Only baseline code, apart from bundler glue that renders to nothing.
      fallback =
        kind === 'lazy' &&
        baseline.length > 0 &&
        ids.every((id) => baselineOnly(id) || (out.modules?.[id]?.renderedLength ?? 0) === 0)
    }
    chunks.push({
      file: out.fileName,
      kind: fallback ? 'fallback' : kind,
      ...sizes(bytes),
      packages,
      baseline,
    })
  }
  chunks.sort((a, b) => b.brotli - a.brotli)
  const total = (kinds) =>
    chunks.filter((c) => kinds.includes(c.kind)).reduce((sum, c) => sum + c.brotli, 0)
  return {
    name,
    chunks,
    brotli: {
      entry: total(['entry']),
      js: total(['entry', 'lazy']),
      fallback: total(['fallback']),
      all: total(['entry', 'lazy', 'fallback', 'wasm', 'asset']),
    },
  }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const report = { version: 1, fixtures: {} }
for (const [name, root] of Object.entries(FIXTURES))
  report.fixtures[name] = await measure(name, root)
writeFileSync(join(here, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const f of Object.values(report.fixtures)) {
    console.log(
      `\n${f.name}: entry ${kb(f.brotli.entry)}, all JS ${kb(f.brotli.js)}, baseline fallback ${kb(f.brotli.fallback)}, everything ${kb(f.brotli.all)} (brotli)`,
    )
    for (const c of f.chunks.slice(0, 8)) {
      const top = Object.entries(c.packages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([p]) => p.replace('@aethervtt/shard-', ''))
        .join(', ')
      console.log(
        `  ${c.kind.padEnd(5)} ${kb(c.brotli).padStart(9)}  ${c.file}${top ? `  [${top}]` : ''}`,
      )
    }
  }
}

if (args.has('--check')) {
  const argv = process.argv.slice(2)
  const custom = argv.indexOf('--budgets')
  const budgetsFile = custom === -1 ? join(here, 'budgets.json') : resolve(argv[custom + 1])
  const budgets = JSON.parse(readFileSync(budgetsFile, 'utf8'))
  const over = []
  for (const [name, budget] of Object.entries(budgets.fixtures)) {
    const got = report.fixtures[name]?.brotli
    if (!got) continue
    const { forbid = [], ...limits } = budget
    for (const [key, limit] of Object.entries(limits)) {
      if (got[key] > limit * 1.02)
        over.push(`${name} ${key}: ${kb(got[key])} over its budget of ${kb(limit)}`)
    }
    const bundled = new Set(report.fixtures[name].chunks.flatMap((c) => Object.keys(c.packages)))
    for (const pkg of forbid) if (bundled.has(pkg)) over.push(`${name} bundles ${pkg}`)
  }
  // Baseline code a WebGPU session would load belongs behind an import() of its own (0064).
  for (const f of Object.values(report.fixtures)) {
    for (const c of f.chunks) {
      if (c.kind === 'fallback' || c.baseline.length === 0) continue
      const files = c.baseline.map((id) => relative(repo, id.replace(/^\0/, '').split('?')[0]))
      over.push(`${f.name}: baseline-only code in ${c.kind} chunk ${c.file}: ${files.join(', ')}`)
    }
  }
  if (over.length > 0) {
    console.error(`\nOver budget:\n  ${over.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\nWithin budget.')
}
