import { assetServer, MissingAsset } from '@aethervtt/shard-assets'
import { type AssetRef, ShardError, t } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { createGpuContext, type GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext, nodeGpu } from '@aethervtt/shard-gpu/node'
import { cube, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, MaterialAssetType, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { RenderHealth, RenderHealthChanged } from './health'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight } from './lights'
import { defineMaterial } from './materials'
import { Gpu, renderPlugin, Shaders } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'

// Failure recovery (0061): fallbacks for assets that fail, the standard pipeline for materials whose
// shader fails, device loss, and owners that take their GPU objects with them.

const here = import.meta.dirname

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

async function scene(context = gpu, size = 16) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu: context, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(context, { label: 'recovery', width: size, height: size })
  const ref = world.resource(RenderTargets).add(target, 'recovery') as AssetRef<'RenderTarget'>
  world.resource(AmbientLight).brightness = 2000
  world.spawn(
    [DirectionalLight, { illuminance: 8000 }],
    [Transform, { rotation: lookAt([0, 1, 2], [0, 0, 0]) }],
  )
  const cam = world.spawn(
    [Camera3d, { target: ref, clearColor: [0, 0, 1, 1] }],
    [Exposure, { ev100: 11 }],
    [Transform, { translation: [0, 0, 3], rotation: lookAt([0, 0, 3], [0, 0, 0]) }],
  )
  const center = async () => pixel(await renderView(app, `camera:${cam}`), size / 2, size / 2)
  return { app, world, target, cam, center }
}

/** RenderHealth transitions, as they happen. */
function transitions(world: App['world']): string[] {
  const seen: string[] = []
  world.observe(RenderHealthChanged, ({ data }) => seen.push(data.to))
  return seen
}

/** A solid-color 4×4 texture. */
function solid(rgba: [number, number, number, number]): Texture {
  const pixels = new Uint8Array(4 * 4 * 4)
  for (let i = 0; i < 16; i++) pixels.set(rgba, i * 4)
  return Texture.create({ width: 4, height: 4, mips: [pixels], usage: 'color' })
}

describe('asset fallbacks (0061)', () => {
  it(
    'a failed texture, a failed mesh and a deleted texture draw fallbacks, carry MissingAsset, degrade RenderHealth, and come back after retry',
    async () => {
      const { app, world, center } = await scene()
      const errorsBefore = gpu.errors.length
      const server = assetServer(world)
      let broken = true
      const fail = () => {
        if (broken) throw new ShardError('assets/load-failed', 'HTTP 404')
      }
      const texture = server.virtual('rec-tex', 'art/token.png', 'Texture', () => {
        fail()
        return solid([255, 0, 0, 255])
      })
      const mesh = server.virtual('rec-mesh', 'models/token.glb#Mesh0', 'Mesh', () => {
        fail()
        return plane({ size: 1.2 })
      })
      expect(server.state(texture.path)).toBe('failed')
      const material = world.resource(Materials).add(
        new MaterialAsset({
          baseColorTexture: {
            texture: { type: 'Texture', guid: texture.guid, path: texture.path },
          },
          roughness: 1,
        }),
      )
      const quad = world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 3 })) }],
        [MeshMaterial, { material }],
        [Transform, { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }],
      )
      const box = world.spawn(
        [Mesh3d, { mesh: { type: 'Mesh', guid: mesh.guid, path: mesh.path } }],
        [Transform, { translation: [0, 0, 1] }],
      )
      const changes = transitions(world)
      // The failed texture shows as neutral gray, and the failed mesh as the missing box in front.
      const before = await center()
      expect(Math.abs(before[0]! - before[1]!)).toBeLessThan(12)
      expect(before[2]!).toBeLessThan(200)
      expect(world.get(quad, MissingAsset).ref).toBe('art/token.png')
      expect(world.get(box, MissingAsset)).toMatchObject({
        ref: mesh.path,
        code: 'assets/load-failed',
      })
      const health = world.resource(RenderHealth)
      expect(health.state).toBe('degraded')
      expect(health.issues.map((i) => i.ref).sort()).toEqual([mesh.path, texture.path].sort())
      expect(changes.splice(0)).toEqual(['degraded'])

      broken = false
      await server.retry(texture.path)
      await server.retry(mesh.path)
      world.despawn(box)
      const after = await center()
      expect(after[0]!).toBeGreaterThan(after[1]! + 60)
      expect(world.has(quad, MissingAsset)).toBe(false)
      expect(world.resource(RenderHealth).state).toBe('ok')
      expect(changes.splice(0)).toEqual(['ok'])

      // A texture that left its store (deleted) draws the fallback too, instead of waiting forever.
      const gone = world.resource(Textures).add(solid([0, 255, 0, 255]))
      world.resource(Textures).delete(gone.guid!)
      world.set(quad, MeshMaterial, {
        material: world
          .resource(Materials)
          .add(new MaterialAsset({ baseColorTexture: { texture: gone } })),
      })
      const deleted = await center()
      expect(Math.abs(deleted[0]! - deleted[1]!)).toBeLessThan(12)
      expect(world.get(quad, MissingAsset).code).toBe('assets/not-found')
      expect(world.resource(RenderHealth).state).toBe('degraded')
      expect(gpu.errors.slice(errorsBefore)).toEqual([])
      await app.dispose()
    },
    timeout(60_000),
  )

  it('draws a mesh ref the catalog never had as the missing box', async () => {
    const { app, world, center } = await scene()
    const entity = world.spawn(
      [Mesh3d, { mesh: { type: 'Mesh', guid: 'no-such-guid', path: 'models/gone.glb#Mesh0' } }],
      Transform,
    )
    const seen = await center()
    expect(seen[2]!).toBeLessThan(200) // the box, not the blue clear
    expect(world.get(entity, MissingAsset).code).toBe('assets/not-found')
    await app.dispose()
  })

  it("keeps a failed material's readable base color in its standard fallback", () => {
    const ctx = { guid: 'rec-mat', path: 'materials/lava.material.json', resolve: () => undefined }
    expect(() =>
      MaterialAssetType.load({ json: { type: 'nope/Unknown', baseColor: [1, 0, 0, 1] } }, ctx),
    ).toThrow()
    const fallback = MaterialAssetType.fallback!({
      guid: 'rec-mat',
      path: ctx.path,
      error: new ShardError('assets/load-failed', 'x'),
      dev: false,
      world: undefined as never,
    })
    expect(fallback.type.name).toBe('render/StandardMaterial')
    expect([...fallback.value.baseColor]).toEqual([1, 0, 0, 1])
  })
})

