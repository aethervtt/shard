import type { InputSource, PointerPolicy, RawInputEvent } from '@aethervtt/shard-platform'
import { App, FrameDemand } from '@aethervtt/shard-runtime'
import { describe, expect, it } from 'vitest'
import {
  Gesture,
  type GestureEvent,
  Gestures,
  gestureFrames,
  gesturesPlugin,
  simulateGestures,
} from './gestures'
import { injectInput, inputPlugin, Mouse, rebindAction } from './plugin'

function fakeSource() {
  const queue: RawInputEvent[] = []
  const claimed: number[] = []
  const policies: PointerPolicy[] = []
  const source: InputSource = {
    drain: (out) => {
      out.push(...queue)
      queue.length = 0
    },
    claimPointer: (id) => claimed.push(id),
    setPointerPolicy: (p) => policies.push(p),
    dispose() {},
  }
  return { source, push: (...e: RawInputEvent[]) => queue.push(...e), claimed, policies }
}

async function makeApp() {
  const fake = fakeSource()
  const app = new App().addPlugin(inputPlugin({ source: fake.source }), gesturesPlugin)
  await app.init()
  const reader = app.world.reader(Gesture)
  const seen: GestureEvent[] = []
  const frame = (ms = 1000 / 60) => {
    app.update(ms / 1000)
    for (const g of reader.read()) seen.push({ ...g })
  }
  const kinds = () => seen.map((g) => g.kind)
  const pointer = (
    phase: 'down' | 'move' | 'up' | 'cancel',
    x: number,
    y: number,
    id = 1,
    extra: Partial<Extract<RawInputEvent, { type: 'pointer' }>> = {},
  ) =>
    fake.push({
      type: 'pointer',
      id,
      phase,
      pointer: 'mouse',
      button: 'left',
      x,
      y,
      modifiers: 0,
      ...extra,
    })
  frame()
  return { app, world: app.world, fake, frame, seen, kinds, pointer }
}

