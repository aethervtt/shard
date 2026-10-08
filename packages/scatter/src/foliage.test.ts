import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import type { AssetRef } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { procgenPlugin } from '@aethervtt/shard-procgen'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  Exposure,
  FoliageLayers,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { pixel, pngBytes, renderView, settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prop, ScatterSurface } from './components'
import { scatterPlugin } from './plugin'
import { Scatter } from './runtime'
import { ScatterSet } from './set'

const shots = process.env.SHARD_SHOTS
const W = 128
const H = 128
const roots: string[] = []
let gpu: GpuContext

beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => {
  gpu?.destroy()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const SET = {
  rules: [
    {
      name: 'boulders',
      items: [{ generator: 'shard/Rock', params: { detail: 2, radius: 1.2 }, variants: 2 }],
      density: 0.01,
      spacing: 6,
      range: 120,
    },
    {
      name: 'grass',
      kind: 'foliage',
      items: [{ generator: 'shard/GrassClump', variants: 3 }],
      density: 3,
      align: 0.3,
      scale: [0.8, 1.3],
      avoid: ['boulders'],
      range: 40,
    },
  ],
}

async function scene() {
  const root = mkdtempSync(join(tmpdir(), 'shard-foliage-'))
  roots.push(root)
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    ScenePlugin,
    procgenPlugin(),
    scatterPlugin(),
  )
  await app.init()
  await assetServer(app.world)
    .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
    .scan()
  const w = app.world
  const target = new OffscreenTarget(gpu, { label: 'foliage', width: W, height: H })
  const ref = w.resource(RenderTargets).add(target, 'foliage') as AssetRef<'RenderTarget'>
  const set = w.initResource(ScatterSet.store).add(ScatterSet.deserialize(SET as never), 'set')
  const brown = w
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [0.35, 0.25, 0.18, 1], roughness: 1 }))
  w.spawn(
    [Mesh3d, { mesh: w.resource(Meshes).add(plane({ size: 1, subdivisions: 2 })) }],
    [MeshMaterial, { material: brown }],
    [ScatterSurface, { set, seed: 1 }],
    [Transform, { scale: [200, 200, 200] }],
  )
  Object.assign(w.resource(AmbientLight), { brightness: 2500 })
  w.spawn(
    [DirectionalLight, { illuminance: 30_000, shadows: true }],
    [Transform, { rotation: lookAt([-2, 8, 3], [0, 0, 0]) }],
  )
  // Eye level, looking down the field.
  const eye: [number, number, number] = [0, 1.7, 0]
  const camera = w.spawn(
    [Camera3d, { target: ref, fovY: 60 }],
    [Exposure, { ev100: 12.5 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0.4, -10]) }],
  )
  return {
    app,
    world: w,
    view: `camera:${camera}`,
    async dispose() {
      await app.dispose()
      target.destroy()
    },
  }
}

/** Grass green: green clearly above red and blue. */
const isGrass = (p: ArrayLike<number>) => p[1]! > p[0]! * 1.15 && p[1]! > p[2]! * 1.4

describe('foliage from a ScatterSet', () => {
  it('draws GPU grass on a ScatterSurface, kept off the boulders', {
    timeout: timeout(60_000),
  }, async () => {
    const s = await scene()
    if (!s.world.resource(Gpu).features.has('indirect-first-instance')) {
      await s.dispose()
      return
    }
    // Generation is async: step until the layer has chunks, then let it place and draw.
    for (let i = 0; i < 400; i++) {
      s.app.update(1 / 60)
      await new Promise((r) => setTimeout(r, 1))
      const layers = s.world.resource(FoliageLayers).layers
      if ([...layers].some((l) => l.chunkCount > 0)) break
    }
    await settle(s.app)
    const image = await renderView(s.app, s.view)
    if (shots)
      writeFileSync(join(shots, 'scatter-foliage.png'), pngBytes(image.data as Uint8Array, W, H))
    // The ground is the lower half of the view.
    let grass = 0
    for (let y = H / 2 + 4; y < H; y++)
      for (let x = 0; x < W; x++) if (isGrass(pixel(image, x, y))) grass++
    expect(grass / (W * (H / 2 - 4))).toBeGreaterThan(0.25)
    const layer = [...s.world.resource(FoliageLayers).layers][0]!
    const { drawn } = layer.visible(s.view)
    // About density × the view's area (900 m²), give or take boulders and thinning.
    expect(drawn).toBeGreaterThan(3 * 900 * 0.5)
    // No entities for foliage: only the boulders are props.
    const props = s.world.query({ with: [Prop] })
    let n = 0
    for (const t of props.tables) n += t.count
    expect(n).toBeGreaterThan(0)
    const ss = [...s.world.resource(Scatter).surfaces.values()][0]!
    expect(ss.stats[1]!.spawned).toBe(0)
    await s.dispose()
  })
})
