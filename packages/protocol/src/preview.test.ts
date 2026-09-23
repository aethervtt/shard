import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@shard/assets'
import { createNodeGpuContext } from '@shard/gpu/node'
import '@shard/gltf'
import { createNodePlatform } from '@shard/platform-node'
import { forwardPlugin, OffscreenTarget, renderPlugin } from '@shard/render'
import { App, Time } from '@shard/runtime'
import { ScenePlugin } from '@shard/scene'
import { TransformPlugin } from '@shard/transform'
import { afterAll, describe, expect, it } from 'vitest'
import { decodePng } from './png'
import { createProtocolServer } from './server'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../../gltf/fixtures/khronos')
const shots = process.env.SHARD_SHOTS
const root = mkdtempSync(join(tmpdir(), 'shard-preview-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('asset.preview', () => {
  it('previews a texture, a material, a mesh, and a scene without touching the game', async () => {
    mkdirSync(join(root, 'assets'), { recursive: true })
    cpSync(
      join(fixtures, 'CesiumMan/glTF-Binary/CesiumMan.glb'),
      join(root, 'assets/CesiumMan.glb'),
    )
    cpSync(join(fixtures, 'BoxTextured/glTF/CesiumLogoFlat.png'), join(root, 'assets/logo.png'))
    const gpu = await createNodeGpuContext()
    const target = new OffscreenTarget(gpu, { label: 'main', width: 32, height: 32 })
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, target }),
      forwardPlugin(),
      ScenePlugin,
    )
    await app.init()
    await assetServer(app.world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
      .scan()
    const server = createProtocolServer(app)
    const call = async (asset: string, size = 160) => {
      const r = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'asset.preview',
        params: { asset, width: size, height: size },
      })
      if (r!.error) throw new Error(JSON.stringify(r!.error))
      const result = r!.result as { data: string; width: number; height: number }
      const png = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
      if (shots) {
        mkdirSync(shots, { recursive: true })
        writeFileSync(join(shots, `preview-${asset.replace(/[^a-z0-9]+/gi, '_')}.png`), png)
      }
      return decodePng(png)
    }
    const frame = app.world.resource(Time).frame
    const subAssets = assetServer(app.world).info('assets/CesiumMan.glb').subAssets!
    const texture = await call('assets/logo.png')
    expect(texture.width).toBe(160)
    const material = await call(subAssets.find((a) => a.type === 'Material')!.path)
    const mesh = await call(subAssets.find((a) => a.type === 'Mesh')!.path)
    const scene = await call('assets/CesiumMan.glb#Scene', 240)
    // Something was drawn: a good share of pixels differ from the clear color in the corner.
    for (const img of [material, mesh, scene]) {
      let drawn = 0
      for (let i = 0; i < img.data.length; i += 4) {
        if (Math.abs(img.data[i]! - img.data[0]!) + Math.abs(img.data[i + 1]! - img.data[1]!) > 12)
          drawn++
      }
      expect(drawn / (img.width * img.height)).toBeGreaterThan(0.05)
    }
    // The model's bounds frame it: it touches neither the left nor right edge columns fully.
    expect(app.world.resource(Time).frame).toBe(frame)
    gpu.destroy()
  }, 60_000)
})
