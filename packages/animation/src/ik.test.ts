import { type AssetRef, type Entity, ShardError } from '@shard/core'
import { App, Log, LogResource } from '@shard/runtime'
import {
  findEntityByPath,
  loadScene,
  registerPrefab,
  type SceneEntity,
  ScenePlugin,
} from '@shard/scene'
import { GlobalTransform, Transform, TransformPlugin, worldPosition } from '@shard/transform'
import { describe, expect, it } from 'vitest'
import { animationLayer } from './api'
import { AnimationClips } from './clip'
import { AnimationPlayer } from './components'
import { describeIk, TwoBoneIk } from './ik'
import { describePlayer } from './methods'
import { animationPlugin } from './plugin'
import { JointMaps, jointKey, Retarget } from './retarget'
import { attachToSocket, BoneSocket } from './socket'
import { addBipedAssets, type Biped, biped, spawnBiped } from './testing'

async function start() {
  const app = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin)
  await app.init()
  app.world.insertResource(LogResource, new Log())
  return app
}

const T = (translation: number[], extra: Record<string, unknown> = {}) => ({
  'core/Transform': { translation, ...extra },
})

/** A chain of `n` joints named j0…, each `length` below the last, under `name` at `at`. */
function chain(
  name: string,
  at: number[],
  n: number,
  length: number,
  axis = [0, -1, 0],
): SceneEntity {
  let node: SceneEntity | undefined
  for (let k = n - 1; k >= 0; k--) {
    node = {
      name: `j${k}`,
      components: T(k === 0 ? [0, 0, 0] : axis.map((v) => v * length)),
      ...(node ? { children: [node] } : {}),
    }
  }
  return { name, components: T(at), children: [node!] }
}

const path = (n: number) => Array.from({ length: n }, (_, k) => `j${k}`).join('/')

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