describe('shader failures (0061)', () => {
  it(
    'draws a material type with a WGSL error through the standard pipeline, names the type and line, and recovers',
    async () => {
      const { app, world, center } = await scene()
      const shaders = world.resource(Shaders)
      const broken = `import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  p.base_color = vec3f(0.0);
  p.emissive = vec3f(0.0, 2000.0, 0.0) +;
  return p;
}`
      shaders.register('project::glow', broken, 'shaders/glow.wesl')
      const Glow = defineMaterial('recovery-test/Glow', {
        fields: { strength: t.f32({ default: 1 }) },
        shader: 'project::glow',
      })
      world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1.5 })) }],
        [
          MeshMaterial,
          {
            material: world
              .resource(Materials)
              .add(new MaterialAsset({ baseColor: [1, 0, 0, 1] }, Glow)),
          },
        ],
        Transform,
      )
      const fallback = await center()
      // Standard lighting in the material's own base color: red, not the missing green glow.
      expect(fallback[0]!).toBeGreaterThan(fallback[1]! + 40)
      const errors = world.resource(Gpu).errors
      const error = errors.find((e) => e.message.includes('material recovery-test/Glow'))
      expect(error?.path).toMatch(/^shaders\/glow\.wesl:6:\d+$/)
      const health = world.resource(RenderHealth)
      expect(health.state).toBe('degraded')
      expect(health.issues).toContainEqual(
        expect.objectContaining({ code: 'render/material-fallback', ref: 'recovery-test/Glow' }),
      )
      // Defining the type again with working code clears the mark: the glow draws.
      shaders.register('project::glow', broken.replace(' +;', ';'), 'shaders/glow.wesl')
      defineMaterial('recovery-test/Glow', {
        fields: { strength: t.f32({ default: 1 }) },
        shader: 'project::glow',
      })
      await shaders.whenIdle()
      const fixed = await center()
      expect(fixed[1]!).toBeGreaterThan(fixed[0]! + 40)
      expect(world.resource(RenderHealth).state).toBe('ok')
      await app.dispose()
    },
    timeout(60_000),
  )
})

describe('device loss (0061)', () => {
  it(
    'goes ok → lost → ok and renders the same afterwards',
    async () => {
      const context = await createNodeGpuContext()
      try {
        const { app, world, cam } = await scene(context, 32)
        world.spawn(
          [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1.5 })) }],
          [
            MeshMaterial,
            {
              material: world
                .resource(Materials)
                .add(new MaterialAsset({ baseColor: [0.8, 0.5, 0.2, 1] })),
            },
          ],
          [Transform, { rotation: [0.2, 0.3, 0, 0.93] }],
        )
        const first = await renderView(app, `camera:${cam}`)
        const changes = transitions(world)
        context.simulateDeviceLoss()
        app.update(1 / 60)
        expect(world.resource(RenderHealth).state).toBe('lost')
        await context.recreate()
        await settle(app)
        const again = await renderView(app, `camera:${cam}`)
        expect(changes.splice(0)).toEqual(['lost', 'ok'])
        expect(compareGolden(here, 'recovery-device-loss', first).mean).toBeLessThan(1.5)
        expect(compareGolden(here, 'recovery-device-loss', again).mean).toBeLessThan(1.5)
        await app.dispose()
      } finally {
        context.destroy()
      }
    },
    timeout(60_000),
  )

  it('goes failed when the device can’t be replaced after 3 tries', async () => {
    const real = nodeGpu()
    let adapters = 0
    const flaky = {
      getPreferredCanvasFormat: () => real.getPreferredCanvasFormat(),
      requestAdapter: (o?: GPURequestAdapterOptions) =>
        adapters++ === 0 ? real.requestAdapter(o) : Promise.resolve(null),
    } as unknown as GPU
    const context = await createGpuContext({ gpu: flaky, recovery: { attempts: 3, intervalMs: 5 } })
    try {
      const { app, world } = await scene(context)
      const changes = transitions(world)
      context.simulateDeviceLoss()
      app.update(1 / 60)
      await context.recreate().catch(() => {})
      app.update(1 / 60)
      expect(adapters).toBe(4)
      expect(context.status).toBe('failed')
      expect(world.resource(RenderHealth).state).toBe('failed')
      expect(changes.splice(0)).toEqual(['lost', 'failed'])
      expect(context.errors.at(-1)?.code).toBe('gpu/recovery-failed')
      await app.dispose()
    } finally {
      context.destroy()
    }
  })
})

