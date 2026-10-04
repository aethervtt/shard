# 0070 — Per-view visibility and cutaways

- **Status:** accepted
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
- **Nothing changes without the features.** `renderer-min`'s baked shaders link the same code:
  cutaway and the hidden-list resolver are plugins (0056), and both tests are defines.

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

**Resolving the list.** `viewVisibilityPlugin` (in `forwardPlugin`) resolves each camera's list to
a set of instance slots: every renderable under a listed entity, walked through `Children`. A list
resolves again only when:
- it changes;
- a slot is allocated or freed, or a `ChildOf` changes anywhere (rare; checked per `ChildOf` table);
- nothing else. A still frame does no work and allocates nothing.

Without the plugin, a `ViewVisibility` logs `render/feature-missing` once and hides nothing.

**Culling.** A camera with a list has a bitset of slots, one bit each, in `HiddenSets`.
- The CPU culls (opaque, blended, ground) read the bits.
- The GPU culler reads them from its LOD state buffer, after the LOD entries: its compute stage
  already binds 8 storage buffers, WebGPU's guaranteed maximum. `CullView.hidden_base` (a padding
  word) is the set's first word there, `0xffffffff` for none.
- Only the words that changed upload; a new buffer or layout uploads them all.

The camera's colour, depth, G-buffer and picking views test it. Its cascades test it only with
`shadows: 'hide'`, and cached cascades (0055) redraw when such a set changes. Spot and point shadow
maps are shared by every camera, so they always keep hidden entities.

