# 0059 — Tilemaps on the tabletop, and diffable tile data

- **Status:** draft
- **Packages:** `@shard/sprite`, `@shard/protocol`, `@shard/mcp`, `apps/cli`
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
that rotation). In the ground phase, tile shading is `lit: '3d'`: flat albedo with an up normal and
roughness 1, lit by the clustered lights (including tabletop falloff), and receiving directional
and spot shadows. Walls and props occlude it by depth, as for every band, and fog composites over
it. `lit: 'none'` stays for unlit maps, and `lit: '2d'` for 0039's 2D lights in 2D games.

### Picking

The tilemap's pick drawer writes the cell index and layer into the pick buffer's detail channel.
`PickHit` gains `detail?: { kind: 'tile', layer: string, x: number, y: number, tile: string }`,
where `tile` is the palette name. A host that stores tiles by name gets the same answer after a
re-pack.

### Palette

`TilemapData` gains `palette: string[]`, atlas region names in first-use order. Cells store
`palette index + 1`, with 0 as empty. At load, the palette resolves against the atlas once. A name
missing from the atlas fails validation with `sprite/unknown-tile`, naming the layer, the cell
and the name.

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
palette) load as they are and migrate on save.

### Read and edit API

Protocol methods, exposed as MCP tools:

```ts
'tilemap.read'  { asset, layer, chunk?: [cx, cy], rect?: { x, y, w, h } }   // → rows, as above
'tilemap.edit'  { asset, layer, cells?: { x, y, tile, flags? }[], fill?: { rect, tile },
                  rows?: { chunk: [cx, cy], rows: string[] } }             // → changed cell count
```

Edits go through `TileLayer.set`, so they use the existing edit log and dirty-chunk upload. They
apply to the live world and, with `save: true`, to the asset file, preserving its encoding.
`shard tiles read|edit` are the CLI forms.

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

- [ ] A 48×32 map round-trips base64 → rows → base64 byte-identical, and so does version 1 → 2
      with a palette.
- [ ] Changing one tile and saving changes exactly one line of the rows file.
- [ ] Re-packing the atlas (a different region order) leaves the rendered map identical, and
      picking returns the same tile names.
- [ ] Picking a cell in each view returns its layer, `x`, `y` and tile name, over 100 random cells.
- [ ] On the parity fixture (0057), tiles draw under the grid and tokens, are hidden behind walls,
      are lit by a tabletop point light, receive a prop's shadow, and are covered by fog, in both
      views (golden captures).
- [ ] `tilemap.edit` of 10 cells uploads only the chunks containing them (`chunkUploads`).
- [ ] An unknown tile name fails validation with the layer, the cell and the name in the error
      path.

## Open questions

- Should rows files store animation frames in the palette (`water@anim`)? Proposed: no.
  Animations stay a separate list keyed by palette name.
