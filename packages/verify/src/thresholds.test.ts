import { describe, expect, it } from 'vitest'
import type { Thresholds } from './plan'
import type { PerfRecord } from './record'
import { checkThresholds } from './thresholds'

function record(
  renderer: string,
  values: { p95: number; patch: number; longest: number },
): PerfRecord {
  return {
    version: 1,
    renderer,
    fixture: 'table-small',
    scenario: 'tabletop-pan',
    device: { ua: 'Chrome/153', gpu: 'nvidia', dpr: 1, viewport: [1320, 720] },
    renderScale: { mode: 'fixed', min: 1, max: 1 },
    coldStart: { total: 400, modules: 120, device: 60, pipelines: 200, assets: 150 },
    firstUsableFrame: 900,
    patchToFrame: { p50: values.patch * 0.8, p95: values.patch, n: 40 },
    frameTime: { p50: 8, p95: values.p95, p99: values.p95 + 2, n: 1800 },
    longTasks: { count: 1, totalMs: values.longest, maxMs: values.longest },
    gpuMemory: { bytes: 1 << 20, byCategory: { targets: 1 << 20 } },
    download: { transferred: 500_000, decoded: 1_500_000 },
  }
}

const thresholds: Thresholds = {
  'tabletop-pan': {
    'frameTime.p95': { max: 16.7 },
    'longTasks.maxMs': { max: 50 },
    'patchToFrame.p95': { maxRatioTo: 'three', ratio: 1.0 },
  },
}

const three = record('three@0.160.1', { p95: 15, patch: 30, longest: 70 })

describe('checkThresholds (0062)', () => {
  it('passes when absolute and ratio budgets are met, and leaves the baseline alone', () => {
    const shard = record('shard@abc', { p95: 12, patch: 25, longest: 20 })
    const result = checkThresholds([three, shard], thresholds)
    expect(result).toMatchObject({ pass: true, breaches: [], checked: 3 })
  })

  it('fails an absolute breach, naming the metric, the value and the budget', () => {
    const shard = record('shard@abc', { p95: 19.2, patch: 25, longest: 20 })
    const { pass, breaches } = checkThresholds([three, shard], thresholds)
    expect(pass).toBe(false)
    expect(breaches).toEqual([
      expect.objectContaining({
        metric: 'frameTime.p95',
        renderer: 'shard@abc',
        value: 19.2,
        budget: 'max 16.7',
        message: 'tabletop-pan frameTime.p95 (shard@abc): 19.2 is over the max of 16.7',
      }),
    ])
  })

  it('fails a ratio breach against the baseline, with both values', () => {
    const shard = record('shard@abc', { p95: 12, patch: 34, longest: 20 })
    const { pass, breaches } = checkThresholds([three, shard], thresholds)
    expect(pass).toBe(false)
    expect(breaches).toEqual([
      expect.objectContaining({
        metric: 'patchToFrame.p95',
        value: 34,
        baseline: { renderer: 'three@0.160.1', value: 30 },
        budget: 'max 1 × three@0.160.1 (30) = 30',
      }),
    ])
  })

  it('fails a ratio rule with no baseline record to compare with', () => {
    const shard = record('shard@abc', { p95: 12, patch: 25, longest: 20 })
    const { breaches } = checkThresholds([shard], thresholds)
    expect(breaches.map((b) => b.message)).toEqual([
      'tabletop-pan patchToFrame.p95 (shard@abc): no three record of tabletop-pan on table-small to compare with',
    ])
  })

  it('fails a metric the record lacks', () => {
    const shard = record('shard@abc', { p95: 12, patch: 25, longest: 20 })
    const { breaches } = checkThresholds([shard], {
      'tabletop-pan': { 'frameTime.gpuP95': { max: 10 } },
    })
    expect(breaches[0]).toMatchObject({ metric: 'frameTime.gpuP95', value: undefined })
  })
})

const span = (name: string, p95: number, track: 'main' | 'gpu' = 'main') => ({
  span: name,
  track,
  calls: 120,
  total: p95 * 60,
  p50: p95 / 2,
  p95,
  max: p95 * 1.5,
})

/** A version 2 record (0074) with a breakdown. */
function withBreakdown(renderer: string, spawnP95: number, opaqueP95: number): PerfRecord {
  return {
    ...record(renderer, { p95: 12, patch: 25, longest: 20 }),
    version: 2,
    breakdown: {
      cpu: [span('partition/spawn', spawnP95), span('render/forward-opaque', 1.2)],
      gpu: [span('gpu:forward-opaque', opaqueP95, 'gpu')],
    },
  }
}

describe('span thresholds (0074)', () => {
  it('fails a record whose partition/spawn p95 is over its threshold, naming the span', () => {
    const spans: Thresholds = {
      'tabletop-pan': {
        spans: [
          { span: 'partition/spawn', p95: 2 },
          { span: 'gpu:forward-opaque', max: 9 },
        ],
      },
    }
    const ok = checkThresholds([withBreakdown('shard@abc', 1.5, 3)], spans)
    expect(ok).toMatchObject({ pass: true, checked: 2 })
    const { pass, breaches } = checkThresholds([withBreakdown('shard@abc', 2.6, 3)], spans)
    expect(pass).toBe(false)
    expect(breaches).toEqual([
      expect.objectContaining({
        span: 'partition/spawn',
        metric: 'span:partition/spawn.p95',
        value: 2.6,
        budget: 'p95 2',
        message: 'tabletop-pan span partition/spawn (shard@abc): p95 2.6 ms is over 2 ms',
      }),
    ])
  })

  it('fails a span budget on a version 1 record, which has no breakdown', () => {
    const { breaches } = checkThresholds(
      [record('shard@abc', { p95: 12, patch: 25, longest: 20 })],
      {
        'tabletop-pan': { spans: [{ span: 'partition/spawn', p95: 2 }] },
      },
    )
    expect(breaches[0]!.message).toBe(
      'tabletop-pan span partition/spawn (shard@abc): the record has no breakdown (version 1)',
    )
  })

  it('lists the spans that grew the most when a record fails against its baseline', () => {
    const before = withBreakdown('shard@base', 0.4, 3)
    const after = {
      ...withBreakdown('shard@abc', 6, 3.5),
      frameTime: { p50: 8, p95: 18, p99: 20, n: 1 },
    }
    const { breaches } = checkThresholds([before, after], {
      'tabletop-pan': { 'frameTime.p95': { maxRatioTo: 'shard', ratio: 1.1 } },
    })
    // The baseline renderer is "shard" too, so the base record isn't a subject: compare by hand.
    expect(breaches).toEqual([])
    const shard = { ...after, renderer: 'next@abc' }
    const result = checkThresholds([before, shard], {
      'tabletop-pan': { 'frameTime.p95': { maxRatioTo: 'shard', ratio: 1.1 } },
    })
    expect(result.breaches[0]!.grew).toEqual([
      { span: 'partition/spawn', p95: 6, baselineP95: 0.4 },
      { span: 'gpu:forward-opaque', p95: 3.5, baselineP95: 3 },
    ])
    expect(result.breaches[0]!.message).toContain('grew most: partition/spawn 0.4 → 6 ms')
  })
})
