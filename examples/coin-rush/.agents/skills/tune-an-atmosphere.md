# Tune an alien sky

`render/Atmosphere` on a planet entity (the `terrain/Planet`, or any entity: it's centered on
its origin) gives it a sky you can see from the surface, from a ship, and from orbit as a glowing
limb. It also hazes distant terrain and dims and reddens the sun near the horizon, for lighting too.
`bottomRadius: 0` takes the Planet's radius. Units are physical: metres and 1/m.

```json
"render/Atmosphere": { "thickness": 60000, "rayleighScattering": [5.8e-6, 13.6e-6, 33.1e-6] }
```

Presets (`AtmospherePresets` in code; copy the values into a scene): `earth` (the defaults),
`mars`, `thin`, `thick-haze`, `alien-violet`, `gas-giant`.

Which knob does what:

- **Sky color and sunset color: `rayleighScattering`.** The sky takes the color that scatters most;
  sunsets get what's left after the long path. Blue above red gives a blue sky with orange sunsets.
  Reverse it for a red sky with blue sunsets; raise red and blue for violet. Scale all three
  together to thicken or thin the air.
- **Haze and the glow around the sun: `mieScattering`** (4e-6 very clear, 1e-4 hazy) with
  `mieScale` (how high the haze reaches) and `mieG` (how tight the halo is). `mieAbsorption` makes
  the haze dirtier and darker. `mieGOffset` gives different colors different halos: Mars' blue
  sunset is blue scattered more forward, `[-0.15, 0, 0.2]`.
- **Twilight and tinted air: `absorption`**, a layer at `absorptionCenter` `absorptionWidth` wide.
  Earth's ozone keeps twilight blue; at center 0 and a wide layer it's dust (Mars' butterscotch) or
  methane (Neptune's blue: absorb red).
- **How far you see: all of the above.** Distant terrain turns the sky's color; 20 km on Earth is
  noticeably blue, a few km in `thick-haze`.
- **Ground below the horizon:** `groundAlbedo`, where no terrain is drawn (from high up, or before
  chunks load).
- **Gas giants:** `bottomRadius` is the cloud top and `deckDepth` the haze below it that thickens to
  opaque cloud as a ship dives.

Check it without screenshots: MCP `sample_atmosphere` (`{ "direction": [0, 1, 0] }`) gives sky
radiance and transmittance from the camera; with `position` 40 km up the sky should be near black.
`render.describe`'s `atmosphere` section lists each camera's primary atmosphere, the sunlight
reaching the camera (`illuminanceAtCamera`), and GPU time. In code, `sunTransmittanceAt(world,
planet, position)` is how much sunlight gets through, for gameplay (solar panels, heat).

- The sun's `DirectionalLight.illuminance` is above the air (direct-sun 100 000). Its
  `angularDiameter` (0.53°) sizes the disk; the two brightest lights both draw one.
- `render/AtmosphereSettings` on a camera: `aerialPerspective: false` for only the sky; the froxel
  range `maxDistance` (32 km) beyond which haze is marched per pixel.
- `render/Fog` is for flat scenes: inside an atmosphere it's ignored (`render/fog-with-atmosphere`)
  unless `mode: "add"`, for ground fog on top.
- `render/ProceduralSky` is an Earth atmosphere pinned 10 m under the camera: fine for a level, but
  you can't fly out of it.