describe('owners and GPU memory (0061)', () => {
  it(
    'releasing an owner with 1,000 entities, 20 textures and 10 meshes returns gpu.stats and the stores to their counts; shared leases stay',
    async () => {
      const { app, world, center } = await scene()
      const errorsBefore = gpu.errors.length
      const server = assetServer(world)
      for (let i = 0; i < 20; i++) {
        server.virtual(`own-tex-${i}`, `art/tex-${i}.png`, 'Texture', () =>
          solid([i * 12, 100, 200 - i * 8, 255]),
        )
      }
      for (let i = 0; i < 10; i++) {
        server.virtual(`own-mesh-${i}`, `models/m-${i}.glb#Mesh0`, 'Mesh', () =>
          cube({ size: 0.02 + i * 0.001 }),
        )
      }
      for (let i = 0; i < 20; i++) {
        const texture = { type: 'Texture' as const, guid: `own-tex-${i}`, path: `art/tex-${i}.png` }
        server.virtual(
          `own-mat-${i}`,
          `materials/m-${i}.material.json`,
          'Material',
          () => new MaterialAsset({ baseColorTexture: { texture } }),
          { lazy: true },
        )
      }
      await center() // warm: pipelines and per-frame buffers exist before counting
      const load = async () => {
        const scene = world.owners.create('scene:abc')
        const other = world.owners.create('scene:other')
        const texRefs = Array.from({ length: 20 }, (_, i) =>
          server.lease<'Texture'>(`art/tex-${i}.png`, scene),
        )
        server.lease('art/tex-0.png', other) // shared with another owner
        const meshRefs = Array.from({ length: 10 }, (_, i) =>
          server.lease<'Mesh'>(`models/m-${i}.glb#Mesh0`, scene),
        )
        expect(texRefs).toHaveLength(20)
        const mats = Array.from({ length: 20 }, (_, i) =>
          server.lease<'Material'>(`materials/m-${i}.material.json`, scene),
        )
        for (let i = 0; i < 1000; i++) {
          world.owners.spawn(
            scene,
            [Mesh3d, { mesh: meshRefs[i % 10]! }],
            [MeshMaterial, { material: mats[i % 20]! }],
            [
              Transform,
              { translation: [((i % 40) - 20) * 0.05, Math.floor(i / 40) * 0.05 - 0.6, 0] },
            ],
          )
        }
        await center()
        const described = world.owners.describe(scene)
        expect(described.usage.entities).toBe(1000)
        expect(described.leases).toHaveLength(50)
        expect(described.gpu).toMatchObject({ textures: 20 })
        expect((described.gpu as { buffers: number }).buffers).toBeGreaterThanOrEqual(
          10 * 6 + 20 * 2,
        )
        return { scene, other }
      }
      const release = async ({ scene, other }: Awaited<ReturnType<typeof load>>) => {
        world.owners.release(scene)
        await center()
        return other
      }
      // One cycle first: instance and upload buffers grow to fit 1,000 and stay grown (pools).
      world.owners.release(await release(await load()))
      await center()
      const entities = world.entityCount
      const stats = gpu.stats()
      const textures = world.resource(Textures).size
      const meshes = world.resource(Meshes).size
      const loaded = await load()
      expect(gpu.stats().textures).toBeGreaterThan(stats.textures)
      const other = await release(loaded)
      // The texture another owner leases stays loaded, with its GPU copy.
      expect(server.state('art/tex-0.png')).toBe('loaded')
      expect(world.resource(Textures).size).toBe(textures + 1)
      world.owners.release(other)
      await center()
      expect(world.entityCount).toBe(entities)
      expect(world.resource(Textures).size).toBe(textures)
      expect(world.resource(Meshes).size).toBe(meshes)
      expect(gpu.stats()).toEqual(stats)
      expect(gpu.errors.slice(errorsBefore)).toEqual([])
      await app.dispose()
    },
    timeout(120_000),
  )
})
