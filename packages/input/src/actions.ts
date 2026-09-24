import { defineResource, type JsonSchema, type ResourceDef, ShardError } from '@shard/core'
import { type ParsedBinding, parseBinding } from './bindings'
import type { GamepadsState, KeyboardState, MouseState, TouchesState } from './devices'

export type Interaction =
  | { hold: number }
  | { tap: number }
  | { multiTap: { count: number; window: number } }

export interface ButtonAction {
  kind: 'button'
  bindings: readonly string[]
  /** Timing rules, in ms. Without one, the action performs on press. */
  interaction?: Interaction
}

export type Axis1dBinding = string | { positive: string; negative: string }
export interface Axis1dAction {
  kind: 'axis1d'
  bindings: readonly Axis1dBinding[]
  deadZone?: number
}

export type Axis2dBinding =
  | string
  | { composite: 'wasd' | 'arrows' }
  | { up: string; down: string; left: string; right: string }
export interface Axis2dAction {
  kind: 'axis2d'
  bindings: readonly Axis2dBinding[]
  deadZone?: number
}

export type ActionDef = ButtonAction | Axis1dAction | Axis2dAction

export interface Devices {
  keyboard: KeyboardState
  mouse: MouseState
  gamepads: GamepadsState
  touches: TouchesState
}

type Compiled =
  | { kind: 'button'; bindings: ParsedBinding[]; interaction: Interaction | undefined }
  | {
      kind: 'axis1d'
      parts: ({ single: ParsedBinding } | { pos: ParsedBinding; neg: ParsedBinding })[]
      deadZone: number
    }
  | {
      kind: 'axis2d'
      parts: (
        | { stick: ParsedBinding }
        | { up: ParsedBinding; down: ParsedBinding; left: ParsedBinding; right: ParsedBinding }
      )[]
      deadZone: number
    }

interface ButtonRuntime {
  pressed: boolean
  justPressed: boolean
  justReleased: boolean
  started: boolean
  performed: boolean
  canceled: boolean
  holdProgress: number
  downAt: number
  heldPerformed: boolean
  taps: number
  lastReleaseAt: number
  value: number
  axis: [number, number]
}

function newRuntime(): ButtonRuntime {
  return {
    pressed: false,
    justPressed: false,
    justReleased: false,
    started: false,
    performed: false,
    canceled: false,
    holdProgress: 0,
    downAt: 0,
    heldPerformed: false,
    taps: 0,
    lastReleaseAt: -Infinity,
    value: 0,
    axis: [0, 0],
  }
}

const COMPOSITES = {
  wasd: { up: 'Key:KeyW', down: 'Key:KeyS', left: 'Key:KeyA', right: 'Key:KeyD' },
  arrows: {
    up: 'Key:ArrowUp',
    down: 'Key:ArrowDown',
    left: 'Key:ArrowLeft',
    right: 'Key:ArrowRight',
  },
} as const

/** Current values of one action map. Action names are type-checked against the definition. */
export class ActionState<K extends string> {
  /** Disabled sets report nothing (use for contexts like gameplay vs menu). */
  enabled = true
  readonly name: string
  /**
   * The input context the map listens in: it reports nothing while another is active
   * (`InputContext`; UI makes it `ui` while a node has focus). `any` always listens.
   */
  readonly context: string
  /** Its context isn't the active one this frame. */
  private suspended = false
  private readonly compiled: Map<K, Compiled>
  private readonly runtime = new Map<K, ButtonRuntime>()
  /** Pressed state injected by synthetic `action` events, by action name. */
  private readonly injected = new Map<string, { pressed: boolean; value: number }>()

  constructor(name: string, compiled: Map<K, Compiled>, context = 'game') {
    this.name = name
    this.context = context
    this.compiled = compiled
    for (const key of compiled.keys()) this.runtime.set(key, newRuntime())
  }

