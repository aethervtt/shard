# Light 2D: lights, normal maps, shadows

Sprites are unlit until their camera has `"sprite/Lighting2d": { "ambient": [0.08, 0.08, 0.1, 1] }`.
Then each lit sprite shows `albedo × (ambient + Σ lights) + albedo × emissive`: a light of
intensity 1 at its center shows the sprite at its texture color. For a bright scene where lights
only add, use `"ambient": [1, 1, 1, 1]`.

1. Lights: `"sprite/PointLight2d": { "color": [1, 0.7, 0.4, 1], "intensity": 1.5, "radius": 6 }`.
   `"sprite/SpotLight2d"` adds `innerAngle` / `outerAngle` (degrees) and points along the
   entity's +X: rotate the entity (or parent it to a hand) to aim it. `falloff` tightens the
   edge; `height` is how high above the sprites it sits (low grazes normal maps).
2. Shadows: `"shadows": true` on the light (at most `Lighting2d.maxShadowed`, 64, per view; the
   nearest win) and `"sprite/LightOccluder2d"` on what blocks it: `"shape": "box"` with `size`,
   `"circle"` (`size[0]` is the radius), `"polygon"` with `points`, `"sprite"` (the sprite's
   outline), or `"collider"` (its physics Collider). `softness` on the light widens penumbras
   (0: hard). Tile walls: set `"occludes": true` on the layer in `*.tilemap.json`.
3. Normal maps: name them `hero_n.png` next to `hero.png` in an atlas-pack folder and they pack
   into a matching page (`"normalMap": "directx"` in the pack file flips green). Plain texture
   sprites: `"sprite/SpriteLighting": { "normal": { "path": "assets/rock_n.png" } }`. Add
   `"outlines": true` to the pack file for `shape: 'sprite'` occluders that follow the alpha.
4. Glow and exceptions: `SpriteLighting.emissive` for eyes and screens; `"lit": false` on a Sprite
   (flames, UI, particles that shine on their own). `layers` on lights and occluders masks which
   layer bands they touch (bit k covers layers k×64 − 1024 …).
5. Check: `render.describe` → `sprites.lighting` (lights lit, culled, dropped over budget,
   shadowed and demoted, occluder segments, tiles at the 64-light cap, GPU ms), the `lights2d`
   overlay in a screenshot (radii, cones, each shadow row as a ring, occluder segments), and the log
   for `sprite/invalid-occluder`, `sprite/too-many-lights`, `sprite/too-many-shadowed-lights`.
