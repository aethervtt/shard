# Shard

A WebGPU-first 2D/3D game engine in TypeScript, built for AI-driven authoring.

You build with Shard through its API and plain-text project files, which an agent can read, diff
and write. Schemas say what's valid before anything runs. The same project runs in a browser, in
the desktop app, or headless in the CLI, where an agent can play it, query it, screenshot it and
test it. [VISION.md](VISION.md) explains the bet.

**Status:** early development. The APIs change without notice, nothing is published to npm yet,
and the first proof project (a procedural space explorer) is still being built. Every feature
starts as a spec in [`specs/`](specs/), and [specs/ROADMAP.md](specs/ROADMAP.md) shows what's done
and what's next.

## Try it

Requires Node 22+ and pnpm 10, and a browser with WebGPU.

```sh
pnpm install
pnpm playground   # browser sandbox with every demo, at http://localhost:5180
pnpm studio       # desktop app (Tauri 2; needs Rust)
```

Inside a project (for example `examples/star-explorer`), the `shard` CLI does the rest:

```sh
pnpm exec shard validate              # manifest, assets and scenes; lists every error
pnpm exec shard dev                   # play it in a browser, with hot reload
pnpm exec shard run --frames 600      # headless run; prints a deterministic world hash
pnpm exec shard screenshot scenes/main.scene.json --out shot.png
pnpm exec shard test                  # gameplay tests in tests/*.test.ts
pnpm exec shard mcp                   # MCP server, so an agent can drive it
```

Every command takes `--json`.

## Packages

Each package exports its TypeScript source directly (`./src/index.ts`), with no build step.

### Core

| Package | What it does |
|---|---|
| `@shard/core` | ECS with archetype tables of TypedArray columns, queries, change detection, events and observers. Component schemas, from which storage, serialization, validation, JSON Schema and inspector views are derived. Scheduler with stages and system ordering. Math (vectors, quaternions, matrices, AABBs, rays), f64 helpers, seeded RNG, and structured `ShardError`s |
| `@shard/runtime` | `App` and plugins, fixed timestep, time, animation-frame and headless runners, display refresh rate |
| `@shard/transform` | Transform hierarchies and propagation, large-world grids with a floating origin |
| `@shard/input` | Keyboard, mouse, touch and gamepad devices, and action maps |
| `@shard/platform` | The host interface (files, storage, audio, workers) the engine uses instead of any host API. `platform-web`, `platform-node` and `platform-tauri` implement it |

### Rendering

| Package | What it does |
|---|---|
| `@shard/gpu` | WebGPU context, buffers, pipeline and layout caches, validation errors, device-loss recovery, WebGPU support probing, and Dawn for Node |
| `@shard/shader` | WGSL module system: imports, defines and material hooks |
| `@shard/render` | Render graph; forward+ and deferred paths per camera; PBR in physical units with camera exposure; clustered point and spot lights with cascaded shadows; HDR, tonemapping, IBL and procedural sky; atmosphere scattering at any altitude; extensible materials; instancing, GPU culling and LOD; post-processing (bloom, auto exposure, depth of field, motion blur, TAA, FXAA, SSAO, fog, color grading); render scale and dynamic resolution; debug drawing, gizmos and picking |
| `@shard/mesh` | Mesh data and primitives |
| `@shard/texture` | KTX2/Basis pipeline and transcoding, PNG, JPEG, WebP and HDR decoding, texture arrays, previews |
| `@shard/gltf` | glTF and GLB loading: PBR materials, skins, morph targets, animations, punctual lights, texture transforms |
| `@shard/sprite` | Sprites, atlases, batching, sprite animation, tilemaps, and 2D lighting with normal maps and soft shadows |
| `@shard/text` | MSDF text in the world and on screen, font building, and layout with kerning |
| `@shard/particles` | GPU particles (compute simulation, instanced drawing) with a CPU backend, and effects as data assets |
| `@shard/ui` | Flexbox UI and HUDs with themes, widgets and world-anchored elements |

### Gameplay

| Package | What it does |
|---|---|
| `@shard/physics` | 3D and 2D physics on Rapier: bodies, colliders, joints, contact events, scene queries, point gravity, and a character controller for slopes, steps and spherical gravity |
| `@shard/animation` | Skeletal skinning, clips, blending and masks, morph targets, root motion, state machines and blend spaces, IK, bone attachments, retargeting |
| `@shard/audio` | Web Audio with spatial sound and buses, and headless voices for tests |
| `@shard/nav` | Grid A*, navmeshes (Recast) and agents |
| `@shard/save` | Save and load, settings, localization |

### Content and procedural generation

| Package | What it does |
|---|---|
| `@shard/assets` | Asset database: GUIDs, `.meta` files, an import cache, invalidation, hot reload, and project-defined data assets |
| `@shard/scene` | Scene files with validation, prefabs with overrides and variants |
| `@shard/project` | The project format (`shard.json`), user scripts, and the generated agent docs (`AGENTS.md`, `.agents/`, schemas) |
| `@shard/noise` | Noise graphs as data, evaluated by a Rust/WASM kernel, as generated WGSL, or on a worker pool |
| `@shard/procgen` | Generators as seeded assets, cached by input hash, with previews |
| `@shard/terrain` | Planet terrain: a cube-sphere with quadtree LOD, GPU-generated chunks, biomes and streaming |

### Tools

| Package | What it does |
|---|---|
| `@shard/protocol` | The inspection and control protocol: query the world, patch components, step frames, capture frames |
| `@shard/node` | Node helpers: open a project, hash a world |
| `@shard/testing` | Helpers for gameplay tests |
| `apps/cli` | The `shard` binary: validate, import, dev, headless runs, screenshots, tests, the protocol hub and the MCP server |
| `apps/playground` | Browser sandbox with a demo per feature |
| `apps/studio` | Desktop app (Tauri 2) for playing, inspecting and debugging |

## Development

```sh
pnpm typecheck   # tsc in every package
pnpm test        # vitest; GPU tests run on Dawn in Node
pnpm lint        # Biome
pnpm bench       # benchmarks, then every test serially at exact time budgets
```

[AGENTS.md](AGENTS.md) has the working rules for people and agents: work from a spec, keep hot
paths allocation-free, and raise errors as `ShardError`s.

## License

See [LICENSE](LICENSE). Third-party code and assets keep their own licenses, next to them:
Basis Universal (`packages/texture/vendor/basis`), the Inter and Noto Sans JP fonts, and the
Khronos glTF sample models (`packages/gltf/fixtures/khronos`).
