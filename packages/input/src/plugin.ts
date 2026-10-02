import { defineResource, defineSystem, First, ShardError, type World } from '@aethervtt/shard-core'
import type { InputSource, RawInputEvent } from '@aethervtt/shard-platform'
import { definePlugin, FrameDemand, type Plugin, Time } from '@aethervtt/shard-runtime'
import type { ActionMapDef, ActionState, Devices } from './actions'
import {
  GAMEPAD_AXES,
  GAMEPAD_BUTTONS,
  GamepadsState,
  KeyboardState,
  MouseState,
  PointersState,
  TouchesState,
} from './devices'
import * as pluginModule from './plugin'

export const Keyboard = defineResource<KeyboardState>('input/Keyboard', {
  description: 'Keys by KeyboardEvent.code.',
})
export const Mouse = defineResource<MouseState>('input/Mouse', {
  description: 'Mouse buttons, position, delta, wheel.',
})
export const Gamepads = defineResource<GamepadsState>('input/Gamepads', {
  description: 'Connected gamepads (standard mapping).',
})
export const Touches = defineResource<TouchesState>('input/Touches', {
  description: 'Active touches.',
})
export const Pointers = defineResource<PointersState>('input/Pointers', {
  description: "This frame's pointer and wheel events in CSS pixels, for gestures (0060).",
})

interface InputQueueState {
  source: InputSource | undefined
  /** Injected events, applied at the start of the next frame. */
  pending: RawInputEvent[]
  scratch: RawInputEvent[]
  maps: ActionState<string>[]
  /** Frames recorded so far (events per frame), when recording. */
  recording: RawInputEvent[][] | undefined
  /** Frames to play back instead of live input, when replaying. */
  replay: { frames: Map<number, RawInputEvent[]>; frame: number; length: number } | undefined
  /** Simulated input still to come (`simulateInput`), one entry per frame, merged with live input. */
  scheduled: RawInputEvent[][]
}

export const InputQueue = defineResource<InputQueueState>('input/Queue', {
  description: 'Raw input buffer: live source, injected events, recording, replay.',
})

export interface InputPluginOptions {
  /** Live input (e.g. `createDomInputSource(canvas)`). Omit when headless. */
  source?: InputSource
  /** Action maps to install as resources. */
  actions?: readonly ActionMapDef<string>[]
}

function devices(world: World): Devices {
  return {
    keyboard: world.resource(Keyboard),
    mouse: world.resource(Mouse),
    gamepads: world.resource(Gamepads),
    touches: world.resource(Touches),
  }
}

function pointers(world: World, e: RawInputEvent): void {
  if (e.type !== 'pointer' && e.type !== 'wheel' && e.type !== 'focus') return
  const p = world.resource(Pointers)
  p.events.push(e)
  if (e.type === 'pointer') {
    p.position[0] = e.x
    p.position[1] = e.y
  }
}

function apply(world: World, d: Devices, e: RawInputEvent): void {
  switch (e.type) {
    case 'key':
      d.keyboard.set(e.code, e.pressed)
      break
    case 'mouse-button':
      d.mouse.set(e.button, e.pressed)
      break
    case 'mouse-move':
      d.mouse.position[0] = e.x
      d.mouse.position[1] = e.y
      d.mouse.delta[0] += e.dx
      d.mouse.delta[1] += e.dy
      break
    case 'wheel':
      d.mouse.wheel[0] += e.dx
      d.mouse.wheel[1] += e.dy
      break
    case 'touch': {
      if (e.phase === 'start') {
        d.touches.active.set(e.id, { id: e.id, position: [e.x, e.y], start: [e.x, e.y] })
        d.touches.started.push(e.id)
      } else if (e.phase === 'move') {
        const t = d.touches.active.get(e.id)
        if (t) {
          t.position[0] = e.x
          t.position[1] = e.y
        }
      } else {
        d.touches.active.delete(e.id)
        d.touches.captured.delete(e.id)
        d.touches.ended.push(e.id)
      }
      break
    }
    case 'text':
      d.keyboard.typed += e.text
      break
    case 'gamepad': {
      const pad = d.gamepads.slot(e.index)
      pad.connected = e.connected
      for (let i = 0; i < GAMEPAD_BUTTONS.length; i++) {
        const v = e.buttons[i] ?? 0
        pad.buttonValues[i] = v
        pad.set(GAMEPAD_BUTTONS[i]!, v > 0.5)
      }
      for (let i = 0; i < GAMEPAD_AXES.length; i++) {
        // The DOM's stick Y is down-positive; ours is up-positive.
        const v = e.axes[i] ?? 0
        pad.axisValues[i] = i % 2 === 1 ? -v : v
      }
      break
    }
    case 'pointer':
      break
    case 'focus':
      if (!e.focused) {
        d.keyboard.releaseAll()
        d.mouse.releaseAll()
        d.touches.active.clear()
        d.touches.captured.clear()
      }
      break
    case 'action': {
      const dot = e.name.lastIndexOf('.')
      const mapName = e.name.slice(0, dot)
      const map = world.resource(InputQueue).maps.find((m) => m.name === mapName)
      if (!map) {
        throw new ShardError(
          'input/unknown-action',
          `No action map "${mapName}" for injected "${e.name}"`,
          {
            hint: 'Use "<map name>.<action>", e.g. "game/Controls.jump".',
          },
        )
      }
      map.inject(e.name.slice(dot + 1), e.pressed, e.value)
      break
    }
  }
}

