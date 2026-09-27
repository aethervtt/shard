import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@aethervtt/shard-assets'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import {
  captureView,
  forwardPlugin,
  Instances,
  Lod,
  MaterialAsset,
  Materials,
  Meshes,
  OffscreenTarget,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { loadScene, type SceneFile, ScenePlugin, whenSceneReady } from '@aethervtt/shard-scene'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseGltf } from './document'
import './index'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../fixtures/khronos')
const shots = process.env.SHARD_SHOTS

let gpu: GpuContext
const roots: string[] = []
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => {
  gpu.destroy()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function project(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), 'shard-textured-'))
  roots.push(root)
  for (const [to, from] of Object.entries(files)) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    if (typeof from === 'string') cpSync(join(fixtures, from), join(root, to))
    else writeFileSync(join(root, to), from)
  }
  return root
}

async function start(root: string, size: number) {
  const target = new OffscreenTarget(gpu, { label: 'textured', width: size, height: size })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin(),
    ScenePlugin,
  )
  await app.init()
  const assets = assetServer(app.world).configure({
    platform: createNodePlatform({ root, logTo: () => {} }),
  })
  const report = await assets.scan()
  if (report.failed.length) throw new Error(JSON.stringify(report.failed))
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

function golden(name: string, image: Uint8Array, size: number) {
  const file = join(here, '__golden__', name)
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, image)
    console.warn(`Wrote new golden image: ${file}`)
  }
  if (shots) {
    mkdirSync(shots, { recursive: true })
    writeFileSync(join(shots, `${name}.${size}`), image)
  }
  const expected = new Uint8Array(readFileSync(file))
  let sum = 0
  for (let i = 0; i < expected.length; i++) sum += Math.abs(expected[i]! - image[i]!)
  expect(sum / expected.length).toBeLessThan(1.5)
}

/** A scene with one model instance, a sun, and a camera at `camera` looking down -Z. */
function modelScene(model: string, camera: number[], extra: SceneFile['entities'] = []): SceneFile {
  return {
    version: 1,
    resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 2500 } },
    entities: [
      {
        name: 'sun',
        components: {
          'render/DirectionalLight': { illuminance: 'daylight' },
          'core/Transform': { rotationEuler: [-30, 20, 0] },
        },
      },
      {
        name: 'model',
        components: { 'core/Transform': {}, 'scene/SceneInstance': { scene: { path: model } } },
      },
      ...extra,
      {
        name: 'camera',
        components: { 'render/Camera3d': { fovY: 45 }, 'core/Transform': { translation: camera } },
      },
    ],
  }
}

async function render(files: Record<string, string | Uint8Array>, scene: SceneFile, size = 96) {
  const { app, assets } = await start(project(files), size)
  const { entities } = loadScene(app.world, scene, { id: 'main' })
  await whenSceneReady(app.world, 'main')
  await frames(app, 10)
  return {
    app,
    assets,
    image: await capture(app, entities.get('camera')!),
    camera: entities.get('camera')!,
  }
}

/** Repacks a GLB with its JSON changed (e.g. attributes removed). */
function editGlb(file: string, edit: (json: Record<string, unknown>) => void): Uint8Array {
  const bytes = new Uint8Array(readFileSync(join(fixtures, file)))
  const { json, bin } = parseGltf(bytes)
  edit(json as unknown as Record<string, unknown>)
  const text = JSON.stringify(json)
  const jsonBytes = new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 4) * 4, ' '))
  const binPadded = Math.ceil(bin!.length / 4) * 4
  const out = new Uint8Array(12 + 8 + jsonBytes.length + 8 + binPadded)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  view.setUint32(20 + jsonBytes.length, binPadded, true)
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true)
  out.set(bin!, 28 + jsonBytes.length)
  return out
}