describe('gestures (0060)', () => {
  it('a 3 px move is a tap; a 5 px move is a drag', async () => {
    const a = await makeApp()
    a.pointer('down', 100, 100)
    a.pointer('move', 103, 100)
    a.pointer('up', 103, 100)
    a.frame()
    expect(a.kinds()).toEqual(['tap'])

    const b = await makeApp()
    b.pointer('down', 100, 100)
    b.frame()
    b.pointer('move', 105, 100)
    b.frame()
    b.pointer('move', 120, 110)
    b.pointer('up', 120, 110)
    b.frame()
    expect(b.kinds()).toEqual(['drag-start', 'drag', 'drag-end'])
    const [start, drag, end] = b.seen
    expect(start).toMatchObject({ x: 105, y: 100, startX: 100, startY: 100, dx: 5, dy: 0 })
    expect(drag).toMatchObject({ dx: 15, dy: 10 })
    expect(end).toMatchObject({ cancelled: false, x: 120, y: 110 })
    expect(new Set([start!.id, drag!.id, end!.id]).size).toBe(1)
  })

  it('two quick taps in place are a double tap; a held press is a long press', async () => {
    const a = await makeApp()
    a.pointer('down', 50, 50)
    a.pointer('up', 50, 50)
    a.frame(100)
    a.pointer('down', 53, 52)
    a.pointer('up', 53, 52)
    a.frame()
    expect(a.kinds()).toEqual(['tap', 'tap', 'double-tap'])

    const b = await makeApp()
    b.pointer('down', 50, 50)
    b.pointer('up', 50, 50)
    b.frame()
    b.frame(400) // too late for a double tap
    b.pointer('down', 50, 50)
    b.pointer('up', 50, 50)
    b.frame()
    expect(b.kinds()).toEqual(['tap', 'tap'])

    const c = await makeApp()
    c.pointer('down', 50, 50)
    c.frame()
    // On-demand runners get a frame for the long press.
    expect(c.world.resource(FrameDemand).dueIn()).toBeLessThan(Number.POSITIVE_INFINITY)
    for (let i = 0; i < 40; i++) c.frame()
    c.pointer('up', 50, 50)
    c.frame()
    expect(c.kinds()).toEqual(['long-press'])
  })

  it('two fingers pan, pinch and twist about their center', async () => {
    const a = await makeApp()
    const touch = { pointer: 'touch' as const }
    a.pointer('down', 100, 100, 1, touch)
    a.pointer('down', 200, 100, 2, touch)
    a.frame()
    // Spread to twice the distance, turn a quarter, and move the center by (10, 20).
    a.pointer('move', 160, 20, 1, touch)
    a.pointer('move', 160, 220, 2, touch)
    a.frame()
    const pan = a.seen.filter((g) => g.kind === 'pan2')
    const pinch = a.seen.filter((g) => g.kind === 'pinch')
    const twist = a.seen.filter((g) => g.kind === 'twist')
    const sum = (
      list: GestureEvent[],
      f: (g: GestureEvent) => number,
      op = (x: number, y: number) => x + y,
      init = 0,
    ) => list.reduce((acc, g) => op(acc, f(g)), init)
    expect(sum(pan, (g) => g.dx)).toBeCloseTo(10)
    expect(sum(pan, (g) => g.dy)).toBeCloseTo(20)
    expect(
      sum(
        pinch,
        (g) => g.scale,
        (x, y) => x * y,
        1,
      ),
    ).toBeCloseTo(2)
    expect(sum(twist, (g) => g.angle)).toBeCloseTo(Math.PI / 2)
    expect(new Set(a.seen.map((g) => g.id)).size).toBe(1)
    expect(a.kinds()).not.toContain('drag-start')
  })

  it('normalizes the wheel; a ctrl wheel is a pinch', async () => {
    const a = await makeApp()
    a.fake.push({ type: 'wheel', dx: 0, dy: 100, x: 30, y: 40 })
    a.fake.push({ type: 'wheel', dx: 0, dy: -50, x: 30, y: 40, modifiers: 2 })
    a.frame()
    expect(a.seen[0]).toMatchObject({ kind: 'wheel', id: 0, dy: 100, x: 30, y: 40 })
    expect(a.seen[1]!.kind).toBe('pinch')
    expect(a.seen[1]!.scale).toBeGreaterThan(1)
  })

  it('Escape cancels a drag; its pointer is ignored until it lifts', async () => {
    const a = await makeApp()
    a.pointer('down', 0, 0)
    a.pointer('move', 20, 0)
    a.frame()
    injectInput(a.world, { key: 'Escape', pressed: true })
    a.frame()
    a.pointer('move', 40, 0)
    a.pointer('up', 40, 0)
    a.frame()
    expect(a.kinds()).toEqual(['drag-start', 'drag-end'])
    expect(a.seen[1]!.cancelled).toBe(true)

    // A host can rebind it, or remove it.
    rebindAction(a.world, 'input/GestureActions.cancel', [])
    a.seen.length = 0
    a.pointer('down', 0, 0, 2)
    a.pointer('move', 20, 0, 2)
    a.frame()
    injectInput(a.world, { key: 'Escape', pressed: false })
    a.frame()
    injectInput(a.world, { key: 'Escape', pressed: true })
    a.frame()
    expect(a.kinds()).toEqual(['drag-start'])
  })

  it('claims: the owner takes the pointers; holds keep fallback consumers off', async () => {
    const a = await makeApp()
    a.pointer('down', 0, 0, 9)
    a.pointer('move', 20, 0, 9)
    a.frame()
    const g = a.world.resource(Gestures)
    const id = a.seen[0]!.id
    expect(g.free(id)).toBe(true)
    g.hold(id)
    expect(g.free(id)).toBe(false)
    expect(g.claim(id, 'host')).toBe(true)
    expect(a.fake.claimed).toEqual([9])
    expect(g.claim(id, 'controls')).toBe(false)
    expect(g.take(id, 'drag')).toBe(true)
    expect(g.owner(id)).toBe('drag')
    a.pointer('up', 20, 0, 9)
    a.frame()
    expect(g.live(id)).toBe(false)
    // The owner is still known the frame the drag ends, then it's gone.
    expect(g.owner(id)).toBe('drag')
    a.frame()
    expect(g.owner(id)).toBeUndefined()
  })

  it("a press on UI is the UI's: nothing else can claim it", async () => {
    const a = await makeApp()
    a.world.resource(Mouse).captured = true
    a.pointer('down', 0, 0)
    a.pointer('move', 30, 0)
    a.frame()
    const id = a.seen[0]!.id
    const g = a.world.resource(Gestures)
    expect(g.owner(id)).toBe('ui')
    expect(g.free(id)).toBe(false)
    expect(g.claim(id, 'controls')).toBe(false)
  })

  it('tells the source the union of what enabled consumers take, when it changes', async () => {
    const a = await makeApp()
    const g = a.world.resource(Gestures)
    g.setPolicy('a', { buttons: ['right'], wheel: true, touch: false })
    g.setPolicy('b', { buttons: ['middle', 'right'], wheel: false, touch: true })
    a.frame()
    a.frame()
    expect(a.fake.policies).toEqual([{ buttons: ['middle', 'right'], wheel: true, touch: true }])
    g.setPolicy('a', undefined)
    g.setPolicy('b', undefined)
    a.frame()
    expect(a.fake.policies.at(-1)).toEqual({ buttons: [], wheel: false, touch: false })
  })

  it('simulates gestures a step per frame', async () => {
    const a = await makeApp()
    const frames = simulateGestures(a.world, [
      { drag: { from: [0, 0], to: [100, 0], frames: 4 } },
      { tap: [10, 10] },
      { pinch: { center: [50, 50], from: 100, to: 200, frames: 2 } },
    ])
    expect(frames).toBe(
      gestureFrames([{ drag: { from: [0, 0], to: [100, 0], frames: 4 } }]).length + 2 + 4,
    )
    for (let i = 0; i < frames + 1; i++) a.frame()
    expect(a.kinds().filter((k) => k !== 'pan2' && k !== 'twist')).toEqual([
      'drag-start',
      'drag',
      'drag',
      'drag',
      'drag-end',
      'tap',
      'pinch',
      'pinch',
      'pinch',
      'pinch',
    ])
    expect(a.world.resource(FrameDemand).isHeld('input/simulate')).toBe(false)
  })
})
