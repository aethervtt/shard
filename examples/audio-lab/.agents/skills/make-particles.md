# Make a particle effect

Add `"particles"` to `plugins` in `shard.json`. An effect is `assets/fx/<name>.particles.json`,
validated against `.shard/schemas/particle-effect.schema.json` (errors point into the file):

```json
{ "emitters": [{ "name": "exhaust", "capacity": 20000, "spawn": { "rate": 4000 },
  "shape": { "type": "cone", "angle": 8, "radius": 0.2 },
  "init": { "lifetime": [0.3, 0.6], "speed": [18, 25], "size": [0.2, 0.35], "color": "#9ad4ff" },
  "update": [{ "module": "drag", "coefficient": 1.5 }, { "module": "curl-noise", "strength": 2 },
    { "module": "color-over-life", "gradient": [[0, "#e9f6ff", 1], [1, "#1a3a7a", 0]] }],
  "render": { "blend": "additive", "emissive": 4000 } }] }
```

- Values: a number or `[min, max]`; curves `[[t, v], …]`; gradients `[[t, color, alpha], …]`.
- Modules: gravity, drag, velocity-over-life, curl-noise, attractor, rotation, color-over-life,
  size-over-life, collision (bounces off what the camera sees).
- Use it: `"particles/ParticleSystem": { "effect": { "path": "assets/fx/exhaust.particles.json" } }`;
  `space: "local"` keeps particles attached. Drive it from gameplay with
  `particles/ParticleEmitterOverrides` (`spawnScale`). Saving the file updates the running effect.
- Look: MCP `preview_asset` on the file shows it after one second; `render.describe` →
  `particles` gives alive counts.
