import type { Entity } from '@aethervtt/shard-core'
import {
  allocationChecks,
  budget,
  gcWindow,
  timeout,
  timingMode,
} from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { AmbientLight, Gpu, Graph, PointLight, RenderStats } from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Structure } from './compile'
import { Floor, Opening, Roof, StructureSettings, Wall } from './components'
import { maxScene } from './fixtures'
import { type Rig, rig } from './harness'
import {
  FieldLayer,
  packRect,
  SolveScratch,
  solveRect,
  type TexelRect,
  unpackVisibility,
} from './interior'
import { Interior, updateInterior } from './interior-plugin'

// Interior lighting on the max structure fixture (0069): 5000 walls, 1024 openings, roofs over
// every block of rooms, and 200 torches blocked by walls.

let gpu: GpuContext
beforeAll(async () => {
  // GPU timestamps where the adapter has them: frames are timed on the GPU, not by the queue.
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(() => gpu.destroy())

/** The fixture's rooms are 4.5 m (210 px) on a side, 50 to a row. */
const ROOM = 4.5

/** The max fixture, a roof over each 5×5 block of rooms, and 200 torches in rooms. */
async function maxInterior(o: { width?: number; height?: number } = {}) {
  const r = await rig(gpu, {
    shadows: false,
    interior: true,
    width: o.width ?? 64,
    height: o.height ?? 64,
  })
  const world = r.app.world
  Object.assign(world.resource(AmbientLight), { brightness: 3000 })
  r.host.sync(maxScene())
  for (let bx = 0; bx < 10; bx++)
    for (let bz = 0; bz < 10; bz++) {
      const x = bx * 5 * ROOM
      const z = bz * 5 * ROOM
      const s = 5 * ROOM
      world.spawn([
        Roof,
        {
          points: [
            [x, z],
            [x + s, z],
            [x + s, z + s],
            [x, z + s],
          ],
          height: 3,
          thickness: 0.2,
        },
      ])
    }
  const torches: Entity[] = []
  for (let i = 0; i < 200; i++) {
    const c = (i * 7) % 50
    const row = Math.floor((i * 7) / 50) * 3
    torches.push(
      world.spawn(
        [
          PointLight,
          {
            intensity: 20_000,
            range: 6,
            falloff: 'tabletop',
            bright: 2,
            blockedByWalls: true,
          },
        ],
        [Transform, { translation: [(c + 0.5) * ROOM, 1.5, (row + 0.5) * ROOM] }],
      ),
    )
  }
  r.look([110, 60, 160], [110, 0, 100])
  return { r, world, torches }
}

/**
 * GPU time of a frame, the median of `n`: its passes' span from GPU timestamps where the device
 * has them, else from its submit to the queue going idle.
 */
async function frameMs(r: Rig, n: number): Promise<number> {
  const timer = r.app.world.resource(Graph).timer
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const samples = timer.frameSamples
    r.frame()
    const t0 = performance.now()
    await gpu.device.queue.onSubmittedWorkDone()
    const idle = performance.now() - t0
    if (!timer.enabled) {
      times.push(idle)
      continue
    }
    // The timestamps land a task or two after the work is done.
    for (let k = 0; k < 20 && timer.frameSamples === samples; k++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    if (timer.frameSamples !== samples) times.push(timer.frameMs)
  }
  times.sort((x, y) => x - y)
  return times[times.length >> 1]!
}

/**
 * Interleaved GPU frame timing of configurations (each a settings patch): per round, each one's
 * time over the first's; the median per configuration, and the first's median time. A laptop's
 * clocks drift far more over a run than within a round.
 */
async function gpuRatios(
  r: Rig,
  configs: (() => void)[],
): Promise<{ ratios: number[]; ms: number }> {
  const rounds = timingMode === 'bench' ? 12 : 2
  // Every configuration's pipelines compile before anything is timed.
  for (const c of configs) {
    c()
    await settle(r.app)
  }
  const per: number[][] = configs.map(() => [])
  const base: number[] = []
  for (let round = 0; round < rounds; round++) {
    let first = 0
    for (let k = 0; k < configs.length; k++) {
      configs[k]!()
      await settle(r.app, 3)
      const ms = await frameMs(r, 11)
      if (k === 0) {
        first = ms
        base.push(ms)
      }
      per[k]!.push(ms / first)
    }
  }
  const median = (v: number[]) => {
    const s = [...v].sort((x, y) => x - y)
    return s[s.length >> 1]!
  }
  return { ratios: per.map(median), ms: median(base) }
}

describe('interior lighting on the max fixture', () => {
  it('solves the field coarse to fine, within 1/255 of a reference solve; low costs half', {
    timeout: timeout(300_000),
  }, async () => {
    const { r, world } = await maxInterior()
    r.frame()
    const interior = world.resource(Interior)
    const medium = interior.last!
    expect(medium.full).toBe(true)
    const grid = interior.grid!
    expect(grid.texel).toBe(0.25)
    // The reference: the same cover and links, plain SOR from nothing, run far past the default.
    const layer = interior.layers[0]!
    const reference = new FieldLayer(grid.width, grid.height)
    reference.cover.set(layer.cover)
    reference.links.set(layer.links)
    reference.value.fill(0)
    const all: TexelRect = { x0: 0, z0: 0, x1: grid.width, z1: grid.height }
    const scratch = new SolveScratch()
    solveRect(
      grid,
      reference,
      all,
      { reach: interior.settings.spillReach, tolerance: 1e-7, maxSweeps: 20_000 },
      scratch,
    )
    packRect(grid, reference, all, scratch)
    let worst = 0
    for (let i = 0; i < layer.packed.length; i++)
      worst = Math.max(
        worst,
        Math.abs(unpackVisibility(layer.packed[i]!) - unpackVisibility(reference.packed[i]!)),
      )
    expect(worst).toBeLessThan(1 / 255)
    // Low: a 0.5 m field, solved whole again.
    world.patchResource(StructureSettings, { interior: { quality: 'low' } } as never)
    r.frame()
    const low = interior.last!
    expect(low.full).toBe(true)
    expect(interior.grid!.texel).toBe(0.5)
    console.log(
      `max fixture field: medium ${medium.texels} texels, ${medium.sweeps} sweeps, ${medium.ms.toFixed(0)} ms; low ${low.texels} texels, ${low.ms.toFixed(0)} ms; worst ${(worst * 255).toFixed(3)}/255`,
    )
    if (timingMode === 'bench') expect(low.ms).toBeLessThan(medium.ms / 2)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it('200 blocked lights: a door toggle rebuilds only nearby rows, under 2 ms; a still frame allocates nothing', {
    timeout: timeout(300_000),
  }, async () => {
    const { r, world, torches } = await maxInterior()
    r.frame()
    r.frame()
    const interior = world.resource(Interior)
    expect(interior.lights.size).toBe(200)
    for (const t of torches) expect(interior.lights.get(t)!.row).toBeGreaterThanOrEqual(0)
    // A closed door near a torch.
    const doors = world
      .query({ with: [Opening] })
      .entities()
      .filter((e) => world.get(e, Opening).kind === 'door')
    const near = doors.find((d) => {
      const wall = world.resource(Structure).walls.get(world.get(d, Opening).wall as Entity)
      if (!wall) return false
      const s = wall.shape
      return [...interior.lights.values()].some(
        (c) => Math.hypot(c.x - (s.ax + s.bx) / 2, c.z - (s.az + s.bz) / 2) < 4,
      )
    })!
    expect(near).toBeDefined()
    const rebuilt = world.resource(Structure).chunksRebuilt
    const times: number[] = []
    for (let i = 0; i < 6; i++) {
      world.set(near, Opening, { state: i % 2 === 0 ? 'open' : 'closed' })
      r.frame()
      expect(interior.lastRows.lights).toBeGreaterThan(0)
      expect(interior.lastRows.lights).toBeLessThan(20)
      times.push(interior.lastRows.ms)
    }
    times.sort((a, b) => a - b)
    console.log(
      `max fixture: a door toggle rebuilds ${interior.lastRows.lights} rows in ${times[3]!.toFixed(3)} ms (median); field region ${interior.last!.texels} texels, ${interior.last!.ms.toFixed(2)} ms`,
    )
    expect(times[3]!).toBeLessThan(budget('structure/interior-rows'))
    expect(world.resource(Structure).chunksRebuilt).toBe(rebuilt)
    // A still frame: the system does nothing and allocates nothing.
    const local = updateInterior.setup!(world)
    for (let i = 0; i < 200; i++) {
      world.incrementTick()
      updateInterior.run(local, world, {
        lastRunTick: world.tick - 1,
        thisRunTick: world.tick,
      } as never)
    }
    if (allocationChecks) {
      globalThis.gc?.()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const window = gcWindow()
      for (let i = 0; i < 2000; i++) {
        world.incrementTick()
        updateInterior.run(local, world, {
          lastRunTick: world.tick - 1,
          thisRunTick: world.tick,
        } as never)
      }
      expect(await window.end()).toBe(0)
    }
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it('blocked lights cost a frame within 10% of unblocked ones', {
    timeout: timeout(300_000),
  }, async () => {
    const { r, world } = await maxInterior({ width: 1280, height: 720 })
    await settle(r.app)
    const set = (patch: object) => () =>
      world.patchResource(StructureSettings, { interior: patch } as never)
    const blocked = await gpuRatios(r, [set({ blockLights: false }), set({ blockLights: true })])
    const b = blocked.ratios[1]!
    console.log(
      `max fixture, 1280×720 (${blocked.ms.toFixed(2)} ms a frame unblocked): blocked lights ${((b - 1) * 100).toFixed(1)}% GPU time`,
    )
    expect(world.resource(Gpu).errors).toEqual([])
    expect(world.resource(RenderStats).lastFrame.chunksRebuilt).toBe(0)
    expect(b).toBeLessThan(budget('structure/blocked-lights'))
    await r.dispose()
  })

  // On the max fixture a frame is drawing 5000 walls: interior lighting's share is under the
  // noise of its timing. This one is bound by lighting: every pixel a covered floor shaded by
  // dozens of blocked torches.
  it('at low, a frame’s interior lighting costs at most half of medium’s', {
    timeout: timeout(300_000),
  }, async () => {
    const r = await rig(gpu, {
      shadows: false,
      interior: true,
      width: 1280,
      height: 720,
      orthoHeight: 24,
    })
    const world = r.app.world
    world.despawn(r.sun)
    Object.assign(world.resource(AmbientLight), { brightness: 3000 })
    world.spawn([
      Floor,
      {
        points: [
          [-24, -14],
          [24, -14],
          [24, 14],
          [-24, 14],
        ],
      },
    ])
    for (let x = -24; x <= 24; x += 6) world.spawn([Wall, { a: [x, -14], b: [x, 14], height: 2.8 }])
    for (let z = -14; z <= 14; z += 7) world.spawn([Wall, { a: [-24, z], b: [24, z], height: 2.8 }])
    world.spawn([
      Roof,
      {
        points: [
          [-25, -15],
          [25, -15],
          [25, 15],
          [-25, 15],
        ],
        height: 2.8,
      },
    ])
    for (let i = 0; i < 96; i++)
      world.spawn(
        [
          PointLight,
          { intensity: 20_000, range: 12, falloff: 'tabletop', bright: 3, blockedByWalls: true },
        ],
        [Transform, { translation: [-23 + (i % 16) * 3, 1.5, -13 + Math.floor(i / 16) * 4.6] }],
      )
    r.look([0, 30, 0.0001], [0, 0, 0])
    await settle(r.app)
    const set = (patch: object) => () =>
      world.patchResource(StructureSettings, { interior: patch } as never)
    const q = await gpuRatios(r, [
      set({ sky: false, blockLights: false }),
      set({ sky: true, blockLights: true, quality: 'medium' }),
      set({ sky: true, blockLights: true, quality: 'low' }),
    ])
    const medium = q.ratios[1]! - 1
    const low = q.ratios[2]! - 1
    console.log(
      `lighting-bound, 1280×720 (${q.ms.toFixed(2)} ms without interior lighting): +${(medium * 100).toFixed(1)}% at medium, +${(low * 100).toFixed(1)}% at low`,
    )
    expect(world.resource(Gpu).errors).toEqual([])
    if (timingMode === 'bench') expect(low).toBeLessThanOrEqual(medium / 2)
    await r.dispose()
  })
})
