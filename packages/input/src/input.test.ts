import { defineComponent, defineSystem, FixedUpdate, type Rng, t, type World } from '@shard/core'
import type { InputSource, RawInputEvent } from '@shard/platform'
import { App, GlobalRng } from '@shard/runtime'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { defineActions } from './actions'
import { parseBinding } from './bindings'
import {
  addActions,
  describeInput,
  Gamepads,
  injectInput,
  inputPlugin,
  Keyboard,
  Mouse,
  startRecording,
  startReplay,
  stopRecording,
  Touches,
} from './plugin'

/** A fake platform source: push events, they're drained on the next frame. */
function fakeSource() {
  const queue: RawInputEvent[] = []
  const source: InputSource = {
    drain: (out) => {
      out.push(...queue)
      queue.length = 0
    },
    dispose() {},
  }
  return { source, push: (...e: RawInputEvent[]) => queue.push(...e) }
}

const Controls = defineActions('game/Controls', {
  jump: { kind: 'button', bindings: ['Key:Space', 'Gamepad:South'] },
  interact: { kind: 'button', bindings: ['Key:KeyE'], interaction: { hold: 500 } },
  fire: { kind: 'button', bindings: ['Mouse:Left'], interaction: { tap: 200 } },
  dash: {
    kind: 'button',
    bindings: ['Key:ShiftLeft'],
    interaction: { multiTap: { count: 2, window: 300 } },
  },
  move: { kind: 'axis2d', bindings: [{ composite: 'wasd' }, 'Gamepad:LeftStick'], deadZone: 0.2 },
  zoom: {
    kind: 'axis1d',
    bindings: ['Mouse:WheelY', { positive: 'Key:Equal', negative: 'Key:Minus' }],
  },
})

async function makeApp(options: { withSource?: boolean } = {}) {
  const fake = fakeSource()
  const app = new App().addPlugin(
    inputPlugin({
      source: options.withSource === false ? undefined : fake.source,
      actions: [Controls],
    }),
  )
  await app.init()
  const frame = (ms = 1000 / 60) => app.update(ms / 1000)
  return {
    app,
    world: app.world,
    push: fake.push,
    frame,
    actions: () => app.world.resource(Controls.resource),
  }
}

describe('devices', () => {
  it('reports pressed / justPressed / justReleased once per frame', async () => {
    const { world, push, frame } = await makeApp()
    const kb = () => world.resource(Keyboard)
    push({ type: 'key', code: 'KeyW', pressed: true })
    frame()
    expect([kb().pressed('KeyW'), kb().justPressed('KeyW')]).toEqual([true, true])
    frame()
    expect([kb().pressed('KeyW'), kb().justPressed('KeyW')]).toEqual([true, false])
    push({ type: 'key', code: 'KeyW', pressed: false })
    frame()
    expect([kb().pressed('KeyW'), kb().justReleased('KeyW')]).toEqual([false, true])
  })

  it('tracks mouse position, per-frame delta, and wheel', async () => {
    const { world, push, frame } = await makeApp()
    push(
      { type: 'mouse-move', x: 10, y: 20, dx: 3, dy: 4 },
      { type: 'mouse-move', x: 12, y: 21, dx: 2, dy: 1 },
    )
    push(
      { type: 'wheel', dx: 0, dy: -120 },
      { type: 'mouse-button', button: 'right', pressed: true },
    )
    frame()
    const mouse = world.resource(Mouse)
    expect(mouse.position).toEqual([12, 21])
    expect(mouse.delta).toEqual([5, 5])
    expect(mouse.wheel).toEqual([0, -120])
    expect(mouse.justPressed('right')).toBe(true)
    frame()
    expect(mouse.delta).toEqual([0, 0])
    expect(mouse.wheel).toEqual([0, 0])
  })

  it('tracks touches and gamepads (stick Y up-positive)', async () => {
    const { world, push, frame } = await makeApp()
    push(
      { type: 'touch', id: 7, phase: 'start', x: 5, y: 5 },
      { type: 'touch', id: 7, phase: 'move', x: 9, y: 6 },
    )
    push({ type: 'gamepad', index: 0, connected: true, buttons: [1], axes: [0.5, -1, 0, 0] })
    frame()
    expect(world.resource(Touches).active.get(7)?.position).toEqual([9, 6])
    const pad = world.resource(Gamepads).get(0)!
    expect(pad.justPressed('South')).toBe(true)
    expect(pad.axis('LeftStickY')).toBe(1)
    push({ type: 'touch', id: 7, phase: 'end', x: 9, y: 6 })
    frame()
    expect(world.resource(Touches).ended).toEqual([7])
  })

  it('releases everything when focus is lost', async () => {
    const { world, push, frame } = await makeApp()
    push(
      { type: 'key', code: 'KeyA', pressed: true },
      { type: 'mouse-button', button: 'left', pressed: true },
    )
    frame()
    push({ type: 'focus', focused: false })
    frame()
    expect(world.resource(Keyboard).pressed('KeyA')).toBe(false)
    expect(world.resource(Keyboard).justReleased('KeyA')).toBe(true)
    expect(world.resource(Mouse).pressed('left')).toBe(false)
  })
})

