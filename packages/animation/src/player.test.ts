import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import { type AssetRef, type Entity, quat, type World } from '@aethervtt/shard-core'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { PointLight } from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { findEntityByPath, loadScene, type SceneEntity, ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, describe, expect, it } from 'vitest'
import { animationLayer, crossfade } from './api'
import { type AnimationChannel, AnimationClips, parsePropertyClip } from './clip'
import {
  AnimationEvent,
  type AnimationEventData,
  AnimationFinished,
  type AnimationFinishedData,
  type AnimationLayerValue,
  AnimationMasks,
  AnimationPlayer,
  RootMotion,
} from './components'
import { describePlayer } from './methods'
import { animationPlugin } from './plugin'

const DT = 1 / 60
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

async function app(): Promise<App> {
  const a = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin)
  await a.init()
  return a
}

function frames(a: App, n: number): void {
  for (let i = 0; i < n; i++) a.update(DT)
}

const deg = (d: number) => (d * Math.PI) / 180
const rotY = (d: number) => [0, Math.sin(deg(d) / 2), 0, Math.cos(deg(d) / 2)]
const rotX = (d: number) => [Math.sin(deg(d) / 2), 0, 0, Math.cos(deg(d) / 2)]
const mul = (a: number[], b: number[]) => [...quat.multiply([0, 0, 0, 1], a, b)]

function expectQuat(actual: ArrayLike<number>, expected: number[], digits = 4): void {
  // q and -q are the same rotation.
  const sign = Math.sign(
    actual[0]! * expected[0]! +
      actual[1]! * expected[1]! +
      actual[2]! * expected[2]! +
      actual[3]! * expected[3]!,
  )
  for (let k = 0; k < 4; k++) expect(actual[k]! * sign).toBeCloseTo(expected[k]!, digits)
}

const joint = (name: string, translation: number[], children: SceneEntity[] = []) => ({
  name,
  components: { 'core/Transform': { translation } },
  ...(children.length ? { children } : {}),
})

/** A test skeleton: rig → Hips → Spine → Neck, and Hips → Leg. */
function rig(world: World, components: Record<string, object> = {}): Entity {
  const { entities } = loadScene(
    world,
    {
      version: 1,
      entities: [
        {
          name: 'rig',
          components: { 'core/Transform': {}, ...components } as never,
          children: [
            joint(
              'Hips',
              [0, 1, 0],
              [
                joint('Spine', [0, 0.3, 0], [joint('Neck', [0, 0.3, 0])]),
                joint('Leg', [0.1, 0, 0]),
              ],
            ),
          ],
        },
      ],
    },
    { id: `rig${Math.random()}` },
  )
  return entities.get('rig')!
}

type ChannelInit = Partial<Omit<AnimationChannel, 'times' | 'values'>> & {
  target: string
  times: number[]
  values: number[][]
}

function clip(world: World, duration: number, channels: ChannelInit[], events = [] as never[]) {
  return world.resource(AnimationClips).add({
    name: 'test',
    duration,
    events,
    channels: channels.map((c) => ({
      component: 'core/Transform',
      field: 'rotation',
      interpolation: 'linear',
      ...c,
      times: Float32Array.from(c.times),
      values: Float32Array.from(c.values.flat()),
      width: c.values[0]!.length,
    })),
  })
}

/** A clip holding one rotation on each of the given joints. */
const hold = (world: World, joints: string[], rotation: number[]) =>
  clip(
    world,
    1,
    joints.map((target) => ({ target, times: [0], values: [rotation] })),
  )

function player(world: World, entity: Entity, layers: AnimationLayerValue[], extra = {}) {
  world.add(entity, AnimationPlayer, { layers, ...extra })
}

const local = (world: World, path: string) => world.get(findEntityByPath(world, path)!, Transform)

