import { t } from '@aethervtt/shard-core'
import type { NoiseGraph } from '@aethervtt/shard-noise'
import { defineGenerator } from '@aethervtt/shard-procgen'

// The example's generators (examples/star-explorer/scripts/rock.ts), under the playground's
// namespace. Imported by the page and by the worker module, so both define them.

/** A boulder: an icosphere displaced along its normals by a noise graph. */
export const Rock = defineGenerator('playground/Rock', {
  params: {
    radius: t.f32({ default: 1, min: 0.05, unit: 'm' }),
    roughness: t.f32({ default: 0.3, min: 0, max: 1 }),
    detail: t.u8({ default: 3, min: 0, max: 6 }),
    shape: t.handle('NoiseGraph', {
      default: { type: 'NoiseGraph', guid: undefined, path: 'assets/rock.noise.json' },
    }),
  },
  output: 'mesh',
  run(ctx, p) {
    const mesh = ctx.mesh.icosphere(p.detail)
    const shape = ctx.load<NoiseGraph>(p.shape)
    const pos = mesh.positions
    const n = new Float32Array(pos.length / 3)
    ctx.noise.sample(shape, ctx.seed, pos, n)
    for (let i = 0; i < n.length; i++) {
      const s = p.radius * (1 + p.roughness * n[i]!)
      pos[i * 3] = pos[i * 3]! * s
      pos[i * 3 + 1] = pos[i * 3 + 1]! * s
      pos[i * 3 + 2] = pos[i * 3 + 2]! * s
    }
    return ctx.mesh.finish(mesh, { normals: true, tangents: true, lods: [0.5, 0.2] })
  },
})

/** Rocks scattered in a shell, each its own Rock output. */
export const AsteroidField = defineGenerator('playground/AsteroidField', {
  params: {
    count: t.u32({ default: 60, min: 1, max: 512 }),
    radius: t.f32({ default: 9, min: 0, unit: 'm' }),
    spread: t.f32({ default: 5, min: 0, unit: 'm' }),
    roughness: t.f32({ default: 0.4, min: 0, max: 1 }),
    material: t.handle('Material'),
  },
  output: 'entities',
  async run(ctx, p) {
    const rocks = []
    for (let i = 0; i < p.count; i++) {
      let x = 0
      let y = 0
      let z = 0
      let d = 0
      do {
        x = ctx.rng.range(-1, 1)
        y = ctx.rng.range(-0.35, 0.35)
        z = ctx.rng.range(-1, 1)
        d = x * x + y * y + z * z
      } while (d > 1 || d < 0.05)
      const r = (p.radius + ctx.rng.range(-p.spread, p.spread) / 2) / Math.sqrt(d)
      const mesh = await ctx.generate(
        Rock,
        { radius: ctx.rng.range(0.25, 0.9), roughness: p.roughness, detail: 3 },
        ctx.childSeed(i),
      )
      rocks.push({
        name: `rock-${i}`,
        components: {
          'core/Transform': { translation: [x * r, y * r, z * r] },
          'render/Mesh3d': { mesh },
          ...(p.material ? { 'render/MeshMaterial': { material: p.material } } : {}),
        },
      })
    }
    return rocks
  },
})
