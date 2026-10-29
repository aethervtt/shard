# 0089 — Net commands, events, and hidden information

- **Status:** accepted (built, except the dice criterion's test)
- **Packages:** `@aethervtt/shard-net`, `@aethervtt/shard-cards`, `@aethervtt/shard-dice`
- **Depends on:** 0054, 0076, 0086, 0087

## Context

A card game doesn't stream positions. Its state changes in discrete, validated steps: a player
asks to play a card, the server checks the rules (is it their turn, can they pay for it, is the
target legal), applies it or refuses, and tells each player what they may know. The opponent
learns that a card was played; only its owner knew what it was before. The server shuffles and
rolls, and nobody else can predict the result.

0087 replicates state, and 0088 sends input every tick. Neither fits "a player asked for one
thing". This spec adds commands (client to server, validated, answered) and events (server to
chosen clients). With 0087's redaction, they cover hidden information, and they also serve real-
time games for anything discrete: buying an item, chatting, using an ability.

0076 leaves rules and secrecy to the host. Aether's server keeps them, and integrates through
these commands and events plus `mirror`. A Shard server can now do the same itself.

## Goals

- `defineNetCommand`: schema'd requests from a client, validated by server systems, answered with
  accepted or rejected (a `ShardError`).
- `defineNetEvent`: schema'd messages from the server to all clients, one client, or a filter.
- Ordering: commands from one client are handled in the order sent; events to one client arrive
  in the order sent, interleaved correctly with 0087's state.
- Hidden information: secret state stays on the server, and clients receive only what they may see.
- The server owns randomness: shuffles and rolls happen there; clients see results, not seeds.
- Dice: the server rolls, every client lands the same throw on the server's values.

## Non-goals

- A rules engine for card games. Games write rules as server systems.
- Optimistic application of commands on the client. A game can predict locally and roll back on
  rejection, but this spec doesn't automate it.
- Cryptographic fairness (commit-reveal shuffles between distrusting peers). With a trusted server
  it isn't needed; P2P games that need it get a later spec.
- Persisting the command log. A game can record it; this spec only orders it.

## Design

### Commands

```ts
const PlayCard = defineNetCommand('duel/PlayCard', {
  card: t.entity(), target: t.entity(), zone: t.enum(['field', 'spell'] as const),
})

// client
const pending = sendCommand(world, PlayCard, { card, target, zone: 'field' })
pending.status          // 'pending' | 'accepted' | 'rejected'
pending.error           // the ShardError when rejected

// server, a system in FixedUpdate
for (const cmd of commands(world, PlayCard)) {
  if (!isTurnOf(world, cmd.peer)) { cmd.reject('duel/not-your-turn', 'Wait for your turn'); continue }
  applyPlay(world, cmd.peer, cmd.data)
  cmd.accept()
}
```

- Commands go on the reliable channel with a per-peer sequence number. The server decodes and
  validates them against their schema in `First`; an invalid one is rejected with the schema's
  `ShardError` before any game system sees it.
- `commands(world, def)` returns the unanswered commands in arrival order, with `peer` set. One
  still unanswered in `Last` after a FixedUpdate ran since it arrived is rejected with
  `net/unhandled-command`, so a client never waits forever.
- Entity fields arrive as entities through 0087's net ids. A command naming an entity the peer
  can't see is rejected with `net/unknown-net-id`: a client can't probe for hidden entities.
- The answer goes back reliably in the next send, after that send's spawns. Clients poll
  `pending.status`; answer events for systems are not built yet.
- Rate limit per peer (`commandsPerSecond`, default 30). Over it: `net/command-rate`.
- On a client in `host` or `server` role (or with no network), `sendCommand` delivers locally
  through the same path, so single-player and multiplayer run the same rules code.

### Events

```ts
const CardRevealed = defineNetEvent('duel/CardRevealed', { card: t.entity(), definition: t.string() })
sendEvent(world, CardRevealed, data, { to: 'all' })              // or a peer id, or (peer) => bool
for (const e of netEvents(world, CardRevealed)) { … }             // client
```

- Events are reliable and ordered per client, and stamped with the server tick. They're written
  after the spawns of the same send, so an event never names an entity the client hasn't spawned.
  An entity the recipient can't have arrives as null.
- `to` takes a peer, `all`, or a predicate over peers, evaluated at send.
- Each net event has a core event (`def.event`): clients and the server's own world read it with
  `ctx.reader(def.event)`, so single-player code reads the same stream.

### Hidden information

