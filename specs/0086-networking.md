# 0086 — Networking foundations (transports, sessions, roles, ticks)

- **Status:** accepted (built; hosting in 0091)
- **Packages:** `@aethervtt/shard-net` (new), `@aethervtt/shard-net-websocket` (new),
  `@aethervtt/shard-runtime`
- **Depends on:** 0002, 0003, 0008, 0011

## Context

Shard has no networking. The games it should support need very different multiplayer models: a
card game needs validated moves and hidden hands, an MMO needs thousands of entities filtered per
player, an FPS needs prediction and lag compensation, and co-op wants one player to host without a
server. Building one model per game type would give four networking stacks. Building one fixed
model would fit none of them.

This spec is the shared base. It defines the layers, the interfaces each one is swapped behind, and
the runtime pieces every sync model needs: connections, roles, a tick clock, and a test harness.
The sync models build on it: replication (0087), prediction and reconciliation (0088), commands
and hidden information (0089). Later specs add lockstep and rollback, WebRTC, line-of-sight
interest, and zone sharding.

The authority is always a Shard app running the game's own scripts: a dedicated server on Node,
or the host player's machine. Third-party services (Colyseus, Nakama, Steam, PlayFab) sit
underneath that as transports, relays, or lobbies. A host whose server isn't Shard, such as
Aether, keeps using `mirror` (0055) and 0089's commands and events.

## Goals

- Four layers, each behind an interface: transport (bytes), session (lobbies, matchmaking,
  signaling), role (who is authoritative), sync model (what is sent).
- A transport interface with reliable and unreliable channels, and a capability flag when a
  transport has only reliable delivery.
- A conditions wrapper that adds seeded latency, jitter, loss and duplication to any transport.
- Roles: `server`, `client`, `host`. Game scripts are shared; systems are gated by run conditions.
- An integer fixed tick, a fixed-rate multiplier, and a clock estimate (offset, RTT, jitter) per
  connection.
- A handshake that rejects a client whose schemas differ from the server's.
- `netHarness`: a server and N clients in one process, over a conditioned loopback, stepped
  deterministically (`@aethervtt/shard-net/testing`).
- Transports: loopback (in `net`) and WebSocket (browser client, Node server).

## Non-goals

- A documented wire format for servers not written with Shard. The format is versioned and derived
  from schemas, so a later spec can freeze it. Not now.
- WebRTC, WebTransport, Steam sockets. They implement this spec's interface in later packages.
- Lobby implementations beyond direct URLs. Only the interface is defined here.
- Authentication and encryption beyond what the transport provides (TLS for `wss://`). The
  handshake carries an opaque token the game checks.
- Lockstep and rollback. They reuse 0088's input pipeline and need a world snapshot spec.
- A dedicated-server CLI command and server exports. They follow once a game runs on 0087.

## Design

### Layers

```
 game scripts      shared by every role; systems gated by onServer / onClient / hasAuthority
 sync models       commands+events (0089) │ replication (0087) │ prediction (0088) │ lockstep (later)
 net core          connections, channels, handshake, ticks, clock, peers         (this spec)
 session           direct URL │ lobby providers (Colyseus, Nakama, Steam, …)       (interface here)
 transport         loopback(+conditions) │ WebSocket │ WebRTC, WebTransport (later)
```

### Transport

```ts
type Channel = 'reliable' | 'unreliable'
type PeerId = number                       // assigned by the listener, unique per listener

interface NetTransport {
  readonly name: string
  readonly caps: { unreliable: boolean; maxMessage: number }
  connect(address: string, options?: { token?: string }): Promise<NetConnection>
  listen?(options: { address?: string; maxPeers?: number }): Promise<NetListener>
}
interface NetListener {
  onConnection(fn: (connection: NetConnection) => void): () => void
  close(): Promise<void>
}
interface NetConnection {
  readonly peer: PeerId
  send(channel: Channel, bytes: Uint8Array): void   // the transport copies or transfers; caller reuses
  onMessage(fn: (channel: Channel, bytes: Uint8Array) => void): () => void
  onClose(fn: (reason: ShardError | undefined) => void): () => void
  close(reason?: string): void
  stats(): ConnectionStats                          // rtt, sentBytes, receivedBytes, lost
  pump?(): void                                     // deliver what's due; sockets leave it out
}
```

- Without `caps.unreliable`, `send('unreliable', …)` goes reliable. Every sync model works on
  either (0087's deltas are acked, 0088's inputs are sent redundantly).
- `send` above `caps.maxMessage` throws `net/message-too-large`. Splitting large messages is the
  net core's job (reliable channel only), not the transport's.