export interface InputContextValue {
  /** Action maps listen only in their own context (`game` by default) or `any`. */
  active: string
}

export const InputContext = defineResource<InputContextValue>('input/Context', {
  description:
    "The active input context: action maps of other contexts report nothing. UI sets 'ui' while a node has focus, so gameplay actions don't fire while typing.",
  init: () => ({ active: 'game' }),
})

/** Drains input once, at the start of the frame, so every system sees the same state. */
export const updateInput = defineSystem({
  name: 'input/update',
  description: "Applies this frame's raw input to devices.",
  run: (_, world) => {
    const q = world.resource(InputQueue)
    const d = devices(world)
    d.keyboard.beginFrame()
    d.mouse.beginFrame()
    d.gamepads.beginFrame()
    d.touches.beginFrame()
    world.resource(Pointers).beginFrame()

    const events = q.scratch
    events.length = 0
    if (q.replay) {
      for (const e of q.replay.frames.get(q.replay.frame) ?? []) events.push(e)
      q.replay.frame++
      q.source?.drain([]) // discard live input while replaying
      if (q.replay.frame >= q.replay.length) q.replay = undefined
    } else {
      q.source?.drain(events)
    }
    for (const e of q.pending) events.push(e)
    q.pending.length = 0
    if (q.scheduled.length > 0) {
      for (const e of q.scheduled.shift()!) events.push(e)
      // A simulated gesture plays one step a frame, on-demand runners included (0052).
      world.resource(FrameDemand).set(SIMULATE_DEMAND, q.scheduled.length > 0)
    }

    for (const e of events) {
      apply(world, d, e)
      pointers(world, e)
    }
    if (q.recording) q.recording.push(events.map((e) => ({ ...e })))
  },
})

/**
 * Recomputes action maps from device state, after `input/update`. Systems that claim input first
 * (UI capturing the pointer, setting the context) run between the two.
 */
export const updateActions = defineSystem({
  name: 'input/actions',
  description: 'Updates action maps from device state, in the active input context.',
  run: (_, world) => {
    const q = world.resource(InputQueue)
    const d = devices(world)
    const context = world.resource(InputContext).active
    const now = world.resource(Time).elapsed * 1000
    for (const map of q.maps) map.update(d, now, context)
  },
})

export function inputPlugin(options: InputPluginOptions = {}): Plugin {
  let unsubscribe: (() => void) | undefined
  return definePlugin({
    name: 'input',
    provides: [pluginModule],
    dependencies: ['core/time'],
    build(app) {
      const queue: InputQueueState = {
        source: options.source,
        pending: [],
        scratch: [],
        maps: [],
        recording: undefined,
        replay: undefined,
        scheduled: [],
      }
      app
        .insertResource(Keyboard, new KeyboardState())
        .insertResource(Mouse, new MouseState())
        .insertResource(Gamepads, new GamepadsState())
        .insertResource(Touches, new TouchesState())
        .insertResource(Pointers, new PointersState())
        .insertResource(InputQueue, queue)
      app.world.initResource(InputContext)
      for (const map of options.actions ?? []) addActions(app.world, map)
      app.addSystems(First, updateInput, updateActions.after(updateInput))
      // Input arriving wakes an on-demand runner to drain it (0052).
      unsubscribe = options.source?.onInput?.(() => {
        if (!app.disposed) app.requestFrame()
      })
    },
    dispose(app) {
      unsubscribe?.()
      unsubscribe = undefined
      const queue = app.world.tryResource(InputQueue)
      queue?.source?.dispose()
      if (queue) queue.source = undefined
    },
  })
}

