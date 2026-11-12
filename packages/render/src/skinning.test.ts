import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  generateLods,
  loadMeshSimplifier,
  Mesh,
  type MeshData,
  plane,
  simplifyMesh,
} from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { Lod, Mesh3d, MeshMaterial, MorphWeights, SkinnedMesh } from './instances'
import { DirectionalLight } from './lights'
import { renderPlugin } from './plugin'
import { Skins } from './skin-asset'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { meanDifference, renderView } from './testing'
import { RenderPath } from './view'
import { Visibility } from './visibility'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadMeshSimplifier()
})
afterAll(() => gpu.destroy())

/**
 * A 2 m tube on two joints (the upper one at 1 m), with a UV seam and one morph target that
 * bulges it near the bottom.
 */
function tube(): MeshData {
  const rings = 41
  const sides = 24
  const n = rings * (sides + 1)
  const positions = new Float32Array(n * 3)
  const normals = new Float32Array(n * 3)
  const uvs = new Float32Array(n * 2)
  const joints = new Uint16Array(n * 4)
  const weights = new Float32Array(n * 4)
  const bulge = new Float32Array(n * 3)
  for (let r = 0; r < rings; r++) {
    const y = (r / (rings - 1)) * 2
    const upper = Math.min(1, Math.max(0, (y - 0.8) / 0.4))
    for (let s = 0; s <= sides; s++) {
      const v = r * (sides + 1) + s
      const a = (s / sides) * Math.PI * 2
      const x = Math.cos(a)
      const z = Math.sin(a)
      positions.set([x * 0.15, y, z * 0.15], v * 3)
      normals.set([x, 0, z], v * 3)
      uvs.set([s / sides, y / 2], v * 2)
      joints.set([0, 1, 0, 0], v * 4)
      weights.set([1 - upper, upper, 0, 0], v * 4)
      const b = 0.08 * Math.exp(-(((y - 0.5) / 0.2) ** 2))
      bulge.set([x * b, 0, z * b], v * 3)
    }
  }
  const indices: number[] = []
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * (sides + 1) + s
      const b = a + sides + 1
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return {
    positions,
    normals,
    uvs,
    joints,
    weights,
    indices: Uint32Array.from(indices),
    targets: [{ positions: bulge }],
  }
}

async function scene(deferredView = false) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  type Vec3 = [number, number, number]
  const camera = (name: string, eye: Vec3, at: Vec3) => {
    const target = new OffscreenTarget(gpu, { label: name, width: 96, height: 96 })
    const ref = world.resource(RenderTargets).add(target, name)
    return world.spawn(
      [Camera3d, { target: ref as never, fovY: 40 }],
      [Transform, { translation: eye, rotation: lookAt(eye, at) }],
    )
  }
  const materials = world.resource(Materials)
  const ground = materials.add(new MaterialAsset({ roughness: 0.9 }))
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 10 })) }],
    [MeshMaterial, { material: ground }],
    [Transform, {}],
  )
  world.spawn(
    [DirectionalLight, { illuminance: 20000, shadows: true }],
    [Transform, { rotation: lookAt([5, 3.5, 0], [0, 0, 0]) }],
  )
  // The tube and its shadow, and the shadow alone (the tube is outside this one's view).
  const both = camera('both', [0.5, 1.6, 5], [-1, 0.8, 0])
  const shadow = camera('shadow', [-2.2, 3, 0.4], [-2.2, 0, 0])
  const views = [`camera:${both}`, `camera:${shadow}`]
  if (deferredView) {
    // The tube in a deferred view: the G-buffer and the prepass that feeds it.
    const deferred = camera('deferred', [0.5, 1.6, 5], [-1, 0.8, 0])
    world.add(deferred, RenderPath, { mode: 'deferred' })
    views.push(`camera:${deferred}`)
  }
  return { app, world, views }
}

