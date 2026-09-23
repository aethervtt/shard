import { describe, expect, it } from 'vitest'
import { defineComponent, findComponent } from '../schema/component'
import { t } from '../schema/field'
import { beginRedefinition, endRedefinition } from '../schema/names'
import { defineResource, findResource } from '../schema/resource'
import { World } from './world'

describe('redefinition (hot reload)', () => {
  it('a same-layout redefinition keeps storage and id; a changed one migrates through values', () => {
    const Ship = defineComponent('reload-a/Ship', { speed: t.f32(), fuel: t.f32({ default: 5 }) })
    const Other = defineComponent('reload-a/Other', { n: t.u32() })
    const world = new World()
    const a = world.spawn([Ship, { speed: 3 }], [Other, { n: 1 }])
    const b = world.spawn([Ship, { speed: 7, fuel: 1 }])

    beginRedefinition('reload-a')
    const Ship2 = defineComponent('reload-a/Ship', {
      speed: t.f32({ description: 'now documented' }),
      fuel: t.f32({ default: 5 }),
    })
    const changes = endRedefinition()
    expect(changes.map((c) => c.name)).toEqual(['reload-a/Ship'])
    expect(Ship2.id).toBe(Ship.id)
    expect(findComponent('reload-a/Ship')).toBe(Ship2)
    world.redefine(Ship2)
    expect(world.get(a, Ship2)).toEqual({ speed: 3, fuel: 5 })
    expect(world.componentsOf(b)).toContain(Ship2)

    beginRedefinition('reload-a')
    const Ship3 = defineComponent('reload-a/Ship', {
      speed: t.f32(),
      heading: t.vec3({ default: [0, 0, -1] }),
    })
    endRedefinition()
    world.redefine(Ship3, (value) => {
      const { fuel: _dropped, ...json } = Ship2.serialize(value as never)
      return Ship3.deserialize(json)
    })
    expect(world.get(a, Ship3).speed).toBe(3)
    expect(Array.from(world.get(a, Ship3).heading)).toEqual([0, 0, -1])
    expect(world.get(b, Ship3).speed).toBe(7)
    expect(world.get(a, Other).n).toBe(1)
    // New spawns use the new layout, and moving between archetypes keeps working.
    const c = world.spawn([Ship3, { speed: 1 }])
    world.add(c, Other, { n: 2 })
    expect(world.get(c, Ship3).speed).toBe(1)
    world.remove(a, Other)
    expect(world.get(a, Ship3).speed).toBe(3)
  })

  it('outside a scope (or its namespace) a second definition is ambiguous as before', () => {
    defineComponent('reload-b/Thing', { x: t.f32() })
    beginRedefinition('elsewhere')
    defineComponent('reload-b/Thing', { x: t.f32() })
    endRedefinition()
    expect(() => findComponent('reload-b/Thing')).toThrow(/Several components/)
  })

  it('undo restores the previous definitions after a failed reload', () => {
    const Before = defineComponent('reload-c/Thing', { x: t.f32() })
    const R = defineResource<number>('reload-c/Score')
    beginRedefinition('reload-c')
    defineComponent('reload-c/Thing', { x: t.f32(), y: t.f32() })
    const R2 = defineResource<number>('reload-c/Score')
    const changes = endRedefinition()
    expect(R2.id).toBe(R.id)
    for (const c of changes) c.undo()
    expect(findComponent('reload-c/Thing')).toBe(Before)
    expect(findResource('reload-c/Score')).toBe(R)
  })
})