describe('textured models', () => {
  it('BoxTextured renders its texture (golden image), from .glb and from .gltf + .png', async () => {
    const scene = modelScene('assets/BoxTextured.glb#Scene', [0.9, 0.7, 2.4])
    scene.entities.at(-1)!.components!['core/Transform'] = {
      translation: [1.3, 1.1, 2.2],
      rotationEuler: [-20, 30, 0],
    }
    const { image, assets } = await render(
      { 'assets/BoxTextured.glb': 'BoxTextured/glTF-Binary/BoxTextured.glb' },
      scene,
    )
    golden('box-textured.rgba', image, 96)
    expect(assets.info('assets/BoxTextured.glb').subAssets!.some((a) => a.type === 'Texture')).toBe(
      true,
    )
    // The .gltf references an external PNG, which imports as its own asset.
    const scene2 = structuredClone(scene)
    scene2.entities[1]!.components!['scene/SceneInstance'] = {
      scene: { path: 'assets/box/BoxTextured.gltf#Scene' },
    }
    const external = await render(
      {
        'assets/box/BoxTextured.gltf': 'BoxTextured/glTF/BoxTextured.gltf',
        'assets/box/BoxTextured0.bin': 'BoxTextured/glTF/BoxTextured0.bin',
        'assets/box/CesiumLogoFlat.png': 'BoxTextured/glTF/CesiumLogoFlat.png',
      },
      scene2,
    )
    let sum = 0
    for (let i = 0; i < image.length; i++) sum += Math.abs(image[i]! - external.image[i]!)
    expect(sum / image.length).toBeLessThan(1.5)
    expect(external.assets.state('assets/box/CesiumLogoFlat.png')).toBe('loaded')
  }, 60_000)

  it('normal maps render with generated and with authored tangents (golden images)', async () => {
    const a = await render(
      { 'assets/NormalTangentTest.glb': 'NormalTangentTest/glTF-Binary/NormalTangentTest.glb' },
      modelScene('assets/NormalTangentTest.glb#Scene', [0, 0, 3.1]),
      128,
    )
    golden('normal-tangent.rgba', a.image, 128)
    const b = await render(
      {
        'assets/NormalTangentMirrorTest.glb':
          'NormalTangentMirrorTest/glTF-Binary/NormalTangentMirrorTest.glb',
      },
      modelScene('assets/NormalTangentMirrorTest.glb#Scene', [0, 0, 3.1]),
      128,
    )
    golden('normal-tangent-mirror.rgba', b.image, 128)
  }, 60_000)

  it('generated MikkTSpace tangents match the file’s own (within 1°)', async () => {
    const file = 'NormalTangentMirrorTest/glTF-Binary/NormalTangentMirrorTest.glb'
    const stripped = editGlb(file, (json) => {
      for (const mesh of json.meshes as {
        primitives: { attributes: Record<string, number> }[]
      }[]) {
        for (const p of mesh.primitives) delete p.attributes.TANGENT
      }
    })
    const { assets, app } = await start(
      project({ 'assets/authored.glb': file, 'assets/generated.glb': stripped }),
      16,
    )
    const path = assets.info('assets/authored.glb').subAssets!.find((s) => s.type === 'Mesh')!.path
    const other = path.replace('authored', 'generated')
    await assets.whenSettled([path, other])
    const authored = app.world.resource(Meshes).get(assets.resolve(path))!
    const generated = app.world.resource(Meshes).get(assets.resolve(other))!
    expect(authored.tangents).toBeDefined()
    expect(generated.indices).toBeUndefined() // unwelded by generation
    const tri = authored.indices!
    let worst = 0
    let signs = 0
    for (let k = 0; k < tri.length; k++) {
      const v = tri[k]!
      const t = authored.tangents!.subarray(v * 4, v * 4 + 4)
      const g = generated.tangents!.subarray(k * 4, k * 4 + 4)
      const dot =
        (t[0]! * g[0]! + t[1]! * g[1]! + t[2]! * g[2]!) /
        (Math.hypot(t[0]!, t[1]!, t[2]!) * Math.hypot(g[0]!, g[1]!, g[2]!))
      worst = Math.max(worst, (Math.acos(Math.min(1, dot)) * 180) / Math.PI)
      if (Math.sign(t[3]!) === Math.sign(g[3]!)) signs++
    }
    expect(worst).toBeLessThan(1)
    expect(signs).toBe(tri.length)
  }, 60_000)

  it('texture transforms render (golden image)', async () => {
    const dir = 'TextureTransformTest/glTF'
    const files: Record<string, string> = {}
    for (const f of [
      'TextureTransformTest.gltf',
      'TextureTransformTest.bin',
      'Arrow.png',
      'Correct.png',
      'Error.png',
      'NotSupported.png',
      'UV.png',
    ]) {
      files[`assets/tt/${f}`] = `${dir}/${f}`
    }
    const { image } = await render(
      files,
      modelScene('assets/tt/TextureTransformTest.gltf#Scene', [0, 0, 4.6]),
      200,
    )
    golden('texture-transform.rgba', image, 200)
  }, 60_000)
})

