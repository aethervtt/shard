# 0069 — Interior lighting: sky visibility and wall-blocked lights

- **Status:** implemented
- **Packages:** `@aethervtt/shard-structure`, `@aethervtt/shard-render`
- **Depends on:** 0018, 0055, 0057, 0067

## Context

Structure builds rooms, but lighting doesn't know they're rooms. Today the sun lights an interior
as if it had no roof, and the ambient term (the `AmbientLight`, or the environment's image-based
light) is as strong inside a sealed cellar as in an open field.

0067 fixes the sun. A roof hidden with `shadowWhenHidden` still casts, so direct sunlight reaches
an interior only through its openings, and a patch of sun under a window comes from the cascades
as it is. Two things are still wrong, and a third matters as soon as a table has torches.
Today's tables are lit by ambient light alone (with 0068's contact shade), so the first two pay
off immediately. The third is the goal for torches and lamps, if it's cheap enough:

1. **Sky light indoors.** Ambient is uniform, so a hidden-roof interior looks lit at noon from
   everywhere at once. It should be darker the deeper you are from an opening, and dark in a room
   with none.
2. **Spill from openings.** Light coming through a window or an open door should fall off into the
   room and go around corners weakly. A closed door should cut it.
3. **Lights through walls.** A torch in one room lights the next through the wall. Point-light
   shadows (0018) stop it, but only four point lights get shadow maps, a cube map each, and a
   tavern has dozens of torches. A VTT's walls are vertical extrusions of a plan, so the plan
   answers "does this wall block this light" much more cheaply than a cube map does. It's how 2D
   tables block light, lifted to 3D.

## Goals

- **Sky visibility.** A per-level 2D field over the plan:
  - 1 outdoors, 0 in a sealed room, and in between where light spills through openings;
  - it scales ambient and image-based light for every lit surface (tokens and props included);
  - an interior ambient keeps sealed rooms from going black.
- **Wall-blocked lights.** Point and spot lights flagged to be blocked by walls are occluded by
  their level's sight barriers, with low walls only blocking what's below them. There's no
  shadow-map budget: each light costs one texture row.
- **Incremental.** A door toggle re-solves only the field near the door, and only the rows of the
  lights in range. Walls change rarely; tokens carrying lights move often.
- **Opt-in by structure.** With no roofs, and no light asking to be blocked, the frame is
  unchanged, and `renderer-min` stays the same size.

## Non-goals

- Global illumination: light bouncing off lit surfaces, or colour bleeding. The interior ambient
  is one colour per level.
- Tokens and props blocking lights. They use real shadows (0018), which combine with this.
- Tinted light through glass, volumetric shafts, dust.
- Deciding which lights are torches. The host flags lights; the Aether adapter decides for its
  documents.

## Design

### Shaded in 3D, occluded from the plan

Everything here renders and shades in 3D:
- Lights are 3D points with 3D falloff.
- Surfaces use their 3D normals, and highlights their view direction.
- The sun and any shadowed light keep their 3D shadow maps.

The result doesn't depend on the camera, so it looks the same from the map view's tilted
orthographic camera as from a perspective orbit. It is not a 2D lighting pass painted onto the
floor.

What comes from the plan is the occlusion. Structure is a plan extruded upward:
- walls: a centreline, thickness, base and height;
- openings: a span, a sill and a head;
- floors and roofs: polygons at a height.

So two questions can be answered from the plan plus heights (2.5D), without rendering the scene
from each light: "how much sky reaches this point", and "is there a wall between this light and
this point". The plan is exact for walls. What it doesn't cover:

- **Occluders not in the plan.** Tokens, props and furniture don't block a light's row. They use
  real shadows (0018), which multiply with the row, so a light can have both.
- **Height inside a room.** Sky visibility is one value per plan point per level: a point at head
  height near a window reads the same as the floor below it. In rooms a few metres tall, spill
  varies far more across the floor than up the wall.
- **Across levels.** A blocked light lights only its own level. Light falling down a stairwell into
  the level below is a non-goal for now. Without the rule, a torch upstairs would light the room
  under it through the floor, because floors aren't barriers.

### Sky visibility field

**Grid.** Each level has a field over the structure's bounds, at the quality's texel (0.25 m at
`medium`). The layers share one extent: the bounds plus a quarter of their size (at least 4 m) each
way, on whole metres. It is made again (and solved whole) only when the bounds outgrow it, the
quality or the spill reach changes, or levels move. Layer 0 is the ground level's (pieces with no
`Level`); each `Level`, by elevation, gets the next, up to 8.

A texel is 32 bits: its visibility (14 bits), whether flux to its +x and +z neighbours is blocked
(2 bits), and its cover's top height over the level's floor (16 bits, 1/64 m; 0 for uncovered).

