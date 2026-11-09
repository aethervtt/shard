# Make a view look like a comic

Toon shading and ink are camera components: the camera that has them draws the comic look, every
other camera renders as before (a menu, a card table, a minimap). Nothing on the models changes.

```json
"render/Toon": { "bands": 3, "softness": 0.03, "shadowColor": [0.25, 0.22, 0.35, 1] },
"render/Ink": { "width": 2, "depthThreshold": 0.15, "normalThreshold": 35 }
```

- `Toon`: each light's diffuse falls into `bands` tones (2: lit and shadow), on the models' own
  colors and textures, with no specular. `shadowColor` is what a light still gives the side facing
  away or in its shadow; `ramp` (2–8 colors, darkest first) sets every tone instead. Sun, point and
  spot lights all band; distance falloff stays smooth (tabletop falloff gives hard-edged pools).
  Ambient light, SSAO and emissive are kept. Deferred views and skinned meshes work the same.
- `Ink`: lines where depth jumps (silhouettes, an arm across a body) or surface direction turns
  (a wall's edge, the crease where a wall meets the floor). Raise `depthThreshold` (m) if small
  steps draw lines, raise `normalThreshold` (degrees) if bevels or normal maps do. Flat ground
  never draws lines, at any angle. Lines go into the image before tonemapping, so TAA smooths them.
- Hover and selection: an `Outline` on the entity (a model's root covers its meshes). Its ring
  draws over the ink and over other outlined things behind it. When an entity and a descendant
  both have one, the higher `priority` wins, then the nearer; give hover `"priority": 1`.
- Check it: `shard screenshot`; `render.describe` lists `toon` per view and `ink` among a view's
  post effects with its GPU time.
