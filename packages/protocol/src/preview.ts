import { AssetServerResource, assetServer, findAssetPreview } from '@shard/assets'
import {
  Children,
  type Entity,
  findResource,
  quat,
  ShardError,
  vec3,
  type World,
} from '@shard/core'
import {
  captureView,
  forwardPlugin,
  Gpu,
  Materials,
  Mesh3d,
  Meshes,
  OffscreenTarget,
  RenderStats,
  renderPlugin,
  Shaders,
} from '@shard/render'
import { App } from '@shard/runtime'
import {
  loadScene,
  PrefabAssets,
  releaseSceneHooks,
  SceneAssets,
  type SceneFile,
  ScenePlugin,
  unloadScene,
  whenSceneReady,
} from '@shard/scene'
import { readKtx2, Textures, transcodeBasis } from '@shard/texture'
import { GlobalTransform, TransformPlugin } from '@shard/transform'

export interface PreviewImage {
  width: number
  height: number
  data: Uint8Array
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

/** Nearest-neighbour fit of RGBA8 pixels into width x height, keeping the aspect ratio (letterboxed). */
function fit(src: Uint8Array, sw: number, sh: number, width: number, height: number): PreviewImage {
  const scale = Math.min(width / sw, height / sh)
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(y / scale))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor(x / scale))
      out.set(src.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * w + x) * 4)
    }
  }
  return { width: w, height: h, data: out }
}

/** A texture's top mip as RGBA8, on the CPU (HDR tonemapped, normal maps shown as color). */
async function texturePreview(world: World, path: string, width: number, height: number) {
  const artifact = await assetServer(world).artifact(path)
  return previewKtx2(artifact.bytes!, width, height)
}

/** The top mip of a KTX2 texture as RGBA8, fit into width × height (HDR tonemapped). */
export async function previewKtx2(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<PreviewImage> {
  const ktx = readKtx2(bytes)
  let rgba: Uint8Array
  if (ktx.basis) {
    rgba = (await transcodeBasis(ktx.bytes, 'rgba8')).levels[0]!
  } else if (ktx.usage === 'hdr') {
    const half = new Uint16Array(ktx.levels[0]!.slice().buffer)
    rgba = new Uint8Array(ktx.width * ktx.height * 4)
    for (let i = 0; i < half.length; i++) {
      const v = halfToFloat(half[i]!)
      // Reinhard, then sRGB-ish gamma: enough to see an environment map.
      const mapped = i % 4 === 3 ? 1 : (v / (1 + v)) ** (1 / 2.2)
      rgba[i] = Math.round(Math.min(1, Math.max(0, mapped)) * 255)
    }
  } else {
    rgba = ktx.levels[0]!
  }
  return fit(rgba, ktx.width, ktx.height, width, height)
}

/**
 * Renders an asset (Material on a sphere, Mesh, or Scene) in a private world that shares the main
 * world's GPU and asset stores. The main world's entities, time, and frame count are untouched.
 */
async function renderPreview(
  world: World,
  path: string,
  type: string,
  width: number,
  height: number,
) {
  const gpu = world.resource(Gpu)
  const server = assetServer(world)
  const target = new OffscreenTarget(gpu, { label: 'preview', width, height })
  const app = new App()
  // Share what's already loaded: the preview loads through the main server into the main stores.
  app.world.insertResource(AssetServerResource, server)
  for (const def of [Meshes, Materials, Textures, SceneAssets, PrefabAssets] as const) {
    app.world.insertResource(def as never, world.initResource(def as never))
  }
  // Stores and runtimes of other packages (generator outputs), by name so this one needn't import them.
  for (const name of ['procgen/Runtime', 'procgen/Generators', 'procgen/Data']) {
    const def = findResource(name)
    if (def && world.hasResource(def)) app.world.insertResource(def, world.resource(def))
  }
  app.addPlugin(
    TransformPlugin,
    // The game's shader library, so materials with project shaders preview with them.
    renderPlugin({ gpu, target, shaders: world.resource(Shaders) }),
    forwardPlugin(),
    ScenePlugin,
  )
  try {
    await app.init()
    await server.load(path)
    // Frame the subject from its bounds: a three-quarter view from above and in front.
    let min = [-1, -1, -1]
    let max = [1, 1, 1]
    const subject: Record<string, unknown> = { 'core/Transform': {} }
    if (type === 'Material') {
      subject['render/Mesh3d'] = { mesh: { path: 'procedural:sphere?radius=1&segments=48' } }
      subject['render/MeshMaterial'] = { material: { path } }
    } else if (type === 'Prefab') {
      subject['scene/PrefabInstance'] = { prefab: { path } }
    } else if (type === 'Mesh') {
      subject['render/Mesh3d'] = { mesh: { path } }
      const b = world.resource(Meshes).get(server.resolve(path))!.bounds
      min = [b[0]!, b[1]!, b[2]!]
      max = [b[3]!, b[4]!, b[5]!]
    } else {
      subject['scene/SceneInstance'] = { scene: { path } }
      const bounds = (
        server.info(path).info as { bounds?: { min: number[]; max: number[] } } | undefined
      )?.bounds
      if (bounds) {
        min = bounds.min
        max = bounds.max
      }
    }
    if (type === 'Prefab') {
      // A prefab's extent is only known once it's spawned: place it alone first and measure.
      const probe = loadScene(
        app.world,
        { version: 1, entities: [{ name: 'subject', components: subject as never }] },
        { id: 'preview-bounds' },
      )
      await whenSceneReady(app.world, 'preview-bounds')
      app.update(1 / 60)
      const box = worldBounds(app.world, probe.entities.get('subject')!)
      if (box) {
        min = box.min
        max = box.max
      }
      unloadScene(app.world, 'preview-bounds', { collect: false })
    }
    const center = [0, 1, 2].map((i) => (min[i]! + max[i]!) / 2)
    const radius = Math.max(
      1e-3,
      Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2,
    )
    const fov = 40
    const distance = (radius / Math.sin(((fov / 2) * Math.PI) / 180)) * 1.05
    const dir = vec3.normalize(vec3.create(), vec3.create(1, 0.7, 1.2))
    const eye = [0, 1, 2].map((i) => center[i]! + dir[i]! * distance)
    const rotation = quat.lookRotation(
      quat.create(),
      vec3.create(-dir[0]!, -dir[1]!, -dir[2]!),
      vec3.create(0, 1, 0),
    )
    const scene: SceneFile = {
      version: 1,
      resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 3000 } },
      entities: [
        {
          name: 'key',
          components: {
            'render/DirectionalLight': { illuminance: 'daylight' },
            'core/Transform': { rotationEuler: [-45, 35, 0] },
          },
        },
        { name: 'subject', components: subject as never },
        {
          name: 'camera',
          components: {
            'render/Camera3d': {
              fovY: fov,
              near: Math.max(1e-4, distance - radius * 2) / 10,
              clearColor: [0.05, 0.055, 0.07, 1],
            },
            'core/Transform': { translation: eye, rotation: [...rotation] },
          },
        },
      ],
    }
    const { entities } = loadScene(app.world, scene, { id: 'preview' })
    await whenSceneReady(app.world, 'preview')
    // Render until nothing is waiting: shaders compiled and no draw skipped for a missing asset
    // (a texture another world uploaded may be reloading, since uploads drop CPU pixels).
    for (let i = 0; i < 200; i++) {
      app.update(1 / 60)
      await app.world.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
      const stats = [...(app.world.tryResource(RenderStats)?.values() ?? [])]
      const pending = stats.reduce((n, v) => n + v.pending, 0)
      if (i >= 3 && pending === 0 && gpu.pipelines.pending === 0 && gpu.pipelines.skipped === 0) {
        break
      }
      await new Promise((r) => setTimeout(r, 2))
    }
    const shot = captureView(app.world, `camera:${entities.get('camera')}`)
    app.update(1 / 60)
    const image = await shot
    return { width: image.width, height: image.height, data: image.data }
  } finally {
    releaseSceneHooks(app.world)
    target.destroy()
  }
}

