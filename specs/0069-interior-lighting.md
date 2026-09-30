# 0069 — Interior lighting: sky visibility and wall-blocked lights

- **Status:** accepted
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

**Grid.** Each level has an R8 field over the structure's bounds, at the quality's texel
(0.25 m at `medium`). The layers share one extent and live in a `texture_2d_array`, one layer per level, which
grows (and is rebuilt) only when the bounds grow.

**Cover.** A texel is covered when it's under any of these:
- a `Roof` footprint on its level, hidden or not;
- a `Floor` of a higher level.

Cutouts (holes and skylights, 0067) uncover their outline. Uncovered texels are sources, fixed
at 1. Hiding a roof never changes the field; the host hides roofs to see inside, not to let the sky
in.

**Solve.** On covered texels, a screened diffusion: each texel is the average of its neighbours,
times a factor that sets how far spill reaches (`interior.spillReach`, 3 m by default).
- Flux doesn't cross a segment that blocks light. The segments are `planarBarriers` for the
  level: walls, closed doors, and anything else whose `light` channel (which follows `sight` when
  unset) isn't `none`.
- Light enters where barriers have gaps: open doors, windows with sight, gaps between walls.
- A wide door lets in more than a narrow one, and light goes around a corner at a diminishing
  rate. A max-flood would get both of these wrong: a crack would light a room as much as a
  doorway.
- It is solved coarse to fine (1 m, then the texel size) so it converges in a handful of passes.
- The result is blurred once, so there are no texel stairs.

It runs on the CPU, in structure's compile (deterministic, testable headless).

**Incremental.** An edit that changes cover or barriers marks a region: the union of the edit's
old and new bounds, grown by `2 × spillReach`. The region is re-solved with its border held at
the old values, and only its texels are uploaded. A door toggle marks its opening's bounds, so a
door changes the field without rebuilding any mesh chunk.

**Shading.** Core's lighting stage scales the ambient term by the fragment's sky visibility `s`:

```
ambient = mix(interiorAmbient, skyAmbient, s)      // uniform AmbientLight or IBL, whichever is on
```

`interiorAmbient` is `Level.interiorAmbient` (linear colour, cd/m²), which defaults to 5% of the
view's ambient.

- The fragment reads its level's layer: the level whose `[elevation, elevation + height)` holds its
  world y, from a small uniform table of up to 8 levels.
- It samples at `world_position + normal × texel`. A wall's inside face sits a hair from its
  outside, and without the offset an interior face would read the outdoor texel next to it and
  glow.
- Specular image light is scaled the same way, so metal indoors doesn't reflect the sky.

**Where it lives.** The lighting stage gets a define, `SKY_VISIBILITY`, which is off unless the
feature is installed. So `renderer-min`'s baked variants and bundle don't change.
- Render owns the binding and a 1×1 placeholder, as 0056 does for every feature's off state.
- `structure`'s `interiorLightingPlugin` fills them.
- Render never imports structure.

### Wall-blocked lights

`PointLight.blockedByWalls: bool` and `SpotLight.blockedByWalls: bool`, both false by default.

**Polar rows.** A blocked light gets a row in an RG16F texture, as many bins wide as
the quality sets (512 at `medium`), one row per light slot:
- A bin covers an angle around the light's (x, z).
- R is the distance to the nearest light-blocking barrier in that direction, within the light's
  range, on the light's level.
- G is that barrier's top height.

Structure fills rows on the CPU from `planarBarriers`, reading only segments in the chunks the
light's range touches. A row is rebuilt when:
- its light moves or its range changes;
- a barrier in its range changes (a door toggles, a wall is edited).

The light record carries the row index.

**Shading.** For a light with a row, in the clustered loop:

```
d = |fragment.xz − light.xz|, bin from atan2
blocked when d > R + bias, unless the light-to-fragment line clears the wall:
  y_at_wall = light.y + (fragment.y − light.y) × R / d  >  G
attenuation *= 1 − blocked         // 3 bins filtered, so the edge is soft
```

- `bias` is a quarter of the wall's thickness, capped at 5 cm. The face toward the light (d < R)
  is lit, and the face behind it (d > R + thickness / 2) is dark.
