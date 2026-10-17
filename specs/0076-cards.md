# 0076 — Cards, decks, and extensible foil finishes

- **Status:** draft
- **Packages:** `@aethervtt/shard-cards` (new), `@aethervtt/shard-render`,
  `@aethervtt/shard-input`, `@aethervtt/shard-project`, `apps/playground`
- **Depends on:** 0002, 0006, 0014, 0016, 0020, 0022, 0027, 0052, 0056, 0060, 0061, 0062, 0064, 0074, 0075

## Implementation checkpoint — 2026-10-17

The first implementation is in `packages/cards`, with `apps/playground/cards.html` for visual
review. After visual iteration, the user authorized PR validation and merge. Regression coverage
now includes headless collections/layouts/picking/motion, GPU layer composition and PBR lighting,
and browser interaction on WebGPU/WebGL2. The full acceptance checklist below remains open;
project/protocol integration and automatic deck residency are follow-up work.

Implemented for this review: schema-backed definitions; arbitrary sizes; rounded front/back/edge
geometry; four independently masked layers per face; four built-in and three host-defined finish
shaders; shared texture arrays/material and dirty instance rows; deterministic logical collections;
fan/grid/stack poses; flips; face hit UVs; optional damped tilt; and reduced motion. The playground
uses the three supplied card images and generated artwork masks. The independent pattern layer
uses flowing engraved lines for Ninetales, stars for Umbreon and petal/leaf confetti for Pawmi;
the showcase backs are plain print. Artwork masks use art UVs to follow crop/fit changes.
Umbreon's coverage samples the original art's green channel as linear data, preserving source
pixel alignment; the earlier generated silhouette mask is no longer used.
Prompts are recorded in `apps/playground/public/cards/generation-prompts.json` and
`pattern-revision-prompts.json` in the same directory.

The current API is `cardsPlugin({ art, masks, lighting, finishes, capacity, textureBudgetMiB })`, with pages
prepared by `prepareCardTextures`. `Cards` exposes `spawn`, and handles expose `setPose`, `flip`,
`setFinish`, `setStrength` and `setHover`. `hitCards` and `cardTiltCoordinates` write into reusable
outputs; the playground owns DOM pointer capture and click/drag behavior. Custom `surface` bodies
receive `ctx` and `base`, return linear RGB reflectance, and accept up to four schema-defined scalar
parameters. Optional `response` bodies receive `ctx` and `current` (metallic, roughness), returning
`vec2f`; the same grayscale coverage blends both color and response. The default foil response is
(0.35, 0.28). Built-ins and host finishes demonstrate independent response hooks.
The shared shader reads bounded records from a data texture on either tier. `lighting: 'pbr'` is
the default: `extends: 'standard'`, `standardTextures: false`, and the engine's `pbr_input` hook
supply bounded reflectance, normal, metallic and roughness before ordinary lighting, shadows and
IBL. Foil emits no light. No renderer changes or duplicated light loops are required.
`lighting: 'unlit'` explicitly selects the exposure-aware `shade` hook and configured print luminance.
Both modes cast ordinary geometry shadows; only PBR responds to scene lights and receives shadows.
The virtual pointer/light remains an artistic input to finish patterns, not a source of PBR radiance.
The playground offers real light direction/sweep, lights off, a shadow-casting bar, and a lighting
selector (reloading the scene). Geometry is cached by dimensions. Covered deck cards are
logical entries; this demo explicitly exposes 10 stack cards or 15 hand cards.
Hand and deck layouts disable pointer tilt. Clicking a hand card raises it in front of its
neighbours and straightens it; selecting another restores the previous pose. Empty-space click
returns it to the fan, and arrow keys browse every physical card in the hand.
The deck stacks along one shared face normal, separated by thickness plus a small gap, so covered
back faces are not exposed by lateral offsets. The tabletop camera uses a 1 m far plane.
Deck flips first lift the chosen card clear of the pile, then rotate it, avoiding intersections.

Still required after this review: project/scene auto-instantiation and protocol/editor commands;
engine gesture events and occluder-aware picking; hierarchy/visibility synchronization; automatic
deck exposure, edge proxies and texture residency/eviction; extended finish texture/normal
hooks; and the correctness, device recovery, GPU tier and performance acceptance work below.
The initial CPU update benchmark uses `cards/update`: 1,000 settled cards over 600 frames,
with a proposed 0.8 ms target on each named machine. The complete cards-table scenario and
image equivalence matrix below remain follow-up work.