describe('action maps', () => {
  it('combines bindings: any device can press a button', async () => {
    const { push, frame, actions } = await makeApp()
    push({ type: 'gamepad', index: 0, connected: true, buttons: [1], axes: [] })
    frame()
    expect(actions().justPressed('jump')).toBe(true)
    expect(actions().performed('jump')).toBe(true)
  })

  it('normalizes composite diagonals and applies radial dead zones', async () => {
    const { push, frame, actions } = await makeApp()
    push({ type: 'key', code: 'KeyW', pressed: true }, { type: 'key', code: 'KeyD', pressed: true })
    frame()
    const [x, y] = actions().axis2d('move')
    expect(Math.hypot(x, y)).toBeCloseTo(1, 5)
    expect(x).toBeCloseTo(y)
    push(
      { type: 'key', code: 'KeyW', pressed: false },
      { type: 'key', code: 'KeyD', pressed: false },
    )
    push({ type: 'gamepad', index: 0, connected: true, buttons: [], axes: [0.1, -0.1, 0, 0] })
    frame()
    expect(actions().axis2d('move')).toEqual([0, 0]) // inside the dead zone
    push({ type: 'gamepad', index: 0, connected: true, buttons: [], axes: [0.6, 0, 0, 0] })
    frame()
    expect(actions().axis2d('move')[0]).toBeCloseTo((0.6 - 0.2) / 0.8)
  })

  it('takes the strongest binding for axes', async () => {
    const { push, frame, actions } = await makeApp()
    push({ type: 'key', code: 'Equal', pressed: true }, { type: 'wheel', dx: 0, dy: -3 })
    frame()
    expect(actions().value('zoom')).toBe(-3)
  })

  it('type-checks action names and validates binding strings', () => {
    const state = Controls.create()
    expectTypeOf<Parameters<typeof state.pressed>[0]>().toEqualTypeOf<
      'jump' | 'interact' | 'fire' | 'dash' | 'move' | 'zoom'
    >()
    // @ts-expect-error: not an action in the map
    expect(() => state.pressed('fly')).toThrow(
      expect.objectContaining({ code: 'input/unknown-action' }),
    )
    expect(() =>
      defineActions('game/Bad', { x: { kind: 'button', bindings: ['Key:Spce'] } }),
    ).toThrow(
      expect.objectContaining({
        code: 'input/unknown-binding',
        hint: expect.stringContaining('Key:Space'),
      }),
    )
    expect(() => parseBinding('Gamepad:Southh')).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('Gamepad:South') }),
    )
  })

  it('reports nothing from a disabled set (contexts)', async () => {
    const { push, frame, actions } = await makeApp()
    actions().enabled = false
    push({ type: 'key', code: 'Space', pressed: true })
    frame()
    expect(actions().pressed('jump')).toBe(false)
    actions().enabled = true
    expect(actions().pressed('jump')).toBe(true)
  })
})

