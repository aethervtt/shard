# 0011 — Inspection and control protocol

- **Status:** accepted
- **Packages:** `@shard/protocol`
- **Depends on:** 0003, 0005, 0008, 0010

## Context

The vision's authoring loop is: edit → validate → run → observe → verify. The observe and control
half needs one API that works the same whether the game runs headless in the CLI, in Studio, or in a
browser tab. The MCP server (0013) is a thin layer over it, and anyone building a custom UI for Shard
uses it directly.

## Goals

- A transport-agnostic JSON-RPC 2.0 protocol served by any running app.
- Methods to describe, query, patch, spawn, despawn, pause, step, capture, inject input, record,
  and load/save/validate scenes.
- Subscriptions for logs, errors, and frame events.
- Frame control (pause, step N frames) honored by every runner.
- Transports: in-process, stdio, and WebSocket (with the app dialing out, so browsers can join).

## Non-goals

- Authentication beyond localhost-only by default.
- Remote debugging over the network.

## Design

### Methods

| Method | Does |
|---|---|
| `app.describe` | plugins, schedules, systems (0003) |
| `schema.list` / `schema.get` | registered components/resources/events with JSON Schemas |
| `world.stats` | entity/archetype counts, memory |
| `world.query` | `{ with, without, limit, fields? }` → entities with component values (JSON) |
| `entity.get` | by id or scene path → all components as JSON |
| `entity.spawn` | components as JSON (validated), optional parent → id and path |
| `entity.patch` | JSON merge patch per component, validated before applying |
| `entity.despawn` | recursive by default |
| `resource.get` / `resource.set` | for resources with schemas (and JSON-safe values) |
| `time.pause` / `time.resume` / `time.step` | frame control; `step` runs N frames and returns |
| `render.capture` | a view → PNG (base64) plus size; `render.describe` (0005) |
| `input.inject` / `input.record` / `input.replay` | 0008 |
| `scene.validate` / `scene.load` / `scene.save` | 0010 |
| `log.tail` / `errors.recent` | structured logs and recent `ShardError`s |

- Every method validates its params against a schema; bad params are a JSON-RPC error carrying the
  `ShardError` (`code`, `message`, `hint`, `path`) in `data`.
- Mutations go through commands and apply at the next sync point, so the protocol never breaks a
  system mid-iteration. `entity.patch` returns after the patch has applied.
- Entity ids are accepted everywhere, and so are scene paths (`ship/camera`).

### Frame control

`AppControl` resource: `{ paused, pendingSteps }`. Runners check it every frame: paused apps don't
advance time; `time.step(n)` runs exactly n fixed-delta frames, then responds. Deterministic runs
(seeded, fixed delta) stay deterministic under stepping.

### Transports

- **In-process:** `createProtocolServer(app).handle(request)` for tests and Studio's own UI.
- **stdio:** newline-delimited JSON-RPC for the CLI.
- **WebSocket, dialing out:** the app connects to a hub URL (e.g. `ws://127.0.0.1:7811`) given by the
  host. The MCP server or CLI listens; Studio and browser tabs connect to it. Reversing the
  direction means browsers can take part and Studio needs no server of its own.

### Logging

A `Log` resource (ring buffer) with levels and structured data; `ShardError`s thrown in systems and
reported by the GPU/shader layers land in it. `log.tail` and the `log` subscription read it.

### PNG encoding

`render.capture` encodes PNG in pure TS (zlib via `CompressionStream` in browsers, `node:zlib` in
Node), so captures work on every host.

## Decisions

- **JSON-RPC 2.0.** Simple, standard, maps directly onto MCP tools and onto any custom UI.
- **App dials out.** One hub (CLI/MCP) can attach to headless runs, Studio, or a browser tab the
  same way.
- **Everything validated, everything through commands.** The protocol can't corrupt a frame or
  write data a schema forbids.
- **Default hub port 7811**, overridable with `SHARD_HUB_PORT` and `--port`.

## Acceptance criteria

- [ ] Every method in the table works in-process against a headless app, with schema-validated
      params and `ShardError` data on failure.
- [ ] `time.step(n)` advances exactly n frames; a paused app doesn't advance.
- [ ] `entity.patch` with an out-of-range value fails with the field's pointer and changes nothing.
- [ ] `render.capture` returns a valid PNG that decodes to the rendered pixels.
- [ ] A browser tab (playground) connects to a WebSocket hub and answers `app.describe`.
- [ ] Log and error subscriptions deliver events as they happen.

## Open questions

None.