describe('two-bone IK', () => {
  async function arm(target: number[], pole: number[] | null) {
    const app = await start()
    const w = app.world
    const { entities } = loadScene(
      w,
      {
        version: 1,
        entities: [
          {
            ...chain('arm', [0, 2, 0], 3, 0.5),
            children: [
              ...chain('arm', [0, 2, 0], 3, 0.5).children!,
              {
                name: 'ik',
                components: {
                  'animation/TwoBoneIk': {
                    root: 'j0',
                    mid: 'j0/j1',
                    tip: 'j0/j1/j2',
                    target: 'target',
                    pole: pole ? 'pole' : null,
                  },
                },
              },
            ],
          },
          { name: 'target', components: T(target) },
          { name: 'pole', components: T(pole ?? [0, 0, 0]) },
        ],
      },
      { id: 'main' },
    )
    app.update(1 / 60)
    return { app, w, entities, at: (p: string) => worldPosition(w, entities.get(p)!) }
  }

  it('puts the tip within 1 mm of a reachable target', async () => {
    const { w, at } = await arm([0.3, 1.4, 0.25], [0, 1.5, 1])
    expect(dist(at('arm/j0/j1/j2'), [0.3, 1.4, 0.25])).toBeLessThan(0.001)
    // Bone lengths hold.
    expect(dist(at('arm/j0'), at('arm/j0/j1'))).toBeCloseTo(0.5, 4)
    expect(dist(at('arm/j0/j1'), at('arm/j0/j1/j2'))).toBeCloseTo(0.5, 4)
    const [solver] = describeIk(w)
    expect(solver).toMatchObject({ kind: 'two-bone', solved: true, problem: null })
    expect(solver!.targetError as number).toBeLessThan(0.001)
  })

  it('bends toward the pole', async () => {
    const front = await arm([0, 1.3, 0.1], [0, 1.5, 2])
    expect(front.at('arm/j0/j1')[2]!).toBeGreaterThan(0.2)
    const back = await arm([0, 1.3, 0.1], [0, 1.5, -2])
    expect(back.at('arm/j0/j1')[2]!).toBeLessThan(-0.2)
    expect(dist(back.at('arm/j0/j1/j2'), [0, 1.3, 0.1])).toBeLessThan(0.001)
  })

  it('fully extends toward an unreachable target, still on the pole side', async () => {
    const { at } = await arm([2, 2, 0], [0, 2, -1])
    const root = at('arm/j0')
    const tip = at('arm/j0/j1/j2')
    expect(dist(root, tip)).toBeGreaterThan(0.999)
    // Pointing at the target, (1, 0, 0) from the root.
    expect((tip[0]! - root[0]!) / dist(root, tip)).toBeGreaterThan(0.9999)
    expect(at('arm/j0/j1')[2]!).toBeLessThanOrEqual(0)
  })

  it('weight blends with the animated pose, and at 0 the joints go back to it', async () => {
    const { app, w, entities, at } = await arm([0.5, 1.6, 0], [0, 2, 1])
    const ik = entities.get('arm/ik')!
    const solvedTip = at('arm/j0/j1/j2')
    w.set(ik, TwoBoneIk, { weight: 0.5 })
    app.update(1 / 60)
    const half = at('arm/j0/j1/j2')
    expect(dist(half, [0, 1, 0])).toBeGreaterThan(0.05)
    expect(dist(half, solvedTip)).toBeGreaterThan(0.05)
    w.set(ik, TwoBoneIk, { weight: 0 })
    app.update(1 / 60)
    // No clip animates the arm: IK's writes were undone, not stacked.
    expect(dist(at('arm/j0/j1/j2'), [0, 1, 0])).toBeLessThan(1e-5)
    expect([...w.get(entities.get('arm/j0')!, Transform).rotation]).toEqual([0, 0, 0, 1])
    w.set(ik, TwoBoneIk, { weight: 1 })
    for (let i = 0; i < 5; i++) app.update(1 / 60)
    expect(dist(at('arm/j0/j1/j2'), solvedTip)).toBeLessThan(1e-4)
  })

  it('solves on top of a clip each frame', async () => {
    const { app, w, entities, at } = await arm([0.4, 1.3, 0.2], [0, 2, 1])
    const clip = w.resource(AnimationClips).add({
      name: 'swing',
      duration: 1,
      events: [],
      channels: [
        {
          target: 'j0',
          component: 'core/Transform',
          field: 'rotation',
          interpolation: 'linear',
          times: Float32Array.from([0, 0.5, 1]),
          values: Float32Array.from([0, 0, 0, 1, 0.38, 0, 0, 0.92, 0, 0, 0, 1]),
          width: 4,
        },
      ],
    })
    w.add(entities.get('arm')!, AnimationPlayer, { layers: [animationLayer(clip)] })
    for (let i = 0; i < 40; i++) {
      app.update(1 / 60)
      expect(dist(at('arm/j0/j1/j2'), [0.4, 1.3, 0.2])).toBeLessThan(0.001)
    }
  })

  it('reaches into a model’s generated joints from the scene, and again after it respawns', async () => {
    const app = await start()
    const w = app.world
    const MODEL = 'prefabs/arm.prefab.json'
    const model = (length: number) => ({
      version: 1,
      root: {
        name: 'arm',
        components: T([0, 2, 0]),
        children: [chain('Upper', [0, 0, 0], 3, length)],
      },
    })
    registerPrefab(w, MODEL, model(0.5))
    loadScene(
      w,
      {
        version: 1,
        entities: [
          {
            name: 'hero',
            components: {
              'scene/PrefabInstance': { prefab: { path: MODEL } },
              'animation/TwoBoneIk': {
                root: 'Upper/j0',
                mid: 'Upper/j0/j1',
                tip: 'Upper/j0/j1/j2',
                target: 'target',
              },
            },
          },
          { name: 'target', components: T([0.3, 1.3, 0.2]) },
        ],
      },
      { id: 'main' },
    )
    const tip = () => worldPosition(w, findEntityByPath(w, 'main:hero/Upper/j0/j1/j2')!)
    app.update(1 / 60)
    expect(dist(tip(), [0.3, 1.3, 0.2])).toBeLessThan(0.001)
    registerPrefab(w, MODEL, model(0.6))
    app.update(1 / 60)
    expect(dist(tip(), [0.3, 1.3, 0.2])).toBeLessThan(0.001)
  })

  it('reports ik/not-a-chain and ik/unknown-joint', async () => {
    const app = await start()
    const w = app.world
    loadScene(
      w,
      {
        version: 1,
        entities: [
          {
            ...chain('arm', [0, 0, 0], 3, 0.5),
            children: [
              ...chain('arm', [0, 0, 0], 3, 0.5).children!,
              {
                name: 'crossed',
                components: {
                  'animation/TwoBoneIk': {
                    root: 'j0/j1',
                    mid: 'j0',
                    tip: 'j0/j1/j2',
                    target: 'target',
                  },
                },
              },
              {
                name: 'missing',
                components: {
                  'animation/TwoBoneIk': {
                    root: 'j0/Elbow',
                    mid: 'j0/j1',
                    tip: 'j0/j1/j2',
                    target: 'target',
                  },
                },
              },
            ],
          },
          { name: 'target', components: T([0, 0, 0]) },
        ],
      },
      { id: 'main' },
    )
    app.update(1 / 60)
    const codes = describeIk(w).map((s) => (s.problem as { code: string } | null)?.code)
    expect(codes.sort()).toEqual(['ik/not-a-chain', 'ik/unknown-joint'])
    const logged = w
      .resource(LogResource)
      .tail(10, 'error')
      .map((e) => e.code)
    expect(logged).toContain('ik/not-a-chain')
  })
})

