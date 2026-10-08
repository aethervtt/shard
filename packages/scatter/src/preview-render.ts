import { AssetServerResource, assetServer, type PreviewImage } from '@aethervtt/shard-assets'
import { type AssetRef, findResource, type World } from '@aethervtt/shard-core'
import { plane } from '@aethervtt/shard-mesh'
import { NoiseGraphs } from '@aethervtt/shard-noise'
import {
  AmbientLight,
  Camera3d,
  captureView,
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
  Shaders,
  Tonemapping,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { ScatterSurface } from './components'
import { scatterPlugin } from './plugin'
import { Scatter } from './runtime'
import { ScatterSet } from './set'

/** Side of the previewed patch (m). */
export const PREVIEW_SIZE = 64

/**
 * A ScatterSet on a flat 64 m patch, in a private world sharing the game's GPU, assets and
 * generator outputs: from above (left half) and at eye level (right half), or one of them with
 * `options.view` ('top' | 'eye').
 */
export async function renderScatterPreview(
  world: World,
  path: string,
  width: number,
  height: number,
  options: Readonly<Record<string, unknown>> = {},
): Promise<PreviewImage> {
  const gpu = world.resource(Gpu)
  const server = assetServer(world)
  await server.load(path)
  const entry = server.entry(path)!
  const view = options.view === 'top' || options.view === 'eye' ? options.view : 'both'
  const app = new App()
  app.world.insertResource(AssetServerResource, server)
  for (const def of [Meshes, Materials, Textures, NoiseGraphs, ScatterSet.store] as const)
    app.world.insertResource(def as never, world.initResource(def as never))
  // Generator outputs come from the game's procgen runtime (by name: no import of procgen here).
  for (const name of ['procgen/Runtime', 'procgen/Generators', 'procgen/Data']) {
    const def = findResource(name)
    if (def && world.hasResource(def)) app.world.insertResource(def, world.resource(def))
  }
  app.addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false, shaders: world.resource(Shaders) }),
    forwardPlugin({ msaa: 1 }),
    ScenePlugin,
    scatterPlugin(),
  )
  const views = view === 'both' ? (['top', 'eye'] as const) : ([view] as const)
  const cellW = view === 'both' ? Math.max(1, Math.floor(width / 2)) : width
  const targets: OffscreenTarget[] = []
  try {
    await app.init()
    const w = app.world
    const ground = w
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [0.36, 0.3, 0.22, 1], roughness: 1 }))
    w.spawn(
      [Mesh3d, { mesh: w.resource(Meshes).add(plane({ size: 1, subdivisions: 2 })) }],
      [MeshMaterial, { material: ground }],
      [
        ScatterSurface,
        {
          set: {
            type: 'scatter/ScatterSet',
            guid: entry.guid,
            path: entry.path,
          } as AssetRef<'scatter/ScatterSet'>,
          seed: 1,
        },
      ],
      [Transform, { scale: [PREVIEW_SIZE, PREVIEW_SIZE, PREVIEW_SIZE] }],
    )
    Object.assign(w.resource(AmbientLight), { brightness: 4000 })
    w.spawn(
      [DirectionalLight, { illuminance: 60_000, shadows: true }],
      [Transform, { rotation: lookAt([-3, 8, 4], [0, 0, 0]) }],
    )
    const cameras: string[] = []
    for (const v of views) {
      const target = new OffscreenTarget(gpu, {
        label: `scatter-preview-${v}`,
        width: cellW,
        height,
      })
      targets.push(target)
      const ref = w
        .resource(RenderTargets)
        .add(target, `scatter-preview-${v}`) as AssetRef<'RenderTarget'>
      const eye: [number, number, number] =
        v === 'top' ? [0, 40, 0.001] : [-PREVIEW_SIZE * 0.42, 1.7, PREVIEW_SIZE * 0.42]
      const at: [number, number, number] = v === 'top' ? [0, 0, 0] : [0, 0.8, 0]
      const camera = w.spawn(
        [
          Camera3d,
          v === 'top'
            ? {
                target: ref,
                projection: 'orthographic',
                orthoHeight: PREVIEW_SIZE,
                far: 200,
                clearColor: [0.5, 0.65, 0.85, 1],
              }
            : { target: ref, fovY: 55, clearColor: [0.5, 0.65, 0.85, 1] },
        ],
        [Exposure, { ev100: 13.5 }],
        [Tonemapping, { dither: false }],
        [Transform, { translation: eye, rotation: lookAt(eye, at) }],
      )
      cameras.push(`camera:${camera}`)
    }
    // Until the set's meshes are made, props placed and foliage chunks placed on the GPU.
    for (let i = 0; i < 600; i++) {
      app.update(1 / 60)
      await w.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
      await new Promise((r) => setTimeout(r, 1))
      const state = w.resource(Scatter)
      let busy = state.surfaces.size === 0
      for (const ss of state.surfaces.values()) {
        if (ss.problem) throw ss.problem
        if (!ss.ready) busy = true
        for (const c of ss.chunks.values()) if (c.job) busy = true
        for (const f of ss.foliage.values())
          for (const c of f.chunks.values()) if (c.slot < 0) busy = true
      }
      const layers = w.resource(FoliageLayers).layers
      for (const l of layers) if (l.pending.length > 0) busy = true
      if (!busy && i > 3 && gpu.pipelines.pending === 0 && gpu.pipelines.skipped === 0) break
    }
    for (let i = 0; i < 3; i++) app.update(1 / 60)
    const shots = cameras.map((c) => captureView(w, c))
    app.update(1 / 60)
    const images = await Promise.all(shots)
    if (images.length === 1) {
      const image = images[0]!
      return { width: image.width, height: image.height, data: image.data }
    }
    // Side by side.
    const out = new Uint8Array(cellW * 2 * height * 4)
    for (const [k, image] of images.entries()) {
      for (let y = 0; y < height; y++) {
        out.set(
          image.data.subarray(y * cellW * 4, (y + 1) * cellW * 4),
          (y * cellW * 2 + k * cellW) * 4,
        )
      }
    }
    return { width: cellW * 2, height, data: out }
  } finally {
    await app.dispose()
    for (const t of targets) t.destroy()
  }
}
