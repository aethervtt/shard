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
import {
  AnimationClips,
  AnimationPlayer,
  animationLayer,
  animationPlugin,
} from '@aethervtt/shard-animation'
import { assetServer, findAssetPreview } from '@aethervtt/shard-assets'
import { ChildOf, type Entity, quat } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { Mesh } from '@aethervtt/shard-mesh'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import {
  captureView,
  DEFORM_WORDS,
  forwardPlugin,
  InstanceSlot,
  Instances,
  Mesh3d,
  Meshes,
  MeshMaterial,
  MorphWeights,
  OffscreenTarget,
  renderPlugin,
  Shaders,
  SkinnedMesh,
  Visibility,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import {
  findEntityByPath,
  loadScene,
  type SceneEntity,
  ScenePlugin,
  whenSceneReady,
} from '@aethervtt/shard-scene'
import { GlobalTransform, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Accessors } from './accessors'
import { parseGltf } from './document'
import './index'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../fixtures/khronos')
const CESIUM = 'CesiumMan/glTF-Binary/CesiumMan.glb'
const MORPH = 'AnimatedMorphCube/glTF-Binary/AnimatedMorphCube.glb'

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
  const root = mkdtempSync(join(tmpdir(), 'shard-skinning-'))
  roots.push(root)
  for (const [to, from] of Object.entries(files)) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    if (typeof from === 'string') cpSync(join(fixtures, from), join(root, to))
    else writeFileSync(join(root, to), JSON.stringify(from))
  }
  return root
}

async function start(root: string, size = 128) {
  const target = new OffscreenTarget(gpu, { label: 'skinning', width: size, height: size })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin(),
    ScenePlugin,
    animationPlugin,
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

async function capture(app: App, camera: Entity) {
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

function difference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

const AMBIENT = { 'render/AmbientLight': { color: [1, 1, 1], brightness: 1500 } }

const GROUND = {
  baseColor: [0.5, 0.52, 0.55, 1],
  roughness: 0.9,
  metallic: 0,
}

function stage(model: SceneEntity, camera: { eye: number[]; rotation: number[] }): SceneEntity[] {
  return [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight', shadows: true },
        'core/Transform': { rotationEuler: [-55, -35, 0] },
      },
    },
    {
      name: 'ground',
      components: {
        'core/Transform': {},
        'render/Mesh3d': { mesh: { path: 'procedural:plane?size=6' } },
        'render/MeshMaterial': { material: { path: 'materials/ground.material.json' } },
      },
    },
    model,
    {
      name: 'camera',
      components: {
        'render/Camera3d': { fovY: 40 },
        'core/Transform': { translation: camera.eye, rotation: camera.rotation },
      },
    },
  ]
}

const lookAt = (eye: number[], target: number[]) => {
  const d = [target[0]! - eye[0]!, target[1]! - eye[1]!, target[2]! - eye[2]!]
  return [...quat.lookRotation([0, 0, 0, 1], d, [0, 1, 0])]
}

/** glTF's own answer for a rotation channel at time t: find the keys, slerp (spec 3.11). */
function referenceRotation(times: Float32Array, values: Float32Array, t: number): number[] {
  if (t <= times[0]!) return [...values.subarray(0, 4)]
  const n = times.length
  if (t >= times[n - 1]!) return [...values.subarray((n - 1) * 4, n * 4)]
  let i = 0
  while (times[i + 1]! <= t) i++
  const u = (t - times[i]!) / (times[i + 1]! - times[i]!)
  const out = quat.slerp(
    [0, 0, 0, 1],
    [...values.subarray(i * 4, i * 4 + 4)],
    [...values.subarray(i * 4 + 4, i * 4 + 8)],
    u,
  )
  return [...out]
}