  pressed(action: K): boolean {
    return this.live && this.rt(action).pressed
  }
  justPressed(action: K): boolean {
    return this.live && this.rt(action).justPressed
  }
  justReleased(action: K): boolean {
    return this.live && this.rt(action).justReleased
  }
  /** The interaction began this frame (press for hold/tap). */
  started(action: K): boolean {
    return this.live && this.rt(action).started
  }
  /** The action fired this frame: press, completed hold, tap, or multi-tap. */
  performed(action: K): boolean {
    return this.live && this.rt(action).performed
  }
  /** The interaction was abandoned this frame (hold released early, tap held too long). */
  canceled(action: K): boolean {
    return this.live && this.rt(action).canceled
  }
  /** 0..1 progress of a hold interaction, for UI. */
  holdProgress(action: K): number {
    return this.live ? this.rt(action).holdProgress : 0
  }
  /** Button strength (0..1) or axis1d value (-1..1, or raw wheel units). */
  value(action: K): number {
    return this.live ? this.rt(action).value : 0
  }
  /** axis2d value, length ≤ 1. The array is reused; copy it to keep it. */
  axis2d(action: K): readonly [number, number] {
    return this.live ? this.rt(action).axis : ZERO2
  }

  /** Enabled, and listening in the active context. */
  get live(): boolean {
    return this.enabled && !this.suspended
  }

  /** @internal */
  inject(action: string, pressed: boolean, value = pressed ? 1 : 0): void {
    if (!this.compiled.has(action as K)) {
      throw new ShardError('input/unknown-action', `"${this.name}" has no action "${action}"`, {
        hint: `Actions: ${[...this.compiled.keys()].join(', ')}.`,
      })
    }
    this.injected.set(action, { pressed, value })
  }

  /** @internal Recompute every action from device state. `now` is in ms. */
  update(devices: Devices, now: number, context = 'game'): void {
    this.suspended = this.context !== 'any' && this.context !== context
    for (const [name, def] of this.compiled) {
      const r = this.rt(name)
      const injected = this.injected.get(name)
      if (def.kind === 'button') {
        let value = 0
        for (const b of def.bindings) value = Math.max(value, readButton(devices, b))
        if (injected) value = Math.max(value, injected.value)
        updateButton(r, value, def.interaction, now)
      } else if (def.kind === 'axis1d') {
        let best = 0
        for (const part of def.parts) {
          const v =
            'single' in part
              ? readAxis(devices, part.single)
              : readButton(devices, part.pos) - readButton(devices, part.neg)
          if (Math.abs(v) > Math.abs(best)) best = v
        }
        if (injected) best = injected.value
        r.value = Math.abs(best) < def.deadZone ? 0 : best
        r.pressed = r.value !== 0
      } else {
        let bx = 0
        let by = 0
        for (const part of def.parts) {
          let x: number
          let y: number
          if ('stick' in part) {
            const stick = (part.stick as { stick: 'LeftStick' | 'RightStick' }).stick
            x = readStick(devices, stick, 0)
            y = readStick(devices, stick, 1)
          } else {
            x = readButton(devices, part.right) - readButton(devices, part.left)
            y = readButton(devices, part.up) - readButton(devices, part.down)
          }
          if (x * x + y * y > bx * bx + by * by) {
            bx = x
            by = y
          }
        }
        let len = Math.sqrt(bx * bx + by * by)
        if (len > 1) {
          bx /= len
          by /= len
          len = 1
        }
        // Radial dead zone, rescaled so values start at 0 just past it.
        if (len < def.deadZone) {
          bx = 0
          by = 0
        } else if (def.deadZone > 0) {
          const scale = (len - def.deadZone) / (1 - def.deadZone) / len
          bx *= scale
          by *= scale
        }
        r.axis[0] = bx
        r.axis[1] = by
        r.pressed = bx !== 0 || by !== 0
      }
    }
  }

