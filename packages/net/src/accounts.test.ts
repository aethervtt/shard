import {
  defineComponent,
  defineSystem,
  type Entity,
  ShardError,
  t,
  Update,
} from '@aethervtt/shard-core'
import { LogResource } from '@aethervtt/shard-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AcceptResult,
  NetRole,
  netSession,
  PeerJoined,
  PeerLeft,
  Peers,
  type PlayerHooks,
  PlayerSaveFailed,
  Replicated,
  replicate,
  savePlayer,
} from '.'
import { type NetHarness, type NetHarnessOptions, netHarness } from './testing'

const Gold = defineComponent('accttest/Gold', { amount: t.u32() })
const Banner = defineComponent('accttest/Banner', { text: t.string() })

interface Account {
  account: string
}
interface Character {
  gold: number
}

let net: NetHarness | undefined
afterEach(async () => {
  await net?.dispose()
  net = undefined
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Records what each hook saw. */
function recorder() {
  return {
    loaded: [] as unknown[],
    spawned: [] as { peer: number; user: unknown; data: unknown }[],
    captured: [] as { user: unknown; alive: boolean[] }[],
    stored: [] as { user: unknown; data: unknown }[],
    joined: [] as unknown[],
    left: [] as unknown[],
    saveFailed: [] as string[],
  }
}

function players(log: ReturnType<typeof recorder>): PlayerHooks<Account, Character, Character> {
  return {
    async load({ user }) {
      log.loaded.push(user)
      return { gold: 42 }
    },
    spawn(world, { peer, user, data }) {
      log.spawned.push({ peer, user, data })
      world.spawn([Replicated, { owner: peer }], [Gold, { amount: data.gold }])
    },
    capture(world, { user, owned }) {
      log.captured.push({ user, alive: owned.map((e) => world.isAlive(e)) })
      return { gold: world.get(owned[0]!, Gold).amount }
    },
    async store({ user, data }) {
      log.stored.push({ user, data })
    },
  }
}

function listen(log: ReturnType<typeof recorder>): NetHarnessOptions['server'] {
  return () => [
    {
      name: 'accttest/listen',
      build(app) {
        app.addSystems(
          Update,
          defineSystem({
            name: 'accttest/events',
            run: (_, _w, ctx) => {
              for (const e of ctx.reader(PeerJoined).read()) log.joined.push(e.user)
              for (const e of ctx.reader(PeerLeft).read()) log.left.push(e.user)
              for (const e of ctx.reader(PlayerSaveFailed).read()) log.saveFailed.push(e.code)
            },
          }),
        )
      },
    },
  ]
}

const sharedNet = { replicate: [replicate(Gold), replicate(Banner)] }

describe('async accept', () => {
  it('holds a peer back, receiving nothing, until accept settles', async () => {
    const answer = deferred<AcceptResult<Account>>()
    net = await netHarness({
      clients: 1,
      net: sharedNet,
      serverNet: { accept: () => answer.promise },
    })
    net.server.world.spawn([Replicated, {}], [Banner, { text: 'welcome' }])
    await net.run(12) // 200 ms
    const client = net.clients[0]!.world
    expect(net.server.world.resource(Peers).size).toBe(0)
    expect(client.resource(NetRole).connected).toBe(false)
    expect(netSession(client).client!.byNetId.size).toBe(0)

    answer.resolve({ user: { account: 'a1' } })
    await net.connect()
    expect([...net.server.world.resource(Peers).values()][0]!.user).toEqual({ account: 'a1' })
    await net.run(4)
    expect(netSession(client).client!.byNetId.size).toBe(1)
  })

  it.each([
    [
      'an async refusal',
      () => Promise.resolve(new ShardError('game/bad-token', 'Log in again')),
      'game/bad-token',
    ],
    [
      'a throw',
      () => {
        throw new Error('auth service down')
      },
      'net/accept-failed',
    ],
    ['a rejection', () => Promise.reject(new Error('auth service down')), 'net/accept-failed'],
    ['a timeout', () => new Promise<AcceptResult>(() => {}), 'net/join-timeout'],
  ])('refuses on %s', async (_, accept, code) => {
    net = await netHarness({
      clients: 1,
      net: sharedNet,
      serverNet: { accept, joinTimeout: 0.5 },
    })
    await expect(net.connect(120)).rejects.toMatchObject({ code })
    expect(net.server.world.resource(Peers).size).toBe(0)
  })
})

describe('player hooks', () => {
  async function session(log: ReturnType<typeof recorder>, extra: Partial<NetHarnessOptions> = {}) {
    let next = 0
    return netHarness({
      clients: 2,
      net: sharedNet,
      server: listen(log),
      serverNet: {
        accept: async (): Promise<AcceptResult<Account>> => ({ user: { account: `a${++next}` } }),
        players: players(log) as PlayerHooks,
      },
      ...extra,
    })
  }

  it('passes the user through load, spawn and PeerJoined, and spawns before the welcome', async () => {
    const log = recorder()
    net = await session(log)
    // Step a tick at a time: on the first frame a client is connected, its character is there.
    for (
      let i = 0;
      i < 120 && !net.clients.every((c) => c.world.resource(NetRole).connected);
      i++
    ) {
      await net.run(1)
      for (const c of net.clients) {
        if (c.world.resource(NetRole).connected) {
          expect(netSession(c.world).client!.byNetId.size).toBeGreaterThan(0)
        }
      }
    }
    expect(log.loaded).toEqual([{ account: 'a1' }, { account: 'a2' }])
    expect(log.spawned.map((s) => s.user)).toEqual([{ account: 'a1' }, { account: 'a2' }])
    expect(log.spawned[0]!.data).toEqual({ gold: 42 })
    expect(log.joined).toEqual([{ account: 'a1' }, { account: 'a2' }])
    const gold = [...netSession(net.clients[0]!.world).client!.byNetId.values()].map((e) =>
      net!.clients[0]!.world.tryGet(e, Gold),
    )
    expect(gold).toContainEqual({ amount: 42 })
  })

  it('captures before despawning, stores, and fires PeerLeft with the user', async () => {
    const log = recorder()
    net = await session(log)
    await net.connect()
    const world = net.server.world
    const owned = (peer: number) =>
      world
        .query({ with: [Replicated, Gold] })
        .tables.flatMap((tb) =>
          [...tb.entities.subarray(0, tb.count)].filter(
            (e) => world.get(e, Replicated).owner === peer,
          ),
        ) as Entity[]
    const peer = net.clients[0]!.world.resource(NetRole).peer
    world.set(owned(peer)[0]!, Gold, { amount: 7 })
    await net.removeClient(0)
    await net.run(3)
    expect(log.captured).toEqual([{ user: { account: 'a1' }, alive: [true] }])
    expect(owned(peer)).toEqual([])
    expect(log.stored).toEqual([{ user: { account: 'a1' }, data: { gold: 7 } }])
    expect(log.left).toEqual([{ account: 'a1' }])
  })

  it('saves on demand without despawning', async () => {
    const log = recorder()
    net = await session(log)
    await net.connect()
    await savePlayer(net.server.world, net.clients[1]!.world.resource(NetRole).peer)
    expect(log.stored).toEqual([{ user: { account: 'a2' }, data: { gold: 42 } }])
    expect(log.left).toEqual([])
  })

  it('stores every connected player before the server dispose resolves', async () => {
    const log = recorder()
    let finished = 0
    const hooks = players(log)
    net = await session(log, {
      serverNet: {
        accept: async (_peer: number) => ({ user: { account: `a${_peer}` } }),
        players: {
          ...hooks,
          async store(ctx) {
            await new Promise((r) => setTimeout(r, 20))
            finished++
            await hooks.store!(ctx as never)
          },
        } as PlayerHooks,
      },
    })
    await net.connect()
    const harness = net
    net = undefined
    await harness.server.dispose()
    expect(finished).toBe(2)
    expect(log.stored).toHaveLength(2)
    for (const c of harness.clients) await c.dispose()
  })

  it('reports a failed store and keeps running', async () => {
    const log = recorder()
    const hooks = players(log)
    net = await session(log, {
      serverNet: {
        accept: async () => ({ user: { account: 'x' } }),
        players: {
          ...hooks,
          store: () => Promise.reject(new Error('disk full')),
        } as PlayerHooks,
      },
    })
    await net.connect()
    await net.removeClient(0)
    await net.run(5)
    expect(log.saveFailed).toEqual(['net/save-failed'])
    const errors = net.server.world.resource(LogResource).errors()
    expect(errors.some((e) => e.code === 'net/save-failed' && e.message === 'disk full')).toBe(true)
    expect(net.clients[0]!.world.resource(NetRole).connected).toBe(true)
  })

  it('never spawns or stores a peer that leaves while accept is pending', async () => {
    const log = recorder()
    const answer = deferred<AcceptResult<Account>>()
    net = await session(log, {
      clients: 1,
      serverNet: { accept: () => answer.promise, players: players(log) as PlayerHooks },
    })
    await net.run(5)
    await net.removeClient(0)
    await net.run(2)
    answer.resolve({ user: { account: 'late' } })
    await net.run(5)
    expect(log.loaded).toEqual([])
    expect(log.spawned).toEqual([])
    expect(log.stored).toEqual([])
    expect(net.server.world.resource(Peers).size).toBe(0)
  })
})
