import { describe, expect, it } from 'vitest'
import { defineSpan, Profiler, TRACK } from '../profiler'
import { startCapture } from './index'
import { hottestFromCpuProfile, hottestFromSelfProfile, samplesFromSelfProfile } from './samples'

const clockOf = () => {
  const clock = { t: 1000, now: () => clock.t }
  return clock
}

const FRAME_SPANS = {
  update: defineSpan('schedule/Update'),
  move: defineSpan('test-capture/move'),
  spawn: defineSpan('test-capture/spawn'),
  execute: defineSpan('render/execute-graph'),
  opaque: defineSpan('render/opaque'),
  load: defineSpan('test-capture/load'),
  commands: defineSpan('commands/Update'),
}

/**
 * One scripted frame on a fake clock: Update runs `move` and `spawn` (with commands), then the
 * graph system encodes `render/opaque` for two views. The previous frame's GPU passes land, placed
 * at its submit time; a worker job and a GC pause go on their tracks.
 */
function frame(p: Profiler, clock: { t: number }, n: number, spawnMs: number, submits: number[]) {
  const f = p.beginFrame(n)
  const u = p.begin(FRAME_SPANS.update)
  const m = p.begin(FRAME_SPANS.move)
  clock.t += 1
  p.end(m)
  const s = p.begin(FRAME_SPANS.spawn)
  clock.t += spawnMs
  p.end(s)
  p.event(FRAME_SPANS.commands, TRACK.main, clock.t, 0.25)
  clock.t += 0.25
  p.end(u)
  const g = p.begin(FRAME_SPANS.execute)
  for (let view = 0; view < 2; view++) {
    p.event(FRAME_SPANS.opaque, TRACK.main, clock.t, 0.5)
    clock.t += 0.5
  }
  p.sample(FRAME_SPANS.opaque, 1)
  clock.t += 0.25
  p.end(g)
  submits.push(clock.t)
  if (n > 0) {
    const at = submits[n - 1]!
    p.record('gpu:opaque', 2, TRACK.gpu, at, n - 1)
    p.record('gpu:tonemap', 0.5, TRACK.gpu, at + 2, n - 1)
    p.record('gpu:frame', 2.5, TRACK.gpu, at, n - 1)
  }
  p.record('worker/noise', 3, TRACK.worker + (n % 2), clock.t - 3)
  if (n === 1) p.event('gc/minor', TRACK.gc, clock.t - 1, 0.5)
  if (n === 0) p.beginAsync(FRAME_SPANS.load, 'rock.glb')
  if (n === 2) p.endAsync(FRAME_SPANS.load, 'rock.glb')
  clock.t += 1
  p.endFrame(f)
  clock.t += 12 // idle until the next frame
}

