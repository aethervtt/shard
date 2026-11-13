import {
  defineComponent,
  defineSystem,
  type Entity,
  FixedUpdate,
  t,
  World,
} from '@aethervtt/shard-core'
import { Transform } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allOf,
  anyOf,
  type InterestPolicy,
  NetId,
  NetRole,
  netSession,
  RelevanceSet,
  Replicated,
  replicate,
} from '.'
import { type NetHarness, netHarness } from './testing'

const Secret = defineComponent('streamtest/Secret', { card: t.string() })
const Tag = defineComponent('streamtest/Tag', { v: t.u8() })

let net: NetHarness | undefined
afterEach(async () => {
  await net?.dispose()
  net = undefined
})

/** Sends exactly the listed entities, each at its interval. */
function listInterest(entries: Map<Entity, number>): InterestPolicy {
  return {
    name: 'list',
    update(world, _peer, out) {
      for (const [e, every] of entries) if (world.isAlive(e)) out.add(e, every)
    },
  }
}

function fixedPolicy(name: string, entities: Entity[], every: number): InterestPolicy {
  return {
    name,
    update(_world, _peer, out) {
      for (const e of entities) out.add(e, every)
    },
  }
}

describe('RelevanceSet intervals', () => {
  it('keeps the smallest interval within a fill, and resets on clear', () => {
    const world = new World()
    const [a, b] = [world.spawn(), world.spawn()]
    const set = new RelevanceSet()
    set.add(a, 4)
    set.add(a, 2)
    set.add(a, 8)
    set.add(b)
    expect(set.size).toBe(2)
    expect(set.everyOf(a)).toBe(2)
    expect(set.everyOf(b)).toBe(1)
    set.retain((e) => e === a)
    expect(set.everyOf(a)).toBe(2)
    expect(set.everyOf(b)).toBe(1)
    set.clear()
    expect(set.everyOf(a)).toBe(1)
    set.add(a, 6)
    expect(set.everyOf(a)).toBe(6)
    expect(() => set.add(b, 0)).toThrow(expect.objectContaining({ code: 'net/bad-interval' }))
    expect(() => set.add(b, 1.5)).toThrow(expect.objectContaining({ code: 'net/bad-interval' }))
  })

  it('anyOf takes the smallest interval, allOf the largest', () => {
    const world = new World()
    const [a, b] = [world.spawn(), world.spawn()]
    const peer = { id: 1, focus: [], knows: () => false }
    const some = fixedPolicy('some', [a, b], 4)
    const few = fixedPolicy('few', [a], 2)
    const out = new RelevanceSet()
    anyOf(some, few).update(world, peer, out)
    expect([out.everyOf(a), out.everyOf(b)]).toEqual([2, 4])
    out.clear()
    allOf(few, some).update(world, peer, out)
    expect(out.entities).toEqual([a])
    expect(out.everyOf(a)).toBe(4)
  })
})

