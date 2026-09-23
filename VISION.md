# Shard — Vision

> Working name. Living document: when a decision changes, change it here.

## The bet

Game engines are built around a human in an editor: drag, drop, paint, tweak a slider, press play.
When an AI agent does the authoring, that editor is mostly in the way. An agent does not want a
gizmo. It wants:

- a text-first project it can read, diff, and write,
- schemas that tell it what is valid before it runs anything,
- a way to run the game, observe it, and verify what happened,
- generators it can parameterize, instead of 10,000 rocks it has to place one by one.

Shard is a WebGPU-first 2D/3D engine and renderer in TypeScript, where **the primary authoring
interface is an API, not a GUI**. The desktop app (Tauri) exists to play, inspect, and debug.
Anyone can build a Unity-style human editor on the SDK, but the engine never assumes one.

## Principles

1. **Everything is data, and the data is text.** Scenes, prefabs, materials, generators, and
   import settings are serialized to stable, diff-friendly files. No binary blobs as source of truth.
2. **One schema drives everything.** A component is defined once at runtime (field names and
   types). That single definition produces its storage, serialization, validation, JSON Schema,
   the inspector view, and the agent-facing API. No hand-written parallel layers.
3. **Observable by default.** Every system, entity, asset, and frame can be queried. Errors are
   structured (code, path, hint), not strings.
4. **Deterministic when asked.** Fixed timestep, seeded RNG, recordable input. An agent can write
   a gameplay test, replay it, and trust the result.
5. **Procedural is the default medium.** AI is good at describing rules and parameters and bad at
   hand placement. Generators are first-class, seeded, composable assets.
6. **The engine never imports the host.** Tauri, the browser, and future hosts sit behind a
   `Platform` interface injected at startup. The browser build is pure TS + WASM.
7. **Performance is designed in.** TypedArray-backed data, no allocation in the frame loop,
   GPU-driven work where WebGPU allows it, benchmarks in CI.
8. **Plugins all the way down.** Rendering, 2D, 3D, audio, physics, UI, and the agent layer are
   plugins over a small core, like Bevy.

## What "AI-native" means concretely

The product is the authoring loop:

```
read project + schemas → edit files → validate → run (headless or windowed)
   → observe (queries, events, logs, screenshots, frame captures) → verify → repeat
```

Surfaces:

- **MCP server** exposed by the running app and by the headless CLI: query the world, inspect and
  patch components, step frames, capture screenshots, read the asset graph, run tests.
- **Agent files in every project**: `AGENTS.md` plus skills describing the project's conventions,
  generated from engine docs plus the project's own schemas.
- **Headless mode**: run, test, bake, and export from the CLI, in CI or in an agent's sandbox.
- **Event and data API** for anyone building a custom UI. It is the same protocol the MCP layer uses.

The engine is model-agnostic. We build it with Claude; users can drive it with anything that
speaks MCP, or with plain code.

## Proof project: a Habbo Hotel-style game

The first game an agent builds with Shard is a Habbo-like: isometric 3D rooms, avatars, furniture,
chat. It is small enough to finish and touches most of the engine:

| Habbo feature | Engine capability it proves |
|---|---|
| Tile rooms, walls, floors | procedural room/mesh generation, scenes |
| Furniture (place, rotate, stack) | prefabs, data assets, procedural props, picking |
| Click-to-walk | raycasting, grid pathfinding, animation |
| Avatars (walk, sit, wave) | glTF, skinning, animation state machines |
| Chat bubbles, navigator, inventory | HUD/UI, world-anchored UI, text rendering |
| Room lighting, ambience | PBR, shadows, audio |
| Other people in the room | bots first, then the networking plugin |

Furniture should be procedural where possible (a generator per furniture family, with parameters),
so the agent can make new items without a 3D artist. Avatars can start from a CC0 rigged model.

## Engine feature map

"v1" means needed for the proof project or for the engine to be credible. "Later" means designed
for, not built yet.

**Core**
- ECS (archetype storage, TypedArray columns), resources, events, observers, change detection
- Scheduler with stages, fixed timestep, system ordering, run conditions
- Reflection/schema, serialization, JSON Schema export
- Math (vectors, quaternions, matrices, AABBs, rays), seeded RNG
- Transform hierarchy (2D and 3D), time, timers, tweening
- State machines (game states and per-entity)

**Rendering (v1)**
- WebGPU layer, render graph, pipeline cache
- Forward+ PBR, directional/point/spot lights, shadow maps, IBL, HDR, tonemapping
- Extensible materials (PBR base + user shader hooks, Bevy `ExtendedMaterial` pattern)
- WGSL module system (imports, defines, hooks)
- Instancing, frustum culling, LOD
- Compute passes as a first-class feature
- Post-processing: bloom, SSAO, FXAA/TAA, fog, color grading
- Skybox, procedural sky
- 2D: sprites, atlases, batching, sprite animation, tilemaps, 2D camera
- Debug drawing (lines, shapes, gizmos), picking
- Text rendering (MSDF fonts), in world and on screen
- Later: GPU-driven culling, decals, 2D lighting, water, atmosphere, volumetrics

**Particles**
- v1: GPU particles (compute simulate + instanced draw), emitters as data assets
- CPU particles for small counts or gameplay-coupled effects

**Animation**
- v1: skeletal skinning, clips, blending, state machines, morph targets, property tweens
- Later: IK, root motion, retargeting