## Context

A tabletop, deck builder, or collectible gallery needs cards with different dimensions, independent
front and back art, and finishes that change with the view. A card must remain individually
pickable while sharing geometry, textures and draw calls with its deck. Hundreds of unique images
must not mean hundreds of materials; thousands of covered cards must not mean thousands of updates.

Shard already supplies instancing, material hooks, picking, gestures and asset ownership. This
package composes them into card presentation and deterministic collection operations. Game rules,
ownership permissions and the decision to play a card stay with the host.

## Goals

- Arbitrary rectangular sizes, rounded corners, optional thickness, independent front/back art.
- Plain, metallic, rainbow and patterned holographic finishes, masked independently on either face.
- Schema-defined custom finish shaders, layered effects and per-card variation without material clones.
- Efficient stacks, hands and galleries; bounded artwork residency and dirty instance uploads.
- Click/tap, hover, local UVs, drag integration and optional pointer-position tilt.
- Deterministic flip/deal/layout animation, reduced motion, headless inspection and both GPU tiers.

## Non-goals

- Trading-card rules, networking, authoritative hidden information, or gambling/shuffle certification.
- DOM card rendering, a card-art editor, live text layout into textures, arbitrary die-cut silhouettes,
  bent/cloth cards, or physically simulated piles. Text/UI can be attached as ordinary children.
- A general spectral BRDF or glTF iridescence importer. Built-in foil is an art-directed approximation.

## Design

### Definitions, faces and instances

`CardDefinition` is a schema-backed asset (`*.card.json`), separate from the identity of a physical
copy. It contains `size: [width, height]` in metres, `cornerRadius`, `thickness`, `edgeColor`,
`front`, `back`, and an optional label. Require positive finite dimensions, non-negative thickness,
and radius in `[0, min(width, height) / 2]`. Presets are conveniences, never an aspect-ratio limit:
`poker` 0.063 × 0.088 m, `bridge` 0.057 × 0.088 m, `tarot` 0.070 × 0.120 m, and custom sizes.
Their exact dimensions are named defaults, not promises about every manufacturer's stock.

Each `CardFace` has `art?: TextureRef`, `tint`, `fit: 'contain' | 'cover' | 'stretch'`,
`background`, `uvRect` (normalized source crop), `rotation` (quarter turns), and `finishes`.
Missing art draws the background; missing back never copies the front. The default is `contain`.
Art alpha composites over the opaque background: it does not punch holes in the card or picking.
The geometric rounded rectangle is the silhouette in color, depth, shadow and picking passes.

Cards lie in local XY, centered at the origin: +Y is up and the front faces +Z. Each face's UV
origin is its own top left; back art reads normally when viewed from behind. The back tangent
basis is reversed consistently for pattern direction and hit UVs. Zero thickness uses one
two-sided face mesh; nonzero thickness puts faces at Z = ±thickness/2 with a shared edge band.
No coincident front and back planes. Geometry dimensions come from instance data; corner segment count is a quality
bucket, not one mesh per card size. Edge-on picks return `side: 'edge'`, with no face UV.

`Card` holds a definition handle, stable `instanceId`, tint, finish strength, seed and enabled flag.
It composes with `Transform`, hierarchy, render layers and visibility. Multiple copies of a
definition keep distinct IDs. `CardInteraction` and `CardTilt` are optional components.
Presentation state (hover, temporary tilt, animation progress) is separate from saved game data.
All fields, references, validation, serialization and agent descriptions derive from schemas.

```json
{
  "size": [0.063, 0.088], "cornerRadius": 0.003, "thickness": 0.0003,
  "front": {
    "art": { "path": "assets/dragon.png" }, "fit": "contain",
    "finishes": [
      { "family": "cards/hologram", "strength": 0.65,
        "mask": { "texture": { "path": "assets/stars-mask.png" }, "space": "art" },
        "parameters": { "roughness": 0.25 } },
      { "family": "cards/sparkle", "strength": 0.4,
        "mask": { "texture": { "path": "assets/glitter-mask.png" }, "space": "art" } }
    ]
  },
  "back": { "art": { "path": "assets/deck-back.png" } }
}
```

