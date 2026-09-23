import { describe, expect, it } from 'vitest'
import { defineComponent, defineTag, t } from '../schema'
import { defineEvent, defineResource } from '../schema/resource'
import { Commands } from './commands'
import { entityIndex } from './entity'
import { ChildOf, Children } from './hierarchy'
import { onAdd, onRemove, onSet } from './observers'
import { World } from './world'

const Position = defineComponent('test/Position', { value: t.vec3 })
const Velocity = defineComponent('test/Velocity', { value: t.vec3 })
const Health = defineComponent('test/Health', { current: t.f32({ default: 100 }), max: t.f32 })
const Name = defineComponent('test/Name', { value: t.string })
const Frozen = defineTag('test/Frozen')

describe('entities', () => {
  it('spawns with values and defaults', () => {
    const world = new World()
    const e = world.spawn([Position, { value: [1, 2, 3] }], Health, Frozen)
    expect(world.get(e, Position)).toEqual({ value: [1, 2, 3] })
    expect(world.get(e, Health)).toEqual({ current: 100, max: 0 })
    expect(world.has(e, Frozen)).toBe(true)
    expect(world.has(e, Velocity)).toBe(false)
    expect(world.entityCount).toBe(1)
  })

  it('type-checks spawn values', () => {
    const world = new World()
    // @ts-expect-error: wrong field type
    world.spawn([Position, { value: 'nope' }])
    // @ts-expect-error: unknown field
    world.spawn([Health, { hp: 1 }])
    expect(world.entityCount).toBe(2)
  })

  it('throws ecs/dead-entity for despawned entities and reuses the index with a new generation', () => {
    const world = new World()
    const a = world.spawn(Position)
    world.despawn(a)
    expect(world.isAlive(a)).toBe(false)
    expect(() => world.get(a, Position)).toThrow(
      expect.objectContaining({ code: 'ecs/dead-entity' }),
    )
    expect(() => world.add(a, Frozen)).toThrow(expect.objectContaining({ code: 'ecs/dead-entity' }))

    const b = world.spawn(Position)
    expect(entityIndex(b)).toBe(entityIndex(a))
    expect(b).not.toBe(a)
    expect(world.isAlive(b)).toBe(true)
    expect(world.isAlive(a)).toBe(false)
  })

  it('keeps other entities intact across swap-removes', () => {
    const world = new World()
    const es = Array.from({ length: 5 }, (_, i) =>
      world.spawn([Position, { value: [i, 0, 0] }], [Name, { value: `e${i}` }]),
    )
    world.despawn(es[1]!)
    world.remove(es[3]!, Name)
    expect(world.get(es[0]!, Position).value[0]).toBe(0)
    expect(world.get(es[2]!, Name).value).toBe('e2')
    expect(world.get(es[3]!, Position).value[0]).toBe(3)
    expect(world.has(es[3]!, Name)).toBe(false)
    expect(world.get(es[4]!, Name).value).toBe('e4')
  })
})

describe('components', () => {
  it('adds, sets, and removes, moving between archetypes', () => {
    const world = new World()
    const e = world.spawn([Position, { value: [1, 1, 1] }])
    world.add(e, Velocity, { value: [0, 1, 0] })
    world.set(e, Position, { value: [5, 5, 5] })
    expect(world.get(e, Position).value).toEqual([5, 5, 5])
    expect(world.get(e, Velocity).value).toEqual([0, 1, 0])
    expect(world.remove(e, Velocity)).toBe(true)
    expect(world.remove(e, Velocity)).toBe(false)
    expect(world.get(e, Position).value).toEqual([5, 5, 5])
  })

  it('partial set leaves other fields alone', () => {
    const world = new World()
    const e = world.spawn([Health, { current: 50, max: 80 }])
    world.set(e, Health, { current: 10 })
    expect(world.get(e, Health)).toEqual({ current: 10, max: 80 })
  })

  it('throws ecs/missing-component', () => {
    const world = new World()
    const e = world.spawn(Position)
    expect(() => world.get(e, Health)).toThrow(
      expect.objectContaining({ code: 'ecs/missing-component' }),
    )
    expect(world.tryGet(e, Health)).toBeUndefined()
  })

  it('get returns copies', () => {
    const world = new World()
    const e = world.spawn([Position, { value: [1, 2, 3] }], [Name, { value: 'a' }])
    world.get(e, Position).value[0] = 99
    expect(world.get(e, Position).value[0]).toBe(1)
  })
})

