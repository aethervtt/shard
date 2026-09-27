import { describe, expect, it } from 'vitest'
import { RefreshMeter, rateFromIntervals, snapRate } from './display'

describe('display refresh rate', () => {
  it('snaps measurements to the rates displays ship with', () => {
    expect(snapRate(59.94)).toBe(60)
    expect(snapRate(119.2)).toBe(120)
    expect(snapRate(142)).toBe(144)
    expect(snapRate(1000 / 6.9)).toBe(144)
    // Nothing within 4%: the measurement, rounded.
    expect(snapRate(110.4)).toBe(110)
  })

  it('reads a probe by its median, so a hitch or two do not move it', () => {
    const intervals = [8.3, 8.4, 8.2, 25, 8.3, 8.35, 16.6, 8.3, 8.33, 8.31, 8.36, 8.29]
    expect(rateFromIntervals(intervals)).toBe(120)
    expect(rateFromIntervals([16.7, 16.6, 16.7, 33.3, 16.7, 16.6, 16.8, 16.7])).toBe(60)
  })

  it('raises the rate after a run of faster frames, never lowers it', () => {
    const meter = new RefreshMeter(1000 / 60)
    // A slow app at 60 Hz shows 33 ms frames: they say nothing about the display.
    for (let i = 0; i < 100; i++) expect(meter.sample(33.3)).toBe(0)
    let rose = 0
    for (let i = 0; i < 20; i++) rose = meter.sample(i % 7 === 0 ? 7.9 : 8.33) || rose
    expect(rose).toBe(120)
    expect(meter.periodMs).toBeCloseTo(8.33, 2)
    // A fast frame now and then (the next one early after a hitch) isn't a run.
    for (let i = 0; i < 100; i++) expect(meter.sample(i % 3 === 0 ? 4 : 12)).toBe(0)
  })
})