describe('FABRIK', () => {
  it('reaches a target within tolerance in at most 10 iterations on a 12-joint chain', async () => {
    const app = await start()
    const w = app.world
    const tipPath = `tail/${path(12)}`
    const { entities } = loadScene(
      w,
      {
        version: 1,
        entities: [
          {
            ...chain('tail', [0, 0, 0], 12, 0.1, [0, 1, 0]),
            components: {
              ...T([0, 0, 0]),
              'animation/ChainIk': { root: 'j0', tip: path(12), target: 'target' },
            },
          },
          { name: 'target', components: T([0.45, 0.55, 0.3]) },
        ],
      },
      { id: 'main' },
    )
    app.update(1 / 60)
    const tip = worldPosition(w, entities.get(tipPath)!)
    expect(dist(tip, [0.45, 0.55, 0.3])).toBeLessThanOrEqual(0.001)
    const [solver] = describeIk(w)
    expect(solver!.iterations as number).toBeLessThanOrEqual(10)
    expect(solver!.iterations as number).toBeGreaterThan(0)
    // Segments keep their lengths and the root stays put.
    expect(dist(worldPosition(w, entities.get('tail/j0')!), [0, 0, 0])).toBeLessThan(1e-6)
    let prev = worldPosition(w, entities.get('tail/j0')!)
    for (let k = 1; k < 12; k++) {
      const p = worldPosition(w, entities.get(`tail/${path(k + 1)}`)!)
      expect(dist(prev, p)).toBeCloseTo(0.1, 4)
      prev = p
    }
  })

  it('points straight at a target out of reach', async () => {
    const app = await start()
    const w = app.world
    const tipPath = `tail/${path(5)}`
    const { entities } = loadScene(
      w,
      {
        version: 1,
        entities: [
          {
            ...chain('tail', [0, 0, 0], 5, 0.1, [0, 1, 0]),
            components: {
              ...T([0, 0, 0]),
              'animation/ChainIk': { root: 'j0', tip: path(5), target: 'target' },
            },
          },
          { name: 'target', components: T([3, 0, 0]) },
        ],
      },
      { id: 'main' },
    )
    app.update(1 / 60)
    const tip = worldPosition(w, entities.get(tipPath)!)
    expect(tip[0]).toBeCloseTo(0.4, 4)
    expect(Math.abs(tip[1]!)).toBeLessThan(1e-4)
  })
})

