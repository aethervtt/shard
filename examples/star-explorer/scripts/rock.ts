import { t } from '@aethervtt/shard-core'
import type { NoiseGraph } from '@aethervtt/shard-noise'
import { defineGenerator } from '@aethervtt/shard-procgen'
import { displaceAlongNormals } from './displace'

/**
 * A boulder: an icosphere displaced by a noise graph, with normals, tangents, and two levels of
 * detail. Place one with `generators/*.gen.json` or `procedural:star-explorer/Rock?seed=3`.
 */
export const Rock = defineGenerator('star-explorer/Rock', {
  description: 'A boulder: an icosphere displaced along its normals by a noise graph.',
  params: {
    radius: t.f32({ default: 1, min: 0.05, unit: 'm', description: 'Size before displacement.' }),
    roughness: t.f32({
      default: 0.3,
      min: 0,
      max: 1,
      description: 'How far the noise pushes the surface, as a fraction of the radius.',
    }),
    detail: t.u8({ default: 3, min: 0, max: 6, description: 'Icosphere subdivisions.' }),
    shape: t.handle('NoiseGraph', {
      default: { type: 'NoiseGraph', guid: undefined, path: 'assets/noise/rock.noise.json' },
      description: 'Displacement noise, sampled on the unit sphere.',
    }),
  },
  output: 'mesh',
  run(ctx, p) {
    const mesh = ctx.mesh.icosphere(p.detail)
    const shape = ctx.load<NoiseGraph>(p.shape)
    displaceAlongNormals(mesh, ctx.noise, shape, ctx.seed, p.radius, p.roughness)
    return ctx.mesh.finish(mesh, { normals: true, tangents: true, lods: [0.5, 0.2] })
  },
})

/**
 * A cluster of boulders: `count` rocks scattered in a shell, each its own `Rock` output (cached on
 * its own, so changing one rock's params rebuilds only it). Spawn it with procgen/GeneratorInstance.
 */
export const AsteroidField = defineGenerator('star-explorer/AsteroidField', {
  description: 'Boulders scattered in a shell around the instance, each a Rock output.',
  params: {
    count: t.u32({ default: 12, min: 1, max: 256, description: 'How many rocks.' }),
    radius: t.f32({ default: 20, min: 0, unit: 'm', description: 'Shell radius.' }),
    spread: t.f32({ default: 6, min: 0, unit: 'm', description: 'Shell thickness.' }),
    size: t.vec2({ default: [0.4, 1.6], description: 'Rock radius range [min, max].' }),
    material: t.handle('Material', { description: 'The rocks’ material.' }),
  },
  output: 'entities',
  async run(ctx, p) {
    const rocks = []
    for (let i = 0; i < p.count; i++) {
      // A direction in the unit ball's shell, by rejection (no trig: same result everywhere).
      let x = 0
      let y = 0
      let z = 0
      let d = 0
      do {
        x = ctx.rng.range(-1, 1)
        y = ctx.rng.range(-1, 1)
        z = ctx.rng.range(-1, 1)
        d = x * x + y * y + z * z
      } while (d > 1 || d < 1e-4)
      const r = (p.radius + ctx.rng.range(-p.spread, p.spread) / 2) / Math.sqrt(d)
      const mesh = await ctx.generate(
        Rock,
        { radius: ctx.rng.range(p.size[0]!, p.size[1]!), roughness: 0.4, detail: 2 },
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
