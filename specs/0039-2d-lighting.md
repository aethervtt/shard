# 0039 — 2D lighting and shadows

- **Status:** accepted
- **Packages:** `@shard/sprite`, `@shard/texture`, `@shard/render`
- **Depends on:** 0018, 0024

## Context

Sprites are unlit today (0024): they write their texture's color straight into the HDR buffer.
Nearly every modern 2D game lights its sprites: torches in a dungeon, a flashlight in a cave,
muzzle flashes, day and night. Light is also how 2D scenes read depth. Normal-mapped sprites pick up
light from the side, and occluders throw shadows that tell you where walls are.

This spec adds 2D lights, normal maps for sprites and tiles, and shadows from occluders. The
design borrows the parts of 0018 that carry over (a light buffer, screen-tile light culling,
per-light shadow maps) and keeps 2D's own rules: sprite color stays the unit of brightness, and
everything stays in the one sprite pass.

## Goals

- `PointLight2d` and `SpotLight2d`: color, intensity, radius, falloff, and a height above the
  sprite plane for normal mapping.
- `Lighting2d` on a 2D camera turns lighting on for what it sees, with an ambient color. Without it,
  sprites draw exactly as they do today.
- Normal maps for sprites, atlases, and tilemaps. The atlas packer packs `*_n.png` companions into
  a matching page.
- Hard and soft shadows from `LightOccluder2d` shapes: box, circle, polygon, the sprite's own
  outline, or its 2D physics collider. Tilemap layers can occlude by their filled cells.
- Hundreds of lights, dozens of them shadowed, at 60 fps. Lights are culled per screen tile, so a
  fragment only evaluates the lights that reach it.
- Everything visible to agents: what's lit, what's culled, what's over budget, and an overlay.

## Non-goals

- Global illumination, bounce light, or light that spills through translucent sprites (colored
  shadows).
- Light cookies (textured lights) and area lights. A directional "sun" with long shadows is an open
  question below.
- Lighting 3D meshes with 2D lights, or sprites with 3D lights. The two light sets stay separate.
- Screen-space or signed-distance-field shadows. Shadows come from 1D shadow maps (Decisions).

## Design

### Lights

```ts
PointLight2d {
  color: color = white        // linear
  intensity: f32 = 1          // 1: a sprite it fully lights shows at its texture color
  radius: f32 = 5             // world units; the light reaches zero here
  falloff: f32 = 2            // exponent of the smooth window (1 − (d/radius)²)^falloff
  height: f32 = 1             // world units above the sprite plane, for normal maps
  shadows: bool = false
  softness: f32 = 0.1         // emitter size in world units: penumbras widen with distance
  layers: u32 = 0xffffffff    // which sprite layers it lights (bit per layer band, see below)
}
SpotLight2d { ...PointLight2d, innerAngle: f32 = 30, outerAngle: f32 = 45 }   // degrees, from +X
Lighting2d {                  // on a camera with Camera2d
  ambient: color = [0.08, 0.08, 0.1, 1]
  ambientIntensity: f32 = 1
  maxLights: u16 = 256        // visible lights per view
  maxShadowed: u16 = 64       // shadowed lights per view (nearest to the view center win)
}
```

- Units are sprite units, not lux (Decisions). A lit sprite's color is
  `albedo × (ambient + Σ lightᵢ) + emissive`. Values above 1 are fine: the buffer is HDR, so bright
  lights bloom through the post stack.
- The light's own entity rotation aims a spot (its +X), so spots follow what carries them, like a
  flashlight in a hand (0034 sockets).
- `layers` masks which layer bands a light touches: bit `k` covers layers `[k × 64, k × 64 + 63]`
  offset from −1024. Foreground lights can skip the background. Most games leave it at all.

### Lit sprites and tiles

```ts
Sprite { …, lit: bool = true }            // new field; only matters under a Lighting2d camera
SpriteLighting {                          // optional, on a sprite entity
  normal: handle('Texture')               // for a plain texture sprite
  emissive: f32 = 0                       // × albedo, added after lighting (glowing eyes, screens)
  normalStrength: f32 = 1
}
TextureAtlas { …, normals: handle('Texture') }   // same regions, a matching page
Tilemap { …, lit: bool = true }
```

