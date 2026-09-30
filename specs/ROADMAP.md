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
| [0018](0018-lights-shadows.md) | Lights and shadows (point, spot, clustered Forward+, cascaded shadows) | implemented |
| [0019](0019-hdr-ibl-sky.md) | HDR, tonemapping, image-based lighting, and sky | implemented |
| [0020](0020-extensible-materials.md) | Extensible materials | implemented |
| [0021](0021-deferred.md) | Deferred rendering path (G-buffer, per-camera forward/deferred) | implemented |
| [0022](0022-instancing-culling-lod.md) | Instancing, GPU culling, and LOD | implemented |
| [0023](0023-post-processing.md) | Post-processing (bloom, auto exposure, DoF, motion blur, TAA, SSAO, fog, grading) | implemented |
| [0024](0024-2d.md) | 2D: sprites, atlases, tilemaps | implemented |
| [0025](0025-text.md) | Text rendering (MSDF) | implemented |
| [0026](0026-particles.md) | GPU particles | implemented |
| [0027](0027-debug-draw-picking.md) | Debug drawing and picking | implemented |
| [0039](0039-2d-lighting.md) | 2D lighting and shadows (normal maps, occluders, soft shadows) | implemented |

## M6 — Gameplay systems

Things that move, collide, animate, make noise, and remember: physics and a character that walks
around a planet, prefabs and data assets for reuse, skeletal animation with graphs and IK, audio,
UI, navigation, and saves. Each one exposes its state to agents as data.

| Spec | Title | Status |
|---|---|---|
| [0028](0028-physics.md) | Physics 3D and 2D (Rapier) | implemented |
| [0029](0029-character-controller.md) | Character controller (slopes, steps, spherical gravity) | implemented |
| [0030](0030-prefabs.md) | Prefabs, overrides, and variants | implemented |
| [0031](0031-data-assets.md) | Data assets (project-defined types, variants) | implemented |
| [0032](0032-skeletal-animation.md) | Skeletal animation (skinning, clips, blending, masks, morph targets, root motion) | implemented |
| [0033](0033-animation-graphs.md) | Animation state machines and blend spaces | implemented |
| [0034](0034-ik-retargeting.md) | IK, bone attachments, and retargeting | implemented |
| [0035](0035-audio.md) | Audio (Web Audio, spatial, buses, headless voices) | implemented |
| [0036](0036-ui.md) | UI and HUD (flexbox, themes, world-anchored) | implemented |
| [0037](0037-navigation.md) | Navigation (grid A*, navmesh, agents) | implemented |
| [0038](0038-save-settings-localization.md) | Save/load, settings, and localization | implemented |

## M7 — Procedural generation and large worlds

| Spec | Title | Status |
|---|---|---|
| [0040](0040-large-world-coordinates.md) | Large-world coordinates (grids, floating origin, f64 helpers) | implemented |
| [0041](0041-noise.md) | Noise library (graphs as data, WASM kernel, WGSL codegen, worker pool) | implemented |
| [0042](0042-generators.md) | Generators as assets (seeded, cached by input hash, previews) | implemented |
| [0043](0043-planet-terrain.md) | Planet terrain (cube-sphere, quadtree LOD, GPU chunks, biomes, streaming) | implemented |
| [0044](0044-atmosphere.md) | Atmosphere scattering (Hillaire LUTs, aerial perspective, any altitude) | implemented |
| [0045](0045-scatter-foliage-procedural-meshes.md) | Scatter, foliage, and procedural meshes | accepted |
| [0046](0046-star-systems-galaxy.md) | Star systems and galaxy generation | accepted |
| [0047](0047-small-bodies.md) | Small bodies (asteroids, belts, rings, comets) | accepted |
| [0048](0048-creatures.md) | Creatures (body plans, procedural locomotion, behavior, fauna) | accepted |
| [0049](0049-clouds-weather.md) | Clouds and weather (volumetric clouds, timeline weather, precipitation) | accepted |
| [0050](0050-soundscapes.md) | Soundscapes and procedural audio | accepted |
| [0051](0051-render-scale.md) | Render scale and dynamic resolution (high-DPI displays) | implemented |

