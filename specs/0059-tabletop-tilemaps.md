# 0059 — Tilemaps on the tabletop, and diffable tile data

- **Status:** implemented
- **Packages:** `@aethervtt/shard-sprite`, `@aethervtt/shard-protocol`, `@aethervtt/shard-mcp`, `apps/cli`
- **Depends on:** 0024, 0027, 0057

## Context

Shard's tilemaps (0024) draw only visible chunks and re-upload only dirty ones, and they already
place by the full world transform. For a tabletop they also have to sit correctly among floors,
tokens, walls, light, fog and 3D props, in both the Map and Tabletop views. Picking has to return
a stable tile, and tiles have to reference atlas art by something steadier than an index.

The authored format is the other gap. `TilemapData` stores each layer's cells as base64 of `u16`s.
That's compact, but an agent can't read it, and a one-tile change is an unreadable diff. That
contradicts Shard's first principle: everything is data, and the data is text.

## Goals

- Tilemaps on the floor plane, in the `tiles` ground band (0057), lit by 3D lights, receiving
  shadows, and covered by fog.
- Tile picking: the hit carries the layer, the cell and the tile.
- Tiles reference atlas regions by name through a palette, so re-packing an atlas doesn't change
  a map.
- A diffable authored encoding (chunked, run-length rows) as the default, with base64 kept as an
  option.
- Chunk-level read and edit through the protocol, MCP and CLI.

## Non-goals

- Auto-tiling rules and terrain brushes. Later.
- Isometric and hex tile layouts. The grid (0057) draws hex; tiles stay square.

## Design

### On the ground

A tilemap entity with `GroundLayer { band: 10 }` draws in the ground phase instead of the sprite
pass. Its transform lays it on the XZ plane at floor elevation (`tilemapOnGround(elevation)` gives
that rotation). Each chunk of each layer becomes a mesh of its tiles' quads (`TileChunk` children
of the tilemap, layers stacked by `GroundLayer.order`), so tiles are ordinary ground-band meshes:
culled, sorted among bands, occluded by walls and props by depth, and fogged like the rest. An
edit rebuilds only its chunk's mesh, and `GroundTiles.chunkUploads` counts them.

Tile shading is `lit: '3d'`, the `sprite/TileLit` material: flat albedo with an up normal and
roughness 1, lit by the clustered lights (including tabletop falloff), and receiving directional
and spot shadows. `lit: 'none'` (`sprite/TileUnlit`) draws the atlas as it is. On the ground there
are no 2D lights, so `lit: '2d'` (the default, and what version 1's `lit: true` migrates to) lights
it like `'3d'`; in the sprite pass it keeps meaning 0039's 2D lights. Both materials sample the
atlas isotropically, as the sprite pass does: anisotropic filtering reaches past a region's edge
at grazing angles, so a re-packed atlas would draw a different map. Their atlas field is declared
`colors: ['atlas']` (0020), so it reads through the sRGB view.

### Picking

`PickHit` gains `detail?: { kind: 'tile', tilemap, layer: string, x: number, y: number, id,
tile: string }`, where `tile` is the palette name. A host that stores tiles by name gets the same
answer after a re-pack. The detail is worked out on the CPU from the hit: a chunk knows its tilemap
and layer, and the hit position in the tilemap's space gives the cell (a tilemap in the sprite pass
reports its topmost filled layer there). So GPU picks and raycasts give the same detail, and
picking needs no extra render target on either tier. Packages add detail through
`Picking.detailers`.

Two picking fixes came with it. A ground band's pick point is its surface's own: the pick shader
writes clip z / w interpolated per fragment rather than the fragment depth, which carries the
bands' depth bias and moved a picked point up to a metre toward a grazing camera. And a grid's
lines aren't pick targets (`pickable: false` on `grid/GridLines`, 0020), so a pick reaches the
tiles under them.

### Palette