**Cover.** A texel is covered when its centre is under any of these:
- a `Roof` footprint on its level, hidden or not;
- a `Floor` of a higher level (one whose level's elevation is above this level's).

Holes and skylights uncover their outline; a closed hatch covers, an open one uncovers.
Uncovered texels are sources, fixed at 1. Hiding a roof never changes the field; the host hides
roofs to see inside, not to let the sky in.

**Solve.** On covered texels, a screened diffusion (∇²u = u / L², L = `interior.spillReach`, 3 m
by default): each texel is the sum of the neighbours it isn't walled off from, over their count
plus h² / L² (h the texel).
- Flux doesn't cross a segment that blocks light. The segments are `planarBarriers` for the
  level: walls, closed doors, and anything else whose `light` channel (which follows `sight` when
  unset) isn't `none`. A link between two texel centres is blocked when a segment touches it, ends
  included, so walls meeting at a corner leave no crack.
- Light enters where barriers have gaps: open doors, windows with sight, gaps between walls.
- A wide door lets in more than a narrow one, and light goes around a corner at a diminishing
  rate. A max-flood would get both of these wrong: a crack would light a room as much as a
  doorway.
- A whole field is solved coarse to fine. First covered texels are grouped into ~1 m blocks, split
  where a wall crosses one, and that system is solved. Then successive over-relaxation runs at the
  texel size, in 16×16 tiles that stop being swept once they and their neighbours settle.