describe('look-at IK', () => {
  async function head(target: number[], maxAngle: number, share = 0) {
    const app = await start()
    const w = app.world
    const { entities } = loadScene(
      w,
      {
        version: 1,
        entities: [
          {
            name: 'body',
            components: {
              ...T([0, 0, 0]),
              'animation/LookAtIk': {
                joint: 'Neck/Head',
                target: 'target',
                maxAngle,
                chain: share > 0 ? [{ joint: 'Neck', share }] : [],
              },
            },
            children: [
              {
                name: 'Neck',
                components: T([0, 1.5, 0]),
                children: [{ name: 'Head', components: T([0, 0.1, 0]) }],
              },
            ],
          },
          { name: 'target', components: T(target) },
        ],
      },
      { id: 'main' },
    )
    app.update(1 / 60)
    const forward = (e: Entity) => {
      const m = w.get(e, GlobalTransform).matrix
      // -Z column.
      const f = [-m[2]!, -m[6]!, -m[10]!]
      const l = Math.hypot(...f)
      return f.map((v) => v / l)
    }
    return { app, w, entities, forward }
  }

  it('turns a head toward a target', async () => {
    const { w, entities, forward } = await head([2, 1.6, -2], 70)
    const f = forward(entities.get('body/Neck/Head')!)
    const d = [2, 0, -2].map((v) => v / Math.hypot(2, 2))
    expect(f[0]! * d[0]! + f[1]! * d[1]! + f[2]! * d[2]!).toBeGreaterThan(0.9999)
    const [solver] = describeIk(w)
    expect(solver).toMatchObject({ kind: 'look-at', clamped: false })
    expect(solver!.angleToTarget as number).toBeLessThan(0.1)
  })

  it('stops at maxAngle', async () => {
    // Straight behind: 180° away, clamped to 70.
    const { w, entities, forward } = await head([0.01, 1.6, 3], 70)
    const f = forward(entities.get('body/Neck/Head')!)
    const angle = (Math.acos(-f[2]!) * 180) / Math.PI // from the animated forward, -Z
    expect(angle).toBeCloseTo(70, 1)
    expect(describeIk(w)[0]).toMatchObject({ clamped: true })
  })

  it('spreads the turn over the chain by share', async () => {
    const { entities, forward, w } = await head([2, 1.6, 0], 90, 0.4)
    // The neck took 40% of the 90° turn; the head aimed the rest.
    const neck = w.get(entities.get('body/Neck')!, Transform).rotation
    expect((2 * Math.acos(Math.min(1, Math.abs(neck[3]!))) * 180) / Math.PI).toBeCloseTo(36, 0)
    const f = forward(entities.get('body/Neck/Head')!)
    expect(f[0]!).toBeGreaterThan(0.999)
  })
})

