// Performance budgets (spec 0075): which named machine this is, what each budget key resolves to
// there, whether budgets.json is well formed, and the report a bench run writes. Pure functions
// apart from `adapterInfo` and `loadPerf`, so scripts/bench.mjs and the tests share them.
//
// Budgets reach the test process as JSON in SHARD_BUDGETS (see packages/core/src/test-env.ts):
// scripts/bench.mjs resolves them for the detected machine; outside pnpm bench, testFiles()
// (scripts/test-shard.mjs) passes the keys with no machine, so a misspelt key fails everywhere.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PERF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

export const KINDS = ['target', 'unit', 'rate', 'guard']
export const TRACKS = ['gpu', 'cpu']

/** An error with a namespaced code and a hint, like ShardError (scripts can't import core). */
export class PerfError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

/** machines.json and budgets.json, parsed. */
export function loadPerf(dir = PERF_DIR) {
  return {
    machines: JSON.parse(readFileSync(join(dir, 'machines.json'), 'utf8')),
    budgets: JSON.parse(readFileSync(join(dir, 'budgets.json'), 'utf8')),
  }
}

/** The graphics API Dawn picked, from the adapter's description. */
export function backendOf(description = '') {
  const d = description.toLowerCase()
  if (d.includes('metal')) return 'metal'
  if (d.includes('d3d12')) return 'd3d12'
  if (d.includes('d3d11')) return 'd3d11'
  if (d.includes('vulkan')) return 'vulkan'
  if (d.includes('opengl es') || d.includes('opengles')) return 'opengles'
  if (d.includes('opengl')) return 'opengl'
  return undefined
}

/**
 * The adapter Node tests render on (Dawn, through the `webgpu` package, with SHARD_DAWN_OPTIONS as
 * `@aethervtt/shard-gpu/node` passes them). Undefined when there's no adapter.
 */
export async function adapterInfo(env = process.env) {
  try {
    const { create } = await import('webgpu')
    const options = env.SHARD_DAWN_OPTIONS?.split(';').filter(Boolean) ?? []
    const adapter = await create(options).requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return undefined
    const { vendor, architecture, device, description } = adapter.info
    return { vendor, architecture, device, description, backend: backendOf(description) }
  } catch {
    return undefined
  }
}

const has = (text, part) => !!part && (text ?? '').toLowerCase().includes(part.toLowerCase())

/** How well a machine entry matches: CPU and GPU 2 each, the backend 1. */
function score(machine, cpu, adapter) {
  const gpuText = adapter
    ? [adapter.vendor, adapter.architecture, adapter.device, adapter.description].join(' ')
    : ''
  const cpuMatch = has(cpu, machine.cpu)
  const gpuMatch = has(gpuText, machine.gpu)
  const backendMatch = !!adapter?.backend && adapter.backend === machine.backend
  return {
    cpu: cpuMatch,
    gpu: gpuMatch,
    backend: backendMatch,
    score: (cpuMatch ? 2 : 0) + (gpuMatch ? 2 : 0) + (backendMatch ? 1 : 0),
  }
}

/**
 * Which named machine this is. A machine matches when both its CPU and GPU strings do.
 * `override` (SHARD_MACHINE) wins; a detection that disagrees with it is a warning, as is a name
 * machines.json doesn't have (`perf/unknown-machine`, then the machine is unknown). On an unknown
 * machine `closest` names the entry that matched best (the first one when nothing did), whose
 * budgets the run reports against without enforcing them.
 */
export function detectMachine(machines, { cpu, adapter, override } = {}) {
  const names = Object.keys(machines.machines)
  const scored = names.map((name) => ({ name, ...score(machines.machines[name], cpu, adapter) }))
  const matched = scored.find((s) => s.cpu && s.gpu)
  let best = scored[0]
  for (const s of scored) if (s.score > best.score) best = s
  const warnings = []
  const detected = matched?.name ?? null
  let machine = detected
  let source = detected ? 'detected' : 'unknown'
  if (override) {
    if (names.includes(override)) {
      if (detected && detected !== override) {
        warnings.push({
          code: 'perf/machine-mismatch',
          message: `SHARD_MACHINE=${override}, but this looks like "${detected}"`,
        })
      }
      machine = override
      source = 'override'
    } else {
      warnings.push({
        code: 'perf/unknown-machine',
        message: `SHARD_MACHINE=${override} isn't in machines.json (${names.join(', ')})`,
      })
      machine = null
      source = 'unknown'
    }
  }
  if (!machine && !warnings.some((w) => w.code === 'perf/unknown-machine')) {
    warnings.push({
      code: 'perf/unknown-machine',
      message: `No machine in machines.json matches (CPU "${cpu ?? '?'}", GPU "${
        adapter ? `${adapter.vendor} ${adapter.description}` : 'none'
      }"): budgets are unlimited; reporting against "${best.name}"`,
    })
  }
  return { machine, source, detected, closest: machine ?? best?.name ?? null, warnings }
}

