import { defineResource } from '@aethervtt/shard-core'

export interface PerfScenarioData {
  /** A scenario of budgets.json, or null: no scenario, so nothing adapts to a slice. */
  name: string | null
}

/**
 * The scenario the app declares (`App.perfScenario`): features that adapt (0045's foliage) take
 * their slice of its frame as their target, and the `perf` overlay shows its slices.
 */
export const PerfScenario = defineResource<PerfScenarioData>('runtime/PerfScenario', {
  description:
    'The budget scenario the app runs as (0075): features adapt to its slices, and the perf overlay shows them. null: none.',
  hostWritable: true,
  init: () => ({ name: null }),
})
