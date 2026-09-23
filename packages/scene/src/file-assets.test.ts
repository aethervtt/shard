import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@shard/assets'
import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { createNodePlatform } from '@shard/platform-node'
import {
  captureView,
  forwardPlugin,
  Materials,
  OffscreenTarget,
  renderPlugin,
  Shaders,
} from '@shard/render'
import { App } from '@shard/runtime'
import { TransformPlugin } from '@shard/transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SceneFile } from './format'
import { loadScene, saveScene, unloadScene, validateScene, whenSceneReady } from './scene'

const here = dirname(fileURLToPath(import.meta.url))

const scene: SceneFile = {
  version: 1,
  resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 1000 } },
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight' },
        'core/Transform': { rotationEuler: [-50, 30, 0] },
      },
    },
    {
      name: 'hull',
      components: {
        'core/Transform': { rotationEuler: [0, 35, 0] },
        'render/Mesh3d': { mesh: { path: 'procedural:box?x=2&y=1.2&z=2' } },
        'render/MeshMaterial': { material: { path: 'materials/hull.material.json' } },
      },
    },
    {
      name: 'camera',
      components: {
        'render/Camera3d': { fovY: 50 },
        'core/Transform': { translation: [0, 1.5, 5], rotationEuler: [-15, 0, 0] },
      },
    },
  ],
}

let root: string
let gpu: GpuContext

function writeMaterial(value: object) {
  const file = join(root, 'materials/hull.material.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

async function start() {
  const target = new OffscreenTarget(gpu, { label: 'file-assets', width: 64, height: 64 })
  const app = new App().addPlugin(TransformPlugin, renderPlugin({ gpu, target }), forwardPlugin())
  await app.init()
  const assets = assetServer(app.world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  await assets.scan()
  return { app, assets }
}

async function frames(app: App, n: number) {
  for (let i = 0; i < n; i++) {
    app.update(1 / 60)
    await app.world.resource(Shaders).whenIdle()
    await gpu.pipelines.whenIdle()
  }
}

async function capture(app: App, camera: number) {
  const shot = captureView(app.world, `camera:${camera}`)
  app.update(1 / 60)
  return (await shot).data
}

/** Mean red and blue over the image. */
function redBlue(data: Uint8Array): [number, number] {
  let r = 0
  let b = 0
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]!
    b += data[i + 2]!
  }
  return [r / (data.length / 4), b / (data.length / 4)]
}

beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

describe('file assets in scenes', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shard-scene-assets-'))
    writeMaterial({ baseColor: '#c0392b', roughness: 0.4 })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('a scene referencing a material file loads, renders as authored, and saves the path back', async () => {
    const { app } = await start()
    const { entities } = loadScene(app.world, scene, { id: 'main' })
    await whenSceneReady(app.world, 'main')
    await frames(app, 30)
    const image = await capture(app, entities.get('camera')!)

    const golden = join(here, '__golden__', 'material-file-scene.rgba')
    if (!existsSync(golden)) {
      mkdirSync(dirname(golden), { recursive: true })
      writeFileSync(golden, image)
      console.warn(`Wrote new golden image: ${golden}`)
    }
    const expected = new Uint8Array(readFileSync(golden))
    let sum = 0
    for (let i = 0; i < expected.length; i++) sum += Math.abs(expected[i]! - image[i]!)
    expect(sum / expected.length).toBeLessThan(1.5)

    expect(saveScene(app.world, 'main')).toEqual(scene)
  })

  it('reports a missing asset path with a pointer', async () => {
    const { app } = await start()
    const broken = structuredClone(scene)
    broken.entities[1]!.components!['render/MeshMaterial'] = {
      material: { path: 'materials/nope.material.json' },
    }
    const errors = validateScene(app.world, broken, { id: 'x' })
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ['schema/asset-not-found', '/entities/1/components/render~1MeshMaterial/material'],
    ])
  })

  it('hot reloads a changed material within two frames, keeping its guid', async () => {
    const { app, assets } = await start()
    const { entities } = loadScene(app.world, scene, { id: 'main' })
    await whenSceneReady(app.world, 'main')
    await frames(app, 30)
    const camera = entities.get('camera')!
    const [r0, b0] = redBlue(await capture(app, camera))
    const guid = assets.resolve('materials/hull.material.json')!.guid

    const scanned = new Promise<void>((resolve) => {
      void assets
        .watch({ debounceMs: 20, onScan: (r) => r.imported.length > 0 && resolve() })
        .then((stop) => scanned.finally(stop))
    })
    await new Promise((r) => setTimeout(r, 20))
    writeMaterial({ baseColor: '#2e86de', roughness: 0.4 })
    await scanned
    await frames(app, 2)
    const [r1, b1] = redBlue(await capture(app, camera))
    expect(assets.resolve('materials/hull.material.json')!.guid).toBe(guid)
    expect(r1).toBeLessThan(r0 - 5)
    expect(b1).toBeGreaterThan(b0 + 5)

    // A broken edit keeps the last good material.
    writeMaterial({ baseColor: 'not a color' })
    const report = await assets.scan()
    expect(report.failed[0]?.error.code).toBe('assets/import-failed')
    const mat = app.world.resource(Materials).get(assets.resolve('materials/hull.material.json')!)
    expect(mat).toBeDefined()
    writeMaterial({ baseColor: '#2e86de', roughness: 0.4 })
    await assets.scan()
  })

  it('unloading a scene unloads the assets only it referenced', async () => {
    const { app, assets } = await start()
    loadScene(app.world, scene, { id: 'main' })
    await whenSceneReady(app.world, 'main')
    expect(assets.state('materials/hull.material.json')).toBe('loaded')
    assets.pin('materials/hull.material.json', 'test')
    unloadScene(app.world, 'main')
    expect(assets.state('materials/hull.material.json')).toBe('loaded') // pinned
    assets.unpin('test')
    assets.collect()
    expect(assets.state('materials/hull.material.json')).toBe('unloaded')
  })
})
