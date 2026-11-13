import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube } from '@aethervtt/shard-mesh'
import {
  ForwardStateResource,
  Gpu,
  Instances,
  LightingSettings,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  readTextureLayer,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StructureChunk, StructureSettings, StructureShadowProxy } from './components'
import { maxScene } from './fixtures'
import { rig } from './harness'

// Shadow proxies (0116): a region's opaque structure merged into one shadow-only mesh per group.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** The max fixture under a cached sun, with proxies of `region` meters (0: none). */
async function scene(region: number) {
  const r = await rig(gpu, { shadowUpdate: 'on-change' })
  const world = r.app.world
  world.resource(LightingSettings).cascadeMapSize = 512
  world.patchResource(StructureSettings, { shadowRegion: region })
  // Far-off casters that set the scene's caster bounds whatever the proxies' spheres are, so both
  // runs fit the same depth range (GPU culling fits it to every caster's bounds).
  const unit = world.resource(Meshes).add(cube({ size: 4 }))
  const material = world.resource(Materials).add(new MaterialAsset({}))
  for (const [x, y, z] of [
    [-600, 0, -600],
    [600, 0, 600],
    [-600, 300, 600],
    [600, 300, -600],
  ] as const)
    world.spawn(
      [Mesh3d, { mesh: unit }],
      [MeshMaterial, { material }],
      [Transform, { translation: [x, y, z] }],
    )
  r.host.sync(maxScene())
  r.look([60, 40, 90], [100, 0, 40])
  await settle(r.app)
  for (let i = 0; i < 3; i++) r.frame()
  return r
}

describe('structure shadow proxies (0116)', () => {
  it('draw cascade layers bit-identical to the chunk meshes they stand for', {
    timeout: timeout(180_000),
  }, async () => {
    const layers: Float32Array[][] = []
    for (const region of [32, 0]) {
      const r = await scene(region)
      const world = r.app.world
      const proxies = world.query({ with: [StructureShadowProxy] }).entities().length
      if (region > 0) expect(proxies).toBeGreaterThan(0)
      else expect(proxies).toBe(0)
      const cascades = world.resource(ForwardStateResource).views.get(r.view)!.cascades
      const out: Float32Array[] = []
      for (let i = 0; i < cascades.count; i++)
        out.push(
          (await readTextureLayer(world.resource(Gpu), cascades.texture!, i)).data as Float32Array,
        )
      layers.push(out)
      await r.dispose()
    }
    for (let i = 0; i < layers[0]!.length; i++) {
      const a = layers[0]![i]!
      const b = layers[1]![i]!
      let differ = 0
      for (let k = 0; k < a.length; k += 4) if (a[k] !== b[k]) differ++
      expect(differ, `cascade ${i}: texels that differ`).toBe(0)
    }
  })

  it('a full redraw of four cascades draws proxies instead of thousands of chunk meshes', {
    timeout: timeout(180_000),
  }, async () => {
    const draws: number[] = []
    for (const region of [32, 0]) {
      const r = await scene(region)
      const world = r.app.world
      // Turn the sun: every static layer redraws, one a frame.
      world.set(r.sun, Transform, { rotation: [0.2, 0.1, 0, 0.97] })
      const cascades = world.resource(ForwardStateResource).views.get(r.view)!.cascades
      let total = 0
      let full = 0
      for (let f = 0; f < 6 && full < cascades.count; f++) {
        r.frame()
        for (let i = 0; i < cascades.count; i++) {
          if (!(cascades.fullMask & (1 << i))) continue
          full++
          total += cascades.views[i]!.draws.length
        }
      }
      expect(full).toBe(cascades.count)
      draws.push(total)
      if (region > 0) {
        // What still casts for itself: chunk meshes of materials that don't merge, and the rest.
        const store = world.resource(Instances)
        const chunks = world.query({ with: [StructureChunk] }).entities()
        const casting = chunks.filter((e) => !world.has(e, NotShadowCaster)).length
        const proxies = world.query({ with: [StructureShadowProxy] }).entities().length
        expect(total).toBeLessThanOrEqual(
          cascades.count * (proxies + casting + store.batches.length - chunks.length),
        )
      }
      await r.dispose()
    }
    // Measured (Apple M5 Max, 2026-11-13): 572 draws with proxies, 38,304 without.
    const [proxied, chunked] = draws as [number, number]
    expect(proxied * 10).toBeLessThan(chunked)
  })
})
