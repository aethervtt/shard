import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Profiler, ProfilerResource, TRACK, World } from '@aethervtt/shard-core'
import { PerfBudgets, type PerfBudgetsData, PerfScenario, Time } from '@aethervtt/shard-runtime'
import { describe, expect, it } from 'vitest'
import { PassCosts } from './ablation'
import { perfOverlayLines } from './perf-overlay'

// The perf overlay's text (0074), with 0075's additions: overlapping pass times in grey and
// unranked (ranked by ablation when one ran), and the declared scenario's slices against budget.

const here = dirname(fileURLToPath(import.meta.url))
const perfDir = join(here, '../../../bench/perf')
const files: PerfBudgetsData = {
  machines: JSON.parse(readFileSync(join(perfDir, 'machines.json'), 'utf8')),
  budgets: JSON.parse(readFileSync(join(perfDir, 'budgets.json'), 'utf8')),
}
const GREY = [0.6, 0.6, 0.6, 1]
const RED = [1, 0.35, 0.3, 1]

/** A world with a profiler that saw a few frames of the playground's overlapping M4 passes. */
function world(elapsed: number): World {
  const w = new World()
  const profiler = new Profiler()
  w.insertResource(ProfilerResource, profiler)
  w.insertResource(Time, { delta: 0, elapsed, frame: 0 })
  w.insertResource(PerfScenario, { name: null })
  for (let f = 0; f < 4; f++) {
    profiler.sample('scatter/props', 0.4)
    for (const [name, ms] of [
      ['gpu:frame', 9.4],
      ['gpu:forward-opaque', 6],
      ['gpu:tonemap', 3],
      ['gpu:post/upscale', 3],
      ['gpu:gizmos', 3],
      ['gpu:foliage/draw', 3],
    ] as const)
      profiler.record(name, ms, TRACK.gpu)
  }
  return w
}

describe('perf overlay (0074, 0075)', () => {
  it('greys overlapping pass times out of the ranking, listed apart and unranked', () => {
    const { lines, colors } = perfOverlayLines(world(0))
    const ranked = lines.slice(1, lines.indexOf('gpu passes overlapping: perf.ablate ranks them'))
    expect(ranked.some((l) => l.includes('scatter/props'))).toBe(true)
    expect(ranked.some((l) => l.includes('gpu:'))).toBe(false)
    const passes = lines
      .map((l, i) => ({ l, c: colors[i] }))
      .filter(({ l }) => l.endsWith('overlapping'))
    expect(passes.length).toBeGreaterThan(0)
    for (const p of passes) expect(p.c).toEqual(GREY)
    // By name, not by time.
    const names = passes.map((p) => p.l.trim().split(/\s+/)[2]!)
    expect(names).toEqual([...names].sort())
  })

  it('ranks passes by the latest ablation once one ran', () => {
    const w = world(0)
    w.insertResource(PassCosts, {
      latest: {
        frameMs: 9.4,
        passes: [
          { pass: 'tonemap', ms: 0.4, rounds: [0.4] },
          { pass: 'forward-opaque', ms: 5.1, rounds: [5.1] },
        ],
        frames: 120,
        rounds: 1,
        samples: 360,
        at: 0,
      },
    })
    const { lines } = perfOverlayLines(w)
    const at = lines.indexOf('gpu passes by ablation (timestamps overlap)')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toContain('gpu:forward-opaque  ablated')
    expect(lines[at + 2]).toContain('gpu:tonemap  ablated')
  })

  it("shows the scenario's slices: measured share of the frame against budget, red when over", () => {
    const w = world(0)
    w.insertResource(PerfBudgets, { ...files, machine: 'laptop' })
    w.resource(PerfScenario).name = 'scatter-walk'
    const { lines, colors } = perfOverlayLines(w)
    const header = lines.findIndex((l) => l.startsWith('scenario scatter-walk on laptop'))
    expect(header).toBeGreaterThan(0)
    const opaque = lines.findIndex((l) => l.endsWith('gpu:forward-opaque'))
    // 6 ms of a 9.4 ms frame: 64% against its 35%.
    expect(lines[opaque]).toMatch(/gpu\s+64% \/\s+35%/)
    expect(colors[opaque]).toEqual(RED)
    const cpu = lines.findIndex((l) => l.endsWith(' scatter'))
    expect(colors[cpu]).not.toEqual(RED)
  })

  it('refreshes four times a second, not every frame', () => {
    const w = world(0)
    const first = perfOverlayLines(w)
    expect(perfOverlayLines(w)).toBe(first)
    w.resource(Time).elapsed = 0.3
    expect(perfOverlayLines(w)).not.toBe(first)
  })
})
