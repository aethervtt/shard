# @aethervtt/shard-net

Multiplayer for [Shard](https://github.com/aethervtt/shard): state replication with per-player
interest and redaction, validated commands and events, accounts and player persistence, and
peer-to-peer hosting. The authority is always a Shard app running your game's systems. Transports
are separate packages:

- `@aethervtt/shard-net-websocket`: a browser/Node client and a Node server (`./server`).
- `@aethervtt/shard-net-webrtc`: peer-to-peer data channels, a lobby client, and a lobby server
  (`./server`).

Design: specs 0086–0092 in the repository.

## Shared definitions

```ts
import { defineComponent, t } from '@aethervtt/shard-core'
import { Transform } from '@aethervtt/shard-transform'
import { defineNetCommand, defineNetEvent, ownerOnly, replicate } from '@aethervtt/shard-net'

export const Health = defineComponent('game/Health', { hp: t.u16({ max: 1000 }) })
export const Gold = defineComponent('game/Gold', { amount: t.u32() })
export const Attack = defineNetCommand('game/Attack', { target: t.entity() })
export const Chat = defineNetEvent('game/Chat', { text: t.string() })

// Both sides pass the same lists; a mismatch is refused at connect (net/schema-mismatch).
export const net = {
  replicate: [
    replicate(Transform, { mode: 'interpolate', quantize: { translation: { step: 0.01 } } }),
    replicate(Health),
    replicate(Gold, { visibleTo: ownerOnly }),
  ],
  commands: [Attack],
  events: [Chat],
}
```

## Server (Node)

```ts
import { App, intervalRunner } from '@aethervtt/shard-runtime'
import { commands, netPlugin, Replicated } from '@aethervtt/shard-net'
import { webSocketServer } from '@aethervtt/shard-net-websocket/server'

const app = new App()
app.addPlugin(
  netPlugin({
    ...net,
    role: 'server',
    transport: webSocketServer({ port: 7000 }),
    async accept(peer, token) {
      return { user: await verify(token) } // or a ShardError to refuse
    },
    players: {
      spawn: (world, { peer }) => void world.spawn([Replicated, { owner: peer }], [Health, { hp: 100 }]),
      capture: (world, { owned }) => world.get(owned[0]!, Health),
      store: ({ user, data }) => db.save(user, data),
    },
  }),
)
// Game rules: systems gated with onServer read commands(world, Attack) and accept or reject them.
app.setRunner(intervalRunner())
await app.run()
```

## Client (browser)

```ts
import { netPlugin, sendCommand } from '@aethervtt/shard-net'
import { webSocketTransport } from '@aethervtt/shard-net-websocket'

app.addPlugin(
  netPlugin({ ...net, role: 'client', transport: webSocketTransport(), address: 'wss://game.example.com', token }),
)
const pending = sendCommand(app.world, Attack, { target }) // pending.status: accepted | rejected
```

## Peer to peer: a lobby, a host, and a room code

```ts
// Node: the lobby only introduces peers; game traffic goes peer to peer.
import { lobbyServer } from '@aethervtt/shard-net-webrtc/server'
await lobbyServer({ port: 7500, host: '0.0.0.0' })

// Browser, hosting: the game's server runs in this page; the host joins it over loopback.
import { startHost } from '@aethervtt/shard-net'
import { webRtcLobby } from '@aethervtt/shard-net-webrtc'
const session = webRtcLobby({ url: 'wss://lobby.example.com', iceServers: [{ urls: 'stun:…' }] })
const host = await startHost({ plugins: () => [game()], net, session })
clientApp.addPlugin(netPlugin({ ...net, role: 'client', ...host.local }))
show(host.code)

// Browser, joining with the code.
clientApp.addPlugin(netPlugin({ ...net, role: 'client', session, code }))
```

Peers on different networks need STUN servers in `iceServers`, and TURN behind strict NATs.

## Tests

`@aethervtt/shard-net/testing` runs a server and N clients in one process over a loopback with
seeded latency, jitter and loss: `netHarness({ clients, net, conditions })`, then `connect()`,
`run(ticks)`, and `differences(...components)` to check every client matches the server.
