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
  Meshes,
  OffscreenTarget,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import {
  findEntityByPath,
  loadScene,
  type SceneFile,
  ScenePlugin,
  saveScene,
  whenSceneReady,
} from '@aethervtt/shard-scene'
import { GlobalTransform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Skins } from './index'
import './index'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../fixtures/khronos')

/** A tiny glTF (embedded buffer) built in code: quads with the given materials. */
function quadsGltf(
  quads: { name: string; material: object; translation: number[]; rotation?: number[] }[],
): object {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3])
  const bin = new Uint8Array(48 + 48 + 12)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(normals.buffer), 48)
  bin.set(new Uint8Array(indices.buffer), 96)
  const b64 = Buffer.from(bin).toString('base64')
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: quads.map((_, i) => i) }],
    nodes: quads.map((q, i) => ({
      name: q.name,
      mesh: i,
      translation: q.translation,
      ...(q.rotation ? { rotation: q.rotation } : {}),
    })),
    meshes: quads.map((q, i) => ({
      name: q.name,
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: i }],
    })),
    materials: quads.map((q) => ({ name: q.name, ...q.material })),
    buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${b64}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 12 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [-1, -1, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  }
}

let gpu: GpuContext
const roots: string[] = []

beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => {
  gpu.destroy()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function project(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'shard-gltf-instance-'))
  roots.push(root)
  for (const [to, from] of Object.entries(files)) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    if (typeof from === 'string') cpSync(join(fixtures, from), join(root, to))
    else writeFileSync(join(root, to), JSON.stringify(from))
  }
  return root
}

async function start(root: string, size = 64) {
  const target = new OffscreenTarget(gpu, { label: 'gltf', width: size, height: size })
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

function compareGolden(name: string, image: Uint8Array) {
  const golden = join(here, '__golden__', name)
  if (!existsSync(golden)) {
    mkdirSync(dirname(golden), { recursive: true })
    writeFileSync(golden, image)
    console.warn(`Wrote new golden image: ${golden}`)
  }
  const expected = new Uint8Array(readFileSync(golden))
  let sum = 0
  for (let i = 0; i < expected.length; i++) sum += Math.abs(expected[i]! - image[i]!)
  expect(sum / expected.length).toBeLessThan(1.5)
}

const QUADS = quadsGltf([
  // Faces away from the camera: visible only because it's double-sided.
  {
    name: 'Back',
    material: {
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.6, 1, 1], metallicFactor: 0 },
    },
    translation: [-1.3, 0, 0],
    rotation: [0, 1, 0, 0],
  },
  // Alpha 0.3 under a 0.5 cutoff: masked away entirely.
  {
    name: 'Masked',
    material: {
      alphaMode: 'MASK',
      alphaCutoff: 0.5,
      pbrMetallicRoughness: { baseColorFactor: [1, 0.2, 0.2, 0.3], metallicFactor: 0 },
    },
    translation: [1.3, 0, 0],
  },
])

const SCENE: SceneFile = {
  version: 1,
  resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 1000 } },
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight' },
        'core/Transform': { rotationEuler: [-40, 30, 0] },
      },
    },
    {
      name: 'box',
      components: {
        'core/Transform': { translation: [0, 1.4, 0], rotationEuler: [0, 30, 0] },
        'scene/SceneInstance': { scene: { path: 'assets/Box.glb#Scene' } },
      },
    },
    {
      name: 'quads',
      components: {
        'core/Transform': { translation: [0, -0.6, 0] },
        'scene/SceneInstance': { scene: { path: 'assets/quads.gltf#Scene' } },
      },
    },
    {
      name: 'camera',
      components: {
        'render/Camera3d': { fovY: 55 },
        'core/Transform': { translation: [0, 0.5, 6] },
      },
    },
  ],
}

