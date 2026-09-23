# 0013 — MCP server

- **Status:** implemented
- **Packages:** `apps/cli` (`shard mcp`)
- **Depends on:** 0011, 0012

## Context

MCP is how Claude (and any MCP client) drives Shard: open a project, read schemas, edit and
validate scenes, run the game, look at it, play it, and check the result. The protocol (0011)
already does the work; this spec is about exposing it as MCP tools that are easy for a model to use
correctly.

## Goals

- `shard mcp`: a stdio MCP server for a project.
- Tools mirroring the protocol, with descriptions written for models.
- Screenshots returned as MCP image content, so the model sees the frame.
- Two targets: a headless app the server runs itself, or a live app (Studio, browser) that attached
  over WebSocket.
- Resources: component schemas, scenes, project docs.

## Non-goals

- Remote/multi-user servers.
- Editing arbitrary source files (the client has its own file tools); the server focuses on the
  running game and engine data.

## Design

### Tools

| Tool | Maps to |
|---|---|
| `describe_project` | manifest, plugins, systems, scenes, component list |
| `get_schema` | one component/resource schema with descriptions |
| `validate_scene` | `scene.validate`, all errors with pointers |
| `load_scene` / `save_scene` | 0010 |
| `query_entities` / `get_entity` | `world.query` / `entity.get` (by id or path) |
| `spawn_entity` / `patch_entity` / `despawn_entity` | validated mutations |
| `step` / `pause` / `resume` | frame control |
| `screenshot` | `render.capture` → image content (optionally a camera path and size) |
| `press` / `hold` / `release` | input injection by action name or key |
| `record_input` / `replay_input` | 0008 |
| `run_tests` | `shard test`, results as structured text |
| `recent_errors` / `logs` | 0011 logging |

- Descriptions say when to use each tool and what comes back, with one example each.
- Errors come back as tool errors carrying `code`, `message`, `hint`, and `path`, which are exactly
  what a model needs to fix its input.
- `screenshot` defaults to a modest size (e.g. 768×432) to keep images cheap to send.

### Targets

- **Headless (default):** the server builds the app itself (0012 loading), renders through Dawn,
  and is fully deterministic.
- **Attached:** `shard mcp --attach` also listens on the protocol hub (0011); when Studio or a
  playground tab connects, tools go to the live app instead. `describe_project` reports which
  target is active.

### Resources

`shard://schemas/<component>`, `shard://scenes/<path>`, `shard://docs/agents` (generated
`AGENTS.md` and `.agents/`), so clients can pull reference material without tool calls.

### Setup

`shard init` writes a project `.mcp.json` pointing at `shard mcp`, so Claude Code picks it up when
opened in the project folder.

## Decisions

- **Built on the official MCP TypeScript SDK.** Standard transports and content types.
- **Headless by default.** Deterministic, works in CI and sandboxes, no window needed.
- **Tool descriptions are part of the product.** They're reviewed like API docs.

## Acceptance criteria

- [x] An MCP client lists the tools and resources; each tool works against a headless project.
- [x] `screenshot` returns image content of the rendered scene.
- [x] A scripted session: validate a scene, fix the reported error, load it, step 60 frames,
      screenshot, press an action, step, and read back a changed component. All through MCP tools.
- [x] With `--attach`, a connected playground tab serves the same tools.
- [x] `shard init` produces a `.mcp.json` that Claude Code loads.

## Implementation notes

- **Built on the SDK's low-level `Server`**, so tool input schemas come straight from each protocol
  method's schema (`paramsSchema`) instead of being restated in Zod.
- **22 tools:** the table above, where `press` is press, step 1, release. Tool errors return the
  `ShardError` JSON as `isError` content.
- **`--attach`** starts the hub on 7811 (or `--port` / `SHARD_HUB_PORT`); tools go to the most
  recently attached app and fall back to headless when none is attached.
- **`.mcp.json`** from `shard init` runs `pnpm exec shard mcp`.
- Verified over stdio (initialize, list, `get_entity`) and in `cli.test.ts` with the in-memory
  transport, including the scripted agent loop and an attached app.

## Open questions

- **Deferred:** a watch mode that pushes errors and logs as MCP notifications. Added once common
  clients surface server notifications; until then `recent_errors` and `logs` cover it.