**Cost.**
- Memory: `capacity / 8` bytes per camera with a list, 12.5 KB at 100k slots.
- Per frame: one bit read per candidate slot, in views that have a list.
- The GPU test links in only through `HIDDEN`, in frames where a view has a list: the default cull
  variant links the same code as before.

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
  radius: f32,                           // 2.5 m around each point's line of sight
  margin: f32,                           // 0.6 m: how far in front of a point a cut starts
  edge: f32,                             // 0.3 m of dithered edge; 0 is a hard cut
}
```

A fragment of a `Cutaway` renderable is removed in a camera's views when, for some reveal point
`p`:

```
it lies within radius of the line from the eye through p
  (orthographic: the view direction's line through p),
and it's nearer the camera than p by more than margin
```

- The edge is an ordered 4×4 dither over `edge` metres, ramping both conditions, so it needs no
  sorting and stays opaque.
- The `margin` keeps what's under a token (behind it from the camera) from being cut. Floors aren't
  `Cutaway` in structure anyway: at an angle, a floor in front of a token is nearer than it.
- From above, a roof opens a round hole over each token. In an orbit view, the wall between the
  camera and a token opens.

**Where it runs.** A plugin, `cutawayPlugin`, depends on `render/forward` and registers
`shard::cutaway`.
- Its module is linked, by `@if(CUTAWAY)`, into the forward (and ground and blended), prepass,
  depth-only, G-buffer and picking variants. Core shaders gain one conditional import and one call
  per fragment entry point; off, they link byte-identical code. The shader linker now only requires
  a conditional import's module while its condition holds.
- Shadow variants never link it, so a cut roof still casts, and 0069's interior stays dark.
- Each camera's points go into a uniform at bind group 3, with each point's line of sight computed
  on the CPU. It uploads when a value or the camera changes.
- A batch takes the cutaway variant only when the CPU finds that a point can cut it this frame: one
  of its `Cutaway` instances has a world box, grown by the radius, that a line of sight reaches in
  front of its point. Structure draws a chunk per batch, so only chunks near the lines of sight pay
  for the discard.
- The instance needs a flag. The flags byte was full (`ShadowOnly` took its last bit), so slot flags
  widen to 16 bits (`InstanceFlags.Cutaway` is 256) and it rides in bit 28 of the record's flags
  word. Bits 24–27 carry the LOD when read; the LOD debug view tints a cutaway slot as level 3.
- Without the plugin, a `Cutaway` tag logs `render/feature-missing` once, and the mesh draws whole.

**Structure.**
- `Roof.cutaway: bool` tags a roof's chunk meshes, and its hatches and skylights, as
  `shadowWhenHidden` does: a toggle rebuilds nothing.
- `StructureSettings.cutawayWalls: bool` builds wall pieces (frames included) into meshes of their
  own, apart from floors of the same material, and tags them; door leaves and window panes too, so
  a door in the cut goes with its wall. Changing it rebuilds every chunk with walls.
- Contact shade (0068) isn't cut: its floor strips must stay, and its corner strips stay with them.

Hosts combine them as they like. For example, hide the roof of the building a player's token is in,
and cut away the neighbours' roofs and the walls in front of the token.

### API sketch

```ts
import { CutawayView, ViewVisibility } from '@aethervtt/shard-render'
// forwardPlugin includes cutawayPlugin and viewVisibilityPlugin.
world.add(preview, ViewVisibility, { hide: [gmOnlyNotes, secretDoorsGroup] })
world.add(camera, CutawayView, { points: myTokens.map(worldPos), radius: 2.5, margin: 0.6, edge: 0.3 })
world.set(roof, Roof, { cutaway: true })
world.patchResource(StructureSettings, { cutawayWalls: true })
```

### Agent surface

- `render.describe` adds, per camera:
  - `viewVisibility`: its hidden entities, the slot count they resolve to, and `shadows`;
  - `cutaways`: its reveal points (and how many were ignored), radius, margin and edge.
- `ViewVisibility`, `Cutaway`, `CutawayView`, `Roof.cutaway` and
  `StructureSettings.cutawayWalls` are schema components and fields.
- Errors:
  - `render/too-many-reveal-points` (once per camera, naming it);
  - `render/feature-missing` for `Cutaway` or `ViewVisibility` without its plugin.

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
- **Hidden bits in the LOD state buffer.** A ninth storage binding would exceed WebGPU's
  guaranteed 8 per stage; the cull already writes that buffer, and the default variant's layout
  stays as it was.
- **The cutaway variant per batch, chosen on the CPU.** A discard costs a draw its early depth test
  (on a tiled GPU, its hidden-surface removal); a chunk no line of sight reaches doesn't pay it.

## Acceptance criteria

- [x] Two cameras on one scene, one hiding a group: the hiding camera never draws it and the other
      always does, on the GPU and CPU culls alike. Its shadows still fall in both views (golden).
- [x] Changing a hide list uploads only the bitset words that changed. A still frame with lists on
      three cameras uploads nothing and allocates nothing.
- [x] A camera without `ViewVisibility` renders byte-identical to before. `renderer-min`'s bake
      links byte-identical code (two modules' hashes change: their sources gained `@if` lines); its
      JS grows 1.4 KB brotli (the components, the cull test, the pipeline plumbing).
- [x] A cutaway roof over a token opens a disc of `radius` around the token from above (golden) and
      a hole along the line of sight at 30° (golden). The floor under the token is not cut, and the
      room below stays as dark as with the roof whole (the shadow map is unchanged).
- [x] A pick through the hole returns the token, not the roof.
- [x] `edge` dithers the rim: the fraction of cut pixels rises monotonically across the edge band.
- [ ] With 16 reveal points, the max fixture's frame costs at most 5% more GPU time than with none.
      Checked under `pnpm bench`. On an Apple M4 it's +8–11% with all 16 points in view (+1% when
      they cut nothing); see `TODO.md`.
- [x] Without `cutawayPlugin`, the forward shaders link the same code, and a `Cutaway` renderable
      logs `render/feature-missing` once and draws whole.

## Open questions

- A show-only list (`only`) for minimaps and isolation views? Proposed: add it to `ViewVisibility`
  when a use appears. It is the same bitset, inverted.
- A cylinder around the line of sight, or a cone that widens toward the camera, in perspective?
  Proposed: a cylinder; in the tilted map view it reads as a disc.
- Should `Cutaway` inherit down the hierarchy, like `Visibility`, so a host tags a group root?
  Proposed: not yet. Structure tags its own meshes, and other hosts tag what they spawn.
