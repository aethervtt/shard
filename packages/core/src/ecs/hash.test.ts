import { describe, expect, it } from 'vitest'
import { defineComponent, t } from '../schema'
import { worldHashRows } from './hash'
import { World } from './world'

// Defined Zeta first, so a table's columns put it before Alpha.
const Zeta = defineComponent('hash-test/Zeta', { z: t.f32 })
const Alpha = defineComponent('hash-test/Alpha', { a: t.f32 })

describe('worldHashRows', () => {
  it('lists components by name, not definition order: a bundle that defines them in another order hashes the same', () => {
    const world = new World()
    world.spawn([Zeta, { z: 1 }], [Alpha, { a: 2 }])
    const [row] = worldHashRows(world)
    expect(row).toBe('[0,[["hash-test/Alpha",{"a":2}],["hash-test/Zeta",{"z":1}]]]')
  })
})
