import {
  type InputSource,
  MODIFIERS,
  type MouseButton,
  type PointerKind,
  type PointerPolicy,
  type RawInputEvent,
} from '@aethervtt/shard-platform'

const BUTTONS: MouseButton[] = ['left', 'middle', 'right', 'back', 'forward']

function modifiersOf(e: MouseEvent): number {
  return (
    (e.shiftKey ? MODIFIERS.shift : 0) |
    (e.ctrlKey ? MODIFIERS.ctrl : 0) |
    (e.altKey ? MODIFIERS.alt : 0) |
    (e.metaKey ? MODIFIERS.meta : 0)
  )
}

function kindOf(e: PointerEvent): PointerKind {
  return e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse'
}

export interface DomInputOptions {
  /**
   * The element's context menu. 'block' (default): never shown, for a game that owns its page.
   * 'pass': shown unless a control drags with the right button, for a host with menus of its own
   * (0060).
   */
  contextMenu?: 'block' | 'pass'
}

/**
 * DOM input: pointer and wheel events on `element` (positions in its backing pixels, and in CSS
 * pixels for `pointer` events), keys and focus on the window, gamepads polled on drain. Works in
 * browsers and Tauri webviews alike.
 *
 * Events pass through to the page unless the scene takes them (0060): a press with a button an
 * enabled control drags with, a claimed pointer's later events, and the wheel while a control
 * zooms with it are `preventDefault`ed; so is the context menu, unless `contextMenu` is 'pass'.
 */
