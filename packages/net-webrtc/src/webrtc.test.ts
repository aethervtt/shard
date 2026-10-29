import { defineComponent, defineSystem, t, Update } from '@aethervtt/shard-core'
import {
  Disconnected,
  type Host,
  NetRole,
  type NetSessionProvider,
  netPlugin,
  netSession,
  Replicated,
  replicate,
  startHost,
} from '@aethervtt/shard-net'
import { App, intervalRunner } from '@aethervtt/shard-runtime'
import { RTCPeerConnection as NodePeer } from 'node-datachannel/polyfill'
import { afterEach, describe, expect, it } from 'vitest'
import { webRtcLobby } from '.'
import type { WebRtcConnection } from './connection'
import { type LobbyServer, lobbyServer } from './server'

const Score = defineComponent('rtctest/Score', { points: t.u32() })
const shared = { replicate: [replicate(Score)] }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function lobby(): Promise<{ server: LobbyServer; session: () => NetSessionProvider }> {
  const server = await lobbyServer()
  cleanups.push(() => server.close())
  const session = () =>
    webRtcLobby({
      url: `ws://127.0.0.1:${server.port}`,
      RTCPeerConnection: NodePeer as unknown as typeof RTCPeerConnection,
    })
  return { server, session }
}

async function until(done: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('webRtcLobby', () => {
  it('connects two peers over real WebRTC, with both channels', async () => {
    const { session } = await lobby()
    const { code, listener } = await session().host({})
    cleanups.push(() => listener.close())
    const accepted: WebRtcConnection[] = []
    listener.onConnection((c) => accepted.push(c as WebRtcConnection))
    const joiner = (await session().join(code)) as WebRtcConnection
    cleanups.push(() => joiner.close())
    await until(() => accepted.length === 1)
    const host = accepted[0]!

    const got: string[] = []
    host.onMessage((channel, bytes) => got.push(`${channel}:${bytes[0]}`))
    joiner.send('reliable', new Uint8Array([1]))
    joiner.send('unreliable', new Uint8Array([2]))
    const back: string[] = []
    joiner.onMessage((channel, bytes) => back.push(`${channel}:${bytes[0]}`))
    host.send('reliable', new Uint8Array([3]))
    await until(() => got.length === 2 && back.length === 1)
    expect(got.sort()).toEqual(['reliable:1', 'unreliable:2'])
    expect(back).toEqual(['reliable:3'])

    const channels = (joiner as unknown as { channels: RTCDataChannel[] }).channels
    expect(channels[0]!.ordered).toBe(true)
    expect(channels[1]!.ordered).toBe(false)
    expect(channels[1]!.maxRetransmits).toBe(0)
  })

  it('lists rooms, and refuses unknown codes and full rooms', async () => {
    const { session } = await lobby()
    const { code, listener } = await session().host({ meta: { name: 'Friday co-op' }, maxPeers: 1 })
    cleanups.push(() => listener.close())
    await expect(session().join('NOPE42')).rejects.toMatchObject({ code: 'net/room-not-found' })
    const first = await session().join(code)
    cleanups.push(() => first.close())
    await expect(session().join(code)).rejects.toMatchObject({ code: 'net/room-full' })
    const rooms = await session().list!()
    expect(rooms).toEqual([{ code, meta: { name: 'Friday co-op' }, peers: 1, maxPeers: 1 }])
  })
})

describe('startHost', () => {
  it('admits the local player over loopback and a remote one over WebRTC, then saves them on stop', async () => {
    const { session } = await lobby()
    const saved: number[] = []
    const host: Host = await startHost({
      net: {
        ...shared,
        meta: { name: 'test' },
        players: {
          spawn: (world, { peer }) =>
            void world.spawn([Replicated, { owner: peer }], [Score, { points: peer * 10 }]),
          capture: (world, { owned }) => world.get(owned[0]!, Score).points,
          store: ({ data }) => void saved.push(data as number),
        },
      },
      session: session(),
    })
    let stopped = false
    cleanups.push(() => (stopped ? undefined : host.stop()))
    expect(host.code).toMatch(/^[A-Z2-9]{6}$/)

    const client = async (options: Parameters<typeof netPlugin>[0]) => {
      const app = new App()
      app.addPlugin(netPlugin(options))
      app.setRunner(intervalRunner())
      await app.init()
      void app.run()
      cleanups.push(() => app.dispose())
      return app
    }
    const mine = await client({ ...shared, role: 'client', ...host.local })
    const friend = await client({ ...shared, role: 'client', session: session(), code: host.code })
    const disconnects: string[] = []
    friend.addSystems(
      Update,
      defineSystem({
        name: 'rtctest/disconnected',
        run: (_, _w, ctx) => {
          for (const e of ctx.reader(Disconnected).read()) disconnects.push(e.message)
        },
      }),
    )

    const points = (app: App) =>
      [...netSession(app.world).client!.byNetId.values()]
        .map((e) => app.world.tryGet(e, Score)?.points)
        .sort()
    await until(
      () =>
        mine.world.resource(NetRole).connected &&
        friend.world.resource(NetRole).connected &&
        points(mine).length === 2 &&
        points(friend).length === 2,
    )
    const peers = [mine, friend].map((a) => a.world.resource(NetRole).peer * 10).sort()
    expect(points(mine)).toEqual(peers)
    expect(points(friend)).toEqual(peers)

    stopped = true
    await host.stop()
    expect(saved.sort()).toEqual(peers)
    await until(() => !friend.world.resource(NetRole).connected)
    expect(disconnects).toEqual(['server stopped'])
  })
})
