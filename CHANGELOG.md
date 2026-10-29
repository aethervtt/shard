# Changelog

All engine packages share one version. During `0.x`, minor releases may change APIs;
patch releases preserve compatibility. The CLI is published with them from 0.4.0; the other apps
and the examples are not.

## 0.4.1 — 2026-10-29

The first complete release since 0.2.2. 0.3.0 was published partway (a transient npm provenance
error stopped it; deprecate it), and 0.4.0 was tagged but never published (a test teardown timed
out during validation). 0.4.1 contains everything listed under 0.4.0 and 0.3.0, plus:

- `shard test` gives setup and teardown hooks 60 s, like tests.
- The Release workflow skips versions already on npm and retries a failed publish once.

## 0.4.0 — 2026-10-28 (not published)

The `shard` command is on npm: `@aethervtt/shard-cli` (0093).

- `npx @aethervtt/shard-cli init my-game` makes a project pinned to this version; inside it,
  `npx shard <command>` runs every command (`dev`, `test`, `server`, `lobby`, `run --net`, …).
- `shard dev`, `shard docs` and `shard test` find the engine in any install layout (the repository,
  npm, pnpm) through `enginePackages` (`@aethervtt/shard-node`).
- Playwright is an optional peer of the CLI: only browser-driven commands need it.
- `commands()` and `sendEvent` work in apps without networking, so a multiplayer project's server
  systems run in a plain `shard run`.
- `pnpm release --check` installs the CLI from the tarballs and runs a project with it.

## 0.3.0 — 2026-10-28 (partially published)

50 packages, including three new ones: `net`, `net-websocket` and `net-webrtc` (each under
`@aethervtt/shard-`).

- Multiplayer (0086): transports behind one interface with seeded latency/loss simulation, a
  handshake that refuses mismatched builds, a tick clock, and an in-process test harness
  (`@aethervtt/shard-net/testing`).
- Replication (0087): a schema-derived binary codec in core (`createRowCodec`), net ids, acked
  deltas, server-side interest (owner, grid, team) and per-component redaction, a per-player
  bandwidth budget, and interpolation of remote entities.
- Commands, events and hidden information (0089): validated client commands answered by the
  server, per-recipient events, and per-player card zone views with placeholders (`cards/net`).
- Accounts and persistence (0090): async `accept` with the peer's account, and load/spawn/
  capture/store player hooks that save every player when the server stops.
- Peer to peer (0091): WebRTC data channels with a truly unreliable channel, a lobby with room
  codes and signaling, and `startHost` for hosting from a browser.
- Multiplayer projects (0092): `project.net(...)`, `buildApp({ display: false })` without a GPU,
  and `loadHeadlessCode` for servers and headless clients.
- Runtime: `FixedTime.tick` and `FixedTime.rate`, and `intervalRunner` for servers and hosts.

## 0.2.2 — 2026-10-19

- Break the audio music/checkpoint initialization cycle without changing schema identity (0085).
- Reset cached dice presentation fade/result state, and restore the WebGL2 default draw buffer
  when presenting resized/shared surfaces (0085).
- Support OpenType's CommonJS and ESM exports, ship statically discoverable Basis assets, fix
  ETC1S quality, and keep Node codec imports outside browser bundles through a conditional host
  entry. WebP uses its fully specified module path; noise uses the same host boundary (0085).
- Advance timed on-demand presentation clocks by elapsed time while keeping fixed-step wake
  behavior. Existing `App.update(delta)` callers retain their timing (0052, 0085).
- Exercise packed packages in Node/Bun, Vite, webpack and Next, including browser codecs,
  transparent shared surfaces and dice workers. Ship Vite module-worker setup instructions (0085).

## 0.2.1

- Preserve and relocate the text package's reference to its bundled `opentype.js` declarations
  in emitted `.d.ts` files. Strict TypeScript consumers of text, dice, cards, and related APIs no longer need
  to supply an additional ambient declaration (0056).
- Expand the packed consumer's declaration check to cover audio, the audio editor and preview,
  cards, dice, effects, scatter, and text, in addition to the renderer example (0056).

## 0.2.0 — 2026-10-18

47 packages, including five new packages: `audio-editor`, `audio-preview`, `cards`, `effects`,
and `scatter` (each under `@aethervtt/shard-`).

- Scatter, foliage, and procedural meshes (0045); heightfield terrain with incremental baking,
  streaming, physics, navigation, and scatter integration (0071).
- CPU, GPU, worker, and asset profiling (0074), named performance budgets and scenario captures
  (0075), and post-processing/render-pass performance improvements.
- Cards and decks with PBR materials and extensible foil finishes (0076).
- Authored audio events, parameters, preparation, and voice ownership (0077); mixers, inserts,
  sends, snapshots, and acoustics (0078); adaptive music, preview, and export (0079).
- Embeddable audio authoring panels with host-owned assets and persistence, light/dark themes,
  and layouts that support 300 px docks (0080). The editor remains an early version.
- Reusable effect sequences with preparation, binding, and cancellation (0081), trails and beams
  (0082), and projected color decals on rigid mesh receivers (0083).
- Authored dice impact, entrance, and result audio with parameter-driven layers and independent
  mixing, while retaining procedural defaults (0084).

Upgrade all installed Shard packages together. Review each feature's spec and package documentation
when upgrading from 0.1.0; this release does not promise API compatibility with 0.1.x.

## 0.1.0 — 2026-10-07

42 packages. Specs 0057–0070, including the WebGL2 baseline backend (0064).
Ten packages first published: `controls`, `dice`, `fog`, `gpu-webgl2`, `grid`, `mirror`, `scenes`,
`structure`, `vector`, and `verify`.

## 0.0.1 — 2026-09-28

Initial public engine packages and modular JavaScript/declaration packaging (0056).
