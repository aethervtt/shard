# Make a generator

Don't place 10 000 rocks: write the rule for one rock and let seeds make the rest. A generator is a
pure function `(seed, params) → output` (a mesh, a texture, a data value, or entities), cached by the
hash of its inputs, so the same seed gives the same bytes on every host.

1. Define it in `scripts/` (any module the entry imports):

```ts
export const Rock = project.generator('Rock', {
  params: {
    radius: t.f32({ default: 1, min: 0.05, unit: 'm' }),
    roughness: t.f32({ default: 0.3, min: 0, max: 1 }),
    detail: t.u8({ default: 3, min: 0, max: 6 }),
    shape: t.handle('NoiseGraph', { description: 'Displacement noise.' }),
  },
  output: 'mesh',
  run(ctx, p) {
    const mesh = ctx.mesh.icosphere(p.detail)
    const shape = ctx.load<NoiseGraph>(p.shape) // only handles in params; editing it regenerates
    const n = new Float32Array(mesh.positions.length / 3)
    ctx.noise.sample(shape, ctx.seed, mesh.positions, n)
    for (let i = 0; i < n.length; i++) {
      const s = p.radius * (1 + p.roughness * n[i]!)
      for (let k = 0; k < 3; k++) mesh.positions[i * 3 + k]! *= s
    }
    return ctx.mesh.finish(mesh, { normals: true, tangents: true, lods: [0.5, 0.2] })
  },
})
```

   `output` is `'mesh'`, `'texture'` (`{ width, height, mips: [rgba8] }`), `'data'` or a data type
   (`project.dataAsset`), or `'entities'` (a prefab-shaped entity `{ name, components, children }`,
   or a list of them). A generator can use another: `await ctx.generate(Planet, params, ctx.childSeed(i))`
   returns a ref to put in its output; each is cached on its own.
2. Keep it pure. Randomness is `ctx.rng` (seeded from the seed and the generator's name), per-part
   seeds `ctx.childSeed(label)`. `Math.random`, `Date.now`, and `performance.now` throw
   `procgen/nondeterministic` (and `shard check` flags them). Prefer `+ * sqrt` over trig for
   geometry that must match across browsers.
3. Look at it: MCP `preview_generator { "generator": "maze-chase/Rock", "seeds": "1-9", "params": { "roughness": 0.6 } }`
   (or `shard gen scripts:Rock --seeds 1-9 --out sheet.png`) renders a labelled contact sheet. Change
   one param, preview again, compare. `run_generator` reports vertex and triangle counts, bounds,
   the cache key, and whether it was a cache hit.
4. Place it:
   - a file `generators/boulder.gen.json` (schema `.shard/schemas/gen.schema.json`):
     `{ "generator": "maze-chase/Rock", "seed": 3, "params": { "radius": 2, "shape": { "path": "assets/noise/rock.noise.json" } } }`,
     then `"mesh": { "path": "generators/boulder.gen.json" }` in a prefab (`#LOD1` for a level of detail)
   - a ref: `"mesh": { "path": "procedural:maze-chase/Rock?seed=3&radius=2" }`
   - entities: `"procgen/GeneratorInstance": { "generator": { "path": "maze-chase/StarSystem" }, "seed": 7 }`
     spawns the fragment as children; patching `seed` regenerates and keeps the ids of unchanged paths
   - at runtime: `const mesh = await generate(world, Rock, { radius: 2 }, seed)`
5. `shard validate` checks every `*.gen.json` against its generator (`procgen/bad-params` with a pointer).
   Editing the generator's code (or a helper it imports) regenerates its outputs on hot reload; the
   reload report lists them under `procgen.regenerated`.
