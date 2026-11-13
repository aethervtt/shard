import type { Entity } from '@aethervtt/shard-core'
import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import {
  NavAgent,
  NavMesh,
  NavSource,
  navPlugin,
  navReady,
  navTiersPlugin,
} from '@aethervtt/shard-nav'
import { Collider } from '@aethervtt/shard-physics'
import { Gpu, Mesh3d, Meshes } from '@aethervtt/shard-render'
import { expectScenario, measureScenario } from '@aethervtt/shard-render/testing'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Ctx, startCharacters, stopCharacters, zombie } from './test-app'
import { TierRunResource } from './tiers'

// `pnpm test` runs a few frames small: the capture runs and every slice key covers spans that ran.
// `pnpm bench` runs the spec's sizes at 1920×1080 against the scenarios' budgets.
// SHARD_HORDE_FULL: the bench's sizes without its budgets (profiling).
const bench = timingMode === 'bench' || process.env.SHARD_HORDE_FULL === '1'

let gpu: GpuContext | undefined
const contexts: Ctx[] = []

beforeAll(async () => {
  gpu = await createNodeGpuContext().catch(() => undefined)
})

afterAll(async () => {
  for (const c of contexts) await stopCharacters(c)
})

/** A flat field `w` wide and `d` deep in front of the camera, drawn and baked into a coarse navmesh. */
async function field(c: Ctx, w: number, d: number): Promise<void> {
  const world = c.world
  world.spawn(
    [NavSource, {}],
    [Collider, { shape: 'cuboid', halfExtents: [w / 2, 0.5, d / 2] }],
    [Transform, { translation: [0, -0.5, -d / 2 + 20] }],
  )
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 1 })) }],
    [Transform, { translation: [0, 0, -d / 2 + 20], scale: [w, 1, d] }],
  )
  world.spawn([NavMesh, { cellSize: 1, cellHeight: 0.2, tileSize: 64, agentRadius: 0.4 }])
  for (let f = 0; f < 600 && !navReady(world); f++) {
    c.app.update(1 / 60)
    await new Promise((r) => setTimeout(r, 0))
  }
  expect(navReady(world)).toBe(true)
}

/** 0115's bands across the view, each character walking to a point 40 m away on the field. */
function horde(c: Ctx, bands: [number, number, number][]): Entity[] {
  const out: Entity[] = []
  let k = 0
  for (const [count, lo, hi] of bands) {
    for (let i = 0; i < count; i++, k++) {
      const d = lo + ((hi - lo) * (i + 0.5)) / count
      const angle = (((k * 37) % 50) - 25) * (Math.PI / 180)
      const e = zombie(c, d * Math.cos(angle), { x: d * Math.sin(angle) })
      const heading = (k * 2.399) % (2 * Math.PI)
      const t = c.world.get(e, Transform).translation
      c.world.add(e, NavAgent, {
        destination: [t[0]! + Math.cos(heading) * 40, 0, t[2]! + Math.sin(heading) * 40],
        speed: 1.2,
        drive: 'transform',
      })
      out.push(e)
    }
  }
  return out
}

async function run(
  name: 'horde-walk' | 'horde-far',
  bands: [number, number, number][],
  depth: number,
) {
  if (!gpu) return
  const c = await startCharacters(gpu, {}, bench ? [1920, 1080] : [320, 180], [
    navPlugin,
    navTiersPlugin,
  ])
  contexts.push(c)
  await field(c, depth * 1.2, depth + 40)
  horde(c, bands)
  for (let f = 0; f < 30; f++) c.app.update(1 / 60)
  const frames = bench ? 600 : 12
  // SHARD_HORDE_PROF=<file>: a CPU profile of the measured frames (inspector), for tuning.
  const prof = process.env.SHARD_HORDE_PROF
  const session = prof ? new (await import('node:inspector')).Session() : undefined
  const post = (method: string) =>
    new Promise<unknown>((resolve, reject) =>
      session!.post(method, (err, res) => (err ? reject(err) : resolve(res))),
    )
  if (session) {
    session.connect()
    await post('Profiler.enable')
    await post('Profiler.start')
  }
  const result = await measureScenario(c.world, name, {
    frames,
    step: async (i) => {
      // The camera walks forward and pans across the horde.
      const z = 10 - (i / frames) * 30
      const yaw = Math.sin((i / frames) * Math.PI * 2) * 0.3
      c.world.set(c.camera, Transform, {
        translation: [0, 1.7, z],
        rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
      })
      c.app.update(1 / 60)
      await gpu!.device.queue.onSubmittedWorkDone()
      // Pass timings land between tasks.
      await new Promise((r) => setTimeout(r, 0))
    },
  })
  if (session && prof) {
    const { profile } = (await post('Profiler.stop')) as { profile: unknown }
    ;(await import('node:fs')).writeFileSync(prof, JSON.stringify(profile))
    session.disconnect()
  }
  expect(c.world.resource(Gpu).errors).toEqual([])
  const counts = c.world.resource(TierRunResource).run!.stats.counts
  console.info(
    `${name}: tiers near ${counts[0]}, mid ${counts[1]}, far ${counts[2]}, off ${counts[3]}; ` +
      `frame p95 cpu ${result.frame.cpuP95.toFixed(2)} ms, gpu ${result.frame.gpuP95.toFixed(2)} ms\n` +
      result.slices.map((s) => `  ${s.track} ${s.key}: p95 ${s.p95.toFixed(3)} ms`).join('\n'),
  )
  console.info(
    `${name} top spans:\n${result.summary.top
      .slice(0, 14)
      .map((t) => `  ${t.span}: p50 ${t.p50.toFixed(3)} ms, p95 ${t.p95.toFixed(3)} ms`)
      .join('\n')}`,
  )
  expectScenario(result, expect)
}

describe('scenarios (0115)', () => {
  it('scenario: horde-walk 500 characters from 2 m to 300 m walking', {
    timeout: timeout(900_000),
  }, async () => {
    await run(
      'horde-walk',
      bench
        ? [
            [40, 2, 15],
            [160, 15, 60],
            [300, 60, 300],
          ]
        : [
            [4, 2, 15],
            [16, 15, 60],
            [30, 60, 300],
          ],
      300,
    )
  })

  it('scenario: horde-far 2,000 characters mostly far', {
    timeout: timeout(900_000),
  }, async () => {
    await run(
      'horde-far',
      bench
        ? [
            [40, 2, 15],
            [160, 15, 60],
            [1800, 60, 500],
          ]
        : [
            [4, 2, 15],
            [16, 15, 60],
            [80, 60, 500],
          ],
      500,
    )
  })
})
