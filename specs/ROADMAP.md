# Roadmap

Each milestone ends with something you can run. Specs are numbered in the order they're
expected to land; numbers are reserved when a spec is drafted, not before.

## M1 — Core loop

The engine skeleton, fully headless and tested.

| Spec | Title | Status |
|---|---|---|
| [0001](0001-ecs-core.md) | ECS core | accepted |
| [0002](0002-component-schema.md) | Component schema and reflection | accepted |
| [0003](0003-app-plugins-scheduler.md) | App, plugins, and scheduler | accepted |
| — | Math, transforms, hierarchy | planned |

## M2 — First pixels, the engine's way

A spinning PBR-lit cube driven by ECS, in the playground and in Studio.

| Spec | Title | Status |
|---|---|---|
| — | GPU layer and render graph | planned |
| — | WGSL module system (imports, defines, hooks) | planned |
| — | Cameras, meshes, basic forward renderer | planned |
| — | Input and action maps | planned |

## M3 — The agent loop

An agent builds a scene without writing engine code: it edits files, validates them, runs
headless, and checks screenshots.

| Spec | Title | Status |
|---|---|---|
| — | Scene serialization and validation | planned |
| — | Inspection/control protocol | planned |
| — | MCP server | planned |
| — | Headless CLI (run, step, screenshot, test) | planned |
| — | Project format (`shard.json`, `AGENTS.md` generation) | planned |

## M4 — Assets

| Spec | Title | Status |
|---|---|---|
| — | Asset database (GUIDs, `.meta`, cache, invalidation, hot reload) | planned |
| — | glTF/GLB loader | planned |
| — | Textures (KTX2 pipeline, fallback) | planned |
| — | User scripts: bundling and hot reload | planned |

## M5 — Renderer v1

| Spec | Title | Status |
|---|---|---|
| — | PBR, lights, shadows, IBL, HDR, tonemapping | planned |
| — | Extensible materials | planned |
| — | Instancing, culling, LOD | planned |
| — | Post-processing stack | planned |
| — | 2D pipeline (sprites, atlases, tilemaps) | planned |
| — | Text rendering (MSDF) | planned |
| — | GPU particles | planned |
| — | Debug drawing and picking | planned |

## M6 — Gameplay systems

| Spec | Title | Status |
|---|---|---|
| — | Skeletal animation and state machines | planned |
| — | Physics 3D and 2D (Rapier) | planned |
| — | Audio (Web Audio, spatial) | planned |
| — | UI/HUD (flexbox, world-anchored) | planned |
| — | Navigation (grid A*, navmesh) | planned |
| — | Prefabs, overrides, data assets | planned |
| — | Save/load, settings, localization | planned |

## M7 — Procedural generation

| Spec | Title | Status |
|---|---|---|
| — | Noise library (WASM + compute) | planned |
| — | Generators as assets | planned |
| — | Terrain (heightmap, chunked LOD, splatting) | planned |
| — | Scatter and procedural meshes | planned |

## M8 — Proof project: Habbo-like

An agent builds it end to end: tile rooms, procedural furniture, avatars, click-to-walk,
chat bubbles, bots. Networking follows as its own spec.

## M9 — Export

Web build, desktop bundles, profiler in Studio. Mobile via Tauri, untested and non-blocking.
