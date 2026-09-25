import { defineSystem, defineTag, quat, ShardError, Update } from '@shard/core'
import { cube, plane } from '@shard/mesh'
import { createTauriPlatform } from '@shard/platform-tauri'
import { connectToHub, createProtocolServer } from '@shard/protocol'
import {
  AmbientLight,
  Camera3d,
  captureView,
  DirectionalLight,
  forwardPlugin,
  Gpu,
  LightPresets,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  renderPlugin,
} from '@shard/render'
import { App, animationFrameRunner, definePlugin, Time } from '@shard/runtime'
import { lookAt, Transform, TransformPlugin } from '@shard/transform'
import { appDataDir, homeDir } from '@tauri-apps/api/path'

const status = document.getElementById('status') as HTMLDivElement
const canvas = document.getElementById('viewport') as HTMLCanvasElement

/** Marks entities the placeholder scene spins. */
const Spin = defineTag('studio/Spin')

/** Placeholder scene until Studio opens projects: a lit, spinning cube. */
const studioScene = definePlugin({
  name: 'studio/scene',
  dependencies: ['render/forward'],
  build(app) {
    app.addSystems(
      Update,
      defineSystem({
        name: 'studio/spin',
        setup: (world) => ({ q: world.query({ with: [Spin, Transform] }) }),
        run: ({ q }, world) => {
          const t = world.resource(Time).elapsed
          for (const table of q.tables) {
            const rotation = table.column(Transform, 'rotation')
            for (let i = 0; i < table.count; i++) {
              quat.fromEuler(rotation.subarray(i * 4, i * 4 + 4), t * 0.6, t, 0)
            }
            table.markChanged(Transform)
          }
        },
      }),
    )
  },
  ready(app) {
    const world = app.world
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    world.resource(AmbientLight).brightness = 500
    world.spawn(
      [DirectionalLight, { illuminance: LightPresets.daylight }],
      [
        Transform,
        {
          rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.6, 0) as [number, number, number, number],
        },
      ],
    )
    world.spawn(Camera3d, [
      Transform,
      { translation: [0, 2.5, 6], rotation: lookAt([0, 2.5, 6], [0, 0.5, 0]) },
    ])
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 20 })) }],
      [
        MeshMaterial,
        {
          material: materials.add(
            new MaterialAsset({ baseColor: [0.3, 0.32, 0.36, 1], roughness: 0.9 }),
          ),
        },
      ],
      [Transform, { translation: [0, -1, 0] }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(cube({ size: 1.5 })) }],
      [
        MeshMaterial,
        {
          material: materials.add(
            new MaterialAsset({ baseColor: [0.9, 0.25, 0.15, 1], roughness: 0.35 }),
          ),
        },
      ],
      [Transform, { translation: [0, 0.5, 0] }],
      Spin,
    )
  },
})

async function main() {
  // Project selection comes later; until then the platform is rooted at $HOME.
  const platform = createTauriPlatform({
    projectRoot: await homeDir(),
    dataDir: (await appDataDir()).replace(/\/+$/, ''),
  })
  const app = new App()
    .addPlugin(TransformPlugin, renderPlugin({ canvas }), forwardPlugin(), studioScene)
    .setRunner(animationFrameRunner())
  await app.init()
  const info = app.world.resource(Gpu).adapter.info
  status.textContent = `Shard Studio · WebGPU · ${info.vendor || 'unknown vendor'} · ${platform.name}`
  if (import.meta.env.VITE_SHARD_CAPTURE === '1') void selfCapture(app, platform)
  // VITE_SHARD_HUB=ws://127.0.0.1:7811 lets `shard serve` / `shard mcp --attach` drive Studio.
  const hub = import.meta.env.VITE_SHARD_HUB as string | undefined
  if (hub)
    connectToHub(hub, createProtocolServer(app, { frames: 'loop', platform }), { name: 'studio' })
  await app.run()
}

/**
 * Dev check: after a couple of seconds, capture what the camera rendered and write the raw RGBA to
 * ~/Library/Caches, so the window can be verified without screen-recording permission.
 */
async function selfCapture(app: App, platform: ReturnType<typeof createTauriPlatform>) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const camera = app.world.query({ with: [Camera3d] }).entities()[0]
  if (camera === undefined) return
  const image = await captureView(app.world, `camera:${camera}`)
  const base = 'Library/Caches/shard-studio-capture'
  await platform.fs.writeBytes(`${base}.rgba`, image.data)
  await platform.fs.writeText(
    `${base}.json`,
    JSON.stringify({ width: image.width, height: image.height }),
  )
}

main().catch((err: unknown) => {
  status.textContent =
    err instanceof ShardError ? `${err.code}: ${err.message}` : `error: ${String(err)}`
  console.error(err)
})