/** The tube's skin, joints (the upper one bent 60°), and a material, as both tests pose it. */
function posedTube(world: App['world']) {
  const skin = world.resource(Skins).add({
    name: 'tube',
    joints: ['j0', 'j1'],
    restPose: [
      { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    ],
    inverseBindMatrices: Float32Array.from([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0,
      1,
    ]),
  })
  const j0 = world.spawn([Transform, {}])
  const half = Math.PI / 6
  const j1 = world.spawn([
    Transform,
    { translation: [0, 1, 0], rotation: [0, 0, Math.sin(half), Math.cos(half)] },
  ])
  const material = world.resource(Materials).add(new MaterialAsset({ roughness: 0.5 }))
  return { skin, j0, j1, material }
}

describe('skinned and morphed LOD levels', () => {
  it('a Lod drawing level 1 deforms it like level 1 drawn on its own, in view and in shadow', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, views } = await scene()
    const source = tube()
    // Level 1's vertices are a reordered subset of level 0's: indexing level 0's skin data by them
    // gives the wrong joints and weights.
    const level1 = simplifyMesh(source, 0.3, { keepSeams: true }).mesh
    expect(level1.positions.length).toBeLessThan(source.positions.length)
    const meshes = world.resource(Meshes)
    const l0 = meshes.add(Mesh.create(source))
    const l1 = meshes.add(Mesh.create(level1))
    const { skin, j0, j1, material } = posedTube(world)
    const tubeAt = (mesh: typeof l0, lod: boolean) =>
      world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, {}],
        [SkinnedMesh, { skin, joints: [j0, j1] }],
        [MorphWeights, { weights: [1] }],
        [Visibility, { mode: 'hidden' }],
        ...(lod
          ? [
              [
                Lod,
                {
                  levels: [
                    { mesh: l0, screenSize: 1000 },
                    { mesh: l1, screenSize: 0 },
                  ],
                },
              ] as const,
            ]
          : []),
      )
    const viaLod = tubeAt(l0, true)
    const alone = tubeAt(l1, false)
    const shots = async (shown: number) => {
      for (const e of [viaLod, alone]) {
        world.set(e, Visibility, { mode: e === shown ? 'visible' : 'hidden' })
      }
      const out: Uint8Array[] = []
      for (const view of views) out.push((await renderView(app, view)).data)
      return out
    }
    const [lodView, lodShadow] = await shots(viaLod)
    const [aloneView, aloneShadow] = await shots(alone)
    expect(meanDifference(lodView!, aloneView!)).toBeLessThan(0.5)
    expect(meanDifference(lodShadow!, aloneShadow!)).toBeLessThan(0.5)
    // The pose shows in both views: straightened, the tube and its shadow move.
    world.set(j1, Transform, { translation: [0, 1, 0], rotation: [0, 0, 0, 1] })
    const [straightView, straightShadow] = await shots(alone)
    expect(meanDifference(straightView!, aloneView!)).toBeGreaterThan(1)
    expect(meanDifference(straightShadow!, aloneShadow!)).toBeGreaterThan(1)
  })

  it('a morph shows on every generated level, in view, in shadow, and in a deferred view', {
    timeout: timeout(120_000),
  }, async () => {
    const { app, world, views } = await scene(true)
    // 14 targets, more than the 8 applied at once; target 1 moves every vertex 0.3 m along +x.
    const source = tube()
    const n = source.positions.length / 3
    const shift = new Float32Array(n * 3)
    for (let v = 0; v < n; v++) shift[v * 3] = 0.3
    source.targets = Array.from({ length: 14 }, (_, t) => ({
      positions: t === 1 ? shift : new Float32Array(n * 3),
    }))
    // The importer's levels (lods: 'auto'), not simplifyMesh's.
    const generated = generateLods(source, [0.5, 0.2])
    expect(generated.length).toBe(2)
    const meshes = world.resource(Meshes)
    const levels = [source, ...generated.map((g) => g.mesh)].map((m) => meshes.add(Mesh.create(m)))
    const { skin, j0, j1, material } = posedTube(world)
    const weights = (w: number) => Array.from({ length: 14 }, (_, t) => (t === 1 ? w : 0))
    const tubeAt = (mesh: (typeof levels)[number], lodLevel?: number) =>
      world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, {}],
        [SkinnedMesh, { skin, joints: [j0, j1] }],
        [MorphWeights, { weights: weights(0) }],
        [Visibility, { mode: 'hidden' }],
        ...(lodLevel === undefined
          ? []
          : [
              [
                Lod,
                {
                  // Drawn at lodLevel: every earlier level needs a larger size than any view has.
                  levels: levels.map((l, k) => ({ mesh: l, screenSize: k < lodLevel ? 1000 : 0 })),
                },
              ] as const,
            ]),
      )
    const tubes = [1, 2].map((k) => ({ viaLod: tubeAt(levels[0]!, k), alone: tubeAt(levels[k]!) }))
    const all = tubes.flatMap((t) => [t.viaLod, t.alone])
    const shots = async (shown: number, w: number) => {
      for (const e of all) world.set(e, Visibility, { mode: e === shown ? 'visible' : 'hidden' })
      world.set(shown, MorphWeights, { weights: weights(w) })
      const out: Uint8Array[] = []
      for (const view of views) out.push((await renderView(app, view)).data)
      return out
    }
    for (const { viaLod, alone } of tubes) {
      const still = await shots(viaLod, 0)
      const morphed = await shots(viaLod, 1)
      const reference = await shots(alone, 1)
      for (let v = 0; v < views.length; v++) {
        expect(meanDifference(still[v]!, morphed[v]!)).toBeGreaterThan(1)
        expect(meanDifference(morphed[v]!, reference[v]!)).toBeLessThan(0.5)
      }
    }
  })
})