describe('blending', () => {
  it('a 50/50 blend of two clips gives the halfway pose (slerp)', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const ca = clip(w, 1, [
      { target: 'Hips/Spine', times: [0], values: [rotY(0)] },
      { target: 'Hips', field: 'translation', times: [0], values: [[0, 1, 0]] },
    ])
    const cb = clip(w, 1, [
      { target: 'Hips/Spine', times: [0], values: [rotY(90)] },
      { target: 'Hips', field: 'translation', times: [0], values: [[0, 2, 1]] },
    ])
    player(w, e, [animationLayer(ca), animationLayer(cb, { weight: 0.5 })])
    frames(a, 1)
    expectQuat(local(w, 'rig/Hips/Spine').rotation, rotY(45))
    expect(local(w, 'rig/Hips').translation).toEqual([0, 1.5, 0.5])
  })

  it('an additive layer adds its change since the first frame', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const base = hold(w, ['Hips/Spine'], rotY(30))
    // First frame at 10°, sampled at 50°: adds 40° about X.
    const nod = clip(w, 1, [{ target: 'Hips/Spine', times: [0, 1], values: [rotX(10), rotX(50)] }])
    player(w, e, [
      animationLayer(base),
      animationLayer(nod, { blend: 'additive', time: 1, playing: false }),
    ])
    frames(a, 1)
    expectQuat(local(w, 'rig/Hips/Spine').rotation, mul(rotY(30), rotX(40)))
    // At half weight, half the delta.
    const layers = w.get(e, AnimationPlayer).layers
    layers[1]!.weight = 0.5
    w.set(e, AnimationPlayer, { layers })
    frames(a, 1)
    expectQuat(local(w, 'rig/Hips/Spine').rotation, mul(rotY(30), rotX(20)))
  })

  it('a masked layer changes only its subtree', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const all = ['Hips', 'Hips/Spine', 'Hips/Spine/Neck', 'Hips/Leg']
    const base = hold(w, all, rotY(10))
    const wave = hold(w, all, rotY(80))
    const mask = w.resource(AnimationMasks).add({
      joints: { 'Hips/Spine': 1, 'Hips/Spine/Neck': 0 },
    })
    player(w, e, [animationLayer(base), animationLayer(wave, { mask })])
    frames(a, 1)
    expectQuat(local(w, 'rig/Hips/Spine').rotation, rotY(80))
    for (const path of ['rig/Hips', 'rig/Hips/Spine/Neck', 'rig/Hips/Leg'])
      expectQuat(local(w, path).rotation, rotY(10))
  })

  it('joints no layer animates keep what code wrote', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    player(w, e, [animationLayer(hold(w, ['Hips/Spine'], rotY(20)))])
    const leg = findEntityByPath(w, 'rig/Hips/Leg')!
    w.set(leg, Transform, { rotation: rotX(33) as never })
    frames(a, 3)
    expectQuat(local(w, 'rig/Hips/Leg').rotation, rotX(33))
  })
})

