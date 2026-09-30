import { ChildOf, defineComponent, t, World } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { createMirror } from './mirror'

const Pos = defineComponent('test/MirrorPos', { value: t.vec2 })

interface Doc {
  id: string
  rev: number
  x: number
  y: number
}

function tokens(world: World) {
  const applied: string[] = []
  const mirror = createMirror(world, {
    key: (doc: Doc) => doc.id,
    rev: (doc: Doc) => doc.rev,
    spawn: (_doc, w) => w.spawn(Pos),
    apply: (entity, doc, w) => {
      applied.push(doc.id)
      w.set(entity, Pos, { value: [doc.x, doc.y] })
    },
  })
  return { mirror, applied }
}

const median = (t: ArrayLike<number>) => Array.from(t).sort((a, b) => a - b)[t.length >> 1]!

describe('mirror', () => {
  it('spawns new documents, applies changed ones, and despawns missing ones', () => {
    const world = new World()
    const { mirror, applied } = tokens(world)
    const a = { id: 'a', rev: 0, x: 1, y: 2 }
    const b = { id: 'b', rev: 0, x: 3, y: 4 }
    expect(mirror.sync([a, b])).toEqual({ spawned: 2, applied: 0, removed: 0 })
    const ea = mirror.entity('a')!
    expect(world.get(ea, Pos).value).toEqual([1, 2])

    applied.length = 0
    expect(mirror.sync([a, b])).toEqual({ spawned: 0, applied: 0, removed: 0 })
    expect(applied).toEqual([])

    expect(mirror.sync([{ ...a, rev: 1, x: 9 }])).toEqual({ spawned: 0, applied: 1, removed: 1 })
    expect(applied).toEqual(['a'])
    expect(world.get(ea, Pos).value).toEqual([9, 2])
    expect(mirror.entity('b')).toBeUndefined()
    expect(mirror.size).toBe(1)
  })

  it('upserts and removes single documents without the full list', () => {
    const world = new World()
    const { mirror, applied } = tokens(world)
    const e = mirror.upsert({ id: 'a', rev: 0, x: 0, y: 0 })
    expect(mirror.upsert({ id: 'a', rev: 0, x: 5, y: 5 })).toBe(e)
    expect(applied).toEqual(['a'])
    mirror.upsert({ id: 'a', rev: 1, x: 5, y: 5 })
    expect(world.get(e, Pos).value).toEqual([5, 5])
    expect(mirror.remove('a')).toBe(true)
    expect(world.isAlive(e)).toBe(false)
    expect(mirror.remove('a')).toBe(false)
  })

  it('falls back to a host equality without revisions', () => {
    const world = new World()
    let applies = 0
    const mirror = createMirror(world, {
      key: (doc: { id: string; x: number }) => doc.id,
      equal: (prev, next) => prev.x === next.x,
      spawn: (_d, w) => w.spawn(Pos),
      apply: () => {
        applies++
      },
    })
    mirror.sync([{ id: 'a', x: 1 }])
    mirror.sync([{ id: 'a', x: 1 }])
    expect(applies).toBe(1)
    mirror.sync([{ id: 'a', x: 2 }])
    expect(applies).toBe(2)
  })

  it('rejects a list with a repeated key, and a mirror that cannot diff', () => {
    const world = new World()
    const { mirror } = tokens(world)
    const a = { id: 'a', rev: 0, x: 0, y: 0 }
    expect(() => mirror.sync([a, a])).toThrow(
      expect.objectContaining({ code: 'mirror/duplicate-key' }),
    )
    expect(() =>
      createMirror(world, { key: (d: Doc) => d.id, spawn: (_d, w) => w.spawn(Pos), apply() {} }),
    ).toThrow(expect.objectContaining({ code: 'mirror/no-diff' }))
  })

  it('resolves a visual child of a mirrored entity to its host id', () => {
    const world = new World()
    let grandchild = -1
    const mirror = createMirror(world, {
      key: (doc: Doc) => doc.id,
      rev: (doc: Doc) => doc.rev,
      spawn: (_doc, w) => {
        const root = w.spawn(Pos)
        const disc = w.spawn([ChildOf, { parent: root }])
        grandchild = w.spawn([ChildOf, { parent: disc }])
        return root
      },
      apply() {},
    })
    mirror.sync([{ id: 'token-7', rev: 0, x: 0, y: 0 }])
    const root = mirror.entity('token-7')!
    expect(mirror.keyOf(grandchild)).toBe('token-7')
    expect(mirror.keyOf(root)).toBe('token-7')
    expect(mirror.keyOf(world.spawn(Pos))).toBeUndefined()
  })

  it('despawns what an entity was replaced with only once, even if the host despawned it', () => {
    const world = new World()
    const { mirror } = tokens(world)
    mirror.sync([{ id: 'a', rev: 0, x: 0, y: 0 }])
    world.despawn(mirror.entity('a')!)
    expect(mirror.sync([]).removed).toBe(1)
  })

  it('syncs 5,000 unchanged walls in under 0.2 ms and allocates nothing', async () => {
    const world = new World()
    let applies = 0
    const mirror = createMirror(world, {
      key: (doc: Doc) => doc.id,
      rev: (doc: Doc) => doc.rev,
      spawn: (_d, w) => w.spawn(Pos),
      apply: () => {
        applies++
      },
    })
    const walls: Doc[] = []
    for (let i = 0; i < 5000; i++) walls.push({ id: `wall-${i}`, rev: i & 7, x: i, y: 0 })
    mirror.sync(walls)
    applies = 0
    for (let i = 0; i < 500; i++) mirror.sync(walls)
    const times = new Float64Array(400)
    globalThis.gc?.()
    await new Promise((r) => setTimeout(r, 200))
    const gcs = gcWindow()
    for (let i = 0; i < times.length; i++) {
      const t0 = performance.now()
      mirror.sync(walls)
      times[i] = performance.now() - t0
    }
    const collections = await gcs.end()
    expect(applies).toBe(0)
    if (allocationChecks) expect(collections).toBe(0)
    expect(median(times)).toBeLessThan(budget(0.2))
  })
})
