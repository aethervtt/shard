# 0070 — Per-view visibility and cutaways

- **Status:** draft
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-structure`
- **Depends on:** 0007, 0056, 0057, 0067

## Context

Hiding is per world today: `Visibility` hides an entity from every camera, and render layers (0057)
pick which cameras draw a renderable from 16 fixed classes. Two common needs fall between them.

**Hide this, from this view.**
- A first-person body its own camera mustn't draw, though it still casts a shadow.
- Split screen, where each player's camera leaves out their own marker.
- An editor viewport beside the game view.
- A game master previewing what one player sees, next to their own view.

Layers can't express these: they are classes, not entities, and there are 16 of them. Unreal's
per-view hidden actors and "owner no see" exist for the same reasons.

**Open a hole to see through.** Top-down and isometric games cut roofs and walls away around the
characters the player follows, instead of hiding the whole building. The building's outline stays,
walls in front of a token in an orbit view open up, and foliage over a character thins out.
Structure's roofs (0067) hide per group. A cutaway is the finer tool, and it is per view by nature:
the points to reveal belong to the camera.

Both are generic. A VTT uses them for the players' tokens under roofs and a game master's preview.
Any top-down game uses them for its party.

## Goals

- **`ViewVisibility` on a camera.** It lists entities that camera doesn't draw, with their
  descendants.
  - Other cameras are unaffected, and shadows still cast by default.
  - The GPU and CPU culls agree.
  - A camera without the component costs nothing new.
- **`Cutaway` on renderables, and `CutawayView` on a camera.** Up to 16 reveal points: where a
  cutaway surface stands between the camera and a point, within a radius, it isn't drawn.
  - It applies in every camera pass: forward, depth prepass, G-buffer and picking, so a click
    through the hole reaches the token.
  - Shadows are unaffected.
  - A soft edge, by dithering, needs no blending.
- **Structure opts in** with `Roof.cutaway` and `StructureSettings.cutawayWalls`, which tag the
  groups' meshes.
- **Nothing changes without the features.** `renderer-min` and its baked shaders stay as they are:
  cutaway is a plugin (0056), and the hidden-set check is a define.

## Non-goals

- Deciding what to hide or reveal. The host picks the entities and points: a player's own tokens,
  the party, the selected character.
- Fading whole meshes with alpha (transparency sorting, overdraw). A dither edge covers the soft
  look without it.
- Occlusion queries, such as automatically revealing whatever hides a point. The points are given.
- Per-view `Visibility` modes (`only`, show-only lists). See the open questions.

## Design

### Per-view hiding

```ts
ViewVisibility {                         // on a Camera3d
  hide: list(entity),                    // these and their descendants aren't drawn by this camera
  shadows: 'keep' | 'hide',              // keep (default): they still cast into its shadow maps
}
```

**Resolving the list.** The camera's list resolves to a set of instance slots: every renderable
under a listed entity, walked through `Children`. It is re-resolved only when:
- the list changes;
- a listed subtree changes (a `ChildOf` change under it, or a slot allocated or freed);
- nothing else. A still frame does no work.

**Culling.** A view with a hidden set gets a bitset of slots, one bit each, in a storage buffer.
- The GPU culler reads it through a new `CullView.hidden_base`; `0xffffffff` means none, and fits a
  padding word.
- The CPU cull reads the same bits.
- Only the words that changed upload.

The camera's colour, depth, G-buffer and picking views test it. Its shadow views test it only with
`shadows: 'hide'`.

**Cost.**
- Memory: `capacity / 8` bytes per camera with a list, 12.5 KB at 100k slots.
- Per frame: one bit read per candidate slot, in views that have a list.
- Views without a list skip the test, through a define: the baked variants don't change.

It composes with what exists:
- `Visibility` hides from every view;
- render layers pick classes per view;
- `ViewVisibility` removes named subtrees from one view;
- `ShadowWhenHidden` (0067) is unaffected.

### Cutaways

```ts
Cutaway { }                              // tag on a renderable: it may be cut away
CutawayView {                            // on a Camera3d
  points: list(vec3),                    // at most 16; more are ignored with a warning
  radius: f32,                           // metres around each point's line of sight
  margin: f32,                           // how far in front of a point a cut starts (keeps its floor)
  edge: f32,                             // metres of dithered edge; 0 is a hard cut
}
```

A fragment of a `Cutaway` renderable is removed in a camera's views when, for some reveal point
`p`:

```
it lies within radius of the line from the eye through p
  (orthographic: the view direction's line through p),
and it's nearer the camera than p by more than margin
```

- The edge is an ordered dither over `edge` metres, so it needs no sorting and stays opaque.
- The `margin` keeps the floor a token stands on, and a stairwell's rim, from being cut.
- From above, a roof opens a round hole over each token. In an orbit view, the wall between the
  camera and a token opens.

**Where it runs.** A plugin, `cutawayPlugin`, depends on `render/forward` and registers
`shard::cutaway`.
- Its module is linked, by a define, into the forward, prepass, G-buffer and picking variants of
  materials that draw cutaway instances.
- Shadow variants never link it, so a cut roof still casts, and 0069's interior stays dark.
- The points go into a small per-camera uniform, which uploads only when it changes.
- The instance needs a flag. The flags byte is full (`ShadowOnly` took its last bit), so slot flags
  widen to 16 bits and `Cutaway` rides in bit 28 of the record's flags word. Bits 24–27 carry the
  LOD when read.
- Without the plugin, a `Cutaway` tag logs `render/feature-missing` once, and the mesh draws whole.

**Structure.**
- `Roof.cutaway: bool` tags a roof's chunk meshes, as `shadowWhenHidden` does.
- `StructureSettings.cutawayWalls: bool` tags wall chunk meshes: the pieces a wall draws, frames
  and leaves included, so a door in the cut goes with its wall.

Hosts combine them as they like. For example, hide the roof of the building a player's token is in,
and cut away the neighbours' roofs and the walls in front of the token.

### API sketch

```ts
import { ViewVisibility } from '@aethervtt/shard-render'
import { Cutaway, CutawayView, cutawayPlugin } from '@aethervtt/shard-render'
app.addPlugins(cutawayPlugin)
world.add(preview, ViewVisibility, { hide: [gmOnlyNotes, secretDoorsGroup] })
world.add(camera, CutawayView, { points: myTokens.map(worldPos), radius: 2.5, margin: 0.6, edge: 0.3 })
world.set(roof, Roof, { cutaway: true })
```

### Agent surface

- `render.describe` adds, per camera:
  - its hidden entities and the slot count they resolve to;
  - its reveal points, radius and edge.
- `ViewVisibility`, `Cutaway`, `CutawayView`, `Roof.cutaway` and
  `StructureSettings.cutawayWalls` are schema components and fields.
- Errors:
  - `render/too-many-reveal-points` (once, naming the camera);
  - `render/feature-missing` for `Cutaway` without the plugin.

## Decisions

- **Entities, not more layers.** A hidden list names what the host means: this token, this group.
  Layers stay the tool for classes of visuals.
- **A bitset per view, not a per-slot mask of views.** The cost lands only on views that use it,
  and the number of cameras is unbounded.
- **Shadows kept by default.** A body its own camera doesn't draw still casts, and a roof a player
  sees through still darkens the room. That's the common case, and the one that keeps lighting the
  same on every screen.
- **Dither, not alpha.** Cut surfaces stay opaque: no sorting, and depth and picking stay right.
- **Cutaways in every camera pass, never in shadows.** If the prepass or picking still saw the
  hole, it would hide the token or eat its clicks.

## Acceptance criteria

- [ ] Two cameras on one scene, one hiding a group: the hiding camera never draws it and the other
      always does, on the GPU and CPU culls alike. Its shadows still fall in both views (golden).
- [ ] Changing a hide list uploads only the bitset words that changed. A still frame with lists on
      three cameras uploads nothing and allocates nothing.
- [ ] A camera without `ViewVisibility` renders byte-identical to before, and `renderer-min`'s bake
      and size are unchanged.
- [ ] A cutaway roof over a token opens a disc of `radius` around the token from above (golden) and
      a hole along the line of sight at 30° (golden). The floor under the token is not cut, and the
      room below stays as dark as with the roof whole (the shadow map is unchanged).
- [ ] A pick through the hole returns the token, not the roof.
- [ ] `edge` dithers the rim: the fraction of cut pixels rises monotonically across the edge band.
- [ ] With 16 reveal points, the max fixture's frame costs at most 5% more GPU time than with none.
- [ ] Without `cutawayPlugin`, the forward shaders and `renderer-min` are unchanged, and a
      `Cutaway` renderable logs `render/feature-missing` once and draws whole.

## Open questions

- A show-only list (`only`) for minimaps and isolation views? Proposed: add it to `ViewVisibility`
  when a use appears. It is the same bitset, inverted.
- A cylinder around the line of sight, or a cone that widens toward the camera, in perspective?
  Proposed: a cylinder; in the tilted map view it reads as a disc.
- Should `Cutaway` inherit down the hierarchy, like `Visibility`, so a host tags a group root?
  Proposed: not yet. Structure tags its own meshes, and other hosts tag what they spawn.
