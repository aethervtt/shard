/**
 * Scenario tests (0075), a test helper exported from `@aethervtt/shard-render/testing`: a fixture's
 * camera path runs through a 0074 capture, and each slice of the scenario (`bench/perf/budgets.json`)
 * is read from it with the covers rule (`Capture.spanTime`), so tests, `shard profile` and the
 * `perf` overlay measure the same thing. On a machine whose GPU passes overlap (machines.json's
 * `passTiming: "ablation"`), GPU slices are measured by ablation under `pnpm bench` instead.
 */
import { spanCovers, spanName, type World } from '@aethervtt/shard-core'
import type { Capture, CaptureSummary } from '@aethervtt/shard-core/capture'
import {
  budget,
  passTiming,
  scenarioSlices,
  type Track,
  timingMode,
} from '@aethervtt/shard-core/test-env'
import { capturePerf } from '@aethervtt/shard-runtime'
import type { expect as vitestExpect } from 'vitest'
import { ablatePasses } from './ablation'
import { Graph } from './plugin'

export interface ScenarioSlice {
  key: string
  track: Track
  /** Spans that ran in the capture and that the key covers. */
  covers: string[]
  /** Time the key covered in each captured frame (ms). */
  perFrame: Float64Array
  /** The p95 of it: frames whose GPU timings landed, for a GPU slice. Ablation's cost instead. */
  p95: number
  measuredBy: 'capture' | 'ablation'
}

export interface ScenarioRun {
  name: string
  summary: CaptureSummary
  capture: Capture
  /** Every span that ran during the capture, by name. */
  spans: string[]
  /** Each frame's CPU time (`frame`) and GPU time (`gpu:frame`; 0 where none landed). */
  frame: { cpu: Float64Array; gpu: Float64Array; cpuP95: number; gpuP95: number }
  /** Whether GPU passes were timed (the device has `timestamp-query`). */
  gpuTimed: boolean
  slices: ScenarioSlice[]
}

export interface ScenarioOptions {
  /** Frames along the camera path, each run through the capture. */
  frames: number
  /** Puts the camera at path frame `i`, runs one app frame, and waits for the GPU. */
  step: (i: number) => void | Promise<void>
  /** Ablation under `pnpm bench` on a machine that needs it: frames per measurement, rounds. */
  ablation?: {
    frames?: number
    rounds?: number /** Ablate whatever the machine (tests of this helper). */
    force?: boolean
  }
}

function p95Of(values: ArrayLike<number>): number {
  const sorted = Array.from(values).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
}

/**
 * Runs a scenario's camera path through a capture and measures its frame and slices (0075). The
 * slices are the scenario's keys in budgets.json, `headroom` aside.
 */
export async function measureScenario(
  world: World,
  name: string,
  options: ScenarioOptions,
): Promise<ScenarioRun> {
  const keys = scenarioSlices(name)
  let i = 0
  const { summary, capture } = await capturePerf(world, {
    frames: options.frames,
    write: false,
    trace: false,
    keep: true,
    step: async () => {
      await options.step(Math.min(i, options.frames - 1))
      i++
    },
  })
  if (!capture) throw new Error('capturePerf kept no capture')
  const seen = new Set<number>()
  for (let e = 0; e < capture.eventCount; e++) seen.add(capture.events.ids[e]!)
  const spans = [...seen].map(spanName).sort()
  const gpuFrame = capture.spanTime('gpu:frame')
  const timedFrames: number[] = []
  for (let f = 0; f < gpuFrame.length; f++) if (gpuFrame[f]! > 0) timedFrames.push(f)
  const gpuTimed = timedFrames.length > 0
  const slices: ScenarioSlice[] = []
  for (const track of ['gpu', 'cpu'] as const) {
    for (const key of keys[track]) {
      const perFrame = capture.spanTime(key)
      const values = track === 'gpu' ? timedFrames.map((f) => perFrame[f]!) : perFrame
      slices.push({
        key,
        track,
        covers: spans.filter((s) => spanCovers(key, s)),
        perFrame,
        p95: p95Of(values),
        measuredBy: 'capture',
      })
    }
  }
  // Tile-based GPUs: pass timestamps overlap, so a GPU slice is what disabling its nodes saves.
  if ((options.ablation?.force || passTiming() === 'ablation') && gpuTimed) {
    const graph = world.resource(Graph)
    const nodes = graph.nodeNames()
    const groups: Record<string, string[]> = {}
    for (const s of slices) {
      if (s.track !== 'gpu') continue
      const covered = nodes.filter((n) => spanCovers(s.key, `gpu:${n}`))
      if (covered.length > 0) groups[s.key] = covered
    }
    const passes = Object.keys(groups)
    if (passes.length > 0) {
      const result = await ablatePasses(
        world,
        {
          passes,
          groups,
          frames: options.ablation?.frames ?? 60,
          rounds: options.ablation?.rounds ?? 3,
        },
        () => options.step(options.frames - 1),
      )
      for (const cost of result.passes) {
        const s = slices.find((x) => x.track === 'gpu' && x.key === cost.pass)!
        s.p95 = Math.max(0, cost.ms)
        s.measuredBy = 'ablation'
      }
    }
  }
  return {
    name,
    summary,
    capture,
    spans,
    frame: {
      cpu: capture.frames.cpu,
      gpu: gpuFrame,
      cpuP95: p95Of(capture.frames.cpu),
      gpuP95: p95Of(timedFrames.map((f) => gpuFrame[f]!)),
    },
    gpuTimed,
    slices,
  }
}

/**
 * The checks of a scenario test. In `pnpm test`: the capture ran every frame, and every slice key
 * covers at least one span that ran (GPU ones where the device times passes). Under `pnpm bench`:
 * p95 of the frame and of each slice against the scenario's budgets, soft, so every one is
 * recorded for `bench/perf/report.json`.
 */
export function expectScenario(run: ScenarioRun, expect: typeof vitestExpect): void {
  expect(run.summary.frames.count).toBe(run.capture.frameCount)
  expect(run.capture.frameCount).toBeGreaterThan(0)
  for (const s of run.slices) {
    if (s.track === 'gpu' && !run.gpuTimed) continue
    expect(s.covers, `${run.name}: slice "${s.key}" covers no span that ran`).not.toEqual([])
  }
  if (timingMode !== 'bench') return
  const soft = expect.soft
  soft(run.frame.cpuP95, `${run.name}: CPU frame p95`).toBeLessThan(
    budget(`${run.name}`, { track: 'cpu' }),
  )
  if (run.gpuTimed) {
    soft(run.frame.gpuP95, `${run.name}: GPU frame p95`).toBeLessThan(
      budget(`${run.name}`, { track: 'gpu' }),
    )
  }
  for (const s of run.slices) {
    if (s.track === 'gpu' && !run.gpuTimed) continue
    soft(s.p95, `${run.name}: ${s.track} slice ${s.key} p95 (${s.measuredBy})`).toBeLessThan(
      budget(`${run.name}`, { slice: s.key, track: s.track }),
    )
  }
}
