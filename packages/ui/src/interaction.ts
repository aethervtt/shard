import {
  defineResource,
  defineSystem,
  type Entity,
  ShardError,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { Gamepads, InputContext, Keyboard, Mouse, Touches } from '@aethervtt/shard-input'
import {
  UiChanged,
  UiClick,
  UiHover,
  UiInteraction,
  UiNode,
  UiSlider,
  UiTextInput,
  UiToggle,
} from './components'
import { Kind, type UiRootState, UiState, type UiStore } from './tree'

const STATE_NONE = 0
const STATE_HOVERED = 1
const STATE_PRESSED = 2
const STATE_DISABLED = 3

/** Pointer and focus state of the UI. */
export class UiPointerState {
  /** The interactive node under the pointer (null: none). */
  hovered: Entity | null = null
  /** The node a press started on, until release. */
  pressed: Entity | null = null
  focused: Entity | null = null
  /** The pointer is over UI that takes it (a node with a background, an image, or a widget). */
  overUi = false
  /** A press that started on the world: UI doesn't take the pointer until it's released. */
  worldPress = false
  /** Pointer in screen pixels, and whether a pointer (mouse or touch) is present. */
  x = -1
  y = -1
  touch = -1
  /** Clicks and changes this frame (for describe). */
  clicks = 0
}

export const UiPointer = defineResource<UiPointerState>('ui/UiPointer', {
  description: 'What the pointer is over, what it pressed, and which node has focus.',
  init: () => new UiPointerState(),
})

// --- hit testing -------------------------------------------------------------------------------

/** The topmost node taking the pointer at (x, y) screen pixels in a root, or -1. */
export function hitNode(r: UiRootState, sx: number, sy: number): number {
  const x = sx / r.factor
  const y = sy / r.factor
  for (let p = r.count - 1; p >= 0; p--) {
    const i = r.paint[p]!
    if (!r.visible[i] || !r.solid[i]) continue
    if (x < r.x[i]! || y < r.y[i]! || x >= r.x[i]! + r.w[i]! || y >= r.y[i]! + r.h[i]!) continue
    const o = i * 4
    if (x < r.clip[o]! || y < r.clip[o + 1]! || x >= r.clip[o + 2]! || y >= r.clip[o + 3]!) continue
    return i
  }
  return -1
}

/** The widget a hit node belongs to: itself or its nearest interactive ancestor, or -1. */
function widgetOf(r: UiRootState, i: number): number {
  for (let n = i; n >= 0; n = r.parent[n]!) if (r.kind[n] !== Kind.None) return n
  return -1
}

const hitResult = { root: undefined as UiRootState | undefined, node: -1 }

/** The topmost UI node taking the pointer at a screen pixel, over every root (top root first). */
export function hitTest(store: UiStore, sx: number, sy: number, camera?: Entity): typeof hitResult {
  hitResult.root = undefined
  hitResult.node = -1
  for (let k = store.roots.length - 1; k >= 0; k--) {
    const r = store.roots[k]!
    if (camera !== undefined && r.camera !== camera) continue
    const i = hitNode(r, sx, sy)
    if (i >= 0) {
      hitResult.root = r
      hitResult.node = i
      return hitResult
    }
  }
  return hitResult
}

// --- activation --------------------------------------------------------------------------------

function nodeOf(store: UiStore, e: Entity): { r: UiRootState; i: number } | undefined {
  const r = store.rootOf.get(e)
  const i = store.indexOf.get(e)
  return r && i !== undefined ? { r, i } : undefined
}

/** Clicks a button or flips a toggle: what a pointer click, Enter, or the south button does. */
function activate(world: World, e: Entity, kind: number): void {
  const pointer = world.resource(UiPointer)
  if (kind === Kind.Toggle) {
    const table = world.entityTable(e)
    const row = world.entityRow(e)
    const on = table.column(UiToggle, 'on')
    on[row] = on[row] ? 0 : 1
    table.markChanged(UiToggle, row)
    world.send(UiChanged, { entity: e })
  }
  if (kind === Kind.Button || kind === Kind.Toggle) {
    world.send(UiClick, { entity: e })
    pointer.clicks++
  }
}

/**
 * Clicks a button or toggle by entity, as a real click would (UiClick, a toggle flips), without
 * pointer coordinates. For tests, tools, and `ui.click`.
 */
export function clickUi(world: World, entity: Entity): void {
  const store = world.resource(UiState)
  const at = nodeOf(store, entity)
  const kind = at ? at.r.kind[at.i]! : Kind.None
  if (!at || (kind !== Kind.Button && kind !== Kind.Toggle)) {
    throw new ShardError(
      'ui/not-clickable',
      `Entity ${entity} isn't a UiButton or UiToggle in a UI tree`,
      {
        hint: 'ui.click takes the path of a node with ui/UiButton or ui/UiToggle (see ui.describe).',
      },
    )
  }
  if (at.r.disabled[at.i]) {
    throw new ShardError('ui/disabled', `Entity ${entity} is disabled`, {
      hint: 'Set disabled to false on its UiButton or UiToggle first.',
    })
  }
  if (!at.r.visible[at.i]) {
    throw new ShardError('ui/hidden', `Entity ${entity} isn't visible`, {
      hint: "A node with display none, under a hidden anchor, or outside a root can't be clicked.",
    })
  }
  activate(world, entity, kind)
}

/** Gives keyboard and gamepad focus to a widget (null clears it). */
export function focusUi(world: World, entity: Entity | null): void {
  const pointer = world.resource(UiPointer)
  if (entity !== null) {
    const at = nodeOf(world.resource(UiState), entity)
    if (!at || at.r.kind[at.i] === Kind.None) {
      throw new ShardError('ui/not-focusable', `Entity ${entity} isn't a widget in a UI tree`, {
        hint: 'Focus takes a node with UiButton, UiToggle, UiSlider, or UiTextInput.',
      })
    }
  }
  pointer.focused = entity
}

// --- the system --------------------------------------------------------------------------------

function sliderValue(world: World, e: Entity, fraction: number): boolean {
  const table = world.entityTable(e)
  const row = world.entityRow(e)
  const min = table.column(UiSlider, 'min')[row]!
  const max = table.column(UiSlider, 'max')[row]!
  const step = table.column(UiSlider, 'step')[row]!
  let v = min + Math.min(1, Math.max(0, fraction)) * (max - min)
  if (step > 0) v = min + Math.round((v - min) / step) * step
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  v = Math.min(hi, Math.max(lo, v))
  const value = table.column(UiSlider, 'value')
  if (Math.fround(v) === value[row]) return false
  value[row] = v
  table.markChanged(UiSlider, row)
  world.send(UiChanged, { entity: e })
  return true
}

function stepSlider(world: World, e: Entity, dir: number): void {
  const table = world.entityTable(e)
  const row = world.entityRow(e)
  const min = table.column(UiSlider, 'min')[row]!
  const max = table.column(UiSlider, 'max')[row]!
  const step = table.column(UiSlider, 'step')[row]!
  const span = max - min
  const value = table.column(UiSlider, 'value')[row]!
  const delta = step > 0 ? step : span / 10
  if (span !== 0) sliderValue(world, e, (value + dir * delta - min) / span)
}

function editText(world: World, e: Entity, typed: string): void {
  const table = world.entityTable(e)
  const row = world.entityRow(e)
  const values = table.column(UiTextInput, 'value')
  const maxLength = table.column(UiTextInput, 'maxLength')[row]!
  let v = values[row] ?? ''
  const before = v
  for (const ch of typed) {
    if (ch === '\b') v = Array.from(v).slice(0, -1).join('')
    else if (ch >= ' ' && (maxLength === 0 || Array.from(v).length < maxLength)) v += ch
  }
  if (v === before) return
  values[row] = v
  table.markChanged(UiTextInput, row)
  world.send(UiChanged, { entity: e })
}

/** Every focusable widget in tree order across roots: (root, node) pairs, flattened. */
function focusables(store: UiStore, out: { r: UiRootState; i: number }[]): number {
  let n = 0
  for (const r of store.roots) {
    for (let i = 0; i < r.count; i++) {
      if (r.kind[i] === Kind.None || r.disabled[i] || !r.visible[i]) continue
      const slot = out[n]
      if (slot) {
        slot.r = r
        slot.i = i
      } else out.push({ r, i })
      n++
    }
  }
  return n
}

/** The nearest focusable in a direction (dx, dy one of ±1) from the focused node, or undefined. */
function nearest(
  list: { r: UiRootState; i: number }[],
  n: number,
  from: { r: UiRootState; i: number },
  dx: number,
  dy: number,
): { r: UiRootState; i: number } | undefined {
  const f = from.r.factor
  const cx = (from.r.x[from.i]! + from.r.w[from.i]! / 2) * f
  const cy = (from.r.y[from.i]! + from.r.h[from.i]! / 2) * f
  let best: { r: UiRootState; i: number } | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (let k = 0; k < n; k++) {
    const c = list[k]!
    if (c.r === from.r && c.i === from.i) continue
    const g = c.r.factor
    const x = (c.r.x[c.i]! + c.r.w[c.i]! / 2) * g - cx
    const y = (c.r.y[c.i]! + c.r.h[c.i]! / 2) * g - cy
    const along = x * dx + y * dy
    if (along <= 0.5) continue
    const across = Math.abs(dx !== 0 ? y : x)
    const score = along + 2 * across
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

const focusList: { r: UiRootState; i: number }[] = []

function setInteraction(world: World, e: Entity | null, state: number, focused: boolean): void {
  if (e === null || !world.isAlive(e) || !world.has(e, UiInteraction)) return
  const table: Table = world.entityTable(e)
  const row = world.entityRow(e)
  const s = table.column(UiInteraction, 'state')
  const f = table.column(UiInteraction, 'focused')
  if (s[row] === state && (f[row] !== 0) === focused) return
  s[row] = state
  f[row] = focused ? 1 : 0
  table.markChanged(UiInteraction, row)
}

function stateOf(store: UiStore, p: UiPointerState, e: Entity): number {
  const at = nodeOf(store, e)
  if (at?.r.disabled[at.i]) return STATE_DISABLED
  if (p.pressed === e && p.hovered === e) return STATE_PRESSED
  if (p.hovered === e || p.pressed === e) return STATE_HOVERED
  return STATE_NONE
}

/**
 * Pointer, keyboard, and gamepad input for UI, between device updates and action maps: hit tests
 * last frame's layout, updates hover and press, clicks, drags sliders, scrolls, moves focus, and
 * edits text. While the pointer is over UI (or pressing a widget), action maps don't see mouse
 * buttons or the wheel; while a node has focus the input context is `ui`.
 */
export const interactUi = defineSystem({
  name: 'ui/interact',
  description: 'Hover, press, click, drag, scroll, focus navigation, and text editing for UI.',
  run: (_, world) => {
    const store = world.tryResource(UiState)
    const p = world.tryResource(UiPointer)
    const mouse = world.tryResource(Mouse)
    if (!store || !p || !mouse) return
    const keyboard = world.resource(Keyboard)
    const touches = world.resource(Touches)
    const pads = world.resource(Gamepads)
    p.clicks = 0

    // The pointer: a touch while one is down, else the mouse.
    let px = mouse.position[0]
    let py = mouse.position[1]
    let down = mouse.justPressed('left')
    let up = mouse.justReleased('left')
    let held = mouse.pressed('left')
    let startedTouch = -1
    if (touches.started.length > 0) {
      startedTouch = touches.started[0]!
      p.touch = startedTouch
      down = true
    }
    if (p.touch >= 0) {
      const t = touches.active.get(p.touch)
      if (t) {
        px = t.position[0]
        py = t.position[1]
        held = true
      } else {
        up = true
        held = false
        p.touch = -1
      }
    }
    p.x = px
    p.y = py

    // Last frame's flags may be stale if widgets changed; hit test with what's there.
    const hit = hitTest(store, px, py)
    const overUi = hit.node >= 0
    p.overUi = overUi
    let widget: Entity | null = null
    if (hit.root) {
      const w = widgetOf(hit.root, hit.node)
      if (w >= 0 && !hit.root.disabled[w]) widget = hit.root.entities[w]!
    }

    // Hover.
    const prevHover = p.hovered
    if (widget !== prevHover) {
      if (prevHover !== null && world.isAlive(prevHover))
        world.send(UiHover, { entity: prevHover, hovered: false })
      if (widget !== null) world.send(UiHover, { entity: widget, hovered: true })
      p.hovered = widget
    }

    // Press and release.
    if (down) {
      if (overUi) {
        p.pressed = widget
        p.worldPress = false
        if (startedTouch >= 0) touches.captured.add(startedTouch)
        const at = widget !== null ? nodeOf(store, widget) : undefined
        const kind = at ? at.r.kind[at.i]! : Kind.None
        // Only text fields take focus from the pointer; a press anywhere else drops it.
        p.focused = kind === Kind.TextInput ? widget : null
      } else {
        p.worldPress = true
        p.focused = null
      }
    }
    if (p.pressed !== null) {
      const at = nodeOf(store, p.pressed)
      if (at && at.r.kind[at.i] === Kind.Slider && held) {
        const f = at.r.factor
        sliderValue(world, p.pressed, (px / f - at.r.x[at.i]!) / Math.max(1e-6, at.r.w[at.i]!))
      }
    }
    if (up) {
      const pressed = p.pressed
      if (pressed !== null && pressed === widget) {
        const at = nodeOf(store, pressed)
        if (at) activate(world, pressed, at.r.kind[at.i]!)
      }
      p.pressed = null
      p.worldPress = false
    } else if (!held && p.touch < 0) {
      p.pressed = null
      p.worldPress = false
    }
    mouse.captured = p.pressed !== null || (overUi && !p.worldPress)

    // Wheel: the nearest scroll node under the pointer.
    if (overUi && hit.root && (mouse.wheel[0] !== 0 || mouse.wheel[1] !== 0)) {
      const r = hit.root
      for (let n = hit.node; n >= 0; n = r.parent[n]!) {
        if (r.overflow[n] !== 2) continue
        const e = r.entities[n]!
        const table = world.entityTable(e)
        const row = world.entityRow(e)
        const scroll = table.column(UiNode, 'scroll') as unknown as Float32Array
        const maxX = Math.max(0, r.contentW[n]! - r.tree.w[n]!)
        const maxY = Math.max(0, r.contentH[n]! - r.tree.h[n]!)
        const sx = Math.min(maxX, Math.max(0, r.scrollX[n]! + mouse.wheel[0] / r.factor))
        const sy = Math.min(maxY, Math.max(0, r.scrollY[n]! + mouse.wheel[1] / r.factor))
        if (sx !== scroll[row * 2] || sy !== scroll[row * 2 + 1]) {
          scroll[row * 2] = sx
          scroll[row * 2 + 1] = sy
          table.markChanged(UiNode, row)
        }
        break
      }
    }

    // Focus: Tab moves through widgets in order; arrows and the D-pad move it once something has
    // focus; Enter, Space, or south activates; Escape or east drops it.
    if (p.focused !== null && !(world.isAlive(p.focused) && nodeOf(store, p.focused)))
      p.focused = null
    const n = focusables(store, focusList)
    const shift = keyboard.pressed('ShiftLeft') || keyboard.pressed('ShiftRight')
    if (keyboard.justPressed('Tab') && n > 0) {
      let at = -1
      for (let k = 0; k < n; k++) {
        const c = focusList[k]!
        if (c.r.entities[c.i] === p.focused) at = k
      }
      const next = at < 0 ? (shift ? n - 1 : 0) : (at + (shift ? n - 1 : 1)) % n
      const c = focusList[next]!
      p.focused = c.r.entities[c.i]!
    }
    const focusedAt = p.focused !== null ? nodeOf(store, p.focused) : undefined
    let navX = 0
    let navY = 0
    let activatePressed = false
    let back = keyboard.justPressed('Escape')
    const kind = focusedAt ? focusedAt.r.kind[focusedAt.i]! : Kind.None
    const typing = kind === Kind.TextInput
    if (focusedAt) {
      if (!typing) {
        if (keyboard.justPressed('ArrowLeft')) navX = -1
        if (keyboard.justPressed('ArrowRight')) navX = 1
      }
      if (keyboard.justPressed('ArrowUp')) navY = -1
      if (keyboard.justPressed('ArrowDown')) navY = 1
      activatePressed =
        keyboard.justPressed('Enter') ||
        keyboard.justPressed('NumpadEnter') ||
        (!typing && keyboard.justPressed('Space'))
    }
    for (let k = 0; k < 4; k++) {
      const pad = pads.get(k)
      if (!pad) continue
      if (focusedAt) {
        if (pad.justPressed('DpadLeft')) navX = -1
        if (pad.justPressed('DpadRight')) navX = 1
        if (pad.justPressed('DpadUp')) navY = -1
        if (pad.justPressed('DpadDown')) navY = 1
        if (pad.justPressed('South')) activatePressed = true
      }
      if (pad.justPressed('East')) back = true
    }
    if (focusedAt && p.focused !== null) {
      if (kind === Kind.Slider && navX !== 0) {
        stepSlider(world, p.focused, navX)
        navX = 0
      }
      if (navX !== 0 || navY !== 0) {
        const next = nearest(focusList, n, focusedAt, navX !== 0 ? navX : 0, navX !== 0 ? 0 : navY)
        if (next) p.focused = next.r.entities[next.i]!
      } else if (activatePressed) {
        if (typing) p.focused = null
        else activate(world, p.focused, kind)
      }
      if (typing && p.focused !== null && keyboard.typed !== '')
        editText(world, p.focused, keyboard.typed)
      if (back) p.focused = null
    }
    world.resource(InputContext).active = p.focused !== null ? 'ui' : 'game'

    // UiInteraction for every widget whose state may have moved.
    for (const r of store.roots) {
      for (let i = 0; i < r.count; i++) {
        if (r.kind[i] === Kind.None) continue
        const e = r.entities[i]!
        setInteraction(world, e, stateOf(store, p, e), p.focused === e)
      }
    }
  },
})