describe('captures (0074)', () => {
  it('a capture with a fake clock produces the golden trace', async () => {
    const clock = clockOf()
    const p = new Profiler({ now: clock.now })
    const recorder = startCapture(p, { frames: 3 })
    const submits: number[] = []
    for (let n = 0; n < 8 && recorder.running; n++) frame(p, clock, n, n === 1 ? 9 : 1, submits)
    const capture = await recorder.done
    expect(p.sink).toBeUndefined()
    expect(capture.frameCount).toBe(3)
    const trace = capture.trace()
    // Main, GPU, async, GC and worker tracks.
    const threads = trace.traceEvents
      .filter((e) => e.name === 'thread_name')
      .map((e) => e.args!.name)
    expect(threads).toEqual([
      'main',
      'gpu (approximate: placed at submit)',
      'async',
      'gc',
      'worker 0',
      'worker 1',
    ])
    await expect(`${JSON.stringify(trace, null, 2)}\n`).toMatchFileSnapshot(
      './__golden__/capture-trace.snap',
    )
  })

  it('the summary names the span that grew in the worst frame, and keys cover spans once', async () => {
    const clock = clockOf()
    const p = new Profiler({ now: clock.now })
    const recorder = startCapture(p, { frames: 5 })
    const submits: number[] = []
    for (let n = 0; n < 12 && recorder.running; n++) frame(p, clock, n, n === 3 ? 18 : 0.4, submits)
    const capture = await recorder.done
    const summary = capture.summary({
      clock: { resolutionMs: 0.001, isolated: true, gpuQuantized: false },
    })
    expect(summary.frames.count).toBe(5)
    expect(summary.worst[0]).toMatchObject({ frame: 3, cpuMs: 21.5 })
    expect(summary.worst[0]!.over[0]).toEqual({ span: 'test-capture/spawn', ms: 18, medianMs: 0.4 })
    // Its parents grew by the same 17.6 ms, but their own time didn't: they aren't the lead.
    expect(summary.worst[0]!.over.map((o) => o.span)).not.toContain('schedule/Update')
    expect(summary.frames.gpu).toEqual({ p50: 2.5, p95: 2.5, max: 2.5 })
    // The asset load spans two frames on the async track: the most time, though not per frame.
    expect(summary.top[0]).toMatchObject({ span: 'test-capture/load', track: 'async', calls: 1 })
    expect(summary.top[1]!.span).toBe('schedule/Update')
    expect(summary.top.find((s) => s.span === 'render/opaque')).toMatchObject({
      track: 'main',
      calls: 10,
      total: 5,
      p50: 1,
    })
    expect(summary.warnings).toEqual([])
    // `render` covers render/execute-graph and the render/opaque spans inside it: counted once.
    expect([...capture.spanTime('render')]).toEqual([1.25, 1.25, 1.25, 1.25, 1.25])
    expect([...capture.spanTime('render/opaque')]).toEqual([1, 1, 1, 1, 1])
    expect(capture.spanTime('gpu:opaque')[1]).toBe(2)
  })

  it('the flight recorder stops `after` frames past the first slow one, keeping `before`', async () => {
    const clock = clockOf()
    const p = new Profiler({ now: clock.now })
    const span = defineSpan('test-capture/busy')
    const recorder = startCapture(p, { until: { frameMs: 15 }, before: 120, after: 30 })
    let ran = 0
    for (let n = 0; n < 1000 && recorder.running; n++, ran++) {
      const f = p.beginFrame(n)
      const t = p.begin(span)
      clock.t += n === 400 ? 20 : 1
      p.end(t)
      p.endFrame(f)
      clock.t += 15
    }
    const capture = await recorder.done
    expect(ran).toBe(431)
    expect(capture.trigger).toEqual({ frame: 400, frameMs: 20 })
    expect(capture.frames.numbers[0]).toBe(280)
    expect(capture.frames.numbers[capture.frameCount - 1]).toBe(430)
    const summary = capture.summary({
      clock: { resolutionMs: 0, isolated: false, gpuQuantized: false },
    })
    expect(summary.worst[0]!.frame).toBe(400)
    expect(summary.capture).toMatchObject({ mode: 'until', range: [280, 430] })
    expect(summary.warnings.map((w) => w.code)).toEqual(['perf/clock-coarse'])
  })

  it('stops and says truncated when the event buffer fills', async () => {
    const clock = clockOf()
    const p = new Profiler({ now: clock.now })
    const span = defineSpan('test-capture/many')
    const recorder = startCapture(p, { frames: 100, events: 64 })
    for (let n = 0; n < 100 && recorder.running; n++) {
      const f = p.beginFrame(n)
      for (let i = 0; i < 10; i++) p.end(p.begin(span))
      p.endFrame(f)
    }
    const capture = await recorder.done
    expect(capture.truncated).toBe(true)
    expect(capture.frameCount).toBeLessThan(10)
    expect(() => startCapture(p).start()).toThrow(/already running/)
  })

  it('turns sampled profiles into the hottest functions', () => {
    const hottest = hottestFromCpuProfile({
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
        {
          id: 2,
          callFrame: { functionName: 'busyWait', url: 'file:///fixture.ts', lineNumber: 9 },
        },
        { id: 3, callFrame: { functionName: 'other', url: 'file:///x.ts', lineNumber: 0 } },
      ],
      startTime: 0,
      endTime: 4000,
      samples: [2, 2, 3, 2],
      timeDeltas: [0, 1000, 1000, 1000],
    })
    expect(hottest[0]).toEqual({
      name: 'busyWait',
      url: 'file:///fixture.ts',
      line: 10,
      selfMs: 2,
      share: 0.667,
    })
    const trace = {
      resources: ['https://x/app.js'],
      frames: [{ name: 'draw', resourceId: 0, line: 3 }, { name: 'tick' }],
      stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }],
      samples: [
        { timestamp: 10, stackId: 1 },
        { timestamp: 11, stackId: 1 },
        { timestamp: 12, stackId: 0 },
        { timestamp: 13 },
      ],
    }
    expect(hottestFromSelfProfile(trace, 1).map((f) => f.name)).toEqual(['tick', 'draw'])
    expect(samplesFromSelfProfile(trace, 1)).toEqual([
      { name: 'tick', start: 10, ms: 2 },
      { name: 'draw', start: 12, ms: 1 },
    ])
  })
})
