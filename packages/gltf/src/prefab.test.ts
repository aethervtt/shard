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
  MeshMaterial,
  OffscreenTarget,
  renderPlugin,
  Shaders,
} from '@shard/render'
import { App } from '@shard/runtime'
import {
  currentOverrides,
  findEntityByPath,
  loadScene,
  type SceneFile,
  ScenePlugin,
  saveScene,
  stringifyScene,
  validateScene,
  whenSceneReady,
} from '@shard/scene'
import { Transform, TransformPlugin } from '@shard/transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import './index'

const here = dirname(fileURLToPath(import.meta.url))

/** Quads named A, B, C side by side, each with its own gray material. */
function quads(): object {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3])
  const bin = new Uint8Array(108)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(normals.buffer), 48)
  bin.set(new Uint8Array(indices.buffer), 96)
  const names = ['A', 'B', 'C']
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: names.map((name, i) => ({ name, mesh: 0, translation: [(i - 1) * 2.2, 0, 0] })),
    meshes: [
      {
        name: 'quad',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
      },
    ],
    materials: [
      {
        name: 'gray',
        pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.6, 1], metallicFactor: 0 },
      },
    ],
    buffers: [
      {
        byteLength: 108,
        uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`,
      },
    ],
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

const BOARD = {
  version: 1,
  root: {
    name: 'board',
    components: { 'core/Transform': {} },
    children: [
      {
        name: 'Model',
        components: { 'scene/SceneInstance': { scene: { path: 'assets/quads.gltf#Scene' } } },
      },
    ],
  },
}

const SCENE: SceneFile = {
  version: 1,
  resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 1000 } },
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight' },
        'core/Transform': { rotationEuler: [-30, 20, 0] },
      },
    },
    {
      name: 'top',
      components: {
        'core/Transform': { translation: [0, 1.2, 0] },
        'scene/PrefabInstance': {
          prefab: { path: 'prefabs/board.prefab.json' },
          overrides: {
            'Model/A': {
              'render/MeshMaterial': { material: { path: 'materials/red.material.json' } },
            },
            'Model/B': null,
            'Model/C': { 'core/Transform': { scale: [0.5, 0.5, 0.5] } },
          },
        },
      },
    },
    {
      name: 'bottom',
      components: {
        'core/Transform': { translation: [0, -1.2, 0] },
        'scene/SceneInstance': {
          scene: { path: 'assets/quads.gltf#Scene' },
          overrides: {
            C: { 'render/MeshMaterial': { material: { path: 'materials/red.material.json' } } },
            'A/render/Mesh3d': null,
          },
        },
      },
    },
    {
      name: 'camera',
      components: { 'render/Camera3d': { fovY: 60 }, 'core/Transform': { translation: [0, 0, 7] } },
    },
  ],
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

async function start() {
  const root = mkdtempSync(join(tmpdir(), 'shard-gltf-prefab-'))
  roots.push(root)
  const files: Record<string, object> = {
    'assets/quads.gltf': quads(),
    'prefabs/board.prefab.json': BOARD,
    'materials/red.material.json': { baseColor: '#d0302a', roughness: 0.6 },
  }
  for (const [path, json] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), JSON.stringify(json))
  }
  const target = new OffscreenTarget(gpu, { label: 'gltf-prefab', width: 64, height: 64 })
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
  return app
}

describe('prefabs with models inside', () => {
  it('overrides reach into a nested model: fields, removed entities, removed components (golden image)', async () => {
    const app = await start()
    const w = app.world
    const { entities } = loadScene(w, structuredClone(SCENE))
    await whenSceneReady(w, 'main')
    const red = w.get(findEntityByPath(w, 'top/Model/A')!, MeshMaterial).material?.path
    expect(red).toBe('materials/red.material.json')
    expect(findEntityByPath(w, 'top/Model/B')).toBeUndefined()
    expect([...w.get(findEntityByPath(w, 'top/Model/C')!, Transform).scale]).toEqual([
      0.5, 0.5, 0.5,
    ])
    expect(w.get(findEntityByPath(w, 'bottom/C')!, MeshMaterial).material?.path).toBe(red)
    expect(w.has(findEntityByPath(w, 'bottom/A')!, MeshMaterial)).toBe(true)
    // Overrides are validated against the model's tree too.
    const bad = structuredClone(SCENE)
    ;(bad.entities[1]!.components!['scene/PrefabInstance']!.overrides as Record<string, unknown>)[
      'Model/D'
    ] = null
    expect(validateScene(w, bad).map((e) => e.path)).toEqual([
      '/entities/1/components/scene~1PrefabInstance/overrides/Model~1D',
    ])

    for (let i = 0; i < 20; i++) {
      app.update(1 / 60)
      await w.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
    }
    const shot = captureView(w, `camera:${entities.get('camera')}`)
    app.update(1 / 60)
    const image = (await shot).data
    const golden = join(here, '__golden__', 'prefab-nested.rgba')
    if (!existsSync(golden)) {
      mkdirSync(dirname(golden), { recursive: true })
      writeFileSync(golden, image)
      console.warn(`Wrote new golden image: ${golden}`)
    }
    const expected = new Uint8Array(readFileSync(golden))
    let sum = 0
    for (let i = 0; i < expected.length; i++) sum += Math.abs(expected[i]! - image[i]!)
    expect(sum / expected.length).toBeLessThan(1.5)

    // Untouched, the scene saves as written; a change inside the model saves as an override.
    expect(stringifyScene(saveScene(w, 'main'))).toBe(stringifyScene(SCENE))
    w.set(findEntityByPath(w, 'top/Model/C')!, Transform, { translation: [2.2, 0.5, 0] })
    expect(currentOverrides(w, findEntityByPath(w, 'top')!)).toEqual({
      'Model/A': { 'render/MeshMaterial': { material: { path: 'materials/red.material.json' } } },
      'Model/B': null,
      'Model/C': { 'core/Transform': { scale: [0.5, 0.5, 0.5], translation: [2.2, 0.5, 0] } },
    })
  })
})
