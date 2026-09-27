import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@aethervtt/shard-assets'
import { ChildOf, quat } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import {
  Camera3d,
  captureView,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Shaders,
  Tonemapping,
} from '@aethervtt/shard-render'
import { compareGolden, settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import {
  FloatingOrigin,
  GlobalTransform,
  Grid,
  GridCell,
  lookAt,
  OriginShift,
  Transform,
  TransformPlugin,
} from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ParticleEmitterOverrides, ParticleSystem } from './components'
import { ParticleEffect, ParticleEffects, parseEffect } from './effect'
import { particlesPlugin } from './plugin'
import { Particles, readParticles } from './sim'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

async function scene(width = 96, height = 96, root?: string) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    particlesPlugin,
  )
  await app.init()
  if (root) {
    await assetServer(app.world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
      .scan()
  }
  const target = new OffscreenTarget(gpu, { label: 'particles', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'particles')
  const camera = (eye: [number, number, number], at: [number, number, number] = [0, 0, 0]) =>
    app.world.spawn(
      [Camera3d, { target: targetRef as never, fovY: 50, clearColor: [0, 0, 0, 1] }],
      [Exposure, { ev100: 10 }],
      [Tonemapping, { curve: 'none', dither: false }],
      [Transform, { translation: eye, rotation: lookAt(eye, at) }],
    )
  const step = async (n: number) => {
    for (let i = 0; i < n; i++) {
      app.update(1 / 60)
      await app.world.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
    }
  }
  return { app, world: app.world, camera, step, targetRef }
}

type World = Awaited<ReturnType<typeof scene>>['world']

const fountain = (extra: Record<string, unknown> = {}) => ({
  emitters: [
    {
      name: 'sparks',
      capacity: 4096,
      spawn: { rate: 600 },
      shape: { type: 'cone', angle: 20, radius: 0.1 },
      init: { lifetime: [1, 1.5], speed: [3, 5], size: [0.05, 0.1], color: '#ffc864' },
      update: [{ module: 'gravity' }, { module: 'drag', coefficient: 0.5 }],
      render: { blend: 'additive', emissive: 3000 },
      ...extra,
    },
  ],
})

function effect(world: World, json: unknown) {
  return world.resource(ParticleEffects).add(ParticleEffect.fromJson(json))
}

const aliveOf = (data: Float32Array) => {
  let n = 0
  for (let o = 0; o < data.length; o += 16) if (data[o + 7]! > 0 && data[o + 3]! < data[o + 7]!) n++
  return n
}

describe('particles', () => {
  it('rejects a bad module parameter with a pointer, and hot reloads a running effect', async () => {
    const bad = parseEffect({ emitters: [{ update: [{ module: 'drag', coefficient: 'lots' }] }] })
    expect(bad.errors[0]!.path).toBe('/emitters/0/update/0/coefficient')
    const unknown = parseEffect({ emitters: [{ update: [{ module: 'gravty' }] }] })
    expect(unknown.errors[0]!.path).toBe('/emitters/0/update/0/module')
    expect(unknown.errors[0]!.hint).toContain('gravity')

    const root = mkdtempSync(join(tmpdir(), 'shard-particles-'))
    roots.push(root)
    mkdirSync(join(root, 'assets/fx'), { recursive: true })
    const file = join(root, 'assets/fx/sparks.particles.json')
    writeFileSync(file, JSON.stringify(fountain()))
    writeFileSync(
      join(root, 'assets/fx/broken.particles.json'),
      JSON.stringify({ emitters: [{ init: { speed: 'fast' } }] }),
    )
    const { world, camera, step } = await scene(32, 32, root)
    const server = assetServer(world)
    expect(server.info('assets/fx/broken.particles.json')?.error?.path).toBe(
      '/emitters/0/init/speed',
    )
    await server.load('assets/fx/sparks.particles.json')
    const ref = server.resolve('assets/fx/sparks.particles.json')!
    world.spawn([ParticleSystem, { effect: ref as never }], Transform)
    camera([0, 2, 8])
    await step(30)
    const sys = [...world.resource(Particles).systems.values()][0]!
    const spawned = sys.emitters[0]!.spawned
    const buffer = sys.emitters[0]!.particles
    expect(spawned).toBeGreaterThan(200)
    // Edit the file: the same system picks up the new rules and keeps its particles.
    writeFileSync(file, JSON.stringify(fountain({ spawn: { rate: 1200 } })))
    await server.scan()
    await server.whenSettled(['assets/fx/sparks.particles.json'])
    await step(2)
    const after = [...world.resource(Particles).systems.values()][0]!
    expect(after.emitters[0]!.def.spawn.rate).toBe(1200)
    expect(after.emitters[0]!.particles).toBe(buffer)
    expect(after.emitters[0]!.spawned).toBeGreaterThan(spawned)
  })

  it('replays exactly: same seed, same frames, same particle buffers', async () => {
    const run = async (seed: number) => {
      const { world, camera, step } = await scene(32, 32)
      const e = world.spawn(
        [
          ParticleSystem,
          {
            playing: false,
            effect: effect(
              world,
              fountain({
                update: [
                  { module: 'gravity' },
                  { module: 'curl-noise', strength: 2 },
                  { module: 'rotation' },
                ],
              }),
            ),
            seed,
          },
        ],
        Transform,
      )
      camera([0, 2, 8])
      // Compile first: a frame the pipelines weren't ready is a frame not simulated.
      await step(5)
      world.set(e, ParticleSystem, { playing: true })
      await step(60)
      return readParticles(gpu, [...world.resource(Particles).systems.values()][0]!.emitters[0]!)
    }
    const a = await run(7)
    const b = await run(7)
    const c = await run(8)
    expect(aliveOf(a)).toBeGreaterThan(500)
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true)
    expect(Buffer.from(a.buffer).equals(Buffer.from(c.buffer))).toBe(false)
  })

  it('ParticleEmitterOverrides changes the spawn rate on the next frame', async () => {
    const { world, camera, step } = await scene(32, 32)
    const e = world.spawn(
      [ParticleSystem, { effect: effect(world, fountain()) }],
      [ParticleEmitterOverrides, { spawnScale: 1 }],
      Transform,
    )
    camera([0, 2, 8])
    await step(10)
    const emitter = () => [...world.resource(Particles).systems.values()][0]!.emitters[0]!
    const before = emitter().spawned
    await step(1)
    expect(emitter().spawned - before).toBe(10) // 600/s at 60 fps
    world.set(e, ParticleEmitterOverrides, { spawnScale: 0 })
    const stopped = emitter().spawned
    await step(1)
    expect(emitter().spawned).toBe(stopped)
    world.set(e, ParticleEmitterOverrides, { spawnRate: 6000, spawnScale: 1 })
    await step(1)
    expect(emitter().spawned - stopped).toBe(100)
    // The alive count follows (read back from the GPU).
    await step(30)
    expect(aliveOf(await readParticles(gpu, emitter()))).toBeGreaterThan(2000)
  })

  it('bounces particles off the floor it sees (golden sequence)', async () => {
    const { app, world, camera, step } = await scene(128, 96)
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 20 })) }],
      [
        MeshMaterial,
        {
          material: world
            .resource(Materials)
            .add(new MaterialAsset({ baseColor: [0.2, 0.2, 0.25, 1] })),
        },
      ],
      Transform,
    )
    world.spawn(
      [DirectionalLight, { illuminance: 3000 }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -1, 0.3, 0) as never }],
    )
    world.spawn(
      [
        ParticleSystem,
        {
          effect: effect(world, {
            emitters: [
              {
                capacity: 2048,
                spawn: { rate: 400 },
                shape: { type: 'sphere', radius: 0.3 },
                init: { lifetime: 3, speed: [0, 0.5], size: 0.08, color: '#8cf' },
                update: [{ module: 'gravity' }, { module: 'collision', restitution: 0.6 }],
                render: { emissive: 4000 },
              },
            ],
          }),
        },
      ],
      [Transform, { translation: [0, 2, 0] }],
    )
    const cam = camera([0, 1.5, 5], [0, 0.6, 0])
    await settle(app, 3)
    const frames: Uint8Array[] = []
    for (let i = 0; i < 3; i++) {
      await step(20)
      const shot = captureView(world, `camera:${cam}`)
      app.update(1 / 60)
      frames.push((await shot).data)
    }
    // No particle ends up under the floor: they bounced.
    const data = await readParticles(
      gpu,
      [...world.resource(Particles).systems.values()][0]!.emitters[0]!,
    )
    let below = 0
    let bounced = 0
    for (let o = 0; o < data.length; o += 16) {
      if (!(data[o + 7]! > 0 && data[o + 3]! < data[o + 7]!)) continue
      if (data[o + 1]! < -0.05) below++
      if (data[o + 3]! > 0.8 && data[o + 5]! > 0) bounced++
    }
    expect(below).toBe(0)
    expect(bounced).toBeGreaterThan(20)
    const strip = new Uint8Array(128 * 96 * 4 * 3)
    for (let y = 0; y < 96; y++)
      for (let k = 0; k < 3; k++)
        strip.set(frames[k]!.subarray(y * 128 * 4, (y + 1) * 128 * 4), (y * 3 + k) * 128 * 4)
    expect(
      compareGolden(here, 'particles-bounce', { width: 384, height: 96, data: strip }).mean,
    ).toBeLessThan(1.5)
    expect(world.resource(Gpu).errors).toEqual([])
  })

  it('fades soft particles where they meet geometry (golden image)', async () => {
    const shots: Uint8Array[] = []
    for (const softness of [0, 0.8]) {
      const { app, world, camera } = await scene(128, 96)
      world.spawn(
        [DirectionalLight, { illuminance: 3000 }],
        [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.8, 0.5, 0) as never }],
      )
      // A round, soft-edged puff.
      const puff = new Uint8Array(32 * 32 * 4)
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const r = Math.hypot(x - 15.5, y - 15.5) / 16
          puff.set([255, 255, 255, Math.round(255 * Math.max(0, 1 - r) ** 1.5)], (y * 32 + x) * 4)
        }
      const texture = world
        .resource(Textures)
        .add(Texture.create({ width: 32, height: 32, mips: [puff] }))
      world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 10 })) }],
        [
          MeshMaterial,
          {
            material: world
              .resource(Materials)
              .add(new MaterialAsset({ baseColor: [0.3, 0.3, 0.3, 1] })),
          },
        ],
        Transform,
      )
      world.spawn(
        [
          ParticleSystem,
          {
            effect: effect(world, {
              emitters: [
                {
                  capacity: 64,
                  spawn: { bursts: [{ time: 0, count: 24 }] },
                  shape: { type: 'box', size: [3, 0.2, 1.5] },
                  init: { lifetime: 100, speed: 0, size: 1.4, color: ['#ff9040', '#ffd080'] },
                  render: { blend: 'alpha', emissive: 400, softness, texture },
                },
              ],
            }),
          },
        ],
        Transform,
      )
      const cam = camera([0, 1.2, 4], [0, 0.2, 0])
      await settle(app, 4)
      const shot = captureView(world, `camera:${cam}`)
      app.update(1 / 60)
      const image = await shot
      shots.push(image.data)
      if (softness > 0) expect(compareGolden(here, 'particles-soft', image).mean).toBeLessThan(1.5)
      expect(
        world
          .resource(LogResource)
          .errors()
          .map((e) => e.message),
      ).toEqual([])
    }
    let diff = 0
    for (let i = 0; i < shots[0]!.length; i++) diff += Math.abs(shots[0]![i]! - shots[1]![i]!)
    expect(diff / shots[0]!.length).toBeGreaterThan(0.5)
  })

  it('the CPU backend matches the GPU: alive count and bounds over 120 frames', async () => {
    const results = []
    for (const backend of ['gpu', 'cpu'] as const) {
      const { world, camera, step } = await scene(32, 32)
      world.spawn(
        [ParticleSystem, { effect: effect(world, fountain()), seed: 3, backend }],
        Transform,
      )
      camera([0, 2, 8])
      await step(120)
      const data = await readParticles(
        gpu,
        [...world.resource(Particles).systems.values()][0]!.emitters[0]!,
      )
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let o = 0; o < data.length; o += 16) {
        if (!(data[o + 7]! > 0 && data[o + 3]! < data[o + 7]!)) continue
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, data[o + k]!)
          max[k] = Math.max(max[k]!, data[o + k]!)
        }
      }
      results.push({ alive: aliveOf(data), min, max })
    }
    const [g, c] = results
    expect(g!.alive).toBeGreaterThan(500)
    expect(Math.abs(g!.alive - c!.alive)).toBeLessThanOrEqual(2)
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(g!.min[k]! - c!.min[k]!)).toBeLessThan(0.05)
      expect(Math.abs(g!.max[k]! - c!.max[k]!)).toBeLessThan(0.05)
    }
  })

  it('keeps a world-space trail continuous across a floating-origin shift (spec 0040)', async () => {
    const trail = {
      emitters: [
        {
          name: 'trail',
          capacity: 512,
          spawn: { rate: 60 },
          shape: { type: 'point' },
          init: { lifetime: [4, 4], speed: [0, 0], size: [0.4, 0.4], color: '#64c8ff' },
          update: [],
          render: { blend: 'additive', emissive: 3000 },
          offscreen: 'simulate',
        },
      ],
    }
    const images: Uint8Array[] = []
    for (const backend of ['gpu', 'cpu'] as const) {
      const { world, step, app, targetRef } = await scene(96, 64)
      const grid = world.spawn([Grid, { cellSize: 100, hysteresis: 10 }])
      const ship = world.spawn(
        [ParticleSystem, { effect: effect(world, trail), seed: 5, backend }],
        Transform,
        GridCell,
        [ChildOf, { parent: grid }],
        FloatingOrigin,
      )
      const eye: [number, number, number] = [-12, 5, 25]
      const cam = world.spawn(
        [
          Camera3d,
          {
            target: targetRef as never,
            fovY: 50,
            clearColor: [0, 0, 0, 1],
          },
        ],
        [Exposure, { ev100: 10 }],
        [Tonemapping, { curve: 'none', dither: false }],
        [Transform, { translation: eye, rotation: lookAt(eye, [-12, 0, 0]) }],
        [ChildOf, { parent: ship }],
      )
      let shifts = 0
      world.observe(OriginShift, () => shifts++)
      // 2 m a frame along +x: past the 60 m recentering limit (half a cell plus hysteresis) twice.
      const v = 2 * 60
      for (let f = 1; f <= 90; f++) {
        world.set(ship, Transform, {
          translation: [f * 2 - world.get(ship, GridCell).cell[0]! * 100, 0, 0],
        })
        await step(1)
      }
      expect(shifts).toBe(2)
      expect(world.get(ship, GridCell).cell[0]).toBe(2)
      const e = [...world.resource(Particles).systems.values()][0]!.emitters[0]!
      const data = await readParticles(gpu, e)
      const alive: { age: number; x: number; y: number; z: number }[] = []
      for (let o = 0; o < data.length; o += 16) {
        if (!(data[o + 7]! > 0 && data[o + 3]! < data[o + 7]!)) continue
        alive.push({ age: data[o + 3]!, x: data[o]!, y: data[o + 1]!, z: data[o + 2]! })
      }
      alive.sort((a, b) => a.age - b.age)
      expect(alive.length).toBeGreaterThan(80)
      // The newest particle sits on the ship; each older one is v × its extra age behind it.
      const shipX = world.get(ship, GlobalTransform).matrix[3]!
      expect(Math.abs(alive[0]!.x - shipX)).toBeLessThan(1e-3)
      let worst = 0
      for (let i = 1; i < alive.length; i++) {
        const a = alive[i - 1]!
        const b = alive[i]!
        worst = Math.max(
          worst,
          Math.abs(b.x - a.x + v * (b.age - a.age)),
          Math.abs(b.y),
          Math.abs(b.z),
        )
      }
      // A missed shift would leave a 100 m gap at the crossing.
      expect(worst, backend).toBeLessThan(0.01)
      // The oldest particles were spawned before both shifts: the trail spans them.
      expect(alive.at(-1)!.age).toBeGreaterThan(80 / 60)
      const shot = captureView(world, `camera:${cam}`)
      app.update(0)
      images.push((await shot).data)
      expect(world.resource(LogResource).errors()).toEqual([])
    }
    expect(
      compareGolden(here, 'particles-origin-shift', { width: 96, height: 64, data: images[0]! })
        .mean,
    ).toBeLessThan(1)
    let diff = 0
    for (let i = 0; i < images[0]!.length; i++) diff += Math.abs(images[0]![i]! - images[1]![i]!)
    expect(diff / images[0]!.length).toBeLessThan(1)
  })
})