- Atlas sprites and tiles take normals from `TextureAtlas.normals`, sampled at the same UV rect,
  so one region lookup covers both. Plain texture sprites use `SpriteLighting.normal`.
- The atlas packer packs `name_n.png` next to `name.png` into a second page with the same layout.
  A region without a companion gets a flat normal. `*.atlas.json` takes `normals` by path.
- Normals are tangent-space, +Y up (OpenGL). The texture importer's `normalMap: 'opengl' |
  'directx'` flips green for DirectX maps. Flip and rotation (sprite `flipX`, tile flags) turn the
  normal with the sprite, so a flipped sprite is still lit from the correct side.
- `lit: false` sprites and screen-space sprites draw as today (UI, particles that glow on their
  own).

### Occluders

```ts
LightOccluder2d {
  shape: 'box' | 'circle' | 'polygon' | 'sprite' | 'collider'
  size: vec2                 // box: full size; circle: size[0] is the radius
  points: list(vec2)         // polygon, local space, closed; convex or not
  lightPenetration: f32 = 0.05   // world units: how far light reaches into the occluder itself
  layers: u32 = 0xffffffff   // which lights it blocks, matching PointLight2d.layers
}
TilemapLayer { …, occludes: bool = false }   // in TilemapData layers
```

- `sprite` uses the sprite region's outline. The atlas importer builds it when the atlas sets
  `outlines: true`: marching squares on alpha at 0.5, simplified to within 0.5 texel, at most 32
  points per region. It's stored with the atlas, so it costs nothing at runtime.
- `collider` reads the entity's `physics/Collider` (cuboid, ball, capsule, convex polygon) by name,
  so there's one source of truth for walls. The sprite package doesn't depend on physics.
- Occluding tilemap layers turn filled cells into boundary edges per chunk, with shared edges
  between filled cells removed and collinear runs merged. A 32×32 chunk of solid wall with one
  doorway is a few dozen segments, not a thousand quads. Editing a tile rebuilds only its chunk's
  edges.
- Everything reduces to world-space segments in one storage buffer per frame. Only occluders
  whose bounds reach a shadowed light's circle are uploaded, and static occluders keep their
  records (the 0022 slot pattern).
- `lightPenetration` keeps an occluder's own pixels lit on the side facing the light. Without it a
  wall sprite would sit in its own shadow.

### Rendering

Per view with `Lighting2d`, in the sprite pass's prepare phase:

1. **Extract.** Visible lights (circle-vs-view, layers) go into a light buffer, up to `maxLights`.
   The `maxShadowed` nearest shadowed lights get a shadow row, and the rest render unshadowed.
2. **Bin.** A compute pass bins lights into 16×16-pixel screen tiles, like 0018's clusters without
   depth slices, with up to 64 lights per tile.
3. **Shadow maps.** One compute pass fills a 1D shadow map per shadowed light: a row of 1024
   angles in an `r32float` texture (64 × 1024). Each thread takes one segment and one light, and
   writes the nearest distance for each angle it covers with `atomicMin` on the distance's bits.
   One dispatch does every light.
4. **Shade.** The sprite and tilemap fragment shaders loop over their tile's lights. For each one
   they compute attenuation, N·L from the normal map and the light's height (flat normals give
   plain radial falloff), and a shadow term. The shadow term samples the light's row at the
   fragment's angle, with a PCF kernel whose width grows with `softness × (d − occluderD) / d`,
   so penumbras widen away from the occluder.

- Order and blending don't change (0024): lighting multiplies each sprite's color before its
  premultiplied blend, so transparent sprites are lit too.
- Pixel-perfect cameras light in their low-resolution target, so lighting is pixelated with them.
- The whole path costs nothing when no camera has `Lighting2d`: no buffers, passes, or shader
  variants.

### API sketch

```ts
import { Lighting2d, LightOccluder2d, PointLight2d, SpotLight2d } from '@shard/sprite'

