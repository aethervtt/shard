import type { AssetRef, Entity, World } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { GlobalTransform, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { animationLayer, crossfade } from './api'
import { type AnimationClipAsset, AnimationClips } from './clip'
import {
  AnimationEvent,
  type AnimationEventData,
  AnimationFinished,
  type AnimationFinishedData,
  AnimationMasks,
  AnimationPlayer,
  AnimationSampling,
  RootMotion,
} from './components'
import { bakeClip, createFlatPose, flatRest, flatSkeleton, samplePose } from './flat'
import { AnimationStateResource } from './player'
import { animationPlugin } from './plugin'
import { Retarget } from './retarget'
import { addBipedAssets, biped, spawnBiped } from './testing'

const DT = 1 / 60

async function start(): Promise<App> {
  const app = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin)
  await app.init()
  return app
}

// --- 3x4 affine rows ---------------------------------------------------------------------------

function mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(12)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++)
      out[r * 4 + c] =
        a[r * 4]! * b[c]! +
        a[r * 4 + 1]! * b[4 + c]! +
        a[r * 4 + 2]! * b[8 + c]! +
        (c === 3 ? a[r * 4 + 3]! : 0)
  return out
}

function invert(m: ArrayLike<number>): number[] {
  const [a, b, c, , d, e, f, , g, h, i] = Array.from(m)
  const A = e! * i! - f! * h!
  const B = -(d! * i! - f! * g!)
  const C = d! * h! - e! * g!
  const k = 1 / (a! * A + b! * B + c! * C)
  const r = [
    A * k,
    -(b! * i! - c! * h!) * k,
    (b! * f! - c! * e!) * k,
    B * k,
    (a! * i! - c! * g!) * k,
    -(a! * f! - c! * d!) * k,
    C * k,
    -(a! * h! - b! * g!) * k,
    (a! * e! - b! * d!) * k,
  ]
  const out: number[] = []
  for (let row = 0; row < 3; row++) {
    const x = r[row * 3]!
    const y = r[row * 3 + 1]!
    const z = r[row * 3 + 2]!
    out.push(x, y, z, -(x * m[3]! + y * m[7]! + z * m[11]!))
  }
  return out
}

/** Column-major 4x4 → rows of its top 3x4. */
function ibmRows(ibm: Float32Array, j: number): number[] {
  const out: number[] = []
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out.push(ibm[j * 16 + c * 4 + r]!)
  return out
}

/** Every joint's `jointWorld × ibm`, relative to the player: what the entity sampler drives. */
function entityRows(w: World, root: Entity, joints: Entity[], ibm: Float32Array): number[] {
  const inv = invert(w.get(root, GlobalTransform).matrix)
  return joints.flatMap((j, k) => mul(mul(inv, w.get(j, GlobalTransform).matrix), ibmRows(ibm, k)))
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length)
  let d = 0
  for (let k = 0; k < a.length; k++) d = Math.max(d, Math.abs(a[k]! - b[k]!))
  return d
}

function withEvents(w: World, clip: AnimationClipAsset): AssetRef {
  return w.resource(AnimationClips).add({
    ...clip,
    name: `${clip.name}-events`,
    events: [
      { time: 0.25, name: 'left' },
      { time: 0.75, name: 'right' },
    ],
  })
}

