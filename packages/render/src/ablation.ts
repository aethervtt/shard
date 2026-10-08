import { ShardError, type World } from '@aethervtt/shard-core'
import { Gpu, Graph } from './plugin'

/**
 * Per-pass GPU cost by ablation (0075). On tile-based GPUs passes overlap and a pass's timestamps
 * include waiting for earlier work, so per-pass times add up to more than the frame. `gpu:frame`
 * (first pass start to last pass end) stays true, so a pass's cost is how much `gpu:frame` drops
 * with the pass disabled.
 */
export interface AblationOptions {
  /** Render-graph nodes to measure, each on its own. */
  passes: readonly string[]
  /** Frames measured per pass and round (the median is kept). Default 120. */
  frames?: number
  /** Rounds, each measuring every pass and the baseline; the median over rounds is kept. Default 5. */
  rounds?: number
  /** Frames dropped after each change, while timings of the previous state land. Default 4. */
  settle?: number
  /** Also measure every pass disabled at once. */
  together?: boolean
}

export interface PassCost {
  /** The node, or every node joined with '+' for `together`. */
  pass: string
  /** Median over rounds of baseline `gpu:frame` minus `gpu:frame` with the pass disabled, in ms. */
  ms: number
  /** Each round's difference. */
  rounds: number[]
}

export interface AblationResult {
  /** Median `gpu:frame` with every pass enabled, in ms. */
  frameMs: number
  passes: PassCost[]
  /** Every pass disabled at once, with `together`. */
  together?: PassCost
  frames: number
  rounds: number
  /** GPU frame timings read, all states together. */
  samples: number
}

/** How a measurement drives the app: what to disable, and one frame's `gpu:frame`. */
export interface AblationDriver {
  disable(passes: readonly string[]): void
  /** Renders a frame and resolves its `gpu:frame` in ms, or undefined when none landed. */
  frame(): Promise<number | undefined>
}

const median = (values: number[]): number => {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * The measurement, apart from any app: each round measures the baseline, every pass disabled in
 * turn (in reverse order on odd rounds), and the baseline again; a pass's difference in a round is
 * the mean of the two baselines minus its median. Interleaving rounds cancels thermal drift, as
 * `structure/src/cutaway.test.ts` does. Restores every pass before it returns or throws.
 */
export async function runAblation(
  driver: AblationDriver,
  options: AblationOptions,
): Promise<AblationResult> {
  const frames = options.frames ?? 120
  const rounds = options.rounds ?? 5
  const settle = options.settle ?? 4
  const sets: (readonly string[])[] = options.passes.map((p) => [p])
  if (options.together && options.passes.length > 1) sets.push(options.passes)
  let samples = 0
  const measure = async (disabled: readonly string[]): Promise<number> => {
    driver.disable(disabled)
    for (let i = 0; i < settle; i++) await driver.frame()
    const times: number[] = []
    for (let i = 0; i < frames; i++) {
      const ms = await driver.frame()
      if (ms !== undefined) times.push(ms)
    }
    samples += times.length
    return median(times)
  }
  const diffs = sets.map((): number[] => [])
  const baselines: number[] = []
  try {
    for (let round = 0; round < rounds; round++) {
      const before = await measure([])
      const order = sets.map((_, i) => i)
      if (round % 2 === 1) order.reverse()
      const off = new Map<number, number>()
      for (const i of order) off.set(i, await measure(sets[i]!))
      const after = await measure([])
      const base = (before + after) / 2
      baselines.push(base)
      for (let i = 0; i < sets.length; i++) diffs[i]!.push(base - off.get(i)!)
    }
  } finally {
    driver.disable([])
  }
  const costs = sets.map(
    (set, i): PassCost => ({ pass: set.join('+'), ms: median(diffs[i]!), rounds: diffs[i]! }),
  )
  const together = options.together && options.passes.length > 1 ? costs.pop() : undefined
  return {
    frameMs: median(baselines),
    passes: costs,
    ...(together ? { together } : {}),
    frames,
    rounds,
    samples,
  }
}

/**
 * Ablates render-graph passes in a running app: `frame` produces one frame (rendering without
 * advancing time, or waiting for the loop). Reads `gpu:frame` from the graph's `GpuTimer`, so the
 * device needs `timestamp-query` (`render/gpu-timing-unavailable` otherwise). Unknown passes throw
 * `render/unknown-node`.
 */
export async function ablatePasses(
  world: World,
  options: AblationOptions,
  frame: () => Promise<void> | void,
): Promise<AblationResult> {
  const graph = world.resource(Graph)
  const gpu = world.resource(Gpu)
  if (!graph.timer.enabled) {
    throw new ShardError('render/gpu-timing-unavailable', "This device can't time GPU passes", {
      hint: "Ablation reads gpu:frame, which needs the 'timestamp-query' feature.",
    })
  }
  if (options.passes.length === 0) {
    throw new ShardError('render/unknown-node', 'No passes to ablate', {
      hint: `Name render graph nodes: ${graph.nodeNames().join(', ')}.`,
    })
  }
  graph.ablate(options.passes) // checks the names before anything runs
  graph.ablate([])
  const timer = graph.timer
  const driver: AblationDriver = {
    disable: (passes) => graph.ablate(passes),
    async frame() {
      const seen = timer.frameSamples
      await frame()
      // The timing lands once the GPU finished the frame and its readback mapped.
      for (let i = 0; i < 8 && timer.frameSamples === seen; i++) {
        await gpu.device.queue.onSubmittedWorkDone()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      return timer.frameSamples === seen ? undefined : timer.frameMs
    },
  }
  return runAblation(driver, options)
}
