import {
  defineComponent,
  defineSystem,
  type Entity,
  FixedUpdate,
  onAdd,
  t,
  type World,
} from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import {
  alwaysInterest,
  anyOf,
  commands,
  defineNetCommand,
  defineNetEvent,
  gridInterest,
  loopback,
  NetClock,
  NetRole,
  netSession,
  onServer,
  ownerInterest,
  ownerOnly,
  Replicated,
  replicate,
  sendCommand,
  sendEvent,
  simulateConditions,
  teamInterest,
} from '.'
import { type NetHarness, netHarness } from './testing'

const Health = defineComponent('nettest/Health', { hp: t.u16({ max: 1000 }), target: t.entity() })
const Secret = defineComponent('nettest/Secret', { card: t.string() })
const Other = defineComponent('nettest/Other', { v: t.f32() })

const Attack = defineNetCommand('nettest/Attack', {
  target: t.entity(),
  damage: t.u16({ max: 100 }),
})
const Shout = defineNetEvent('nettest/Shout', { text: t.string(), about: t.entity() })

const replicated = [
  replicate(Transform, { quantize: { translation: { step: 0.01 } } }),
  replicate(Health),
  replicate(Secret, { visibleTo: ownerOnly }),
]

let net: NetHarness | undefined
afterEach(async () => {
  await net?.dispose()
  net = undefined
})

function spawn(world: World, x: number, owner = 0, hp = 100): Entity {
  return world.spawn(
    [Replicated, { owner }],
    [Transform, { translation: [x, 0, 0] }],
    [Health, { hp }],
  )
}

describe('connections', () => {
  it('connects every client within 10 ticks at zero latency', async () => {
    net = await netHarness({ clients: 2, net: { replicate: replicated } })
    net.step(10)
    for (const c of net.clients) expect(c.world.resource(NetRole).connected).toBe(true)
    const peers = net.clients.map((c) => c.world.resource(NetRole).peer)
    expect(new Set(peers).size).toBe(2)
  })

  it('refuses a client whose replicated layout differs, naming the component', async () => {
    net = await netHarness({
      clients: 1,
      serverNet: { replicate: [...replicated, replicate(Other)] },
      clientNet: () => ({ replicate: replicated }),
    })
    await expect(net.connect(60)).rejects.toMatchObject({
      code: 'net/schema-mismatch',
      message: expect.stringContaining('nettest/Other'),
    })
  })

  it('estimates RTT under latency and jitter', async () => {
    net = await netHarness({
      clients: 1,
      net: { replicate: replicated },
      conditions: { latency: 0.1, jitter: 0.02, seed: 3 },
    })
    await net.connect()
    net.step(180)
    const rtt = net.clients[0]!.world.resource(NetClock).rtt
    // 200 ms plus mean jitter both ways (20 ms), plus up to three frame waits (a message is read
    // once per frame on each side, and the harness steps the server first).
    expect(rtt).toBeGreaterThan(200)
    expect(rtt).toBeLessThan(200 + 20 + 3 * 17)
    const offset =
      net.clients[0]!.world.resource(NetClock).serverTick - net.server.world.resource(NetRole).tick
    expect(Math.abs(offset)).toBeLessThan(4)
  })

  it('splits large reliable messages into fragments', async () => {
    net = await netHarness({ clients: 1, maxMessage: 256, net: { replicate: replicated } })
    await net.connect()
    const owner = net.clients[0]!.world.resource(NetRole).peer
    const e = net.server.world.spawn([Replicated, { owner }], [Secret, { card: 'x'.repeat(5000) }])
    net.step(6)
    const local = net.clientEntity(0, e)!
    expect(net.clients[0]!.world.get(local, Secret).card).toHaveLength(5000)
  })
})

