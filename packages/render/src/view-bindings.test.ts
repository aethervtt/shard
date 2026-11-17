import { describe, expect, it } from 'vitest'
import { checkViewEntries, VIEW_BINDINGS } from './view-bindings'

describe('view group bindings', () => {
  it('gives every binding of the view group its own number', () => {
    const numbers = Object.values(VIEW_BINDINGS)
    expect(new Set(numbers).size).toBe(numbers.length)
  })

  it('throws on a layout with two entries at one binding', () => {
    const entry = (binding: number) => ({ binding, visibility: 0, texture: {} })
    expect(() => checkViewEntries('ok', [entry(0), entry(19), entry(20)])).not.toThrow()
    expect(() =>
      checkViewEntries('forward/view/refraction', [entry(0), entry(19), entry(19)]),
    ).toThrow(expect.objectContaining({ code: 'render/view-binding-collision' }))
  })
})
