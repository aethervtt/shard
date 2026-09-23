<!-- shard:generated -->
# star-explorer

A [Shard](https://github.com/) project. The engine is data-first: scenes are JSON validated against
component schemas, game code is ECS (components, systems) in `scripts/`.

## Commands

```sh
shard validate --json     # manifest, scenes, schemas: every error with a path
shard run --frames 600    # headless run
shard screenshot scenes/main.scene.json --out shot.png
shard test --json         # gameplay tests in tests/
shard docs                # regenerate this block, .agents/, and .shard/schemas/
shard mcp                 # MCP server for this project (see .mcp.json)
```

## Where things are

- `shard.json`: manifest (start scene: `scenes/main.scene.json`, seed 1, plugins: render/forward, input)
- `scripts/main.ts`: the project plugin; project types are named `star-explorer/<Name>`
- `scenes/`: scene files; `tests/`: gameplay tests; `shaders/`: `project::` shader modules
- `.agents/components.md`: every component and field; `.agents/errors.md`: error codes
- `.agents/skills/`: recipes for common tasks

Engine plugins available: `render` (GPU device, render graph, views, shaders); `render/forward` (cameras, meshes, standard material, lights (includes render and core/transform)); `input` (keyboard, mouse, gamepad, touch, action maps); `core/transform` (Transform and hierarchy propagation).
<!-- /shard:generated -->

## Notes

Project-specific notes for agents go here; `shard docs` keeps them.