describe('skinning', () => {
  it('CesiumMan: sampled joint rotations match the glTF at 10 times', async () => {
    const root = project({ 'assets/CesiumMan.glb': CESIUM })
    const { app, assets } = await start(root, 32)
    const clipPath = assets
      .info('assets/CesiumMan.glb')
      .subAssets!.find((a) => a.type === 'AnimationClip')!.path
    await assets.load(clipPath)
    const ref = assets.resolve(clipPath)!
    const { entities } = loadScene(
      app.world,
      {
        version: 1,
        entities: [
          {
            name: 'man',
            components: {
              'core/Transform': {},
              'scene/SceneInstance': { scene: { path: 'assets/CesiumMan.glb#Scene' } },
              'animation/AnimationPlayer': {
                layers: [{ clip: { path: clipPath }, playing: false }],
              },
            },
          },
        ],
      },
      { id: 'main' },
    )
    await whenSceneReady(app.world, 'main')
    const man = entities.get('man')!
    const clip = app.world.resource(AnimationClips).get(ref)!
    // The raw file, read independently of the importer.
    const { json, bin } = parseGltf(new Uint8Array(readFileSync(join(fixtures, CESIUM))))
    const acc = new Accessors(json, [bin!])
    const anim = json.animations![0]!
    const rotations = anim.channels
      .map((ch, i) => ({ ch, i }))
      .filter(({ ch }) => ch.target.path === 'rotation')
    expect(rotations.length).toBeGreaterThan(10)
    const duration = clip.duration
    for (let k = 0; k < 10; k++) {
      const t = (duration * (k + 0.37)) / 10
      const layers = app.world.get(man, AnimationPlayer).layers
      layers[0]!.time = t
      app.world.set(man, AnimationPlayer, { layers })
      app.update(1 / 60)
      for (const { ch } of rotations) {
        const sampler = anim.samplers[ch.sampler]!
        const expected = referenceRotation(acc.floats(sampler.input), acc.floats(sampler.output), t)
        // The imported channel for this node: same target path.
        const node = json.nodes![ch.target.node!]!.name!
        const channel = clip.channels.find(
          (c) => c.field === 'rotation' && c.target.endsWith(node),
        )!
        const joint = findEntityByPath(app.world, `man/${channel.target}`)!
        const actual = app.world.get(joint, Transform).rotation
        const dot = actual.reduce((s, v, j) => s + v * expected[j]!, 0)
        expect(Math.abs(dot)).toBeGreaterThan(1 - 1e-5)
      }
    }
  })

  it('joint matrices reproduce the mesh at bind pose, and the pose sphere encloses the skinned mesh', async () => {
    const root = project({ 'assets/CesiumMan.glb': CESIUM })
    const { app, assets } = await start(root, 32)
    const clipPath = assets
      .info('assets/CesiumMan.glb')
      .subAssets!.find((a) => a.type === 'AnimationClip')!.path
    const { entities } = loadScene(
      app.world,
      {
        version: 1,
        entities: [
          {
            name: 'man',
            components: {
              'core/Transform': { translation: [3, 0, 0] },
              'scene/SceneInstance': { scene: { path: 'assets/CesiumMan.glb#Scene' } },
            },
          },
        ],
      },
      { id: 'main' },
    )
    await whenSceneReady(app.world, 'main')
    await frames(app, 2)
    const w = app.world
    const q = w.query({ with: [SkinnedMesh, InstanceSlot] })
    const table = q.tables.find((t) => t.count > 0)!
    const entity = table.entities[0]!
    const store = w.resource(Instances)
    /** The mesh skinned on the CPU from this frame's joint matrices, in world space. */
    const skinned = () => {
      const slot = w.get(entity, InstanceSlot).slot - 1
      const record = store.deform.records.subarray(slot * DEFORM_WORDS)
      const f = store.deform.recordF32.subarray(slot * DEFORM_WORDS)
      const mesh = w.resource(Meshes).get(w.get(entity, Mesh3d).mesh)!
      const poses = store.deform.poses
      const g = w.get(entity, GlobalTransform).matrix
      const out: number[][] = []
      for (let v = 0; v < mesh.vertexCount; v++) {
        const p = [0, 0, 0]
        for (let k = 0; k < 4; k++) {
          const weight = mesh.weights![v * 4 + k]!
          const m = (record[4]! + mesh.joints![v * 4 + k]! * 3) * 4
          for (let r = 0; r < 3; r++) {
            const row = poses.subarray(m + r * 4)
            p[r]! +=
              weight *
              (row[0]! * mesh.positions[v * 3]! +
                row[1]! * mesh.positions[v * 3 + 1]! +
                row[2]! * mesh.positions[v * 3 + 2]! +
                row[3]!)
          }
        }
        out.push(
          [0, 1, 2].map(
            (r) =>
              g[r * 4]! * p[0]! + g[r * 4 + 1]! * p[1]! + g[r * 4 + 2]! * p[2]! + g[r * 4 + 3]!,
          ),
        )
      }
      return { out, sphere: [...f.subarray(0, 4)], mesh }
    }
    // Bind pose: skinning is the identity.
    const bind = skinned()
    for (let v = 0; v < bind.mesh.vertexCount; v += 17) {
      const g = w.get(entity, GlobalTransform).matrix
      const x = bind.mesh.positions.subarray(v * 3)
      for (let r = 0; r < 3; r++) {
        const expected =
          g[r * 4]! * x[0]! + g[r * 4 + 1]! * x[1]! + g[r * 4 + 2]! * x[2]! + g[r * 4 + 3]!
        expect(bind.out[v]![r]).toBeCloseTo(expected, 3)
      }
    }
    // Mid-stride: every skinned vertex is inside the pose sphere.
    await assets.load(clipPath)
    w.add(entities.get('man')!, AnimationPlayer, {
      layers: [animationLayer(assets.resolve(clipPath)!, { time: 0.6, playing: false })],
    })
    await frames(app, 2)
    const posed = skinned()
    const [cx, cy, cz, radius] = posed.sphere as [number, number, number, number]
    expect(radius).toBeGreaterThan(0.3)
    let moved = 0
    for (let v = 0; v < posed.out.length; v++) {
      const p = posed.out[v]!
      expect(Math.hypot(p[0]! - cx, p[1]! - cy, p[2]! - cz)).toBeLessThanOrEqual(radius * 1.0001)
      moved = Math.max(moved, Math.hypot(...[0, 1, 2].map((r) => p[r]! - bind.out[v]![r]!)))
    }
    expect(moved).toBeGreaterThan(0.05)
  })

  it('CesiumMan renders mid-stride with its shadow (golden image)', async () => {
    const root = project({
      'assets/CesiumMan.glb': CESIUM,
      'materials/ground.material.json': GROUND,
    })
    const { app, assets } = await start(root)
    const clipPath = assets
      .info('assets/CesiumMan.glb')
      .subAssets!.find((a) => a.type === 'AnimationClip')!.path
    const eye = [2.4, 1.1, 1.6]
    const view = { eye, rotation: lookAt(eye, [0, 0.6, 0]) }
    const model: SceneEntity = {
      name: 'man',
      components: {
        'core/Transform': {},
        'scene/SceneInstance': { scene: { path: 'assets/CesiumMan.glb#Scene' } },
        'animation/AnimationPlayer': {
          layers: [{ clip: { path: clipPath }, time: 0.35, playing: false }],
        },
      },
    }
    const { entities } = loadScene(
      app.world,
      { version: 1, resources: AMBIENT, entities: stage(model, view) },
      {
        id: 'main',
      },
    )
    await whenSceneReady(app.world, 'main')
    await frames(app, 20)
    const stride = await capture(app, entities.get('camera')!)
    compareGolden('cesium-man-stride.rgba', stride)
    // Half a cycle later the other leg is forward: the mesh follows its joints.
    const man = entities.get('man')!
    const layers = app.world.get(man, AnimationPlayer).layers
    layers[0]!.time = 0.35 + clipDuration(app, assets.resolve(clipPath)!) / 2
    app.world.set(man, AnimationPlayer, { layers })
    await frames(app, 3)
    expect(difference(stride, await capture(app, entities.get('camera')!))).toBeGreaterThan(1)
  })
})

