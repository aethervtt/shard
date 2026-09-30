<!-- shard:generated -->
# star-explorer

A [Shard](https://github.com/) project. The engine is data-first: scenes are JSON validated against
component schemas, game code is ECS (components, systems) in `scripts/`.

## Commands

```sh
shard validate --json     # manifest, assets, scenes: every error with a path
shard import --json       # import new and changed asset files
shard mv <from> <to>      # move an asset and rewrite references to it
shard run --frames 600    # headless run
shard screenshot scenes/main.scene.json --out shot.png
shard test --json         # gameplay tests in tests/
shard check --json        # type-check scripts: file, line, column
shard gen <generator> --seeds 1-9 --out sheet.png   # preview a generator's outputs
shard dev                 # play it in a browser; saves hot reload in place
shard capture plan.json   # real-browser shots and perf records; then compare, approve, perf-check
shard docs              # regenerate this block, .agents/, and .shard/schemas/
shard mcp                 # MCP server for this project (see .mcp.json)
```

## Where things are

- `shard.json`: manifest (start scene: `scenes/main.scene.json`, seed 1, plugins: render/forward, input, audio, ui, physics3d, terrain)
- `scripts/main.ts`: the project plugin; project types are named `star-explorer/<Name>`
- `scenes/`: scene files; `tests/`: gameplay tests; `shaders/`: `project::` shader modules
- `generators/`: `*.gen.json` generator outputs; `.agents/generators.md`: every generator and its params
- `assets/`, `materials/`, `data/`, `prefabs/`, `locales/`, `generators/`: asset files, each with a `.meta` (guid, import settings)
- `.agents/components.md`: every component and field; `.agents/assets.md`: importers and
  project data types;
  `.agents/errors.md`: error codes
- `.agents/skills/`: recipes for common tasks

Engine plugins available: `render` (GPU device, render graph, views, shaders); `render/forward` (cameras, meshes, standard material, lights (includes render and core/transform)); `sprite` (sprites, atlases, frame animation, tilemaps (includes render/forward)); `text` (Text and ScreenText with imported fonts (includes render/forward)); `particles` (GPU particle effects from *.particles.json (includes render/forward)); `animation` (AnimationPlayer: glTF and .anim.json clips on joints and fields, blending, root motion; Animator graphs from .animgraph.json (includes render/forward)); `physics3d` (Rapier 3D rigid bodies, colliders, joints, raycasts (includes core/transform)); `physics2d` (Rapier 2D physics in the XY plane (includes core/transform)); `input` (keyboard, mouse, gamepad, touch, action maps); `audio` (AudioSource, AudioListener, playSound, buses and ducking, spatial audio, voice limits (includes core/transform)); `ui` (UiNode trees under a UiRoot: flexbox layout, text, images, buttons, sliders, text fields, world-anchored markers, themes (includes core/transform)); `nav` (navigation: NavGrid A* (2D), NavMesh baked by Recast from NavSource geometry, OffMeshLink, path queries, NavAgent steering (includes core/transform)); `nav/grid` (navigation on NavGrids only, without loading the Recast WASM (includes core/transform)); `terrain` (planets: Planet cube-sphere terrain from noise graphs with LOD, geomorphing, oceans, biomes, collider chunks around characters, navmeshes on the surface; terrain.* methods (includes core/transform; add render/forward to draw it, physics3d for colliders)); `dice` (the dice table (0054): dice skins, face layouts and effect recipes as data, dice.play and dice.describe, dice/RollRequest in scenes; tracks record on the calling thread (includes render/forward)); `core/transform` (Transform and hierarchy propagation).
<!-- /shard:generated -->

## Notes

Project-specific notes for agents go here; `shard docs` keeps them.
