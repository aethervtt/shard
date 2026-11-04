# Build or change a scene

1. Read `.agents/components.md` for component names and fields.
2. Edit `scenes/*.scene.json`. Name every entity; nest with `children`. Materials go in `assets`
   (`{ "type": "Material", "value": {...} }`), meshes can be procedural
   (`{ "path": "procedural:sphere?radius=2" }`).
3. Validate: `shard validate --json` (or the MCP `validate_scene` tool). Fix every error by its `path`.
4. Look at it: `shard screenshot scenes/main.scene.json --out shot.png` (or MCP `screenshot`).