function clipDuration(app: App, ref: { guid: string | undefined }): number {
  return app.world.resource(AnimationClips).get(ref)!.duration
}

describe('previews', () => {
  it('asset.preview of a clip shows its model at 5 times, left to right', async () => {
    const root = project({ 'assets/CesiumMan.glb': CESIUM })
    const { app, assets } = await start(root, 32)
    const clipPath = assets
      .info('assets/CesiumMan.glb')
      .subAssets!.find((a) => a.type === 'AnimationClip')!.path
    const preview = findAssetPreview('AnimationClip')!
    const image = await preview(app.world, clipPath, 400, 120)
    expect([image.width, image.height]).toEqual([400, 120])
    // Each panel shows the model (not just the clear color), in a different pose.
    const panel = (f: number) => {
      const out = new Uint8Array(80 * 120 * 4)
      for (let y = 0; y < 120; y++)
        out.set(
          image.data.subarray((y * 400 + f * 80) * 4, (y * 400 + f * 80 + 80) * 4),
          y * 80 * 4,
        )
      return out
    }
    const middle = panel(2)
    let model = 0
    for (let i = 0; i < middle.length; i += 4) {
      const off =
        Math.abs(middle[i]! - middle[0]!) +
        Math.abs(middle[i + 1]! - middle[1]!) +
        Math.abs(middle[i + 2]! - middle[2]!)
      if (off > 30) model++
    }
    expect(model).toBeGreaterThan(300)
    expect(difference(panel(1), panel(3))).toBeGreaterThan(0.5)
  })
})

