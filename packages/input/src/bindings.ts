import { ShardError } from '@shard/core'
import type { MouseButton } from '@shard/platform'
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, type GamepadAxis, type GamepadButton } from './devices'

/**
 * Binding grammar:
 *   Key:<code>                        KeyboardEvent.code, e.g. Key:Space, Key:KeyW, Key:ArrowUp
 *   Mouse:<Left|Middle|Right|Back|Forward|WheelX|WheelY|DeltaX|DeltaY>
 *   Gamepad:<button|axis|LeftStick|RightStick>   any connected gamepad
 *   Touch:Any                         any active touch
 */
export type ParsedBinding =
  | { device: 'key'; code: string }
  | { device: 'mouse-button'; button: MouseButton }
  | { device: 'mouse-axis'; axis: 'WheelX' | 'WheelY' | 'DeltaX' | 'DeltaY' }
  | { device: 'gamepad-button'; button: GamepadButton }
  | { device: 'gamepad-axis'; axis: GamepadAxis }
  | { device: 'gamepad-stick'; stick: 'LeftStick' | 'RightStick' }
  | { device: 'touch' }

const MOUSE_BUTTONS: Record<string, MouseButton> = {
  Left: 'left',
  Middle: 'middle',
  Right: 'right',
  Back: 'back',
  Forward: 'forward',
}
const MOUSE_AXES = ['WheelX', 'WheelY', 'DeltaX', 'DeltaY'] as const

/** A small allowlist so typos like `Key:Spce` are caught; letters, digits, and F-keys are generated. */
const KEY_CODES = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...'0123456789'.split('').map((d) => `Numpad${d}`),
  'Space',
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote',
  'Comma',
  'Period',
  'Slash',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadEnter',
  'NumpadDecimal',
])

function unknown(binding: string, valid: readonly string[]): ShardError {
  return new ShardError('input/unknown-binding', `Unknown input binding "${binding}"`, {
    hint: `Valid: ${valid.join(', ')}.`,
    path: binding,
  })
}

export function parseBinding(binding: string): ParsedBinding {
  const [device, name] = binding.split(':')
  if (!name) throw unknown(binding, ['Key:<code>', 'Mouse:<name>', 'Gamepad:<name>', 'Touch:Any'])
  switch (device) {
    case 'Key':
      if (!KEY_CODES.has(name))
        throw unknown(binding, [
          'Key:KeyA…KeyZ',
          'Key:Digit0…9',
          'Key:Space',
          'Key:ArrowUp',
          'Key:ShiftLeft',
          '…',
        ])
      return { device: 'key', code: name }
    case 'Mouse':
      if (name in MOUSE_BUTTONS) return { device: 'mouse-button', button: MOUSE_BUTTONS[name]! }
      if ((MOUSE_AXES as readonly string[]).includes(name))
        return { device: 'mouse-axis', axis: name as (typeof MOUSE_AXES)[number] }
      throw unknown(
        binding,
        [...Object.keys(MOUSE_BUTTONS), ...MOUSE_AXES].map((n) => `Mouse:${n}`),
      )
    case 'Gamepad':
      if ((GAMEPAD_BUTTONS as readonly string[]).includes(name))
        return { device: 'gamepad-button', button: name as GamepadButton }
      if ((GAMEPAD_AXES as readonly string[]).includes(name))
        return { device: 'gamepad-axis', axis: name as GamepadAxis }
      if (name === 'LeftStick' || name === 'RightStick')
        return { device: 'gamepad-stick', stick: name }
      throw unknown(
        binding,
        [...GAMEPAD_BUTTONS, ...GAMEPAD_AXES, 'LeftStick', 'RightStick'].map((n) => `Gamepad:${n}`),
      )
    case 'Touch':
      if (name === 'Any') return { device: 'touch' }
      throw unknown(binding, ['Touch:Any'])
    default:
      throw unknown(binding, ['Key:<code>', 'Mouse:<name>', 'Gamepad:<name>', 'Touch:Any'])
  }
}
