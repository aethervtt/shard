import { describe, expect, it } from 'vitest'
import { budget, type ResolvedBudgets, resolveLimit, slack, timingMode } from './test-env'

const RESOLVED: ResolvedBudgets = {
  machine: 'laptop',
  enforce: true,
  spans: {
    'a/target': { kind: 'target', value: 2 },
    'a/unit': { kind: 'unit', value: 0.5, per: 'item' },
    'a/rate': { kind: 'rate', value: 1000, per: 'point' },
    'a/guard': { kind: 'guard', value: 1, margin: 0.1 },
  },
  scenarios: {
    walk: {
      frame: { gpu: 10, cpu: 8 },
      slices: { gpu: { 'gpu:foliage': 1.2, headroom: 8.8 }, cpu: { render: 2, headroom: 6 } },
    },
  },
}

describe('budget() (0075)', () => {
  it('resolves each kind on the machine: unit × count, guard plus margin, rate as a floor', () => {
    expect(resolveLimit(RESOLVED, 'a/target').limit).toBe(2)
    expect(resolveLimit(RESOLVED, 'a/unit', { count: 10 }).limit).toBe(5)
    expect(resolveLimit(RESOLVED, 'a/guard').limit).toBeCloseTo(1.1)
    expect(resolveLimit(RESOLVED, 'a/rate').limit).toBe(1000)
  })

  it('reads scenario frames and slices, the track from the slice name by default', () => {
    expect(resolveLimit(RESOLVED, 'walk', { slice: 'gpu:foliage' }).limit).toBe(1.2)
    expect(resolveLimit(RESOLVED, 'walk', { slice: 'render' }).limit).toBe(2)
    expect(resolveLimit(RESOLVED, 'walk', { track: 'gpu' }).limit).toBe(10)
    expect(resolveLimit(RESOLVED, 'walk', { slice: 'headroom', track: 'cpu' }).limit).toBe(6)
  })

  it('is unlimited when not enforced (pnpm test, an unknown machine), keeping the reference', () => {
    expect(resolveLimit(RESOLVED, 'a/target', {}, false)).toEqual({
      limit: Number.POSITIVE_INFINITY,
      reference: 2,
      kind: 'target',
    })
    expect(resolveLimit(RESOLVED, 'a/rate', {}, false).limit).toBe(0)
    const unknown = { ...RESOLVED, enforce: false }
    expect(resolveLimit(unknown, 'a/unit', { count: 4 })).toMatchObject({
      limit: Number.POSITIVE_INFINITY,
      reference: 2,
    })
  })

  it('throws perf/unknown-budget for a key or slice it lacks', () => {
    expect(() => resolveLimit(RESOLVED, 'a/nope', {}, false)).toThrow(
      expect.objectContaining({ code: 'perf/unknown-budget', path: 'a/nope' }),
    )
    expect(() => resolveLimit(RESOLVED, 'walk', { slice: 'gpu:nope' })).toThrow(
      expect.objectContaining({ code: 'perf/unknown-budget' }),
    )
  })

  it('reads bench/perf/budgets.json through SHARD_BUDGETS: real keys resolve, typos throw', () => {
    // testFiles() passes every key (pnpm test); pnpm bench passes its machine's numbers.
    if (timingMode !== 'bench') expect(budget('mirror/sync')).toBe(Number.POSITIVE_INFINITY)
    expect(budget('scatter-walk', { slice: 'gpu:foliage' })).toBeGreaterThan(0)
    expect(() => budget('mirror/snyc')).toThrow(
      expect.objectContaining({ code: 'perf/unknown-budget' }),
    )
  })

  it('keeps budget(ms) working', () => {
    expect(budget(3)).toBe(3 * slack)
  })
})
