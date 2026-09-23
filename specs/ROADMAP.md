# Roadmap

Each milestone ends with something you can run. Specs are numbered in the order they're
expected to land; numbers are reserved when a spec is drafted, not before.

## M1 — Core loop

The engine skeleton, fully headless and tested.

| Spec | Title | Status |
|---|---|---|
| [0001](0001-ecs-core.md) | ECS core | implemented |
| [0002](0002-component-schema.md) | Component schema and reflection | implemented |
| [0003](0003-app-plugins-scheduler.md) | App, plugins, and scheduler | implemented |
| [0004](0004-math-transforms.md) | Math, transforms, hierarchy propagation | implemented |

## M2 — First pixels, the engine's way

A spinning PBR-lit cube driven by ECS, in the playground and in Studio.

| Spec | Title | Status |
|---|---|---|
| [0005](0005-gpu-render-graph.md) | GPU layer and render graph | implemented |
| [0006](0006-wgsl-modules.md) | WGSL module system (imports, defines, hooks) | implemented |
| [0007](0007-forward-renderer.md) | Cameras, meshes, basic forward renderer | implemented |
| [0008](0008-input.md) | Input and action maps | implemented |

## M3 — The agent loop

An agent builds a scene without writing engine code: it edits files, validates them, runs
headless, and checks screenshots.

| Spec | Title | Status |
|---|---|---|
| [0009](0009-project-format.md) | Project format (`shard.json`, layout, generated agent docs) | implemented |
| [0010](0010-scene-files.md) | Scene files (validation, load/save, presets, procedural refs) | implemented |
| [0011](0011-protocol.md) | Inspection and control protocol | implemented |
| [0012](0012-cli.md) | Headless CLI and gameplay tests | implemented |
| [0013](0013-mcp-server.md) | MCP server | implemented |

## M4 — Assets

| Spec | Title | Status |
|---|---|---|
| [0014](0014-asset-database.md) | Asset database (GUIDs, `.meta`, cache, invalidation, hot reload) | implemented |
| [0015](0015-gltf-loader.md) | glTF/GLB loader | implemented |
| [0016](0016-textures.md) | Textures (KTX2 pipeline, fallback, material slots, previews) | implemented |
| [0017](0017-user-scripts.md) | User scripts: bundling and hot reload | implemented |

## M5 — Renderer v1

A frame that looks finished: lights by the hundred with shadows, HDR with image-based lighting and a
sky, custom materials, a deferred path, post-processing, 2D, text, particles, and the debug tools an
agent needs to see what's on screen.

| Spec | Title | Status |
|---|---|---|
| [0018](0018-lights-shadows.md) | Lights and shadows (point, spot, clustered Forward+, cascaded shadows) | accepted |
| [0019](0019-hdr-ibl-sky.md) | HDR, tonemapping, image-based lighting, and sky | accepted |
| [0020](0020-extensible-materials.md) | Extensible materials | accepted |
| [0021](0021-deferred.md) | Deferred rendering path (G-buffer, per-camera forward/deferred) | accepted |
| [0022](0022-instancing-culling-lod.md) | Instancing, GPU culling, and LOD | accepted |
| [0023](0023-post-processing.md) | Post-processing (bloom, auto exposure, DoF, motion blur, TAA, SSAO, fog, grading) | accepted |
| [0024](0024-2d.md) | 2D: sprites, atlases, tilemaps | accepted |
| [0025](0025-text.md) | Text rendering (MSDF) | accepted |
| [0026](0026-particles.md) | GPU particles | accepted |
| [0027](0027-debug-draw-picking.md) | Debug drawing and picking | accepted |
| — | 2D lighting and shadows (builds on 0024) | planned |

## M6 — Gameplay systems

| Spec | Title | Status |
|---|---|---|
| — | Skeletal animation (skinning, clips, blending, masks, root motion) | planned |
| — | Animation state machines | planned |
| — | IK, bone attachments, retargeting | planned |
| — | Physics 3D and 2D (Rapier) | planned |
| — | Audio (Web Audio, spatial) | planned |
| — | UI/HUD (flexbox, world-anchored) | planned |
| — | Navigation (grid A*, navmesh) | planned |
| — | Prefabs, overrides, data assets | planned |
| — | Save/load, settings, localization | planned |

## M7 — Procedural generation and large worlds

| Spec | Title | Status |
|---|---|---|
| — | Noise library (WASM + compute) | planned |
| — | Generators as assets | planned |
| — | Large-world coordinates (floating origin, double-precision positions) | planned |
| — | Planet terrain (cube-sphere, quadtree LOD, GPU heightfields, streaming) | planned |
| — | Atmosphere scattering and sky | planned |
| — | Scatter, foliage, and procedural meshes | planned |
| — | Star systems and galaxy generation | planned |

## M8 — Proof project: No Man's Sky-style explorer

An agent builds it end to end from generators: a seeded galaxy, star systems, planets you can land
on and leave, procedural flora and creatures, a ship, a scanner, and a HUD.

## M9 — Export

Web build, desktop bundles, profiler in Studio. Mobile via Tauri, untested and non-blocking.
