import type { AssetRef, Entity } from '@aethervtt/shard-core'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  captureBuffer,
  describeRender,
  Exposure,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App, animationFrameRunner } from '@aethervtt/shard-runtime'
import { fakeAnimationFrames } from '@aethervtt/shard-runtime/testing'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FogLayer,
  type FogRegion,
  FogRegionsStore,
  FogSettings,
  FogStateResource,
  fogPlugin,
  referenceMask,
  sampleFog,
  setFogRegions,
} from './index'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(() => gpu.destroy())

async function fogApp(options: { fog?: boolean; msaa?: 1 | 4 } = {}) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: options.msaa ?? 1 }),
    ...(options.fog === false ? [] : [fogPlugin]),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'fog', width: 64, height: 64 })
  const ref = world.resource(RenderTargets).add(target, 'fog') as AssetRef<'RenderTarget'>
  world.resource(AmbientLight).brightness = 4000
  // A lit floor under a top-down orthographic camera over (0..20, 0..20).
  const floor = world.resource(Meshes).add(plane({ size: 20 }))
  world.spawn(
    [Mesh3d, { mesh: floor }],
    [
      MeshMaterial,
      {
        material: world
          .resource(Materials)
          .add(new MaterialAsset({ baseColor: [0.8, 0.8, 0.8, 1], roughness: 1 })),
      },
    ],
    [Transform, { translation: [10, 0, 10] }],
  )
  const eye: [number, number, number] = [10, 30, 10.001]
  const cam = world.spawn(
    [Camera3d, { target: ref, projection: 'orthographic', orthoHeight: 20, far: 100 }],
    [Exposure, { ev100: 11 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [10, 0, 10]) }],
  )
  return { app, world, target, cam }
}

function regionsRef(world: App['world'], regions: FogRegion[]): AssetRef<'FogRegions'> {
  return world.resource(FogRegionsStore).add({ rev: 1, regions }) as AssetRef<'FogRegions'>
}

function layer(world: App['world'], regions: AssetRef<'FogRegions'>, texelSize = 0.05): Entity {
  return world.spawn([
    FogLayer,
    { base: 'hidden', extent: { min: [0, 0], max: [20, 20] }, texelSize, regions },
  ])
}

const square = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
]

/** A layer's whole mask, read back. */
async function readMask(entity: Entity, world: App['world']): Promise<Uint8Array> {
  const l = world.resource(FogStateResource).layers.get(entity)!
  const row = Math.ceil(l.width / 256) * 256
  const buffer = gpu.device.createBuffer({
    size: row * l.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = gpu.device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture: l.texture! }, { buffer, bytesPerRow: row }, [
    l.width,
    l.height,
  ])
  gpu.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const all = new Uint8Array(buffer.getMappedRange())
  const out = new Uint8Array(l.width * l.height)
  for (let y = 0; y < l.height; y++) out.set(all.subarray(y * row, y * row + l.width), y * l.width)
  buffer.destroy()
  return out
}

/** A seeded mix of every region kind. */
function randomRegions(count: number, seed: number): FogRegion[] {
  let s = seed
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  const out: FogRegion[] = []
  for (let i = 0; i < count; i++) {
    const cx = rnd() * 20
    const cz = rnd() * 20
    const size = 0.5 + rnd() * 4
    const kind = Math.floor(rnd() * 4)
    const op = rnd() < 0.5 ? 'hide' : 'reveal'
    const strength = rnd() < 0.3 ? 0.3 + rnd() * 0.6 : 1
    const feather = rnd() < 0.5 ? 0 : rnd() * 1.5
    let shape: FogRegion['shape']
    if (kind === 0) shape = { kind: 'rect', x: cx, y: cz, w: size, h: size * (0.5 + rnd()) }
    else if (kind === 1) {
      const n = 3 + Math.floor(rnd() * 8)
      const outer: [number, number][] = []
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2
        const r = size * (0.4 + rnd() * 0.6)
        outer.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r])
      }
      shape = { kind: 'polygon', outer }
    } else if (kind === 2) {
      const points: [number, number][] = []
      let x = cx
      let z = cz
      const n = 2 + Math.floor(rnd() * 12)
      for (let k = 0; k < n; k++) {
        points.push([x, z])
        x += (rnd() - 0.5) * 2
        z += (rnd() - 0.5) * 2
      }
      shape = { kind: 'brush', points, radius: 0.1 + rnd() * 0.8 }
    } else {
      shape = {
        kind: 'multipolygon',
        polygons: [
          { outer: square(cx, cz, cx + size, cz + size) },
          { outer: square(cx + size * 1.5, cz, cx + size * 2.2, cz + size * 0.7) },
        ],
      }
    }
    out.push({ op, strength, feather, shape })
  }
  return out
}