describe('compressed textures', () => {
  it('a UASTC texture transcodes to BC7 when the device has it and renders like the original', async () => {
    const { deflateSync, crc32 } = await import('node:zlib')
    const size = 64
    const rgba = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const check = ((x >> 3) + (y >> 3)) % 2
        rgba.set([check ? 230 : 40, 90 + y * 2, 60 + x * 2, 255], (y * size + x) * 4)
      }
    const raw = new Uint8Array((size * 4 + 1) * size)
    for (let y = 0; y < size; y++)
      raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1)
    const chunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(12 + data.length)
      const v = new DataView(out.buffer)
      v.setUint32(0, data.length)
      out.set(new TextEncoder().encode(type), 4)
      out.set(data, 8)
      v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
      return out
    }
    const ihdr = new Uint8Array(13)
    new DataView(ihdr.buffer).setUint32(0, size)
    new DataView(ihdr.buffer).setUint32(4, size)
    ihdr[8] = 8
    ihdr[9] = 6
    const png = new Uint8Array(
      Buffer.concat([
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', new Uint8Array()),
      ]),
    )
    const meta = (compression: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          guid: compression === 'none' ? 'a'.repeat(32) : 'b'.repeat(32),
          settings: { usage: 'color', compression },
        }),
      )
    const mat = (tex: string) =>
      new TextEncoder().encode(
        JSON.stringify({ metallic: 0, roughness: 1, baseColorTexture: { texture: { path: tex } } }),
      )
    const root = project({
      'assets/raw.png': png,
      'assets/raw.png.meta': meta('none'),
      'assets/basis.png': png,
      'assets/basis.png.meta': meta('uastc'),
      'materials/raw.material.json': mat('assets/raw.png'),
      'materials/basis.material.json': mat('assets/basis.png'),
    })
    const shoot = async (material: string) => {
      const { app, assets } = await start(root, 64)
      const { entities } = loadScene(
        app.world,
        {
          version: 1,
          resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 6000 } },
          entities: [
            {
              name: 'quad',
              components: {
                'core/Transform': {},
                'render/Mesh3d': { mesh: { path: 'procedural:plane?size=2' } },
                'render/MeshMaterial': { material: { path: material } },
              },
            },
            {
              name: 'camera',
              components: {
                'render/Camera3d': { fovY: 50 },
                'core/Transform': { translation: [0, 2.2, 0], rotationEuler: [-90, 0, 0] },
              },
            },
          ],
        },
        { id: 'main' },
      )
      await whenSceneReady(app.world, 'main')
      await frames(app, 4)
      const texture = app.world
        .resource(Textures)
        .get(assets.resolve(material.includes('basis') ? 'assets/basis.png' : 'assets/raw.png'))!
      return { image: await capture(app, entities.get('camera')!), format: texture.format }
    }
    const a = await shoot('materials/raw.material.json')
    const b = await shoot('materials/basis.material.json')
    expect(a.format).toBe('rgba8unorm')
    expect(b.format).toBe(
      gpu.features.has('texture-compression-bc') ? 'bc7-rgba-unorm' : 'rgba8unorm',
    )
    let sum = 0
    for (let i = 0; i < a.image.length; i++) sum += Math.abs(a.image[i]! - b.image[i]!)
    expect(sum / a.image.length).toBeLessThan(3)
  }, 120_000)
})