describe('queries', () => {
  it('matches with/without and picks up archetypes created later', () => {
    const world = new World()
    const moving = world.query({ with: [Position, Velocity], without: [Frozen] })
    const a = world.spawn(Position, Velocity)
    const b = world.spawn(Position, Velocity, Frozen)
    const c = world.spawn(Position)
    const d = world.spawn(Position, Velocity, Health)
    expect(moving.entities().sort()).toEqual([a, d].sort())
    world.add(c, Velocity)
    world.remove(b, Frozen)
    expect(moving.count()).toBe(4)
  })

  it('returns the same query for the same descriptor', () => {
    const world = new World()
    expect(world.query({ with: [Position, Velocity] })).toBe(
      world.query({ with: [Velocity, Position] }),
    )
  })

  it('iterates raw strided columns', () => {
    const world = new World()
    for (let i = 0; i < 10; i++) {
      world.spawn([Position, { value: [i, 0, 0] }], [Velocity, { value: [1, 2, 3] }])
    }
    const q = world.query({ with: [Position, Velocity] })
    for (const table of q.tables) {
      const pos = table.column(Position, 'value')
      const vel = table.column(Velocity, 'value')
      for (let i = 0, n = table.count * 3; i < n; i++) pos[i]! += vel[i]!
      table.markChanged(Position)
    }
    const values = q.entities().map((e) => world.get(e, Position).value)
    expect(values[0]).toEqual([1, 2, 3])
    expect(values[9]).toEqual([10, 2, 3])
  })
})

describe('change detection', () => {
  it('added/changed filters return exactly rows touched since a tick', () => {
    const world = new World()
    const a = world.spawn(Health)
    const b = world.spawn(Health)
    const since = world.tick
    world.incrementTick()

    const c = world.spawn(Health)
    world.set(a, Health, { current: 1 })

    const added = world.query({ added: [Health] })
    const changed = world.query({ changed: [Health] })
    expect(added.entities(since)).toEqual([c])
    expect(changed.entities(since).sort()).toEqual([a, c].sort())
    expect(changed.entities(since)).not.toContain(b)

    const later = world.tick
    world.incrementTick()
    expect(changed.entities(later)).toEqual([])
  })

  it('markChanged marks whole tables or single rows', () => {
    const world = new World()
    const a = world.spawn(Health)
    const b = world.spawn(Health)
    const since = world.tick
    world.incrementTick()
    const q = world.query({ with: [Health], changed: [Health] })
    const table = q.tables[0]!
    table.markChanged(Health, 1)
    expect(q.entities(since)).toEqual([b])
    table.markChanged(Health)
    expect(q.entities(since).sort()).toEqual([a, b].sort())
  })

  it('keeps ticks when an entity moves between tables', () => {
    const world = new World()
    const e = world.spawn(Health)
    const since = world.tick
    world.incrementTick()
    world.add(e, Frozen)
    expect(world.query({ changed: [Health] }).entities(since)).toEqual([])
  })
})

describe('commands', () => {
  it('defers structural changes and applies them in order', () => {
    const world = new World()
    const cmd = new Commands(world)
    const q = world.query({ with: [Position] })
    const a = world.spawn(Position)

    q.each((e) => {
      cmd.add(e, Velocity, { value: [1, 0, 0] })
      cmd.remove(e, Velocity)
      cmd.add(e, Velocity, { value: [2, 0, 0] })
    })
    const spawned = cmd.spawn([Position, { value: [9, 9, 9] }])
    cmd.add(spawned, Frozen)

    expect(world.has(a, Velocity)).toBe(false)
    expect(world.isAlive(spawned)).toBe(false)
    cmd.apply()
    expect(world.get(a, Velocity).value).toEqual([2, 0, 0])
    expect(world.get(spawned, Position).value).toEqual([9, 9, 9])
    expect(world.has(spawned, Frozen)).toBe(true)
    expect(cmd.length).toBe(0)
  })

  it('skips despawns of already-dead entities', () => {
    const world = new World()
    const cmd = new Commands(world)
    const e = world.spawn(Position)
    cmd.despawn(e)
    cmd.despawn(e)
    expect(() => cmd.apply()).not.toThrow()
    expect(world.isAlive(e)).toBe(false)
  })
})