- Incoming messages are queued by the net core and drained once per frame in `First`
  (`net/receive`), after `pump()`. Nothing touches the world from a socket callback. The server
  subscribes to a connection the moment it arrives, so a hello sent at once isn't lost.
- Transports take host APIs as constructor arguments, the way `terrainPlugin({ workers })` does.
  `net` itself uses no host API: the loopback is plain queues on the app clock.

**Loopback.** `loopback()` returns a transport pair keyed by address, so a server App and client
Apps in one process can connect. Delivery happens at the receiving app's next drain.

**Conditions.**

```ts
simulateConditions(transport, {
  latency: 0.08, jitter: 0.02, loss: 0.05, duplicate: 0, reorder: true,
  seed: 1, now: () => clock,                       // the app clock; tests pass a fake one
})
```

It wraps any transport. Loss and duplication apply only to `unreliable`. `reliable` keeps its
order and gets the latency. The protocol method `net.conditions` changes the values at runtime.

**WebSocket.** `@aethervtt/shard-net-websocket` exports `webSocketTransport()` for clients (the global
`WebSocket`, present in browsers and Node 22+) and, from `./server`, `webSocketServer({ port })` on
Node through `ws` (already a CLI dependency). Each binary frame starts with a channel byte;
`caps.unreliable` is false. Port 0 picks a free port, read back from the listener's `port`.

### Sessions

```ts
interface NetSessionProvider {
  readonly name: string
  host(options: HostOptions): Promise<{ code: string; listener: NetListener }>
  join(code: string, options?: { token?: string }): Promise<NetConnection>
  list?(filter?: JsonObject): Promise<readonly SessionInfo[]>
}
```

A provider hides how peers find each other: a URL, a room code, a relay, or WebRTC signaling.
`directSession(transport)` treats the code as an address. Others are packages that depend on
`net`, never the reverse.

### Roles

```ts
netPlugin({
  role: 'server' | 'client',             // hosting: startHost() (0091)
  transport, address,                    // or: session + code
  tickRate: 30,                          // network ticks per second; must divide fixedHz
  maxPeers: 64, token,
  replicate: [...], interest: ..., budget: { bytesPerTick },   // 0087
  commands: [...], events: [...],        // 0089: listed on both sides, like replicate
  accept: (peer, token, world) => error | undefined,
  spawnPrefab: (world, prefab) => entity, // client: how a replicated prefab spawns
})
```

A server with no transport runs locally: single-player games use the same commands and rules.

- **server.** Listens, owns every replicated entity unless it grants ownership (0087), runs every
  system. It can run headless on Node with no GPU.
- **client.** Connects, applies what the server sends, runs the systems it's allowed to: rendering,
  audio, input, interpolation, prediction.
- **host** (listen server, P2P co-op): not a role but `startHost()` (0091). It runs a server App
  next to the player's client App, connected by loopback. The host player is an ordinary client of
  its own server, so a host takes the same code path as a dedicated server. Remote players reach
  it through a session provider (WebRTC lobby, 0091).
- Run conditions: `onServer`, `onClient`, `connected`, and `hasAuthority(world, entity)` (the
  server always; a client for what it owns). A system without one runs in every role.
  `NetSystems.send` orders game systems that must run before a send.
- `NetRole` resource: `{ role, peer, connected, tick }`. `Peers` resource on the server: peer id →
  `{ state, rtt, user, joinedTick }`.

### Ticks and clock

- `FixedTime.tick` (runtime): an integer that counts FixedUpdate runs, starting at 0; a FixedUpdate
  system sees the index of the step running. Wire messages carry ticks, never seconds.
- `FixedTime.rate` (runtime, default 1): multiplies fixed-step accumulation. 0088 adjusts it within
  ±5% so a client stays the right number of ticks ahead of the server, without jumps.
- A network tick is every `fixedHz / tickRate` fixed ticks: 60 Hz simulation, 30 Hz sends.
  `net/send` runs in `Last` and sends when a network tick passed during the frame.
- Clock: the client sends pings with its tick and time on the unreliable channel every 0.5 s. The
  server echoes its tick. The client keeps the median offset of the last 16 samples and an RTT
  estimate with jitter. `NetClock` resource: `{ serverTick, offsetTicks, rtt, jitter }`.

### Handshake

1. Client sends `hello { protocol, schemaHash, token, types }` (`types`: its manifest lines, so the
   server can name what differs).