### Finishes and extension contract

A face has at most four ordered finish layers, each with its own family, parameters, strength
and grayscale mask: e.g. holographic stars overlaid with glitter. Masks may overlap; they are not
exclusive regions, and changing one layer never modifies another layer's mask or parameters.
Mask coordinates default to face UVs;
`space: 'art'` follows the cropped/fitted artwork and is zero outside a contained image.
Masks have independent UV transforms, channel (`r` default, or `g`, `b`, `a`) and invert flags.
Masks are linear data with no sRGB decode: black (0) means no foil, white (1) full foil, and
gray (0.5) half strength, without thresholding. Missing mask means one. Art is decoded from sRGB.
The package multiplies each layer's coverage by its strength and mask, clamps to `[0, 1]`, then
blends its surface color and metallic/roughness response over the previous layer in linear space. Zero coverage reproduces the previous
layer exactly. A foil mask never changes silhouette, hit testing or the other face.

Built-ins in the `cards/` namespace are `metallic` (tinted reflective ink), `rainbow` (angle-dependent
color bands), `hologram` (directional spectrum with a tileable pattern), and `sparkle` (filtered flecks).
No layers is ordinary printed stock. Fields include roughness, intensity, pattern scale/rotation
and, where relevant, spectrum ramp, phase and animation speed. Shimmer defaults to stationary;
view/light motion still changes it. Sparkles use footprint filtering to avoid subpixel flashing.
Built-ins preserve readable art at their defaults and work without a pointer in the scene.

```ts
// Proposed API; declarations have no registration side effects.
const etched = defineCardFinish('my-game/Etched', {
  fields: { intensity: t.f32({ default: 0.6, min: 0, max: 1 }) },
  instanceFields: { phase: t.f32({ default: 0 }) },
  textures: { pattern: { colorSpace: 'linear' } },
  shader: 'project::etched',
  baseline: 'same',                 // or a baseline module, or 'unsupported'
  animated: false,                  // or { fps: 30 }; uses simulation time
})
app.addPlugin(cardsPlugin({ finishes: [etched], textureBudgetMiB: 128 }))
```

The generated WESL contract is `card_finish(ctx: CardFinishContext, base: vec3f) -> vec3f`.
`base` and the result are linear surface color. In PBR the wrapper clamps the final reflectance
to `[0, 1]`; finish `response(ctx, current) -> vec2f` controls metallic and roughness with the same
mask coverage (metallic `[0, 1]`, roughness `[0.045, 1]`). Lighting runs after layer composition,
then the renderer applies exposure/tonemapping once. Unlit uses the color as print radiance scaled
by configured luminance. Context includes face/art/pattern UVs and
derivatives, world position, face-correct normal/tangent, view direction, seed, simulation time,
and per-instance parameters. The material wrapper feeds the existing lighting, shadowing and IBL
pipeline; families do not copy lighting loops. Optional hover input contains UV and an explicit active flag
and defaults to centered/inactive. A finish cannot alter geometry, depth, alpha, or entity identity.

`fields` and texture bindings are shared per finish asset; equal inline parameters are interned.
`instanceFields` are bounded numeric schema fields packed into an instance table. Shader modules
and layer-family sequences specialize pipelines; numbers, masks, seeds, artwork and pointer
positions do not. Report binding limits before compilation; hot reload keeps the last valid shader.
New built-ins must use this same API; a project-defined family gets the same preview and batching.

### Rendering, batching and artwork residency

`cardsRenderPlugin` depends on `render/forward` and registers its shaders/features explicitly.
Keep render-facing scene definitions in the renderer's component catalog and gameplay helpers in
cards; absent rendering support logs `render/feature-missing`. The smallest lit scene loads no
card shaders or systems. The public convenience plugin composes rendering and optional interaction.
Use 0020's material/pipeline machinery and 0022's instance/cull machinery, not a second renderer.
Cards default to `lighting: 'pbr'`, extending the engine standard material through `pbr_input`.
View-dependent patterns are evaluated into ordinary PBR inputs; no custom lighting or G-buffer
extension is needed. The same material can use the engine's forward or deferred path.
The card wrapper binds its own texture arrays instead of unused standard texture slots.
`lighting: 'unlit'` is an explicit alternate material type using configured print luminance.
Both respect exposure. PBR surfaces with no incident light are black, including all foil layers.