describe('playback', () => {
  it('crossfade over 0.3 s reaches the target pose at 0.3 s; a once clip then finishes', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const idle = clip(w, 2, [{ target: 'Hips/Spine', times: [0, 2], values: [rotY(0), rotY(40)] }])
    const jump = clip(w, 1, [{ target: 'Hips/Spine', times: [0, 1], values: [rotX(0), rotX(90)] }])
    player(w, e, [animationLayer(idle)])
    frames(a, 30)
    const finished = w.reader(AnimationFinished)
    crossfade(w, e, jump, 0.3, { loop: 'once' })
    frames(a, 9)
    // Halfway through the fade: both clips count.
    expect(w.get(e, AnimationPlayer).layers.length).toBe(2)
    frames(a, 9)
    const layers = w.get(e, AnimationPlayer).layers
    expect(layers.length).toBe(1)
    expect(layers[0]!.weight).toBe(1)
    expectQuat(local(w, 'rig/Hips/Spine').rotation, rotX(90 * 0.3), 3)
    expect(finished.read().length).toBe(0)
    const events: AnimationFinishedData[] = []
    for (let i = 0; i < 45; i++) {
      a.update(DT)
      events.push(...(finished.read() as AnimationFinishedData[]))
    }
    expect(events).toEqual([{ entity: e, layer: 0 }])
    // It holds the last pose.
    expectQuat(local(w, 'rig/Hips/Spine').rotation, rotX(90))
    frames(a, 10)
    expect(finished.read().length).toBe(0)
  })

  it('sends clip events at their times, again after each loop, and for ping-pong both ways', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const step = w.resource(AnimationClips).add({
      name: 'walk',
      duration: 1,
      channels: [],
      events: [
        { time: 0.25, name: 'left' },
        { time: 0.75, name: 'right' },
      ],
    })
    player(w, e, [animationLayer(step)])
    const reader = w.reader(AnimationEvent)
    const names: string[] = []
    for (let i = 0; i < 150; i++) {
      a.update(DT)
      for (const ev of reader.read() as AnimationEventData[]) names.push(ev.name)
    }
    expect(names).toEqual(['left', 'right', 'left', 'right', 'left'])
    const layers = w.get(e, AnimationPlayer).layers
    layers[0] = animationLayer(step, { loop: 'ping-pong' })
    w.set(e, AnimationPlayer, { layers })
    names.length = 0
    for (let i = 0; i < 120; i++) {
      a.update(DT)
      for (const ev of reader.read() as AnimationEventData[]) names.push(ev.name)
    }
    expect(names).toEqual(['left', 'right', 'right', 'left'])
  })

  it('describes layers, unbound channels, and root motion', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    const c = clip(w, 1, [
      { target: 'Hips/Spine', times: [0], values: [rotY(0)] },
      { target: 'Hips/Tail', times: [0], values: [rotY(0)] },
    ])
    player(w, e, [animationLayer(c, { weight: 0.7 })])
    frames(a, 2)
    const d = describePlayer(w, e)
    expect(d.layers[0]).toMatchObject({ weight: expect.closeTo(0.7), loop: 'loop', loaded: true })
    expect(d.boundTargets).toBe(1)
    expect(d.unboundChannels).toEqual([
      'Hips/Tail core/Transform.rotation (no entity at this path)',
    ])
    expect(d.rootMotion.mode).toBe('none')
  })
})

describe('property clips', () => {
  const RADAR = {
    duration: 2,
    tracks: [
      {
        path: 'radar/dish',
        component: 'core/Transform',
        field: 'rotation',
        keys: [
          [0, [0, 0, 0, 1]],
          [2, [0, 1, 0, 0]],
        ],
        interpolation: 'linear',
      },
      {
        path: '',
        component: 'render/PointLight',
        field: 'intensity',
        keys: [
          [0, 800],
          [0.1, 0],
          [0.2, 800],
        ],
      },
    ],
    events: [{ time: 1, name: 'ping' }],
  }

  function tower(w: World): Entity {
    const { entities } = loadScene(
      w,
      {
        version: 1,
        entities: [
          {
            name: 'tower',
            components: { 'core/Transform': {}, 'render/PointLight': { intensity: 800 } },
            children: [
              {
                name: 'radar',
                components: { 'core/Transform': {} },
                children: [{ name: 'dish', components: { 'core/Transform': {} } }],
              },
            ],
          },
        ],
      },
      { id: 'tower' },
    )
    return entities.get('tower')!
  }

  it('imports a .anim.json that rotates an entity and blinks a light as authored', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-anim-'))
    roots.push(root)
    const file = join(root, 'assets/anims/radar.anim.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(RADAR))
    const a = await app()
    const w = a.world
    const assets = assetServer(w).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    const report = await assets.scan()
    expect(report.failed).toEqual([])
    await assets.load('assets/anims/radar.anim.json')
    const ref = assets.resolve('assets/anims/radar.anim.json')!
    expect(assets.info('assets/anims/radar.anim.json').info).toEqual({
      duration: 2,
      channelCount: 2,
      channels: ['radar/dish core/Transform.rotation', '(self) render/PointLight.intensity'],
      events: [{ time: 1, name: 'ping' }],
    })
    const e = tower(w)
    player(w, e, [animationLayer(ref)])
    const pings = w.reader(AnimationEvent)
    frames(a, 3) // t = 0.05: halfway down
    expect(w.get(e, PointLight).intensity).toBeCloseTo(400, 0)
    frames(a, 3) // t = 0.1: off
    expect(w.get(e, PointLight).intensity).toBeCloseTo(0, 0)
    frames(a, 54) // t = 1: a quarter turn
    expectQuat(local(w, 'tower/radar/dish').rotation, rotY(90))
    expect((pings.read() as AnimationEventData[]).map((p) => p.name)).toEqual(['ping'])
  })

  it('a track naming an unknown field fails with a pointer; a non-numeric field is invalid', () => {
    const bad = structuredClone(RADAR)
    bad.tracks[1]!.field = 'brightness'
    expect(() => parsePropertyClip(bad, 'radar')).toThrow(
      expect.objectContaining({ code: 'animation/unknown-target', path: '/tracks/1/field' }),
    )
    const unknown = structuredClone(RADAR)
    unknown.tracks[0]!.component = 'render/Nope'
    expect(() => parsePropertyClip(unknown, 'radar')).toThrow(
      expect.objectContaining({ code: 'animation/unknown-target', path: '/tracks/0/component' }),
    )
    const handle = structuredClone(RADAR)
    handle.tracks[0] = { ...handle.tracks[0]!, component: 'render/Mesh3d', field: 'mesh' }
    expect(() => parsePropertyClip(handle, 'radar')).toThrow(
      expect.objectContaining({ code: 'animation/invalid-track', path: '/tracks/0/field' }),
    )
    const width = structuredClone(RADAR)
    width.tracks[0]!.keys[1] = [2, [0, 1, 0]]
    expect(() => parsePropertyClip(width, 'radar')).toThrow(
      expect.objectContaining({ code: 'animation/invalid-track', path: '/tracks/0/keys/1/1' }),
    )
  })
})