describe('projected fog (0058)', () => {
  it('samples the base in a revealed polygon’s hole, 0 inside it, and 0.5 at half the feather out', async () => {
    const { app, world } = await fogApp()
    const regions = regionsRef(world, [
      {
        op: 'reveal',
        feather: 1,
        shape: { kind: 'polygon', outer: square(5, 5, 15, 15), holes: [square(8, 8, 12, 12)] },
      },
    ])
    layer(world, regions)
    await settle(app)
    const state = world.resource(FogStateResource)
    expect((await sampleFog(world, state, 10, 10)).layers[0]!.value).toBeCloseTo(1, 2)
    expect((await sampleFog(world, state, 6.5, 6.5)).layers[0]!.value).toBeCloseTo(0, 2)
    expect(Math.abs((await sampleFog(world, state, 4.5, 10)).layers[0]!.value - 0.5)).toBeLessThan(
      0.05,
    )
    await app.dispose()
  })

  it(
    'applies 200 mixed hide and reveal regions in order, matching a CPU raster within 1/255 per texel',
    async () => {
      const { app, world } = await fogApp()
      const regions = randomRegions(200, 7)
      const entity = layer(world, regionsRef(world, regions), 0.078125)
      await settle(app)
      const gpuMask = await readMask(entity, world)
      const l = world.resource(FogStateResource).layers.get(entity)!
      const cpu = referenceMask(regions, {
        base: 'hidden',
        extent: [0, 0, 20, 20],
        width: l.width,
        height: l.height,
        texelSize: 0.078125,
      })
      let worst = 0
      let off = 0
      for (let i = 0; i < cpu.length; i++) {
        const d = Math.abs(cpu[i]! - gpuMask[i]!)
        if (d > worst) worst = d
        if (d > 1) off++
      }
      expect(off, `texels more than 1/255 apart (worst ${worst})`).toBe(0)
      await app.dispose()
    },
    timeout(60_000),
  )

  it('appends a brush stroke to 4,000 regions by drawing only that stroke', async () => {
    const { app, world } = await fogApp()
    const base = randomRegions(4000, 11)
    const ref = regionsRef(world, base)
    const entity = layer(world, ref)
    await settle(app)
    const stroke: FogRegion = {
      op: 'reveal',
      feather: 0.3,
      shape: {
        kind: 'brush',
        points: [
          [2, 2],
          [4, 3],
          [6, 2],
        ],
        radius: 0.5,
      },
    }
    setFogRegions(world, ref, { rev: 2, regions: [...base, stroke] })
    app.update(1 / 60)
    const describe = describeRender(world).fog as {
      layers: { entity: Entity; lastUpdate: string; lastDrawn: number; regions: number }[]
      regionsDrawn: number
      gpuMs: number | null
    }
    expect(describe.layers[0]).toMatchObject({
      entity,
      lastUpdate: 'append',
      lastDrawn: 1,
      regions: 4001,
    })
    expect(describe.regionsDrawn).toBe(1)
    // The GPU time lands a frame or two later.
    for (let i = 0; i < 3; i++) {
      await gpu.device.queue.onSubmittedWorkDone()
      await new Promise((r) => setTimeout(r, 20))
      app.update(1 / 60)
    }
    const gpuMs = (describeRender(world).fog as { gpuMs: number | null }).gpuMs
    if (timingMode === 'bench' && gpuMs !== null) expect(gpuMs).toBeLessThan(budget(1))
    await app.dispose()
  })

  it('redraws only the vision layer when its polygons change; the manual mask is untouched', async () => {
    const { app, world } = await fogApp()
    const vision = regionsRef(world, [
      { op: 'reveal', feather: 1, shape: { kind: 'rect', x: 2, y: 2, w: 5, h: 5 } },
    ])
    const manual = regionsRef(world, [
      { op: 'hide', shape: { kind: 'rect', x: 10, y: 10, w: 3, h: 3 } },
    ])
    const v = layer(world, vision)
    const m = world.spawn([
      FogLayer,
      { base: 'revealed', extent: { min: [0, 0], max: [20, 20] }, regions: manual },
    ])
    await settle(app)
    const before = await readMask(m, world)
    setFogRegions(world, vision, {
      rev: 2,
      regions: [{ op: 'reveal', feather: 1, shape: { kind: 'rect', x: 12, y: 2, w: 5, h: 5 } }],
    })
    app.update(1 / 60)
    const layers = (
      describeRender(world).fog as { layers: { entity: Entity; lastUpdate: string }[] }
    ).layers
    expect(layers.find((l) => l.entity === v)!.lastUpdate).toBe('redraw')
    expect(layers.find((l) => l.entity === m)!.lastUpdate).toBe('none')
    expect(await readMask(m, world)).toEqual(before)
    await app.dispose()
  })

  it(
    'redraws 4,000 regions of 1,000 points each',
    async () => {
      const { app, world } = await fogApp()
      const regions: FogRegion[] = []
      for (let i = 0; i < 4000; i++) {
        const outer: [number, number][] = []
        const cx = (i % 64) * 0.3
        const cz = Math.floor(i / 64) * 0.3
        for (let k = 0; k < 1000; k++) {
          const a = (k / 1000) * Math.PI * 2
          outer.push([cx + Math.cos(a) * 0.4, cz + Math.sin(a) * 0.4])
        }
        regions.push({
          op: i % 2 ? 'hide' : 'reveal',
          feather: 0.1,
          shape: { kind: 'polygon', outer },
        })
      }
      const ref = regionsRef(world, regions)
      layer(world, ref)
      await settle(app)
      // Redraw with every tessellation cached: GPU work only.
      setFogRegions(world, ref, { rev: 2, regions: [...regions].reverse() })
      const start = performance.now()
      app.update(1 / 60)
      await gpu.device.queue.onSubmittedWorkDone()
      const ms = performance.now() - start
      expect(
        (describeRender(world).fog as { layers: { lastUpdate: string }[] }).layers[0]!.lastUpdate,
      ).toBe('redraw')
      expect(ms).toBeLessThan(budget(50))
      await app.dispose()
    },
    timeout(120_000),
  )

  it.each([1, 4] as const)(
    'darkens by the viewer’s opacity: 0.45 over hidden fog takes 45%% ± 1%% off the pixel (MSAA %i)',
    async (msaa) => {
      const { app, world, cam } = await fogApp({ msaa })
      const hdr = async () => {
        await settle(app)
        const pending = captureBuffer(world, `camera:${cam}`, 'hdr')
        app.update(1 / 60)
        const shot = await pending
        const o = (32 * 64 + 32) * 4
        return shot.data[o]!
      }
      const layerEntity = layer(world, regionsRef(world, []))
      world.patchResource(FogSettings, { viewerOpacity: 0 })
      const clear = await hdr()
      world.patchResource(FogSettings, { viewerOpacity: 0.45 })
      const fogged = await hdr()
      expect(fogged / clear).toBeGreaterThan(0.55 - 0.01)
      expect(fogged / clear).toBeLessThan(0.55 + 0.01)
      world.despawn(layerEntity)
      await app.dispose()
    },
  )

  it('has no fog pass in a scene without a FogLayer', async () => {
    const { app, world } = await fogApp()
    await settle(app)
    const order = describeRender(world).perView as Record<string, { order: string[] }>
    for (const view of Object.values(order)) {
      expect(view.order).not.toContain('fog/composite')
      expect(view.order).not.toContain('fog/masks')
    }
    await app.dispose()
  })

  it(
    'wakes an idle on-demand app for a new viewerOpacity or new regions, and costs no frames otherwise',
    async () => {
      const frames = fakeAnimationFrames()
      try {
        const { app, world } = await fogApp()
        const ref = regionsRef(world, [
          { op: 'reveal', shape: { kind: 'rect', x: 1, y: 1, w: 3, h: 3 } },
        ])
        layer(world, ref)
        let rendered = 0
        app.onFrame(() => rendered++)
        app.setRunner(animationFrameRunner({ mode: 'on-demand', measureRefresh: false }))
        const running = app.run()
        await Promise.resolve()
        for (let i = 0; i < 20; i++) {
          frames.runUntilIdle()
          await gpu.pipelines.whenIdle()
          await new Promise((r) => setTimeout(r, 5))
        }
        frames.runUntilIdle()
        const idle = rendered
        frames.tick()
        frames.tick()
        expect(rendered).toBe(idle)
        world.patchResource(FogSettings, { viewerOpacity: 0.45 })
        frames.runUntilIdle()
        expect(rendered).toBeGreaterThan(idle)
        const after = rendered
        setFogRegions(world, ref, { rev: 2, regions: [] })
        frames.runUntilIdle()
        expect(rendered).toBeGreaterThan(after)
        await app.dispose()
        await running
      } finally {
        frames.restore()
      }
    },
    timeout(60_000),
  )
})

