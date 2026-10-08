// perf.budgets (spec 0075): the machine this app runs on, its budgets, and the profiler's latest
// measurements against them. In its own file, like perf.ablate, next to the profiler's methods.

import { defineSchema, t } from '@aethervtt/shard-core'
import { describeBudgets } from '@aethervtt/shard-runtime'
import type { MethodDef } from './server'

export const BUDGET_METHODS: MethodDef[] = [
  {
    name: 'perf.budgets',
    description:
      "Performance budgets (0075, bench/perf/budgets.json) for this app: the named machine it runs on (detected from the CPU model where the host exposes it, and the GPU adapter; null with a perf/unknown-machine warning when it can't tell, and then numbers are the closest machine's), every budget resolved for it with the profiler's latest p95 against it, over budget first; and the scenario's slices (the app's App.perfScenario, or `scenario`): each slice's measured share of the frame (from the profiler's aggregates, gpu:frame for GPU slices, frame for CPU) next to its budget share, over first. Hosts supply the files: the CLI loads them from the repo or project, shard dev serves them to its page.",
    params: defineSchema('protocol/BudgetsParams', {
      scenario: t.string({
        description:
          "A scenario of budgets.json to measure (scatter-walk, crowd, planet-descent, tabletop-max). Default: the app's own (App.perfScenario).",
      }),
    }),
    handler: ({ world }, p) => {
      const scenario = p.scenario as string | undefined
      return describeBudgets(world, { scenario: scenario ? scenario : undefined })
    },
  },
]
