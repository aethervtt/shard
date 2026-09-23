# Use asset files

1. Put files under an asset root (`assets/`, `materials/`, `data/`). `.agents/assets.md` lists
   what each extension imports as and its settings.
2. Import: `shard import --json` (MCP `reimport_asset` with no "asset"). Fix failures by their `path`.
3. Reference by path in scenes: `"material": { "path": "materials/hull.material.json" }`.
4. Inspect with MCP `get_asset` (sub-assets, bounds, dependents, errors); change import settings
   with `reimport_asset` and `{ "settings": {...} }`.
5. Move or rename with `shard mv <from> <to>` (MCP `move_asset`), never by hand: it keeps the
   `.meta` with the file and rewrites references.
6. Look before you place: MCP `preview_asset` renders a texture, a material, or a model.

Models: place a .glb/.gltf with `"scene/SceneInstance": { "scene": { "path": "assets/ship.glb#Scene" } }`;
its nodes become children you can address by path (`ship/Hull`).

Textures: a texture's `usage` setting says what it holds: `color` (albedo, emissive; sRGB),
`data` (roughness, metallic, occlusion; linear), `normal` (tangent-space normal map), `hdr`.
New files get a usage from their name (`*_normal*`, `*rough*`, `*_orm*`, `*.hdr`). Materials
use textures through slots: `"baseColorTexture": { "texture": { "path": "assets/rock.png" } }`
(also metallicRoughnessTexture, normalTexture, occlusionTexture, emissiveTexture).