describe('send intervals', () => {
  it('sends unreliable state every `every` network ticks, and interpolates between samples', async () => {
    const entries = new Map<Entity, number>()
    net = await netHarness({
      clients: 1,
      net: {
        replicate: [
          replicate(Transform, { mode: 'interpolate', quantize: { translation: { step: 0.001 } } }),
        ],
      },
      serverNet: { interest: listInterest(entries) },
      conditions: { latency: 0.05, jitter: 0.01, seed: 2 },
    })
    await net.connect()
    const world = net.server.world
    const sparse = world.spawn(Replicated, Transform)
    const dense = world.spawn(Replicated, [Transform, { translation: [0, 5, 0] }])
    entries.set(sparse, 4)
    entries.set(dense, 1)
    const speed = 3 // m/s
    net.server.addSystems(
      FixedUpdate,
      defineSystem({
        name: 'streamtest/move',
        run: (_, w) => {
          for (const e of [sparse, dense]) {
            const tr = w.get(e, Transform).translation
            w.set(e, Transform, { translation: [tr[0] + speed / 60, tr[1], 0] })
          }
        },
      }),
    )
    net.step(90)

    // Count the state entries each entity gets over 120 network ticks (two fixed ticks each).
    const server = netSession(world).server!
    const peer = [...server.peers.values()][0]!
    const sparseId = world.get(sparse, NetId).id
    const denseId = world.get(dense, NetId).id
    const counts = new Map<number, number>()
    for (let i = 0; i < 120; i++) {
      const seq = peer.nextSeq
      net.step(2)
      if (peer.nextSeq === seq) continue
      const record = peer.packets[seq % peer.packets.length]!
      for (let k = 0; k < record.netIds.length; k++) {
        const id = record.netIds.at(k)
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    expect(Math.abs((counts.get(sparseId) ?? 0) - 30)).toBeLessThanOrEqual(1)
    expect(counts.get(denseId)).toBe(120)

    // The client knows the interval, and moves the sparse entity on every frame between samples.
    const client = netSession(net.clients[0]!.world).client!
    expect(client.everyOf(sparseId)).toBe(4)
    expect(client.everyOf(denseId)).toBe(1)
    const cw = net.clients[0]!.world
    const local = net.clientEntity(0, sparse)!
    let last = cw.get(local, Transform).translation[0]
    for (let i = 0; i < 120; i++) {
      net.step(1)
      const x = cw.get(local, Transform).translation[0]
      expect(x - last).toBeGreaterThan(speed / 60 / 3)
      expect(x - last).toBeLessThan((speed / 60) * 3)
      last = x
    }

    // A changed interval reaches the client.
    entries.set(sparse, 1)
    net.step(20)
    expect(client.everyOf(sparseId)).toBe(1)
  })

  it('never delays reliable changes', async () => {
    const entries = new Map<Entity, number>()
    net = await netHarness({
      clients: 1,
      net: { replicate: [replicate(Transform), replicate(Tag, { channel: 'reliable' })] },
      serverNet: { interest: listInterest(entries) },
    })
    await net.connect()
    const world = net.server.world
    const e = world.spawn(Replicated, Transform, Tag)
    entries.set(e, 16)
    net.step(10)
    const cw = net.clients[0]!.world
    const local = net.clientEntity(0, e)!
    // Every network tick, a reliable change lands on the next one.
    for (let v = 1; v <= 10; v++) {
      world.set(e, Tag, { v })
      net.step(2)
      expect(cw.get(local, Tag).v).toBe(v)
    }
  })
})

describe('bound entities', () => {
  it('sends only redacted components, and strips them when the entity leaves interest', async () => {
    const entries = new Map<Entity, number>()
    const open = new Set<Entity>()
    const local: { crate?: Entity; spawned: number } = { spawned: 0 }
    const before = { entities: 0 }
    net = await netHarness({
      clients: 1,
      net: {
        replicate: [
          replicate(Transform),
          replicate(Tag),
          replicate(Secret, { visibleTo: (_w, _peer, e) => open.has(e) }),
        ],
      },
      serverNet: { interest: listInterest(entries) },
      clientNet: () => ({
        spawnPrefab: (world) => {
          local.spawned++
          return world.spawn()
        },
        bind: (_world, ref) => (ref === 'cell:main/0,0/crate' ? local.crate : undefined),
      }),
    })
    await net.connect()
    const cw = net.clients[0]!.world
    local.crate = cw.spawn([Transform, { translation: [7, 0, 0] }], [Tag, { v: 9 }])
    before.entities = cw.entityCount

    const world = net.server.world
    const crate = world.spawn(
      [Replicated, { prefab: 'cell:main/0,0/crate', bound: true }],
      [Transform, { translation: [1, 2, 3] }],
      [Tag, { v: 1 }],
      [Secret, { card: 'gold' }],
    )
    // Bound to a cell the client has unloaded: ignored, its updates are no error.
    const gone = world.spawn(
      [Replicated, { prefab: 'cell:main/9,9/barrel', bound: true }],
      [Secret, { card: 'rope' }],
    )
    const plain = world.spawn(Replicated, [Transform, { translation: [4, 0, 0] }])
    entries.set(crate, 1)
    entries.set(gone, 1)
    entries.set(plain, 1)
    open.add(gone)
    net.step(10)

    const client = netSession(cw).client!
    const crateId = world.get(crate, NetId).id
    const goneId = world.get(gone, NetId).id
    expect(client.byNetId.get(crateId)).toBe(local.crate)
    expect(client.byNetId.has(goneId)).toBe(false)
    // Nothing spawned from a prefab, and only the plain entity spawned at all.
    expect(local.spawned).toBe(0)
    expect(cw.entityCount).toBe(before.entities + 1)
    // Nothing but redacted components is sent, and none is visible yet.
    expect(cw.has(local.crate, Secret)).toBe(false)
    expect(cw.has(local.crate, NetId)).toBe(false)
    expect(cw.has(local.crate, Replicated)).toBe(false)
    expect(cw.get(local.crate, Transform).translation).toEqual([7, 0, 0])
    expect(cw.get(local.crate, Tag).v).toBe(9)

    // Revealed: it arrives, follows changes, and goes when hidden again.
    open.add(crate)
    net.step(4)
    expect(cw.get(local.crate, Secret).card).toBe('gold')
    world.set(crate, Secret, { card: 'silver' })
    world.set(gone, Secret, { card: 'chain' })
    world.set(crate, Transform, { translation: [5, 5, 5] })
    net.step(4)
    expect(cw.get(local.crate, Secret).card).toBe('silver')
    open.delete(crate)
    net.step(4)
    expect(cw.has(local.crate, Secret)).toBe(false)

    // Leaving interest strips what it received and keeps the entity.
    open.add(crate)
    net.step(4)
    expect(cw.get(local.crate, Secret).card).toBe('silver')
    entries.delete(crate)
    net.step(4)
    expect(cw.isAlive(local.crate)).toBe(true)
    expect(cw.has(local.crate, Secret)).toBe(false)
    expect(cw.get(local.crate, Transform).translation).toEqual([7, 0, 0])
    expect(cw.get(local.crate, Tag).v).toBe(9)
    expect(client.byNetId.has(crateId)).toBe(false)

    // Back in interest, then despawned on the server: the same.
    entries.set(crate, 1)
    net.step(4)
    expect(cw.get(local.crate, Secret).card).toBe('silver')
    world.despawn(crate)
    net.step(4)
    expect(cw.isAlive(local.crate)).toBe(true)
    expect(cw.has(local.crate, Secret)).toBe(false)

    const stats = [...netSession(world).server!.peers.values()][0]!.stats
    expect(stats.bytesByComponent['core/Transform']).toBeGreaterThan(0) // the plain entity's
    // The plain entity still converges: the ignored one's updates don't hold acks back.
    world.set(plain, Transform, { translation: [6, 0, 0] })
    net.step(6)
    expect(cw.get(net.clientEntity(0, plain)!, Transform).translation).toEqual([6, 0, 0])
    expect(net.differences(Transform, Tag, Secret)).toEqual([])
    expect(client.lastError).toBeUndefined()
    expect(cw.resource(NetRole).connected).toBe(true)
  })

  it('never sends a bound entity anything but redacted components', async () => {
    const entries = new Map<Entity, number>()
    let crate: Entity | undefined
    net = await netHarness({
      clients: 1,
      net: {
        replicate: [replicate(Transform), replicate(Secret, { visibleTo: () => true })],
      },
      serverNet: { interest: listInterest(entries) },
      clientNet: () => ({ bind: () => crate }),
    })
    await net.connect()
    crate = net.clients[0]!.world.spawn()
    const world = net.server.world
    const e = world.spawn(
      [Replicated, { prefab: 'cell:x', bound: true }],
      [Transform, { translation: [1, 0, 0] }],
      [Secret, { card: 'k' }],
    )
    entries.set(e, 1)
    for (let i = 0; i < 20; i++) {
      world.set(e, Transform, { translation: [i, 0, 0] })
      net.step(2)
    }
    const stats = [...netSession(world).server!.peers.values()][0]!.stats
    expect(Object.keys(stats.bytesByComponent)).toEqual(['streamtest/Secret'])
    expect(net.clients[0]!.world.has(crate, Transform)).toBe(false)
  })
})
