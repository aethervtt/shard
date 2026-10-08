import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodePlatform, createNodeWorkers } from '@aethervtt/shard-platform-node'
import { Gpu } from '@aethervtt/shard-render'
import { expectScenario, measureScenario } from '@aethervtt/shard-render/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evalHeightPoints } from './kernel'
import { mainNoise } from './stack'
import {
  heightfieldApp,
  lookAt,
  openWorldSource,
  settleHeightfield,
  untilStreaming,
  VALLEY_HILLS,
  valleySource,
} from './testing'

// Spec 0075's open-world-fly scenario (0071): a 300 m/s flight 30 m over the 16 km terrain at
// 1920×1080 under `pnpm bench` (the terrain bakes once into the OS temp directory and is reused),
// through a capture. `pnpm test` flies a few frames over the 2 km terrain, small: the capture runs
// and every slice key covers a span that ran.

const bench = timingMode === 'bench'
const WIDTH = bench ? 1920 : 320
const HEIGHT = bench ? 1080 : 180
/** 30 s of flight (9 km) under the bench. */
const FRAMES = bench ? 1800 : 40

let gpu: GpuContext
let hills: NoiseGraph
const workers = createNodeWorkers(bench ? undefined : 2)

beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
  await loadNoiseKernel()
  hills = await NoiseGraph.create(VALLEY_HILLS)
})

afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
  workers.dispose()
}, timeout(120_000))

describe('scenario: open-world-fly (0075, 0071)', () => {
  it(
    'scenario: open-world-fly crosses the terrain at 300 m/s through a capture; streaming stays under 1 ms',
    async () => {
      const root = join(tmpdir(), 'shard-open-world-fly')
      mkdirSync(root, { recursive: true })
      const terrain = bench ? openWorldSource() : valleySource()
      const size = bench ? 16384 : 2048
      const p = await heightfieldApp(gpu, {
        ...terrain,
        noise: { hills },
        workers,
        width: WIDTH,
        heightPx: HEIGHT,
        ...(bench ? { fs: createNodePlatform({ root }).fs, name: 'open-world-16km' } : {}),
      })
      await untilStreaming(p, timeout(bench ? 1_800_000 : 120_000))
      const rt = p.runtime()
      const ground = (x: number, z: number) => {
        const out = new Float64Array(1)
        evalHeightPoints(mainNoise(), rt.stack!, [x, z], 1, rt.stack!.height.length, out)
        return out[0]!
      }
      // Diagonally across, from a tenth of the way in.
      const look = (i: number) => {
        const d = size * 0.1 + i * 5
        const x = d * 0.8
        const z = d * 0.6
        const eye = [x, ground(x, z) + 30, z]
        lookAt(p, eye, [x + 80, ground(x + 80, z + 60), z + 60])
      }
      look(0)
      await settleHeightfield(p)
      const run = await measureScenario(p.world, 'open-world-fly', {
        frames: FRAMES,
        step: async (i) => {
          look(i + 1)
          p.app.update(1 / 60)
          await gpu.device.queue.onSubmittedWorkDone()
          await new Promise((r) => setTimeout(r, 0))
        },
      })
      expect(p.world.resource(Gpu).errors).toEqual([])
      const streaming = run.capture
        .spanTime('terrain/heightfield-select')
        .map(
          (v, f) =>
            v +
            run.capture.spanTime('terrain/heightfield-upload')[f]! +
            run.capture.spanTime('terrain/heightfields')[f]!,
        )
      const sorted = Array.from(streaming).sort((a, b) => a - b)
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
      console.info(
        `open-world-fly spans: ${run.spans.join(', ')}\n  streaming p95 ${p95.toFixed(3)} ms\n` +
          run.slices
            .map(
              (s) => `  ${s.track} ${s.key}: p95 ${s.p95.toFixed(3)} ms (${s.covers.join(', ')})`,
            )
            .join('\n'),
      )
      expectScenario(run, expect)
      // 0071: streaming under 1 ms of main-thread time a frame (p95).
      if (bench) expect.soft(p95, 'open-world-fly: streaming p95').toBeLessThan(1)
      await p.app.dispose()
    },
    timeout(bench ? 3_600_000 : 300_000),
  )
})
