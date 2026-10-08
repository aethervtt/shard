import { Profiler, Rng, TRACK } from '@aethervtt/shard-core'
import { allocationChecks, gcWindow } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { CoveredGpuTime, FoliageController } from './foliage-budget'

// Spec 0075: foliage keeps its GPU time inside a target, the way TerrainBudget.triangles steers
// 0043's LOD bias. Headless: a fake GPU whose foliage time is the detail drawn times a load, with
// noise, landing three frames late as real GPU timings do.

const LAG = 3

/** Runs the controller against a load (ms at full detail) per frame; returns each frame's state. */
function simulate(
  loads: (frame: number) => number,
  frames: number,
  target: number | ((frame: number) => number),
  ctl = new FoliageController(),
) {
  const rng = new Rng(7)
  const inFlight: number[] = []
  const detail: number[] = []
  const cost: number[] = []
  for (let f = 0; f < frames; f++) {
    // This frame's GPU time: what the current detail draws, ±5%.
    const ms = loads(f) * ctl.detail * (0.95 + rng.float() * 0.1)
    cost.push(ms)
    inFlight.push(ms)
    const t = typeof target === 'number' ? target : target(f)
    if (inFlight.length > LAG) ctl.sample(inFlight.shift()!, t, 0.05)
    detail.push(ctl.detail)
  }
  return { ctl, detail, cost }
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}
const p95 = (values: number[]) => pct(values, 0.95)

/** Times the detail turns from falling to rising or back. */
function reversals(values: number[]): number {
  let turns = 0
  let last = 0
  for (let i = 1; i < values.length; i++) {
    const d = Math.sign(values[i]! - values[i - 1]!)
    if (d !== 0 && last !== 0 && d !== last) turns++
    if (d !== 0) last = d
  }
  return turns
}

describe('foliage budget controller (0075)', () => {
  it('converges under its target when foliage costs more than it at full detail', () => {
    // 8 ms of grass against a 3 ms target: about 0.37 of full detail fits.
    const { detail, cost } = simulate(() => 8, 900, 3)
    const settled = cost.slice(600)
    expect(p95(settled)).toBeLessThan(3)
    // Not starved either: it holds above the recovery band's floor (85% of the target).
    expect(pct(settled, 0.05)).toBeGreaterThan(3 * 0.75)
    expect(detail.at(-1)!).toBeGreaterThan(0.25)
    expect(detail.at(-1)!).toBeLessThan(0.5)
  })

  it("doesn't oscillate once it has converged", () => {
    const { detail } = simulate(() => 8, 1500, 3)
    const tail = detail.slice(900)
    expect(reversals(tail)).toBeLessThanOrEqual(2)
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.03)
  })

  it('goes back to full detail when the load drops, and stays inside the target while it does', () => {
    const { detail, cost } = simulate((f) => (f < 900 ? 8 : 2), 2400, 3)
    expect(detail[899]!).toBeLessThan(0.5)
    expect(detail.at(-1)).toBe(1)
    // Recovering never overshoots the target: it rises only under 85% of it.
    expect(p95(cost.slice(900))).toBeLessThan(3)
  })

  it('draws everything without a target, and resets at once when it goes away', () => {
    const none = simulate(() => 8, 300, 0)
    expect(none.detail.every((d) => d === 1)).toBe(true)
    const off = simulate(
      () => 8,
      900,
      (f) => (f < 600 ? 3 : 0),
    )
    expect(off.detail[599]!).toBeLessThan(0.5)
    expect(off.detail[650]).toBe(1)
  })

  it('never thins below its floor', () => {
    const ctl = new FoliageController()
    for (let i = 0; i < 2000; i++) ctl.sample(50, 1, 0.1)
    expect(ctl.detail).toBeCloseTo(0.1, 6)
    // Density and range together scale the instances drawn with the detail.
    expect(ctl.density ** 2 * ctl.rangeScale ** 4).toBeCloseTo(ctl.detail * ctl.detail, 6)
  })
})

describe('foliage GPU time by the covers rule (0075)', () => {
  it('sums the gpu:foliage passes that landed with each GPU frame, and nothing else', () => {
    const profiler = new Profiler()
    const reader = new CoveredGpuTime('gpu:foliage')
    // Nothing timed yet.
    expect(reader.read(profiler)).toBe(false)
    const land = (passes: [string, number][], frame: number) => {
      for (const [name, ms] of passes) profiler.sample(name, ms)
      profiler.record('gpu:frame', frame, TRACK.gpu)
    }
    land(
      [
        ['gpu:foliage/cull', 0.5],
        ['gpu:foliage/draw', 4],
        ['gpu:forward-opaque', 3],
        ['gpu:foliage-ish', 9],
      ],
      9,
    )
    // Names seen for the first time: what they ran before is no frame of the reader's.
    expect(reader.read(profiler)).toBe(true)
    expect(reader.ms).toBe(0)
    land(
      [
        ['gpu:foliage/cull', 0.5],
        ['gpu:foliage/draw', 4],
        ['gpu:forward-opaque', 3],
      ],
      9,
    )
    expect(reader.read(profiler)).toBe(true)
    expect(reader.ms).toBe(4.5)
    // No new GPU frame: nothing to read.
    expect(reader.read(profiler)).toBe(false)
    // Placement runs only some frames; the frames it doesn't, it adds nothing.
    land(
      [
        ['gpu:foliage/place', 1],
        ['gpu:foliage/cull', 0.5],
        ['gpu:foliage/draw', 4],
      ],
      9,
    )
    expect(reader.read(profiler)).toBe(true)
    expect(reader.ms).toBe(4.5)
    land(
      [
        ['gpu:foliage/place', 1],
        ['gpu:foliage/cull', 0.5],
        ['gpu:foliage/draw', 4],
      ],
      9,
    )
    expect(reader.read(profiler)).toBe(true)
    expect(reader.ms).toBe(5.5)
    land([['gpu:foliage/draw', 2]], 9)
    expect(reader.read(profiler)).toBe(true)
    expect(reader.ms).toBe(2)
  })

  it('reads and steers without allocating', async () => {
    const profiler = new Profiler()
    const reader = new CoveredGpuTime('gpu:foliage')
    const ctl = new FoliageController()
    const frames = allocationChecks ? 20_000 : 500
    const step = (i: number) => {
      profiler.sample('gpu:foliage/draw', 4 + (i % 7) * 0.1)
      profiler.sample('gpu:foliage/cull', 0.4)
      profiler.sample('gpu:frame', 9)
      if (reader.read(profiler)) ctl.sample(reader.ms, 3, 0.1)
    }
    for (let i = 0; i < 2000; i++) step(i) // let V8 optimize
    const window = gcWindow()
    for (let i = 0; i < frames; i++) step(i)
    const collections = await window.end()
    expect(ctl.detail).toBeLessThan(1)
    if (allocationChecks) expect(collections).toBe(0)
  })
})