/** Installs an action map as a resource (also callable after startup). */
export function addActions<K extends string>(world: World, map: ActionMapDef<K>): ActionState<K> {
  const state = map.create()
  world.insertResource(map.resource, state)
  const maps = world.resource(InputQueue).maps
  // Re-adding a map by name (e.g. after hot reload) replaces it rather than doubling it.
  const i = maps.findIndex((m) => m.name === map.name)
  if (i === -1) maps.push(state as unknown as ActionState<string>)
  else maps[i] = state as unknown as ActionState<string>
  return state
}

/**
 * Rebinds one action by `"<map>.<action>"` (`rebindAction(world, 'game/Controls.jump',
 * ['Key:KeyJ'])`); `undefined` restores the authored bindings. With the save plugin, the engine
 * settings keep rebindings across restarts.
 */
export function rebindAction(
  world: World,
  action: string,
  bindings: readonly unknown[] | undefined,
): void {
  const dot = action.lastIndexOf('.')
  const mapName = action.slice(0, dot)
  const map = world.resource(InputQueue).maps.find((m) => m.name === mapName)
  if (dot === -1 || !map) {
    throw new ShardError('input/unknown-action', `No action map "${mapName}" for "${action}"`, {
      hint: 'Use "<map name>.<action>", e.g. "game/Controls.jump".',
    })
  }
  map.rebind(action.slice(dot + 1), bindings as never)
}

export type InjectedInput =
  | RawInputEvent
  | { key: string; pressed: boolean }
  | { mouse: 'left' | 'middle' | 'right'; pressed: boolean }
  | { action: string; pressed: boolean; value?: number }

/**
 * Queues synthetic input, applied at the start of the next frame through the same path as real
 * input (so it's recorded and replayed too). Actions are named `"<map>.<action>"`.
 */
export function injectInput(world: World, input: InjectedInput): void {
  const q = world.resource(InputQueue)
  if ('type' in input) q.pending.push(input)
  else if ('key' in input) q.pending.push({ type: 'key', code: input.key, pressed: input.pressed })
  else if ('mouse' in input)
    q.pending.push({ type: 'mouse-button', button: input.mouse, pressed: input.pressed })
  else
    q.pending.push({
      type: 'action',
      name: input.action,
      pressed: input.pressed,
      value: input.value,
    })
}

const SIMULATE_DEMAND = 'input/simulate'

/**
 * Queues raw input over the next frames, one entry per frame (empty entries wait a frame),
 * after anything already queued. Gesture simulation (`simulateGestures`) builds on it.
 */
export function scheduleInput(world: World, frames: readonly (readonly RawInputEvent[])[]): void {
  const q = world.resource(InputQueue)
  for (const frame of frames) q.scheduled.push([...frame])
  if (q.scheduled.length > 0) world.resource(FrameDemand).hold(SIMULATE_DEMAND)
}

export function startRecording(world: World): void {
  world.resource(InputQueue).recording = []
}

/** Stops recording and returns it as JSON lines: `{"f":<frame>,"e":[...events]}` per non-empty frame. */
export function stopRecording(world: World): string {
  const q = world.resource(InputQueue)
  const frames = q.recording ?? []
  q.recording = undefined
  const lines = [JSON.stringify({ frames: frames.length })]
  frames.forEach((events, f) => {
    if (events.length > 0) lines.push(JSON.stringify({ f, e: events }))
  })
  return lines.join('\n')
}

/** Plays a recording back from the next frame on, ignoring live input until it ends. */
export function startReplay(world: World, recording: string): void {
  const [header, ...lines] = recording.split('\n').filter(Boolean)
  const length = (JSON.parse(header ?? '{}') as { frames?: number }).frames ?? 0
  const frames = new Map<number, RawInputEvent[]>()
  for (const line of lines) {
    const { f, e } = JSON.parse(line) as { f: number; e: RawInputEvent[] }
    frames.set(f, e)
  }
  world.resource(InputQueue).replay = { frames, frame: 0, length }
}

/** Devices, action maps, and current values. For agents. */
export function describeInput(world: World) {
  const q = world.resource(InputQueue)
  return {
    source: q.source ? 'live' : 'none (headless)',
    recording: q.recording !== undefined,
    replaying: q.replay !== undefined,
    keysHeld: world.resource(Keyboard).held(),
    gamepads: world.resource(Gamepads).connected().length,
    touches: world.resource(Touches).active.size,
    scheduledFrames: q.scheduled.length,
    context: world.resource(InputContext).active,
    pointerCaptured: world.resource(Mouse).captured,
    actionMaps: q.maps.map((m) => ({
      name: m.name,
      enabled: m.enabled,
      context: m.context,
      live: m.live,
      values: m.snapshot(),
      rebindings: m.rebindings(),
    })),
  }
}
