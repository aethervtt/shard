import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { App, DevMode, LogResource } from '@aethervtt/shard-runtime'
import { Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight } from './lights'
import { captureView, describeRender, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { pixel, pngBytes, settle } from './testing'
import { Tonemapping } from './view'

// Format twins on the baseline tier (0064): one format per texture, from its import usage. A slot
// that reads it in the other color space gets a twin; when the bytes were released after upload,
// the twin reloads the artifact, and until then the slot shows its loading fallback (or, with
// deferUntilReady, the draw waits), never the texture in the wrong color space.

let compat: GpuContext
const roots: string[] = []
beforeAll(async () => {
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(() => {
  compat.destroy()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A 4×4 swatch of one color, as PNG bytes. */
function swatch(rgb: [number, number, number]): Uint8Array {
  const data = new Uint8Array(16 * 4)
  for (let i = 0; i < 16; i++) data.set([...rgb, 255], i * 4)
  return pngBytes(data, 4, 4)
}

/**
 * The same bytes twice: `mask.png` imports as `data` (linear) and `swatch.png` as `color` (sRGB),
 * by their names. Quads left to right: untextured, the swatch, the mask as a data map (uploading
 * it, then releasing its bytes), and one more slot for the test's material.
 */
async function scene() {
  const root = mkdtempSync(join(tmpdir(), 'shard-twins-'))
  roots.push(root)
  mkdirSync(join(root, 'assets'))
  const bytes = swatch([200, 60, 230])
  writeFileSync(join(root, 'assets/mask.png'), bytes)
  writeFileSync(join(root, 'assets/swatch.png'), bytes)
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu: compat, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  world.resource(DevMode).enabled = true
  const server = assetServer(world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  await server.scan()
  await server.load('assets/mask.png')
  await server.load('assets/swatch.png')
  const mask = server.resolve('assets/mask.png')!
  const swatchRef = server.resolve('assets/swatch.png')!
  world.resource(AmbientLight).brightness = 1000
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const quad = meshes.add(plane({ size: 1.8 }))
  const at = (x: number, material: MaterialAsset) =>
    world.spawn(
      [Mesh3d, { mesh: quad }],
      [MeshMaterial, { material: materials.add(material) }],
      [Transform, { translation: [x, 0, 0] }],
    )
  const flat = { roughness: 1, metallic: 0 }
  at(-3, new MaterialAsset(flat))
  at(-1, new MaterialAsset({ ...flat, baseColorTexture: { texture: swatchRef } }))
  at(1, new MaterialAsset({ ...flat, metallicRoughnessTexture: { texture: mask } }))
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(compat, { label: 'twins', width: 128, height: 32 }), 'twins')
  const cam = world.spawn(
    [
      Camera3d,
      {
        target: target as never,
        projection: 'orthographic',
        orthoHeight: 2,
        clearColor: [0, 0, 0, 1],
      },
    ],
    [Exposure, { ev100: 10 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: [0, 5, 0], rotation: lookAt([0, 5, 0], [0, 0, 0], [0, 0, -1]) }],
  )
  await settle(app)
  const texture = world.resource(Textures).get(mask)!
  // The data map uploaded and then released its bytes, as imported textures do.
  expect(texture.levels).toBeUndefined()
  const shoot = async () => {
    const shot = captureView(world, `camera:${cam}`)
    app.update(1 / 60)
    const image = await shot
    // The middle of each quad: untextured, swatch, data map, the test's.
    return [16, 48, 80, 112].map((x) => pixel(image, x, 16).slice(0, 3))
  }
  const twins = () =>
    (
      describeRender(world) as unknown as {
        twins: {
          pending: { texture: string; kind: string; waitedMs: number }[]
          recent: { texture: string; kind: string; waitedMs: number }[]
        }
      }
    ).twins
  return {
    app,
    world,
    mask,
    texture: () => world.resource(Textures).get(mask)!,
    at,
    flat,
    shoot,
    twins,
  }
}

async function untilReady(s: Awaited<ReturnType<typeof scene>>) {
  for (let i = 0; i < 400 && s.twins().pending.length > 0; i++) {
    s.app.update(1 / 60)
    await new Promise((r) => setTimeout(r, 5))
  }
  await settle(s.app)
}

const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 2)

describe('format twins on the baseline tier (0064)', () => {
  it("shows a data texture's loading fallback in a color slot until its twin reloads, then renders it right", {
    timeout: 60_000,
  }, async () => {
    const s = await scene()
    s.at(3, new MaterialAsset({ ...s.flat, baseColorTexture: { texture: s.mask } }))
    const [white, swatch, , waiting] = await s.shoot()
    // Material preparation asked for the twin; the bytes are gone, so the artifact reloads.
    expect(s.twins().pending).toEqual([
      { texture: s.mask.guid, kind: 'srgb/2d', waitedMs: expect.any(Number) },
    ])
    expect(close(waiting!, white!)).toBe(true) // the loading fallback, not the mask read linear
    expect(close(swatch!, white!)).toBe(false)
    await untilReady(s)
    const [, swatchAfter, , twinned] = await s.shoot()
    expect(close(twinned!, swatchAfter!)).toBe(true)
    const recent = s.twins().recent.find((w) => w.texture === s.mask.guid)!
    expect(recent.kind).toBe('srgb/2d')
    expect(recent.waitedMs).toBeGreaterThan(0)
    // The reloaded bytes went again once the twin was made from them.
    expect(s.texture().levels).toBeUndefined()
    const logged = s.world
      .resource(LogResource)
      .errors()
      .filter((e) => e.code === 'render/texture-color-space-mismatch')
    expect(logged).toHaveLength(1)
    expect(logged[0]!.path).toBe(s.mask.guid)
    expect(compat.errors).toEqual([])
    await s.app.dispose()
  })

  it('skips the draws of a deferUntilReady material until its twin is ready', {
    timeout: 60_000,
  }, async () => {
    const s = await scene()
    s.at(
      3,
      new MaterialAsset({
        ...s.flat,
        baseColorTexture: { texture: s.mask },
        deferUntilReady: true,
      }),
    )
    const [, , , waiting] = await s.shoot()
    expect(waiting).toEqual([0, 0, 0]) // not drawn: the clear color
    expect(s.twins().pending).toHaveLength(1)
    await untilReady(s)
    const [, swatch, , twinned] = await s.shoot()
    expect(close(twinned!, swatch!)).toBe(true)
    expect(s.texture().levels).toBeUndefined()
    expect(compat.errors).toEqual([])
    await s.app.dispose()
  })
})