Batch by mesh quality, layer-family sequence, shared finish assets, texture-page set and render
state. One `InstanceData` index selects face records, dimensions, tint and finish parameters through
`@data`. Renderer extensions required for these bindings must be generic and inert without the
plugin. Rounded geometry and its exact edge band are reused by shadows and picking. Default cards
write depth and are opaque; fade is an explicit transparent variant with 0020's sorting limits.
Physical layout separation resolves overlapping hands; no reliance on insertion order or z-fighting.

Art and masks pack into separately typed, mipmapped texture-array page sets grouped by resolution
and format. Arrays hold one image per layer, preventing cross-card mip bleed; fitting/cropping is
in UVs. A page set is capped by adapter layer/dimension limits and the residency budget. Duplicate
images (especially backs) share slots. Resolution buckets include thumbnails and inspection art;
the host chooses the inspection target, so only inspected cards request full-resolution images.
Masks and custom pattern slots count against the same total GPU-byte budget, including mipmaps.
This follows the batching/residency principles in [MDN's WebGL guidance][batching].

Definition metadata can load without decoding its images. Image references are tracked as asset
dependencies for validation/hot reload but acquired for residency only on face demand; do not use
eager handle loading to pull in an entire collection. Visible faces, in-flight flips and explicit
prefetches pin slots; evict unpinned least-recently-used slots. When the budget cannot fit a visible
set, demote inspection art, then thumbnails; use a stable neutral placeholder if still necessary.
Never exceed the cap, silently substitute another card, or block input on IO. `prepareCards`
preloads a known hand plus pipelines and reports ready/failed/over-budget entries. Missing art
reports `cards/art-unavailable` and uses a placeholder, distinct from an intentionally blank face.
Upload only dirty records/pages; no allocation, repacking, or per-card callbacks in steady frames.

Full and baseline tiers support all built-ins. Baseline uses `@data` texture-backed instance tables,
instancing and texture arrays; its implementation loads from `src/baseline/`. Binding validation
counts the renderer's reserved textures as well as card fields. Unsupported custom families draw
plain print and report `render/feature-unsupported` once; a host may supply an explicit fallback.
Teardown releases owned buffers, images, picks and frame demands; shared handles survive (0061).

### Collections, layouts and motion

`CardCollection` stores ordered stable instance IDs and definition refs in compact storage.
`insert`, `remove`, `move`, `draw(count, destination)` and `shuffle(seed)` are explicit operations;
draw removes from index 0 and appends to the destination. Invalid counts/IDs leave both collections
unchanged. Seeded Fisher–Yates uses the core RNG with unbiased bounded integers and a pinned test
vector; randomness is gameplay input, never read from wall time. Save/load preserves IDs, order,
face orientation and seed; it does not save residency or hover state. Duplicate IDs are errors.

`CardLayout` supplies stack, fan and grid layouts on a collection root, with explicit spacing,
fan angle, row/column count and visible range. Layout writes pooled presentation children only on
change. A stack realizes its top/bottom and a bounded exposed edge sample (`maxExposed`, default 8);
its remaining thickness is one stack-edge proxy, picked as the collection root. This proxy applies
only to aligned, same-size opaque stacks. Mixed-size, offset or transparent stacks use explicit
cards or a host-selected visible range; never silently hide protruding cards. A gallery virtualizes
only its declared visible range. Hidden entries have no render entity, animation or image demand.
Materialized hits include both instance ID and collection ID/index; IDs survive pool reuse.

`cardPose(..., out)` computes layouts headless. Opt-in `animateCard` interpolates position/rotation
for deal, return, flip and fan changes using simulation time; cancellation starts from the current
pose. A flip is an actual 180° rotation, with the back visible throughout the appropriate half.
Art readiness never delays logical order or changes the deterministic world hash. Hover lift and
tilt apply after the authored/layout pose and never accumulate into it. These APIs move presentation;
the host commits game actions. Reduced motion snaps layout/flip transitions, disables tilt and
automatic shimmer, while keeping click, drag, focus and selection available.

### Picking, clicks, drag and tilt

Extend 0027's pick details with `{ instanceId, collection?, index?, side, uv?, localPosition }`.
Use its GPU entity/depth pass for scene occlusion, and add an allocation-free CPU card query with
an out-parameter for headless interaction and pointer tracking. CPU tests the same rounded geometry,
thickness, face orientation and final presentation pose; a bounds hit alone is not a card hit.
It respects the requested camera's visibility and mesh occluders where CPU geometry is available.
GPU-only occluders use asynchronous GPU picking; never present CPU bounds as an exact visible hit.
Register card narrow-phase tests before nearest-hit selection; a post-hit detailer alone cannot
reject a false corner hit. Culling bounds include dimensions, thickness and the final tilt pose.

`CardInteraction` opts into hover/press/activate/context/drag events and declares accepted buttons.
Events contain pointer ID/kind, camera, side, UV, modifiers and stable instance ID. Activation
requires down and up on the same enabled card, within 0060's tap threshold, without drag/cancel;
an up outside, removed card, lost capture, or camera change cancels. Touch has tap/drag but no
synthetic hover. Hosts can invoke the same activation action from keyboard/gamepad focus; labels
and focused IDs are exposed for the host's accessibility UI.

Gestures retain 0060 ownership: UI first, card handlers in `Update`, camera fallback in `PostUpdate`.
An async hit holds the gesture until resolved; generation/pointer/view tokens reject stale replies
after a removal or pool reuse. Hover alone never claims a gesture. Drag handlers explicitly begin
`PlaneDrag` with the card's stable grab point or use custom preview/drop logic; crossing the drag
threshold suppresses activation. Hosts choose acceptance and commit, including a cancelled return.

`CardTilt` defaults off. Fields: `maxDegrees: [x, y]` (default `[8, 8]`), `responseSeconds` (0.12),
`returnSeconds` (0.18), `pivot` (center), and controlling camera/pointer policy. Normalize local
face UV to `[-1, 1]`, clamp, and smooth toward the bounded rotation. Hit testing uses the rendered
pose; the tilt driver projects onto the untilted base-pose plane to avoid feedback/jitter. Near
parallel rays hold the last target, then return on leave. Only one pointer/view drives a physical
card at once (first captured pointer, otherwise most recent hover in the designated camera).
Drag suspends hover tilt. Headless callers may set the normalized target directly.

An opt-in automatic driver replaces mouse input with a virtual pointer. `setAutomaticMotion`
accepts schema-backed `enabled`, `tilt` (both default false), `seconds` per waypoint (4), `range`
(0.85 of the normalized face), and per-card `phase`. Deterministic integer-generated waypoints
are interpolated with quintic easing, continuous in position, velocity and acceleration. The
shader computes this from one shared clock and static instance settings, feeds it to custom
finish `ctx.pointer`, spectrum shift and virtual light, and needs no per-frame pointer uploads.
Optional geometry tilt samples the same path on CPU and uses existing damped transforms so
picking matches the visible card. Automatic input takes precedence over mouse input. Reduced
motion freezes the automatic clock and returns physical tilt to neutral; resuming does not jump
ahead in wall time. The playground defaults to foil-only motion, suspends physical tilt during
drag, and permits automatic tilt only in gallery/inspect or on the raised card in a hand.

Hold a 0052 frame demand only during motion or visible time-animated finishes; stationary foil,
hidden collections and settled tilt must let an on-demand app sleep. Recompute hover when the
camera/card moves under a stationary pointer, not just on pointer events.

### Agent surface and example

`"cards"` in `shard.json` installs the package. `cards.describe` reports collections, realized IDs,
layout/interaction state, batches, texture bytes, pending art and unsupported finishes;
`cards.hit` returns pick details; `cards.prepare` preloads; `cards.move`, `cards.shuffle` and
`cards.animate` mirror the typed APIs. Existing `input.simulate` drives actual interaction.
`asset.preview` shows both faces and a fixed-light/view sweep of each finish. Schema errors include
JSON pointers; runtime errors use `cards/*` codes and hints. Generate a card-authoring skill.
The `#cards` playground demonstrates an ordinary deck, mixed sizes, a masked foil hand, four-layer
and project-defined finishes, flip/deal, click details and opt-in tilt on both backends.

## Decisions

- **Surface hooks over a hardcoded holo switch.** Patterned foil and thin-film interference are
  different visual models. [KHR_materials_iridescence][iridescence] informs angle dependence and
  linear strength masks; [Simon Goellner's card effects][holo] demonstrate art-directed layered
  finishes. These are references, not a dependency or a claim of glTF/material compatibility.
- **Compact collections, pooled visible cards.** A large deck's cost follows exposed cards and
  resident images, while every logical card keeps stable identity.
- **Opaque printed stock by default.** Avoid transparent sorting/overdraw for ordinary card art.
- **Host authority.** A face-down card is presentation, not secrecy; a host with hidden information
  supplies sanitized definitions and must not send private fronts to an unauthorized client.

## Acceptance criteria

- [ ] Mixed sizes/radii/thicknesses, cropped art and asymmetric front/back labels match goldens at
      0°, 90° and 180°; identical silhouettes in color, shadow and CPU/GPU picking, including corners.
- [ ] Black/white/gradient and inverted masks on either face isolate every built-in finish; zero
      coverage matches plain print within one 8-bit level. Art-space masks align after all fit modes.
      Overlapping stars + glitter match ordered composition; 0.5 mask × 0.4 strength gives 0.2
      coverage in linear HDR. Disabling either layer preserves the other, including in overlap.
- [ ] A project family with one shared pattern and per-instance phase renders 1,000 distinct cards
      without 1,000 material assets; valid hot reload updates it, invalid reload retains the old image.
- [ ] Full WebGPU, baseline WebGPU and WebGL2 minimum render the finish sweep within 0064's image
      tolerances. Unsupported families report once and preserve the artwork and picking.
- [ ] In overlapping/occluded cards, simulated tap, right-click, touch and drag hit the visible ID
      with UV error ≤ 0.005; corners miss. Cancel/removal/stale GPU replies never activate reused IDs.
- [ ] Tilt stays within its bounds, settles within 0.1° after 2 s, returns on leave and does not
      alter the base pose. Reduced motion disables it; a settled on-demand scene submits no frames.
- [ ] Seeded shuffle/draw/save/load and fixed-step animation replay give identical IDs/order/poses
      headless and in Chrome. Invalid transfers are atomic; IDs survive layout pooling and picking.
- [ ] A 10,000-entry aligned stack realizes ≤ 10 card entities plus one edge proxy and requests no
      covered front art. A dirty card uploads only its record ranges; idle cards upload zero bytes.
- [ ] A 1,000-visible-card gallery with unique 128² fronts, one back, one finish asset and page
      capacity 256 uses ≤ 4 face draws per color pass (zero thickness, one layer, after warmup).
      With 128 MiB residency, repeated inspect/evict cycles never exceed the cap or show stale art.
- [ ] Add `cards-table` to 0075: 1,000 visible cards at 1080p, 200 masked foil, 20 animated, a
      10,000-entry compact stack, fixed camera/pointer replay for 600 measured frames after warmup.
      Proposed on both named machines: CPU `frame` 8 ms, GPU `gpu:frame` 16.6 ms; CPU slices
      `cards/update` 0.10, `cards/interaction` 0.05, `render` 0.65, headroom 0.20; GPU slices
      `gpu:forward-opaque` 0.60, `gpu:shadows` 0.20, `gpu:tonemap` 0.05, headroom 0.15.
      Basis: like `crowd`, plus masked fragment work; unmeasured proposals, not current capability.
      Register these keys/slices in `bench/perf/budgets.json` when implementing, measure both machines,
      and assert with `budget()`/`allocationChecks` only under bench. Steady updates allocate nothing.
- [ ] Two embedded views share art safely; dispose one during a pick/load/animation without affecting
      the other. Repeated mount/unmount returns owned GPU bytes and frame demands to baseline.
- [ ] `pnpm size --check` and WGSL identity checks preserve the renderer-min fixture; `#cards` joins
      curated browser verification. Pure deck/layout/interaction tests run without a GPU or DOM.

## Open questions

- Deferred: bending, arbitrary silhouettes, live text-to-texture, spectral diffraction, physical
  shuffle simulation and per-view concealed faces. None is required for the first package.
- Proposed budgets need measurements on both named machines before marking the spec implemented.

[iridescence]: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_iridescence
[holo]: https://github.com/simeydotme/pokemon-cards-css
[batching]: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices#batch_draw_calls