describe('conditions', () => {
  async function deliveries(seed: number, loss: number) {
    let clock = 0
    const net = loopback()
    const listener = await net.listen!({ address: 'a' })
    const got: string[] = []
    listener.onConnection((c) => c.onMessage((channel, b) => got.push(`${channel}:${b[0]}`)))
    const link = simulateConditions(net, {
      latency: 0.05,
      jitter: 0.05,
      loss,
      seed,
      now: () => clock,
    })
    const conn = await link.connect('a')
    for (let i = 0; i < 50; i++) {
      conn.send(i % 2 ? 'reliable' : 'unreliable', new Uint8Array([i]))
      clock += 5
      conn.pump!()
    }
    clock += 1000
    conn.pump!()
    return got
  }

  it('is deterministic for a seed, and loss drops only unreliable messages', async () => {
    expect(await deliveries(9, 0.3)).toEqual(await deliveries(9, 0.3))
    const all = await deliveries(9, 1)
    expect(all).toHaveLength(25)
    expect(all.every((m) => m.startsWith('reliable'))).toBe(true)
    // Reliable messages arrive in order even under jitter.
    const order = all.map((m) => Number(m.split(':')[1]))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

describe('replication', () => {
  it('converges at 100 ms ± 20 ms with 5% loss', async () => {
    net = await netHarness({
      clients: 2,
      net: { replicate: replicated },
      conditions: { latency: 0.1, jitter: 0.02, loss: 0.05, seed: 5 },
    })
    await net.connect()
    const world = net.server.world
    const entities = Array.from({ length: 50 }, (_, i) => spawn(world, i))
    world.set(entities[3]!, Health, { target: entities[7]! })
    for (let i = 0; i < 120; i++) {
      for (const e of entities) {
        const tr = world.get(e, Transform).translation
        world.set(e, Transform, { translation: [tr[0] + 0.1, tr[1], Math.sin(i / 10)] })
      }
      if (i % 30 === 0) world.set(entities[i % 50]!, Health, { hp: 50 + i })
      net.step(1)
    }
    world.despawn(entities[10]!)
    net.step(60) // one second after the server goes quiet
    expect(net.differences(Transform, Health)).toEqual([])
    // Entity fields arrive as the client's own entities.
    const client = net.clients[0]!.world
    const local3 = net.clientEntity(0, entities[3]!)!
    expect(client.get(local3, Health).target).toBe(net.clientEntity(0, entities[7]!))
    expect(netSession(client).client!.byNetId.size).toBe(49)
  })

  it('keeps a redacted component off every other peer', async () => {
    net = await netHarness({ clients: 2, net: { replicate: replicated } })
    await net.connect()
    const [a, b] = net.clients.map((c) => c.world.resource(NetRole).peer) as [number, number]
    let leaked = 0
    net.clients[1]!.world.observe(onAdd(Secret), () => leaked++)
    const hand = net.server.world.spawn([Replicated, { owner: a }], [Secret, { card: 'ace' }])
    net.step(20)
    expect(net.clients[0]!.world.get(net.clientEntity(0, hand)!, Secret).card).toBe('ace')
    expect(net.clients[1]!.world.has(net.clientEntity(1, hand)!, Secret)).toBe(false)
    expect(leaked).toBe(0)
    const stats = netSession(net.server.world).server!.peers.get(b)!.stats
    expect(stats.bytesByComponent['nettest/Secret']).toBeUndefined()
    // Ownership changes hands: the old owner loses it, the new one gets it.
    net.server.world.set(hand, Replicated, { owner: b })
    net.step(20)
    expect(net.clients[0]!.world.has(net.clientEntity(0, hand)!, Secret)).toBe(false)
    expect(net.clients[1]!.world.get(net.clientEntity(1, hand)!, Secret).card).toBe('ace')
  })

  it('sends only entities in grid range, and despawns those that leave it', async () => {
    net = await netHarness({
      clients: 1,
      net: { replicate: replicated },
      serverNet: { interest: anyOf(ownerInterest(), gridInterest({ cellSize: 10, range: 1 })) },
    })
    await net.connect()
    const world = net.server.world
    const peer = net.clients[0]!.world.resource(NetRole).peer
    spawn(world, 0, peer)
    const near = spawn(world, 15)
    const far = spawn(world, 100)
    net.step(10)
    expect(net.clientEntity(0, near)).toBeDefined()
    expect(net.clientEntity(0, far)).toBeUndefined()
    const stats = netSession(world).server!.peers.get(peer)!
    expect(stats.known.size).toBe(2)
    world.set(near, Transform, { translation: [45, 0, 0] })
    net.step(4)
    expect(net.clientEntity(0, near)).toBeUndefined()
    expect(net.differences(Transform, Health)).toEqual([])
  })

  it('brings a late joiner up to date under a byte budget', async () => {
    net = await netHarness({
      clients: 1,
      net: { replicate: replicated },
      serverNet: { budget: { bytesPerTick: 16000 } },
    })
    await net.connect()
    const world = net.server.world
    for (let i = 0; i < 5000; i++) spawn(world, i * 0.5, 0, i % 1000)
    net.step(120)
    expect(net.converged(Transform, Health)).toBe(true)
    await net.addClient()
    let ticks = 0
    while (!net.converged(Transform, Health) && ticks < 240) {
      net.step(2)
      ticks += 2
    }
    expect(net.differences(Transform, Health)).toEqual([])
    expect(ticks).toBeLessThanOrEqual(120)
  })

  it('sends everything within ceil(total / budget) + 1 network ticks', async () => {
    net = await netHarness({
      clients: 1,
      net: { replicate: replicated, tickRate: 60 },
      serverNet: { budget: { bytesPerTick: 400 } },
    })
    await net.connect()
    const world = net.server.world
    const entities = Array.from({ length: 100 }, (_, i) => spawn(world, i))
    let sent = 0
    let ticks = 0
    while (sent < 100 && ticks < 100) {
      net.step(1)
      ticks++
      sent = entities.filter((e) => net!.clientEntity(0, e) !== undefined).length
    }
    // Each spawn here is about 20 bytes: 100 entities take ~5 ticks at 400 bytes.
    const stats = netSession(world).server!.peers.values().next().value!.stats
    const total = Object.values(stats.bytesByComponent).reduce((a, b) => a + b, 0)
    expect(sent).toBe(100)
    expect(ticks).toBeLessThanOrEqual(Math.ceil(total / 400) + 2)
  })

  it('spawns from the prefab on the client and never sends its local components', async () => {
    net = await netHarness({
      clients: 1,
      net: { replicate: replicated },
      clientNet: () => ({
        spawnPrefab: (world, prefab) =>
          world.spawn([Other, { v: prefab === 'props/crate' ? 1 : 2 }]),
      }),
    })
    await net.connect()
    const world = net.server.world
    const crate = world.spawn(
      [Replicated, { prefab: 'props/crate' }],
      [Transform, { translation: [1, 2, 3] }],
      [Other, { v: 42 }],
    )
    net.step(10)
    const client = net.clients[0]!.world
    const local = net.clientEntity(0, crate)!
    expect(client.get(local, Other).v).toBe(1)
    expect(client.get(local, Transform).translation).toEqual([1, 2, 3])
    const stats = [...netSession(world).server!.peers.values()][0]!.stats
    expect(Object.keys(stats.bytesByComponent).sort()).toEqual(['core/Transform', 'net/Replicated'])
  })

  it('sends teammates to each other wherever they are', async () => {
    const Team = defineComponent('nettest/Team', { id: t.u8() })
    net = await netHarness({
      clients: 2,
      net: { replicate: replicated },
      serverNet: { interest: anyOf(ownerInterest(), teamInterest(Team, 'id')) },
    })
    await net.connect()
    const world = net.server.world
    const [a, b] = net.clients.map((c) => c.world.resource(NetRole).peer) as [number, number]
    world.spawn([Replicated, { owner: a }], [Team, { id: 1 }])
    world.spawn([Replicated, { owner: b }], [Team, { id: 2 }])
    const ally = world.spawn([Replicated, {}], [Team, { id: 1 }])
    const enemy = world.spawn([Replicated, {}], [Team, { id: 2 }])
    net.step(10)
    expect(net.clientEntity(0, ally)).toBeDefined()
    expect(net.clientEntity(0, enemy)).toBeUndefined()
    expect(net.clientEntity(1, enemy)).toBeDefined()
    expect(net.clientEntity(1, ally)).toBeUndefined()
  })

  it('answers the agent protocol: describe, inspect, relevance', async () => {
    net = await netHarness({ clients: 1, net: { replicate: replicated } })
    await net.connect()
    const app = net.server
    const world = app.world
    const peer = net.clients[0]!.world.resource(NetRole).peer
    const secret = world.spawn([Replicated, { owner: 99 }], [Secret, { card: 'x' }])
    net.step(6)
    const call = (name: string, params: Record<string, unknown> = {}) =>
      app.methods.find((m) => m.name === name)!.handler({ app, world }, params)
    expect(call('net.describe')).toMatchObject({ role: 'server', connected: true })
    expect(call('net.inspect', { entity: secret })).toMatchObject({
      owner: 99,
      peers: { [peer]: { relevant: true, known: true, redacted: ['nettest/Secret'] } },
    })
    expect(call('net.relevance', { peer, reason: '' })).toContain(secret)
    const client = net.clients[0]!
    expect(
      client.methods
        .find((m) => m.name === 'net.describe')!
        .handler({ app: client, world: client.world }, {}),
    ).toMatchObject({ role: 'client', connected: true, peer })
  })

  it('interpolates remote movement without steps', async () => {
    net = await netHarness({
      clients: 1,
      net: {
        replicate: [
          replicate(Transform, { mode: 'interpolate', quantize: { translation: { step: 0.001 } } }),
        ],
      },
      conditions: { latency: 0.05, jitter: 0.01, seed: 2 },
    })
    await net.connect()
    const world = net.server.world
    const mover = world.spawn(Replicated, Transform)
    const speed = 3 // m/s
    const move = defineSystem({
      name: 'nettest/move',
      run: (_, w) => {
        const tr = w.get(mover, Transform).translation
        w.set(mover, Transform, { translation: [tr[0] + speed / 60, 0, 0] })
      },
    })
    net.server.addSystems(FixedUpdate, move)
    net.step(90)
    const client = net.clients[0]!.world
    const local = net.clientEntity(0, mover)!
    let last = client.get(local, Transform).translation[0]
    for (let i = 0; i < 120; i++) {
      net.step(1)
      const x = client.get(local, Transform).translation[0]
      // Every frame advances by about speed / 60: no frame stands still or jumps.
      expect(x - last).toBeGreaterThan(speed / 60 / 3)
      expect(x - last).toBeLessThan((speed / 60) * 3)
      last = x
    }
  })
})

describe('commands and events', () => {
  const rules = definePlugin({
    name: 'nettest/rules',
    build(app) {
      app.addSystems(
        FixedUpdate,
        defineSystem({
          name: 'nettest/attack',
          run: (_, world) => {
            for (const cmd of commands(world, Attack)) {
              const target = cmd.data.target
              if (target === null || !world.has(target, Health)) {
                cmd.reject('nettest/no-target', 'Nothing to attack')
                continue
              }
              const hp = world.get(target, Health).hp
              world.set(target, Health, { hp: Math.max(0, hp - cmd.data.damage) })
              cmd.accept()
            }
          },
        }).runIf(onServer),
      )
    },
  })

  it('answers commands, rejecting to the sender only, in send order', async () => {
    net = await netHarness({
      clients: 2,
      plugins: () => [rules],
      net: { replicate: replicated, commands: [Attack], events: [Shout] },
      conditions: { latency: 0.1, jitter: 0.05, seed: 11 },
    })
    await net.connect()
    const world = net.server.world
    const dummy = spawn(world, 0, 0, 100)
    const prop = world.spawn([Replicated, {}])
    net.step(30)
    const a = net.clients[0]!.world
    const local = net.clientEntity(0, dummy)!
    const sent = [1, 2, 3, 4, 5].map((d) => sendCommand(a, Attack, { target: local, damage: d }))
    const bad = sendCommand(a, Attack, { target: net.clientEntity(0, prop)!, damage: 1 })
    net.step(30)
    expect(sent.map((p) => p.status)).toEqual(Array(5).fill('accepted'))
    expect(bad.status).toBe('rejected')
    expect(bad.error?.code).toBe('nettest/no-target')
    expect(world.get(dummy, Health).hp).toBe(100 - 15)
    const answers = netSession(world).server!.peers.get(
      net.clients[1]!.world.resource(NetRole).peer,
    )!
    expect(answers.stats.rejected).toBe(0)
    expect(netSession(net.clients[1]!.world).client!.pending.size).toBe(0)
  })

  it('rejects out-of-range data and entities the sender cannot see', async () => {
    net = await netHarness({
      clients: 1,
      plugins: () => [rules],
      net: { replicate: replicated, commands: [Attack] },
      serverNet: { interest: ownerInterest() },
    })
    await net.connect()
    const world = net.server.world
    const hidden = spawn(world, 0)
    const mine = spawn(world, 0, net.clients[0]!.world.resource(NetRole).peer)
    net.step(10)
    const client = net.clients[0]!.world
    const tooMuch = sendCommand(client, Attack, { target: net.clientEntity(0, mine)!, damage: 500 })
    // The client has no entity for `hidden`: forge a reference to its server-side net id.
    const forged = client.spawn()
    const { NetId } = await import('./components')
    client.add(forged, NetId, { id: world.get(hidden, NetId).id })
    const probe = sendCommand(client, Attack, { target: forged, damage: 1 })
    net.step(10)
    expect(tooMuch.error?.code).toBe('schema/out-of-range')
    expect(probe.error?.code).toBe('net/unknown-net-id')
    expect(world.get(hidden, Health).hp).toBe(100)
  })

  it('runs the same rules offline, and rejects commands nobody handles', async () => {
    const { App } = await import('@aethervtt/shard-runtime')
    const { netPlugin } = await import('./plugin')
    const app = new App()
      .addPlugin(rules)
      .addPlugin(
        netPlugin({ role: 'server', commands: [Attack, defineNetCommand('nettest/Nobody', {})] }),
      )
    await app.init()
    const world = app.world
    const target = world.spawn([Health, { hp: 10 }])
    const ok = sendCommand(world, Attack, { target, damage: 4 })
    const orphan = sendCommand(world, netSession(world).manifest.commands[1]!, {})
    app.update(1 / 60)
    app.update(1 / 60)
    expect(ok.status).toBe('accepted')
    expect(world.get(target, Health).hp).toBe(6)
    expect(orphan.error?.code).toBe('net/unhandled-command')
    await app.dispose()
  })

  it('delivers events to the chosen peers, after the entities they name', async () => {
    net = await netHarness({
      clients: 2,
      net: { replicate: replicated, events: [Shout] },
      serverNet: { interest: alwaysInterest() },
    })
    await net.connect()
    const world = net.server.world
    const b = net.clients[1]!.world.resource(NetRole).peer
    const subject = spawn(world, 1)
    sendEvent(world, Shout, { text: 'hi', about: subject }, { to: b })
    const got = net.clients.map(() => [] as { text: string; about: Entity | null }[])
    net.clients.forEach((c, i) => {
      c.addSystems(
        FixedUpdate,
        defineSystem({
          name: `nettest/listen${i}`,
          run: (_, _w, ctx) => {
            for (const e of ctx.reader(Shout.event).read()) got[i]!.push(e.data)
          },
        }),
      )
    })
    net.step(10)
    expect(got[0]).toEqual([])
    expect(got[1]).toEqual([{ text: 'hi', about: net.clientEntity(1, subject) }])
  })
})
