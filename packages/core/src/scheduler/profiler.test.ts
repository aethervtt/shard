import { describe, expect, it } from 'vitest'
import type { ShardError } from '../error'
import { clockInfo, defineSpan, Profiler, spanCovers, spanName, spanStats, TRACK } from './profiler'

/** A clock that only moves when told to. */
function fakeClock() {
  const clock = { t: 0, now: () => clock.t }
  return clock
}

describe('spanCovers (0074, 0075)', () => {
  it('covers equal names and prefixes ending at a "/"', () => {
    expect(spanCovers('frame', 'frame')).toBe(true)
    expect(spanCovers('render', 'render/opaque')).toBe(true)
    expect(spanCovers('render/', 'render/opaque')).toBe(true)
    expect(spanCovers('gpu:foliage', 'gpu:foliage/place')).toBe(true)
    expect(spanCovers('gpu:foliage', 'gpu:foliage/cull')).toBe(true)
    expect(spanCovers('schedule/Update', 'schedule/Update')).toBe(true)
  })

  it("doesn't cover other names that merely start the same", () => {
    expect(spanCovers('render', 'renderer/x')).toBe(false)
    expect(spanCovers('gpu:foliage', 'gpu:foliage-cull')).toBe(false)
    expect(spanCovers('render/opaque', 'render')).toBe(false)
    expect(spanCovers('', 'frame')).toBe(false)
  })
})

describe('Profiler spans (0074)', () => {
  it('defineSpan registers nothing; the first begin interns it into a u16 id', () => {
    const span = defineSpan('test-profiler/encode')
    expect(span).toEqual({ name: 'test-profiler/encode', id: -1 })
    const clock = fakeClock()
    const p = new Profiler({ now: clock.now })
    const t = p.begin(span)
    expect(span.id).toBeGreaterThanOrEqual(0)
    expect(span.id).toBeLessThan(65536)
    expect(spanName(span.id)).toBe('test-profiler/encode')
    clock.t = 2.5
    p.end(t)
    expect(p.timing('test-profiler/encode')).toEqual({ last: 2.5, avg: 2.5, max: 2.5, samples: 1 })
  })

  it('nests spans and keeps last/avg/max/p95 over the window', () => {
    const clock = fakeClock()
    const p = new Profiler({ now: clock.now, settings: { enabled: true, window: 4 } })
    const outer = defineSpan('test-profiler/outer')
    const inner = defineSpan('test-profiler/inner')
    for (let i = 1; i <= 6; i++) {
      const a = p.begin(outer)
      const b = p.begin(inner)
      clock.t += i
      p.end(b)
      clock.t += 1
      p.end(a)
    }
    // The window holds runs 3–6: inner took 3, 4, 5, 6.
    expect(p.timing('test-profiler/inner')).toEqual({ last: 6, avg: 4.5, max: 6, samples: 4 })
    expect(spanStats(p, 'test-profiler/outer')).toMatchObject({
      last: 7,
      max: 7,
      p95: 7,
      track: 'main',
    })
  })

  it('record(name, ms) keeps working for existing callers, and all() lists it', () => {
    const p = new Profiler()
    p.record('test-profiler/legacy', 1.25)
    p.record('test-profiler/legacy', 0.75)
    expect(p.timing('test-profiler/legacy')).toMatchObject({ last: 0.75, avg: 1, samples: 2 })
    expect(p.all()['test-profiler/legacy']?.samples).toBe(2)
    expect(spanStats(p, 'gpu:test-profiler')).toBeUndefined()
    p.record('gpu:test-profiler', 3)
    expect(spanStats(p, 'gpu:test-profiler')?.track).toBe('gpu')
  })

  it('an unbalanced end logs perf/span-mismatch once per name; the frame resets the stack', () => {
    const clock = fakeClock()
    const p = new Profiler({ now: clock.now })
    const warnings: ShardError[] = []
    p.onWarning = (w) => warnings.push(w)
    const a = defineSpan('test-profiler/a')
    const b = defineSpan('test-profiler/b')
    for (let frame = 0; frame < 3; frame++) {
      const f = p.beginFrame(frame)
      const ta = p.begin(a)
      const tb = p.begin(b)
      p.end(ta) // out of order: b is still open
      p.end(tb) // b is no longer on the stack: dropped
      p.endFrame(f)
    }
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ['perf/span-mismatch', 'test-profiler/a'],
      ['perf/span-mismatch', 'test-profiler/b'],
    ])
    expect(p.timing('test-profiler/a')?.samples).toBe(3)
    // A span left open is dropped when the next frame begins, and reported once.
    p.begin(defineSpan('test-profiler/open'))
    p.beginFrame(4)
    expect(warnings.at(-1)?.path).toBe('test-profiler/open')
  })

  it('async spans end in another frame, matched by key', () => {
    const clock = fakeClock()
    const p = new Profiler({ now: clock.now })
    const load = defineSpan('test-profiler/load')
    p.beginAsync(load, 'a.png')
    clock.t = 1
    p.beginAsync(load, 'b.png')
    clock.t = 5
    p.endAsync(load, 'b.png')
    clock.t = 9
    p.endAsync(load, 'a.png')
    expect(p.timing('test-profiler/load')).toMatchObject({ samples: 2, max: 9 })
    expect(spanStats(p, 'test-profiler/load')?.track).toBe('async')
  })

  it('ProfilerSettings.enabled = false turns everything off; window changes take effect', () => {
    const settings = { enabled: false, window: 120 }
    const p = new Profiler({ settings })
    const span = defineSpan('test-profiler/off')
    expect(p.begin(span)).toBe(-1)
    p.end(-1)
    p.record(span, 3)
    expect(p.timing('test-profiler/off')).toBeUndefined()
    settings.enabled = true
    settings.window = 2
    p.beginFrame(0)
    for (let i = 0; i < 5; i++) p.record(span, i)
    expect(p.timing('test-profiler/off')?.samples).toBe(2)
    expect(p.window).toBe(2)
  })

  it('hands spans to a sink with their track and depth', () => {
    const clock = fakeClock()
    const p = new Profiler({ now: clock.now })
    const events: [string, number, number, number, number][] = []
    p.sink = {
      event: (id, track, depth, start, ms) =>
        void events.push([spanName(id), track, depth, start, ms]),
      frameStart: () => {},
      frameEnd: () => {},
    }
    const f = p.beginFrame(7)
    const s = p.begin(defineSpan('test-profiler/system'))
    clock.t = 2
    p.record('gpu:test-profiler/pass', 0.5, TRACK.gpu, 1)
    p.end(s)
    clock.t = 3
    p.endFrame(f)
    expect(events).toEqual([
      ['gpu:test-profiler/pass', TRACK.gpu, 0, 1, 0.5],
      ['test-profiler/system', TRACK.main, 1, 0, 2],
      ['frame', TRACK.main, 0, 0, 3],
    ])
  })

  it('reports its clock: resolution and whether the page is isolated', () => {
    const clock = clockInfo()
    expect(clock.resolutionMs).toBeGreaterThanOrEqual(0)
    expect(clock.isolated).toBe(true) // not a page: nothing coarsens the clock
  })
})
