// Interleaved A/B of #post's frame between two commits (0075's post-stack), for changes smaller
// than run-to-run noise: each commit is served from its own git worktree and Vite port, and
// rounds alternate A, B, B, A, … so thermal drift and background load hit both alike. Reports
// each side's median over rounds of gpu:frame p50 and frame-interval p50.
//
//   node scripts/post-ab.mjs <refA> <refB> [--rounds 4] [--sets all] [--query res=3024x1964]
//                            [--viewport 1512x982] [--out .shard/ab]
//
// The capture tooling runs from this checkout; both commits need #post's `?capture` page (f478e82
// or later). Run it alone: nothing else on the machine.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rounds: { type: 'string', default: '4' },
    sets: { type: 'string', default: 'all' },
    query: { type: 'string', multiple: true, default: ['res=3024x1964'] },
    viewport: { type: 'string', default: '1512x982' },
    out: { type: 'string', default: '.shard/ab' },
  },
})
const [refA, refB] = positionals
if (!refA || !refB) {
  console.error('Usage: node scripts/post-ab.mjs <refA> <refB> [--rounds 4]')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

/** A worktree of `ref` with its dependencies, served by Vite on `port`. */
async function serve(ref, port) {
  const sha = git('rev-parse', '--short', ref)
  const dir = join(root, '.shard/worktrees', sha)
  if (!existsSync(dir)) {
    git('worktree', 'add', '--detach', dir, sha)
    execFileSync('pnpm', ['install', '--offline', '--frozen-lockfile'], {
      cwd: dir,
      stdio: 'ignore',
    })
  }
  const vite = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: join(dir, 'apps/playground'),
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/`)
      if (res.ok) return { sha, vite }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  vite.kill()
  throw new Error(`Vite for ${ref} never answered on ${port}`)
}

const sides = [
  { ref: refA, port: 5181, rows: [] },
  { ref: refB, port: 5182, rows: [] },
]
for (const s of sides) Object.assign(s, await serve(s.ref, s.port))
const out = resolve(root, values.out)
mkdirSync(out, { recursive: true })
try {
  const rounds = Number(values.rounds)
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? [0, 1] : [1, 0]
    for (const i of order) {
      const s = sides[i]
      const dir = join(out, `${s.sha}-${r}`)
      const args = [
        join(root, 'scripts/post-baseline.mjs'),
        '--out',
        dir,
        '--sets',
        values.sets,
        '--port',
        String(s.port),
        '--viewport',
        values.viewport,
        ...values.query.flatMap((q) => ['--query', q]),
      ]
      execFileSync(process.execPath, args, { cwd: root, stdio: 'ignore' })
      const rows = JSON.parse(readFileSync(join(dir, 'baseline.json'), 'utf8'))
      s.rows.push(rows)
      const all = rows[0]
      console.log(
        `round ${r} ${s.sha}: gpu:frame p50 ${all.capture?.gpu?.p50?.toFixed(2)} interval p50 ${all.interval?.p50?.toFixed(2)}`,
      )
    }
  }
} finally {
  for (const s of sides) s.vite.kill()
}

const median = (v) => {
  const a = [...v].sort((x, y) => x - y)
  return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
}
const sets = values.sets.split(',')
const lines = [
  '| set | side | gpu:frame p50 (median of rounds) | rounds | interval p50 | frames over 12.5 ms |',
  '|---|---|---|---|---|---|',
]
const summary = {}
for (const [k, set] of sets.entries()) {
  for (const s of sides) {
    const gpu = s.rows.map((rows) => rows[k].capture.gpu.p50)
    const interval = s.rows.map((rows) => rows[k].interval.p50)
    const missed = s.rows.map((rows) => rows[k].missed.count)
    summary[`${set}/${s.sha}`] = { gpu, interval, missed }
    lines.push(
      `| ${set} | ${s.ref} (${s.sha}) | ${median(gpu).toFixed(2)} | ${gpu.map((g) => g.toFixed(2)).join(', ')} | ${median(interval).toFixed(2)} | ${median(missed)} |`,
    )
  }
  const a = sides[0].rows.map((rows) => rows[k].capture.gpu.p50)
  const b = sides[1].rows.map((rows) => rows[k].capture.gpu.p50)
  lines.push(`| ${set} | B − A | ${(median(b) - median(a)).toFixed(2)} | | | |`)
}
writeFileSync(join(out, 'ab.json'), `${JSON.stringify(summary, null, 2)}\n`)
writeFileSync(join(out, 'ab.md'), `${lines.join('\n')}\n`)
console.log(`\n${lines.join('\n')}`)
