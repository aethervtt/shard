import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLimit } from '@aethervtt/shard-core/test-env'
import { afterAll, describe, expect, it } from 'vitest'
import { parseArgs, prepare } from '../../../scripts/bench.mjs'
import { findLiteralCalls, literalCalls } from '../../../scripts/budget-literals.mjs'
import { budgetMatchers } from '../../../scripts/perf-report.setup.mjs'
import {
  backendOf,
  buildReport,
  checkBudgets,
  detectMachine,
  limitOf,
  loadPerf,
  ratchet,
  resolveBudgets,
} from './perf.mjs'

const { machines, budgets } = loadPerf()
/** scatter-walk's shares as budgets.json sets them. */
const WALK = budgets.scenarios['scatter-walk'].slices

const M4 = {
  vendor: 'apple',
  architecture: 'metal-3',
  device: 'apple-m4',
  description: 'Metal driver on macOS Version 26.2 (Build 25C56)',
  backend: 'metal',
}
const RTX = {
  vendor: 'nvidia',
  architecture: 'blackwell',
  device: '',
  description: 'D3D12 backend - NVIDIA GeForce RTX 5060 Ti',
  backend: 'd3d12',
}
const RYZEN = 'AMD Ryzen 9 9950X3D 16-Core Processor'

describe('machines (0075)', () => {
  it('detects both named machines from the CPU model and the adapter', () => {
    expect(detectMachine(machines, { cpu: 'Apple M4', adapter: M4 })).toMatchObject({
      machine: 'laptop',
      source: 'detected',
      warnings: [],
    })
    expect(detectMachine(machines, { cpu: RYZEN, adapter: RTX })).toMatchObject({
      machine: 'desktop',
      source: 'detected',
      warnings: [],
    })
  })

  it('reads the backend from the adapter description', () => {
    expect(backendOf(M4.description)).toBe('metal')
    expect(backendOf(RTX.description)).toBe('d3d12')
    expect(backendOf('Vulkan backend - Intel')).toBe('vulkan')
    expect(backendOf('')).toBeUndefined()
  })

  it('on an unknown machine: no machine, a perf/unknown-machine warning, the closest named', () => {
    const intel = { ...RTX, vendor: 'intel', description: 'D3D12 backend - Intel Arc' }
    const d = detectMachine(machines, { cpu: 'Intel Core i7', adapter: intel })
    expect(d.machine).toBeNull()
    expect(d.closest).toBe('desktop') // the D3D12 backend matched
    expect(d.warnings.map((w) => w.code)).toEqual(['perf/unknown-machine'])
    // The same CPU with another GPU isn't the machine either.
    expect(detectMachine(machines, { cpu: 'Apple M4', adapter: undefined }).machine).toBeNull()
  })

  it('SHARD_MACHINE overrides; a disagreeing detection or an unknown name only warns', () => {
    const agree = detectMachine(machines, { cpu: 'Apple M4', adapter: M4, override: 'laptop' })
    expect(agree).toMatchObject({ machine: 'laptop', source: 'override', warnings: [] })
    const other = detectMachine(machines, { cpu: 'Apple M4', adapter: M4, override: 'desktop' })
    expect(other.machine).toBe('desktop')
    expect(other.warnings.map((w) => w.code)).toEqual(['perf/machine-mismatch'])
    const typo = detectMachine(machines, { cpu: 'Apple M4', adapter: M4, override: 'lapotp' })
    expect(typo.machine).toBeNull()
    expect(typo.warnings.map((w) => w.code)).toEqual(['perf/unknown-machine'])
  })
})