2. Server checks `protocol` and `schemaHash`, then calls the game's `accept(peer, token)` hook,
   which may refuse with a `ShardError`. It may be async, and returns the peer's account data;
   player load/save hooks run around it (0090).
3. Server replies `welcome { peer, tick, tickRate, components }` or `refused { error }`.

`schemaHash` covers each replicated component, command, event and input: name, version, and field
layout (kind, storage, stride, quantization). A difference refuses the client with
`net/schema-mismatch`, naming the first differing type. Both sides then number types by sorted name,
so the wire carries a `u16` instead of a name.

### Messages

Every message is binary: `u8 kind`, `u32 tick`, then a body (0087's codec). Kinds in this spec:
`hello`, `welcome`, `refused`, `ping`, `pong`, `disconnect`, `fragment`. 0087 to 0089 add theirs.
Unknown kinds are a protocol error and close the connection with `net/bad-message`.

### Harness

```ts
const net = await netHarness({
  plugins: [gamePlugin()], clients: 2,
  conditions: { latency: 0.1, jitter: 0.02, loss: 0.05, seed: 7 },
})
net.step(120)                         // every app advances 120 fixed ticks, on one fake clock
net.server.world; net.clients[0]!.world
net.setConditions(1, { loss: 0.3 })  // per client
net.converged(Health, Transform)     // replicated values equal on every client, within quantization
```

It builds bare `App`s with an injected clock and seed, and steps the server before the clients.
It lives in `@aethervtt/shard-net/testing` (net's own tests use it, and `@aethervtt/shard-testing`
would make a cycle). Also: `addClient()` for late joins, `differences(...)` to see what didn't
converge, `clientEntity(client, serverEntity)`.

### Agent surface

- Protocol methods: `net.describe` (role, peer, tick, clock, transport caps, types, last error),
  `net.peers`, `net.conditions` (read and set simulated conditions), `net.disconnect(peer)`.
- Events instead of a `subscribe` topic: `PeerJoined`/`PeerLeft` (server), `Connected`/
  `Disconnected` (client, with the refusal's code).
- Errors: `net/schema-mismatch`, `net/full`, `net/transport-closed`, `net/message-too-large`,
  `net/bad-message`, `net/tick-rate` (tickRate doesn't divide fixedHz), `net/connect-failed`,
  `net/cannot-listen`, `net/no-session`, `net/no-conditions`.

## Decisions

- **The authority is always Shard.** Prediction (0088) needs the server to run the client's
  simulation code. External servers integrate as sessions or through commands and `mirror`.
- **Host runs the server next to the client.** One code path for dedicated and hosted games, at
  the cost of a second world on the host, which co-op sizes afford. 0091 runs it on the main
  thread (WebRTC lives there in Chrome); a worker is deferred.
- **Ticks on the wire, not seconds.** Integer ticks compare exactly, index history buffers, and
  don't drift.
- **Transports never touch the world.** Drained once per frame, like input, so systems see a
  stable world and tests are deterministic.
- **Schema hash, then numeric ids.** Mismatched builds fail at connect time with a named type,
  not as garbage values later.

## Acceptance criteria

Checked by `packages/net/src/net.test.ts`, `packages/net-websocket/src/websocket.test.ts` and
`packages/runtime/src/app.test.ts`.

- [x] `netHarness` with 2 clients connects, completes the handshake, and reports `connected` on
      every client within 10 ticks at zero latency.
- [x] A client whose replicated component layout differs is refused with `net/schema-mismatch`
      naming the component.
- [x] Under `latency: 0.1, jitter: 0.02`, `NetClock.rtt` after 3 s is 200 ms plus mean jitter
      (20 ms), within three frames: each side reads messages once per frame, so the harness
      measures the frame waits too.
- [x] `simulateConditions` with the same seed delivers the same messages in the same order on two
      runs; `loss: 1` drops every unreliable message and no reliable one.
- [x] `FixedTime.tick` counts FixedUpdate runs; `rate: 1.05` runs 63 ticks over 60 frames of
      1/60 s at 60 Hz.
- [x] A reliable message larger than `maxMessage` arrives whole, split into fragments.
- [x] The WebSocket transport connects, replicates and fragments with a Node server and the
      global-WebSocket client, and a refused connection fails with `net/connect-failed`.
- [x] `net` uses no host API (its tsconfig has the DOM lib only because runtime's types need it),
      and nothing registers on import.
- [x] Hosting: `startHost()`, see 0091.

## Open questions

- Host in a worker: deferred (0091), since WebRTC objects live on the main thread in Chrome.
- Reconnection: a reconnect is a new join (decided); 0087's late-join path brings it up to date.
