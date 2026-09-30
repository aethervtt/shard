import { defineComponent, defineResource, t, World } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import { AssetServer, AssetStore, defineAssetType, MissingAsset } from './index'

// Leases and fallbacks (0061): assets held by owners unload with them, and a failed asset shows a
// fallback that `retry` replaces.

class Shape {
  readonly triangles: number
  readonly fake: boolean
  constructor(triangles: number, fake = false) {
    this.triangles = triangles
    this.fake = fake
  }
}

const Shapes = defineResource<AssetStore<Shape>>('leases-test/Shapes', {
  init: () => new AssetStore('Shape'),
})

const unloaded: Shape[] = []
defineAssetType<Shape>('Shape', {
  store: Shapes,
  load: () => new Shape(0),
  unload: (item) => unloaded.push(item),
  fallback: ({ dev }) => new Shape(dev ? 2 : 1, true),
  cost: (item) => ({ triangles: item.triangles }),
})

const Holds = defineComponent('leases-test/Holds', { shape: t.handle('Shape') })

function setup() {
  const world = new World()
  const server = new AssetServer(world)
  let n = 0
  const make = (triangles: number, fail = () => false) =>
    server.virtual(`guid-${n}`, `gen/shape-${n++}`, 'Shape', () => {
      if (fail()) throw new Error('the source is gone')
      return new Shape(triangles)
    })
  return { world, server, make }
}

describe('leases (0061)', () => {
  it('unloads an owner’s leased assets on release, unless another owner leases them', async () => {
    const { world, server, make } = setup()
    const a = make(100)
    const b = make(200)
    const scene = world.owners.create('scene')
    const mod = world.owners.create('mod')
    const refA = server.lease(a.path, scene)
    server.lease(b.path, scene)
    server.lease(b.path, mod)
    await server.load(refA)
    expect(world.owners.describe(scene).usage.triangles).toBe(300)
    expect(world.owners.describe(scene).leases).toEqual([a.path, b.path])
    unloaded.length = 0
    world.owners.release(scene)
    expect(server.state(a.path)).toBe('unloaded')
    expect(server.state(b.path)).toBe('loaded')
    expect(unloaded.map((s) => s.triangles)).toEqual([100])
    expect(world.resource(Shapes).size).toBe(1)
    expect(world.owners.describe(mod).usage.triangles).toBe(200)
  })

  it("releasing a parent owner drops its child owners' leases", async () => {
    const { world, server, make } = setup()
    const a = make(5)
    const parent = world.owners.create('scene')
    const child = world.owners.create('mod', { parent })
    await server.load(server.lease(a.path, child))
    world.owners.release(parent)
    expect(server.state(a.path)).toBe('unloaded')
    expect(server.leasesOf(child)).toEqual([])
  })

  it('keeps a released lease loaded while an entity still references it', () => {
    const { world, server, make } = setup()
    const a = make(10)
    const owner = world.owners.create('o')
    const ref = server.lease<'Shape'>(a.path, owner)
    world.spawn([Holds, { shape: ref }])
    world.owners.release(owner)
    expect(server.state(a.path)).toBe('loaded')
  })

  it('fails a lease past the triangles limit with core/owner-quota and changes nothing', () => {
    const { world, server, make } = setup()
    const a = make(600)
    const b = make(600)
    const parent = world.owners.create('parent', { limits: { triangles: 1000 } })
    const child = world.owners.create('child', { parent })
    server.lease(a.path, child)
    expect(() => server.lease(b.path, child)).toThrow(
      expect.objectContaining({ code: 'core/owner-quota' }),
    )
    expect(world.owners.describe(parent).usage.triangles).toBe(600)
    expect(server.leasesOf(child)).toEqual([a.path])
    // At the limit, even an asset whose size isn't known yet is refused.
    const full = world.owners.create('full', { limits: { triangles: 0 } })
    const lazy = server.virtual('lazy', 'gen/lazy', 'Shape', () => new Shape(1), { lazy: true })
    expect(() => server.lease(lazy.path, full)).toThrow(
      expect.objectContaining({ code: 'core/owner-quota' }),
    )
  })
})

describe('fallbacks (0061)', () => {
  it('serves a fallback for a failed asset, marks the entities using it, and retry swaps back', async () => {
    const { world, server, make } = setup()
    let broken = true
    const entry = make(50, () => broken)
    expect(server.state(entry.path)).toBe('failed')
    expect(server.isFallback(entry.path)).toBe(true)
    const ref = { type: 'Shape' as const, guid: entry.guid, path: entry.path }
    const shape = world.resource(Shapes).get(ref)!
    expect(shape.fake).toBe(true)
    const user = world.spawn([Holds, { shape: ref }])
    const other = world.spawn(Holds)
    server.markMissing()
    expect(world.get(user, MissingAsset)).toEqual({
      ref: entry.path,
      code: 'assets/import-failed',
      message: expect.stringContaining('the source is gone'),
    })
    expect(world.has(other, MissingAsset)).toBe(false)
    expect(server.failed().map((f) => f.path)).toEqual([entry.path])

    broken = false
    unloaded.length = 0
    await server.retry(ref)
    expect(server.state(entry.path)).toBe('loaded')
    expect(server.isFallback(entry.path)).toBe(false)
    expect(world.resource(Shapes).get(ref)!.triangles).toBe(50)
    server.markMissing()
    expect(world.has(user, MissingAsset)).toBe(false)
    expect(world.isAlive(user)).toBe(true)
    expect(server.fallbackCount).toBe(0)
  })
})