describe('budgets.json (0075)', () => {
  it('is well formed: kinds, notes, a number per machine, slices that sum to 1', () => {
    expect(checkBudgets(budgets, machines)).toEqual([])
    for (const name of Object.keys(machines.machines)) {
      expect(['ablation', 'timestamps']).toContain(machines.machines[name].passTiming)
    }
  })

  it('fails a scenario whose slices plus headroom do not sum to 1 (perf/slices-overflow)', () => {
    const bad = structuredClone(budgets)
    bad.scenarios['scatter-walk'].slices.gpu['gpu:foliage'] = 0.2
    const problems = checkBudgets(bad, machines)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      code: 'perf/slices-overflow',
      path: 'scenarios/scatter-walk/slices/gpu',
    })
    const sum = 1 - WALK.gpu['gpu:foliage'] + 0.2
    expect(problems[0].message).toContain(String(+sum.toFixed(4)))
  })

  it('flags an entry without a note, a guard without a margin, and a missing machine', () => {
    const bad = structuredClone(budgets)
    delete bad.spans['mirror/sync'].note
    delete bad.spans['ui/layout'].margin
    delete bad.spans['nav/find-path'].desktop
    expect(checkBudgets(bad, machines).map((p) => p.path)).toEqual([
      'spans/mirror/sync',
      'spans/nav/find-path',
      'spans/ui/layout',
    ])
  })

  it('resolves per machine: units, guards with their margin, rates, and scenario slices in ms', () => {
    const laptop = resolveBudgets(budgets, 'laptop')
    const desktop = resolveBudgets(budgets, 'desktop')
    expect(laptop.enforce).toBe(true)
    expect(laptop.spans['noise/fbm6']).toEqual({ kind: 'rate', value: 40e6, per: 'point' })
    expect(desktop.spans['noise/fbm6']!.value).toBe(24e6)
    expect(limitOf(laptop, 'ui/layout')).toBeCloseTo(0.99)
    expect(limitOf(laptop, 'scene/load', { count: 10_000 })).toBeCloseTo(100)
    expect(laptop.scenarios['scatter-walk']!.frame).toEqual({ gpu: 16.6, cpu: 8 })
    expect(laptop.scenarios['scatter-walk']!.slices.gpu['gpu:foliage']).toBeCloseTo(
      16.6 * WALK.gpu['gpu:foliage'],
    )
    expect(desktop.scenarios['scatter-walk']!.slices.cpu.render).toBeCloseTo(6 * WALK.cpu.render)
    expect(limitOf(desktop, 'scatter-walk', { slice: 'gpu:foliage' })).toBeCloseTo(
      8.3 * WALK.gpu['gpu:foliage'],
    )
    // The laptop's known miss: shadows overridden absolutely (budgets.json's note).
    expect(laptop.scenarios['scatter-walk']!.slices.gpu['gpu:shadows']).toBe(
      budgets.scenarios['scatter-walk'].overrides.laptop.gpu['gpu:shadows'],
    )
    expect(desktop.scenarios['scatter-walk']!.slices.gpu['gpu:shadows']).toBeCloseTo(
      8.3 * WALK.gpu['gpu:shadows'],
    )
    // How each checks GPU slices reaches the tests too (test-env's passTiming).
    expect(resolveBudgets(budgets, 'laptop', { machines }).passTiming).toBe('ablation')
    expect(resolveBudgets(budgets, 'desktop', { machines }).passTiming).toBe('timestamps')
    expect(resolveBudgets(budgets, null, { machines }).passTiming).toBeNull()
  })

  it('applies a machine override to a slice as an absolute number', () => {
    const withOverride = structuredClone(budgets)
    withOverride.scenarios['scatter-walk'].overrides = { desktop: { gpu: { 'gpu:tonemap': 2.1 } } }
    expect(checkBudgets(withOverride, machines)).toEqual([])
    const r = resolveBudgets(withOverride, 'desktop')
    expect(r.scenarios['scatter-walk']!.slices.gpu['gpu:tonemap']).toBe(2.1)
    expect(
      resolveBudgets(withOverride, 'laptop').scenarios['scatter-walk']!.slices.gpu['gpu:tonemap'],
    ).toBeCloseTo(16.6 * WALK.gpu['gpu:tonemap'])
    // An override for a slice the scenario lacks is an error.
    withOverride.scenarios['scatter-walk'].overrides = { desktop: { gpu: { 'gpu:nope': 1 } } }
    expect(checkBudgets(withOverride, machines).map((p) => p.code)).toEqual(['perf/bad-budget'])
  })

  it('outside a machine every key resolves to no number; unknown machines keep the closest, unenforced', () => {
    const keys = resolveBudgets(budgets, null)
    expect(keys.enforce).toBe(false)
    expect(keys.spans['ui/layout']!.value).toBeNull()
    const unknown = resolveBudgets(budgets, null, { closest: 'laptop' })
    expect(unknown).toMatchObject({ machine: 'laptop', enforce: false })
    expect(unknown.spans['ui/layout']!.value).toBe(0.9)
  })
})