- This multiplies with a cube or spot shadow if the light has one too, so tokens still cast.
- It's a define on the same variant as sky visibility, and costs one atan2 and three texture
  reads per blocked light per fragment.

**Where it lives.** As for sky visibility: render owns the texture, its placeholder and the light
record's row field. Structure fills them.

### Settings and quality

```ts
StructureSettings.interior: {
  sky: bool,                          // sky visibility on
  blockLights: bool,                  // wall-blocked lights on
  quality: 'low' | 'medium' | 'high',
  spillReach: f32,                    // m, 3
  maxBlockedLights: u32,              // 256
}
Level.interiorAmbient: vec3           // per level; a cellar darker than a hall
```

| quality | field texel | bins per light | filter taps |
|---|---|---|---|
| low | 0.5 m | 256 | 1 |
| medium | 0.25 m | 512 | 3 |
| high | 0.125 m | 1024 | 5 |

A host maps its own quality presets onto these, alongside the switches the engine already has:
- per-light `castShadows`;
- `LightingSettings`' shadow map size and cascades;
- render scale (0051).

- **`sky: false`** frees the field and stops sampling it (a define), so ambient is as it is today.
- **`blockLights: false`** frees the rows and renders flagged lights unblocked. A host that would
  rather drop lights on a weak machine does that itself.

Each switch relinks the forward variant once; neither costs anything per frame when off. Changing
`quality` re-solves the field and rebuilds every row once.

### API sketch

```ts
import { interiorLightingPlugin, skyAt } from '@aethervtt/shard-structure'
app.addPlugins(structurePlugin, interiorLightingPlugin)
world.spawn([PointLight, { intensity: 400, range: 9, falloff: 'tabletop', bright: 4, blockedByWalls: true }], Transform)
skyAt(world, x, y, z)       // the field's value there, for tests and agents
```

### Agent surface

- `structure.describe` adds `interior`: the field's extent and texel, the last solve (its region,
  texel count and milliseconds), and the blocked lights with their rows and last rebuild.
- `structure.skyAt` (a method): sky visibility at a point.
- `Wall.light`, `Opening.light` and `Segment.light` are schema fields: a channel, unset meaning
  "as sight".
- Errors: `structure/too-many-blocked-lights` once, naming the setting. The extra lights render
  unblocked.

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
  sky light as a token walks in.

## Acceptance criteria

- [ ] A sealed roofed room has sky visibility 0 at every texel. The same room without its roof has
      1.
- [ ] A room with one window has visibility that falls monotonically with path distance from the
      window. Doubling the window's width raises the room's mean visibility.
- [ ] Toggling a door re-solves only a region within `2 × spillReach` of it, rebuilds 0 mesh
      chunks, and uploads only that region's texels.
- [ ] Hiding a roof leaves the field unchanged, byte for byte.
- [ ] An interior wall face next to an outdoor texel reads the interior's value, not 1 (the normal
      offset), in a golden at 30°.
- [ ] A torch with `blockedByWalls` lights its room and not the room behind a wall. With the door
      between them open, it lights through the doorway only (golden, top-down). A 1.2 m garden
      wall blocks the floor behind it but not a 2 m pillar's upper half.
- [ ] Moving a blocked light rebuilds only its row. Toggling a door rebuilds only the rows of
      lights whose range covers it.
- [ ] 200 blocked lights in the max fixture: rows rebuild in under 2 ms total after a door toggle.
      A frame's lighting stays within 10% of the same scene with unblocked lights.
- [ ] Without `interiorLightingPlugin`, the forward shaders and `renderer-min` are unchanged
      (bake test and `pnpm size --check`).
- [ ] `sky: false` and `blockLights: false` each free their texture, and the frame renders
      byte-identical to the same scene without the plugin.
- [ ] At `low`, the max fixture's full field solve and a frame's lighting both cost at most half
      of `medium`'s.
- [ ] The field matches a CPU reference solve within 1/255 over the max fixture.

## Open questions

- Should skylights (glass cutouts) count as full sources or be dimmed? Proposed: full; glass is
  clear.
- Is one `interiorAmbient` per level enough, or do rooms need their own (a lit hall next to a
  dark vault)? Proposed: per level first. Per-room ambient needs room detection, which this
  field approximates anyway.