describe('observers', () => {
  it('fires add, set, and remove, with previous values on set', () => {
    const world = new World()
    const log: string[] = []
    world.observe(onAdd(Health), ({ entity, world }) =>
      log.push(`add ${world.get(entity, Health).current}`),
    )
    world.observe(onSet(Health), ({ previous, entity, world }) =>
      log.push(`set ${previous?.current}->${world.get(entity, Health).current}`),
    )
    world.observe(onRemove(Health), ({ entity, world }) =>
      log.push(`remove ${world.get(entity, Health).current}`),
    )
    const e = world.spawn([Health, { current: 10 }])
    world.set(e, Health, { current: 20 })
    world.add(e, Health, { current: 30 })
    world.remove(e, Health)
    world.add(e, Health)
    world.despawn(e)
    expect(log).toEqual([
      'add 10',
      'set 10->20',
      'set 20->30',
      'remove 30',
      'add 100',
      'remove 100',
    ])
  })

  it('fires after commands apply, not while recording', () => {
    const world = new World()
    const cmd = new Commands(world)
    const log: string[] = []
    world.observe(onAdd(Frozen), () => log.push('frozen'))
    const e = world.spawn(Position)
    cmd.add(e, Frozen)
    expect(log).toEqual([])
    cmd.apply()
    expect(log).toEqual(['frozen'])
  })

  it('runs custom triggers with data and target', () => {
    const world = new World()
    const Explode = defineEvent<{ radius: number }>('test/Explode')
    const seen: [number, number | undefined][] = []
    const off = world.observe(Explode, ({ data, entity }) => seen.push([data.radius, entity]))
    world.trigger(Explode, { radius: 3 }, 42)
    off()
    world.trigger(Explode, { radius: 9 })
    expect(seen).toEqual([[3, 42]])
  })
})

describe('events', () => {
  const Hit = defineEvent<number>('test/Hit')

  it('are readable for exactly two frames', () => {
    const world = new World()
    world.send(Hit, 1)
    const late = world.reader(Hit)
    world.updateEvents() // frame 2
    world.send(Hit, 2)
    world.updateEvents() // frame 3: event 1 dropped
    expect([...late.read()]).toEqual([2])
    world.updateEvents() // frame 4: event 2 dropped
    expect(world.reader(Hit).read()).toEqual([])
  })

  it('supports multiple independent readers', () => {
    const world = new World()
    const a = world.reader(Hit)
    const b = world.reader(Hit)
    world.send(Hit, 1)
    world.send(Hit, 2)
    expect([...a.read()]).toEqual([1, 2])
    expect([...a.read()]).toEqual([])
    world.updateEvents()
    world.send(Hit, 3)
    expect([...b.read()]).toEqual([1, 2, 3])
    expect([...a.read()]).toEqual([3])
  })
})

describe('resources', () => {
  it('inserts, reads, and initializes', () => {
    const world = new World()
    const Score = defineResource<{ value: number }>('test/Score', { init: () => ({ value: 0 }) })
    expect(() => world.resource(Score)).toThrow(
      expect.objectContaining({ code: 'ecs/missing-resource' }),
    )
    world.initResource(Score).value = 5
    expect(world.resource(Score).value).toBe(5)
    world.insertResource(Score, { value: 1 })
    expect(world.resource(Score).value).toBe(1)
  })
})

