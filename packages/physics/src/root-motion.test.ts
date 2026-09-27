import {
  AnimationClips,
  AnimationPlayer,
  animationLayer,
  animationPlugin,
} from '@aethervtt/shard-animation'
import { App } from '@aethervtt/shard-runtime'
import { findEntityByPath, loadScene, ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { CharacterController, Collider, RigidBody } from './components'
import { physics3dPlugin } from './plugin'

it("root motion 'character' walks a character controller the clip's distance", async () => {
  const a = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin, physics3dPlugin)
  await a.init()
  const w = a.world
  w.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [20, 0.5, 20] }],
    [Transform, { translation: [0, -0.5, 0] }],
  )
  const { entities } = loadScene(
    w,
    {
      version: 1,
      entities: [
        {
          name: 'rig',
          components: { 'core/Transform': { translation: [0, 0.95, 0] } },
          children: [
            { name: 'Hips', components: { 'core/Transform': { translation: [0, 1, 0] } } },
          ],
        },
      ],
    },
    { id: 'rig' },
  )
  const e = entities.get('rig')!
  w.add(e, CharacterController, {})
  for (let i = 0; i < 30; i++) a.update(1 / 60) // settle on the ground
  const start = [...w.get(e, Transform).translation]
  // The hips walk 2 m toward -z over a second, bobbing.
  const walk = w.resource(AnimationClips).add({
    name: 'walk',
    duration: 1,
    events: [],
    channels: [
      {
        target: 'Hips',
        component: 'core/Transform',
        field: 'translation',
        interpolation: 'linear',
        times: Float32Array.from([0, 0.5, 1]),
        values: Float32Array.from([0, 1, 0, 0, 1.1, -1, 0, 1, -2]),
        width: 3,
      },
    ],
  })
  w.add(e, AnimationPlayer, {
    layers: [animationLayer(walk, { loop: 'once' })],
    rootMotion: 'character',
  })
  for (let i = 0; i < 90; i++) a.update(1 / 60)
  const end = w.get(e, Transform).translation
  expect(end[2]! - start[2]!).toBeCloseTo(-2, 1)
  expect(Math.abs(end[0]! - start[0]!)).toBeLessThan(0.02)
  // The root joint stayed over the controller.
  expect(w.get(findEntityByPath(w, 'rig/Hips')!, Transform).translation[2]).toBeCloseTo(0, 4)
})