describe('budget(key) against resolved budgets (test-env)', () => {
  const laptop = resolveBudgets(budgets, 'laptop')

  it('gives the machine number under pnpm bench, and unlimited otherwise', () => {
    expect(resolveLimit(laptop, 'mirror/sync').limit).toBe(0.2)
    expect(resolveLimit(laptop, 'mirror/sync', {}, false).limit).toBe(Number.POSITIVE_INFINITY)
    expect(resolveLimit(laptop, 'noise/fbm6', {}, false).limit).toBe(0)
    expect(resolveLimit(laptop, 'text/layout', { count: 10_000 }).limit).toBeCloseTo(2)
    expect(
      resolveLimit(laptop, 'scatter-walk', { slice: 'headroom', track: 'gpu' }).limit,
    ).toBeCloseTo(16.6 * WALK.gpu.headroom)
    const unknown = resolveBudgets(budgets, null, { closest: 'desktop' })
    expect(resolveLimit(unknown, 'mirror/sync')).toMatchObject({
      limit: Number.POSITIVE_INFINITY,
      reference: 0.2,
    })
  })

  it('throws perf/unknown-budget for a key, scenario slice, or track budgets.json lacks', () => {
    expect(() => resolveLimit(laptop, 'ui/layuot')).toThrow(
      expect.objectContaining({ code: 'perf/unknown-budget' }),
    )
    expect(() => resolveLimit(laptop, 'scatter-walk', { slice: 'gpu:nope' })).toThrow(
      expect.objectContaining({ code: 'perf/unknown-budget' }),
    )
  })
})

describe('the report (0075)', () => {
  const laptop = resolveBudgets(budgets, 'laptop')
  const record = (key: string, measured: number, opts = {}) => ({
    key,
    opts,
    measured,
    test: 't',
    file: 'f',
  })

  it('lists budget, measured (worst) and verdict per key; units per item, rates as floors', () => {
    const report = buildReport({
      budgets,
      resolved: laptop,
      detection: { machine: 'laptop' },
      date: '2026-10-07',
      records: [
        record('mirror/sync', 0.1),
        record('mirror/sync', 0.15),
        record('nav/find-path', 2.5),
        record('scene/load', 50, { count: 10_000 }),
        record('noise/fbm6', 41e6),
        record('noise/fbm6', 39e6),
        record('scatter-walk', 0.2, { slice: 'gpu:foliage' }),
      ],
    })
    expect(report.machine).toBe('laptop')
    expect(report.keys['mirror/sync']).toMatchObject({
      budget: 0.2,
      measured: 0.15,
      verdict: 'pass',
    })
    expect(report.keys['nav/find-path']).toMatchObject({ verdict: 'over' })
    expect(report.keys['scene/load']).toMatchObject({
      budget: 0.01,
      measured: 0.005,
      verdict: 'pass',
    })
    expect(report.keys['noise/fbm6']).toMatchObject({ measured: 39e6, verdict: 'over' })
    expect(report.keys['scatter-walk:gpu:gpu:foliage']).toMatchObject({
      kind: 'slice',
      verdict: 'pass',
    })
    expect(report.keys['ui/layout']!.verdict).toBe('unmeasured')
    expect(report.over.sort()).toEqual(['noise/fbm6', 'nav/find-path'].sort())
    expect(report.scenarios['scatter-walk']!.slices.gpu.headroom!.share).toBe(WALK.gpu.headroom)
  })

  it("gives each scenario slice its measured share of the frame, and reports a share over its budget's", () => {
    const report = buildReport({
      budgets,
      resolved: laptop,
      detection: {},
      date: '',
      records: [
        record('scatter-walk', 10, { track: 'gpu' }),
        record('scatter-walk', 4, { slice: 'gpu:forward-opaque', track: 'gpu' }),
        record('scatter-walk', 0.1, { slice: 'gpu:foliage', track: 'gpu' }),
        record('scatter-walk', 1, { slice: 'gpu:shadows', track: 'gpu' }),
        record('scatter-walk', 0.05, { slice: 'gpu:tonemap', track: 'gpu' }),
      ],
    })
    const s = report.scenarios['scatter-walk']!
    expect(s.frame.gpu).toEqual({ budget: 16.6, measured: 10 })
    expect(s.slices.gpu['gpu:forward-opaque']).toMatchObject({
      share: WALK.gpu['gpu:forward-opaque'],
      measured: 4,
      measuredShare: 0.4,
      verdict: 'over',
    })
    expect(s.slices.gpu['gpu:foliage']).toMatchObject({ measuredShare: 0.01, verdict: 'pass' })
    // Headroom is what the slices leave, a floor.
    expect(s.slices.gpu.headroom!.measured).toBeCloseTo(4.85)
    expect(s.slices.gpu.headroom).toMatchObject({ measuredShare: 0.485, verdict: 'pass' })
    // 4 ms fits the laptop's absolute override; its share of this frame is still over.
    expect(report.keys['scatter-walk:gpu:gpu:forward-opaque']!.verdict).toBe('pass')
    expect(report.over).toContain('scatter-walk:gpu:gpu:forward-opaque')
    expect(s.slices.cpu.render!.verdict).toBe('unmeasured')
    expect(report.scenarios.crowd!.slices.gpu['gpu:shadows']!.verdict).toBe('unmeasured')
  })

  it("takes the verdict from the test's own comparison when it was recorded", () => {
    const limit = limitOf(laptop, 'nav/find-path')!
    const report = buildReport({
      budgets,
      resolved: laptop,
      detection: {},
      date: '',
      records: [
        { ...record('nav/find-path', limit), pass: true }, // toBeLessThanOrEqual at the limit
        { ...record('mirror/sync', 0.1), pass: false },
      ],
    })
    expect(report.keys['nav/find-path']!.verdict).toBe('pass')
    expect(report.keys['mirror/sync']!.verdict).toBe('over')
  })

  it('--ratchet proposes lowering a guard beaten by more than twice its margin', () => {
    const report = buildReport({
      budgets,
      resolved: laptop,
      detection: {},
      date: '',
      records: [record('ui/layout', 0.5), record('shader/link', 3.5)],
    })
    report.enforced = true
    expect(ratchet(report, budgets)).toEqual([
      { key: 'ui/layout', machine: 'laptop', from: 0.9, to: 0.5, measured: 0.5 },
    ])
    expect(ratchet({ ...report, enforced: false }, budgets)).toEqual([])
  })
})