describe('SceneInstance', () => {
  it('renders models as authored, with double-sided and masked materials (golden image)', async () => {
    const root = project({
      'assets/Box.glb': 'Box/glTF-Binary/Box.glb',
      'assets/quads.gltf': QUADS,
    })
    const { app } = await start(root)
    const { entities } = loadScene(app.world, SCENE, { id: 'main' })
    await whenSceneReady(app.world, 'main')
    // Children are addressable by path under the instance.
    const back = findEntityByPath(app.world, 'quads/Back')
    expect(back).toBeDefined()
    expect(findEntityByPath(app.world, 'box/Node0/Node1')).toBeDefined() // unnamed nodes
    await frames(app, 20)
    compareGolden('instances.rgba', await capture(app, entities.get('camera')!))
    // Saving writes the instance entities only, not their generated children.
    expect(saveScene(app.world, 'main')).toEqual(SCENE)
  })

  it('respawns when the model file changes', async () => {
    const root = project({ 'assets/quads.gltf': QUADS })
    const { app, assets } = await start(root)
    loadScene(
      app.world,
      SCENE.entities[2] ? { version: 1, entities: [SCENE.entities[2]] } : SCENE,
      { id: 'main' },
    )
    await whenSceneReady(app.world, 'main')
    expect(findEntityByPath(app.world, 'quads/Back')).toBeDefined()
    const renamed = JSON.parse(JSON.stringify(QUADS))
    renamed.nodes[0].name = 'Front'
    writeFileSync(join(root, 'assets/quads.gltf'), JSON.stringify(renamed))
    await assets.scan()
    expect(findEntityByPath(app.world, 'quads/Back')).toBeUndefined()
    expect(findEntityByPath(app.world, 'quads/Front')).toBeDefined()
  })

  it('an external .bin edit re-imports the mesh', async () => {
    const root = project({
      'assets/box/Box.gltf': 'Box/glTF/Box.gltf',
      'assets/box/Box0.bin': 'Box/glTF/Box0.bin',
    })
    const { app, assets } = await start(root)
    await assets.load('assets/box/Box.gltf#Mesh/Mesh')
    const ref = assets.resolve('assets/box/Box.gltf#Mesh/Mesh')!
    const mesh = app.world.resource(Meshes).get(ref)!
    const before = mesh.version
    // Box0.bin holds normals then positions; scale every float by 2 (normals get renormalized-ish).
    const bin = new Float32Array(
      new Uint8Array(readFileSync(join(root, 'assets/box/Box0.bin'))).buffer.slice(0, 576),
    )
    const scaled = new Uint8Array(readFileSync(join(root, 'assets/box/Box0.bin')))
    const floats = new Float32Array(scaled.buffer, 0, 144)
    for (let i = 72; i < 144; i++) floats[i] = bin[i]! * 2
    writeFileSync(join(root, 'assets/box/Box0.bin'), scaled)
    const report = await assets.scan()
    expect(report.imported).toEqual(['assets/box/Box.gltf'])
    expect(app.world.resource(Meshes).get(ref)).toBe(mesh)
    expect(mesh.version).toBe(before + 1)
    expect(mesh.bounds[3]).toBeCloseTo(1)
  })

  it('changing scale or forward re-imports the scene only; mesh artifacts stay the same', async () => {
    const root = project({ 'assets/Box.glb': 'Box/glTF-Binary/Box.glb' })
    const { assets } = await start(root)
    await assets.whenSettled(['assets/Box.glb#Mesh/Mesh', 'assets/Box.glb#Scene'])
    const mesh = assets.info('assets/Box.glb#Mesh/Mesh').artifact
    const scene = assets.info('assets/Box.glb#Scene').artifact
    const meshVersion = assets.entry('assets/Box.glb#Mesh/Mesh')!.version
    const sceneVersion = assets.entry('assets/Box.glb#Scene')!.version
    await assets.reimport('assets/Box.glb', { settings: { scale: 0.01, forward: '-z' } })
    expect(assets.info('assets/Box.glb#Mesh/Mesh').artifact).toEqual(mesh)
    expect(assets.entry('assets/Box.glb#Mesh/Mesh')!.version).toBe(meshVersion) // not reloaded
    expect(assets.info('assets/Box.glb#Scene').artifact).not.toEqual(scene)
    expect(assets.entry('assets/Box.glb#Scene')!.version).toBe(sceneVersion + 1)
    await assets.load('assets/Box.glb#Scene')
    const info = assets.info('assets/Box.glb#Scene').info as { bounds: { max: number[] } }
    expect(info.bounds.max[0]).toBeLessThan(0.01)
  })

  it('an entity parented to a joint sits at the joint', async () => {
    const root = project({ 'assets/CesiumMan.glb': 'CesiumMan/glTF-Binary/CesiumMan.glb' })
    const { app, assets } = await start(root)
    const { entities } = loadScene(
      app.world,
      {
        version: 1,
        entities: [
          {
            name: 'man',
            components: {
              'core/Transform': { translation: [2, 0, 0] },
              'scene/SceneInstance': { scene: { path: 'assets/CesiumMan.glb#Scene' } },
            },
          },
          { name: 'hat', components: { 'core/Transform': {} } },
        ],
      },
      { id: 'main' },
    )
    await whenSceneReady(app.world, 'main')
    const skinPath = assets
      .info('assets/CesiumMan.glb')
      .subAssets!.find((a) => a.type === 'Skin')!.path
    await assets.load(skinPath)
    const skin = app.world.resource(Skins).get(assets.resolve(skinPath))!
    const jointPath = `man/${skin.joints[skin.joints.length - 1]}`
    const joint = findEntityByPath(app.world, jointPath)!
    expect(joint).toBeDefined()
    const hat = entities.get('hat')!
    app.world.add(hat, (await import('@aethervtt/shard-core')).ChildOf, { parent: joint })
    await frames(app, 1)
    const a = app.world.get(joint, GlobalTransform).matrix
    const b = app.world.get(hat, GlobalTransform).matrix
    expect(Array.from(b)).toEqual(Array.from(a))
  })
})