/**
 * What's wrong with budgets.json against machines.json: unknown kinds, entries without a note or a
 * number for every machine, guards without a margin, scenarios whose slices plus headroom don't sum
 * to 1 (`perf/slices-overflow`). Empty when it's fine.
 */
export function checkBudgets(budgets, machines) {
  const names = Object.keys(machines.machines)
  const problems = []
  const problem = (code, path, message) => problems.push({ code, path, message })
  for (const [key, entry] of Object.entries(budgets.spans ?? {})) {
    const path = `spans/${key}`
    if (!KINDS.includes(entry.kind)) {
      problem('perf/bad-budget', path, `kind "${entry.kind}" isn't one of ${KINDS.join(', ')}`)
    }
    if (typeof entry.note !== 'string' || entry.note.trim() === '') {
      problem('perf/bad-budget', path, 'every entry needs a note')
    }
    if (entry.kind === 'guard' && !(typeof entry.margin === 'number' && entry.margin >= 0)) {
      problem('perf/bad-budget', path, 'a guard needs a margin (a fraction, e.g. 0.1)')
    }
    if ((entry.kind === 'unit' || entry.kind === 'rate') && typeof entry.per !== 'string') {
      problem('perf/bad-budget', path, `a ${entry.kind} says what it's per ("per": "prop")`)
    }
    for (const name of names) {
      if (!(typeof entry[name] === 'number' && entry[name] > 0)) {
        problem('perf/bad-budget', path, `no positive number for machine "${name}"`)
      }
    }
  }
  for (const [name, scenario] of Object.entries(budgets.scenarios ?? {})) {
    const path = `scenarios/${name}`
    if (budgets.spans?.[name]) {
      problem('perf/bad-budget', path, 'a scenario and a span share this key')
    }
    if (typeof scenario.note !== 'string' || scenario.note.trim() === '') {
      problem('perf/bad-budget', path, 'every scenario needs a note')
    }
    for (const track of TRACKS) {
      const slices = scenario.slices?.[track]
      for (const machine of names) {
        if (!(scenario.frame?.[track]?.[machine] > 0)) {
          problem('perf/bad-budget', `${path}/frame/${track}`, `no frame budget for "${machine}"`)
        }
      }
      if (!slices) {
        problem(
          'perf/slices-overflow',
          `${path}/slices/${track}`,
          'no slices (headroom: 1 at least)',
        )
        continue
      }
      if (!('headroom' in slices)) {
        problem('perf/slices-overflow', `${path}/slices/${track}`, 'slices need a headroom')
      }
      let sum = 0
      for (const share of Object.values(slices)) sum += share
      if (Math.abs(sum - 1) > 1e-6) {
        problem(
          'perf/slices-overflow',
          `${path}/slices/${track}`,
          `slices plus headroom sum to ${+sum.toFixed(4)}, not 1`,
        )
      }
    }
    for (const [machine, tracks] of Object.entries(scenario.overrides ?? {})) {
      if (!names.includes(machine)) {
        problem('perf/bad-budget', `${path}/overrides/${machine}`, 'not a machine')
      }
      for (const [track, slices] of Object.entries(tracks)) {
        for (const slice of Object.keys(slices)) {
          if (!(slice in (scenario.slices?.[track] ?? {}))) {
            problem('perf/bad-budget', `${path}/overrides/${machine}/${track}`, `no slice ${slice}`)
          }
        }
      }
    }
  }
  return problems
}

/**
 * What tests read through SHARD_BUDGETS: every key with its number on `machine` (null numbers for
 * none, outside pnpm bench), and each scenario's frame and slices in ms. `enforce` is false on an
 * unknown machine: budget() stays unlimited, and the numbers are the closest machine's, to report
 * against.
 */
export function resolveBudgets(budgets, machine, { enforce = machine !== null, closest } = {}) {
  const on = machine ?? closest ?? null
  const value = (entry) => (on !== null && typeof entry[on] === 'number' ? entry[on] : null)
  const spans = {}
  for (const [key, entry] of Object.entries(budgets.spans ?? {})) {
    const out = { kind: entry.kind, value: value(entry) }
    if (entry.margin !== undefined) out.margin = entry.margin
    if (entry.per !== undefined) out.per = entry.per
    if (entry.in !== undefined) out.in = entry.in
    spans[key] = out
  }
  const scenarios = {}
  for (const [name, scenario] of Object.entries(budgets.scenarios ?? {})) {
    const frame = {}
    const slices = {}
    for (const track of TRACKS) {
      const ms = scenario.frame?.[track] ? value(scenario.frame[track]) : null
      frame[track] = ms
      slices[track] = {}
      const overrides = on !== null ? scenario.overrides?.[on]?.[track] : undefined
      for (const [slice, share] of Object.entries(scenario.slices?.[track] ?? {})) {
        const absolute = overrides?.[slice]
        slices[track][slice] =
          typeof absolute === 'number' ? absolute : ms === null ? null : ms * share
      }
    }
    scenarios[name] = { frame, slices }
  }
  return { machine: on, enforce: enforce && on !== null, spans, scenarios }
}