## M8 — Proof project: No Man's Sky-style explorer

An agent builds it end to end from generators: a seeded galaxy, star systems, planets you can land
on and leave, procedural flora and creatures, a ship, a scanner, and a HUD.

## M9 — Export

Web build, desktop bundles, profiler in Studio. Mobile via Tauri, untested and non-blocking.

## E1 — Embedding: Aether

Shard as a guest inside a host application: Aether (a VTT) moves its dice, and then its table,
off three.js. This runs alongside M8. Order: 0052, 0053 and 0061 first (the embedding
foundations), then 0054 dice with 0063. The table follows: 0055, 0057, 0060, 0058, 0059. 0056 and
0062 measure the result throughout. The Aether adapter that maps its documents onto these lives in
Aether. Already done outside a spec: `Camera3d.active` (0007) and `probeWebGpu` (0061). The WebGL2
fallback (0064) runs in parallel, in three stages, and doesn't block the WebGPU replacement. New
tabletop shaders use its `shard::data` accessors once stage 1 lands. Dice entrances and screen
effects (0065) build on 0054 and 0063 once 0054 is implemented. Structure grows after 0055: curved
walls (0066) and groups (0067), then surface variation (0068), per-view visibility and cutaways
(0070), and interior lighting (0069).

| Spec | Title | Status |
|---|---|---|
| [0052](0052-embedding.md) | Embedding (transparent surfaces, shared devices, on-demand frames, teardown) | implemented |
| [0053](0053-deterministic-physics-tracks.md) | Deterministic physics and recorded tracks (worker, cancellation) | implemented |
| [0054](0054-dice.md) | Dice (definitions, layouts, skins, tracks, landing on a supplied result) | implemented |
| [0055](0055-host-scenes-structure.md) | Host-driven scenes and incremental structure (mirror, chunks, upload accounting) | implemented |
| [0056](0056-modular-builds-size.md) | Modular builds and size budgets (no import side effects, feature plugins, three baseline) | implemented |
| [0057](0057-tabletop-layers.md) | Tabletop layers (ground bands, render layers, grids, vector shapes, outlines) | implemented |
| [0058](0058-projected-fog.md) | Projected fog (ordered regions, feathered masks, world-space composite) | accepted |
| [0059](0059-tabletop-tilemaps.md) | Tilemaps on the tabletop, and diffable tile data | accepted |
| [0060](0060-camera-controls-gestures.md) | Camera controls, gestures, and object drag | accepted |
| [0061](0061-ownership-recovery.md) | Ownership and failure recovery (owners, fallbacks, health) | accepted |
| [0062](0062-browser-verification.md) | Browser captures, approvals, and performance records | implemented |
| [0063](0063-lens-fields.md) | Screen-space lens fields (bounded post displacement from published fields) | implemented |
| [0064](0064-webgl2-fallback.md) | WebGL2 fallback and the baseline tier (one API, backend chosen at startup; staged, off the critical path) | accepted |
| [0065](0065-dice-entrances.md) | Dice entrances and screen effects (a result arriving through a host scene instead of a tumble; typed effects the table draws) | implemented |
| [0066](0066-curved-walls.md) | Curved walls and structure materials (arcs, Béziers, one subdivision for drawing and barriers; textured, normal-mapped walls) | implemented |
| [0067](0067-structure-groups.md) | Structure groups: levels, roofs and cutouts (hide a level or a roof without a rebuild; stairwells, hatches, skylights) | implemented |
| [0068](0068-surface-variation.md) | Surface variation and contact shade (repetition-breaking variation any material can use; noisy fake AO where walls meet walls and floors) | accepted |
| [0069](0069-interior-lighting.md) | Interior lighting (sky visibility from the plan, spill through openings, lights blocked by walls) | accepted |
| [0070](0070-view-visibility-cutaways.md) | Per-view visibility and cutaways (hide entities from one camera; cut roofs and walls open around reveal points) | draft |
