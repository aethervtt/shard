import {
  defineComponent,
  defineResource,
  defineSystem,
  FixedUpdate,
  t,
  Update,
} from '@aethervtt/shard-core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './app'
import { AppControlResource } from './control'
import { FrameDemand } from './demand'
import { LogResource } from './log'
import { definePlugin } from './plugin'
import { animationFrameRunner } from './runners'
import { type FakeFrames, fakeAnimationFrames } from './testing'
import { Time } from './time'

const Spin = defineComponent('test/Spin', { angle: t.f32 })
const Tuning = defineResource<{ glow: number }>('test/Tuning', { hostWritable: true })

let frames: FakeFrames

/** Timers and the clock only: the frame loop is FakeFrames'. */
const fakeTimers = () =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
  })

/** Lets app.run() get through init to the runner's first frame request. */
async function started(): Promise<void> {
  for (let i = 0; i < 100 && frames.pending === 0; i++) await Promise.resolve()
}
// The runner loads the write check lazily: have it loaded, so starting takes only microtasks.
beforeAll(async () => {
  await import('./write-check')
})
beforeEach(() => {
  frames = fakeAnimationFrames()
})
afterEach(() => {
  frames.restore()
  vi.useRealTimers()
})

/** An on-demand app that counts its frames, started and settled (its first frame has run). */
async function onDemandApp(options: { checkResourceWrites?: boolean } = {}) {
  const counts = { frames: 0, fixed: 0, deltas: [] as number[] }
  const app = new App().addPlugin(
    definePlugin({
      name: 'test/counter',
      build(app) {
        app.insertResource(Tuning, { glow: 1 })
        app.addSystems(
          Update,
          defineSystem({
            name: 'test/count',
            run: (_, world) => {
              counts.frames++
              counts.deltas.push(world.resource(Time).delta)
            },
          }),
        )
        app.addSystems(
          FixedUpdate,
          defineSystem({ name: 'test/fixed', run: () => void counts.fixed++ }),
        )
      },
    }),
  )
  app.setRunner(animationFrameRunner({ mode: 'on-demand', measureRefresh: false, ...options }))
  const running = app.run()
  await started()
  frames.runUntilIdle()
  return { app, world: app.world, counts, running }
}

describe('on-demand frames (0052)', () => {
  it('renders the first frame, then requests no animation frames while idle', async () => {
    fakeTimers()
    const { app, counts } = await onDemandApp()
    expect(counts.frames).toBe(1)
    const requested = frames.requested
    for (let i = 0; i < 300; i++) {
      vi.advanceTimersByTime(1000 / 60)
      frames.tick()
    }
    expect(frames.requested - requested).toBe(0)
    expect(counts.frames).toBe(1)
    await app.dispose()
  })

  it('wakes for exactly one frame when host code writes the world', async () => {
    const { app, world, counts } = await onDemandApp()
    const e = world.spawn([Spin, { angle: 0 }])
    world.set(e, Spin, { angle: 1 })
    world.set(e, Spin, { angle: 2 })
    expect(frames.runUntilIdle()).toBe(1)
    expect(counts.frames).toBe(2)
    world.patchResource(Tuning, { glow: 0.45 })
    expect(frames.runUntilIdle()).toBe(1)
    world.resource(Tuning).glow = 0.2 // a bare assignment is invisible
    expect(frames.runUntilIdle()).toBe(0)
    app.requestFrame()
    app.requestFrame()
    expect(frames.runUntilIdle()).toBe(1)
    await app.dispose()
  })

  it('keeps running while a demand is held, and stops once it is released', async () => {
    const { app, world, counts } = await onDemandApp()
    const demand = world.resource(FrameDemand)
    demand.hold('test/spinning')
    expect(frames.pending).toBe(1)
    for (let i = 0; i < 10; i++) frames.tick()
    expect(counts.frames).toBe(11)
    expect(demand.describe()).toEqual({
      mode: 'on-demand',
      demands: ['test/spinning'],
      dueInMs: null,
    })
    demand.release('test/spinning')
    expect(frames.runUntilIdle()).toBe(1) // the frame already requested
    expect(frames.pending).toBe(0)
    await app.dispose()
  })

  it('runs one frame after(ms), and steps queued through AppControl', async () => {
    fakeTimers()
    const { app, world, counts } = await onDemandApp()
    world.resource(FrameDemand).after(250)
    vi.advanceTimersByTime(249)
    expect(frames.pending).toBe(0)
    vi.advanceTimersByTime(1)
    expect(frames.runUntilIdle()).toBe(1)
    const done = world.resource(AppControlResource).step(3)
    expect(frames.runUntilIdle()).toBe(3)
    await done
    expect(counts.frames).toBe(5)
    await app.dispose()
  })

  it('wakes with one fixed step, not the time it slept', async () => {
    const { app, world, counts } = await onDemandApp()
    world.resource(FrameDemand).hold('test/busy')
    frames.tick(1000 / 60)
    frames.tick(1000 / 60)
    world.resource(FrameDemand).release('test/busy')
    frames.runUntilIdle()
    const fixedBefore = counts.fixed
    frames.tick(60_000) // a minute passes with nothing to do
    world.spawn(Spin)
    frames.tick(1000 / 60)
    expect(counts.deltas.at(-1)).toBeCloseTo(1 / 60)
    expect(counts.fixed - fixedBefore).toBe(1)
    await app.dispose()
  })

  it('logs runtime/unmarked-resource-write for a hostWritable resource changed while idle', async () => {
    fakeTimers()
    const { app, world } = await onDemandApp({ checkResourceWrites: true })
    const log = world.resource(LogResource)
    world.resource(Tuning).glow = 0.45
    vi.advanceTimersByTime(1000)
    const entry = log.tail(10).find((e) => e.code === 'runtime/unmarked-resource-write')
    expect(entry?.path).toBe('test/Tuning')
    expect(frames.pending).toBe(0)
    // The same write through patchResource wakes the app instead.
    world.patchResource(Tuning, { glow: 0.5 })
    frames.runUntilIdle()
    vi.advanceTimersByTime(3000)
    expect(log.tail(10).filter((e) => e.code === 'runtime/unmarked-resource-write')).toHaveLength(1)
    await app.dispose()
  })

  it('stops the loop on dispose: nothing requested, no listeners, no wake hook', async () => {
    const { app, world, running } = await onDemandApp()
    world.resource(FrameDemand).hold('test/forever')
    frames.tick()
    expect(frames.pending).toBe(1)
    expect(frames.listeners).toBe(1)
    await app.dispose()
    await running
    expect(frames.pending).toBe(0)
    expect(frames.listeners).toBe(0)
    expect(world.onWake).toBeUndefined()
    world.spawn(Spin)
    expect(frames.pending).toBe(0)
  })
})

describe('continuous frames', () => {
  it('requests a frame every refresh, and stops on abort', async () => {
    const controller = new AbortController()
    const app = new App().setRunner(
      animationFrameRunner({ measureRefresh: false, signal: controller.signal }),
    )
    const running = app.run()
    await started()
    for (let i = 0; i < 5; i++) frames.tick()
    expect(app.world.resource(Time).frame).toBe(5)
    expect(app.world.resource(FrameDemand).mode).toBe('continuous')
    controller.abort()
    await running
    expect(frames.pending).toBe(0)
  })
})