Secret state never leaves the server, so a client can't read it from memory. Two tools combine:

- **Redaction (0087).** A component with `visibleTo` goes only to the clients it returns true for.
  For cards: `CardFace { definition }` replicates with `visibleTo: (w, peer, card) => ownerOf(card)
  === peer || isFaceUp(card)`. Everyone else gets the card entity (position, zone, back art)
  without its face.
- **Server-only components.** A component not in the registry never replicates. A deck's order
  lives in a server-only component; clients see a zone of the right length whose entries carry
  placeholder ids.

`CardCollection` (0076) is a plain object, not a component, so `@aethervtt/shard-cards` gets a
small adapter:

- `netCardsPlugin({ zones, visibleTo })` (`@aethervtt/shard-cards/net`, no renderer imports) keeps
  the server's collections authoritative and sends each peer its own view of every zone whose
  version changed, as a `cards/ZoneView` net event (list `ZoneView` in `netPlugin({ events })`).
  On the client the `NetCardZones` resource keeps a `CardCollection` per zone in sync, bumping its
  `version` so the presentation updates as it does today.
- Entries a peer may not see are sent as `{ instanceId: <placeholder>, definition: 'cards/hidden',
  faceDown: true }`. The host draws `cards/hidden` as the back. Placeholder ids are random per
  peer and per reveal, so a client can't follow a hidden card through a shuffle.
- When a card becomes visible to a peer (drawn, revealed), the view lists the placeholder it
  replaces, and the client sends `CardRevealed { zone, placeholder, instanceId }` so the
  presentation layer (0076) can flip the card it already shows.
- Presentation stays the host's choice: `faceDown` on the client is drawn as before.

### Randomness

- Shuffles and rolls run on the server, from `GlobalRng` streams (`rng.stream('duel/shuffle')`),
  so a server run is reproducible from its seed for tests and replays. Seeds are never sent.
- `CardCollection.shuffle(seed)` keeps its signature; the server calls it with a draw from its
  stream, and clients receive only placeholders.
- **Dice.** The server picks values and a track seed, then sends a game-defined `DiceRolled
  { roll, values }` net event. Every client records the same track (0054's inputs plus the
  server's seed and a fixed tray) and lands it on the server's values. This needs no new code:
  0054 already lands any track on supplied values, and its tracks are deterministic.

### Agent surface

- `net.commands`: recent commands per peer with status, error code, and tick.
- `net.events`: recent events with recipients.
- Tests send commands as a given peer with `sendCommand(net.clients[1].world, …)`.
- Errors: `net/unhandled-command`, `net/unknown-command`, `net/unknown-event`, `net/command-rate`,
  `net/unknown-net-id`, `net/not-connected`, `net/not-authority`, `net/peer-left`, plus the
  game's own codes.

## Decisions

- **Commands are answered.** A move that silently does nothing is a bug report; a named rejection
  is a UI message.
- **Events are delivered with their tick's state.** Otherwise "card revealed" can arrive before the
  card exists on the client.
- **Placeholders are random per peer.** Stable ids for hidden cards leak which card is which after
  a shuffle.
- **Same path offline.** Rules code runs as server systems in single-player too, so there's one
  rules implementation.

## Acceptance criteria

Checked by `packages/net/src/net.test.ts` and `packages/cards/src/net.test.ts`.

- [x] A command rejected by a server system reaches only its sender, with the game's error code,
      and the server's state is unchanged.
- [x] Commands from one client are handled in send order at 100 ms ± 50 ms jitter.
- [x] An event sent with `to: peer` is never in another client's decoded traffic.
- [x] A test game with two hands of 7 cards and a 40-card deck: neither client's decoded traffic
      ever contains a definition from the other's hand or from the deck, over 50 turns.
- [x] After a shuffle, the placeholder ids a client sees share nothing with the ones before it.
- [x] A command naming an entity the sender can't see is rejected with `net/unknown-net-id`.
- [ ] Two clients shown the same `DiceRolled` event record identical tracks and land on the
      server's values. (No code needed, see *Dice*; a test through `netHarness` is still owed.)
- [x] The same rules systems pass the same gameplay test in single-player and in `netHarness`.

## Open questions

- Should rejected commands also carry a state hint (the server's view of the relevant entity) so
  an optimistic client can repair itself? Wait for a game that predicts commands.
- Spectators: a peer with no hand sees every hand in some games and none in others. Proposed:
  `visibleTo` decides, with a `Spectator` component on the peer's focus entity.