describe('scripts/bench.mjs', () => {
  it('splits its own flags from turbo arguments', () => {
    expect(
      parseArgs(['--dry-run', '--scenario', 'crowd', '--filter=@aethervtt/shard-ui', '--ratchet']),
    ).toEqual({
      dryRun: true,
      ratchet: true,
      json: false,
      scenario: 'crowd',
      rest: ['--filter=@aethervtt/shard-ui'],
    })
  })

  it('prepares the machine and its budgets without running anything', async () => {
    const desktop = await prepare({ env: {}, cpu: RYZEN, adapter: RTX })
    expect(desktop.detection.machine).toBe('desktop')
    expect(desktop.resolved).toMatchObject({ machine: 'desktop', enforce: true })
    const elsewhere = await prepare({ env: {}, cpu: 'Some CPU', adapter: null })
    expect(elsewhere.detection.machine).toBeNull()
    expect(elsewhere.resolved.enforce).toBe(false)
    const forced = await prepare({ env: { SHARD_MACHINE: 'laptop' }, cpu: RYZEN, adapter: RTX })
    expect(forced.resolved.machine).toBe('laptop')
  })
})

describe('scripts/perf-report.setup.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-perf-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('records what an assertion against the last budget() call measured', () => {
    const file = join(dir, 'records.jsonl')
    const matchers = budgetMatchers(file, () => ({ currentTestName: 'a test', testPath: 'x.ts' }))
    const utils = { printReceived: String, printExpected: String }
    const g = globalThis as { __shardBudget?: unknown }
    g.__shardBudget = {
      key: 'mirror/sync',
      opts: {},
      limit: 0.2,
      reference: 0.2,
      kind: 'target',
      used: false,
    }
    expect(matchers.toBeLessThan!.call({ utils, isNot: false }, 0.12, 0.2).pass).toBe(true)
    // Used once: a later comparison against the same number isn't the budget's.
    expect(matchers.toBeLessThan!.call({ utils, isNot: false }, 0.3, 0.2).pass).toBe(false)
    g.__shardBudget = {
      key: 'noise/fbm6',
      opts: {},
      limit: 0,
      reference: 4e7,
      kind: 'rate',
      used: false,
    }
    expect(matchers.toBeGreaterThanOrEqual!.call({ utils, isNot: false }, 3e7, 0).pass).toBe(true)
    delete g.__shardBudget
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toEqual([
      expect.objectContaining({ key: 'mirror/sync', measured: 0.12, limit: 0.2, test: 'a test' }),
      expect.objectContaining({ key: 'noise/fbm6', measured: 3e7, limit: 0, reference: 4e7 }),
    ])
  })
})

describe('scripts/budget-literals.mjs', () => {
  it('finds budget(<number>) calls in files importing budget from test-env, not keys', () => {
    const src = [
      "import { budget } from '@aethervtt/shard-core/test-env'",
      'expect(a).toBeLessThan(budget(2))',
      "expect(b).toBeLessThan(budget('ui/layout'))",
      'expect(c).toBeLessThan(budget(limits.ms) + 1)',
      'expect(d).toBeLessThan(other.budget(3))',
    ].join('\n')
    expect(literalCalls(src).map((c) => c.line)).toEqual([2, 4])
    expect(literalCalls('function budget(n) {}\nbudget(2)')).toEqual([])
  })

  it('reports none left in the repository', () => {
    expect(findLiteralCalls()).toEqual([])
  })
})
