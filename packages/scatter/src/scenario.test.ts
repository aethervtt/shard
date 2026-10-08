import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import { createNodePlatform, loadPerfBudgets } from '@aethervtt/shard-platform-node'
import { DirectionalLight, FoliageBudget, FoliageLayers, Gpu } from '@aethervtt/shard-render'
import { expectScenario, measureScenario } from '@aethervtt/shard-render/testing'
import { PerfBudgets, type PerfBudgetsData } from '@aethervtt/shard-runtime'
import { planetHeightAt } from '@aethervtt/shard-terrain'
import { placeCamera, settleTerrain, sunOver } from '@aethervtt/shard-terrain/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Wind } from './foliage'
import { type ScatterPlanet, scatterPlanet, settleScatter, TEST_RADIUS } from './testing'

// Spec 0075's scatter-walk scenario: the scatter test planet (the biome sets star-explorer's planet
// uses), walking through its forest and grass at head height, at 1920×1080 and render scale 1 under
// `pnpm bench`. `pnpm test` walks a few frames small: the capture runs and every slice key covers a
// span that ran.

const bench = timingMode === 'bench'
const WIDTH = bench ? 1920 : 320
const HEIGHT = bench ? 1080 : 180
/** Frames along the walk: 15 s at 3 m/s under the bench. */
const FRAMES = bench ? 900 : 24
const SPEED = 3

const here = dirname(fileURLToPath(import.meta.url))
const roots: string[] = []
let gpu: GpuContext

beforeAll(async () => {
  await loadNoiseKernel()
  // Pass timings: the slices are GPU spans.
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
}, timeout(60_000))

function direction(angle: number): number[] {
  const d = [Math.cos(angle) * 0.3, 0.9, Math.sin(angle) * 0.3]
  const l = Math.hypot(d[0]!, d[1]!, d[2]!)
  return d.map((x) => x / l)
}

/** The forest of the test planet (planet-render.test.ts's "forest" view), walked east. */
async function walk(): Promise<{ p: ScatterPlanet; place: (i: number) => void }> {
  const root = mkdtempSync(join(tmpdir(), 'shard-scatter-walk-'))
  roots.push(root)
  const host = createNodePlatform({ root, logTo: () => {} })
  const p = await scatterPlanet(gpu, host, { width: WIDTH, height: HEIGHT, workers: true })
  const w = p.world
  w.resource(Wind).strength = 0.5
  const start = direction(18 * 0.157)
  const east = [start[2]!, 0, -start[0]!]
  const el = Math.hypot(east[0]!, east[1]!, east[2]!)
  sunOver(p, start, 40)
  w.set(p.sun, DirectionalLight, { shadows: true })
  const at = (metres: number) => {
    const s = metres / TEST_RADIUS
    const d = start.map((x, k) => x + (east[k]! / el) * s)
    const l = Math.hypot(d[0]!, d[1]!, d[2]!)
    return d.map((x) => x / l)
  }
  const place = (i: number) => {
    const metres = (i * SPEED) / 60
    const n = at(metres)
    const ahead = at(metres + 20)
    const eye = n.map((x) => x * (TEST_RADIUS + planetHeightAt(w, p.planet, n) + 1.7))
    const look = ahead.map((x) => x * (TEST_RADIUS + planetHeightAt(w, p.planet, ahead) + 0.5))
    placeCamera(p, eye, look)
  }
  place(0)
  await settleTerrain(p)
  await settleScatter(p, 2000)
  await settleTerrain(p)
  return { p, place }
}

/** One frame of the walk: the camera at frame `i`, the frame, and the GPU done with it. */
function stepper(p: ScatterPlanet, place: (i: number) => void) {
  return async (i: number) => {
    place(i)
    p.app.update(1 / 60)
    await gpu.device.queue.onSubmittedWorkDone()
    // Pass timings and pool results land between tasks.
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('scenario: scatter-walk (0075)', () => {
  it('scenario: scatter-walk walks the forest through a capture; every slice covers spans that ran', {
    timeout: timeout(600_000),
  }, async () => {
    const { p, place } = await walk()
    // The app declares the scenario: foliage adapts to its slice on the detected machine.
    const budgets = loadPerfBudgets(here)
    expect(budgets).toBeDefined()
    p.world.insertResource(PerfBudgets, budgets as unknown as PerfBudgetsData)
    p.app.perfScenario = 'scatter-walk'
    const run = await measureScenario(p.world, 'scatter-walk', {
      frames: FRAMES,
      step: stepper(p, place),
    })
    expect(p.world.resource(Gpu).errors).toEqual([])
    // Grass drew, so its passes are in the capture.
    expect([...p.world.resource(FoliageLayers).layers].some((l) => l.chunkCount > 0)).toBe(true)
    if (run.gpuTimed) expect(run.spans).toContain('gpu:foliage/draw')
    console.info(
      `scatter-walk spans: ${run.spans.join(', ')}\n` +
        run.slices
          .map((s) => `  ${s.track} ${s.key}: p95 ${s.p95.toFixed(3)} ms (${s.covers.join(', ')})`)
          .join('\n'),
    )
    expectScenario(run, expect)
    await p.app.dispose()
  })

  // 0075's acceptance: foliage holds its slice at 1080p (p95 over the walk), thinning to do it where
  // full density doesn't fit, back at full density where it does. Timing: under `pnpm bench` only.
  it.runIf(bench)(
    'scenario: scatter-walk foliage holds its gpu:foliage slice over the walk',
    { timeout: timeout(900_000) },
    async () => {
      const { p, place } = await walk()
      const limit = budget('scatter-walk', { slice: 'gpu:foliage', track: 'gpu' })
      const target = Number.isFinite(limit) ? limit : 0
      const steer = p.world.resource(FoliageBudget)
      steer.ms = target
      const step = stepper(p, place)
      // Once along the walk to converge, then measured on the way back over the same ground.
      for (let i = 0; i < FRAMES; i++) await step(i)
      const run = await measureScenario(p.world, 'scatter-walk', {
        frames: FRAMES,
        step: (i) => step(FRAMES - 1 - i),
      })
      const foliage = run.slices.find((s) => s.key === 'gpu:foliage')!
      console.info(
        `scatter-walk foliage: target ${target.toFixed(2)} ms, p95 ${foliage.p95.toFixed(2)} ms, detail ${steer.detail.toFixed(3)}`,
      )
      expect(foliage.p95).toBeLessThan(
        budget('scatter-walk', { slice: 'gpu:foliage', track: 'gpu' }),
      )
      // Full density whenever it fits with room to spare.
      if (steer.measuredMs < target * 0.8) expect(steer.detail).toBe(1)
      await p.app.dispose()
    },
  )
})