  /** Current values, for describe(). */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [name, def] of this.compiled) {
      const r = this.rt(name)
      out[name] = def.kind === 'axis2d' ? [...r.axis] : def.kind === 'axis1d' ? r.value : r.pressed
    }
    return out
  }

  private rt(action: K): ButtonRuntime {
    const r = this.runtime.get(action)
    if (!r) {
      throw new ShardError('input/unknown-action', `"${this.name}" has no action "${action}"`, {
        hint: `Actions: ${[...this.compiled.keys()].join(', ')}.`,
      })
    }
    return r
  }
}

const ZERO2: readonly [number, number] = [0, 0]

function updateButton(
  r: ButtonRuntime,
  value: number,
  interaction: Interaction | undefined,
  now: number,
): void {
  const wasPressed = r.pressed
  r.value = value
  r.pressed = value > 0.5
  r.justPressed = r.pressed && !wasPressed
  r.justReleased = !r.pressed && wasPressed
  r.started = false
  r.performed = false
  r.canceled = false

  if (!interaction) {
    r.started = r.justPressed
    r.performed = r.justPressed
    r.holdProgress = r.pressed ? 1 : 0
    return
  }
  if (r.justPressed) {
    r.downAt = now
    r.heldPerformed = false
    r.started = true
  }
  const held = now - r.downAt
  if ('hold' in interaction) {
    r.holdProgress = r.pressed ? Math.min(1, held / interaction.hold) : 0
    if (r.pressed && !r.heldPerformed && held >= interaction.hold) {
      r.performed = true
      r.heldPerformed = true
    }
    if (r.justReleased && !r.heldPerformed) r.canceled = true
  } else if ('tap' in interaction) {
    if (r.justReleased) {
      if (held < interaction.tap) r.performed = true
      else r.canceled = true
    }
  } else {
    const { count, window } = interaction.multiTap
    if (r.justPressed && now - r.lastReleaseAt > window) r.taps = 0
    if (r.justReleased) {
      r.taps++
      r.lastReleaseAt = now
      if (r.taps >= count) {
        r.performed = true
        r.taps = 0
      }
    }
  }
}

function readButton(d: Devices, b: ParsedBinding): number {
  switch (b.device) {
    case 'key':
      return d.keyboard.pressed(b.code) ? 1 : 0
    case 'mouse-button':
      return !d.mouse.captured && d.mouse.pressed(b.button) ? 1 : 0
    case 'gamepad-button': {
      let v = 0
      for (const pad of d.gamepads.connected()) v = Math.max(v, pad.button(b.button))
      return v
    }
    case 'touch':
      return d.touches.active.size > d.touches.captured.size ? 1 : 0
    default:
      return Math.min(1, Math.abs(readAxis(d, b)))
  }
}

function readAxis(d: Devices, b: ParsedBinding): number {
  switch (b.device) {
    case 'mouse-axis':
      if (d.mouse.captured && (b.axis === 'WheelX' || b.axis === 'WheelY')) return 0
      return b.axis === 'WheelX'
        ? d.mouse.wheel[0]
        : b.axis === 'WheelY'
          ? d.mouse.wheel[1]
          : b.axis === 'DeltaX'
            ? d.mouse.delta[0]
            : d.mouse.delta[1]
    case 'gamepad-axis': {
      let v = 0
      for (const pad of d.gamepads.connected()) {
        const a = pad.axis(b.axis)
        if (Math.abs(a) > Math.abs(v)) v = a
      }
      return v
    }
    default:
      return readButton(d, b)
  }
}

function readStick(d: Devices, stick: 'LeftStick' | 'RightStick', component: 0 | 1): number {
  const axis =
    stick === 'LeftStick'
      ? component === 0
        ? 'LeftStickX'
        : 'LeftStickY'
      : component === 0
        ? 'RightStickX'
        : 'RightStickY'
  let v = 0
  for (const pad of d.gamepads.connected()) {
    const a = pad.axis(axis)
    if (Math.abs(a) > Math.abs(v)) v = a
  }
  return v
}