/** A key's limit from resolved budgets (the same rule as budget() in test-env). */
export function limitOf(resolved, key, opts = {}) {
  const span = resolved.spans[key]
  if (span) {
    if (span.value === null) return null
    if (span.kind === 'unit') return span.value * (opts.count ?? 1)
    if (span.kind === 'guard') return span.value * (1 + (span.margin ?? 0))
    return span.value
  }
  const scenario = resolved.scenarios[key]
  if (!scenario) return null
  const track = opts.track ?? (opts.slice?.startsWith('gpu:') ? 'gpu' : 'cpu')
  return opts.slice ? (scenario.slices[track]?.[opts.slice] ?? null) : scenario.frame[track]
}

/**
 * The report a bench run writes (bench/perf/report.json): per key, its budget, the worst measured
 * value (the highest; the lowest for a rate, which is a floor), and a verdict. `records` are what
 * scripts/perf-report.setup.mjs wrote, one per assertion against a budget key.
 */
export function buildReport({ budgets, resolved, records, detection, date }) {
  // A unit's budget, limit and measured value are per item, so runs with different counts compare.
  const keys = {}
  for (const [key, entry] of Object.entries(budgets.spans ?? {})) {
    keys[key] = {
      kind: entry.kind,
      ...(entry.per ? { per: entry.per } : {}),
      ...(entry.in ? { in: entry.in } : {}),
      budget: resolved.spans[key]?.value ?? null,
      limit: limitOf(resolved, key),
      measured: null,
      verdict: 'unmeasured',
      tests: [],
    }
  }
  for (const r of records) {
    // Scenario slices are keyed `<scenario>:<track>:<slice>` (or `<scenario>:<track>`).
    const scenario = !budgets.spans?.[r.key] && budgets.scenarios?.[r.key]
    const limit = limitOf(resolved, r.key, r.opts)
    let id = r.key
    if (scenario) {
      const track = r.opts?.track ?? (r.opts?.slice?.startsWith('gpu:') ? 'gpu' : 'cpu')
      id = [r.key, track, r.opts?.slice].filter(Boolean).join(':')
      keys[id] ??= { kind: 'slice', budget: limit, limit, measured: null, tests: [] }
    }
    keys[id] ??= { kind: 'unknown', budget: null, limit: null, measured: null, tests: [] }
    const k = keys[id]
    const count = k.kind === 'unit' ? (r.opts?.count ?? 1) : 1
    const measured = r.measured / count
    if (
      k.measured === null ||
      (k.kind === 'rate' ? measured < k.measured : measured > k.measured)
    ) {
      k.measured = measured
    }
    k.tests.push({ test: r.test, file: r.file, measured: r.measured, limit })
    if (r.pass !== undefined) k.failed = (k.failed ?? false) || !r.pass
  }
  for (const k of Object.values(keys)) {
    if (k.measured === null) k.verdict = 'unmeasured'
    else if (k.limit === null) k.verdict = 'unbudgeted'
    else if (k.failed !== undefined) k.verdict = k.failed ? 'over' : 'pass'
    else if (k.kind === 'rate') k.verdict = k.measured >= k.limit ? 'pass' : 'over'
    else k.verdict = k.measured < k.limit ? 'pass' : 'over'
    delete k.failed
  }
  const scenarios = {}
  for (const [name, s] of Object.entries(resolved.scenarios)) {
    const slices = {}
    for (const track of TRACKS) {
      slices[track] = {}
      for (const [slice, ms] of Object.entries(s.slices[track])) {
        // Part B fills in measured shares from captures.
        slices[track][slice] = {
          budget: ms,
          share: budgets.scenarios[name].slices[track][slice],
          measured: null,
        }
      }
    }
    scenarios[name] = { frame: s.frame, slices }
  }
  const over = Object.keys(keys).filter((k) => keys[k].verdict === 'over')
  return {
    version: 1,
    date,
    machine: resolved.machine,
    enforced: resolved.enforce,
    detection,
    over,
    keys,
    scenarios,
  }
}

/**
 * Guards a run beat by more than twice their margin (measured under value × (1 − 2 × margin)),
 * with the value to lower each to: the measured one, rounded up to two significant digits.
 */
export function ratchet(report, budgets) {
  const out = []
  if (!report.enforced) return out
  for (const [key, k] of Object.entries(report.keys)) {
    const entry = budgets.spans?.[key]
    if (entry?.kind !== 'guard' || k.measured === null || k.budget === null) continue
    if (k.measured < k.budget * (1 - 2 * entry.margin)) {
      const step = 10 ** (Math.floor(Math.log10(k.measured)) - 1)
      out.push({
        key,
        machine: report.machine,
        from: k.budget,
        to: Number((Math.ceil(k.measured / step) * step).toPrecision(2)),
        measured: k.measured,
      })
    }
  }
  return out
}