describe('time-only players', () => {
  it('send the same events, finish and fade the same as sampled players, and write nothing', async () => {
    const app = await start()
    const w = app.world
    const body = biped()
    const assets = addBipedAssets(w, body)
    const walk = withEvents(w, body.walk)
    const once = w.resource(AnimationClips).add({ ...body.idle, name: 'once' })
    const sampled = spawnBiped(w, body, assets, [0, 0, 0])
    const timeOnly = spawnBiped(w, body, assets, [3, 0, 0])
    for (const { root } of [sampled, timeOnly]) {
      w.add(root, AnimationPlayer, {
        layers: [animationLayer(walk, { time: 0.1 })],
        rootMotion: 'transform',
      })
    }
    w.add(timeOnly.root, AnimationSampling, { mode: 'none' })
    const restOf = body.joints.map((p) => {
      const t = w.get(timeOnly.joint(p), Transform)
      return [...t.translation, ...t.rotation, ...t.scale]
    })
    const events = w.reader(AnimationEvent)
    const finished = w.reader(AnimationFinished)
    const log = new Map<Entity, string[]>([
      [sampled.root, []],
      [timeOnly.root, []],
    ])
    for (let f = 0; f < 200; f++) {
      if (f === 70) {
        for (const { root } of [sampled, timeOnly]) crossfade(w, root, once, 0.25, { loop: 'once' })
      }
      app.update(DT)
      for (const e of events.read() as AnimationEventData[])
        log.get(e.entity)!.push(`${f} ${e.layer} ${e.name} ${e.time}`)
      for (const e of finished.read() as AnimationFinishedData[])
        log.get(e.entity)!.push(`${f} ${e.layer} finished`)
      const a = w.get(sampled.root, AnimationPlayer).layers
      const b = w.get(timeOnly.root, AnimationPlayer).layers
      expect(b).toEqual(a)
    }
    const a = log.get(sampled.root)!
    expect(a.filter((s) => s.endsWith('finished'))).toHaveLength(1)
    expect(a.filter((s) => s.includes('left')).length).toBeGreaterThan(0)
    expect(log.get(timeOnly.root)).toEqual(a)
    // The crossfade ended and removed the walk.
    expect(w.get(timeOnly.root, AnimationPlayer).layers).toHaveLength(1)
    // Nothing written: joints at rest, the entity unmoved, no root motion, no binding.
    body.joints.forEach((p, k) => {
      const t = w.get(timeOnly.joint(p), Transform)
      expect([...t.translation, ...t.rotation, ...t.scale]).toEqual(restOf[k])
    })
    expect([...w.get(timeOnly.root, Transform).translation]).toEqual([3, 0, 0])
    expect([...w.get(timeOnly.root, RootMotion).translation]).toEqual([0, 0, 0])
    expect(w.get(sampled.root, Transform).translation[2]).toBeLessThan(-1)
    const bindings = w.resource(AnimationStateResource).bindings
    expect(bindings.has(timeOnly.root)).toBe(false)
    expect(bindings.has(sampled.root)).toBe(true)
    // Switching a sampled player to time only drops its binding (its joints may be given away).
    w.add(sampled.root, AnimationSampling, { mode: 'none' })
    app.update(DT)
    expect(bindings.has(sampled.root)).toBe(false)
  })
})

describe('samplePose', () => {
  it('matches the entity sampler: retargeted, masked, additive, crossfading, root pinned', async () => {
    const app = await start()
    const w = app.world
    const tall = biped({ scale: 1.1, names: 'prefix' })
    const short = biped({ scale: 0.6, names: 'suffix', twisted: true })
    const src = addBipedAssets(w, tall)
    const tgt = addBipedAssets(w, short)
    const { root, joint } = spawnBiped(w, short, tgt, [1, 0, 2], 30)
    const upper = w.resource(AnimationMasks).add({ joints: { [short.path('Spine')]: 1 } })
    w.add(root, Retarget, { source: src.skin as never, mode: 'rotation-and-root' })
    w.add(root, AnimationPlayer, {
      layers: [
        animationLayer(src.walk, { time: 0.2 }),
        animationLayer(src.idle, { weight: 0.7, mask: upper as never, speed: 0.8 }),
        animationLayer(src.idle, { weight: 0.5, blend: 'additive', time: 0.6, speed: 1.3 }),
      ],
      rootMotion: 'transform',
    })
    const joints = short.joints.map(joint)
    const ibm = short.skin.inverseBindMatrices
    const pose = createFlatPose(flatSkeleton(short.skin), flatRest(short.skin))
    const out = new Float32Array(short.joints.length * 12 + 24)
    let compared = 0
    for (let f = 1; f <= 60; f++) {
      if (f === 24) crossfade(w, root, src.walk, 0.3, { time: 0.5 })
      app.update(DT)
      if (f % 4 !== 0) continue
      samplePose(w, root, pose, out, 24)
      const expected = entityRows(w, root, joints, ibm)
      expect(maxDiff(out.subarray(24), expected)).toBeLessThan(1e-5)
      compared++
    }
    expect(compared).toBe(15)
    // The walk travelled the entity; the flat pose kept its hips over the origin.
    expect(w.get(root, Transform).translation[2]).toBeLessThan(1.5)
    const hips = pose.model
    expect(Math.hypot(hips[3]!, hips[11]!)).toBeLessThan(0.05)
  })

  it('reads rest where nothing animates, and skips property channels', async () => {
    const app = await start()
    const w = app.world
    const body = biped()
    const clip = w.resource(AnimationClips).add({
      name: 'one-arm',
      duration: 1,
      events: [],
      channels: [
        {
          target: body.path('UpperArm', 'L'),
          component: 'core/Transform',
          field: 'rotation',
          interpolation: 'linear',
          times: Float32Array.from([0]),
          values: Float32Array.from([0, 0, Math.sin(0.4), Math.cos(0.4)]),
          width: 4,
        },
        {
          target: '',
          component: 'core/Transform',
          field: 'scale',
          interpolation: 'linear',
          times: Float32Array.from([0]),
          values: Float32Array.from([2, 2, 2]),
          width: 3,
        },
      ],
    })
    const e = w.spawn([AnimationPlayer, { layers: [animationLayer(clip)] }], [Transform, {}])
    w.add(e, AnimationSampling, { mode: 'none' })
    const rest = flatRest(body.skin)
    const pose = createFlatPose(flatSkeleton(body.skin), rest)
    const out = new Float32Array(body.joints.length * 12)
    app.update(DT)
    samplePose(w, e, pose, out, 0)
    const arm = body.joints.indexOf(body.path('UpperArm', 'L'))
    for (let j = 0; j < body.joints.length; j++) {
      const lane = Array.from(pose.local.subarray(j * 10, j * 10 + 10))
      if (j !== arm) expect(lane).toEqual(Array.from(rest.subarray(j * 10, j * 10 + 10)))
    }
    expect(pose.local[arm * 10 + 5]).toBeCloseTo(Math.sin(0.4), 6)
    // Rest everywhere else: the hips' rows are identity (model × its inverse bind).
    expect(maxDiff(out.subarray(0, 12), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])).toBeLessThan(1e-6)
    expect([...w.get(e, Transform).scale]).toEqual([1, 1, 1])
  })
})

