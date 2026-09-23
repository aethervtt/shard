import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Entity } from '../ecs/entity'
import { ShardError } from '../error'
import { type AssetRef, type Color, defineComponent, defineTag, type Infer, Registry, t } from '.'

const Everything = defineComponent('test/Everything', {
  f32: t.f32,
  f64: t.f64({ default: 2.5 }),
  i8: t.i8,
  i16: t.i16,
  i32: t.i32({ min: -10, max: 10 }),
  u8: t.u8,
  u16: t.u16,
  u32: t.u32,
  flag: t.bool,
  v2: t.vec2,
  v3: t.vec3({ default: [1, 2, 3] }),
  v4: t.vec4,
  rotation: t.quat,
  tint: t.color,
  mode: t.enum(['idle', 'walk', 'run']),
  target: t.entity,
  label: t.string,
  mesh: t.handle('Mesh'),
  tags: t.list(t.string),
  stats: t.struct({ speed: t.f32({ default: 1 }), lucky: t.bool }),
  extra: t.json,
})

describe('type inference', () => {
  it('infers the exact value type of every field kind', () => {
    type E = Infer<typeof Everything>
    expectTypeOf<E['f32']>().toEqualTypeOf<number>()
    expectTypeOf<E['u32']>().toEqualTypeOf<number>()
    expectTypeOf<E['flag']>().toEqualTypeOf<boolean>()
    expectTypeOf<E['v2']>().toEqualTypeOf<[number, number]>()
    expectTypeOf<E['v3']>().toEqualTypeOf<[number, number, number]>()
    expectTypeOf<E['rotation']>().toEqualTypeOf<[number, number, number, number]>()
    expectTypeOf<E['tint']>().toEqualTypeOf<Color>()
    expectTypeOf<E['mode']>().toEqualTypeOf<'idle' | 'walk' | 'run'>()
    expectTypeOf<E['target']>().toEqualTypeOf<Entity | null>()
    expectTypeOf<E['label']>().toEqualTypeOf<string>()
    expectTypeOf<E['mesh']>().toEqualTypeOf<AssetRef<'Mesh'> | null>()
    expectTypeOf<E['tags']>().toEqualTypeOf<string[]>()
    expectTypeOf<E['stats']>().toEqualTypeOf<{ speed: number; lucky: boolean }>()
  })
})

describe('defaults', () => {
  it('uses type defaults and declared defaults', () => {
    const d = Everything.defaults()
    expect(d.f32).toBe(0)
    expect(d.f64).toBe(2.5)
    expect(d.v3).toEqual([1, 2, 3])
    expect(d.rotation).toEqual([0, 0, 0, 1])
    expect(d.tint).toEqual([1, 1, 1, 1])
    expect(d.mode).toBe('idle')
    expect(d.target).toBeNull()
    expect(d.stats).toEqual({ speed: 1, lucky: false })
  })

  it('returns fresh copies each time', () => {
    const a = Everything.defaults()
    a.v3[0] = 99
    a.tags.push('x')
    expect(Everything.defaults().v3[0]).toBe(1)
    expect(Everything.defaults().tags).toEqual([])
  })
})