/** World bounds of an entity's meshes and those of its descendants (after transform propagation). */
function worldBounds(world: World, root: Entity): { min: number[]; max: number[] } | undefined {
  const meshes = world.resource(Meshes)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const visit = (e: Entity) => {
    const m = world.tryGet(e, Mesh3d)
    const g = world.tryGet(e, GlobalTransform)?.matrix
    const mesh = m && meshes.get(m.mesh)
    if (mesh && g) {
      const b = mesh.bounds
      for (let c = 0; c < 8; c++) {
        const x = c & 1 ? b[3]! : b[0]!
        const y = c & 2 ? b[4]! : b[1]!
        const z = c & 4 ? b[5]! : b[2]!
        for (let r = 0; r < 3; r++) {
          const v = g[r * 4]! * x + g[r * 4 + 1]! * y + g[r * 4 + 2]! * z + g[r * 4 + 3]!
          if (v < min[r]!) min[r] = v
          if (v > max[r]!) max[r] = v
        }
      }
    }
    for (const child of world.tryGet(e, Children)?.entities ?? []) if (child !== null) visit(child)
  }
  visit(root)
  return min[0]! <= max[0]! ? { min, max } : undefined
}

/** A preview image of any asset: textures on the CPU, everything else rendered. */
export async function previewAsset(
  world: World,
  path: string,
  width: number,
  height: number,
  options?: Readonly<Record<string, unknown>>,
): Promise<PreviewImage> {
  const entry = assetServer(world).entry(path)
  if (!entry) {
    throw new ShardError('assets/not-found', `No asset "${path}" in the catalog`, {
      hint: 'asset.list shows every asset.',
    })
  }
  if (entry.type === 'Texture') return texturePreview(world, entry.path, width, height)
  if (
    entry.type === 'Material' ||
    entry.type === 'Mesh' ||
    entry.type === 'Scene' ||
    entry.type === 'Prefab'
  ) {
    if (!world.tryResource(Gpu)) {
      throw new ShardError(
        'protocol/no-renderer',
        'Previews of meshes, materials, and scenes need the renderer',
      )
    }
    return renderPreview(world, entry.path, entry.type, width, height)
  }
  // Asset types from other packages (atlases, sprite clips, …) register their own.
  const custom = findAssetPreview(entry.type)
  if (custom) return custom(world, entry.path, width, height, options)
  throw new ShardError('protocol/no-preview', `${entry.type} assets have no preview`, {
    hint: 'Previews exist for textures, materials, meshes, scenes, and types that register one.',
  })
}