describe('retargeting', () => {
  it('normalizes joint names across conventions', () => {
    expect(jointKey('mixamorig:LeftUpLeg')).toBe('upleg.l')
    expect(jointKey('UpLeg_L')).toBe('upleg.l')
    expect(jointKey('upleg.L')).toBe('upleg.l')
    expect(jointKey('Armature/Hips/RightHand')).toBe('hand.r')
    expect(jointKey('L_Hand')).toBe('hand.l')
    expect(jointKey('Hand Left')).toBe('hand.l')
    expect(jointKey('Leg')).toBe('leg')
    expect(jointKey('Hips')).toBe('hips')
  })

  /** Lowest sole of a biped this frame (the lower of each ankle and toe, less their padding). */
  function lowestSole(w: App['world'], b: Biped, joint: (p: string) => Entity) {
    let lowest = Infinity
    for (const side of ['L', 'R'] as const) {
      lowest = Math.min(lowest, worldPosition(w, joint(b.path('Foot', side)))[1]! - 0.08 * b.scale)
      lowest = Math.min(lowest, worldPosition(w, joint(b.path('Toe', side)))[1]! - 0.02 * b.scale)
    }
    return lowest
  }

  async function walkOn(target: Biped, source: Biped, retarget: Record<string, unknown> | null) {
    const app = await start()
    const w = app.world
    const src = addBipedAssets(w, source)
    const tgt = addBipedAssets(w, target)
    const { root, joint } = spawnBiped(w, target, tgt, [0, 0, 0])
    if (retarget) w.add(root, Retarget, { source: src.skin as never, ...retarget })
    w.add(root, AnimationPlayer, { layers: [animationLayer(src.walk)], rootMotion: 'transform' })
    return { app, w, root, joint, src }
  }

  it('walks a short rig with other bind orientations on a tall rig’s clip: feet on the ground, root motion scaled', async () => {
    const tall = biped({ scale: 1.1, names: 'prefix' })
    const short = biped({ scale: 0.6, names: 'suffix', twisted: true })
    const { app, w, root, joint } = await walkOn(short, tall, { mode: 'rotation-and-root' })
    app.update(1 / 60)
    const start = [...w.get(root, Transform).translation]
    let worst = 0
    for (let f = 0; f < 60; f++) {
      app.update(1 / 60)
      worst = Math.max(worst, Math.abs(lowestSole(w, short, joint)))
    }
    expect(worst).toBeLessThan(0.02)
    const traveled = start[2]! - w.get(root, Transform).translation[2]!
    // 1.35 m/s at 1.1 scale, times the hip ratio 0.6 / 1.1.
    expect(traveled).toBeCloseTo(1.35 * 1.1 * (0.6 / 1.1), 1)
    const d = describePlayer(w, root)
    expect(d.retarget).toMatchObject({
      mode: 'rotation-and-root',
      root: { source: 'Hips', target: 'Hips' },
      unmappedJoints: [],
      problem: null,
    })
    expect(d.retarget!.hipRatio).toBeCloseTo(0.6 / 1.1, 3)
  })

  it('without retargeting, different bind orientations break the pose', async () => {
    const tall = biped({ scale: 1.1, names: 'suffix' })
    const short = biped({ scale: 0.6, names: 'suffix', twisted: true })
    const { app, w, joint } = await walkOn(short, tall, null)
    let worst = 0
    for (let f = 0; f < 60; f++) {
      app.update(1 / 60)
      worst = Math.max(worst, Math.abs(lowestSole(w, short, joint)))
    }
    expect(worst).toBeGreaterThan(0.1)
  })

  it('rotation mode keeps the target’s own hips; joint maps and unmapped joints', async () => {
    const tall = biped({ scale: 1.1, names: 'prefix' })
    // Rename the source hips to Pelvis and give it a tail the target lacks.
    const renamed: Biped = {
      ...tall,
      skin: { ...tall.skin, joints: tall.skin.joints.map((p) => p.replace(/^Hips/, 'Pelvis')) },
      walk: {
        ...tall.walk,
        channels: [
          ...tall.walk.channels.map((c) => ({ ...c, target: c.target.replace(/^Hips/, 'Pelvis') })),
          { ...tall.walk.channels[0]!, target: 'Pelvis/Tail' },
        ],
      },
    }
    const short = biped({ scale: 0.6, names: 'suffix', twisted: true })
    const { app, w, root, joint } = await walkOn(short, renamed, { mode: 'rotation' })
    app.update(1 / 60)
    let d = describePlayer(w, root)
    expect(d.retarget!.problem?.code).toBe('retarget/unmapped-root')
    expect(
      w
        .resource(LogResource)
        .tail(10, 'error')
        .map((e) => e.code),
    ).toContain('retarget/unmapped-root')
    const map = w.resource(JointMaps).add({ joints: { Pelvis: 'Hips' } }, 'pelvis-map')
    w.set(root, Retarget, { map: map as AssetRef<'JointMap'> })
    app.update(1 / 60)
    d = describePlayer(w, root)
    expect(d.retarget!.problem).toBeNull()
    expect(d.retarget!.unmappedJoints).toEqual(['Tail'])
    // rotation mode: the hips' translation stays the target's.
    expect(w.get(joint(short.path('Hips')), Transform).translation[1]).toBeCloseTo(
      short.hipHeight,
      4,
    )
  })
})

