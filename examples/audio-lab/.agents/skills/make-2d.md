# Make 2D: sprites, animation, tilemaps

Add `"sprite"` to `plugins` in `shard.json`. 2D uses the same renderer as 3D (HDR, post effects).

1. An atlas. Either drop images in a folder and add `assets/sprites/hero.atlas-pack.json`
   (`{}` packs `assets/sprites/hero/*.png`; regions are the file names), or write
   `hero.atlas.json`: `{ "texture": { "path": "assets/sheet.png" }, "grid": { "columns": 8,
   "rows": 4, "cellWidth": 16, "cellHeight": 16 } }` (regions `cell0`, `cell1`, …) and/or
   `"regions": [{ "name": "idle_0", "rect": [x, y, w, h] }]`.
2. A sprite: `"sprite/Sprite": { "atlas": { "path": "assets/sprites/hero.atlas-pack.json" },
   "region": "idle_0", "layer": 1 }`. No `size`: pixels ÷ `Sprite2dSettings.pixelsPerUnit` (100).
   Higher `layer` draws on top; within a layer, higher z does. `"space": "screen"` makes an
   overlay positioned in pixels.
3. Animation: `walk.clip.json` = `{ "atlas": {...}, "frames": [{ "region": "walk_0",
   "duration": 0.1 }, ...], "loop": "loop", "events": [{ "frame": 2, "name": "step" }] }`, then
   `"sprite/SpriteAnimation": { "clip": { "path": "assets/walk.clip.json" } }`. Read events with
   `world.reader(SpriteAnimationEvent)`.
4. Tilemaps: `level.tilemap.json` names tiles by atlas region in a `palette`, and stores each layer
   as `chunks` of rows: `"0,0": ["grass*12 stone*4", "grass stone:fx . water*13"]` (runs of
   `name[:flags][*count]`, `.` empty, flags `fx`/`fy`/`r90` joined by `+`), then
   `"sprite/Tilemap": { "atlas": ..., "data": ..., "tileSize": [1, 1] }`. Read and edit cells by
   name with MCP `tilemap_read` / `tilemap_edit` (live; `save: true` writes the file) or
   `shard tiles read|edit`; `shard tiles <file> --encoding base64` compacts a big generated map.
   In code: `setTile(world, map, x, y, data.tileId('stone'))`; only that chunk re-uploads. On a
   tabletop, add `"render/GroundLayer": { "band": 10 }` and lay it flat (`tilemapOnGround()`'s
   rotation): it draws among the ground bands, lit by 3D lights, and picks return the cell.
5. Pixel art: `"render/PixelPerfect": { "pixelsPerUnit": 16 }` on an orthographic camera.
6. Check: `shard validate`, MCP `preview_asset` on the atlas (regions outlined and numbered) or
   the clip, and `render.describe` → `sprites` (draw calls, sprites per layer, tilemap chunks).
7. Lights and shadows: see `light-2d.md`.