function compile(name: string, def: ActionDef): Compiled {
  const path = (binding: string) => {
    try {
      return parseBinding(binding)
    } catch (err) {
      if (err instanceof ShardError) {
        throw new ShardError(err.code, `${err.message} in action "${name}"`, {
          hint: err.hint,
          path: `${name}/${binding}`,
        })
      }
      throw err
    }
  }
  if (def.kind === 'button') {
    return { kind: 'button', bindings: def.bindings.map(path), interaction: def.interaction }
  }
  if (def.kind === 'axis1d') {
    return {
      kind: 'axis1d',
      deadZone: def.deadZone ?? 0,
      parts: def.bindings.map((b) =>
        typeof b === 'string'
          ? { single: path(b) }
          : { pos: path(b.positive), neg: path(b.negative) },
      ),
    }
  }
  return {
    kind: 'axis2d',
    deadZone: def.deadZone ?? 0,
    parts: def.bindings.map((b) => {
      if (typeof b === 'string') {
        const parsed = path(b)
        if (parsed.device !== 'gamepad-stick') {
          throw new ShardError(
            'input/unknown-binding',
            `axis2d binding "${b}" must be a stick or composite`,
            {
              path: `${name}/${b}`,
              hint: 'Use Gamepad:LeftStick, Gamepad:RightStick, { composite: "wasd" | "arrows" }, or { up, down, left, right }.',
            },
          )
        }
        return { stick: parsed }
      }
      const keys = 'composite' in b ? COMPOSITES[b.composite] : b
      return {
        up: path(keys.up),
        down: path(keys.down),
        left: path(keys.left),
        right: path(keys.right),
      }
    }),
  }
}

export interface ActionMapDef<K extends string> {
  readonly kind: 'actions'
  readonly name: string
  /** The input context it listens in (default `game`; `ui`, or `any` for always). */
  readonly context: string
  readonly definition: Readonly<Record<K, ActionDef>>
  readonly resource: ResourceDef<ActionState<K>>
  create(): ActionState<K>
}

/** An action map. Validates every binding now, so typos fail at startup, not at first press. */
export function defineActions<const A extends Record<string, ActionDef>>(
  name: string,
  definition: A,
  options: { context?: string } = {},
): ActionMapDef<keyof A & string> {
  const context = options.context ?? 'game'
  type K = keyof A & string
  const compiled = new Map<K, Compiled>()
  for (const [action, def] of Object.entries(definition))
    compiled.set(action as K, compile(action, def))
  // Bindings are configuration: when the code that defines them reloads, the new ones apply.
  const resource = defineResource<ActionState<K>>(name, {
    description: `Action map ${name}`,
    reload: 'replace',
  })
  return {
    kind: 'actions',
    name,
    context,
    definition,
    resource,
    create: () => new ActionState<K>(name, new Map(compiled), context),
  }
}

/** JSON Schema for action maps as data files. */
export const actionMapSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Shard action map',
  type: 'object',
  additionalProperties: {
    oneOf: [
      {
        type: 'object',
        properties: {
          kind: { const: 'button' },
          bindings: { type: 'array', items: { type: 'string' } },
          interaction: {
            oneOf: [
              {
                type: 'object',
                properties: { hold: { type: 'number', minimum: 0 } },
                required: ['hold'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { tap: { type: 'number', minimum: 0 } },
                required: ['tap'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  multiTap: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer', minimum: 2 },
                      window: { type: 'number', minimum: 0 },
                    },
                    required: ['count', 'window'],
                  },
                },
                required: ['multiTap'],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ['kind', 'bindings'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { enum: ['axis1d', 'axis2d'] },
          bindings: { type: 'array' },
          deadZone: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['kind', 'bindings'],
        additionalProperties: false,
      },
    ],
  },
  description:
    'Named actions with bindings. Binding strings: Key:<KeyboardEvent.code>, Mouse:<Left|Middle|Right|Back|Forward|WheelX|WheelY|DeltaX|DeltaY>, Gamepad:<South|East|West|North|…|LeftStick|RightStick>, Touch:Any.',
}
