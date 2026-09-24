import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeGpuContext } from '@shard/gpu/node'
import { plane } from '@shard/mesh'
import {
  AmbientLight,
  Camera3d,
  DirectionalLight,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  renderPlugin,
} from '@shard/render'
import { compareGolden, renderView } from '@shard/render/testing'
import { App } from '@shard/runtime'
import { ScenePlugin } from '@shard/scene'
import { lookAt, Transform, TransformPlugin, worldPosition } from '@shard/transform'
import { expect, it } from 'vitest'
import { animationLayer } from './api'
import { AnimationPlayer } from './components'
import { animationPlugin } from './plugin'
import { Retarget } from './retarget'
import { addBipedAssets, biped, spawnBiped } from './testing'

const here = dirname(fileURLToPath(import.meta.url))

it('a walk retargeted from a tall rig to a short one with other bind orientations keeps its feet on the ground (golden image)', async () => {
  const gpu = await createNodeGpuContext()
  const target = new OffscreenTarget(gpu, { label: 'retarget', width: 160, height: 120 })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin(),
    ScenePlugin,
    animationPlugin,
  )
  try {
    await app.init()
    const w = app.world
    w.resource(AmbientLight).brightness = 1500
    w.spawn(
      [DirectionalLight, { illuminance: 30_000, shadows: true }],
      [Transform, { rotation: lookAt([0, 0, 0], [0.5, -1, -0.4]) as never }],
    )
    const ground = new MaterialAsset({
      baseColor: [0.35, 0.4, 0.45, 1],
      roughness: 0.9,
      metallic: 0,
    })
    w.spawn(
      [Mesh3d, { mesh: w.resource(Meshes).add(plane({ size: 8 }), 'ground') as never }],
      [MeshMaterial, { material: w.resource(Materials).add(ground, 'ground') as never }],
      [Transform, {}],
    )
    const tall = biped({ scale: 1.1, names: 'prefix' })
    const short = biped({ scale: 0.6, names: 'suffix', twisted: true })
    const src = addBipedAssets(w, tall)
    const tgt = addBipedAssets(w, short, [0.9, 0.55, 0.3, 1])
    // Side on, mid-stride (a quarter cycle: legs furthest apart), paused.
    const { root, joint } = spawnBiped(w, short, tgt, [0, 0, 0], 90)
    w.add(root, Retarget, { source: src.skin as never, mode: 'rotation-and-root' })
    w.add(root, AnimationPlayer, {
      layers: [animationLayer(src.walk, { time: 0.25, playing: false })],
    })
    const eye: [number, number, number] = [0, 0.55, 2.2]
    const camera = w.spawn(
      [Camera3d, { fovY: 40, clearColor: [0.05, 0.06, 0.08, 1] }],
      [Transform, { translation: eye, rotation: lookAt(eye, [0, 0.45, 0]) as never }],
    )
    const shot = await renderView(app, `camera:${camera}`)
    // The feet stand on the plane: the lower sole of each foot is at y = 0.
    let lowest = Infinity
    for (const side of ['L', 'R'] as const) {
      lowest = Math.min(lowest, worldPosition(w, joint(short.path('Foot', side)))[1]! - short.ankle)
      lowest = Math.min(lowest, worldPosition(w, joint(short.path('Toe', side)))[1]! - 0.02 * 0.6)
    }
    expect(Math.abs(lowest)).toBeLessThan(0.02)
    const result = compareGolden(here, 'retarget-walk', shot)
    if (!result.written) expect(result.mean).toBeLessThan(1)
  } finally {
    target.destroy()
    gpu.destroy()
  }
}, 60_000)
