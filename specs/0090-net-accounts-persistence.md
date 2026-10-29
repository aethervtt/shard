# 0090 — Net accounts and player persistence

- **Status:** accepted
- **Packages:** `@aethervtt/shard-net`
- **Depends on:** 0086, 0087

## Context

0086's handshake takes an opaque token and a synchronous `accept(peer, token)`. Real checks are
asynchronous: a call to an auth service, a database lookup, or a JWT verified with WebCrypto
(`crypto.subtle.verify` returns a promise). A synchronous hook forces a game to admit a player
first and check later, and in between the unverified player receives world state. It also leaves
nowhere to keep who the peer is: a peer id and a raw token aren't an account.

Persistent games then repeat the same steps: load a character when a player joins, spawn it, and
save it when they leave or the server stops. Each step crosses between async storage and the
synchronous world, which is easy to get wrong (reading the world after an `await`, saving after
the entities are gone, losing saves at shutdown).

## Goals

- `accept` may be async, and returns the peer's account data (`user`) or a refusal.
- A peer receives nothing, and appears in `Peers`, only once it is accepted and its player loaded.
- `user` is on the peer's entry, in `PeerJoined`/`PeerLeft`, and in `net.peers`.
- Player hooks that split async storage from world access: load → spawn on join,
  capture → store on leave, and a save on demand for autosaves.
- No save lost at shutdown: disposing the server saves every connected player and waits.

## Non-goals

- An account system, sessions, or a database. Games bring their own; the hooks call it.
- Reconnecting into the same character within a grace period (0086: a reconnect is a new join).
  A game can keep characters with `despawn: false` and reattach them in `spawn`.
- Saving the shared world (0038 does that); these hooks are per player.

## Design

```ts
netPlugin({
  role: 'server', transport,
  // Async allowed. Return { user } to admit, a ShardError to refuse. Throwing refuses too.
  async accept(peer, token, world) {
    const claims = await verifyJwt(token)            // the game's own check
    return claims ? { user: { account: claims.sub, name: claims.name } } : new ShardError('game/bad-token', 'Log in again')
  },
  joinTimeout: 15,                                    // seconds for accept + load, then net/join-timeout
  players: {
    load: ({ peer, user }) => db.characters.get(user.account),          // async; no world
    spawn(world, { peer, user, data }) {                                // sync, in net/receive
      world.spawn([Replicated, { owner: peer, prefab: 'prefabs/knight' }], [Transform, data.transform], [Health, data.health])
    },
    capture: (world, { owned }) => ({ health: world.get(owned[0]!, Health) }),  // sync; read the world
    store: ({ user, data }) => db.characters.put(user.account, data),   // async; no world
    despawn: true,                                                      // default
  },
})

await savePlayer(world, peer)      // capture now, store async: autosaves
await netSession(world).server!.flush()   // wait for every store in flight
```

### Join

1. `hello` passes the protocol, schema and capacity checks (0086).
2. The peer's state becomes `joining`. `accept` runs. A synchronous result is used at once; a
   promise is awaited. Then `players.load` runs, if given, with the `user`.
3. Results are queued and applied in the next `net/receive`, never from a promise callback: the
   world only changes inside a frame.
4. `players.spawn(world, …)` runs, then the server sends `welcome` and fires `PeerJoined { peer,
   user }`. The first state a client receives already contains its character.
5. A refusal, a throw, a rejected promise, or `joinTimeout` passing refuses the peer: the
   `ShardError` it gave, `net/accept-failed`, `net/load-failed`, `net/spawn-failed`, or
   `net/join-timeout`. A peer that disconnects while joining is dropped, and its late result
   ignored.
6. `maxPeers` counts joining peers too, so slow checks can't overfill the server.

Synchronous `accept` with no `load` admits in the same frame, as before.

### Leave

When a connected peer leaves (disconnects, is disconnected, or the server stops):

1. `owned` is every entity whose `Replicated.owner` is the peer.
2. `players.capture(world, { peer, user, owned })` reads what to save, synchronously.
3. Unless `despawn: false`, the owned entities are despawned.
4. `PeerLeft { peer, reason, user }` fires.
5. `players.store({ peer, user, data })` runs; the server tracks the promise. A rejection is
   logged and fires `PlayerSaveFailed { peer, user, code, message }` in the next frame.

`savePlayer(world, peer)` runs steps 2 and 5 for a connected peer, without despawning.
`server.flush()` resolves when every store has settled. Disposing the server (app dispose)
leaves every connected peer as above with reason `server stopped`, then awaits `flush()`.

### Agent surface

- `net.peers` lists `user` and `state` (`joining` or `connected`).
- Errors: `net/accept-failed`, `net/load-failed`, `net/spawn-failed`, `net/join-timeout`,
  `net/save-failed` (in `PlayerSaveFailed`), `net/not-connected` (`savePlayer` for an unknown peer).

## Decisions

- **Async hooks never touch the world.** Load and store get data, not the world; spawn and capture
  get the world but are synchronous. It makes the "read after await" mistake impossible.
- **Welcome after spawn.** A client never sees a world without its own character in it.
- **Store after despawn is safe.** Capture has already read everything, so despawning at once
  doesn't race the save.

## Acceptance criteria

Checked by `packages/net/src/accounts.test.ts`.

- [x] An async `accept` that resolves after 200 ms admits the peer; until then the peer is in no
      `Peers` entry and receives no state.
- [x] An async refusal, a throw, and a timeout refuse the client with the right code.
- [x] `user` from `accept` reaches `load`, `spawn`, `PeerJoined`, `Peers` and `PeerLeft`.
- [x] The client's first replicated entities include the character `spawn` created.
- [x] On leave, `capture` sees the owned entities before they're despawned, and `store` receives
      its result.
- [x] Disposing the server stores every connected player before the dispose resolves.
- [x] A failing `store` fires `PlayerSaveFailed` and logs, without stopping the server.
- [x] A peer that disconnects while `accept` is pending never spawns and never stores.
