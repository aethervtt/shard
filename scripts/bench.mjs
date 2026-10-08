// pnpm bench: the ECS benchmarks, then every test file serially at the budgets of the machine it
// runs on, with allocation checks on (SHARD_BENCH; see packages/core/src/test-env.ts). A script
// rather than an inline `SHARD_BENCH=1 ...` so it runs under Windows' shell too.
//
// Budgets (spec 0075): it detects which machine of bench/perf/machines.json this is (the CPU model
// and the Dawn adapter; SHARD_MACHINE=<name> overrides), resolves every key of
// bench/perf/budgets.json for it, and passes them to the tests as JSON in SHARD_BUDGETS. On an
// unknown machine nothing is enforced: it measures and reports against the closest machine. Each
// assertion against a key is recorded (scripts/perf-report.setup.mjs), and bench/perf/report.json
// gets the budget, the measured value and a verdict per key.
//
//   pnpm bench                       everything
//   pnpm bench --dry-run             print the machine and the resolved budgets, run nothing
//   pnpm bench --ratchet             also propose lowering guards the run beat by twice their margin
//   pnpm bench --scenario <name>     only the scenario's tests (named "scenario: <name> …")
//
// Other arguments go to turbo, e.g. `pnpm bench --filter=@aethervtt/shard-physics`.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  adapterInfo,
  buildReport,
  checkBudgets,
  detectMachine,
  loadPerf,
  PERF_DIR,
  PerfError,
  ratchet,
  resolveBudgets,
} from '../bench/perf/src/perf.mjs'

/** Splits bench's own flags from what goes to turbo. */
export function parseArgs(argv) {
  const out = { dryRun: false, ratchet: false, scenario: undefined, json: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--ratchet') out.ratchet = true
    else if (a === '--json') out.json = true
    else if (a === '--scenario') out.scenario = argv[++i]
    else if (a.startsWith('--scenario=')) out.scenario = a.slice('--scenario='.length)
    else out.rest.push(a)
  }
  return out
}

/** The machine and the budgets resolved for it: everything a run needs before it starts. */
export async function prepare({ env = process.env, cpu = cpus()[0]?.model, adapter } = {}) {
  const { machines, budgets } = loadPerf()
  const problems = checkBudgets(budgets, machines)
  if (problems.length > 0) {
    const first = problems[0]
    throw new PerfError(
      first.code,
      `bench/perf/budgets.json: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`,
      'Fix budgets.json: slices plus headroom sum to 1, and every entry has a kind, a note and a number per machine.',
    )
  }
  const info = adapter === undefined ? await adapterInfo(env) : adapter
  const detection = detectMachine(machines, { cpu, adapter: info, override: env.SHARD_MACHINE })
  const resolved = resolveBudgets(budgets, detection.machine, {
    closest: detection.closest,
    machines,
  })
  return {
    machines,
    budgets,
    resolved,
    detection: { ...detection, cpu, adapter: info ?? null },
  }
}

function run(args, env = {}) {
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    // pnpm is a .cmd shim on Windows, which only a shell can start.
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  return result.status ?? 1
}

function readRecords(dir) {
  const records = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.trim()) records.push(JSON.parse(line))
    }
  }
  return records
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { budgets, resolved, detection } = await prepare()
  for (const w of detection.warnings) console.warn(`${w.code}: ${w.message}`)
  const machineLine = detection.machine
    ? `machine: ${detection.machine} (${detection.source})`
    : `machine: unknown; budgets unlimited, reporting against "${detection.closest}"`
  if (args.scenario !== undefined && !budgets.scenarios?.[args.scenario]) {
    throw new PerfError(
      'perf/unknown-budget',
      `No scenario "${args.scenario}" in bench/perf/budgets.json`,
      `Scenarios: ${Object.keys(budgets.scenarios ?? {}).join(', ')}.`,
    )
  }
  if (args.dryRun) {
    const out = { detection, resolved }
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else {
      console.log(machineLine)
      console.log(
        `${Object.keys(resolved.spans).length} budgets, ${Object.keys(resolved.scenarios).length} scenarios${resolved.enforce ? '' : ' (not enforced)'}`,
      )
    }
    return 0
  }
  console.log(machineLine)

  const reportDir = mkdtempSync(join(tmpdir(), 'shard-perf-'))
  const env = {
    SHARD_BENCH: '1',
    SHARD_BUDGETS: JSON.stringify(resolved),
    SHARD_PERF_REPORT: reportDir,
    ...(args.scenario ? { SHARD_SCENARIO: args.scenario } : {}),
  }
  let status = 0
  // A scenario run is its tests only (part B adds them); the whole run starts with the ECS bench.
  if (!args.scenario) status = run(['--filter', '@aethervtt/shard-core', 'bench'])
  if (status === 0) {
    const filter = args.scenario ? ['--', '-t', `scenario: ${args.scenario}`] : []
    status = run(
      ['exec', 'turbo', 'run', 'test', '--concurrency=1', '--force', ...args.rest, ...filter],
      env,
    )
  }

  const records = readRecords(reportDir)
  rmSync(reportDir, { recursive: true, force: true })
  const report = buildReport({
    budgets,
    resolved,
    records,
    detection,
    date: new Date().toISOString(),
  })
  if (args.scenario) {
    report.scenario = args.scenario
    report.scenarios = { [args.scenario]: report.scenarios[args.scenario] }
  }
  if (args.ratchet) report.ratchet = ratchet(report, budgets)
  writeFileSync(join(PERF_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const measured = Object.values(report.keys).filter((k) => k.measured !== null).length
  console.log(
    `\n${machineLine}: ${measured} of ${Object.keys(report.keys).length} budgets measured, ${report.over.length} over (bench/perf/report.json)`,
  )
  for (const key of report.over) {
    const k = report.keys[key]
    if (k?.verdict === 'over')
      console.log(`  over: ${key}  measured ${k.measured}, limit ${k.limit}`)
    else {
      const [name, track, slice] = key.split(':')
      const sl = report.scenarios[name]?.slices[track]?.[slice]
      if (sl) console.log(`  over: ${key}  ${sl.measuredShare} of the frame, budget ${sl.share}`)
    }
  }
  for (const r of report.ratchet ?? []) {
    console.log(`  ratchet: ${r.key} on ${r.machine}: ${r.from} → ${r.to} (measured ${r.measured})`)
  }
  return status
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (status) => process.exit(status),
    (err) => {
      console.error(err.code ? `${err.code}: ${err.message}` : err)
      if (err.hint) console.error(`hint: ${err.hint}`)
      process.exit(1)
    },
  )
}