describe('interactions', () => {
  it('hold: started on press, performed at the threshold, canceled if released early', async () => {
    const { push, frame, actions } = await makeApp()
    push({ type: 'key', code: 'KeyE', pressed: true })
    frame(100)
    expect(actions().started('interact')).toBe(true)
    expect(actions().performed('interact')).toBe(false)
    frame(200) // 200 ms after press
    expect(actions().holdProgress('interact')).toBeCloseTo(0.4)
    frame(350) // 550 ms
    expect(actions().performed('interact')).toBe(true)
    frame(100)
    expect(actions().performed('interact')).toBe(false) // performs once per hold

    push({ type: 'key', code: 'KeyE', pressed: false })
    frame()
    push({ type: 'key', code: 'KeyE', pressed: true })
    frame(100)
    push({ type: 'key', code: 'KeyE', pressed: false })
    frame(100)
    expect(actions().canceled('interact')).toBe(true)
  })

  it('tap: performs on a quick release, cancels when held too long', async () => {
    const { push, frame, actions } = await makeApp()
    push({ type: 'mouse-button', button: 'left', pressed: true })
    frame(50)
    push({ type: 'mouse-button', button: 'left', pressed: false })
    frame(50)
    expect(actions().performed('fire')).toBe(true)
    push({ type: 'mouse-button', button: 'left', pressed: true })
    frame(50)
    frame(300)
    push({ type: 'mouse-button', button: 'left', pressed: false })
    frame(50)
    expect(actions().canceled('fire')).toBe(true)
    expect(actions().performed('fire')).toBe(false)
  })

  it('multiTap: performs on the second tap within the window', async () => {
    const { push, frame, actions } = await makeApp()
    const tap = () => {
      push({ type: 'key', code: 'ShiftLeft', pressed: true })
      frame(50)
      push({ type: 'key', code: 'ShiftLeft', pressed: false })
      frame(50)
    }
    tap()
    expect(actions().performed('dash')).toBe(false)
    tap()
    expect(actions().performed('dash')).toBe(true)
    tap()
    frame(500) // window expires
    tap()
    expect(actions().performed('dash')).toBe(false)
  })
})

describe('synthetic input', () => {
  it('injected keys and actions behave like real input, next frame', async () => {
    const { world, frame, actions } = await makeApp({ withSource: false })
    injectInput(world, { key: 'Space', pressed: true })
    expect(actions().pressed('jump')).toBe(false)
    frame()
    expect(actions().justPressed('jump')).toBe(true)
    injectInput(world, { key: 'Space', pressed: false })
    injectInput(world, { action: 'game/Controls.interact', pressed: true })
    frame(600)
    frame(600)
    expect(actions().performed('interact')).toBe(true) // injected actions go through interactions too
    expect(() => injectInput(world, { action: 'nope.jump', pressed: true })).not.toThrow()
    expect(() => frame()).toThrow(
      expect.objectContaining({ message: expect.stringContaining('nope') }),
    )
  })

  it('describes devices and action values', async () => {
    const { world, frame } = await makeApp({ withSource: false })
    injectInput(world, { key: 'KeyW', pressed: true })
    frame()
    const d = describeInput(world)
    expect(d.source).toBe('none (headless)')
    expect(d.keysHeld).toEqual(['KeyW'])
    expect(d.actionMaps[0]?.values.move).toEqual([0, 1])
  })

  it('installs action maps added after startup', async () => {
    const { world, frame } = await makeApp({ withSource: false })
    const Menu = defineActions('game/Menu', { back: { kind: 'button', bindings: ['Key:Escape'] } })
    const menu = addActions(world, Menu)
    injectInput(world, { key: 'Escape', pressed: true })
    frame()
    expect(menu.justPressed('back')).toBe(true)
  })
})

describe('recording and replay', () => {
  const Position = defineComponent('test/InputPos', { value: t.vec2 })

  /** A tiny game: the player moves with the stick/WASD and jumps at random heights. */
  async function game() {
    const { app, world, frame } = await makeApp({ withSource: false })
    const player = world.spawn(Position)
    app.addSystems(
      FixedUpdate,
      defineSystem({
        name: 'test/move',
        run: (_, w: World) => {
          const actions = w.resource(Controls.resource)
          const [x, y] = actions.axis2d('move')
          const p = w.get(player, Position).value
          let jump = 0
          if (actions.performed('jump')) jump = (w.resource(GlobalRng) as Rng).range(1, 3)
          w.set(player, Position, { value: [p[0] + x * 0.1, p[1] + y * 0.1 + jump] })
        },
      }),
    )
    return { world, frame, player }
  }

  it('reproduces the same world from a 600-frame recording', async () => {
    const original = await game()
    startRecording(original.world)
    const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']
    for (let f = 0; f < 600; f++) {
      if (f % 7 === 0)
        injectInput(original.world, { key: keys[f % 5]!, pressed: (f / 7) % 2 === 0 })
      if (f % 45 === 3)
        injectInput(original.world, { action: 'game/Controls.jump', pressed: f % 90 === 3 })
      original.frame()
    }
    const recording = stopRecording(original.world)
    const expected = original.world.get(original.player, Position).value

    const replay = await game()
    startReplay(replay.world, recording)
    for (let f = 0; f < 600; f++) replay.frame()
    expect(replay.world.get(replay.player, Position).value).toEqual(expected)
    expect(Math.hypot(expected[0], expected[1])).toBeGreaterThan(1) // the run actually did something
  })
})
