import { defineResource, type World } from '@aethervtt/shard-core'

export interface StepModeData {
  /**
   * The host steps on a fixed clock and wants results that depend only on input and seed:
   * `shard run`, `shard run --net` and netHarness. Plugins that would otherwise act whenever
   * async work lands (partition commits, 0113) act on fixed frames instead.
   */
  deterministic: boolean
  /** Work such a host awaits before each step (generation due next frame). Plugins push here. */
  readonly settles: (() => Promise<void> | void)[]
}

export const StepMode = defineResource<StepModeData>('core/StepMode', {
  description: 'Whether the host steps deterministically, and what it awaits before each step.',
  init: () => ({ deterministic: false, settles: [] }),
})

/** Deterministic hosts await this before each step: every plugin's pending work that's due. */
export async function settleBeforeStep(world: World): Promise<void> {
  const mode = world.tryResource(StepMode)
  if (!mode) return
  for (const settle of mode.settles) await settle()
}
