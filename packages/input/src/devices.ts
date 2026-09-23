import type { MouseButton } from '@shard/platform'

/** Pressed/just-pressed/just-released bookkeeping for a set of named buttons. */
class ButtonSet<K extends string> {
  private readonly down = new Set<K>()
  private readonly pressedNow = new Set<K>()
  private readonly releasedNow = new Set<K>()

  /** @internal start of frame */
  beginFrame(): void {
    this.pressedNow.clear()
    this.releasedNow.clear()
  }

  /** @internal */
  set(key: K, pressed: boolean): void {
    if (pressed && !this.down.has(key)) {
      this.down.add(key)
      this.pressedNow.add(key)
    } else if (!pressed && this.down.has(key)) {
      this.down.delete(key)
      this.releasedNow.add(key)
    }
  }

  /** @internal release everything (focus loss) */
  releaseAll(): void {
    for (const key of this.down) this.releasedNow.add(key)
    this.down.clear()
  }

  pressed(key: K): boolean {
    return this.down.has(key)
  }

  justPressed(key: K): boolean {
    return this.pressedNow.has(key)
  }

  justReleased(key: K): boolean {
    return this.releasedNow.has(key)
  }

  /** Currently held keys. */
  held(): K[] {
    return [...this.down]
  }
}

/** Keys by `KeyboardEvent.code` (physical position: `KeyW`, `Space`, `ArrowUp`, `ShiftLeft`). */
export class KeyboardState extends ButtonSet<string> {}

export class MouseState extends ButtonSet<MouseButton> {
  /** Pointer position in canvas pixels. */
  readonly position: [number, number] = [0, 0]
  /** Movement this frame, in canvas pixels (works under pointer lock). */
  readonly delta: [number, number] = [0, 0]
  /** Wheel movement this frame, in pixels. */
  readonly wheel: [number, number] = [0, 0]

  /** @internal */
  override beginFrame(): void {
    super.beginFrame()
    this.delta[0] = this.delta[1] = 0
    this.wheel[0] = this.wheel[1] = 0
  }
}

export const GAMEPAD_BUTTONS = [
  'South',
  'East',
  'West',
  'North',
  'LeftBumper',
  'RightBumper',
  'LeftTrigger',
  'RightTrigger',
  'Select',
  'Start',
  'LeftStickPress',
  'RightStickPress',
  'DpadUp',
  'DpadDown',
  'DpadLeft',
  'DpadRight',
  'Home',
] as const
export const GAMEPAD_AXES = ['LeftStickX', 'LeftStickY', 'RightStickX', 'RightStickY'] as const

export type GamepadButton = (typeof GAMEPAD_BUTTONS)[number]
export type GamepadAxis = (typeof GAMEPAD_AXES)[number]

/** One gamepad in the standard mapping. Stick Y is up-positive here (the DOM's is down-positive). */
export class GamepadState extends ButtonSet<GamepadButton> {
  connected = false
  readonly buttonValues = new Float32Array(GAMEPAD_BUTTONS.length)
  readonly axisValues = new Float32Array(GAMEPAD_AXES.length)

  button(name: GamepadButton): number {
    return this.buttonValues[GAMEPAD_BUTTONS.indexOf(name)] ?? 0
  }

  axis(name: GamepadAxis): number {
    return this.axisValues[GAMEPAD_AXES.indexOf(name)] ?? 0
  }
}

export class GamepadsState {
  private readonly pads: GamepadState[] = []

  get(index: number): GamepadState | undefined {
    return this.pads[index]?.connected ? this.pads[index] : undefined
  }

  /** Connected gamepads. */
  connected(): GamepadState[] {
    return this.pads.filter((p) => p.connected)
  }

  /** @internal */
  slot(index: number): GamepadState {
    this.pads[index] ??= new GamepadState()
    return this.pads[index]
  }

  /** @internal */
  beginFrame(): void {
    for (const pad of this.pads) pad?.beginFrame()
  }
}

export interface Touch {
  id: number
  position: [number, number]
  start: [number, number]
}

export class TouchesState {
  readonly active = new Map<number, Touch>()
  readonly started: number[] = []
  readonly ended: number[] = []

  /** @internal */
  beginFrame(): void {
    this.started.length = 0
    this.ended.length = 0
  }
}
