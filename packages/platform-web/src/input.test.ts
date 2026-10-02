import type { RawInputEvent } from '@aethervtt/shard-platform'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDomInputSource } from './input'

// A DOM just big enough for the input source: an element and a window as plain EventTargets,
// pointer events as Events with the fields the source reads.

class FakeElement extends EventTarget {
  readonly style = { touchAction: '' }
  readonly captured = new Set<number>()
  getBoundingClientRect() {
    return { left: 10, top: 20, width: 400, height: 300 }
  }
  setPointerCapture(id: number) {
    this.captured.add(id)
  }
}

interface PointerInit {
  pointerId?: number
  button?: number
  pointerType?: string
  clientX?: number
  clientY?: number
  shiftKey?: boolean
}

function pointerEvent(type: string, init: PointerInit = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    button: 0,
    pointerType: 'mouse',
    clientX: 0,
    clientY: 0,
    movementX: 0,
    movementY: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  })
}

const saved = { window: globalThis.window, canvas: globalThis.HTMLCanvasElement }

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).window = new EventTarget()
  ;(globalThis as Record<string, unknown>).HTMLCanvasElement = class {}
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).window = saved.window
  ;(globalThis as Record<string, unknown>).HTMLCanvasElement = saved.canvas
})

function setup() {
  const element = new FakeElement()
  const source = createDomInputSource(element as unknown as HTMLElement)
  const drain = () => {
    const out: RawInputEvent[] = []
    source.drain(out)
    return out
  }
  return { element, source, drain }
}

describe('createDomInputSource (0060)', () => {
  it('reports pointers in CSS pixels from the element, with modifiers', () => {
    const { element, drain } = setup()
    element.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 110, clientY: 70, button: 1, shiftKey: true }),
    )
    const pointer = drain().find((e) => e.type === 'pointer')
    expect(pointer).toEqual({
      type: 'pointer',
      id: 1,
      phase: 'down',
      pointer: 'mouse',
      button: 'middle',
      x: 100,
      y: 50,
      modifiers: 1,
    })
  })

  it("doesn't preventDefault a press no control takes", () => {
    const { element, drain } = setup()
    const down = pointerEvent('pointerdown')
    element.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
    const move = pointerEvent('pointermove', { clientX: 50 })
    element.dispatchEvent(move)
    expect(move.defaultPrevented).toBe(false)
    const menu = new Event('contextmenu', { cancelable: true })
    element.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(false)
    const wheel = Object.assign(new Event('wheel', { cancelable: true }), {
      deltaX: 0,
      deltaY: 3,
      deltaMode: 1,
      clientX: 10,
      clientY: 20,
    })
    element.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
    expect(drain().find((e) => e.type === 'wheel')).toMatchObject({ dy: 48, x: 0, y: 0 })
    expect(element.captured.size).toBe(0)
    expect(element.style.touchAction).toBe('')
  })

  it('takes a claimed drag: preventDefault on its moves, captured so it reports outside', () => {
    const { element, source, drain } = setup()
    element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7 }))
    source.claimPointer?.(7)
    expect(element.captured.has(7)).toBe(true)
    // With capture, moves outside the element still arrive at it.
    const outside = pointerEvent('pointermove', { pointerId: 7, clientX: -500, clientY: 900 })
    element.dispatchEvent(outside)
    expect(outside.defaultPrevented).toBe(true)
    const up = pointerEvent('pointerup', { pointerId: 7, clientX: -500, clientY: 900 })
    globalThis.window.dispatchEvent(up)
    expect(up.defaultPrevented).toBe(true)
    const phases = drain()
      .filter((e) => e.type === 'pointer')
      .map((e) => e.type === 'pointer' && [e.phase, e.x, e.y])
    expect(phases).toEqual([
      ['down', -10, -20],
      ['move', -510, 880],
      ['up', -510, 880],
    ])
    // Once it ended, the pointer id is free again.
    const next = pointerEvent('pointermove', { pointerId: 7 })
    element.dispatchEvent(next)
    expect(next.defaultPrevented).toBe(false)
  })

  it('takes what an enabled control drags with, and only while it is enabled', () => {
    const { element, source } = setup()
    source.setPointerPolicy?.({ buttons: ['right'], wheel: true, touch: true })
    expect(element.style.touchAction).toBe('none')
    const right = pointerEvent('pointerdown', { button: 2, pointerId: 2 })
    element.dispatchEvent(right)
    expect(right.defaultPrevented).toBe(true)
    expect(element.captured.has(2)).toBe(true)
    const left = pointerEvent('pointerdown', { button: 0, pointerId: 3 })
    element.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
    const menu = new Event('contextmenu', { cancelable: true })
    element.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)

    source.setPointerPolicy?.({ buttons: [], wheel: false, touch: false })
    expect(element.style.touchAction).toBe('')
    const later = new Event('contextmenu', { cancelable: true })
    element.dispatchEvent(later)
    expect(later.defaultPrevented).toBe(false)
  })
})
