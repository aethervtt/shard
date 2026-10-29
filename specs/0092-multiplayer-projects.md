# 0092 — Multiplayer projects (project net config, server and net runs, example)

- **Status:** accepted
- **Packages:** `@aethervtt/shard-project`, `@aethervtt/shard-node`, `@aethervtt/shard-net`, `apps/cli`,
  `examples/coin-rush` (new)
- **Depends on:** 0009, 0012, 0086, 0087, 0089, 0090

## Context

0086–0091 give engine packages for multiplayer, but a project made with `shard init` can't use them
without writing its own host: nothing runs a project as a server, `shard run` and `shard dev` know
only single player, and every headless path wants a GPU. An agent working on a multiplayer game
needs the same loop it has for single player: edit, run headless, check a hash, play in a browser.

## Goals

- A project declares its network setup once, in code, beside its components: `project.net({...})`.
- `buildApp({ display: false })`: no render, input, audio or UI plugins, and no GPU. Servers and
  headless clients use it.
- `shard server`: runs the project as a dedicated WebSocket server until stopped (players saved on
  stop, 0090).
- `shard run --net clients=N,latency=s,jitter=s,loss=p`: a server and N clients in one process over
  conditioned loopback, without a GPU; prints every world's hash and whether the clients converged.
- `shard dev --connect <url>`: the browser runner joins that server as a client.
- An example, `examples/coin-rush`, that uses all of it, with tests that run in `pnpm test`.

## Non-goals

- Exporting a server build (bundles, Docker). The export spec covers it.
- GPU-less single-player runs and screenshots: `shard run` without `--net` is unchanged.

## Design

### Project net config

```ts
const project = defineProject({ name: 'coin-rush', build(app) { … } })
export const Score = project.component('Score', { points: t.u32() })
export const Move = defineNetCommand('coin-rush/Move', { direction: t.vec2({ min: -1, max: 1 }) })

project.net({
  replicate: [replicate(Transform, { mode: 'interpolate' }), replicate(Score)],
  commands: [Move],
  players: { spawn(world, { peer }) { … } },
})
```

- `project.net(options)` records `NetOptions` without role or transport (`ProjectNetOptions`). It's
  a call, not a `defineProject` field, so it can name components defined after the project.
- `projectNet(plugin)` reads it back; hosts add `netPlugin({ ...projectNet(project), role, … })`.
- A project without `project.net` is single-player; `shard server` and `run --net` refuse it with
  `project/not-multiplayer`.
- Server-side game code runs in systems gated with `onServer`; it spawns the shared world itself.
  The server doesn't load the start scene: that is the client's presentation (a map, a camera).

### `buildApp({ display: false })`

Skips `render`, `render/forward`, material noise, `sprite`, `text`, `particles`, `animation`,
`dice`, `input`, `gestures`, `controls`, every `audio*` plugin, `ui`, `scatter` and `effects`.
Keeps transform, physics, navigation, terrain, noise, scenes, procgen, saves and glTF. Component
definitions of skipped plugins still exist (their modules are imported), so data naming them
loads; nothing draws or plays it.

`openProjectHeadless({ root, seed, code, extra })` (`@aethervtt/shard-node`) opens a project that
way: manifest, project code, asset scan, no GPU, no start scene; `extra(project)` adds plugins
(the net plugin) before init.

### `shard server`

```sh
shard server [--port 7000] [--json]   # {"url":"ws://127.0.0.1:7000","port":7000} on stdout
```

Opens the project headless with `netPlugin({ ...projectNet, role: 'server', transport:
webSocketServer({ port, host }) })`, runs it on `intervalRunner`, and on SIGINT/SIGTERM disposes it
(saving players) and exits 0. `--host 0.0.0.0` listens beyond localhost.

### `shard run --net`

```sh
shard run --net clients=2,latency=0.08,jitter=0.02,loss=0.05 --frames 600 --seed 7 --json
```

Builds a server and N client apps headless (`createApp` hook on `netHarness`), connects them,
steps `--frames` fixed frames on one fake clock, then lets 60 more settle. Result:
`{ frames, seed, server: { hash, entities }, clients: [{ peer, hash, entities }], converged,
differences }`. `converged` compares every replicated component the server has on what each
client may see (`netHarness.differences`), 60 frames after the run. A game still in motion
differs by the lag, so not converging is reported, not an error: the exit code is 0. Hashes are
reproducible for a seed.

### `shard dev --connect` and `--lobby`

`shard dev --connect ws://127.0.0.1:7000` passes `net: { url }` in the runner's project info; the
runner adds `netPlugin({ ...projectNet, role: 'client', transport: webSocketTransport(), address:
url })` before init. `?connect=<url>` on the page does the same, so several tabs can join.

Peer to peer (0091): `shard lobby` runs a lobby, and `shard dev --lobby ws://127.0.0.1:7500` (or
`?lobby=<url>`) lets a page host or join through it:

- `?host`: the page runs `startHost` with the project's headless build as the server, joins it over
  loopback, and shows the room code with a join link.
- `?join=<code>`: the page joins that room over WebRTC as a client.
- `?host` or `?join` without a lobby fails with `net/no-lobby`.

### Example: coin-rush

A top-down 2D game: each player is a square moved with WASD; coins appear on the server; touching
one scores it. It shows commands (`Move`), state replication with interpolation (`Transform`),
an always-visible scoreboard (`Score` on players, `alwaysInterest`), and player hooks (spawn on
join, despawn on leave). Clients draw replicated entities by adding sprites when they arrive.

### Agent surface

- `shard server`, `shard lobby`, `shard run --net`, `shard dev --connect`/`--lobby`, all with
  `--json` where they print a result.
- Errors: `project/not-multiplayer`, `net/no-lobby`, `cli/usage` for a bad `--net` spec.

## Decisions

- **Config in code, not `shard.json`.** It names components and commands, which are code.
- **No start scene on the server.** Scenes are mostly presentation; the server's world is what game
  code spawns, which keeps the server free of render data.
- **A new `server` command, not `serve --game`.** `serve` is the protocol hub; overloading it would
  mix a debug channel with game traffic.

## Acceptance criteria

Checked by `apps/cli/src/net.test.ts` and `examples/coin-rush/tests/net.test.ts`; `shard dev
--connect` with two browser tabs was checked by hand (both players and the coins drawn, keys move
the player through the server).

- [x] `shard run --net clients=2,latency=0.05,loss=0.05 --frames 600 --seed 3 --json` in
      coin-rush (bots play 8 s, then stop) reports `converged: true`, and two runs print the
      same hashes.
- [x] `shard server --port 0 --json` prints its URL; a WebSocket client app connects to it and
      receives the scoreboard; SIGINT exits 0.
- [x] `buildApp({ display: false })` on a manifest with `sprite` and `input` initializes without a
      GPU (coin-rush; project code that uses input unconditionally, like maze-chase's, still needs
      the input plugin).
- [x] coin-rush's tests pass in `pnpm test`: moving through `Move` commands collects a coin and
      the score reaches every client.
- [x] A project without `project.net` fails `shard server` with `project/not-multiplayer`.
- [x] `shard lobby --port 0 --json` prints its URL, lists a room hosted through it, and stops on
      SIGINT.
- [x] In two browser tabs, `?host` shows a room code and `?join=<code>` joins it over WebRTC: both
      players and the coins appear in both tabs (checked by hand).
