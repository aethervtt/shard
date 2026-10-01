import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assetServer, MissingAsset } from '@aethervtt/shard-assets'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import {
  forwardPlugin,
  Mesh3d,
  Meshes,
  OffscreenTarget,
  RenderHealth,
  renderPlugin,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import {
  findEntityByPath,
  InstancePart,
  loadScene,
  ScenePlugin,
  whenSceneReady,
} from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import './index'

// A model whose artifact arrives truncated (0061): its instance shows the missing box, marked, and
// the renderer reports it; once the bytes are whole again, `retry` brings the model back.

const fixtures = resolve(import.meta.dirname, '../fixtures/khronos')

let gpu: GpuContext
let root: string
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  root = mkdtempSync(join(tmpdir(), 'shard-gltf-missing-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  cpSync(join(fixtures, 'Box/glTF-Binary/Box.glb'), join(root, 'assets/Box.glb'))
})
afterAll(() => {
  gpu.destroy()
  rmSync(root, { recursive: true, force: true })
})

describe('a truncated model (0061)', () => {
  it(
    'spawns the missing box, carries MissingAsset, degrades RenderHealth, and recovers after retry',
    async () => {
      const target = new OffscreenTarget(gpu, { label: 'missing', width: 16, height: 16 })
      const app = new App().addPlugin(
        TransformPlugin,
        renderPlugin({ gpu, target }),
        forwardPlugin({ msaa: 1 }),
        ScenePlugin,
      )
      await app.init()
      const world = app.world
      const assets = assetServer(world).configure({
        platform: createNodePlatform({ root, logTo: () => {} }),
      })
      const report = await assets.scan()
      expect(report.failed).toEqual([])
      // The scene artifact comes back cut short, as a failed download would.
      const artifact = join(
        root,
        '.shard/cache',
        assets.info('assets/Box.glb#Scene').artifact!.json!,
      )
      mkdirSync(dirname(artifact), { recursive: true })
      const whole = readFileSync(artifact)
      writeFileSync(artifact, whole.subarray(0, whole.length >> 1))

      loadScene(world, {
        version: 1,
        entities: [
          {
            name: 'model',
            components: {
              'core/Transform': {},
              'scene/SceneInstance': { scene: { path: 'assets/Box.glb#Scene' } },
            },
          },
          {
            name: 'camera',
            components: { 'render/Camera3d': {}, 'core/Transform': { translation: [0, 0, 4] } },
          },
        ],
      })
      await whenSceneReady(world, 'main')
      await settle(app)
      const model = findEntityByPath(world, 'model')!
      expect(assets.state('assets/Box.glb#Scene')).toBe('failed')
      expect(world.get(model, MissingAsset).ref).toBe('assets/Box.glb#Scene')
      const parts = () =>
        world
          .query({ with: [InstancePart] })
          .tables.flatMap((t) => [...t.entities.subarray(0, t.count)])
          .filter((e) => world.get(e, InstancePart).instance === model)
      // The fallback: one generated child, the missing box.
      expect(parts()).toHaveLength(1)
      expect(world.resource(Meshes).get(world.get(parts()[0]!, Mesh3d).mesh)?.missing).toBe(true)
      expect(world.resource(RenderHealth).state).toBe('degraded')

      writeFileSync(artifact, whole)
      await assets.retry('assets/Box.glb#Scene')
      await whenSceneReady(world, 'main')
      await settle(app)
      expect(assets.state('assets/Box.glb#Scene')).toBe('loaded')
      expect(world.has(model, MissingAsset)).toBe(false)
      expect(parts().length).toBeGreaterThan(0)
      expect(
        parts().some((e) => world.resource(Meshes).get(world.tryGet(e, Mesh3d)?.mesh)?.missing),
      ).toBe(false)
      expect(world.resource(RenderHealth).state).toBe('ok')
      await app.dispose()
    },
    timeout(60_000),
  )
})