- The result is blurred once (each texel with the neighbours it isn't walled off from), so there
  are no texel stairs.

It runs on the CPU (deterministic, testable headless), in `structure/interior`, a system after
light extraction that reads structure's compiled walls, openings, floors, roofs and cutouts.

On the max fixture with a roof over every block (225 m square, 810,000 texels at `medium`) a
whole-field solve takes about 310 ms on an Apple M4 (92 sweeps), and 115 ms at `low`.

**Incremental.** An edit that changes cover or barriers marks a region: the bounds of what changed,
grown by `2 × spillReach`. For a wall, that's the barriers that differ before and after, so a door
toggle marks its opening's span alone. The region is re-solved from its old values with its border
held, and only its texels (and one around it, for the blur) are uploaded. A door toggle changes
the field without rebuilding any mesh chunk; on the max fixture it re-solves about 1,000 texels in
0.6 ms.

**Shading.** Core's lighting stage scales the ambient term by the fragment's sky visibility `s`:

```
ambient = sky × (s + (1 − s) × fill) + albedo × interiorAmbient × (1 − s)
          // sky: the uniform AmbientLight or IBL, whichever is on, already shaded
```

`Level.interiorAmbient` (linear colour, cd/m², default 0) and `Level.interiorFill` (default 0.05)
light what the sky doesn't reach: by default, 5% of the view's ambient. The ground level uses the
defaults.

- The fragment reads its level's layer: the level whose `[elevation, elevation + height)` holds its
  world y, from a small uniform table of up to 8 levels; any other y reads the ground level's.
- It reads at `world_position + normal × texel`. A wall's inside face sits a hair from its
  outside, and without the offset an interior face would read the outdoor texel next to it and
  glow.
- A point at or above its texel's cover is outdoors (1): a roof's top, or a floor's top on the
  level above.
- It filters between the four texel centres around the point, keeping only those it reaches
  without crossing a blocked link: light never bleeds through a wall. At `low` it reads the nearest
  texel alone.
- Specular image light is scaled the same way, so metal indoors doesn't reflect the sky.

**Where it lives.** The lighting stage gets a define, `SKY_VISIBILITY`, off unless a provider turns
it on. So `renderer-min`'s baked variants don't change.
- Render's `interiorPlugin` (`render/interior`, in `forwardPlugin`) owns the texture, a 1×1
  placeholder, the level table and the WGSL (`shard::interior`).
- `structure`'s `interiorLightingPlugin` fills them, and switches each part on while it has data:
  sky visibility while something is covered, blocked lights while a light has a row.
- Render never imports structure.
- The view bind group grows by two bindings (the texture, and the table) only while a part is on.
  Group 0 and every material's group 1 share a stage's 16 sampled textures, and on the baseline
  tier a standard material's fragment stage already uses 15. So the field and the rows share one
  `r32uint` texture array, read with `textureLoad` (the WebGL2 shim has no `rg16uint`). With both
  parts off, group 0's layout and bind group are what they are without the plugin.

### Wall-blocked lights

`PointLight.blockedByWalls: bool` and `SpotLight.blockedByWalls: bool`, both false by default.
Without `interiorPlugin` such a light logs `render/feature-missing` once and lights through walls.

**Polar rows.** A blocked light gets a row of as many bins as the quality sets (512 at `medium`),
in the texture's layers after the field's:
- A bin covers an angle around the light's (x, z).
- Its low 16 bits are the distance to the nearest light-blocking barrier along the bin's centre,
  within the light's range, on the light's level, plus the bias (1/256 m; all ones for none).
- Its high 16 bits are that barrier's top, relative to the light's height (1/256 m).
- A window whose light channel is `none` is a gap for the field, but still blocks a blocked light
  below its sill.

Structure fills rows on the CPU from `planarBarriers`, reading only walls in index cells (4 m) the
light's range touches. A row is rebuilt when:
- its light moves, or its range or level changes;
- a barrier in its range changes (a door toggles, a wall is edited).

The light record carries the row, as row + 1, in a word its kind never reads: a point light's
spot scale, a spot's tabletop bright radius (spots always fall off physically). The `Light` struct
is unchanged, so shaders without the define link the same code.

**Shading.** For a light with a row, in the clustered loop:

```
d = |receiver.xz − light.xz|, bin from atan2     // receiver: the fragment moved 5 cm off its surface
blocked when on another level, or d > R (R includes the bias), unless the line clears the wall:
  y_at_wall = light.y + (receiver.y − light.y) × R / d  >  G
attenuation *= 1 − blocked         // the quality's taps (1, 3, 5 bins), so the edge is soft
```

- `bias` is a quarter of the wall's thickness, capped at 5 cm. The face toward the light (d < R)
  is lit, and the face behind it (d > R + thickness / 2) is dark.
- The receiver and its level are found once per fragment, before the light loop.
- This multiplies with a cube or spot shadow if the light has one too, so tokens still cast.
- It's a define of its own, `BLOCKED_LIGHTS`, and costs one atan2 and the quality's taps per
  blocked light per fragment.

**Where it lives.** As for sky visibility: render owns the texture, its placeholder and the light
record's row word. Structure fills them.

### Settings and quality

```ts
StructureSettings.interior: {
  sky: bool,                          // sky visibility on (default true)
  blockLights: bool,                  // wall-blocked lights on (default true)
  quality: 'low' | 'medium' | 'high', // medium
  spillReach: f32,                    // m, 3
  maxBlockedLights: u32,              // 256
}
Level.interiorAmbient: vec3           // per level; a cellar darker than a hall
Level.interiorFill: f32               // the share of the sky's ambient kept indoors, 0.05
```

| quality | field texel | bins per light | filter taps | sky filter |
|---|---|---|---|---|
| low | 0.5 m | 256 | 1 | nearest texel |
| medium | 0.25 m | 512 | 3 | four texels, barrier-aware |
| high | 0.125 m | 1024 | 5 | four texels, barrier-aware |

A host maps its own quality presets onto these, alongside the switches the engine already has:
- per-light `castShadows`;
- `LightingSettings`' shadow map size and cascades;
- render scale (0051).

- **`sky: false`** frees the field (texture and CPU) and stops sampling it (a define), so ambient
  is as it is today.
- **`blockLights: false`** frees the rows and renders flagged lights unblocked. A host that would
  rather drop lights on a weak machine does that itself.

Each switch relinks the forward variant once; neither costs anything per frame when off. Changing
`quality` re-solves the field and rebuilds every row once.

### API sketch

```ts
import { interiorLightingPlugin, skyAt } from '@aethervtt/shard-structure'
app.addPlugins(structurePlugin, interiorLightingPlugin)
world.spawn([PointLight, { intensity: 400, range: 9, falloff: 'tabletop', bright: 4, blockedByWalls: true }], Transform)
skyAt(world, x, y, z)       // the field's texel there (1 outdoors), for tests and agents
```

### Agent surface

- `structure.describe` adds `interior`: the settings, which parts are on, the field's extent,
  texel, size and layers, the levels' layers, the last solve (whole or its regions, texels,
  sweeps, texels uploaded, milliseconds), the last row rebuild, and the blocked lights with their
  rows and last rebuild.
- `render.describe` adds `interior`: the parts on, the texture's size and bytes.
- `structure.skyAt` (a method): sky visibility at a point.
- `Wall.light` and `Opening.light` are schema fields: `sight` (unset, the default), `normal` or
  `none`. `planarBarriers` takes `light` on walls and openings, and sets `Segment.light` only when
  one is set (`lightChannel(segment)` reads either).
- Errors: `structure/too-many-blocked-lights` once, naming the setting. The extra lights render
  unblocked. `structure/too-many-levels` once past 8 levels: the highest read as outdoors.

## Decisions

- **The sun needs no new work.** A roof that keeps casting (0067) already confines sunlight to its
  openings.