describe('validate', () => {
  const codesAt = (json: unknown) => Everything.validate(json).map((e) => [e.code, e.path] as const)

  it('accepts an empty object (every field has a default)', () => {
    expect(Everything.validate({})).toEqual([])
  })

  it('reports type mismatches with JSON pointers', () => {
    expect(codesAt({ f32: 'fast', v3: [1, 'x', 3], stats: { speed: true } })).toEqual([
      ['schema/type-mismatch', '/f32'],
      ['schema/type-mismatch', '/v3/1'],
      ['schema/type-mismatch', '/stats/speed'],
    ])
  })

  it('reports out-of-range values, including integer storage limits', () => {
    expect(codesAt({ i32: 11, u8: 256, i8: -129 })).toEqual([
      ['schema/out-of-range', '/i8'],
      ['schema/out-of-range', '/i32'],
      ['schema/out-of-range', '/u8'],
    ])
  })

  it('rejects non-integers in integer fields', () => {
    expect(codesAt({ u16: 1.5 })).toEqual([['schema/type-mismatch', '/u16']])
  })

  it('reports unknown fields with a suggestion', () => {
    const [err] = Everything.validate({ lable: 'x' })
    expect(err?.code).toBe('schema/unknown-field')
    expect(err?.path).toBe('/lable')
    expect(err?.hint).toBe('Did you mean "label"?')
  })

  it('reports missing required fields', () => {
    const Named = defineComponent('test/Named', { name: t.string({ required: true }) })
    expect(Named.validate({}).map((e) => [e.code, e.path])).toEqual([
      ['schema/missing-field', '/name'],
    ])
  })

  it('escapes pointer segments', () => {
    const Weird = defineComponent('test/Weird', { 'a/b': t.f32 })
    expect(Weird.validate({ 'a/b': 'x' })[0]?.path).toBe('/a~1b')
  })

  it('checks asset existence and type when a resolver is given', () => {
    const ctx = {
      resolveAsset: (ref: { guid?: string; path?: string }) =>
        ref.path === 'assets/sofa.glb#Mesh0'
          ? { guid: 'g-sofa', path: 'assets/sofa.glb#Mesh0', type: 'Mesh' }
          : ref.path === 'assets/wood.png'
            ? { guid: 'g-wood', path: 'assets/wood.png', type: 'Texture' }
            : undefined,
    }
    expect(Everything.validate({ mesh: { path: 'assets/sofa.glb#Mesh0' } }, ctx)).toEqual([])
    expect(Everything.validate({ mesh: { path: 'assets/nope.glb' } }, ctx)[0]?.code).toBe(
      'schema/asset-not-found',
    )
    expect(Everything.validate({ mesh: { path: 'assets/wood.png' } }, ctx)[0]?.code).toBe(
      'schema/asset-type-mismatch',
    )
    expect(Everything.deserialize({ mesh: { path: 'assets/sofa.glb#Mesh0' } }, ctx).mesh).toEqual({
      type: 'Mesh',
      guid: 'g-sofa',
      path: 'assets/sofa.glb#Mesh0',
    })
  })

  it('deserialize throws the first validation error', () => {
    expect(() => Everything.deserialize({ f32: 'x' })).toThrow(ShardError)
  })
})

describe('JSON Schema', () => {
  const ajv = new Ajv2020({ allErrors: true })
  for (const keyword of ['x-unit', 'x-hidden', 'x-version', 'x-asset-type']) ajv.addKeyword(keyword)
  const check = ajv.compile(Everything.jsonSchema())

  const fixtures: [string, unknown][] = [
    ['empty', {}],
    ['full valid', Everything.serialize(Everything.defaults())],
    ['hex color', { tint: '#ff8800' }],
    ['hex color with alpha', { tint: '#ff880080' }],
    ['bad hex', { tint: '#ff88' }],
    ['linear color', { tint: [0.5, 0.2, 0.1, 1] }],
    ['negative color', { tint: [-1, 0, 0, 1] }],
    ['entity path', { target: 'lobby/sofa_02' }],
    ['entity id', { target: 42 }],
    ['negative entity', { target: -1 }],
    ['handle guid', { mesh: { guid: 'abc' } }],
    ['empty handle', { mesh: {} }],
    ['handle extra key', { mesh: { guid: 'abc', url: 'x' } }],
    ['enum ok', { mode: 'run' }],
    ['enum bad', { mode: 'fly' }],
    ['wrong type', { f32: 'x' }],
    ['float in int', { u8: 1.5 }],
    ['out of range', { i32: 50 }],
    ['vec too short', { v3: [1, 2] }],
    ['unknown field', { nope: 1 }],
    ['nested struct bad', { stats: { speed: 'x' } }],
    ['nested struct unknown', { stats: { luck: true } }],
    ['list ok', { tags: ['a', 'b'] }],
    ['list bad item', { tags: ['a', 1] }],
    ['any json', { extra: { deep: [1, { x: null }] } }],
    ['not an object', [1, 2]],
  ]

  it.each(fixtures)('agrees with validate(): %s', (_, input) => {
    expect(check(input)).toBe(Everything.validate(input).length === 0)
  })

  it('carries descriptions, units, and defaults', () => {
    const Health = defineComponent(
      'test/Health',
      { current: t.f32({ default: 100, min: 0, unit: 'hp', description: 'Current hit points' }) },
      { description: 'Hit points' },
    )
    expect(Health.jsonSchema()).toMatchObject({
      title: 'test/Health',
      description: 'Hit points',
      additionalProperties: false,
      properties: {
        current: {
          type: 'number',
          minimum: 0,
          default: 100,
          'x-unit': 'hp',
          description: 'Current hit points',
        },
      },
    })
  })
})

