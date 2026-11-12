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
import { budget, timeout } from '@aethervtt/shard-core/test-env'
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
  MorphWeights,
  OffscreenTarget,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { loadScene, type SceneFile, ScenePlugin, whenSceneReady } from '@aethervtt/shard-scene'
import { decodeImage, encodeBasis, Texture, Textures } from '@aethervtt/shard-texture'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseGltf } from './document'
import './index'

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

async function start(root: string, size: number, context = gpu) {
  const target = new OffscreenTarget(context, { label: 'textured', width: size, height: size })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu: context, target }),
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

async function frames(app: App, n: number, context = gpu) {
  for (let i = 0; i < n; i++) {
    app.update(1 / 60)
    await app.world.resource(Shaders).whenIdle()
    await context.pipelines.whenIdle()
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

async function render(
  files: Record<string, string | Uint8Array>,
  scene: SceneFile,
  size = 96,
  context = gpu,
) {
  const { app, assets } = await start(project(files), size, context)
  const { entities } = loadScene(app.world, scene, { id: 'main' })
  await whenSceneReady(app.world, 'main')
  await frames(app, 10, context)
  return {
    app,
    assets,
    image: await capture(app, entities.get('camera')!),
    camera: entities.get('camera')!,
  }
}

/** Repacks a GLB with its JSON changed (e.g. attributes removed), and its binary chunk if given. */
function editGlb(
  file: string,
  edit: (json: Record<string, unknown>, bin: Uint8Array) => Uint8Array | undefined,
): Uint8Array {
  const bytes = new Uint8Array(readFileSync(join(fixtures, file)))
  const parsed = parseGltf(bytes)
  const json = parsed.json
  const bin = edit(json as unknown as Record<string, unknown>, parsed.bin!) ?? parsed.bin
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
  it('BoxTextured renders its texture (golden image), from .glb and from .gltf + .png', {
    timeout: timeout(60_000),
  }, async () => {
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
  })

  it('normal maps render with generated and with authored tangents (golden images)', {
    timeout: timeout(60_000),
  }, async () => {
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
  })

  it('generated MikkTSpace tangents match the file’s own (within 1°)', {
    timeout: timeout(60_000),
  }, async () => {
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
    const tri = authored.indices!
    // Generated per corner, then welded: the same triangles, with shared vertices again.
    const corners = generated.indices!
    expect(corners.length).toBe(tri.length)
    expect(generated.vertexCount).toBeLessThan(tri.length)
    let worst = 0
    let signs = 0
    for (let k = 0; k < tri.length; k++) {
      const v = tri[k]!
      const t = authored.tangents!.subarray(v * 4, v * 4 + 4)
      const g = generated.tangents!.subarray(corners[k]! * 4, corners[k]! * 4 + 4)
      const dot =
        (t[0]! * g[0]! + t[1]! * g[1]! + t[2]! * g[2]!) /
        (Math.hypot(t[0]!, t[1]!, t[2]!) * Math.hypot(g[0]!, g[1]!, g[2]!))
      worst = Math.max(worst, (Math.acos(Math.min(1, dot)) * 180) / Math.PI)
      if (Math.sign(t[3]!) === Math.sign(g[3]!)) signs++
    }
    expect(worst).toBeLessThan(1)
    expect(signs).toBe(tri.length)
  })

  it('texture transforms render (golden image)', { timeout: timeout(60_000) }, async () => {
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
  })
})

describe('compressed textures', () => {
  it('a UASTC texture transcodes to BC7 when the device has it and renders like the original', {
    timeout: timeout(120_000),
  }, async () => {
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
        JSON.stringify({
          metallic: 0,
          roughness: 1,
          baseColorTexture: { texture: { path: tex } },
        }),
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
  })
})

describe('compressed embedded textures', () => {
  const MIRROR = 'NormalTangentMirrorTest/glTF-Binary/NormalTangentMirrorTest.glb'
  const meta = (settings: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify({ guid: 'c'.repeat(32), importer: 'gltf', settings }))
  const diff = (a: Uint8Array, b: Uint8Array) => {
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
    return sum / a.length
  }
  type TextureInfo = {
    usage: string
    compression: string
    width: number
    sourceWidth?: number
    bytes: number
    gpuBytes: number
  }
  const textures = (assets: Awaited<ReturnType<typeof render>>['assets'], path: string) =>
    assets
      .info(path)
      .subAssets!.filter((a) => a.type === 'Texture')
      .map((a) => ({ path: a.path, ...(assets.info(a.path).info as TextureInfo) }))

  it('textureCompression "auto" picks a mode per role, textureMaxSize caps them, and they render like the RGBA8 import', {
    timeout: timeout(180_000),
  }, async () => {
    const scene = (model: string) => modelScene(`assets/${model}#Scene`, [0, 0, 3.1])
    const raw = await render({ 'assets/raw.glb': MIRROR }, scene('raw.glb'), 128)
    const files = {
      'assets/basis.glb': MIRROR,
      'assets/basis.glb.meta': meta({ textureCompression: 'auto', textureMaxSize: 256 }),
    }
    const basis = await render(files, scene('basis.glb'), 128)

    // Three 2048² PNGs: the default keeps them whole, RGBA8 with mips.
    const before = textures(raw.assets, 'assets/raw.glb')
    expect(before.map((t) => [t.usage, t.compression, t.width])).toEqual([
      ['data', 'none', 2048],
      ['normal', 'none', 2048],
      ['color', 'none', 2048],
    ])
    const after = textures(basis.assets, 'assets/basis.glb')
    expect(after.map((t) => [t.usage, t.compression, t.width, t.sourceWidth])).toEqual([
      ['data', 'uastc', 256, 2048],
      ['normal', 'uastc', 256, 2048],
      ['color', 'etc1s', 256, 2048],
    ])
    const sum = (list: TextureInfo[], key: 'bytes' | 'gpuBytes') =>
      list.reduce((n, t) => n + t[key], 0)
    expect(sum(before, 'bytes')).toBeGreaterThan(65_000_000)
    expect(sum(after, 'bytes')).toBeLessThan(200_000)
    expect(sum(after, 'gpuBytes')).toBeLessThan(300_000)

    // Transcoded for this device: BC7 for color and data, BC5 for the normal map.
    const bc = gpu.features.has('texture-compression-bc')
    const store = basis.app.world.resource(Textures)
    const formats = after.map((t) => store.get(basis.assets.resolve(t.path))!.format)
    expect(formats).toEqual(
      bc ? ['bc7-rgba-unorm', 'bc5-rg-unorm', 'bc7-rgba-unorm'] : Array(3).fill('rgba8unorm'),
    )
    expect(diff(raw.image, basis.image)).toBeLessThan(1.5)

    // No compressed formats on the device (WebGL2 without the extensions): RGBA8 transcodes.
    const plain = await createNodeGpuContext({ compressedTextures: false })
    try {
      const fallback = await render(files, scene('basis.glb'), 128, plain)
      const store = fallback.app.world.resource(Textures)
      for (const t of textures(fallback.assets, 'assets/basis.glb')) {
        expect(store.get(fallback.assets.resolve(t.path))!.format).toBe('rgba8unorm')
      }
      expect(diff(raw.image, fallback.image)).toBeLessThan(1.5)
    } finally {
      plain.destroy()
    }
  })

  it('a skinned model with generated LODs compresses its textures too', {
    timeout: timeout(120_000),
  }, async () => {
    const CESIUM = 'CesiumMan/glTF-Binary/CesiumMan.glb'
    const scene = (model: string) => modelScene(`assets/${model}#Scene`, [0, 0.75, 2.4])
    const raw = await render({ 'assets/raw.glb': CESIUM }, scene('raw.glb'), 96)
    const basis = await render(
      {
        'assets/man.glb': CESIUM,
        'assets/man.glb.meta': meta({
          lods: 'auto',
          textureCompression: 'etc1s',
          textureMaxSize: 512,
        }),
      },
      scene('man.glb'),
      96,
    )
    const info = basis.assets.info('assets/man.glb')
    expect(info.subAssets!.filter((a) => /\/LOD\d+$/.test(a.path)).length).toBeGreaterThan(0)
    expect(info.subAssets!.some((a) => a.type === 'Skin')).toBe(true)
    expect(textures(basis.assets, 'assets/man.glb').map((t) => [t.compression, t.width])).toEqual([
      ['etc1s', 512],
    ])
    expect(diff(raw.image, basis.image)).toBeLessThan(1.5)
  })

  it('KHR_texture_basisu images keep their KTX2, and the fallback image is skipped', {
    timeout: timeout(60_000),
  }, async () => {
    const BOX = 'BoxTextured/glTF-Binary/BoxTextured.glb'
    type Doc = {
      images: { bufferView: number; mimeType: string }[]
      bufferViews: { buffer: number; byteOffset?: number; byteLength: number }[]
      buffers: { byteLength: number }[]
      textures: { source: number; extensions?: Record<string, unknown> }[]
      extensionsUsed?: string[]
      extensionsRequired?: string[]
    }
    const { json, bin } = parseGltf(new Uint8Array(readFileSync(join(fixtures, BOX))))
    const view = json.bufferViews![json.images![0]!.bufferView!]!
    const png = bin!.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const image = await decodeImage(png)
    const ktx = await encodeBasis(
      image.data as Uint8Array,
      image.width,
      image.height,
      'color',
      'uastc',
      true,
    )
    // The texture reads the KTX2 through the extension; its own source stays as the PNG fallback.
    const glb = (required: boolean) =>
      editGlb(BOX, (raw, bin) => {
        const doc = raw as unknown as Doc
        const offset = Math.ceil(bin.length / 4) * 4
        const out = new Uint8Array(offset + ktx.length)
        out.set(bin)
        out.set(ktx, offset)
        doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: ktx.length })
        doc.buffers[0]!.byteLength = out.length
        doc.images.push({ bufferView: doc.bufferViews.length - 1, mimeType: 'image/ktx2' })
        doc.textures[0]!.extensions = { KHR_texture_basisu: { source: 1 } }
        doc.extensionsUsed = [...(doc.extensionsUsed ?? []), 'KHR_texture_basisu']
        if (required) doc.extensionsRequired = ['KHR_texture_basisu']
        return out
      })
    const scene = modelScene('assets/box.glb#Scene', [0.9, 0.7, 2.4])
    scene.entities.at(-1)!.components!['core/Transform'] = {
      translation: [1.3, 1.1, 2.2],
      rotationEuler: [-20, 30, 0],
    }
    for (const required of [false, true]) {
      const { image, assets } = await render(
        {
          'assets/box.glb': glb(required),
          // Settings that would re-encode an image don't touch a KTX2 source.
          'assets/box.glb.meta': meta({ textureCompression: 'etc1s' }),
        },
        scene,
      )
      expect(assets.info('assets/box.glb').warnings).toEqual([])
      const list = textures(assets, 'assets/box.glb')
      expect(list.map((t) => [t.path, t.usage, t.compression, t.bytes])).toEqual([
        ['assets/box.glb#Texture/1', 'color', 'uastc', expect.any(Number)],
      ])
      golden('box-textured.rgba', image, 96)
    }
  })
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

  it('textured draws recover after the GPU device is lost', {
    timeout: timeout(60_000),
  }, async () => {
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
  })

  it('loads and uploads a 2048² texture in under 30 ms', { timeout: timeout(60_000) }, async () => {
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
    expect(ms).toBeLessThan(budget('gltf/texture-upload'))
  })

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

describe('generated LODs of a morphed model (0103)', () => {
  const CESIUM = 'CesiumMan/glTF-Binary/CesiumMan.glb'

  /** CesiumMan with one morph target that moves every vertex 0.2 m along each axis, at `weight`. */
  const morphed = (weight: number) =>
    editGlb(CESIUM, (raw, bin) => {
      type Doc = {
        meshes: { primitives: { attributes: { POSITION: number }; targets?: unknown[] }[] }[]
        accessors: Record<string, unknown>[]
        bufferViews: { buffer: number; byteOffset?: number; byteLength: number }[]
        buffers: { byteLength: number }[]
      }
      const doc = raw as unknown as Doc
      const mesh = doc.meshes[0]! as Doc['meshes'][number] & { weights?: number[] }
      const prim = mesh.primitives[0]!
      const count = doc.accessors[prim.attributes.POSITION]!.count as number
      const delta = new Float32Array(count * 3).fill(0.2)
      const offset = Math.ceil(bin.length / 4) * 4
      const out = new Uint8Array(offset + delta.byteLength)
      out.set(bin)
      out.set(new Uint8Array(delta.buffer), offset)
      doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: delta.byteLength })
      doc.buffers[0]!.byteLength = out.length
      doc.accessors.push({
        bufferView: doc.bufferViews.length - 1,
        componentType: 5126,
        count,
        type: 'VEC3',
        min: [0.2, 0.2, 0.2],
        max: [0.2, 0.2, 0.2],
      })
      prim.targets = [{ POSITION: doc.accessors.length - 1 }]
      mesh.weights = [weight]
      return out
    })

  it("draws a morph on the lowest generated level, with the scene's Lod and MorphWeights", {
    timeout: timeout(120_000),
  }, async () => {
    const meta = new TextEncoder().encode(
      JSON.stringify({ guid: 'd'.repeat(32), importer: 'gltf', settings: { lods: 'auto' } }),
    )
    const shot = async (weight: number) => {
      const { app, assets, camera } = await render(
        { 'assets/man.glb': morphed(weight), 'assets/man.glb.meta': meta },
        modelScene('assets/man.glb#Scene', [0, 0.75, 2.4]),
        96,
      )
      const world = app.world
      const info = assets.info('assets/man.glb')
      expect(info.subAssets!.filter((a) => /\/LOD\d+$/.test(a.path)).length).toBeGreaterThan(1)
      // One entity, imported with its generated levels and the file's weight.
      const [entity] = world.query({ with: [Lod, MorphWeights] }).entities()
      expect(world.get(entity!, MorphWeights).weights).toEqual([weight])
      // Drop to the lowest level: every size but the last one's (0) is out of reach.
      world.set(entity!, Lod, { ...world.get(entity!, Lod), bias: -30 })
      await frames(app, 4)
      return capture(app, camera)
    }
    const still = await shot(0)
    const moved = await shot(1)
    let sum = 0
    for (let i = 0; i < still.length; i++) sum += Math.abs(still[i]! - moved[i]!)
    expect(sum / still.length).toBeGreaterThan(1)
  })
})
