// The #post page's real-browser baseline (0075's post-stack): `shard capture` over
// apps/playground/plans/post.json once per `?effects=` set, one at a time, then a table of frame
// interval and gpu:frame per set. Each effect's cost is its set's gpu:frame minus `none`'s.
//
//   node scripts/post-baseline.mjs [--out .shard/post-baseline] [--sets all,none,bloom]
//     [--query res=3024x1964] [--viewport 1512x982] [--scale 0.8] [--frames 600]
//     [--ablate [--passes tonemap,gizmos]] [--port 5181] [--chromium]
//
// Runs headed in the installed Chrome (`--chromium`: Playwright's), so frames pace to the display.
// Needs the playground's dev server (`pnpm playground`). Run it alone: nothing else on the machine.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.shard/post-baseline' },
    sets: { type: 'string' },
    ablate: { type: 'boolean' },
    query: { type: 'string', multiple: true },
    chromium: { type: 'boolean' },
    frames: { type: 'string', default: '600' },
    viewport: { type: 'string' },
    scale: { type: 'string' },
    passes: { type: 'string' },
    port: { type: 'string' },
  },
})

const EFFECTS = [
  'bloom',
  'exposure',
  'dof',
  'motion-blur',
  'taa',
  'ssao',
  'fog',
  'grading',
  'vignette',
]
const sets = values.sets ? values.sets.split(',') : ['all', 'none', ...EFFECTS]
const base = JSON.parse(readFileSync(join(root, 'apps/playground/plans/post.json'), 'utf8'))
const out = resolve(root, values.out)
mkdirSync(out, { recursive: true })

const rows = []
for (const set of sets) {
  const url = new URL(base.url)
  if (values.port) url.port = values.port
  if (set !== 'all') url.searchParams.set('effects', set === 'none' ? '' : set)
  for (const q of values.query ?? []) {
    const [k, v = ''] = q.split('=')
    url.searchParams.set(k, v)
  }
  const steps = [...base.steps]
  steps.find((s) => s.name === 'profile').args.frames = Number(values.frames)
  if (values.ablate) {
    const passes = values.passes ? values.passes.split(',') : undefined
    steps.push({
      name: 'ablate',
      args: { frames: 60, rounds: 5, ...(passes && { passes, together: true }) },
    })
  }
  const plan = { ...base, url: url.toString(), steps }
  if (values.viewport) plan.viewport = values.viewport.split('x').map(Number)
  // The plan pins the render scale after the page loads, so `?scale=` alone wouldn't hold.
  if (values.scale) {
    url.searchParams.set('scale', values.scale)
    plan.url = url.toString()
    plan.conditions = { renderScale: { mode: 'fixed', scale: Number(values.scale) } }
  }
  const dir = join(out, set)
  mkdirSync(dir, { recursive: true })
  const planFile = join(dir, 'plan.json')
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`)
  console.log(`\n== ${set}: ${plan.url}`)
  const args = [
    join(root, 'apps/cli/bin/shard.mjs'),
    'capture',
    planFile,
    '--out',
    dir,
    '--headed',
    '--json',
  ]
  if (!values.chromium) args.push('--channel', 'chrome')
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch {
    // A threshold miss exits non-zero; the record is still there.
  }
  const record = readJson(join(dir, 'records/post-stack/chromium@2x-main.json'))
  const profile = readJson(join(dir, 'results/chromium@2x-main/profile.json'))
  const ablation = readJson(join(dir, 'results/chromium@2x-main/ablate.json'))
  if (profile?.trace) {
    writeFileSync(join(dir, 'trace.json'), JSON.stringify(profile.trace))
    delete profile.trace
    writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(profile.summary, null, 2)}\n`)
  }
  const s = profile?.summary
  // Frames that missed a vsync: rAF callbacks jitter by a millisecond either way (7.4 + 9.3 ms
  // pairs at 120 Hz), so interval percentiles overstate; an interval past 1.5 refreshes is a miss.
  const starts = frameStarts(dir)
  const intervals = starts.slice(1).map((t, i) => t - starts[i])
  const refresh = 1000 / 120
  const missed = intervals.filter((ms) => ms > refresh * 1.5).length
  rows.push({
    set,
    canvas: url.searchParams.get('res'),
    missed: { count: missed, of: intervals.length, refreshMs: refresh },
    interval: record?.frameTime,
    gpuP95: record?.frameTime?.gpuP95,
    capture: s && {
      interval: s.frames.interval,
      cpu: s.frames.cpu,
      gpu: s.frames.gpu,
    },
    ablation: ablation && {
      frameMs: ablation.frameMs,
      passes: [...ablation.passes].sort((a, b) => b.ms - a.ms),
      together: ablation.together,
    },
  })
  writeFileSync(join(out, 'baseline.json'), `${JSON.stringify(rows, null, 2)}\n`)
}

const none = rows.find((r) => r.set === 'none')?.capture?.gpu?.p50
const f = (n) => (typeof n === 'number' ? n.toFixed(2) : '—')
const lines = [
  '| set | interval p50 | p95 | p99 | missed vsyncs | gpu:frame p50 | gpu:frame p95 | cpu frame p50 | Δ gpu p50 vs none |',
  '|---|---|---|---|---|---|---|---|---|',
]
for (const r of rows) {
  const i = r.interval ?? {}
  const g = r.capture?.gpu ?? {}
  lines.push(
    `| ${r.set} | ${f(i.p50)} | ${f(i.p95)} | ${f(i.p99)} | ${r.missed.count}/${r.missed.of} | ${f(g.p50)} | ${f(g.p95)} | ${f(r.capture?.cpu?.p50)} | ${none !== undefined && g.p50 !== undefined ? f(g.p50 - none) : '—'} |`,
  )
}
writeFileSync(join(out, 'baseline.md'), `${lines.join('\n')}\n`)
console.log(`\n${lines.join('\n')}`)

/** Frame starts (ms) from the capture's trace. */
function frameStarts(dir) {
  const trace = readJson(join(dir, 'trace.json'))
  const events = Array.isArray(trace) ? trace : (trace?.traceEvents ?? [])
  return events
    .filter((e) => e.name === 'frame' && e.ph === 'X')
    .map((e) => e.ts / 1000)
    .sort((a, b) => a - b)
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}