world.add(camera, Lighting2d, { ambient: [0.05, 0.05, 0.08, 1] })
world.spawn(
  [PointLight2d, { color: [1, 0.7, 0.4, 1], intensity: 1.5, radius: 6, shadows: true }],
  [Transform, transform2d({ x: 3, y: 1 })],
)
world.add(wall, LightOccluder2d, { shape: 'collider' })
```

### Agent surface

- The components have schemas, so agents author lights and occluders in scene JSON and validate
  them.
- `render.describe` gains `sprites.lighting` per view: lights visible, culled, and dropped over
  `maxLights`, shadowed lights and those demoted over `maxShadowed`, occluder segments uploaded,
  tiles at the 64-light cap, and GPU time of the bin, shadow, and shade work.
- A `lights2d` overlay draws each light's radius and cone, its shadow row as a ring, and occluder
  segments, so a screenshot shows why a corner is dark.
- `asset.preview` of an atlas with normals shows albedo and normals side by side, with outlines
  when `outlines: true`.
- **Errors:** `sprite/invalid-occluder` (a polygon under 3 points or self-intersecting, a box of
  zero size, `collider` without a supported collider), and the warnings `sprite/too-many-lights`
  and `sprite/too-many-shadowed-lights`, logged once per view when a budget drops lights.
  `texture/normal-map-mismatch` fires when a normal companion's size differs from its albedo.

## Decisions

- **Sprite units, not lux.** 3D is physical so exposure behaves. 2D art is authored as final color,
  and a light of intensity 1 has to show a sprite at its texture color at any exposure. 2D light
  results enter the pre-exposed HDR buffer the same way unlit sprites do.
- **Forward in the sprite pass, not a light accumulation buffer.** A screen-space light buffer
  can't light transparent sprites or respect per-sprite normals and layers. Tile-binned forward
  handles all three, and it's the pattern 0018 already proved out.
- **1D polar shadow maps from a compute pass.** A shadowed light is one 4 KB row, and every light
  fills in one dispatch. Cost scales with segments × lights near them, not screen pixels, and soft
  shadows come from widening the PCF.
- **Occluders reduce to segments.** Boxes, circles, outlines, colliders, and tile edges become one
  primitive, so one shadow kernel covers all of them, and agents can pick whichever shape they
  already have.
- **Normals ride the atlas layout.** A second page with identical regions means no second lookup,
  no second region table, and the packer keeps them in sync.
- **Opt-in per camera.** Existing 2D projects and UI render byte-for-byte as before, and games can
  mix a lit world camera with an unlit HUD camera.

## Acceptance criteria

- [ ] With no `Lighting2d`, the 0024 golden images are unchanged and the lighting pass adds 0 draws
      and 0 bytes uploaded.
- [ ] A sprite at the center of a point light of intensity 1 shows at its texture color (within 1
      level of 255), and at `radius` it shows at ambient only.
- [ ] A normal-mapped sprite lit from the left is brighter on its left than its right, and flipping
      it (`flipX`) keeps it lit from the left (golden image).
- [ ] A box occluder casts a shadow a sprite behind it falls into, and the occluder's own lit face
      stays lit. Hard (`softness` 0) and soft shadows each have a golden image, and the soft
      penumbra is wider farther from the occluder.
- [ ] `shape: 'sprite'` outlines from the packer stay within 1 texel of the alpha edge on a test
      set of 20 shapes, with at most 32 points each.
- [ ] A 256×256 tilemap with an occluding wall layer produces merged edges (under 5% of the naive
      per-cell edge count on the test map), and editing a tile rebuilds only its chunk's edges.
- [ ] 20k lit sprites, 250 lights (64 shadowed), and 2000 occluder segments render at 60 fps at
      1080p on the dev machine, with bin + shadow + shade adding under 2.5 ms of GPU time over the
      same scene unlit (bench).
- [ ] Light extraction, binning inputs, and occluder segment generation (shapes, outlines, tile
      edges) are tested headless, without a GPU.

## Open questions

- None blocking. Resolved at acceptance:
  - A directional 2D light ("sun") with long parallel shadows is deferred to a follow-up spec. It
    needs a different shadow map (along one axis, across the whole view).
  - Lit 2D particles (0026) are out of scope, with a follow-up if a demo needs them.
  - `Lighting2d.ambient` defaults to dark (0.08), as designed. A bright preset (ambient 1, lights
    only add) can be documented in the skill.