- **A field over the plan, not probes or screen-space GI.** Walls are extrusions of a plan, so a
  2D solve captures what matters (rooms, openings, doors) at a tiny fraction of the cost. It's
  deterministic and testable without a GPU.
- **Diffusion, not a flood fill.** Spill scales with the size of the opening, and it dims around
  corners.
- **Polar rows, not cube shadows, for walls.** It costs one row per light and has no four-light
  cap, and it's exactly as sharp as the plan. Real shadows stay for 3D occluders.
- **A light channel that defaults to sight.** Walls and openings gain `light` alongside `sight` and
  `movement`. Left unset, it follows `sight`, so a host with no light-specific barriers writes
  nothing. One that has them (a curtain that blocks sight but not light, glass that does the
  opposite) sets it.
- **Hidden roofs don't change the field.** Hiding is for the viewer; it mustn't flood a room with
  sky light as a token walks in. A `Roof.cutaway` roof (0070) is whole too: shadows and the field
  never see the cut.
- **One texture, bound only while on.** A fragment stage holds 16 sampled textures, which group 0
  and a material's group 1 share, and the baseline tier's standard material already uses 15. The
  field and the rows share one `r32uint` array, and group 0 grows by it (and the table) only while
  a part is on, so materials keep their room otherwise.
- **The row rides in an unread word.** The light record was full (80 bytes), and any new field
  would have changed the `Light` struct and every shader. A point light never reads its spot scale,
  a spot never reads its tabletop radius.
- **Cover heights in the field.** One value per plan point can't tell a roof's top from the room
  under it. With the cover's height, a point above it reads outdoors, which also covers a level's
  floor seen from the level above.
- **A barrier-aware filter, not bilinear.** Bilinear filtering reaches texels across a wall, and a
  floor along an interior wall would pick up the sky outside. The filter keeps only the texels the
  point reaches without crossing a blocked link.
- **`interiorFill` beside `interiorAmbient`.** "5% of the view's ambient" depends on the view (a
  uniform ambient or an environment), so it's a share the shader applies, not a colour.
- **Skylights are full sources; one interior ambient per level** (the open questions, as proposed).
  Glass is clear, and per-room ambient would need room detection, which the field approximates.

## Acceptance criteria

Timings are from an Apple M4 (Metal), GPU time from timestamps, as the median of interleaved
rounds (`structure/src/interior-max.test.ts`); they're asserted under `pnpm bench`.

- [x] A sealed roofed room has sky visibility 0 at every texel. The same room without its roof has
      1.
- [x] A room with one window has visibility that falls monotonically with path distance from the
      window. Doubling the window's width raises the room's mean visibility.
- [x] Toggling a door re-solves only a region within `2 × spillReach` of it, rebuilds 0 mesh
      chunks, and uploads only that region's texels.
- [x] Hiding a roof leaves the field unchanged, byte for byte (and so does `Roof.cutaway`).
- [x] An interior wall face next to an outdoor texel reads the interior's value, not 1 (the normal
      offset), in a golden at 30°.
- [x] A torch with `blockedByWalls` lights its room and not the room behind a wall. With the door
      between them open, it lights through the doorway only (golden, top-down). A 1.2 m garden
      wall blocks the floor behind it but not a 2 m pillar's upper half.
- [x] Moving a blocked light rebuilds only its row. Toggling a door rebuilds only the rows of
      lights whose range covers it.
- [x] 200 blocked lights in the max fixture: rows rebuild in under 2 ms total after a door toggle
      (0.05 ms: one row). A frame's lighting stays within 10% of the same scene with unblocked
      lights (+2% to +7% across runs at 1280×720).
- [x] Without `interiorLightingPlugin`, the forward shaders link byte-identical code
      (`scripts/wgsl-identity.mjs`, and `renderer-min`'s bake: one module's hash changes, its
      source gained `@if` lines). `renderer-min`'s JS grows 1.6 KB brotli (158.3 to 159.9 KB: the
      light field, the view layout's choice, the define plumbing), within its budget.
- [x] `sky: false` and `blockLights: false` each free their texture, and the frame renders
      byte-identical to the same scene without the plugin.
- [x] At `low`, the max fixture's full field solve and a frame's lighting both cost at most half
      of `medium`'s. The solve: 115 ms against 311 ms. On the max fixture, interior lighting's
      share of a frame (drawing 5000 walls) is under the timing's noise, so the lighting is
      measured where it dominates: a roofed room grid filling 1280×720 top-down, 96 blocked torches
      in range of every pixel, +85% at `low` against +191% at `medium`.
- [x] The field matches a CPU reference solve within 1/255 over the max fixture (0.05/255 at
      worst).

## Open questions

None left. Skylights count as full sources, and each level has one interior ambient (with its
fill share), as proposed.