export function createDomInputSource(
  element: HTMLElement,
  options: DomInputOptions = {},
): InputSource {
  const blockMenu = (options.contextMenu ?? 'block') === 'block'
  const events: RawInputEvent[] = []
  const listeners = new Set<() => void>()
  // Every event goes through here, so on-demand apps hear about it (0052).
  const queue = {
    push(e: RawInputEvent) {
      events.push(e)
      for (const listener of listeners) listener()
    },
  }
  const target = globalThis.window
  const toPixels = (e: PointerEvent | WheelEvent) => {
    const rect = element.getBoundingClientRect()
    const sx = element instanceof HTMLCanvasElement ? element.width / Math.max(1, rect.width) : 1
    const sy = element instanceof HTMLCanvasElement ? element.height / Math.max(1, rect.height) : 1
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    return { x: cx * sx, y: cy * sy, cx, cy, sx, sy }
  }
  const knownPads = new Set<number>()
  let policy: PointerPolicy = { buttons: [], wheel: false, touch: false }
  /** Pointers down on the element: the button each went down with. */
  const down = new Map<number, MouseButton>()
  const claimed = new Set<number>()
  const touchAction = element.style.touchAction

  const capture = (id: number) => {
    try {
      element.setPointerCapture?.(id)
    } catch {
      // The pointer already ended.
    }
  }
  const pointer = (
    e: PointerEvent,
    phase: 'down' | 'move' | 'up' | 'cancel',
    cx: number,
    cy: number,
  ) => {
    const button =
      phase === 'move' ? (down.get(e.pointerId) ?? 'left') : (BUTTONS[e.button] ?? 'left')
    queue.push({
      type: 'pointer',
      id: e.pointerId,
      phase,
      pointer: kindOf(e),
      button,
      x: cx,
      y: cy,
      modifiers: modifiersOf(e),
    })
  }
  const takes = (e: PointerEvent) =>
    e.pointerType === 'touch' ? policy.touch : policy.buttons.includes(BUTTONS[e.button] ?? 'left')

  const onKeyDown = (e: KeyboardEvent) => {
    // Characters (repeats too) feed text fields; key state ignores repeats.
    if (!e.ctrlKey && !e.metaKey) {
      if (e.key.length === 1) queue.push({ type: 'text', text: e.key })
      else if (e.key === 'Backspace') queue.push({ type: 'text', text: '\b' })
    }
    if (e.repeat) return
    queue.push({ type: 'key', code: e.code, pressed: true })
  }
  const onKeyUp = (e: KeyboardEvent) => {
    queue.push({ type: 'key', code: e.code, pressed: false })
  }
  const onPointerDown = (e: PointerEvent) => {
    const { x, y, cx, cy } = toPixels(e)
    down.set(e.pointerId, BUTTONS[e.button] ?? 'left')
    if (takes(e)) {
      // A control drags with this: the press is the scene's, and so is the rest of it.
      e.preventDefault()
      capture(e.pointerId)
    }
    if (e.pointerType === 'touch')
      queue.push({ type: 'touch', id: e.pointerId, phase: 'start', x, y })
    else queue.push({ type: 'mouse-button', button: BUTTONS[e.button] ?? 'left', pressed: true })
    pointer(e, 'down', cx, cy)
  }
  const onPointerUp = (e: PointerEvent) => {
    const { x, y, cx, cy } = toPixels(e)
    if (claimed.has(e.pointerId)) e.preventDefault()
    if (e.pointerType === 'touch')
      queue.push({ type: 'touch', id: e.pointerId, phase: 'end', x, y })
    else queue.push({ type: 'mouse-button', button: BUTTONS[e.button] ?? 'left', pressed: false })
    if (down.has(e.pointerId)) pointer(e, 'up', cx, cy)
    down.delete(e.pointerId)
    claimed.delete(e.pointerId)
  }
  const onPointerCancel = (e: PointerEvent) => {
    if (!down.has(e.pointerId)) return
    const { x, y, cx, cy } = toPixels(e)
    if (e.pointerType === 'touch')
      queue.push({ type: 'touch', id: e.pointerId, phase: 'end', x, y })
    pointer(e, 'cancel', cx, cy)
    down.delete(e.pointerId)
    claimed.delete(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent) => {
    const { x, y, cx, cy, sx, sy } = toPixels(e)
    if (claimed.has(e.pointerId)) e.preventDefault()
    if (e.pointerType === 'touch')
      queue.push({ type: 'touch', id: e.pointerId, phase: 'move', x, y })
    else queue.push({ type: 'mouse-move', x, y, dx: e.movementX * sx, dy: e.movementY * sy })
    pointer(e, 'move', cx, cy)
  }
  const onWheel = (e: WheelEvent) => {
    if (policy.wheel) e.preventDefault()
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    const { cx, cy } = toPixels(e)
    queue.push({
      type: 'wheel',
      dx: e.deltaX * scale,
      dy: e.deltaY * scale,
      x: cx,
      y: cy,
      modifiers: modifiersOf(e),
    })
  }
  const onBlur = () => queue.push({ type: 'focus', focused: false })
  const onFocus = () => queue.push({ type: 'focus', focused: true })
  // With 'pass', the page's context menu stays unless a control drags with the right button.
  const onContextMenu = (e: Event) => {
    if (blockMenu || policy.buttons.includes('right')) e.preventDefault()
  }

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  target.addEventListener('focus', onFocus)
  element.addEventListener('pointerdown', onPointerDown)
  target.addEventListener('pointerup', onPointerUp)
  element.addEventListener('pointercancel', onPointerCancel)
  element.addEventListener('pointermove', onPointerMove)
  element.addEventListener('wheel', onWheel, { passive: false })
  element.addEventListener('contextmenu', onContextMenu)

  return {
    drain(out) {
      for (const e of events) out.push(e)
      events.length = 0
      const pads = globalThis.navigator?.getGamepads?.() ?? []
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i]
        if (pad?.connected) {
          knownPads.add(i)
          out.push({
            type: 'gamepad',
            index: i,
            connected: true,
            buttons: pad.buttons.map((b) => b.value),
            axes: [...pad.axes],
          })
        } else if (knownPads.has(i)) {
          knownPads.delete(i)
          out.push({ type: 'gamepad', index: i, connected: false, buttons: [], axes: [] })
        }
      }
    },
    onInput(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    claimPointer(id) {
      if (!down.has(id) || claimed.has(id)) return
      claimed.add(id)
      capture(id)
    },
    setPointerPolicy(next) {
      policy = { buttons: [...next.buttons], wheel: next.wheel, touch: next.touch }
      element.style.touchAction = next.touch ? 'none' : touchAction
    },
    dispose() {
      listeners.clear()
      element.style.touchAction = touchAction
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
      target.removeEventListener('focus', onFocus)
      element.removeEventListener('pointerdown', onPointerDown)
      target.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onPointerCancel)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('contextmenu', onContextMenu)
    },
  }
}
