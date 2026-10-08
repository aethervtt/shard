import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@aethervtt/shard-assets'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { createProtocolServer, decodePng, type ProtocolServer } from '@aethervtt/shard-protocol'
import { forwardPlugin, OffscreenTarget, renderPlugin } from '@aethervtt/shard-render'
import { compareGolden } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { procgenPlugin } from '../plugin'
import { ENGINE_GENERATORS } from './generators'

const here = dirname(fileURLToPath(import.meta.url))
const shots = process.env.SHARD_SHOTS
const root = mkdtempSync(join(tmpdir(), 'shard-engine-gen-'))
let gpu: GpuContext
let server: ProtocolServer

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  const target = new OffscreenTarget(gpu, { label: 'main', width: 32, height: 32 })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin(),
    ScenePlugin,
    procgenPlugin(),
  )
  await app.init()
  await assetServer(app.world)
    .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
    .scan()
  server = createProtocolServer(app)
})

afterAll(() => {
  gpu?.destroy()
  rmSync(root, { recursive: true, force: true })
})

describe('engine generator contact sheets', () => {
  it.each(ENGINE_GENERATORS.map((g) => [g.name, g] as const))(
    '%s at seeds 1-9 matches its golden',
    { timeout: timeout(60_000) },
    async (name) => {
      const r = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'procgen.preview',
        params: { generator: name, seeds: '1-9', size: 96 },
      })
      if (r!.error) throw new Error(JSON.stringify(r!.error))
      const result = r!.result as { data: string; width: number; height: number }
      const png = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
      const slug = name.replace('shard/', '').toLowerCase()
      if (shots) {
        mkdirSync(shots, { recursive: true })
        writeFileSync(join(shots, `gen-${slug}.png`), png)
      }
      const image = await decodePng(png)
      expect([image.width, image.height]).toEqual([296, 296])
      const golden = compareGolden(join(here, '..'), `engine-${slug}`, image)
      expect(golden.mean).toBeLessThan(1)
    },
  )
})