describe('bakeClip', () => {
  it('equals samplePose bit for bit at its frame times; its sphere holds every frame', async () => {
    const app = await start()
    const w = app.world
    const tall = biped({ scale: 1.1, names: 'prefix' })
    const short = biped({ scale: 0.6, names: 'suffix', twisted: true })
    const src = addBipedAssets(w, tall)
    const skeleton = flatSkeleton(short.skin)
    const rest = flatRest(short.skin)
    const n = short.joints.length
    const radii = new Float32Array(n).fill(0.04)
    radii[3] = -1
    const fps = 30
    const baked = bakeClip(w, skeleton, rest, tall.walk, fps, {
      skin: tall.skin,
      mode: 'rotation-and-root',
      align: true,
    })
    const bounded = bakeClip(
      w,
      skeleton,
      rest,
      tall.walk,
      fps,
      { skin: tall.skin, mode: 'rotation-and-root' },
      radii,
    )
    const pinned = bakeClip(
      w,
      skeleton,
      rest,
      tall.walk,
      fps,
      { skin: tall.skin, mode: 'rotation-and-root' },
      radii,
      true,
    )
    expect(baked.frames).toBe(31)
    expect(baked.rows.length).toBe(31 * n * 12)
    expect(bounded.rows).toEqual(baked.rows)
    // The same clip on a time-only player, at each frame's time.
    const e = w.spawn([Transform, {}])
    w.add(e, Retarget, { source: src.skin as never, mode: 'rotation-and-root' })
    w.add(e, AnimationPlayer, {
      layers: [animationLayer(src.walk, { playing: false })],
      rootMotion: 'transform',
    })
    w.add(e, AnimationSampling, { mode: 'none' })
    app.update(DT)
    const pose = createFlatPose(skeleton, rest)
    const out = new Float32Array(n * 12)
    const sphere = new Float32Array(4)
    const [cx, cy, cz, R] = bounded.sphere
    const frame = (rows: Float32Array, f: number) => rows.subarray(f * n * 12, (f + 1) * n * 12)
    let swayed = 0
    for (let f = 0; f < baked.frames; f++) {
      const time = (f / (baked.frames - 1)) * tall.walk.duration
      // Pinned: as a player with root motion on.
      w.set(e, AnimationPlayer, {
        layers: [animationLayer(src.walk, { playing: false, time })],
        rootMotion: 'transform',
      })
      samplePose(w, e, pose, out, 0)
      expect(out).toEqual(frame(pinned.rows, f))
      // Not pinned: as a player without (its root travels and turns as authored).
      w.set(e, AnimationPlayer, {
        layers: [animationLayer(src.walk, { playing: false, time })],
        rootMotion: 'none',
      })
      samplePose(w, e, pose, out, 0, radii, sphere)
      expect(out).toEqual(frame(baked.rows, f))
      swayed = Math.max(
        swayed,
        Math.abs(baked.rows[f * n * 12 + 11]! - pinned.rows[f * n * 12 + 11]!),
      )
      for (let j = 0; j < n; j++) {
        if (radii[j]! < 0) continue
        const m = pose.model
        const d = Math.hypot(m[j * 12 + 3]! - cx!, m[j * 12 + 7]! - cy!, m[j * 12 + 11]! - cz!)
        expect(d + radii[j]!).toBeLessThanOrEqual(R! * (1 + 1e-6))
      }
      expect(sphere[3]!).toBeLessThanOrEqual(R! * (1 + 1e-6))
    }
    // The walk travels: unpinned, the hips move along Z; pinned they stay put.
    expect(swayed).toBeGreaterThan(0.3)
  })
})