**Physics** (Rapier via WASM, one plugin each)
- v1: 3D rigid bodies, colliders, raycasts, character controller
- v1: 2D physics
- Later: joints UI, vehicle helpers

**Audio** (Web Audio)
- v1: sounds and music, buses, volume, spatial 3D audio
- Later: effects, reverb zones, audio from procedural sources

**Input**
- v1: keyboard, mouse, gamepad, touch, action maps (bindings as data), pointer picking

**UI / HUD**
- v1: engine-rendered retained UI with flexbox layout, text, images, buttons, world-anchored panels
- Themes as data. Rendered by the engine so it looks the same on every export.

**Navigation**
- v1: grid A*, navmesh generation + pathfinding, steering
- Later: crowd avoidance

**Assets**
- v1: asset database, stable GUIDs, `.meta` sidecars, content-addressed cache, dependency-graph
  invalidation, hot reload, async loading, handles with reference counting
- glTF/GLB, images (KTX2 + fallback), audio, fonts, shaders
- Later: streaming, bundles, compression presets per platform

**Reuse**
- v1: scenes, prefabs with overrides as patches, nested composition, data assets
  ("scriptable objects"), variants

**Procedural generation**
- v1: noise library (CPU WASM + GPU compute), heightmap terrain with chunked LOD, splat texturing,
  rule-based scatter (props, foliage), procedural meshes (furniture, rooms, rocks), seeded graphs
- Generators are assets: parameters + seed in, entities/meshes/textures out, cached by input hash
- Later: wave function collapse, dungeon/level generators, L-systems

**Game services**
- v1: save/load (serialize world subsets), settings, localization tables
- Later: networking plugin (client/server state sync) for the Habbo multiplayer step, achievements

**Tooling and the agent layer**
- v1: headless runner, protocol, MCP server, screenshots, frame stepping, input recording/replay
- v1: profiler (CPU per system, GPU timestamps), structured logs, error codes
- v1: Studio (Tauri): game view, entity/component inspector, asset browser, logs, profiler
- Export: web, desktop (Tauri bundles). Mobile via Tauri comes for free if the platform
  abstraction holds; not tested or blocking.

## Scripting model

Game code is ECS, written in TypeScript in the project's `scripts/` folder:

- **Components** are defined with a schema (`defineComponent`), so they are storable, serializable,
  inspectable, and patchable by an agent without extra work.
- **Systems** are plain functions over queries, registered with a schedule.
- **Observers** react to events and lifecycle hooks (added, removed, changed) for logic that would
  otherwise need callbacks.

There is no MonoBehaviour-style layer in core. Explicit data and functions are easier for an agent
to read, test headless, and change safely. A behaviour layer can exist as a plugin.

Scripts are bundled by the tooling (Rust-side oxc/rolldown in Studio, the same pipeline in the
CLI) and hot-reloaded without losing world state where the schema allows it.

## Architecture

Turborepo + pnpm for TypeScript, Cargo workspace for Rust.

```
packages/
  core            ECS, scheduler, events, reflection, math. No DOM, no GPU.
  platform        Platform interface (fs, storage, windowing, clock, logging)
  platform-web    browser implementation
  platform-tauri  Tauri implementation (the only package that imports @tauri-apps/*)
  gpu             thin layer over WebGPU
  ...             runtime, shader, render, assets, scene, protocol, mcp, gltf, procgen,
                  physics, audio, ui, input, animation, particles, nav — added as their specs land
crates/           (later) WASM kernels, native import/bake pipeline
apps/
  playground      browser sandbox for engine development
  studio          Tauri app: play, inspect, debug, MCP host
  cli             (later) headless run, test, bake, export
```

Rust has two jobs and never a third:
1. **WASM kernels** that run the same in browser and desktop (noise, meshing, meshopt).
2. **Native tooling** in Studio and CLI (import, texture baking, cache DB, script bundling).

Project folder (a user's game):

```
my-game/
  shard.json          project manifest
  AGENTS.md, .agents/ agent conventions and skills
  assets/             sources + .meta sidecars (GUID, import settings)
  scenes/  prefabs/  materials/  generators/  data/
  scripts/            user TypeScript (components, systems, observers)
  .shard/             cache (gitignored, fully rebuildable)
```

## Stack decisions

| Area | Decision |
|---|---|
| Language | TypeScript (strict, ESM, erasable syntax only) |
| Monorepo | Turborepo + pnpm; Cargo workspace for Rust |
| Lint/format | Biome |
| Tests | Vitest |
| GPU API | WebGPU only. No WebGL2 fallback. |
| Shaders | WGSL + our module system (imports, defines, material hooks) |
| Desktop | Tauri 2, behind the `Platform` interface |
| ECS | Archetype storage with TypedArray columns (GPU-uploadable) |
| Scripting | ECS components/systems/observers in TS |
| Physics | Rapier (WASM), 2D and 3D plugins |
| Audio | Web Audio |
| UI | Engine-rendered, flexbox layout |
| Spec process | One spec file per feature in `specs/`, see `specs/README.md` |

## Performance targets

- 100k entities with transform + velocity updated at 60 fps in under 4 ms of system time.
- 10k+ instanced meshes drawn at 60 fps on a mid-range GPU.
- 1M GPU particles.
- Zero steady-state allocations per frame in core and render.

## Non-goals

- A drag-and-drop editor. The SDK allows one; we don't build it.
- WebGL2.
- Cross-machine bit-exact determinism.
- Visual scripting.

## Roadmap

See `specs/ROADMAP.md`.