describe('root motion', () => {
  /** Hips walk 2 m toward -z over a second (bobbing up and down), turning 90° left. */
  function walk(w: World, turn = 0): AssetRef {
    return clip(w, 1, [
      {
        target: 'Hips',
        field: 'translation',
        times: [0, 0.5, 1],
        values: [
          [0, 1, 0],
          [0, 1.1, -1],
          [0, 1, -2],
        ],
      },
      { target: 'Hips', field: 'rotation', times: [0, 1], values: [rotY(0), rotY(turn)] },
    ])
  }

  it("'transform' moves the entity by the clip's travel; the root joint stays in place", async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    player(w, e, [animationLayer(walk(w), { loop: 'once' })], { rootMotion: 'transform' })
    frames(a, 30)
    expect(local(w, 'rig/Hips').translation[1]).toBeCloseTo(1.1, 1) // height as authored
    frames(a, 40)
    const t = w.get(e, Transform).translation
    expect(t[2]).toBeCloseTo(-2, 2)
    expect(t[0]).toBeCloseTo(0, 4)
    const hips = local(w, 'rig/Hips').translation
    expect(hips[0]).toBeCloseTo(0, 4)
    expect(hips[2]).toBeCloseTo(0, 4)
    expect(w.get(e, RootMotion).translation).toEqual([0, 0, 0]) // done: no more travel
  })

  it('turning clips turn the entity, keep the root facing forward, and retrace the path', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    player(w, e, [animationLayer(walk(w, 90), { loop: 'once' })], { rootMotion: 'transform' })
    frames(a, 70)
    expectQuat(w.get(e, Transform).rotation, rotY(90), 3)
    expectQuat(local(w, 'rig/Hips').rotation, rotY(0), 3)
    // Entity plus pose retrace the clip's path: 2 m straight along -z, turning on the way.
    const t = w.get(e, Transform).translation
    expect(t[0]).toBeCloseTo(0, 2)
    expect(t[2]).toBeCloseTo(-2, 2)
  })

  it('loops carry on across the wrap', async () => {
    const a = await app()
    const w = a.world
    const e = rig(w)
    player(w, e, [animationLayer(walk(w))], { rootMotion: 'transform' })
    frames(a, 150) // 2.5 loops
    expect(w.get(e, Transform).translation[2]).toBeCloseTo(-5, 1)
  })
})
