import {
  AnimationPlayer,
  animationLayer,
  animationPlugin,
  describeIk,
  FootPlacement,
  TwoBoneIk,
} from '@shard/animation'
import { addBipedAssets, biped, spawnBiped } from '@shard/animation/testing'
import { ChildOf, type Entity } from '@shard/core'
import { App } from '@shard/runtime'
import { ScenePlugin } from '@shard/scene'
import { GlobalTransform, Transform, TransformPlugin, worldPosition } from '@shard/transform'
import { expect, it } from 'vitest'
import { Collider, RigidBody } from './components'
import { physics, physics3dPlugin } from './plugin'
import { createRayHit } from './world'

const SLOPE = (20 * Math.PI) / 180

it('on a 20° slope, foot placement puts both feet on the ground, lowers the hips, and aligns the feet to the normal', async () => {
  const app = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin, physics3dPlugin)
  await app.init()
  const w = app.world
  // Ground rising toward +X, its top surface through the origin.
  const normal = [-Math.sin(SLOPE), Math.cos(SLOPE), 0]
  w.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [6, 0.5, 6] }],
    [
      Transform,
      {
        translation: [-normal[0]! * 0.5, -normal[1]! * 0.5, 0],
        rotation: [0, 0, Math.sin(SLOPE / 2), Math.cos(SLOPE / 2)],
      },
    ],
  )
  const body = biped()
  const assets = addBipedAssets(w, body)
  const { root, joint } = spawnBiped(w, body, assets, [0, 0, 0])
  w.add(root, AnimationPlayer, { layers: [animationLayer(assets.idle)] })
  const leg = (side: 'L' | 'R') => {
    const target = w.spawn([Transform, {}])
    const pole = w.spawn(
      [Transform, { translation: [side === 'L' ? -0.1 : 0.1, 0.5, -1] }],
      [ChildOf, { parent: root }],
    )
    const ik = w.spawn(
      [
        TwoBoneIk,
        {
          root: body.path('UpLeg', side),
          mid: body.path('Leg', side),
          tip: body.path('Foot', side),
          target,
          pole,
          tipRotation: 1,
        },
      ],
      [ChildOf, { parent: root }],
    )
    return { ik, foot: joint(body.path('Foot', side)) }
  }
  const left = leg('L')
  const right = leg('R')
  const hips = joint(body.path('Hips'))
  // Settle physics and the pose, then read where the animation alone puts the hips.
  for (let i = 0; i < 10; i++) app.update(1 / 60)
  const animatedHips = worldPosition(w, hips)[1]!
  w.add(root, FootPlacement, {
    feet: [
      { ik: left.ik, footJoint: body.path('Foot', 'L'), offset: body.ankle },
      { ik: right.ik, footJoint: body.path('Foot', 'R'), offset: body.ankle },
    ],
    hips: body.path('Hips'),
  })
  for (let i = 0; i < 30; i++) app.update(1 / 60)

  const p = physics(w)
  const hit = createRayHit()
  for (const foot of [left.foot, right.foot] as Entity[]) {
    const at = worldPosition(w, foot)
    // Straight down from the ankle: the ground is `offset` away along the normal.
    expect(p.raycast(at, [0, -1, 0], undefined, hit)).toBe(true)
    expect(Math.abs(hit.distance * Math.cos(SLOPE) - body.ankle)).toBeLessThan(0.02)
    // The sole (the foot's -Y) faces the ground: its +Y is the normal.
    const m = w.get(foot, GlobalTransform).matrix
    const y = [m[1]!, m[5]!, m[9]!]
    const len = Math.hypot(...y)
    const dot = (y[0]! * normal[0]! + y[1]! * normal[1]! + y[2]! * normal[2]!) / len
    expect(dot).toBeGreaterThan(0.99)
  }
  // The downhill foot (left, at -X) is lower; the hips came down so it reaches.
  expect(worldPosition(w, left.foot)[1]!).toBeLessThan(worldPosition(w, right.foot)[1]! - 0.04)
  expect(worldPosition(w, hips)[1]!).toBeLessThan(animatedHips - 0.02)
  const [feet] = describeIk(w).filter((s) => s.kind === 'feet')
  expect(feet).toMatchObject({ solved: true, problem: null })
  expect(feet!.hipsDrop as number).toBeLessThan(-0.02)
  expect((feet!.feet as { grounded: boolean }[]).every((f) => f.grounded)).toBe(true)
  // Weight 0 hands the pose back to the animation.
  w.set(root, FootPlacement, { weight: 0 })
  w.set(left.ik, TwoBoneIk, { weight: 0 })
  w.set(right.ik, TwoBoneIk, { weight: 0 })
  app.update(1 / 60)
  expect(worldPosition(w, hips)[1]!).toBeCloseTo(animatedHips, 2)
})