describe('sockets', () => {
  const HERO = 'prefabs/hero.prefab.json'
  const hero = (armLength: number) => ({
    version: 1,
    root: {
      name: 'hero',
      components: { 'core/Transform': {} },
      children: [
        {
          name: 'Arm',
          components: T([0, 1.5, 0]),
          children: [
            {
              name: 'Hand',
              components: {
                ...T([0, -armLength, 0]),
                'animation/BoneSocket': { name: 'hand_r', offset: [0, -0.1, 0] },
              },
            },
          ],
        },
      ],
    },
  })

  it('an attached entity follows the hand through a clip, and survives a model reload', async () => {
    const app = await start()
    const w = app.world
    registerPrefab(w, HERO, hero(0.6))
    const { entities } = loadScene(
      w,
      {
        version: 1,
        entities: [
          { name: 'hero', components: { 'scene/PrefabInstance': { prefab: { path: HERO } } } },
          {
            name: 'sword',
            components: {
              ...T([5, 5, 5]),
              'animation/Attach': { owner: 'hero', socket: 'hand_r' },
            },
          },
        ],
      },
      { id: 'main' },
    )
    const heroE = entities.get('hero')!
    const sword = entities.get('sword')!
    const swing = w.resource(AnimationClips).add({
      name: 'swing',
      duration: 1,
      events: [],
      channels: [
        {
          target: 'Arm',
          component: 'core/Transform',
          field: 'rotation',
          interpolation: 'linear',
          times: Float32Array.from([0, 0.5, 1]),
          values: Float32Array.from([0, 0, 0, 1, Math.SQRT1_2, 0, 0, Math.SQRT1_2, 0, 0, 0, 1]),
          width: 4,
        },
      ],
    })
    app.update(1 / 60)
    w.add(heroE, AnimationPlayer, { layers: [animationLayer(swing)] })
    const expectOnHand = () => {
      const hand = findEntityByPath(w, 'main:hero/Arm/Hand')!
      const m = w.get(hand, GlobalTransform).matrix
      // Hand position plus its rotation of the socket offset (0, -0.1, 0): minus 0.1 × its Y column.
      const expected = [m[3]! - 0.1 * m[1]!, m[7]! - 0.1 * m[5]!, m[11]! - 0.1 * m[9]!]
      expect(dist(worldPosition(w, sword), expected)).toBeLessThan(1e-5)
      return hand
    }
    const seen: number[] = []
    for (let f = 0; f < 30; f++) {
      app.update(1 / 60)
      expectOnHand()
      seen.push(worldPosition(w, sword)[2]!)
    }
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.3) // it moved with the swing
    const before = expectOnHand()
    // Reload the model: a longer arm, new joint entities.
    registerPrefab(w, HERO, hero(0.9))
    app.update(1 / 60)
    expect(w.isAlive(sword)).toBe(true)
    const after = expectOnHand()
    expect(after).not.toBe(before)
    for (let f = 0; f < 10; f++) {
      app.update(1 / 60)
      expectOnHand()
    }
  })

  it('attachToSocket parents at the offset; an unknown socket names the ones there are', async () => {
    const app = await start()
    const w = app.world
    const { entities } = loadScene(
      w,
      {
        version: 1,
        entities: [
          {
            name: 'rig',
            components: T([1, 0, 0]),
            children: [
              {
                name: 'Hand',
                components: {
                  ...T([0, 1, 0]),
                  'animation/BoneSocket': { name: 'grip', offset: [0, 0, 0.2] },
                },
              },
            ],
          },
          { name: 'cup', components: T([0, 0, 0]) },
        ],
      },
      { id: 'main' },
    )
    const joint = attachToSocket(w, entities.get('cup')!, entities.get('rig')!, 'grip')
    expect(joint).toBe(entities.get('rig/Hand'))
    app.update(1 / 60)
    expect(worldPosition(w, entities.get('cup')!)).toEqual([1, 1, expect.closeTo(0.2, 6)])
    let error: unknown
    try {
      attachToSocket(w, entities.get('cup')!, entities.get('rig')!, 'hand_l')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ShardError)
    expect((error as ShardError).code).toBe('animation/unknown-socket')
    expect((error as ShardError).message).toContain('"grip"')
    expect(w.has(entities.get('rig/Hand')!, BoneSocket)).toBe(true)
  })
})
