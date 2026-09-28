import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  forwardCorePlugin,
  Gpu,
  OffscreenTarget,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import type { ShaderBake } from '@aethervtt/shard-shader'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { scene } from '../fixtures/renderer-min/scene'

// renderer-min ships its shaders baked, so the size it reports is an app that never loads WESL.
// This renders the scene headless with that bake and checks every variant came from it. After a
// shader change, `SHARD_UPDATE_BAKE=1 pnpm --filter @aethervtt/shard-bench-size test` rebakes.
const file = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/renderer-min/shaders.bake.json',
)

it('renderer-min draws with baked shaders only', async () => {
  const gpu = await createNodeGpuContext()
  // A canvas's preferred format is a non-sRGB 8-bit one, as here.
  const target = new OffscreenTarget(gpu, {
    label: 'renderer-min',
    width: 320,
    height: 180,
    format: 'bgra8unorm',
  })
  const update = Boolean(process.env.SHARD_UPDATE_BAKE) || !existsSync(file)
  // Rebaking starts from nothing: served entries would be baked again as they were.
  const bake: ShaderBake | undefined = update ? undefined : JSON.parse(readFileSync(file, 'utf8'))
  const app = new App().addPlugin(
    renderPlugin({ gpu, target, shaderBake: bake }),
    TransformPlugin,
    forwardCorePlugin(),
    scene,
  )
  await app.init()
  await settle(app)
  const shaders = app.world.resource(Shaders)
  if (update) {
    writeFileSync(file, `${JSON.stringify(shaders.bake(), null, 2)}\n`)
  } else {
    expect(shaders.linked, 'variants the bake is missing or has stale: rebake (see above)').toBe(0)
  }
  expect(app.world.resource(Gpu).errors).toEqual([])
  target.destroy()
  gpu.destroy()
})
