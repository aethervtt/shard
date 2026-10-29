# 0091 — Peer-to-peer sessions (WebRTC, lobby, host mode)

- **Status:** accepted
- **Packages:** `@aethervtt/shard-net-webrtc` (new), `@aethervtt/shard-net`, `@aethervtt/shard-runtime`
- **Depends on:** 0086, 0087, 0090

## Context

0086 gives a dedicated server over WebSocket. Co-op games want one player to host from their own
browser, and friends to join with a room code: no server to rent or run. Browsers can't accept
incoming connections, so peers need WebRTC data channels, and WebRTC needs a signaling channel to
exchange offers and network candidates before the peers can talk. A lobby provides that channel and
the room code. Once connected, game traffic goes peer to peer; the lobby only introduces players.

WebRTC also gives browsers what WebSocket can't: a truly unreliable, unordered channel, so lost
state doesn't stall the updates behind it (0087).

## Goals

- A WebRTC transport: one reliable ordered channel and one unreliable unordered channel per peer,
  over the standard `RTCPeerConnection` (global in browsers, injected in Node).
- A lobby: room codes, listing, and signaling relay, as a `NetSessionProvider` (0086) over a
  WebSocket, with a small Node lobby server.
- Host mode: `startHost()` runs the game's server App next to the player's own client App, accepts
  remote players through the lobby, and lets the local player join over loopback.
- `intervalRunner`: runs an app on a timer instead of animation frames, for servers and hosts.
- All of it testable in Node over real WebRTC (`node-datachannel` as a dev dependency).

## Non-goals

- TURN relays and STUN servers: games pass `iceServers`. Without STUN, peers connect only on the
  same network; behind strict NATs they need TURN.
- Host migration when the host leaves. The session ends; a later spec can elect a new host.
- Running the host's server in a worker. Chrome doesn't expose `RTCPeerConnection` in workers, so
  the connections would stay on the main thread with a bridge to the worker. Deferred until a
  host's simulation cost needs it.
- Lobby accounts, matchmaking by skill, or persistence. The lobby is a room directory.

## Design

### Transport

```ts
const session = webRtcLobby({
  url: 'wss://lobby.example.com',
  iceServers: [{ urls: 'stun:stun.example.com:3478' }],
  RTCPeerConnection,                     // default: globalThis.RTCPeerConnection
  maxMessage: 64 * 1024,
})
```

- Each peer connection opens two negotiated data channels: `reliable` (id 0, ordered) and
  `unreliable` (id 1, `ordered: false, maxRetransmits: 0`). Negotiated ids mean neither side waits
  for `ondatachannel`. `caps.unreliable` is true.
- `maxMessage` defaults to 64 KiB. The net core fragments reliable messages above it and caps a
  state message at it (0087), so a tick's state beyond 64 KiB waits for the next tick.
- A connection closes when either channel closes or the peer connection fails. Closing it on
  purpose drains both channels first, so a goodbye message arrives before the close.

### Lobby protocol

JSON over WebSocket. `id`s are the lobby's numbers for its own sockets.

| From | Message | Then |
|---|---|---|
| host | `{ t: 'host', meta?, maxPeers? }` | `{ t: 'hosted', code }` |
| joiner | `{ t: 'join', code }` | host gets `{ t: 'joined', id }`; joiner `{ t: 'joining', id }` |
| either | `{ t: 'signal', to, data }` | the other gets `{ t: 'signal', from, data }` |
| anyone | `{ t: 'list' }` | `{ t: 'rooms', rooms: [{ code, meta, peers, maxPeers }] }` |
| lobby | `{ t: 'error', code, message }` | `net/room-not-found`, `net/room-full`, `net/bad-lobby-message` |
| lobby | `{ t: 'closed' }` | to joiners when the host leaves |

- Room codes are 6 characters from an alphabet without look-alikes (no `0/O`, `1/I/L`).
- The joiner makes the offer and the host answers; candidates trickle through `signal`. Each
  player keeps its lobby socket while connected, so the room's player count stays right; the host
  keeps its socket to take more players. The lobby tells the host `{ t: 'left', id }` when one goes.
- `lobbyServer({ port })` (`@aethervtt/shard-net-webrtc/server`, Node) runs the lobby; `shard lobby
  [--port 7500]` runs one from the CLI. It forwards signals only between a room's host and that
  room's joiners.

### Host mode

```ts
const host = await startHost({
  plugins: () => [gamePlugin()],                 // the server App's plugins
  net: { ...shared.net, accept, players, interest },
  session: webRtcLobby({ url, iceServers }),    // how remote players reach the host
  meta: { name: 'Friday co-op' },
})
host.code                                        // share it; friends join with it
clientApp.addPlugin(netPlugin({ ...shared.net, role: 'client', ...host.local }))
await host.stop()                                // saves players (0090), closes the room
```

- `startHost` builds a server App (or takes one from `createApp`: a project's headless build,
  0092), runs it with `intervalRunner`, and listens on the session
  and on a private loopback at once. The server numbers peers itself, since ids from different
  listeners would collide. `host.local` is the loopback `{ transport, address }` for the host
  player's client App.
- The host player is a client like any other, so the same rules, culling and redaction apply to
  them. They have no network latency.
- Remote players join with `webRtcLobby(...)` as their client `session` and the code:
  `netPlugin({ ...shared.net, role: 'client', session, code })`.
- A hidden tab throttles timers, so a host in a background tab simulates slowly. The worker
  non-goal above is the fix; until then, games tell the host to keep the tab visible.

### `intervalRunner`

`intervalRunner({ hz, maxDelta })` (runtime) updates the app on `setInterval` at `hz` (default the
app's `fixedHz`), passing the real elapsed time clamped to `maxDelta` (default 0.25 s). It stops
on `app.dispose()`. Dedicated servers use it too.

### Agent surface

- `net.describe` includes the session `code` on a server. `netPlugin({ meta })` is what the lobby
  lists for the room.
- Errors: `net/room-not-found`, `net/room-full`, `net/bad-lobby-message`, `net/lobby-closed`,
  `net/no-webrtc` (no `RTCPeerConnection`), `net/webrtc-failed`.

## Decisions

- **Standard `RTCPeerConnection`, injected.** The same code runs in browsers and in Node tests; no
  WebRTC library in the shipped package.
- **Negotiated channel ids.** Both sides create the same two channels, so connection setup has no
  ordering race.
- **Host on the main thread for now.** WebRTC objects live there in Chrome; a worker needs a bridge.
- **The lobby only introduces.** It never sees game traffic, so one small lobby serves many games.

## Acceptance criteria

Checked by `packages/net-webrtc/src/webrtc.test.ts` and `packages/runtime/src/runners.test.ts`.

- [x] Two Node peers connect through `lobbyServer` over real WebRTC, and messages flow on both
      channels; the unreliable channel is unordered with no retransmits.
- [x] A host started with `startHost` admits its local player over loopback and a remote player
      through the lobby, and both converge on replicated state.
- [x] Joining an unknown code fails with `net/room-not-found`; a full room with `net/room-full`.
- [x] `list` returns hosted rooms with their meta and player counts.
- [x] When the host stops, its players are saved (0090) and remote clients get `Disconnected`.
- [x] `intervalRunner` updates at about `hz` with real deltas and stops on dispose.