`TilemapData` gains `palette: string[]`, atlas region names in first-use order. Cells store
`palette index + 1`, with 0 as empty. At load, the palette resolves against the atlas once. A name
missing from the atlas fails validation with `sprite/unknown-tile`: its message names the layer,
the first cell using it and the name, and its path points at that cell's row in the file
(`/layers/0/chunks/1,0/5`; the layer's `tiles` in base64). Scenes and prefabs pair a tilemap
with its atlas, so `shard validate` checks every pair they place. At runtime the name draws
nothing and is logged once.

### Diffable encoding

```json
{
  "version": 2,
  "encoding": "rows",
  "chunkSize": 16,
  "palette": ["grass", "stone", "water"],
  "layers": [{
    "name": "ground", "width": 48, "height": 32,
    "chunks": {
      "0,0": ["grass*12 stone*4", "grass*11 stone:fx stone*4", "..."],
      "1,0": ["water*16", "..."]
    }
  }]
}
```

Each chunk is `chunkSize` rows from the top, and each row is space-separated runs of
`name[:flags][*count]`. Flags are `fx`, `fy` and `r90`, joined by `+`. An empty cell is `.`, and a
chunk with no cells is omitted. A one-tile edit changes one line of one chunk. Rows are at most 16
cells, so lines stay short. Runs make large fills compact: a solid 16×16 chunk is 16 short lines.

`encoding: 'base64'` stays for large generated maps, with the same palette. `shard tiles <asset>
--encoding rows|base64` converts a file in place. Loading either encoding gives the same
`TileLayer` arrays, so the renderer never sees the difference. Version 1 files (base64, no
palette) load as they are and migrate on save, which needs their atlas's names (`--atlas` on the
CLI; the protocol takes them from a Tilemap drawing the data).

### Read and edit API

Protocol methods, exposed as MCP tools:

```ts
'tilemap.read'  { asset, layer, chunk?: [cx, cy], rect?: { x, y, w, h } }   // → rows, as above
'tilemap.edit'  { asset, layer, cells?: { x, y, tile, flags? }[], fill?: { rect, tile },
                  rows?: { chunk: [cx, cy], rows: string[] }, save? }      // → { changed, saved }
```

The MCP tools are `tilemap_read` and `tilemap_edit`. Edits go through `TileLayer.set`, so they use
the existing edit log and dirty-chunk upload. They apply to the live world and, with `save: true`,
to the asset file, preserving its encoding and its `$schema` (`AssetServer.writeSource`). The
reimport that follows finds the same content and rebuilds nothing. `shard tiles read|edit <asset>`
are the CLI forms (`--layer`, `--chunk cx,cy`, `--rect x,y,w,h`, `--cell x,y=name[:flags]`,
`--fill x,y,w,h=name`, `--row`); they work on the file, without running the game.

### Baseline tier (0064)

Tile cells reach the sprite pass's shader through `shard::data` accessors: storage on the full
tier, a `rgba32uint` data texture on baseline, updated by the same dirty-chunk uploads. Ground
tiles are meshes with a standard-lit or unlit material, so they need nothing of their own there,
and pick detail is worked out on the CPU on both tiers.

### Agent surface

This spec is mostly agent surface: `tilemap.read` and `tilemap.edit`, a readable file format, and
validation errors that name the cell.

## Decisions

- **Palette names, not atlas indices.** Indices change when an atlas is re-packed; names are how an
  author, or an agent, refers to a tile.
- **Chunked run-length rows, not one string per layer row.** Short lines give small diffs and let
  an agent read one chunk at a time. Runs keep large fills small.
- **Tiles in the ground phase, not the sprite pass.** The ground phase is what orders them among
  bands and against 3D geometry in both views.

## Acceptance criteria

- [x] A 48×32 map round-trips base64 → rows → base64 byte-identical, and so does version 1 → 2
      with a palette.
- [x] Changing one tile and saving changes exactly one line of the rows file.
- [x] Re-packing the atlas (a different region order) leaves the rendered map identical, and
      picking returns the same tile names.
- [x] Picking a cell in each view returns its layer, `x`, `y` and tile name, over 100 random cells.
- [x] On the parity fixture (0057), tiles draw under the grid and tokens, are hidden behind walls,
      are lit by a tabletop point light, receive a prop's shadow, and are covered by fog, in both
      views (golden captures).
- [x] `tilemap.edit` of 10 cells uploads only the chunks containing them (`chunkUploads`).
- [x] An unknown tile name fails validation with the layer, the cell and the name in the error
      (the message names all three; the path points at the cell's row).

## Open questions

- Should rows files store animation frames in the palette (`water@anim`)? Proposed: no.
  Animations stay a separate list keyed by palette name.