describe('textures at runtime', () => {
  it('a texture made in code renders, and update re-uploads it', async () => {
    const { app } = await start(project({}), 48)
    const pixels = (r: number, g: number, b: number) => {
      const out = new Uint8Array(4 * 4 * 4)
      for (let i = 0; i < 16; i++) out.set([r, g, b, 255], i * 4)
      return out
    }
    const texture = Texture.create({ width: 4, height: 4, mips: [pixels(255, 0, 0)] })
    const texRef = app.world.resource(Textures).add(texture, 'red')
    const material = new MaterialAsset({
      baseColorTexture: { texture: texRef } as never,
      metallic: 0,
      roughness: 1,
    })
    const matRef = app.world.resource(Materials).add(material)
    const { entities } = loadScene(
      app.world,
      {
        version: 1,
        resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 5000 } },
        entities: [
          {
            name: 'quad',
            components: {
              'core/Transform': {},
              'render/Mesh3d': { mesh: { path: 'procedural:plane?size=4' } },
            },
          },
          {
            name: 'camera',
            components: {
              'render/Camera3d': { fovY: 40 },
              'core/Transform': { translation: [0, 5, 0], rotationEuler: [-90, 0, 0] },
            },
          },
        ],
      },
      { id: 'main' },
    )
    app.world.add(entities.get('quad')!, (await import('@aethervtt/shard-render')).MeshMaterial, {
      material: matRef,
    })
    await frames(app, 5)
    const center = (img: Uint8Array) =>
      Array.from(img.subarray((24 * 48 + 24) * 4, (24 * 48 + 24) * 4 + 3))
    const red = center(await capture(app, entities.get('camera')!))
    expect(red[0]!).toBeGreaterThan(red[1]! + 50)
    texture.update({ mips: [pixels(0, 0, 255)] })
    await frames(app, 2)
    const blue = center(await capture(app, entities.get('camera')!))
    expect(blue[2]!).toBeGreaterThan(blue[0]! + 50)
  })

  it('textured draws recover after the GPU device is lost', async () => {
    const own = await createNodeGpuContext()
    const root = project({ 'assets/BoxTextured.glb': 'BoxTextured/glTF-Binary/BoxTextured.glb' })
    const target = new OffscreenTarget(own, { label: 'loss', width: 64, height: 64 })
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu: own, target }),
      forwardPlugin(),
      ScenePlugin,
    )
    await app.init()
    await assetServer(app.world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
      .scan()
    const scene = modelScene('assets/BoxTextured.glb#Scene', [1.3, 1.1, 2.2])
    scene.entities.at(-1)!.components!['core/Transform'] = {
      translation: [1.3, 1.1, 2.2],
      rotationEuler: [-20, 30, 0],
    }
    const { entities } = loadScene(app.world, scene, { id: 'main' })
    await whenSceneReady(app.world, 'main')
    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        app.update(1 / 60)
        await app.world.resource(Shaders).whenIdle()
        await own.pipelines.whenIdle()
        await new Promise((r) => setTimeout(r, 2))
      }
    }
    const shoot = async () => {
      const shot = captureView(app.world, `camera:${entities.get('camera')}`)
      app.update(1 / 60)
      return (await shot).data
    }
    await step(10)
    const before = await shoot()
    const generation = own.generation
    own.simulateDeviceLoss()
    for (let i = 0; i < 100 && own.generation === generation; i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(own.generation).toBe(generation + 1)
    await step(30)
    const after = await shoot()
    let sum = 0
    for (let i = 0; i < before.length; i++) sum += Math.abs(before[i]! - after[i]!)
    expect(sum / before.length).toBeLessThan(1.5)
    const errors = app.world
      .resource(LogResource)
      .errors(20)
      .filter((e) => !/device/i.test(e.message))
    expect(errors).toEqual([])
    own.destroy()
  }, 60_000)

  it('loads and uploads a 2048² texture in under 30 ms', async () => {
    const size = 2048
    const { importImageBytes } = await import('@aethervtt/shard-texture')
    const rgba = new Uint8Array(size * size * 4).map((_, i) => (i * 13) & 255)
    const { buildMips, writeKtx2, textureFromKtx2 } = await import('@aethervtt/shard-texture')
    const ktx = writeKtx2(
      buildMips(
        { width: size, height: size, kind: 'u8', data: rgba },
        { usage: 'color', mipmaps: true, maxSize: 4096, flipY: false, premultiplyAlpha: false },
      ),
      'color',
    )
    void importImageBytes
    const { app } = await start(project({}), 16)
    // Warm up the upload path once so the measurement is the steady state.
    const warm = await textureFromKtx2(ktx)
    const material = new MaterialAsset({
      baseColorTexture: { texture: app.world.resource(Textures).add(warm) } as never,
    })
    void material
    const start2 = performance.now()
    const texture = await textureFromKtx2(ktx)
    const device = gpu.device
    const handle = device.createTexture({
      size: { width: size, height: size },
      format: 'rgba8unorm',
      mipLevelCount: texture.mipCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    for (let l = 0; l < texture.mipCount; l++) {
      const w = Math.max(1, size >> l)
      device.queue.writeTexture(
        { texture: handle, mipLevel: l },
        texture.levels![l]! as Uint8Array<ArrayBuffer>,
        { bytesPerRow: w * 4, rowsPerImage: w },
        { width: w, height: w },
      )
    }
    const ms = performance.now() - start2
    handle.destroy()
    expect(ms).toBeLessThan(budget(30))
  }, 60_000)

  it('an imported _LOD chain loads as a Lod entity and draws through a LOD set', async () => {
    // A quad facing +Z, used for every level.
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0])
    const uri = `data:application/octet-stream;base64,${Buffer.from(quad.buffer).toString('base64')}`
    const prim = { attributes: { POSITION: 0 } }
    const gltf = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: quad.byteLength, uri }],
      bufferViews: [{ buffer: 0, byteLength: quad.byteLength }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 6,
          type: 'VEC3',
          min: [-1, -1, 0],
          max: [1, 1, 0],
        },
      ],
      meshes: [
        { name: 'a', primitives: [prim] },
        { name: 'b', primitives: [prim] },
      ],
      scenes: [{ nodes: [0, 1] }],
      nodes: [
        { name: 'Sign_LOD0', mesh: 0 },
        { name: 'Sign_LOD1', mesh: 1 },
      ],
    }
    const { app, image } = await render(
      { 'assets/sign.gltf': new TextEncoder().encode(JSON.stringify(gltf)) },
      modelScene('assets/sign.gltf#Scene', [0, 0, 4]),
    )
    const world = app.world
    const lods = world.query({ with: [Lod] }).entities()
    expect(lods.length).toBe(1)
    const levels = world.get(lods[0]!, Lod)!.levels
    const meshes = world.resource(Meshes)
    expect(levels.map((l) => meshes.get(l.mesh) !== undefined)).toEqual([true, true])
    expect(world.resource(Instances).lodSets.length).toBe(1)
    // The quad covers the middle of the view.
    const o = (48 * 96 + 48) * 4
    expect(image[o]! + image[o + 1]! + image[o + 2]!).toBeGreaterThan(
      image[0]! + image[1]! + image[2]! + 30,
    )
    expect(world.resource(LogResource).errors()).toEqual([])
  })
})
