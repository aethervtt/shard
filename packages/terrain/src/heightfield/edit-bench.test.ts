import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { afterAll, describe, expect, it } from 'vitest'
import { type HeightfieldEditor, terrainEditor } from './editor'
import { loadTerrainRegion } from './queries'
import { EDIT_HILLS, editSource, heightfieldApp, untilStreaming } from './testing'

// 0104's budgets on the zoo's map (1024 m at 0.5 m): the edit work a frame takes while a 20 m
// brush drags across it, and how long a 200 m polygon cut takes to be in. Timing only, so it runs
// under `pnpm bench`.

let workers: ReturnType<typeof createNodeWorkers> | undefined
afterAll(() => workers?.dispose())

async function zooMap() {
  workers = createNodeWorkers()
  await loadNoiseKernel()
  const hills = await NoiseGraph.create(EDIT_HILLS)
  const p = await heightfieldApp(undefined, { ...editSource(1024), noise: { hills }, workers })
  await untilStreaming(p)
  // As the zoo does: every leaf on the CPU.
  await loadTerrainRegion(p.world, p.terrain, [0, 0, 1024, 1024])
  return p
}

const percentile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

describe('terrain edit budgets (0104)', () => {
  it.runIf(timingMode === 'bench')(
    'drags a 20 m brush across the map within terrain/edit-brush a frame (p95)',
    async () => {
      const p = await zooMap()
      const ed = terrainEditor(p.world, p.terrain)
      for (const brush of ['raise', 'smooth', 'paint'] as const) {
        const options =
          brush === 'paint'
            ? { paint: 'sand', radius: 10, strength: 0.4 }
            : { brush, radius: 10, strength: brush === 'raise' ? 0.2 : 0.5, rate: 30 }
        const frames: number[] = []
        const stroke = ed.stroke(options, 100, 200)
        // 3 m a frame (180 m/s at 60 fps) on a diagonal across the map.
        for (let f = 1; f <= 240; f++) {
          const t0 = performance.now()
          stroke.to(100 + f * 3, 200 + f * 2, 1 / 60)
          const applied = performance.now() - t0
          const e = p.runtime().parts.get('editor') as HeightfieldEditor
          e.lastMs = 0
          p.app.update(1 / 60)
          frames.push(applied + e.lastMs)
        }
        stroke.end()
        const p50 = percentile(frames, 0.5)
        const p95 = percentile(frames, 0.95)
        console.info(`edit-brush ${brush}: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`)
        expect(p95).toBeLessThan(budget('terrain/edit-brush'))
      }
    },
    timeout(300_000),
  )

  it.runIf(timingMode === 'bench')(
    'cuts a 200 m polygon in within terrain/edit-shape, a frame at a time',
    async () => {
      const p = await zooMap()
      const ed = terrainEditor(p.world, p.terrain)
      const polygon: [number, number][] = []
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2
        const r = 100 * (1 + 0.1 * Math.cos(3 * a))
        polygon.push([512 + Math.cos(a) * r, 512 + Math.sin(a) * r])
      }
      const t0 = performance.now()
      ed.shape({ shape: { polygon }, set: -4, edge: { angle: 35 } })
      const applied = performance.now() - t0
      let work = applied
      let frames = 0
      for (; frames < 600 && ed.pending > 0; frames++) {
        p.app.update(1 / 60)
        // The edit system's share of the frame.
        work += (p.runtime().parts.get('editor') as HeightfieldEditor).lastMs
      }
      p.app.update(1 / 60)
      // In at 60 fps: the frames it took (a frame each), or the work if that's longer.
      const inMs = Math.max(work, (frames + 1) * (1000 / 60))
      console.info(
        `edit-shape: applied ${applied.toFixed(0)} ms, work ${work.toFixed(0)} ms over ${frames} frames, in by ${inMs.toFixed(0)} ms at 60 fps`,
      )
      expect(inMs).toBeLessThan(budget('terrain/edit-shape'))
    },
    timeout(300_000),
  )
})