describe('performance', () => {
  it('imports a 1M-triangle .glb in under 2 s and loads its mesh in under 20 ms', async () => {
    // A 708x708 grid: 1,000,000+ triangles.
    const n = 708
    const verts = (n + 1) * (n + 1)
    const positions = new Float32Array(verts * 3)
    const normals = new Float32Array(verts * 3)
    for (let y = 0, i = 0; y <= n; y++) {
      for (let x = 0; x <= n; x++, i++) {
        positions[i * 3] = x / n
        positions[i * 3 + 2] = y / n
        normals[i * 3 + 1] = 1
      }
    }
    const indices = new Uint32Array(n * n * 6)
    for (let y = 0, k = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x
        indices.set([a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2], k)
        k += 6
      }
    }
    const binLength = positions.byteLength + normals.byteLength + indices.byteLength
    const json = JSON.stringify({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Grid', mesh: 0 }],
      meshes: [
        { name: 'Grid', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] },
      ],
      buffers: [{ byteLength: binLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
        { buffer: 0, byteOffset: positions.byteLength * 2, byteLength: indices.byteLength },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: verts,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 0, 1],
        },
        { bufferView: 1, componentType: 5126, count: verts, type: 'VEC3' },
        { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
      ],
    })
    const jsonBytes = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '))
    const glb = new Uint8Array(12 + 8 + jsonBytes.length + 8 + binLength)
    const view = new DataView(glb.buffer)
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, glb.length, true)
    view.setUint32(12, jsonBytes.length, true)
    view.setUint32(16, 0x4e4f534a, true)
    glb.set(jsonBytes, 20)
    const binAt = 20 + jsonBytes.length
    view.setUint32(binAt, binLength, true)
    view.setUint32(binAt + 4, 0x004e4942, true)
    glb.set(new Uint8Array(positions.buffer), binAt + 8)
    glb.set(new Uint8Array(normals.buffer), binAt + 8 + positions.byteLength)
    glb.set(new Uint8Array(indices.buffer), binAt + 8 + positions.byteLength * 2)
    const root = mkdtempSync(join(tmpdir(), 'shard-gltf-big-'))
    roots.push(root)
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets/grid.glb'), glb)
    const { assets, app } = await start(root)
    const importMs = (await assets.scan({ force: true })).ms
    expect(importMs).toBeLessThan(budget(2000))
    const start2 = performance.now()
    await assets.load('assets/grid.glb#Mesh/Grid')
    const loadMs = performance.now() - start2
    expect(
      app.world.resource(Meshes).get(assets.resolve('assets/grid.glb#Mesh/Grid'))!.drawCount / 3,
    ).toBeGreaterThan(1_000_000)
    expect(loadMs).toBeLessThan(budget(20))
  }, 60_000)
})
