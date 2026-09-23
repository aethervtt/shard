import type { InputSource, MouseButton, RawInputEvent } from '@shard/platform'

const BUTTONS: MouseButton[] = ['left', 'middle', 'right', 'back', 'forward']

/**
 * DOM input: pointer and wheel events on `element` (positions in its backing pixels), keys and
 * focus on the window, gamepads polled on drain. Works in browsers and Tauri webviews alike.
 */
export function createDomInputSource(element: HTMLElement): InputSource {
  const queue: RawInputEvent[] = []
  const target = globalThis.window
  const toPixels = (e: PointerEvent | WheelEvent) => {
    const rect = element.getBoundingClientRect()
    const sx = element instanceof HTMLCanvasElement ? element.width / Math.max(1, rect.width) : 1
    const sy = element instanceof HTMLCanvasElement ? element.height / Math.max(1, rect.height) : 1
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy, sx, sy }
  }
  const knownPads = new Set<number>()

  const onKey = (pressed: boolean) => (e: KeyboardEvent) => {
    if (e.repeat) return
    queue.push({ type: 'key', code: e.code, pressed })
  }
  const onKeyDown = onKey(true)
  const onKeyUp = onKey(false)
  const onPointerDown = (e: PointerEvent) => {
    const { x, y } = toPixels(e)
    if (e.pointerType === 'touch')
      queue.push({ type: 'touch', id: e.pointerId, phase: 'start', x, y })
    else queue.push({ type: 'mouse-button', button: BUTTONS[e.button] ?? 'left', pressed: true })
  }
  const onPointerUp = (e: PointerEvent) => {
    const { x, y } = toPixels(e)
    if (e.pointerType === 'touch')
      queue.push({ type: 'touch', id: e.pointerId, phase: 'end', x, y })
    else queue.push({ type: 'mouse-button', button: BUTTONS[e.button] ?? 'left', pressed: false })
  }
  const onPointerMove = (e: PointerEvent) => {
    const { x, y, sx, sy } = toPixels(e)
    if (e.pointerType === 'touch')
      queue.push({ type: 'touch', id: e.pointerId, phase: 'move', x, y })
    else queue.push({ type: 'mouse-move', x, y, dx: e.movementX * sx, dy: e.movementY * sy })
  }
  const onWheel = (e: WheelEvent) => {
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    queue.push({ type: 'wheel', dx: e.deltaX * scale, dy: e.deltaY * scale })
  }
  const onBlur = () => queue.push({ type: 'focus', focused: false })
  const onFocus = () => queue.push({ type: 'focus', focused: true })
  const onContextMenu = (e: Event) => e.preventDefault()

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  target.addEventListener('focus', onFocus)
  element.addEventListener('pointerdown', onPointerDown)
  target.addEventListener('pointerup', onPointerUp)
  element.addEventListener('pointermove', onPointerMove)
  element.addEventListener('wheel', onWheel, { passive: true })
  element.addEventListener('contextmenu', onContextMenu)

  return {
    drain(out) {
      for (const e of queue) out.push(e)
      queue.length = 0
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
    dispose() {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
      target.removeEventListener('focus', onFocus)
      element.removeEventListener('pointerdown', onPointerDown)
      target.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('contextmenu', onContextMenu)
    },
  }
}