describe('fog and the rest of the table (0058)', () => {
  it('draws selection outlines over fog, unfogged', async () => {
    const { app, world, cam } = await fogApp()
    const { Outline } = await import('@aethervtt/shard-render')
    const { box } = await import('@aethervtt/shard-mesh')
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 2, y: 0.2, z: 2 })) }],
      [Outline, { color: [0, 1, 0, 1], width: 3 }],
      [Transform, { translation: [10, 0.1, 10] }],
    )
    layer(world, regionsRef(world, []))
    const edge = async () => {
      await settle(app)
      const pending = (await import('@aethervtt/shard-render')).captureView(world, `camera:${cam}`)
      app.update(1 / 60)
      const shot = await pending
      // Just outside the box's edge, on the outline (64 px over 20 m: the box spans 6.4 px).
      let best = 0
      for (let x = 20; x < 44; x++) {
        const o = (32 * 64 + x) * 4
        best = Math.max(best, shot.data[o + 1]! - shot.data[o]!)
      }
      return best
    }
    world.patchResource(FogSettings, { viewerOpacity: 0 })
    const clear = await edge()
    world.patchResource(FogSettings, { viewerOpacity: 1 })
    const fogged = await edge()
    expect(clear).toBeGreaterThan(100)
    expect(Math.abs(fogged - clear)).toBeLessThan(8)
    await app.dispose()
  })

  it('answers fog.describe and fog.sample through the protocol', async () => {
    const { createProtocolServer } = await import('@aethervtt/shard-protocol')
    const { app, world } = await fogApp()
    layer(
      world,
      regionsRef(world, [{ op: 'reveal', shape: { kind: 'rect', x: 0, y: 0, w: 5, h: 5 } }]),
    )
    await settle(app)
    const server = createProtocolServer(app)
    const call = async (method: string, params: unknown) =>
      (await server.handle({ jsonrpc: '2.0', id: 1, method, params }))!
    const described = (await call('fog.describe', {})).result as { layers: { regions: number }[] }
    expect(described.layers[0]!.regions).toBe(1)
    const inside = (await call('fog.sample', { x: 2, z: 2 })).result as { composite: number }
    const outside = (await call('fog.sample', { x: 15, z: 15 })).result as { composite: number }
    expect(inside.composite).toBeCloseTo(0, 2)
    expect(outside.composite).toBeCloseTo(1, 2)
    expect((await call('fog.sample', { x: 2 })).error?.data).toMatchObject({
      code: 'protocol/invalid-params',
    })
    server.close()
    await app.dispose()
  })
})