describe('morph targets', () => {
  it('weights animated by a glTF clip deform the mesh (AnimatedMorphCube golden image)', async () => {
    const root = project({
      'assets/Morph.glb': MORPH,
      'materials/ground.material.json': GROUND,
    })
    const { app, assets } = await start(root)
    const clipPath = assets
      .info('assets/Morph.glb')
      .subAssets!.find((a) => a.type === 'AnimationClip')!.path
    await assets.load(clipPath)
    const clip = app.world.resource(AnimationClips).get(assets.resolve(clipPath))!
    expect(clip.channels[0]).toMatchObject({ component: 'render/MorphWeights', width: 2 })
    const eye = [4, 3.6, 5.5]
    const { entities } = loadScene(
      app.world,
      {
        version: 1,
        resources: AMBIENT,
        entities: stage(
          {
            name: 'cube',
            components: {
              'core/Transform': { translation: [0, 1, 0] },
              'scene/SceneInstance': { scene: { path: 'assets/Morph.glb#Scene' } },
            },
          },
          { eye, rotation: lookAt(eye, [0, 1.3, 0]) },
        ),
      },
      { id: 'main' },
    )
    await whenSceneReady(app.world, 'main')
    await frames(app, 10)
    const before = await capture(app, entities.get('camera')!)
    const mesh = app.world.query({ with: [MorphWeights] }).tables.find((t) => t.count > 0)!
    expect(app.world.get(mesh.entities[0]!, MorphWeights).weights).toEqual([0, 0])
    app.world.add(entities.get('cube')!, AnimationPlayer, {
      layers: [
        animationLayer(assets.resolve(clipPath)!, { time: clip.duration * 0.3, playing: false }),
      ],
    })
    await frames(app, 10)
    const weights = app.world.get(mesh.entities[0]!, MorphWeights).weights
    expect(Math.max(...weights)).toBeGreaterThan(0.2)
    const after = await capture(app, entities.get('camera')!)
    compareGolden('morph-cube.rgba', after)
    expect(difference(before, after)).toBeGreaterThan(0.5)
    // The same weights applied on the CPU to a plain mesh in the same place draw the same image.
    const w = app.world
    const node = mesh.entities[0]!
    const source = w.resource(Meshes).get(w.get(node, Mesh3d).mesh)!
    const positions = Float32Array.from(source.positions)
    const normals = Float32Array.from(source.normals!)
    for (const [k, target] of source.targets!.entries()) {
      for (let i = 0; i < positions.length; i++) {
        positions[i] = positions[i]! + target.positions[i]! * weights[k]!
        normals[i] = normals[i]! + (target.normals?.[i] ?? 0) * weights[k]!
      }
    }
    const cpu = w
      .resource(Meshes)
      .add(Mesh.create({ ...source.data(), positions, normals, targets: [] }))
    const copy = w.spawn(
      [Mesh3d, { mesh: cpu }],
      [MeshMaterial, w.get(node, MeshMaterial)],
      [Transform, w.get(node, Transform)],
      [ChildOf, { parent: w.get(node, ChildOf).parent }],
    )
    w.add(node, Visibility, { mode: 'hidden' })
    await frames(app, 5)
    const reference = await capture(app, entities.get('camera')!)
    expect(difference(after, reference)).toBeLessThan(0.3)
    w.despawn(copy)
  })
})

describe('limits', () => {
  it('a skin over 256 joints fails to import with render/too-many-joints', async () => {
    const joints = 300
    const nodes = Array.from({ length: joints }, (_, i) => ({
      name: `j${i}`,
      ...(i + 1 < joints ? { children: [i + 1] } : {}),
    }))
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes,
      skins: [{ joints: nodes.map((_, i) => i) }],
    }
    const root = project({ 'assets/many.gltf': gltf })
    const target = new OffscreenTarget(gpu, { label: 'x', width: 8, height: 8 })
    const app = new App().addPlugin(TransformPlugin, renderPlugin({ gpu, target }), forwardPlugin())
    await app.init()
    const server = assetServer(app.world).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    const report = await server.scan()
    expect(report.failed[0]).toMatchObject({
      path: 'assets/many.gltf',
      error: { code: 'render/too-many-joints', path: '/skins/0/joints' },
    })
  })
})