describe('serialization', () => {
  it('round-trips every field type', () => {
    const value: Infer<typeof Everything> = {
      f32: 0.5,
      f64: Math.PI,
      i8: -5,
      i16: 1000,
      i32: 7,
      u8: 200,
      u16: 60000,
      u32: 4000000000,
      flag: true,
      v2: [1, 2],
      v3: [3, 4, 5],
      v4: [6, 7, 8, 9],
      rotation: [0, 0.6, 0, 0.8],
      tint: [0.25, 0.5, 0.75, 1],
      mode: 'walk',
      target: 12,
      label: 'sofa',
      mesh: { type: 'Mesh', guid: 'g1', path: 'assets/sofa.glb#Mesh0' },
      tags: ['furniture', 'soft'],
      stats: { speed: 2, lucky: true },
      extra: { anything: [1, 'two', null] },
    }
    const json = JSON.parse(JSON.stringify(Everything.serialize(value)))
    expect(Everything.deserialize(json)).toEqual(value)
  })

  it('writes colors as hex when lossless, arrays otherwise', () => {
    const Tint = defineComponent('test/Tint', { c: t.color })
    const hex = Tint.deserialize({ c: '#ff8800' })
    expect(Tint.serialize(hex).c).toBe('#ff8800')
    expect(Tint.serialize({ c: [2, 1, 1, 1] }).c).toEqual([2, 1, 1, 1])
  })

  it('converts sRGB hex to linear', () => {
    const Tint = defineComponent('test/Tint2', { c: t.color })
    const [r, g, b, a] = Tint.deserialize({ c: '#808080' }).c
    expect(r).toBeCloseTo(0.2158, 3)
    expect(g).toBe(r)
    expect(b).toBe(r)
    expect(a).toBe(1)
  })

  it('resolves entity paths through the context', () => {
    const Link = defineComponent('test/Link', { to: t.entity })
    expect(Link.deserialize({ to: 'lobby/door' }, { resolveEntity: () => 77 }).to).toBe(77)
    expect(() => Link.deserialize({ to: 'lobby/door' })).toThrow(
      expect.objectContaining({ code: 'schema/unresolved-entity' }),
    )
  })
})

describe('versioning', () => {
  it('migrates older JSON step by step', () => {
    // v1 had { hp }, v2 renamed it to { current }, v3 added { max }.
    const Health = defineComponent(
      'test/HealthV3',
      { current: t.f32, max: t.f32({ default: 100 }) },
      {
        version: 3,
        migrate(from, json) {
          const j = json as Record<string, unknown>
          if (from === 1) return { current: j.hp }
          if (from === 2) return { ...j, max: 100 }
          return j
        },
      },
    )
    expect(Health.deserialize(Health.upgrade({ hp: 40 }, 1))).toEqual({ current: 40, max: 100 })
    expect(Health.upgrade({ current: 1, max: 2 }, 3)).toEqual({ current: 1, max: 2 })
    expect(() => Health.upgrade({}, 4)).toThrow(
      expect.objectContaining({ code: 'schema/future-version' }),
    )
  })

  it('requires a migrate function above version 1', () => {
    expect(() => defineComponent('test/NoMigrate', {}, { version: 2 })).toThrow(
      expect.objectContaining({ code: 'schema/missing-migration' }),
    )
  })
})

describe('names and registry', () => {
  it('rejects badly formed names', () => {
    expect(() => defineComponent('Health', {})).toThrow(
      expect.objectContaining({ code: 'schema/invalid-name' }),
    )
  })

  it('rejects a second definition under the same name', () => {
    const registry = new Registry()
    const a = defineTag('test/Dup')
    const b = defineTag('test/Dup')
    registry.register(a)
    registry.register(a)
    expect(() => registry.register(b)).toThrow(
      expect.objectContaining({ code: 'schema/duplicate-name' }),
    )
  })

  it('describes registered definitions with their schemas', () => {
    const registry = new Registry()
    registry.register(Everything)
    const [desc] = registry.describe().components
    expect(desc?.name).toBe('test/Everything')
    expect(desc?.schema).toEqual(Everything.jsonSchema())
  })

  it('builds a column layout from fields', () => {
    const Transformish = defineComponent('test/Transformish', {
      position: t.vec3,
      rotation: t.quat,
      name: t.string,
      mode: t.enum(['a', 'b']),
    })
    expect(Transformish.layout.map((c) => [c.name, c.storage, c.stride])).toEqual([
      ['position', 'f32', 3],
      ['rotation', 'f32', 4],
      ['name', 'object', 1],
      ['mode', 'u8', 1],
    ])
  })
})