describe('hierarchy', () => {
  it('maintains Children from ChildOf', () => {
    const world = new World()
    const parent = world.spawn(Position)
    const a = world.spawn([ChildOf, { parent }])
    const b = world.spawn(Position)
    world.add(b, ChildOf, { parent })
    expect(world.get(parent, Children).entities).toEqual([a, b])

    const other = world.spawn(Position)
    world.set(a, ChildOf, { parent: other })
    expect(world.get(parent, Children).entities).toEqual([b])
    expect(world.get(other, Children).entities).toEqual([a])

    world.remove(b, ChildOf)
    expect(world.has(parent, Children)).toBe(false)
  })

  it('despawning a parent despawns all descendants', () => {
    const world = new World()
    const root = world.spawn(Position)
    const child = world.spawn([ChildOf, { parent: root }])
    const grandchild = world.spawn([ChildOf, { parent: child }])
    const bystander = world.spawn(Position)
    world.despawn(root)
    expect(world.isAlive(child)).toBe(false)
    expect(world.isAlive(grandchild)).toBe(false)
    expect(world.isAlive(bystander)).toBe(true)
    expect(world.entityCount).toBe(1)
  })

  it('despawnSingle orphans children', () => {
    const world = new World()
    const root = world.spawn(Position)
    const child = world.spawn([ChildOf, { parent: root }])
    world.despawnSingle(root)
    expect(world.isAlive(child)).toBe(true)
    expect(world.has(child, ChildOf)).toBe(false)
  })

  it('removes a despawned child from its parent', () => {
    const world = new World()
    const root = world.spawn(Position)
    const a = world.spawn([ChildOf, { parent: root }])
    const b = world.spawn([ChildOf, { parent: root }])
    world.despawn(a)
    expect(world.get(root, Children).entities).toEqual([b])
  })
})

describe('stats', () => {
  it('reports entities, archetypes, and memory', () => {
    const world = new World()
    world.spawn(Position, Velocity)
    world.spawn(Position)
    const stats = world.stats()
    expect(stats.entities).toBe(2)
    const table = stats.tables.find((t) => t.components.length === 2)!
    expect(table.components).toEqual(['test/Position', 'test/Velocity'])
    expect(table.count).toBe(1)
    expect(table.bytes).toBeGreaterThan(0)
  })
})

describe('required components', () => {
  const Global = defineComponent('test/Global', { m: t.affine3x4 })
  const Local = defineComponent('test/Local', { x: t.f32 }, { requires: [Global] })
  const Visible = defineTag('test/Visible')
  const Mesh = defineComponent('test/Mesh', { id: t.u32 }, { requires: [Local, Visible] })

  it('adds required components transitively on spawn, with defaults', () => {
    const world = new World()
    const e = world.spawn([Mesh, { id: 3 }])
    expect(world.has(e, Local)).toBe(true)
    expect(world.has(e, Global)).toBe(true)
    expect(world.has(e, Visible)).toBe(true)
    expect(world.get(e, Global).m).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  })

  it('keeps explicitly given values for required components', () => {
    const world = new World()
    const e = world.spawn([Mesh, { id: 1 }], [Local, { x: 5 }])
    expect(world.get(e, Local).x).toBe(5)
  })

  it('adds them in a single archetype move on add()', () => {
    const world = new World()
    const e = world.spawn([Position, { value: [1, 2, 3] }])
    const before = world.stats().archetypes
    world.add(e, Mesh, { id: 9 })
    // One new archetype: {Position, Mesh, Local, Global, Visible}. No intermediate tables.
    expect(world.stats().archetypes).toBe(before + 1)
    expect(world.get(e, Position).value).toEqual([1, 2, 3])
    expect(world.has(e, Global)).toBe(true)
  })

  it('fires onAdd for required components', () => {
    const world = new World()
    const added: string[] = []
    world.observe(onAdd(Global), () => added.push('global'))
    world.spawn(Local)
    expect(added).toEqual(['global'])
  })

  it('lists requirements in describe()', () => {
    const world = new World()
    world.spawn(Mesh)
    const mesh = world.registry.describe().components.find((c) => c.name === 'test/Mesh')
    expect(mesh?.requires).toEqual(['test/Local', 'test/Visible'])
  })
})
